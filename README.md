# REA City — 新加坡市中心生活模拟（Three.js）

浏览器里跑的开放世界：以 **1:1 真实比例**还原新加坡市中心约 4.8 × 2.8 km 的切片——滨海湾、莱佛士坊、牛车水、丹戎巴葛、中峇鲁、红山。路网、建筑足迹与高度、红绿灯、路灯、巴士站、MRT 出口、小贩中心都来自公开数据（OpenStreetMap、LTA DataMall、URA、HDB、NEA），离线烘焙成分块数据后流式加载。

玩法是**生活模拟 + 四种身份**：吃饭睡觉、上班打工、开车坐地铁，昼夜更替、雷雨天气、靠左行驶、交通罚单与警察追捕。默认身份是**黑帮成员**（唯一能开枪的身份），也可以在建角色界面选金领、白领、蓝领。

技术栈：Three.js 0.186 · Vite 8 · TypeScript（严格模式）。没有游戏引擎与后端，存档在浏览器 localStorage。

---

## 运行

需要 Node ≥ 22（数据脚本直接运行 `.ts`）。

```bash
npm install
npm run dev      # http://127.0.0.1:5173
npm run build    # tsc 检查 + 打包到 dist/（多页：游戏 + dev/ 下三个工具页）
npm run check    # 仅 TypeScript 类型检查
npm run preview  # 预览构建产物（端口 4173）
node --test scripts/test/*.test.ts   # 单元测试（碰撞、分块编解码）
```

`public/world/sg/`（约 11 MB 分块世界）与 `public/assets/characters/`（约 4.5 MB 角色库）已随仓库提供，不跑数据流水线也能直接玩。

### URL 参数

| 参数 | 作用 |
|---|---|
| `world=grid` | 改用程序生成的方格城（旧原型，回归测试基线）；默认 `sg` 真实新加坡 |
| `role=gang\|gold\|white\|blue` | 临时指定身份（覆盖建角色结果，便于测试） |
| `fresh=1` | 忽略存档开新局，并打开建角色界面 |
| `creator=1` | 打开建角色界面（以已保存的角色为初值） |
| `chars=box` | 用方块人代替骨骼角色（低配 / 排错） |
| `shadows=0` | 关闭实时阴影 |
| `music=0` | 关闭背景音乐（手机设置页也可开关；步行为轻柔氛围乐，驾车切换为车载电台） |
| `law=relaxed` / `law=real` | 执法松紧。默认 `casual` 畅玩：只有撞人、枪击行人、攻击警察、开枪打车会招来警察，闯红灯 / 超速 / 碰撞 / 抢车 / 酒驾 / 街头赛都不追究。`relaxed` 恢复交通罚单（闯红灯宽限/冷却、扣 6 分，小额碰撞不立即出警，警察更慢、被捕需贴住 4 s）；`real` 接近原版严格度。只认 URL，不存进本地设置 |
| `signs=0` | 关闭文字街景（路名牌、招牌、站牌等） |
| `props=proc` | 行道树改回程序化圆锥树（默认用 threejsassets 低模阔叶树，低配可用此项省约 30 万三角面） |
| `fx=high\|low\|off` | 画质：high 默认（AgX 电影色调 + GTAO + 泛光 + 调色/颗粒/暗角/色差）；low 关 GTAO、半分辨率泛光、高分屏后期封顶 1.25 倍；off 直出（仍保留 AgX 与环境光）。手机设置页「画质」可切换 |
| `timeSpeed=N` | 游戏时钟倍速 |
| `bright=0.7–1.6` | 画面亮度倍率（默认 1，乘到曝光上；夜里嫌暗可以调高，例如 `?bright=1.2`）。手机设置页的「亮度」滑杆（70–160%）是同一个设置 |
| `racedbg=1` | 赛车 AI 调试：每帧记录 AI 决策文字（`__game.plug.race.state().ai[i].dbg`） |

## 操作

| 按键 | 作用 |
|---|---|
| W A S D / 方向键 | 步行移动 / 驾驶 |
| Shift | 奔跑 |
| Space | 跳跃（步行） / 手刹漂移（驾驶） |
| F | 上车 / 下车（可抢 NPC 车）；开的士时接招手乘客 |
| E | 进入附近地点（小贩中心、商店、MRT、住家、办公楼、工地、的士站…） |
| Tab | 手机：状态、工作、地图、角色（衣柜）、设置、存档 / 读档 / 重新开始 |
| H | 鸣喇叭（驾驶时） |
| M | 当前任务提示 |
| Enter | 切换全屏 |
| 鼠标 | 转动视角（点击画面锁定指针，Esc 解锁） |
| 鼠标左键 / 左 Ctrl | 手枪射击（**仅黑帮身份**；锁定指针时自动过肩瞄准） |
| Esc | 关闭面板 / 解锁鼠标；建角色界面中返回 |

