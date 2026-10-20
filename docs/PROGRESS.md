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
- [x] P6b 车辆五种轮廓 + 新加坡的士/巴士/警车涂装 + 环境音（4583486）
- [x] P6d 修遗留 + README 重写 + 桌面启动器重建 + 四身份终验通过；建角色 Enter 与的士结算偶发已修

## Phase 7 — 试玩反馈修正（计划 ~/.claude/plans/witty-questing-wozniak.md）
- [x] P7.1 驾驶与执法放宽：路口信号簇同步、闯红灯宽限/冷却、碰撞去重与肇事方判定、灯柱推出车行道、转向手感、警察放缓、lawStrictness 设置
- [x] P7.2 小地图与任务指引：事件步给最近 POI 目标、独有目标色+脉冲+屏外箭头+距离、3D 光柱加亮、HUD 方位距离
- [x] P7.3 遗留 bug：天气手动锁定/跳时不重掷/进存档、按键边沿多步重复、F 上客、sidewalkOff、构建 chunk 警告、合入 P7.2 补丁
- [x] P7.V 四身份终验（开局均有品红目标与方位距离、无页面报错）+ 看板/README/记忆更新
- [x] P7.4 音频：去掉背景“嘭嘭”（NPC 撞人不再出声，撞击音阈值 4 + 0.35 s 去抖，车流底噪调轻）；新增 Music.ts 程序合成背景音乐（步行氛围乐 / 驾车车载电台交叉淡化，夜间更暗，通缉压低），手机设置“音乐 开/关”，`?music=0`

## Phase 8 — 成长与产业帝国（计划 ~/.claude/plans/glimmering-yawning-sprout.md）
> 起因：试玩反馈"无聊、单调"；调研 GTA Online/GTA6、Schedule I、Roblox 放置类、FiveM RP 后，本轮只做 成长与消费 + 产业经营。
- [x] P8.1 基础层：Wallet/净资产、Progress 等级头衔/XP/成就/终身统计、解锁表、Assets/Business 桩、事件、存档字段、手机三新应用、HUD 等级条
- [x] P8.2 商店与资产：车/房/升级目录、车库取车、自有房产睡觉、效果倍率（并行 P8.3）
- [x] P8.3 产业帝国：四身份产业表、每小时钱柜、收钱/升级/雇经理、07:00 风险事件、小地图金圈（并行 P8.2）
- [x] P8.4 整合与平衡：被捕/死亡联动、净资产显示、购买自动存档、econ-sim 平衡脚本
- [x] P8.5 帝国任务线：新步骤类型、story/empire 分层、每身份 4 任务、帝国总结
- [x] P8.V 四身份终验 + 看板/README/记忆

## Phase 9 — 画面质感（计划 ~/.claude/plans/optimized-chasing-lantern.md）
> 起因：试玩反馈人物质感差，参考赛博朋克 2077 夜景；保留 Quaternius 模型，只升级渲染管线与角色材质。
- [x] P9.A 后期管线 PostFX（AgX/GTAO/泛光/调色/SMAA）+ ?fx= 设置 + DayNight 环境光/曝光重校/夜间角色轮廓光
- [x] P9.B 角色 PBR 材质（CharacterMaterial：皮肤/布料三平面织纹/头发/皮革分区 + 菲涅尔边缘光）
- [x] P9.C 夜景氛围：窗户/招牌/路灯 HDR 发光、路面 Standard + 雨天湿地反光
- [x] P9.V 截图对比四时段 + 性能 + 回归 + 看板/README/记忆

## Phase 10 — 夜间提亮 + 娱乐消费（计划 ~/.claude/plans/swirling-shimmying-mochi.md）
> 起因：试玩反馈"晚上太黑、可玩性不够"；用户选定：明显提亮+车灯、类 CS 射击赛、赌场四类玩法全要、夜店带恋爱关系系统。
- [x] P10.0 娱乐基础层：casino/club/race/arena POI（data/venues.ts）、营业时间、心情需求、Activity 宿主与 'activity' state、新事件/统计/成就、钱包类别
- [x] P10.A 夜间提亮：关键帧/调色重调、路灯真实光池（8 盏 PointLight 池）、玩家车灯 SpotLight + NPC 光锥贴花、亮度设置 ?bright=
- [ ] P10.B 赌场（滨海湾金沙）：21 点/轮盘/骰宝/百家乐/老虎机、入场税、限额解锁、RTP 脚本
- [ ] P10.C 街头赛车：路线检查点链、3 AI 对手、名次/计时 HUD、报名费/奖金/下注、违法通缉、白天合法赛
- [ ] P10.D 射击竞技（类 CS）：D1 地图+第一人称移动射击 / D2 Bot AI / D3 回合经济+C4+段位
- [ ] P10.E 夜店 + 恋爱关系：酒水、节奏舞蹈、8 位可约会 NPC、好感阶段、手机联系人、约会同伴
- [ ] P10.V 整合验收 + 看板/README/记忆

