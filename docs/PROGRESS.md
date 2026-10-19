# REA City → 新加坡现实世界生活模拟 · 任务看板

> 跨会话接力用。主控每完成一项就更新；新会话先读本文件，再读计划 `~/.claude/plans/agile-booping-parrot.md`，再 `git log`。
> 状态：`[ ]` 未开始 · `[~]` 进行中 · `[x]` 完成并验收

## 执行约定
- 主控（Claude 主会话）拆任务、写简报、验收、提交；代码由子代理写。
- 子代理不 commit；文件所有权按任务划分，不碰别人的文件。
- 每项验收：`npm run check` + 相关 Playwright/脚本检查；通过后主控提交一次。

## Phase 0 — 基建 + 路网通用化
- [x] P0.0 git init、.gitignore（data/）、本看板、首次提交
- [x] P0.A RoadGraph 数据驱动 + GridGraph + Pathfinder + TrafficAI/PoliceAI/Spawner 适配 + DRIVE_SIDE + Settings.ts + Player 右侧下车（提交见 git log；grid 回归：交通 89% 正常、全部靠左、警车 3 s 追到、fps 120）
- [x] P0.B Colliders 多边形体 + circlePoly + addChunk/removeChunk + queryRay + Weapon 改用 queryRay（提交 5a5fbcd；9/9 单测；调用方仍用 circleAABB，接入真实城市时改 circleBody）
- [x] P0.V 验收：由 P0.A/P0.B 各自 Playwright 验证覆盖（射击命中楼房与车、交通、警察）

## Phase 1 — 离线数据流水线 scripts/geo/
- [x] P1.1 00-download / 01-extract / 02-project（提交 47168d8；data/geo/local 25 MB；切片内建筑 3709，80% 有层数/高度）
- [x] P1.2 03-roads（3410 节点/5738 边/312 km；signal 232；SCC 76% 改为 scc+attached 模式保留快速路；死路 229 由 TrafficAI 回收）
- [x] P1.3 04-buildings（3704 栋；src height 1666/levels 1249/default 519/gpr 237/hdb 33；HDB CSV 匹配 67%，120 行无门牌待 OneMap 地理编码）
- [x] P1.4 05-landuse / 06-props / 07-pois（ground.png 2 m/px；道具 13810；POI 369：home×4、office×5、hawker 55、mrt 24、police、hospital、landmark 8）
- [~] P1.5 08-roadmesh / 09-chunks → public/world/sg/

## Phase 2 — 首个可玩版本（真实地图）
- [ ] P2.1 WorldSource + SgWorld 加载器 + ChunkManager
- [ ] P2.2 RoadMarkings + 建筑分类着色 + 天际线 + 小地图 PNG
- [ ] P2.3 Game 接入、出生点、__game 新钩子
- [ ] P2.V 验收清单（见计划）

## Phase 3 — 时钟 / 昼夜 / 天气
- [x] P3.1 Clock + DayNight（阴影 2048 跟随玩家；窗户自发光；路灯光晕；世界约定 scene.userData.windows/lamps/lampHead/roads）
- [x] P3.2 Weather（clear/cloudy/storm；4000 雨丝 GPU；闪电+雷声；遗留：车辆假阴影贴片与真实阴影叠加）

## Phase 4 — 身份 + 角色系统
- [~] P4.1 资产下载与评估（Quaternius Modular / Kenney Blocky）
- [ ] P4.2 Blender 转换脚本 → characters.glb
- [ ] P4.3 CharacterLibrary / CharacterInstance / 行人与玩家替换
- [ ] P4.4 roles.ts + presets.json + Creator UI + 存档

## Phase 5 — 生活模拟
- [ ] P5.1 Needs + Poi/Interactions（小贩中心、MRT、家、办公楼、工地、的士站）
- [ ] P5.2 Signals + Law（合并 Wanted）
- [ ] P5.3 Jobs（四身份工作线）+ Quests + 手机 HUD + 署名

## Phase 6 — 打磨
- [ ] 步行道/天桥、桥梁抬高、地标、招牌贴图、音效、性能、README、启动器

## 日志
- 2026-10-19 计划批准；git init；看板建立。
