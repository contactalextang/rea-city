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
- [x] P1.5 08-roadmesh / 09-chunks → public/world/sg（209 块 7.4 MB + png；ChunkFormat 共用；6/6 单测；提交 09e13cc）

## Phase 2 — 首个可玩版本（真实地图）
- [x] P2.1 SgWorld + ChunkManager + 查看页（牛车水首屏 0.8 s，draw ~60，fps 120；接入提示：灯柱光晕需在块变化后重建、雾 far 放远看天际线、MBS 是单盒子待地标精做）
- [x] P2.2 RoadMarkings + 建筑分类着色 + 天际线 + 小地图 PNG（并入 P2.1）
- [x] P2.3 Game 接入 sg（默认）；init 0.36 s；交通 70–79% 在走；警车 5–21 s 追到；draw 99–179
- [x] P2.V 验收通过（遗留：sg 无 shop POI，m_race 无发布人；夜间光晕偏淡；局部排队）

## Phase 3 — 时钟 / 昼夜 / 天气
- [x] P3.1 Clock + DayNight（阴影 2048 跟随玩家；窗户自发光；路灯光晕；世界约定 scene.userData.windows/lamps/lampHead/roads）
- [x] P3.2 Weather（clear/cloudy/storm；4000 雨丝 GPU；闪电+雷声；遗留：车辆假阴影贴片与真实阴影叠加）

## Phase 4 — 身份 + 角色系统
- [x] P4.1 资产评估：选定 Quaternius Ultimate Modular Men/Women（CC0，62 骨男女同序，纯色材质，24 clip 含 Aim/Shoot，无 Jump/Sit）；详见 data/assets-eval/REPORT.md（gitignored）
- [x] P4.2 scripts/char/build.ts → public/assets/characters（glb 3.75 MB，46 部件，24 clip，14 预设；女包重蒙皮到男包绑定姿态；无 Jump/Sit/Drive 动画；three 会去掉节点名中的 : 用 userData.part 查找）
- [x] P4.3 玩家/行人骨骼角色 + Creator 接入开局/衣柜（60 行人 draw ~110，不限帧 530 fps；?chars=box 回退）
- [x] P4.4 Creator 组件（58f3a7d）；接入开局与换装在 P4.3b

## Phase 5 — 生活模拟
- [x] P5.1 Needs + Poi/Interactions/Panels/Phone/Save（方格城合成 POI 验证通过；真实世界只需 pois.load；遗留：的士与车辆不进存档）
- [x] P5.2 Signals + Law（Wanted 已删；roles.ts 四身份；?role= 切换；吊销仅提示不阻止）
- [x] P5.3 Jobs + Quests + 手机工作页（计价/外卖/偷车/保护费/会议/投资/加班实测通过；gang_wreck 与撞车扣评分未实测）

## Phase 6 — 打磨
- [x] P6a 地标 10 个（18 draw）+ 滨海湾水面 + shop POI 60 个（修复 m_race 无发布人）
- [x] P6c 文字街景（路名牌/楼号/招牌/站牌/LOOK RIGHT，2 draw call；遗留：图集整张重传、MRT 旧绿牌露出）
- [~] P6b 车辆外观 + 环境音进行中
- [ ] P6d README、桌面启动器、最终全流程验收
- [ ] 后续可选：步行道图/天桥可走、桥梁抬高、五脚基、OneMap 补 HDB 层数

## 日志
- 2026-10-19 计划批准；git init；看板建立。
- 2026-10-20 Phase 0/1/3 与 P5.1/P5.2 已提交；进行中 P2.1（加载器+查看页）、P4.2（角色 glb）、P5.3（工作/任务）；下一步 P2.3 接入 Game（WorldSource 切换、pois.load、signalLights）、P4.3 角色运行时、P4.4 建角色界面。
