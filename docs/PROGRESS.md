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
- [x] P10.B 赌场（滨海湾金沙）：21 点/轮盘/骰宝/百家乐/老虎机、入场税、限额解锁、RTP 脚本
- [x] P10.C 街头赛车：路线检查点链、3 AI 对手、名次/计时 HUD、报名费/奖金/下注、违法通缉、白天合法赛
- [x] P10.D 射击竞技（类 CS）：D1 地图+第一人称移动射击 / D2 Bot AI / D3 回合经济+C4+段位
- [x] P10.E 夜店 + 恋爱关系：酒水、节奏舞蹈、8 位可约会 NPC、好感阶段、手机联系人、约会同伴
- [x] P10.V 整合验收 + 看板/README/记忆

## Phase 13 — 日常画面电影化（计划 ~/.claude/plans/dazzling-floating-kazoo.md）
> 起因：用户想要"电影般的人物/场景"；选定只升级日常游玩画面，重效果仅 fx=high。外部库调研后采用 pmndrs/postprocessing + N8AO，天空/CSM 用 three 内置。
- [x] P13.0 PostFX 迁移到 pmndrs/postprocessing（EffectPass 合并、N8AO 替 GTAO、ToneMapping AgX），画面与迁移前一致
- [x] P13.1 物理天空 Sky.js + 指数高度雾/太阳内散射 + 天空 PMREM 环境光（high）
- [x] P13.2 CSM 三级联阴影（high，含角色材质与分块材质）
- [x] P13.3 丁达尔光束 GodRaysEffect（rays 随时段）
- [x] P13.4 镜头光学：太阳鬼影/宽银幕拉丝、手持呼吸、速度 FOV + 边缘速度模糊
- [x] P13.5 程序化胶片 LUT（昼/夜两张）+ `?cine=0` 总开关 + 调试钩子
- [x] P13.V 四时段/暴雨/开车/竞技场截图对比 + 性能 + low/off 回归 + 看板/README/记忆

## Phase 14 — 街景细节（计划 ~/.claude/plans/immutable-squishing-bee.md）
> 起因：对照 mrdoob「Slop New York」（three.js 官方转发），差距不在后期而在表面内容：程序化外墙/室内映射、檐口等几何细节件、路缘与路面/人行道着色器、像样的街道家具。保持 WebGL + pmndrs，手法移植成 GLSL。截图脚本 `__game.camAbs` 固定世界机位（c77e9f7）。
- [x] P14.1 程序化外墙：src/world/FacadeShader.ts（Standard + onBeforeCompile，全城 1 个 program 'rea-facade'）；BuildingMesh 属性 aWall(s, 立面宽, 随机, 闭合) / aBld(种子, cls, 楼高, 色调)，转角 <30° 的边并成一段立面、开间取整、墙角柱；HDB 走廊栏板带 + 视差走廊 / 店屋五脚基拱廊 + 粉彩开间 + 百叶窗 + 瓦顶 / 玻璃塔竖梃幕墙 / 普通楼带形窗；凹窗视差 + 室内盒房间 + 夜窗 HDR；风化与导数凹凸；fwidth 分轴远处淡化。颜色按建筑 id 确定（修跨版本像素对比）。fx=off 仍走 Lambert 窗格，运行时切档换材质。high programs +1。遗留：近处冷白亮窗略过曝、斜边导数凹凸轻微锯齿、Landmarks/skyline 未改
- [x] P14.3 街道表面：src/world/StreetShaders.ts（onBeforeCompile 注入沥青色差/补丁/骨料/油污、人行道 30 cm 红灰透水砖或 60 cm 混凝土板 + fwidth 砖缝、标线磨损剥落、地面草/土细节、积水三层遮罩 uStreetWet）；路缘运行时由人行道三角网边界生成（ChunkManager.buildWalkGeometry，临车道 0.15 m 立面 + 路缘顶 + 倒角高光，外缘落地），与人行道同一网格 draw 不增；fx=off 关细节（setStreetDetail）。遗留：路缘不投影、拐角条带重叠、无无障碍坡口、快速路无人行道落差
- [x] P14.2 建筑几何细节件：src/world/BuildingDetail.ts（每块 0.5 m 栅格判定墙外是车行道/人行道/楼；女儿墙压顶、店屋两级檐口 + 招牌梁线脚、临街五脚基檐篷 + 与着色器对齐的柱（空地 ≥1.6 m 才立柱并加碰撞体，否则无柱悬挑）、空调外机按着色器窗格复算、HDB 机房水箱/普通楼设备与冷却塔、楼前铺装带铺到人行道）；只在 3×3 块内，合并成 2 个全局网格，draw +≤5、三角 +200–300k、每块 5–6 ms；FacadeShader 导出 FACADE_DIMS；`?detail=0`。遗留：檐篷前沿统一奶白、无实体晾衣杆、退界 >10 m 只铺 1.5 m
- [x] P14.4 街道家具：src/world/PropShapes.ts（程序化低模 + aPbr 逐顶点金属度/粗糙度/自发光，道具 Standard 材质；弯臂路灯 LAMP_HEAD (1.75,6.12,0)、信号杆悬臂双灯头、拱顶巴士站 + 广告灯箱、MRT 亭、ERP 龙门、linkway 等）；PropType 追加 9 railing/10 bin/11 hydrant/12 bollard/13 planter，06-props streetFurniture() 新增 4347 件（道具 13810→18157，public/world/sg +87 KB），护栏/花槽多边形碰撞、其余圆形；RoadClearance.roadDir 让灯臂/悬臂/站台朝向车行道；树叶逆光透射 + 风摆。high 三角形约 +20–25%、programs +2。斑马线剥落阈值调低。遗留：道具材质只在启动时读 fx；无双臂分隔带路灯；树透光偏含蓄；dev/world.html 在 HEAD 就有 fakeCtx.camera 报错
- [ ] P14.5（可选，暂缓）反射与接触阴影
- [x] P14.V 固定机位（keongsaik/southbridge/hdb/cbd/aerial）前后对比：high/low/off 0 报错、60 fps（headless vsync），high draw 111–218、三角 1.3–2.6M（基线 0.4–1.8M）、programs 47→51；单测 18/18、geo:check 不变

