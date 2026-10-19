// 第 5 步：从 data/geo/local/osm-polygons.geojson 生成游戏用的建筑足迹 + 高度 + 分类。
// 用法：node scripts/geo/04-buildings.ts
// 输入：
//   data/geo/local/osm-polygons.geojson  OSM 多边形（本地米制 [x, z]）
//   data/geo/local/osm-lines.geojson     仅用于收集切片内的道路名（HDB 街名是否落在切片内）
//   data/geo/hdb.csv                     HDB Property Information（无坐标，按 blk_no + street 匹配 addr:*）
//   data/geo/local/ura-landuse.geojson   URA 2019 土地用途（LU_DESC、GPR 为普通字段）
// 输出：
//   data/geo/build/buildings.json        BuildingRec[]
//   data/geo/build/buildings-stats.json  各 src/cls 计数、高度直方图、HDB 匹配率
//
// 高度链（记录 src）：height → building:levels → HDB max_floor_lvl → URA GPR → 默认 12 m。
// 补充：OSM 里塔楼常拆成 building:part（如 Guoco Tower 的 building 外轮廓只有 30 m 裙楼，塔楼是 180 m 的 part），
// 所以 height 一步取 max(建筑自身 height, 落在足迹内的所有 building:part 的 height)，仍记为 src='height'。
// 环方向约定见 lib/geom.ts 文件头：外环俯视逆时针（鞋带有符号面积 < 0），孔洞顺时针。
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse as parseCsv } from 'csv-parse/sync';
import { GEO_DIR, LOCAL_DIR, ensureDir, fileSize, fmtBytes, log, warn } from './lib/common.ts';
import { area, bbox, bboxContains, centroid, cleanRing, orient, pointInPolygon, type BBox, type Pos, type Ring } from './lib/geom.ts';

// ---------------------------------------------------------------------------
// 类型
// ---------------------------------------------------------------------------

type Cls = 'hdb' | 'shophouse' | 'glass' | 'landmark' | 'generic';
type Src = 'height' | 'levels' | 'hdb' | 'gpr' | 'default';

export interface BuildingRec {
  id: number;
  /** 外环 [x0, z0, x1, z1, ...]，俯视逆时针，首点不重复 */
  ring: number[];
  /** 孔洞，俯视顺时针 */
  holes?: number[][];
  /** 高度（米） */
  h: number;
  levels: number;
  cls: Cls;
  src: Src;
  name?: string;
  blk?: string;
  street?: string;
}

interface Feature {
  type: 'Feature';
  properties: Record<string, unknown> | null;
  geometry: { type: string; coordinates: unknown } | null;
}
interface FeatureCollection {
  type: 'FeatureCollection';
  features: Feature[];
}

interface HdbRow {
  blk_no: string;
  street: string;
  max_floor_lvl: string;
  year_completed: string;
  residential: string;
}

interface Parcel {
  lu: string;
  gpr: number | null;
  bbox: BBox;
  outer: Ring;
  holes: Ring[];
}

interface Part {
  h: number;
  c: Pos;
}

const BUILD_DIR = resolve(GEO_DIR, 'build');
const OUT_JSON = resolve(BUILD_DIR, 'buildings.json');
const OUT_STATS = resolve(BUILD_DIR, 'buildings-stats.json');

const MIN_AREA = 8; // m²
const LEVEL_H = 3.2; // 一般楼层高
const HDB_LEVEL_H = 2.9; // 组屋楼层高
const DEFAULT_H = 12;
const H_MIN = 3;
const H_MAX = 300;
const LANDMARK_H = 120;
const LANDMARK_RE =
  /Marina Bay Sands|Esplanade|Fullerton|UOB Plaza|One Raffles Place|Tanjong Pagar Centre|Guoco|Pinnacle|Capital Tower|Republic Plaza|OCBC Centre|Singapore Flyer|ArtScience|Lau Pa Sat|Telok Ayer Market|Sri Mariamman|Buddha Tooth|Thian Hock Keng|Jamae/i;