## 玩法

### 四种身份

| 身份 | 出生 / 住家 | 初始现金 | 特点 | 工作 |
|---|---|---|---|---|
| 黑帮成员（默认） | 牛车水 52 Pagoda Street | $500 | 可开枪；犯罪累积通缉星、警察追捕 | 偷车交货、收保护费、街头破坏，及三条主线任务 |
| 金领 | 滨海湾 The Sail | $20,000 | 奢侈消费线 | 赶会议、投资（定存/指数/加密，每天 07:00 结算）、上班 |
| 白领 | 中峇鲁 78 Moh Guan Terrace | $2,000 | 房租压力 | 上班打卡（09:00–18:00）、加班（18:00–22:00） |
| 蓝领 | 红山 131 Jalan Bukit Merah | $300 | 房租压力，需求消耗 ×1.3 | 租的士载客、外卖、工地搬运 |

非黑帮身份的犯罪会降级为交通执法（罚单 + 扣分），不会触发通缉。每个身份开局都有一条新手引导任务。

### 需求

饥饿与精力两条需求随游戏时间下降；偏低时减速、屏幕出现暗角，精力归零会昏倒。小贩中心（海南鸡饭、叻沙、Kopi…）和商店补饥饿，回家睡觉恢复精力。

### 交通执法与通缉

- 全城靠左行驶，红绿灯按相位运转，交通 AI 遵守信号。
- 默认畅玩档不开交通罚单，抢车、毁车、酒驾也不追究；只有撞人、枪击行人、攻击警察、开枪打车算犯罪。
- `?law=relaxed` / `?law=real` 下：超速、闯红灯、撞车会开罚单（扣钱 + 扣分），扣满 24 分吊销驾照一天；警署可查记录。
- 黑帮身份的犯罪累积 0–5 星热度并出警追捕；远离警察且一段时间无事件后降星。血量归零或被捕 → 医院醒来并扣钱。

### 出行

- **开车**：路上的车都能抢（F）；巴士、的士、豪车、警车各有手感。
- **MRT**：在站口按 E，按距离计费（$1.19 起，封顶 $2.50）传送到其他站。
- **的士**：的士站日租（蓝领 $30，其他身份 $50）。
- **叫车（Taxi / Grab）**：手机「出行」或各场馆卡上直接叫车，付钱后黑屏直达门口，游戏时间按路程前进。Taxi 按打表价（早晚高峰 ×1.25）；Grab 起价 $3 + $0.7/km + $0.2/分钟 + $0.9 平台费（最低 $6），高峰加价 ×1.3–1.8，雨天再 ×1.2。被通缉、正在做的士/外卖工作、比赛或约会中不能叫车；在车里叫车时车留在原地。

### 成长、资产与产业（Phase 8）
- **等级与头衔**：打工、完成任务、吃饭睡觉、买东西、产业收入都给经验；满级 30，每 5 级换一个身份头衔（黑帮：小弟→教父）。另有 12 个成就和终身统计，见手机「成长」。
- **商店**：手机「商店」或 shop 门口可以买车、升级（防弹衣、改装手枪、引擎套件、人体工学装备、网约车 App、彭博终端）；房产要到门口买。买的车进车库，在自家门口"取车"；在自有房产睡觉饥饿消耗更少、第二天经验 +10%，且不扣房租。
- **产业**：四个身份各有产业（黑帮：保护费地盘/拆车厂/地下赌档；蓝领：小贩档口/的士车队；白领：创业公司/咖啡连锁；金领：商铺出租/写字楼股份/地标项目）。到对应地点门口买下、升级、雇经理；每游戏小时往钱柜攒钱，亲自去收 +10%，经理自动入账 80%。每天 07:00 可能出现突袭、查封、景气或低迷。小地图金圈标出自己的产业，手机「生意」可查看和导航。
- **帝国任务线**：故事线完成后自动接上每个身份 4 个帝国任务，终点是净资产目标。
- 精力 >70 时不能睡觉。数值平衡用 `npm run econ:sim` 检查（含心情倍率和每晚娱乐花费模型）；赌场 RTP 用 `npm run casino:sim` 检查。

### 娱乐（Phase 10）

四个场馆在小地图上是不透明大点，离得远时钉在小地图边缘指示方向；手机「赛车 / 竞技 / 赌场 / 联系人」页顶部有场馆卡（营业时间、距离、【导航】），点导航后小地图和 HUD 指向场馆门口，走到 15 m 内自动取消。门口按 E 打开面板。打烊时面板只剩少数全天按钮（如赛道日）。

