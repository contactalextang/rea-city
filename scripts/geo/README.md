# 离线地理数据流水线（新加坡市中心切片）

把 OSM、URA、HDB、NEA、LTA 的公开数据下载、裁剪并投影到游戏用的本地米制坐标。
全部产物在 `data/geo/`（已 gitignore），脚本只依赖 Node ≥ 22（直接运行 `.ts`）与 GDAL 的 `ogr2ogr`/`ogrinfo`。

## 切片与坐标

| 项 | 值 |
|---|---|
| bbox (WGS84) | lon 103.825–103.868，lat 1.270–1.295（滨海湾 / 莱佛士坊 / 牛车水 / 丹戎巴葛 / 中峇鲁 / 红山） |
| 原点 | lon0 = 103.8465，lat0 = 1.2825 |
| 投影 | `x = (lon − lon0) · 111320 · cos(lat0)`（东为 +x）；`z = (lat0 − lat) · 110574`（北为 −z） |
| 本地范围 | x ∈ [−2392.8, 2392.8] m，z ∈ [−1382.2, 1382.2] m |

实现见 `lib/proj.ts`：导出 `BBOX`、`ORIGIN`、`LOCAL_BBOX`、`proj(lon, lat) → [x, z]`、`unproj(x, z) → [lon, lat]`。

## 用法

```bash
npm run geo:download   # 00：下载原始数据到 data/geo/raw/（已存在且 >1 KB 跳过；--force 重下）
npm run geo:extract    # 01：ogr2ogr 按 bbox 提取为 WGS84 GeoJSON → data/geo/*.geojson、data/geo/lta/*.geojson
npm run geo:project    # 02：投影到本地米制 + 裁剪 → data/geo/local/*.geojson、_stats.json
npm run geo:all        # 三步连跑
```

- GDAL：默认找 `$GDAL_BIN`，其次 `/Applications/Postgres.app/Contents/Versions/16/bin`（GDAL 3.7），最后 `PATH`。
- `data/geo/raw/` 视为不可信数据目录：脚本只把其中文件路径当参数传给 `curl`/`unzip`/`ogr2ogr`，从不在里面执行任何东西。
- 任一数据源失败只打 `WARN` 并继续，结尾有汇总；01/02 对缺失的输入同样跳过。
- 某项下载失败时：BBBike 文件名变了会扫目录页找 `.osm.pbf`，再退到 Geofabrik 全量包；LTA 的 zip 每月改后缀（如 `_Sep2026`），404 时会抓静态数据页按前缀重新找；data.gov.sg 走 `poll-download` 拿 1 小时有效的 S3 签名链接。

## 各步细节

### 00-download.ts

| 数据 | 来源 | 落地 |
|---|---|---|
| OSM 新加坡切片 PBF（≈37 MB） | `https://download.bbbike.org/osm/bbbike/Singapore/Singapore.osm.pbf`；备用 `https://download.geofabrik.de/asia/malaysia-singapore-brunei-latest.osm.pbf` | `raw/singapore.osm.pbf` |
| HDB Property Information（CSV） | data.gov.sg `d_17f5382f26140b1fdae0ba2ef6239d2f` | `raw/hdb-property-information.csv` |
| URA Master Plan 2019 Land Use layer（GeoJSON，≈166 MB） | data.gov.sg `d_90d86daa5bfaa371668b84fa5f01424f` | `raw/ura-mp2019-landuse.geojson` |
| NEA Hawker Centres（GeoJSON） | data.gov.sg `d_4a086da0a5553be1d89383cd90d07ecd` | `raw/nea-hawker-centres.geojson` |
| LTA DataMall 静态地理数据（SHP zip，SVY21/EPSG:3414） | `https://datamall.lta.gov.sg/content/dam/datamall/datasets/Geospatial/<File>.zip`，12 个：LampPost、TrafficLight、BusStopLocation、TrainStation、TrainStationExit、TaxiStand、ERPGantry、CoveredLinkWay、PedestrainOverheadbridge_UnderPass、KerbLine、LaneMarking、RoadSectionLine | `raw/lta/<name>.zip` |