// ---------------------------------------------------------------------------
// 工具
// ---------------------------------------------------------------------------

function readJson<T>(path: string): T | null {
  if (fileSize(path) <= 0) {
    warn(`missing ${path}`);
    return null;
  }
  return JSON.parse(readFileSync(path, 'utf8')) as T;
}

const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v.trim() : undefined);

/** 解析 OSM height / building:levels 这类"数字（可带单位）"字段；非正数视为无效 */
function parseNum(v: unknown): number | null {
  const s = str(v);
  if (!s) return null;
  const m = /^\s*(-?\d+(?:\.\d+)?)\s*(m|metres|meters)?\s*$/i.exec(s);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) && n > 0 ? n : null;
}

const r2 = (v: number) => Math.round(v * 100) / 100;

/** 街名规范化：大写、去标点、缩写统一（与 HDB CSV 的写法对齐） */
const STREET_ABBR: Record<string, string> = {
  ROAD: 'RD',
  STREET: 'ST',
  AVENUE: 'AVE',
  JALAN: 'JLN',
  BUKIT: 'BT',
  LORONG: 'LOR',
  CRESCENT: 'CRES',
  CENTRAL: 'CTRL',
  DRIVE: 'DR',
  UPPER: 'UPP',
  NORTH: 'NTH',
  SOUTH: 'STH',
  CLOSE: 'CL',
  PLACE: 'PL',
  HEIGHTS: 'HTS',
  GARDENS: 'GDNS',
  TERRACE: 'TER',
  VIEW: 'VW',
  LINK: 'LINK',
  WALK: 'WALK',
  // CSV 里实际出现的额外缩写
  PARK: 'PK',
  TANJONG: 'TG',
  MARKET: 'MKT',
  KAMPONG: 'KG',
  BOULEVARD: 'BLVD',
};
function normStreet(s: string): string {
  return s
    .toUpperCase()
    .replace(/[^A-Z0-9 ]+/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => STREET_ABBR[w] ?? w)
    .join(' ');
}

const hdbKey = (blk: string, street: string) => `${blk.toUpperCase().replace(/\s+/g, '')}|${normStreet(street)}`;

// ---------------------------------------------------------------------------
// 输入
// ---------------------------------------------------------------------------

/** 读 HDB CSV → blk|street → 行 */
function loadHdb(): { byKey: Map<string, HdbRow>; rows: HdbRow[] } {
  const path = resolve(GEO_DIR, 'hdb.csv');
  const byKey = new Map<string, HdbRow>();
  if (fileSize(path) <= 0) {
    warn(`missing ${path} — HDB matching disabled`);
    return { byKey, rows: [] };
  }
  const rows = parseCsv(readFileSync(path, 'utf8'), { columns: true, skip_empty_lines: true, trim: true }) as HdbRow[];
  for (const r of rows) {
    if (!r.blk_no || !r.street) continue;
    const k = hdbKey(r.blk_no, r.street);
    if (!byKey.has(k)) byKey.set(k, r);
  }
  return { byKey, rows };
}

/** 读 URA 地块（Polygon / MultiPolygon 每个部分一条） */
function loadParcels(): Parcel[] {
  const fc = readJson<FeatureCollection>(resolve(LOCAL_DIR, 'ura-landuse.geojson'));
  const out: Parcel[] = [];
  if (!fc) return out;
  for (const f of fc.features) {
    const g = f.geometry;
    const p = f.properties ?? {};
    if (!g) continue;
    const polys = g.type === 'Polygon' ? [g.coordinates as Ring[]] : g.type === 'MultiPolygon' ? (g.coordinates as Ring[][]) : [];
    const lu = str(p.LU_DESC) ?? '';
    const gprNum = Number(p.GPR);
    const gpr = Number.isFinite(gprNum) && gprNum > 0 ? gprNum : null;
    for (const rings of polys) {
      const outer = cleanRing(rings[0]);
      if (outer.length < 3) continue;
      const holes = rings.slice(1).map((r) => cleanRing(r)).filter((r) => r.length >= 3);
      out.push({ lu, gpr, bbox: bbox([outer]), outer, holes });
    }
  }
  return out;
}