| 场馆 | 位置（sg 门口坐标） | 营业 | 玩法 |
|---|---|---|---|
| 滨海湾金沙赌场 | 滨海湾 (1319, 145) | 24 小时 | 21 点、轮盘、骰宝、百家乐、老虎机 |
| 克拉码头夜店 | 克拉码头 (66, −704) | 21:00–04:00 | 门票、点酒、节奏舞蹈、VIP 卡座、搭讪 / 约会 |
| 滨海湾赛道 | 摩天轮旁维修区 (1825, −790) | 20:00–04:00（赛道日 08:00–18:00） | 街头赛、合法赛道日 |
| 丹戎巴葛射击俱乐部 | 丹戎巴葛 (27, 563) | 24 小时 | 5v5 爆破、天梯、职业联赛、1v1、死斗 |

方格城（`?world=grid`）也有这四个场馆。

- **赌场**：每天先交入场税 $150（当日有效）。普通厅 $10–$500；高额厅 $100–$5,000（Lv6）；VIP 厅 $1,000–$50,000（Lv10）。点筹码 → 点下注区 → Space 开局。21 点：6 副牌，庄家软 17 停，Blackjack 赔 3:2，可加倍 / 分牌 / 保险，界面会给基本策略建议；快捷键 H 要牌、S 停牌、D 加倍、P 分牌、I / N 买或不买保险。轮盘是欧式单 0；骰宝按澳门赔率表；百家乐完整补牌，押庄赢抽 5%；老虎机 3×3 五条线，RTP 94.05%。一局没结束时 Esc 不能离开，关掉窗口会当场结算。连输 5 局会提示适度娱乐。
- **夜店**：门票平日 $30，周五周六 $40；Lv5 起半价，Lv8 起免费。吧台点酒加心情、加醉意，醉意每游戏小时降 1。醉意 ≥ 2.5 算超过酒驾标准，≥ 8 酒保不再卖酒。醉了画面会晃、会模糊；开车时转向会自己漂，走路会左右飘，越醉越明显。`?law=relaxed|real` 下醉驾被 40 m 内看得见你的警车（包括路边设卡的警车）发现：罚款 $2,000、扣 12 分、通缉 1 星；默认畅玩档不查酒驾。舞蹈是 124 BPM 四轨节奏游戏，用 ←↓↑→ 或 A S W D 按键，判定窗口 Perfect ±60 ms / Good ±130 ms；每晚前两曲加心情，跳得好会吸引 NPC 过来搭话。VIP 卡座需要 Lv3，最低消费 $300，全额转成当晚的酒水额度。
- **恋爱**：8 位可约会的 NPC。关系从陌生 → 认识（要到联系方式）→ 约会中 → 恋人（表白条件：好感 ≥ 80 且约会过 ≥ 2 次）。手机「联系人」里可以发短信、约时间地点；约会对象会跟着你走，约好了不去会掉好感。恋人每天第一次联系心情 +5，可以一起回家过夜。
- **街头赛车**：报名费按 4 人分奖池；可以开自己的车（坐在车上，或停在 80 m 内）参赛，也可以花 $200 租跑车。可押自己拿冠军（$100 / $500 / $2,000）。有 3 名 AI 对手，依次穿过检查点，HUD 显示名次、用时和与前车的差距，小地图上画出整条赛道线。比赛中豁免超速 / 闯红灯 / 碰撞罚单，参赛车伤害只按 0.3 倍算。`?law=relaxed|real` 下非黑帮身份跑街头赛被巡警看到会得 1 星（默认畅玩档不会）。白天的合法赛道日会封路清场，没有通缉风险，奖金较低。滨海湾大奖赛需要 Lv6。
- **射击竞技场**（类 CS，第一人称）：休闲赛报名 $50；天梯 $200（Lv4，ELO 段位共 17 段）；职业联赛 $1,000（Lv12）；1v1 $100；死斗免费。爆破模式先赢 7 回合，有 CS 经济和 40 s 的 C4。

