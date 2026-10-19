# scripts/char — 角色资产打包

`npm run char:build`（= `node scripts/char/build.ts`）把 `data/assets-eval/` 里 Quaternius Ultimate Modular Men（7 套）/ Women（4 套）的独立 glTF 打成：

- `public/assets/characters/characters.glb`：一套 62 关节骨骼 + 46 个部件 mesh + 24 段动画，KHR_mesh_quantization（位置 14 bit / 法线 8 / 权重 8），无 draco / meshopt，三.js GLTFLoader 原生可读。
- `public/assets/characters/catalog.json`：部件目录（slot / 性别 / 套装 / 材质语义 / 默认色）、动画别名、预设。
- `public/assets/characters/LICENSE-quaternius.txt`：两个包的 License.txt 原文（CC0 1.0）。

规则表（材质语义、中文名、动画别名、预设）在 `catalog-rules.ts`，逻辑在 `build.ts`。`data/assets-eval/` 视为不可信下载目录，脚本只按路径读 glTF 与 License。

## 结构约定

- 节点名 `part:<slot>:<id>`，`id = <m|f>_<套装小写>_<slot>`（如 `m_casual2_body`、`f_formal_legs`；女包 `Formad_Head` 拼写错误已修正为 `formal`）。glTF extras 写了 `{ part, slot, gender, set }`，three.js 里在 `object.userData`。
- three.js 的 `PropertyBinding.sanitizeNodeName` 会去掉名字里的 `:` 与 `.`：节点在 three 里叫 `partbodym_casual2_body`（catalog `parts[].nodeThree`），关节 `Shoulder.L` 变成 `ShoulderL`（`skeleton.jointsThree`）；原名在 `userData.name`。多材质部件在 three 里是一个 Group 下多个 SkinnedMesh，运行时按 `userData.part` 找节点再 traverse 收集。
- 所有部件 skin 指向同一个 `CharacterSkeleton`；quantize 的修正矩阵已并入 inverseBindMatrices，且顶点属性按 SEPARATE 布局写出（INTERLEAVED 会让 three 生成 InterleavedBufferAttribute，与共享 accessor 的普通属性混用时 `mergeGeometries` 报 gpuType 不一致）。运行时：`SkeletonUtils.clone(scene)` → 摘掉部件节点 → 按预设挑部件、按材质名写顶点色 → `mergeGeometries` → `new SkinnedMesh(...).bind(skeleton)`，每角色 1 draw call。
- 材质去重只合并**同名同色**；不同名同色（如 `Eyebrows` 与女包 `Hair_Brown`）保留，所以 quantize 的内置 cleanup（会按颜色合并材质）被关掉，之后手动 dedup(ACCESSOR, SKIN)。

## 女包骨骼

关节名序与男包完全一致，但**绑定姿态不同**（IBM 最大差 1.87，Hips 高 11 cm、手臂/手指关节朝向差 60–130°）。脚本把女包顶点按 `Σ w·inv(IBM_男)·IBM_女·v` 重蒙皮到男包绑定姿态（法线用旋转部分），再绑到男骨骼，只保留男包的 24 段动画；女包自带的 24 段同名动画丢弃。截图里 `ped_office_f` 走路正常。

## 材质语义（role）判断依据

对每套的每个部件，按材质名、三角数、顶点范围推断（`scripts/char/build.ts` 之外用 gltf-transform 临时脚本看了每个 primitive 的材质 / 三角数 / bbox）：