function findParcel(parcels: Parcel[], p: Pos): Parcel | null {
  for (const pc of parcels) {
    if (!bboxContains(pc.bbox, p)) continue;
    if (pointInPolygon(p, pc.outer, pc.holes)) return pc;
  }
  return null;
}

/** 从 other_tags（hstore 文本）取一个键的值 */
function otherTag(p: Record<string, unknown>, key: string): string | undefined {
  const raw = str(p.other_tags);
  if (!raw) return undefined;
  const m = new RegExp(`"${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"=>"([^"]*)"`).exec(raw);
  return m ? m[1] : undefined;
}

/** 收集带 height 的 building:part 多边形（质心 + 高度），用于抬高 building 外轮廓的高度 */
function collectParts(polys: FeatureCollection): Part[] {
  const out: Part[] = [];
  for (const f of polys.features) {
    const p = f.properties ?? {};
    const part = otherTag(p, 'building:part');
    if (!part || part === 'no' || !f.geometry) continue;
    const h = parseNum(p.height);
    if (h === null) continue;
    const g = f.geometry;
    const parts: Ring[][] =
      g.type === 'Polygon' ? [g.coordinates as Ring[]] : g.type === 'MultiPolygon' ? (g.coordinates as Ring[][]) : [];
    for (const rings of parts) {
      const outer = cleanRing(rings[0] ?? []);
      if (outer.length < 3) continue;
      out.push({ h, c: centroid(outer) });
    }
  }
  return out;
}

/** 足迹内所有 building:part 的最大 height；没有则 null */
function maxPartHeight(parts: Part[], outer: Ring, holes: Ring[], b: BBox): number | null {
  let best: number | null = null;
  for (const pt of parts) {
    if (!bboxContains(b, pt.c)) continue;
    if (!pointInPolygon(pt.c, outer, holes)) continue;
    if (best === null || pt.h > best) best = pt.h;
  }
  return best;
}