data.gov.sg 的 id 用 `https://api-production.data.gov.sg/v2/public/api/datasets/<id>/metadata` 核实；下载链接来自 `https://api-open.data.gov.sg/v1/public/api/datasets/<id>/poll-download`。清单在 `lib/common.ts`。

### 01-extract.ts

- OSM：`ogr2ogr -f GeoJSON -spat <bbox> -oo CONFIG_FILE=scripts/geo/osmconf.ini raw/singapore.osm.pbf <layer>`，分别导出 `lines`→`osm-lines.geojson`、`multipolygons`→`osm-polygons.geojson`、`points`→`osm-points.geojson`。
  `osmconf.ini` 基于 GDAL 默认配置修改：三个图层都把 `highway, name, lanes, lanes:forward, lanes:backward, oneway, maxspeed, junction, layer, tunnel, bridge, crossing, railway, amenity, building, building:levels, height, addr:housenumber, addr:street, addr:postcode, landuse, leisure, natural, shop, public_transport` 暴露为字段（`attribute_name_laundering=no`，字段名保留冒号），其余 tag 留在 `other_tags`（hstore 文本），关闭 version/timestamp/uid/user/changeset 与 z_order。
  注意 `-spat` 对 OSM 只做相交过滤，跨边界的 way 完整保留，真正裁断在 02 做。
- LTA：`unzip` 到 `raw/lta/<name>/`，然后 `ogr2ogr -t_srs EPSG:4326 -spat <bbox> -spat_srs EPSG:4326 -clipdst <bbox> -nlt PROMOTE_TO_MULTI` → `lta/<name>.geojson`。所有 zip 自带 `.prj`（SVY21）；若缺失则按坐标范围判断并显式 `-s_srs EPSG:3414`。
- URA 土地用途：`-spat` + `-clipdst` 裁剪 → `ura-landuse.geojson`（属性 `LU_DESC`、`GPR` 等已是普通字段）。
- NEA 小贩中心：`-spat` → `hawker.geojson`。
- HDB CSV：原样复制 → `hdb.csv`（无坐标；后续按 `blk_no` + `street` 与 OSM `addr:*` 匹配）。

### 02-project.ts

读取上述 GeoJSON，坐标投影为 `[x, z]`（米，保留 2 位小数），属性原样保留，并按本地矩形真正裁剪：点在框内才保留；线用 Liang–Barsky 逐段裁剪（可能拆成 MultiLineString）；面用 `polygon-clipping` 求交（整体在框内的直接通过）。输出 `data/geo/local/`：
`osm-lines`、`osm-polygons`、`osm-points`、`ura-landuse`、`hawker`、`lta-<name>`，每个文件顶层带 `crs` 说明（原点、bbox、轴向）。
终端打印每个文件的要素数与几何类型分布；`osm-lines` 另有 `highway` 各类型计数，`osm-polygons` 另有建筑数及带 `building:levels` / `height` 的数量；同样内容写入 `_stats.json`。

## 数据许可与署名

| 数据 | 许可 | 署名要求 |
|---|---|---|
| OpenStreetMap（BBBike / Geofabrik 切片） | [ODbL 1.0](https://www.openstreetmap.org/copyright) | 必须注明 "© OpenStreetMap contributors"；基于 OSM 的衍生数据库若公开发布需同样以 ODbL 共享 |
| HDB Property Information、URA Master Plan 2019 Land Use、NEA Hawker Centres | [Singapore Open Data Licence v1.0](https://data.gov.sg/open-data-licence) | 注明来源机构与 data.gov.sg，例如 "Contains information from HDB / URA / NEA accessed from data.gov.sg, made available under the Singapore Open Data Licence v1.0"；不得暗示政府背书 |
| LTA DataMall 静态地理数据 | [Singapore Open Data Licence v1.0](https://datamall.lta.gov.sg/content/datamall/en/SingaporeOpenDataLicence.html)（LTA DataMall 条款） | 注明 "Contains information from the Land Transport Authority (LTA DataMall)"；只用于 API/数据条款允许的用途 |

游戏内的"关于"或 README 应同时列出以上署名。