## 后续
- [x] 外部道具模型（计划 ~/.claude/plans/ethereal-imagining-glade.md）：行道树默认换 threejsassets shade-tree（`?props=proc` 改回程序化）；待定是否推广到巴士站/长椅/垃圾桶
- [ ] 后续可选：步行道图/天桥可走、桥梁抬高、五脚基、OneMap 补 HDB 层数

## 日志
- 2026-10-19 计划批准；git init；看板建立。
- 2026-10-20 Phase 0/1/3 与 P5.1/P5.2 已提交；进行中 P2.1（加载器+查看页）、P4.2（角色 glb）、P5.3（工作/任务）；下一步 P2.3 接入 Game（WorldSource 切换、pois.load、signalLights）、P4.3 角色运行时、P4.4 建角色界面。
- 2026-10-20 全部计划阶段（0–6）完成。已知小问题：调时钟会重掷天气、玩家开巴士易累积罚单、F 上客偶发失败（未定位）、BufferGeometryUtils chunk 632 kB、文字图集整张重传。后续可选见 Phase 6 最后一项。
- 2026-10-20 新增 Phase 7（试玩反馈：驾驶执法太严、金领小地图指引不明显 + 4 个遗留小问题）。
- 2026-10-20 P7.1（56423cc：同路线 14 路口罚单 3→0；警车追撞黑帮 1 星不再升到 5 星；车行道内路灯/信号杆碰撞体 290→0）与 P7.2（78556c7：四身份开局都有品红目标、屏外箭头、HUD 方位距离）已提交；P7.3 进行中。
- 2026-10-20 Phase 7 完成（bd81256 等）：F 上客 20/20 不再被甩下车（根因：一帧多物理步时按键边沿重复）；天气手动锁定 3 h 且跳时不重掷、进存档；构建无体积警告（three 626 kB 单独分包）。
  遗留：单向路车道偏在一侧（lanePoint 对单行道仍按 DRIVE_SIDE 偏移，与路面对称铺设不一致）；约 47/170 公交站碰撞体在车行道内；个别建筑足迹压进 primary 路（约 570,250）；调试钩子 weather.set 现默认锁 3 h（lockHours=0 取消）。
- 2026-10-20 P7.4 音频：步行 40 s 撞击音 0 次；上车 radio、下车 ambient；音乐开关持久化。
- 2026-10-20 外部道具模型试验：threejsassets 免费 GLB（Draco）经 `npm run props:build` 解压合并为 props.glb（103 KB，含 shade-tree 549 三角 / metropolis-street-tree-01 392 三角）；`?props=glb` 替换 tree 池几何，查看页 120 fps 无变化，树三角面约 40→549/棵。许可证禁止单独再分发模型文件——仓库若公开需排除 public/assets/props/。
- 2026-10-20 新行道树设为默认，`?props=glb` 改为 `?props=proc` 反向开关。
- 2026-10-20 Phase 8 完成：等级/成就、商店（车/房/升级）、四身份 10 种产业与每日风险、帝国任务线；econ-sim 首个产业 4.8–7.1 分钟（金领开局即可）、中期目标 48.7–72 分钟；睡觉需精力 ≤70（堵经理刷钱）；通关遮罩只弹一次。
  遗留：蓝领后期偏强（180 分钟净资产约 $100k）；金领中期目标卡 Lv5 门槛（72/78 分钟）；买下产业不满一小时不计收入；任务奖励/罚款/房租仍按每帧现金差分记入收支。下一轮可选：随机事件与支线、手感与追捕升级。
- 2026-10-20 Phase 9 画面质感完成：P9.A 55ac97b（PostFX/AgX/环境光）、P9.B 65eb933（角色 PBR 材质，单 program）、P9.C（路面 Standard + 湿地反光/路灯倒影条纹、招牌夜间 HDR 发光、暴雨夜提亮、low 档 dpr 封顶）。修根因：路面网格绕序朝下，DoubleSide 把法线翻成 -Y，以前太阳从没照亮过路面，改为着色器内固定世界 +Y。回归：四身份、chars=box、fx=low/off 无报错。遗留：车辆无前灯光源（湿路无车灯倒影）、白天暴雨路缘偏亮、帽子下发丝穿模（模型原因）、真机 dpr2 high 档未测（无头 dpr2 约 126 fps）。