| 竞技场按键 | 作用 |
|---|---|
| W A S D | 移动 |
| 鼠标 | 瞄准（点击画面锁定指针） |
| 鼠标左键 | 开火；拿着手雷时松开左键投出；拿着 C4 时按住左键下包 |
| 鼠标右键 | 开镜（AWP 两档）/ 刀重击 |
| Space | 跳 |
| C | 蹲（不用 Ctrl，避免 Ctrl+W 关掉标签页） |
| Shift | 静步（没有脚步声） |
| 1 / 2 / 3 / 4 / 5 | 主武器 / 副武器 / 刀 / 手雷（再按一次换下一种雷）/ C4 |
| 滚轮 | 依次切换武器 |
| Q | 切回上一把武器 |
| R | 换弹 |
| B | 购买菜单（数字键选类别和物品） |
| E | 下包 / 拆包（按住） |
| Tab | 计分板（按住） |
| Z | 给队友下指令：自由行动 / 跟我 / 守住这里 |
| Esc | 暂停菜单（可以投降退出） |

- **心情**：0–100，开局 70。清醒时每小时降 3，自然衰减降到 40 就停。心情低于 30 时工资和 XP ×0.85，高于 75 时 ×1.1。上班、被捕、倒下扣心情；吃饭、睡觉（醒来至少 50）、喝酒、跳舞、赌赢、赛车完赛或夺冠、射击比赛、约会加心情。左上角和手机状态页都会显示。手机「钱包」页可以看各娱乐类别今天和累计的收支。
- **夜景亮度**：场馆大多夜里营业。觉得画面太暗，可以加 `?bright=1.2`（范围 0.7–1.6），或者在手机设置页拖「亮度」滑杆。

### 存档

在家睡觉会自动存档，住家面板也可手动存档；手机里有「存档 / 读档 / 重新开始」。存档、角色外观、设置分别保存在 localStorage。

## 数据流水线

脚本在 `scripts/geo/`，原始数据与中间产物在 `data/`（已 gitignore），最终产物写到 `public/world/sg/`。需要 GDAL（`ogr2ogr`）。详细说明见 `scripts/geo/README.md`。

| 命令 | 步骤 |
|---|---|
| `npm run geo:download` | 00 下载原始数据到 `data/geo/raw/` |
| `npm run geo:extract` | 01 用 ogr2ogr 按切片范围提取为 GeoJSON |
| `npm run geo:project` | 02 投影到本地米制坐标（原点 103.8465E, 1.2825N）并裁剪 |
| `npm run geo:all` | 依次运行下面 7 步（不含 00–02） |
| `geo:roads` | 03 车行道路网图（车道数、单行、信号灯路口、强连通裁剪；丢弃有盖/地下/停车场通道等 service 路及穿楼 service 边） |
| `geo:buildings` | 04 建筑足迹与高度（OSM height/levels → HDB 层数 → URA GPR → 默认值）及分类；跳过悬空/屋顶/天桥/地下体，压车行道的剔除或裁剪 |
| `geo:landuse` | 05 土地用途栅格 → 地面贴图 |
| `geo:props` | 06 LTA 道具点位（路灯、红绿灯、巴士站、的士站、ERP、MRT 出口、有盖走廊、天桥） |
| `geo:pois` | 07 POI（住家、办公楼、小贩中心、MRT、警署、医院、地标、商店） |
| `geo:roadmesh` | 08 路面网格 |
| `geo:chunks` | 09 按 256 m 分块打包 → `public/world/sg/`（分块、天际线、小地图、manifest） |
| `geo:check` | 净空检查：压车行道的建筑、地铁出口、穿楼车道边（`--list` 列明细，`--strict` 不为 0 时退出码非 0） |

原始数据来源：

- OpenStreetMap 切片：<https://download.bbbike.org/osm/bbbike/Singapore/>（备用 <https://download.geofabrik.de/asia/malaysia-singapore-brunei.html>）
- LTA DataMall 静态地理数据：<https://datamall.lta.gov.sg/content/datamall/en/static-data.html>
- data.gov.sg（<https://data.gov.sg>）：HDB Property Information、URA Master Plan 2019 Land Use、NEA Hawker Centres

角色资产：`npm run char:build` 把 Quaternius Ultimate Modular Men / Women（放在 `data/assets-eval/`）打包成 `public/assets/characters/characters.glb` + `catalog.json`（46 个部件、24 段动画、14 个预设），说明见 `scripts/char/README.md`。

道具模型：`npm run props:build` 把 threejsassets.com 免费模型（Draco GLB，放在 `data/assets-eval/threejsassets/`，需登录下载）解压合并成 `public/assets/props/props.glb`（运行时不需要 Draco 解码器）。

## 代码结构