## Phase I18N — 系统语言可选 中文 / English（计划 ~/.claude/plans/bright-brewing-fern.md）
> 机制：`src/i18n`，中文原文作 key，`t('罚款 {n}', { n })`；语言在 i18n 模块加载时确定（`?lang=` ← 设置 ← 浏览器语言），切换 = 存设置+存档后重载；词典 `src/i18n/en/*.ts` 按模块分文件；`npm run i18n:check` 查漏网/缺 key/占位符/冲突。
- [x] I18N.0 基建（6c5c1e1）：i18n 模块、Settings.lang、开局/建角色右上角与手机设置的语言按钮、检查脚本、node 模拟共用解析钩子 scripts/lib/ts-resolve.mjs
- [x] I18N.1–6 抽字+翻译（并行，约 1770 个 key）：1 Game/ui/index.html → en/ui · 2 systems → en/systems · 3 data 表 → en/data · 4 dates/club → en/social · 5 arena/race → en/arena · 6 casino → en/casino
- [x] I18N.V 验收：check/build 通过；i18n:check 漏网/缺 key/占位符/冲突全 0（另查只有全角标点的字面量）；econ/casino/ride sim 通过；Playwright 英文版开局、HUD、手机 13 个子页、衣柜部件名、赌场五游戏、夜店/约会、竞技场、赛车页面无残留中文，运行时缺 key 警告 0；右上角与手机设置切换语言后重载、设置记住、存档保留；中文版 HUD 与原来一致。
  约定：新界面文字一律 `t('中文')`，英文补到 `src/i18n/en/<模块>.ts`；同一中文 key 只能一个译文（21 点「和」=Push 与百家乐 Tie 用 `lang` 分支）；街景招牌中文不翻（Signage.ts i18n-ignore-file）；调试面板、Error、GLSL 不翻。
  2026-10-27 已部署 rea.alextang.dev（版本 b66f1c18），线上 ?lang=en 开局英文、右上角切换按钮在、0 报错。
  遗留：触屏英文布局（I1 已缩小按钮字号）未在真机测；`?lang=` 只在随后有设置保存时才写入本地设置；「未使用 key」里约 70 条是 HTML/部件名等动态 key，属正常。