/** 收集切片内出现过的街名（建筑 addr:street + 道路 name/addr:street），用于判断 HDB CSV 记录是否落在切片内 */
function collectStreets(polys: FeatureCollection, lines: FeatureCollection | null): Set<string> {
  const set = new Set<string>();
  const add = (v: unknown) => {
    const s = str(v);
    if (s) set.add(normStreet(s));
  };
  for (const f of polys.features) {
    add(f.properties?.['addr:street']);
  }
  if (lines) {
    for (const f of lines.features) {
      const p = f.properties ?? {};
      if (p.highway) add(p.name);
      add(p['addr:street']);
    }
  }
  return set;
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

function main(): void {
  const polys = readJson<FeatureCollection>(resolve(LOCAL_DIR, 'osm-polygons.geojson'));
  if (!polys) {
    console.error('osm-polygons.geojson missing — run 02-project first');
    process.exit(1);
  }
  const lines = readJson<FeatureCollection>(resolve(LOCAL_DIR, 'osm-lines.geojson'));
  const hdb = loadHdb();
  const parcels = loadParcels();
  const streetsInSlice = collectStreets(polys, lines);
  const bparts = collectParts(polys);
  log(`inputs: polygons=${polys.features.length} hdb rows=${hdb.rows.length} parcels=${parcels.length} building:parts with height=${bparts.length} streets in slice=${streetsInSlice.size}`);

  const recs: BuildingRec[] = [];
  const stats = {
    inputBuildings: 0,
    dropped: { smallArea: 0, degenerate: 0 },
    multipolygonParts: 0,
    bySrc: {} as Record<Src, number>,
    byCls: {} as Record<Cls, number>,
    byBuildingTag: {} as Record<string, number>,
    heightHistogram: {} as Record<string, number>,
    hdb: {
      matchedBuildings: 0, // OSM 建筑（记录）匹配到 CSV 的数量
      matchedCsvRows: 0, // 被匹配到的不同 CSV 行数
      buildingsWithAddr: 0, // 有 addr:housenumber + addr:street 的记录数
      matchRateOfAddr: 0, // matchedBuildings / buildingsWithAddr
      csvRowsOnSliceStreets: 0, // 街名落在切片内的 CSV 行数
      csvRowsOnSliceStreetsUnmatched: 0, // 其中没匹配到 OSM 建筑的（待日后 OneMap 地理编码）
      matchRateOfCsv: 0, // matchedCsvRows / csvRowsOnSliceStreets
      heightFromLevelsNotHdb: 0, // 匹配到 HDB 但高度仍取自 OSM 字段（height/levels）的数量
    },
    clamped: { low: 0, high: 0 },
    heightRaisedByParts: 0, // 高度被足迹内 building:part 抬高的记录数
    noParcel: 0,
    parcelNoGpr: 0,
  };
  const bump = (o: Record<string, number>, k: string) => {
    o[k] = (o[k] ?? 0) + 1;
  };

  const matchedCsvKeys = new Set<string>();
  let nextId = 1;

  for (const f of polys.features) {
    const p = f.properties ?? {};
    const btag = str(p.building);
    if (!btag || btag === 'no' || !f.geometry) continue;
    stats.inputBuildings++;
    bump(stats.byBuildingTag, btag);

    const g = f.geometry;
    const parts: Ring[][] =
      g.type === 'Polygon' ? [g.coordinates as Ring[]] : g.type === 'MultiPolygon' ? (g.coordinates as Ring[][]) : [];
    if (parts.length > 1) stats.multipolygonParts += parts.length;

    // 属性（所有部分共用）
    const name = str(p.name);
    const hnRaw = str(p['addr:housenumber']);
    const streetRaw = str(p['addr:street']);
    const osmH = parseNum(p.height);
    const osmLevels = parseNum(p['building:levels']);

    // HDB 匹配（无论高度来自哪一步，都用于 cls / blk / street）
    let hdbRow: HdbRow | null = null;
    if (hnRaw && streetRaw) {
      const key = hdbKey(hnRaw, streetRaw);
      const row = hdb.byKey.get(key);
      if (row) {
        hdbRow = row;
        matchedCsvKeys.add(key);
      }
    }
    const hdbLevels = hdbRow ? Number(hdbRow.max_floor_lvl) : NaN;
    const hdbMatched = !!hdbRow && Number.isFinite(hdbLevels) && hdbLevels > 0;

    for (const rings of parts) {
      const outer = cleanRing(rings[0] ?? []);
      if (outer.length < 3) {
        stats.dropped.degenerate++;
        continue;
      }
      const a = area(outer);
      if (a < MIN_AREA) {
        stats.dropped.smallArea++;
        continue;
      }
      const holes = rings
        .slice(1)
        .map((r) => cleanRing(r))
        .filter((r) => r.length >= 3 && area(r) > 0);
      if (hnRaw && streetRaw) stats.hdb.buildingsWithAddr++;

      // 所在 URA 地块（按质心）
      const c = centroid(outer);
      const parcel = findParcel(parcels, c);
      const lu = parcel?.lu ?? '';
      if (!parcel) stats.noParcel++;

      // 组屋样式判断（用于 levels 的层高选择与 cls）
      const hdbStyleAddr = !!hnRaw && /^\d+[A-Z]?$/i.test(hnRaw);
      const residentialParcel = lu.startsWith('RESIDENTIAL');
      const residentialTag = btag === 'apartments' || btag === 'residential';

      // ---- 高度链 ----
      // building:part 抬高：塔楼常拆成 part，外轮廓只标了裙楼高度
      const partH = bparts.length ? maxPartHeight(bparts, outer, holes, bbox([outer])) : null;
      const effH = partH !== null && (osmH === null || partH > osmH) ? partH : osmH;
      if (effH !== osmH) stats.heightRaisedByParts++;
      let h: number;
      let src: Src;
      let levels: number | null = null;
      if (effH !== null) {
        h = effH;
        src = 'height';
        // 高度来自塔楼 part 时，外轮廓的 building:levels 只是裙楼层数，不采用
        if (osmLevels !== null && effH === osmH) levels = Math.round(osmLevels);
        if (hdbMatched) stats.hdb.heightFromLevelsNotHdb++;
      } else if (osmLevels !== null) {
        // 是否按组屋层高：已匹配 HDB，或 住宅地块 + apartments/residential + ≥8 层 + 组屋样式门牌
        const likelyHdb = hdbMatched || (residentialParcel && residentialTag && osmLevels >= 8 && hdbStyleAddr);
        h = osmLevels * (likelyHdb ? HDB_LEVEL_H : LEVEL_H);
        src = 'levels';
        levels = Math.round(osmLevels);
        if (hdbMatched) stats.hdb.heightFromLevelsNotHdb++;
      } else if (hdbMatched) {
        h = hdbLevels * HDB_LEVEL_H;
        src = 'hdb';
        levels = hdbLevels;
      } else if (parcel && parcel.gpr !== null) {
        const lv = Math.min(40, Math.max(2, Math.round(parcel.gpr / 0.45)));
        h = lv * LEVEL_H;
        src = 'gpr';
        levels = lv;
      } else {
        if (parcel) stats.parcelNoGpr++;
        h = DEFAULT_H;
        src = 'default';
      }
      if (h < H_MIN) {
        h = H_MIN;
        stats.clamped.low++;
      } else if (h > H_MAX) {
        h = H_MAX;
        stats.clamped.high++;
      }
      h = r2(h);
      // 已知层数（levels / hdb）保留；否则由高度反推
      if (levels === null || levels < 1) levels = Math.max(1, Math.round(h / LEVEL_H));

      // ---- 分类 ----
      let cls: Cls = 'generic';
      const luCommercial = lu.includes('COMMERCIAL');
      const luBusiness = lu.includes('BUSINESS');
      const luResidential = lu.includes('RESIDENTIAL');
      if (h > LANDMARK_H || (name && LANDMARK_RE.test(name))) {
        cls = 'landmark';
      } else if (hdbMatched || (residentialParcel && residentialTag && levels >= 8 && hdbStyleAddr)) {
        cls = 'hdb';
      } else if (levels >= 15 && (luCommercial || luBusiness || btag === 'office' || btag === 'commercial' || btag === 'hotel')) {
        cls = 'glass';
      } else if (
        levels <= 4 &&
        a < 400 &&
        (btag === 'yes' || btag === 'retail' || btag === 'commercial' || btag === 'house' || btag === 'terrace') &&
        (luCommercial || luResidential)
      ) {
        cls = 'shophouse';
      }

      // ---- 组装 ----
      const rec: BuildingRec = {
        id: nextId++,
        ring: orient(outer, true).flatMap(([x, z]) => [r2(x), r2(z)]),
        h,
        levels,
        cls,
        src,
      };
      if (holes.length) rec.holes = holes.map((r) => orient(r, false).flatMap(([x, z]) => [r2(x), r2(z)]));
      if (name) rec.name = name;
      if (hdbMatched && hdbRow) {
        rec.blk = hdbRow.blk_no;
        rec.street = hdbRow.street;
        stats.hdb.matchedBuildings++;
      } else if (hnRaw && streetRaw) {
        rec.blk = hnRaw;
        rec.street = streetRaw;
      }
      recs.push(rec);

      bump(stats.bySrc, src);
      bump(stats.byCls, cls);
      const bin = Math.floor(h / 10) * 10;
      bump(stats.heightHistogram, `${bin}-${bin + 10}`);
    }
  }

  // ---- HDB 反向统计：CSV 里街名落在切片内的行 ----
  stats.hdb.matchedCsvRows = matchedCsvKeys.size;
  for (const r of hdb.rows) {
    if (!r.blk_no || !r.street) continue;
    if (!streetsInSlice.has(normStreet(r.street))) continue;
    stats.hdb.csvRowsOnSliceStreets++;
    if (!matchedCsvKeys.has(hdbKey(r.blk_no, r.street))) stats.hdb.csvRowsOnSliceStreetsUnmatched++;
  }
  stats.hdb.matchRateOfAddr = stats.hdb.buildingsWithAddr ? r2(stats.hdb.matchedBuildings / stats.hdb.buildingsWithAddr) : 0;
  stats.hdb.matchRateOfCsv = stats.hdb.csvRowsOnSliceStreets ? r2(stats.hdb.matchedCsvRows / stats.hdb.csvRowsOnSliceStreets) : 0;

  // 直方图按下限排序
  stats.heightHistogram = Object.fromEntries(
    Object.entries(stats.heightHistogram).sort((x, y) => Number(x[0].split('-')[0]) - Number(y[0].split('-')[0])),
  );
  stats.byBuildingTag = Object.fromEntries(Object.entries(stats.byBuildingTag).sort((x, y) => y[1] - x[1]));

  const tallest = recs
    .slice()
    .sort((x, y) => y.h - x.h)
    .slice(0, 10)
    .map((r) => ({ id: r.id, name: r.name ?? null, h: r.h, levels: r.levels, src: r.src, cls: r.cls }));

  // ---- 输出 ----
  ensureDir(BUILD_DIR);
  writeFileSync(OUT_JSON, JSON.stringify(recs));
  const full = { total: recs.length, ...stats, tallest, bytes: fileSize(OUT_JSON) };
  writeFileSync(OUT_STATS, JSON.stringify(full, null, 2));

  log(`\nbuildings: ${recs.length} (from ${stats.inputBuildings} OSM features; dropped small=${stats.dropped.smallArea} degenerate=${stats.dropped.degenerate})`);
  log(`src: ${JSON.stringify(stats.bySrc)}`);
  log(`cls: ${JSON.stringify(stats.byCls)}`);
  log(
    `hdb: matched buildings=${stats.hdb.matchedBuildings}/${stats.hdb.buildingsWithAddr} with addr (${(stats.hdb.matchRateOfAddr * 100).toFixed(1)}%); ` +
      `csv rows on slice streets=${stats.hdb.csvRowsOnSliceStreets}, matched=${stats.hdb.matchedCsvRows} (${(stats.hdb.matchRateOfCsv * 100).toFixed(1)}%), unmatched (no geocode yet)=${stats.hdb.csvRowsOnSliceStreetsUnmatched}`,
  );
  log(`no parcel=${stats.noParcel} parcel without GPR=${stats.parcelNoGpr} clamped low/high=${stats.clamped.low}/${stats.clamped.high} height raised by building:part=${stats.heightRaisedByParts}`);
  log('height histogram (10 m bins):');
  for (const [k, v] of Object.entries(stats.heightHistogram)) log(`  ${k.padStart(8)} ${String(v).padStart(5)} ${'#'.repeat(Math.min(60, Math.round(v / 10)))}`);
  log('tallest 10:');
  for (const t of tallest) log(`  ${String(t.h).padStart(6)} m  lv=${String(t.levels).padStart(3)}  ${t.src.padEnd(7)} ${t.cls.padEnd(9)} ${t.name ?? '(unnamed)'}`);
  log(`\nwrote ${OUT_JSON} (${fmtBytes(fileSize(OUT_JSON))}) + buildings-stats.json`);
}

main();