```
src/
  main.ts, config.ts       入口；全局参数（车辆手感、尺寸、NPC 上限）
  core/        Game（主调度、状态机、window.__game）、Camera（追尾/过肩相机）、Input、Context（共享上下文与事件总线）、Settings（URL/本地设置）
  world/       WorldSource（世界数据源接口）
               SgWorld、ChunkManager、ChunkFormat、BuildingMesh、PropMeshes、RoadMarkings、Landmarks、Signage、TextAtlas   真实新加坡
               GridWorld、CityGenerator、GridGraph                                                                            方格城
               RoadGraph、Pathfinder、Colliders（多边形 + 空间哈希 + 射线）、PoiMarkers、Marker
  physics/     ArcadeVehicle（街机车辆）、Collision
  entities/    Player、Vehicle（轿车/MPV/SUV/跑车/巴士）、Pedestrians、TrafficAI、PoliceAI
  characters/  CharacterLibrary、CharacterInstance、CharacterSpec、presets   骨骼角色运行时
  systems/     Clock、DayNight、Weather、Signals、Law、Needs、Poi、Interactions、Jobs、Quests、Save、Spawner、Weapon、Audio、Wallet、NightLights
  activities/  Plugin（娱乐插件接口）+ casino / club / race / arena 四个玩法插件
  data/        roles、jobs、quests、menus、venues、casino、dates、races、arena、mood   身份、工作、任务、菜单、场馆、娱乐与经济参数
  ui/          Hud、Minimap、Phone、Panels、Creator（建角色界面）、Activity（娱乐小游戏的全屏宿主）
  dev/         worldViewer、charsViewer、creatorViewer   开发工具页脚本
scripts/
  geo/         数据流水线 00–09 + lib/
  char/        角色资产打包
  test/        node --test 单元测试
public/world/sg/           烘焙好的世界数据
public/assets/characters/  角色库
launcher/                  macOS 桌面启动器
```

## 开发工具页

`npm run dev` 后打开：

- `/dev/world.html` — 新加坡世界查看器。WASD 平移、Shift 加速、鼠标拖拽环绕、T 顶视图；1–4 四个住家，5 MBS，6 Raffles Place，7 鱼尾狮，8 滨海艺术中心，9 摩天轮，0 老巴刹，G 超级树，P 达士岭，M 马里安曼庙。参数 `hour=`、`x=&z=`、`shadows=0`、`signs=0`。
- `/dev/chars.html` — 角色库与预设查看器。
- `/dev/creator.html` — 建角色界面独立测试页。

## 调试钩子 `window.__game`

浏览器控制台可用，主要供自动化测试：

- 状态：`stats`（fps / draw calls / 三角形 / NPC 数）、`world`（加载耗时、区块统计）、`player`、`role`、`wanted`、`cars`、`peds`、`police`
- 传送：`teleport(x, z)`、`teleportTo(poiId)`、`pois.list()`
- 时间与天气：`clock.set(hour)`、`clock.skip(h)`、`weather.set('clear'|'cloudy'|'storm')`、`dayNight`
- 生活系统：`needs.set(h, e)`、`interact(poiId)`、`panel.choose(i)`、`phone.show('work')`、`jobs.start(id)` / `jobs.state`、`quests.*`、`save()` / `load()`
- 执法与信号：`law.crime()` / `law.traffic()`、`signals.*`
- 截图辅助：`camShot([dx,dy,dz,lx,ly,lz])`（相对玩家的相机位置与注视点）、`gatherPeds(r)`、`creator.state()`

## 桌面启动器（macOS）

```bash
launcher/make-app.sh launcher/icon-mac-1024.png              # 生成 ~/Desktop/REA City.app
launcher/make-app.sh launcher/icon-mac-1024.png /Applications
```

双击 **REA City.app**：源码有改动时自动构建，启动 `vite preview`（127.0.0.1:4173），并用 Chrome 独立窗口打开。构建日志 `/tmp/rea-build.log`，服务日志 `/tmp/rea-preview.log`。

## 署名与许可

- 地图数据 © OpenStreetMap contributors，[ODbL 1.0](https://www.openstreetmap.org/copyright)。
- Contains information from the Land Transport Authority (LTA DataMall), Urban Redevelopment Authority (URA), Housing & Development Board (HDB) and National Environment Agency (NEA), accessed from data.gov.sg / LTA DataMall, made available under the [Singapore Open Data Licence v1.0](https://data.gov.sg/open-data-licence)。本项目与上述机构无关，亦不代表其背书。
- 角色模型：Quaternius — Ultimate Modular Men / Women，CC0 1.0（原文见 `public/assets/characters/LICENSE-quaternius.txt`）。
- 行道树模型：threejsassets.com — Shade Tree / Metropolis Street Tree 01，Free Commercial License（不得单独再分发模型文件，见 `public/assets/props/LICENSE-threejsassets.txt`）。
- 其余几何（建筑、车辆、地标、其余道具）、音效（WebAudio 合成）与代码均为本项目原创。