## Phase AIR — 机场与飞机驾驶（计划 ~/.claude/plans/piped-greeting-locket.md）
> 起因：用户参考 threejsassets「Airfield — Small Airport Kit」（只用免费模型），要求加机场和开飞机。已定：城市南边海上虚构填海岛「滨海南机场」，经堤道接 Marina Coastal Drive 南端断头点；自由飞行与起降 + 四身份飞行工作 + 商店买飞机；不做驾照课。
> 约定：飞机不进 `game.vehicles`；`Player.mount`（Mount 接口）+ `piloting`/`onFoot`，驾驶时 `worldX/Z/Y` 取飞机；边界体 `StaticBody.tag='bound'`（城市墙、堤道护栏、岛边缘）飞机碰撞跳过；插件钩子 keyF/driveCamera/controlMode/audioMount/hint。
- [x] AIR.0 基础层：src/world/Airfield.ts（布局常量、patchAirfieldGraph 堤道 2 条单行边 + 陆侧路、4 个 airport POI、常驻碰撞体 'airfield'、AirfieldSurface 地表分类、空域）；SgWorld 南墙开口、海面 8 km、update 带高度（>60 m 区块半径 3）；ChunkManager.update(radius)；PoiType 'airport'；Plugin 新钩子与 Game 调用点；Player.mount；Save.saveSpot；叫车「日常」加机场；en/aviation.ts。验收：叫 Grab 到机场 6.3 km 落在航站楼门口；从城市步行穿过墙口沿堤道上岛；交通车开上堤道与岛；单测 18/18、ride-sim 25398 通过、i18n 0 缺。
- [ ] AIR.1 资源打包（待用户下载免费 GLB 到 data/assets-eval/threejsassets/airfield/）
- [ ] AIR.2 机场场景网格 + 跑道着色器 + 小地图叠加
- [~] AIR.3 飞行物理 ArcadeFlight.ts + flight.test.ts
- [ ] AIR.4 驾驶接入（Aircraft、aviation 插件、HeightField、Camera.updateAir、触屏、音频）
- [ ] AIR.5a 经济数据 / AIR.5b 飞行工作
- [ ] AIR.6 收尾 / AIR.V 终验

## 后续
- [x] 外部道具模型（计划 ~/.claude/plans/ethereal-imagining-glade.md）：行道树默认换 threejsassets shade-tree（`?props=proc` 改回程序化）；待定是否推广到巴士站/长椅/垃圾桶
- [x] P12 射击 / 赛车 10 级难度阶梯（计划 ~/.claude/plans/soft-scribbling-garden.md）：src/data/tiers.ts；竞技场 botParams(t) 锚点插值 + dmgMul/utility，天梯按 ELO 定中心级别；赛车 RACE_TIERS（水平加成 + 橡皮筋参数）；各自 tier/tierMax 进存档，在最高级别获胜解锁下一级；奖金/XP ×TIER_REWARD；成就 race_legend/arena_legend
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
- 2026-10-21 Phase 10 完成：P10.0 50a38e7、A df9f34c、B b179b25、E 19ac036、D ee4792e、C 60d192f、V（活动内提示转发、酒驾执法+路检警车+转向/步行摇摆、小地图赛道线、Game.showPanel、Vehicle.damageMul、Input.mousePressed/takeWheel 与竞技场滚轮换枪/仅 C 蹲、工资按心情实际入账、赌桌提示挪到状态行、econ-sim 心情+娱乐模型）。验收：四身份流程各 17/17（主控复跑 gold 4 次 1 次 21 点点击时序失败）、酒驾 sg/grid 6/6、回归 grid/box/fx off/low 6/6、各插件脚本通过，夜景无回退。econ-sim：首个产业 0–7.1 分、中期目标 50.7–76.3 分。
  遗留：bot 自然下包与"表白→恋人"测试偶发失败（AI 随机/负载时序）；活动顶部提示条可能压住牌面；路检警车与赛车巡逻车是空车可被开走；白领中期目标 76.3 分逼近 78 上限；步行醉酒摇摆未测轨迹。
- 2026-10-21 试玩反馈：执法太严、找不到娱乐场馆。新增默认执法档 `casual`（Law.ts LAW_TUNING.lenient：不罚交通违规/碰撞/抢车/毁车/对空开枪/酒驾，不刷酒驾路检，街头赛不上星；撞人、枪击行人、攻击警察、开枪打车照旧），`?law=relaxed|real` 切回，lawStrictness 不再从 localStorage 读。场馆导航：Game.venueNav/navTo/venueSections，手机赛车/竞技/赌场/联系人页加场馆卡；小地图远处场馆钉边缘；手动导航优先于工作/任务目标。
- 2026-10-21 P11（计划 ~/.claude/plans/proud-sparking-abelson.md）试玩反馈：建筑与地铁出口挡路、想要叫车直达。P11.A：03 丢弃 covered/level<0/parking_aisle/drive-through 的 service 路并剔除穿楼 service 边（节点/边 3410/5738→2871/4609，主干道长度不变）；04 跳过屋顶/悬空/天桥/indoor/地下 108 栋，压车行道的剔除 8、裁剪 236（建筑 3704→3589）；06 地铁出口推出路缘 19 个（最远 11 m）；PropMeshes 地铁出口与天桥楼梯运行时净空兜底，RoadClearance PAD 3。`npm run geo:check`：压路建筑 111→0、压路出口 17→0、穿楼非 service 边 6→0。P11.B：Ride.ts（Taxi 打表 / Grab 加价报价、canRide）、Game.rideTo 黑屏直达（state 'ride'）、手机「出行」与场馆卡 Taxi/Grab 按钮、rideTaken 统计与成就「不想开车」；`npm run ride:sim` 25398 项通过；实测叫 Grab 到金沙扣费/跳时/落门口/可进赌场。
  遗留：15 条 service 边仍部分穿楼（≤60%）；悬空楼直接不渲染（未做按 min_height 悬空拉伸）；金沙门口有灯杆挡镜头。