| 部件 | 材质 | role | 依据 |
|---|---|---|---|
| 所有 | `Skin` | skin | 头 / 手臂 / 露出的腿脚 |
| 头 | `Eye`（男）、`Brown`（女，24 tris，色 #352921，位置与男 Eye 相同） | fixed | 眼睛不换色 |
| 头 | `Eyebrows`（男）、`Hair_Brown`（女，40 tris，色 #40372d，位置同眉毛） | hair | 眉毛随发色 |
| 头 | `Hair` / `Hair_Blond`（女 Casual）/ `Red`（男 Punk 莫霍克、女 Formal 长发）/ `Pink`（女 Punk）/ `DarkBrown`（女 Worker 1510 tris） | hair | 头发主体 |
| 头 | `Moustache`、男 Worker 的 `Eyebrows`（164 tris，含络腮胡）、Casual2 `Skin_Darker`（下巴 44 tris 胡茬） | hair | 胡子随发色 |
| 头 | `Earrings`、男 Punk `Red_Dark`（140 tris 剃边/发带）、女 Punk `Black`（160 tris 颈圈） | accent | 小配饰 |
| 头 | `Worker_Yellow`（男女 Worker，320 tris） | hat | 头部自带的安全帽 |
| 身 | `LightBrown`（Casual2 T 恤 / Beach 背心 / Worker 衬衫）、`Purple`（卫衣）、`Green`（探险外套）、`Suit`（西装）、男 Punk `Black`（皮夹克 474 tris）、女 `White`（Casual / Worker 上衣本体）、`LimeGreen`（Formal 连衣裙）、女 Punk `Pink` | top | 上衣主体（三角数最大的衣物材质） |
| 身 | `LightGreen`（探险内衬）、男 Suit `White`（衬衫）、`Tie`、男 Punk `White`（内 T 恤 252 tris）、`Worker_Vest` / `Worker_Yellow`（反光背心）、`Gold`（项链） | accent | 次要衣物 |
| 腿 | `LightBlue`、`Brown`、`Brown_02`、`Suit`、`Red_Dark`（泳裤）、`Orange`、`LimeGreen`（裙摆）、`Black` | bottom | 裤 / 裙主体 |
| 腿 | `Brown2`（护膝/口袋）、Beach `White`（条纹） | accent | |
| 脚 | 三角数最大的鞋材质：`Red_Dark`（Casual2 球鞋、Beach 凉鞋）、`Purple`、`Grey`、`Red`（女 Formal 高跟鞋）、`Black`（Suit / Punk / 女 Worker 整只鞋） | shoes | |
| 脚 | `White`（鞋底/鞋带）、`Black`（靴底，Adventurer / Worker 男）、女 Punk `Grey` | accent | |
| 帽 | `Hat`（程序化鸭舌帽）、`Helmet`（Worker_Head 的安全帽复制放大 1.06） | hat | |

同名材质在男女包里颜色不同的有 `Black / Brown / Gold / Red / DarkBrown`；运行时按名换色请以 `catalog.parts[].materials` 为准，不要全局按名。

## 帽子

- `part:hat:cap`：70 tris。帽身 12 边 × 3 环扁球冠（R≈0.13 m，底环 y=1.791，顶 y=1.914），帽檐扁楔形盒朝 +Z（按 `m_casual_head` 的 Eye 相对头中心的方向判定）。尺寸取自 `m_casual_head` 的 Skin + Hair 顶点范围，全部顶点 100% 绑 `Head`（关节索引 7）。
- `part:hat:helmet`：取男 Worker_Head 的 `Worker_Yellow` 图元，绕帽底中心放大 1.06 盖住其他头型的头发。

## 预设

14 个：四身份默认（`default_gang / default_gold / default_white / default_blue`）+ 行人 10 个。包里没有的东西用近似并在 `note` 里注明：没有头巾（`ped_malay_f` 用长发整体染成头巾色）、没有背包/外卖箱（`ped_rider` 只用绿卫衣 + 绿安全帽）、没有单独的衬衫部件（`default_white` 用 Punk 皮夹克 + 内衫都调白）。`default_gang` 用 `m_casual2_legs` 牛仔长裤（2026-10-20 由短裤改为长裤）。

## 验证

- `node scripts/char/build.ts` 跑通，`npm run check` 不受影响（`scripts/` 不在 tsconfig include）。
- scratchpad `char-check/index.html`：GLTFLoader 加载 glb，`default_gang`（Walk）/ `default_blue`（Idle）/ `ped_office_f`（Walk）各合成 1 个 SkinnedMesh；headless Chromium 截图 `char-build-check.png`。3 角色 + 网格辅助线 = 4 draw calls；帽子顶点到 Head 骨距离在两帧间不变（0.2989/0.2995、0.2338/0.2337）；无报错（仅 THREE.Clock 弃用警告）。

## 遗留

- 未打包：Adventurer 的 `Backpack`、Suit 的 `Pistol`（非四件套）；男包 King / Farmer / Spacesuit / Swat、女包 Adventurer / Medieval / SciFi / Soldier / Suit / Witch 未下载。
- 动画缺 Jump / Sit / Drive（包里没有），需要时从 UAL1 重定向。
- 顶点数 ~140k（模型是平面着色不共享顶点），已在 3.75 MB 内，没做 weld / simplify。