- 2026-10-22 Phase 13 日常画面电影化完成（仅 fx=high）：P13.0 2aa7738（PostFX 迁 pmndrs/postprocessing + N8AO，同页像素差 ≤2.3%）、P13.1/2 0e1569b（Atmosphere.ts：Sky.js 混色表、指数高度雾 + 太阳内散射、天空 PMREM、CSM 3 级 350 m 全局片段按片元选级）、P13.3–6（Cine.ts：GodRays 半分辨率、太阳鬼影/拉丝、程序化 day/night LUT `npm run lut:build`、手持晃动、速度 FOV 62→70°、边缘速度模糊、`?cine=0`）。验收：high/cine=0/low/off/grid/box 0 报错 60 fps；日落朝阳 cine 开销约 +1.8 ms、夜晚 +0.3 ms（headless DPR1）。
  约定：城市场景只能有 CSM 的 3 盏投影方向光（Atmosphere.ts 顶部注释）；夜晚 this.sun 换成月光方向，靠 grade.rays=0 关光束。遗留：早晨太阳常被雾化远楼挡住光束偏弱；屏幕空间光束无遮挡时只是一团光晕；远级阴影 4 帧刷新远处车影轻微卡顿；白天天空环境光略偏冷；每次加载楼体颜色随机导致跨版本像素对比不可靠；N8AO 后性能需在空闲真机 DPR2 复测。
- 2026-10-23 上线准备（计划 ~/.claude/plans/ticklish-hatching-nygaard.md）：部署改为 Cloudflare Workers 静态资源（`wrangler.jsonc`、`public/_headers`、`npm run deploy:cf`，自定义域 rea.alextang.dev），已部署上线（版本 b69135f5，245 个文件；线上加载 0 报错、118 fps，缓存头生效）；alextang.dev 加项目页 `site/content/projects/rea-city.md`（order 2、首页精选第 2 位，封面 `public/projects/rea-city.webp`）。账号与云存档设计及费用对比见 `docs/ACCOUNTS.md`（同一 Worker + D1，开放注册时开 Workers Paid $5/月）。待办：网站仓库提交并 push。
- 2026-10-23 Phase 14 街景细节完成（对照 mrdoob Slop New York）：P14.1 1d822a5 外墙着色器、P14.3 17eab96 街道表面、P14.4 7cc15c2 街道家具、P14.2 建筑几何细节件；截图脚本用 `__game.camAbs` 世界坐标机位（c77e9f7）。遗留：道具材质运行时切档不换、树透光含蓄、近处冷白亮窗略过曝、Landmarks/skyline 仍旧材质、P14.5 反射暂缓。
- 2026-10-23 触屏手机可玩（计划 ~/.claude/plans/serialized-wiggling-dragon.md）：此前无任何触屏输入，进城后无法移动/转视角/开手机。新增 `src/ui/TouchControls.ts`（浮动摇杆、右半屏拖视角、动作键复用键码经 `Input.setVirtual` 注入，非游玩状态隐藏并松开全部虚拟键）；`Input.moveAxis/stickX/stickY/addLook/lookActive/touch`；Player 摇杆按 8 方向量化锁定朝向；Hud 触屏说明与提示文案按钮名替换；手机抽屉加 × 关闭；建角色/开局遮罩矮屏布局（横屏手机“下一步”此前被裁掉）；`body` 改 `touch-action: manipulation`（none 会禁止抽屉滚动）。验收（Playwright 移动端模拟 844×390 / 390×844）：开局→建角色→进城、步行 3.6 m/s、推满奔跑 7.3 m/s、拖 150 px 转 0.53 rad、上车驾驶 14 m/s、手机开关，0 报错；桌面无触屏层。遗留：竞技场 FPS 无触屏操作；未上真机测（iOS 不支持全屏 API，需添加到主屏幕）。
- 2026-10-25 取消赌场入场税：Casino.ts 删除 levyDay/levyPaid/paidToday/payLevy 与门口「入场」按钮，五个游戏和换筹码直接可点；data/casino.ts 删 ENTRY_LEVY；econ-sim 赌场每晚花费只计期望输额；旧存档多余字段忽略。debug().enter() 保留并直接返回 true。
