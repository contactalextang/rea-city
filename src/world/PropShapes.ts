import * as THREE from 'three'
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js'
import { LOOK } from '../core/LookUniforms'

/**
 * P14.4 街道家具的程序化低模（参考 Slop New York 的 street-details：每类一个 InstancedMesh，形体靠几何细节而不是贴图）。
 * 约定：
 * - 本地坐标原点在地面，yaw=0 时 +z 为"沿路方向"，+x 为"朝车行道一侧"（PropMeshes 按 RoadClearance 把 +x 转向路面）。
 * - 每个零件写顶点属性 color（线性色）+ aPbr（x 金属度、y 粗糙度、z 夜间自发光权重、w 是否接受实例漆色），合并成非索引几何；
 *   全部道具池共用一个材质（makePropMaterial：Standard + onBeforeCompile 读 aPbr），所以细节再多也不加 program / draw call。
 * - 自发光乘共享 LOOK.uSignGlow（DayNight 的灯光开启度，白天 0）：LED 灯头、广告灯箱、MRT 标志、行人灯在夜里亮。
 * - 信号灯灯头单独一个池（SignalHead 材质）：aLens = 0 红 / 1 黄 / 2 绿 / −1 灯箱外壳；每实例颜色（Signals.applyToMesh 写）
 *   决定哪一盏亮，其余两盏显示熄灭的暗色镜片。
 */

/** tint：该零件接受实例着色（垃圾桶 / 消防栓的漆色，见 TINT_SRGB） */
export interface Pbr { metal?: number; rough?: number; glow?: number; tint?: boolean }

const tmpC = new THREE.Color()
const Y_UP = new THREE.Vector3(0, 1, 0)

/**
 * 实例漆色调色板（sRGB）：0 绿 / 1 灰（垃圾桶）、2 红 / 3 黄（消防栓）。
 * 不用 instanceColor（会让道具与它们的阴影深度材质各多一个 program 变体）：色号编码在实例 y 缩放里
 * （sy = 1 + 0.01 × 色号，肉眼不可见），着色器按 length(instanceMatrix[1]) 解码，只对 aPbr.w = 1 的零件生效。
 */
export const TINT_SRGB = [0x3f7d4a, 0x7d838b, 0xc8261e, 0xe2b21c]
/** 色号 → 实例 y 缩放 */
export const tintScale = (k: number) => 1 + 0.01 * k

/** 给零件写顶点色 + aPbr（hex 为 sRGB，转线性；aPbr = 金属度, 粗糙度, 自发光, 可着色） */
export function part(g: THREE.BufferGeometry, hex: number, o: Pbr = {}): THREE.BufferGeometry {
  if (g.index) { const ng = g.toNonIndexed(); g.dispose(); g = ng }
  tmpC.setHex(hex)
  const n = g.attributes.position.count
  const col = new Float32Array(n * 3), pbr = new Float32Array(n * 4)
  const m = o.metal ?? 0, r = o.rough ?? 0.8, e = o.glow ?? 0, t = o.tint ? 1 : 0
  for (let k = 0; k < n; k++) {
    col[k * 3] = tmpC.r; col[k * 3 + 1] = tmpC.g; col[k * 3 + 2] = tmpC.b
    pbr[k * 4] = m; pbr[k * 4 + 1] = r; pbr[k * 4 + 2] = e; pbr[k * 4 + 3] = t
  }
  g.setAttribute('color', new THREE.BufferAttribute(col, 3))
  g.setAttribute('aPbr', new THREE.BufferAttribute(pbr, 4))
  g.deleteAttribute('uv')
  return g
}

export const box = (w: number, h: number, d: number, x: number, y: number, z: number, hex: number, o?: Pbr) =>
  part(new THREE.BoxGeometry(w, h, d).translate(x, y, z), hex, o)
export const cyl = (rt: number, rb: number, h: number, x: number, y: number, z: number, hex: number, o?: Pbr, seg = 8, open = false) =>
  part(new THREE.CylinderGeometry(rt, rb, h, seg, 1, open).translate(x, y, z), hex, o)
/** 两点间的圆管（开口，接头处由相邻管覆盖） */
export function tube(a: THREE.Vector3, b: THREE.Vector3, r: number, hex: number, o?: Pbr, seg = 6, ra = r): THREE.BufferGeometry {
  const d = b.clone().sub(a)
  const g = new THREE.CylinderGeometry(r, ra, d.length(), seg, 1, true)
  g.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(Y_UP, d.normalize()))
  g.translate((a.x + b.x) / 2, (a.y + b.y) / 2, (a.z + b.z) / 2)
  return part(g, hex, o)
}

export function merge(parts: THREE.BufferGeometry[]): THREE.BufferGeometry {
  const g = mergeGeometries(parts.map((p) => (p.index ? p.toNonIndexed() : p)), false)!
  for (const p of parts) p.dispose()
  g.computeBoundingSphere()
  return g
}

// ---------------------------------------------------------------------------
// 颜色（sRGB）与材质参数
// ---------------------------------------------------------------------------
const GALV = 0x8d9399        // 镀锌钢（灯杆 / 护柱）
const BLACK = 0x15171a
const WHITE = 0xe8ecf0
const CONCRETE = 0x9a9ea5
const GLASS = 0x7f97a8
const STEEL: Pbr = { metal: 0.85, rough: 0.38 }
const PAINT: Pbr = { metal: 0.25, rough: 0.55 }
const ROUGH: Pbr = { metal: 0, rough: 0.92 }
const GLOSS: Pbr = { metal: 0.1, rough: 0.12 }

/** 灯头相对灯柱实例原点的偏移（LED 灯面中心：DayNight 光晕 / 地面光池 / NightLights 点光都以它为准） */
export const LAMP_HEAD = new THREE.Vector3(1.75, 6.12, 0)
/** 信号灯：杆上灯头（相对杆原点，沿"面向来车"方向再外移 HEAD_OUT）与悬臂末端灯头的位置 */
export const SIGNAL = { poleHeadY: 3.05, headOut: 0.2, armHeadX: 3.6, armHeadY: 5.35 }

/** 路灯：混凝土基座 + 锥形镀锌杆 + 弯臂（四段折线近似圆弧）+ 扁平 LED 灯头（下表面夜间发光） */
function lamp(): THREE.BufferGeometry {
  // 三角预算：一城几千盏、还要进 CSM 阴影 pass，控制在 ~70 三角（杆 / 臂都是开口低段数管）
  const parts = [
    cyl(0.17, 0.22, 0.55, 0, 0.275, 0, CONCRETE, ROUGH, 6, true),
    cyl(0.075, 0.13, 5.45, 0, 0.55 + 2.725, 0, GALV, STEEL, 6, true),
  ]
  // 弯臂：杆顶起两段折线近似圆弧（上扬后转平），再一段水平伸到灯头
  const pts = [new THREE.Vector3(0, 5.9, 0), new THREE.Vector3(0.12, 6.12, 0), new THREE.Vector3(0.45, 6.24, 0), new THREE.Vector3(1.3, 6.26, 0)]
  for (let k = 0; k + 1 < pts.length; k++) parts.push(tube(pts[k], pts[k + 1], 0.055, GALV, STEEL, 5))
  // 灯头：扁平铸铝壳 + 下沿 LED 面（朝下的一块面片，夜间发光）
  const led = new THREE.PlaneGeometry(0.7, 0.28).rotateX(Math.PI / 2).translate(1.75, 6.14, 0)
  parts.push(
    box(0.9, 0.11, 0.36, 1.72, 6.2, 0, 0x6d737a, { metal: 0.6, rough: 0.45 }),
    part(led, 0xfff1d6, { metal: 0, rough: 0.3, glow: 3.2 }),
  )
  return merge(parts)
}

/** 信号灯杆：镀锌杆 + 朝路面的悬臂（+x）+ 行人灯箱（朝路面，夜间红人形发光）+ 按钮盒 */
function signalPole(): THREE.BufferGeometry {
  const H = 5.6
  // 行人灯面板：朝路面（+x）的两块面片（上红人形夜间发光、下绿人形熄灭）
  const face = (y: number, hex: number, glow: number) => part(new THREE.PlaneGeometry(0.2, 0.22).rotateY(Math.PI / 2).translate(0.33, y, 0), hex, { metal: 0, rough: 0.4, glow })
  const parts = [
    cyl(0.07, 0.09, H, 0, H / 2, 0, GALV, STEEL, 6, true),
    // 悬臂（略向上斜）+ 斜拉杆
    tube(new THREE.Vector3(0, 5.2, 0), new THREE.Vector3(SIGNAL.armHeadX + 0.3, 5.75, 0), 0.06, GALV, STEEL, 5, 0.045),
    tube(new THREE.Vector3(0, 4.6, 0), new THREE.Vector3(1.4, 5.38, 0), 0.03, GALV, STEEL, 4),
    // 行人灯：黑壳 + 遮光檐 + 红/绿人形面板
    box(0.25, 0.62, 0.3, 0.2, 2.55, 0, BLACK, PAINT),
    face(2.7, 0xff3b30, 2.2), face(2.42, 0x1d3b26, 0),
    box(0.12, 0.03, 0.3, 0.38, 2.83, 0, BLACK, PAINT),
    // 过街按钮盒（黄）
    box(0.12, 0.2, 0.1, 0.1, 1.15, 0, 0xe8c21a, PAINT),
  ]
  return merge(parts)
}

/** 信号灯头：黑色灯箱 + 背板 + 三盏镜片（红上绿下）+ 遮光檐；朝 +z（来车方向） */
export function signalHead(): THREE.BufferGeometry {
  // 每个信号杆两盏（杆上 + 悬臂），控制在 ~60 三角：背板用一块面片，遮光檐是半截开口方管（3 面）
  const parts: THREE.BufferGeometry[] = [
    new THREE.BoxGeometry(0.34, 1.0, 0.24),
    new THREE.PlaneGeometry(0.56, 1.2).rotateY(Math.PI).translate(0, 0, -0.121),
  ]
  const lens: number[] = [-1, -1]
  for (let k = 0; k < 3; k++) {
    const y = 0.31 - k * 0.31
    parts.push(new THREE.CircleGeometry(0.11, 8).translate(0, y, 0.122))
    lens.push(k)
    // 遮光檐：上 + 两侧三块面片（双面看不到背面，朝外即可）
    parts.push(new THREE.PlaneGeometry(0.26, 0.18).rotateX(-Math.PI / 2).translate(0, y + 0.13, 0.21))
    lens.push(-1)
    for (const s of [-1, 1]) { parts.push(new THREE.PlaneGeometry(0.16, 0.14).rotateY(s * Math.PI / 2).translate(s * 0.13, y + 0.06, 0.21)); lens.push(-1) }
  }
  const flat = parts.map((p) => { const g = p.index ? p.toNonIndexed() : p; g.deleteAttribute('uv'); return g })
  flat.forEach((g, i) => {
    const n = g.attributes.position.count
    g.setAttribute('aLens', new THREE.BufferAttribute(new Float32Array(n).fill(lens[i]), 1))
  })
  const g = mergeGeometries(flat, false)!
  for (const p of flat) p.dispose()
  g.computeBoundingSphere()
  return g
}

/**
 * 巴士候车亭（新加坡式）：后排立柱 + 微拱顶棚（5 片折板）+ 后侧玻璃挡板 + 一端广告灯箱（夜间发光）+ 不锈钢长椅 + 路缘侧站牌柱。
 * 开口朝 +x（路面）。顶棚顶 ≤ 2.65 m：Signage 的站名牌立在顶棚中线 y ≈ 2.66 起。
 */
function busstop(): THREE.BufferGeometry {
  const L = 5.6
  const parts: THREE.BufferGeometry[] = []
  // 微拱顶棚：x ∈ [−1.15, 1.25]，中间高
  const xs = [-1.15, -0.65, -0.15, 0.35, 0.85, 1.25]
  const yOf = (x: number) => 2.62 - 0.12 * ((x - 0.05) / 1.2) ** 2
  for (let k = 0; k + 1 < xs.length; k++) {
    const x0 = xs[k], x1 = xs[k + 1], y0 = yOf(x0), y1 = yOf(x1)
    const w = Math.hypot(x1 - x0, y1 - y0)
    const g = new THREE.BoxGeometry(w, 0.05, L).rotateZ(Math.atan2(y1 - y0, x1 - x0)).translate((x0 + x1) / 2, (y0 + y1) / 2, 0)
    parts.push(part(g, 0xd9dde2, { metal: 0.5, rough: 0.35 }))
  }
  parts.push(
    box(0.08, 0.16, L, 1.25, yOf(1.25) - 0.07, 0, 0x2e6fb5, PAINT),                // 前沿蓝色檐口
    box(0.1, 0.14, L, -1.12, yOf(-1.12) - 0.06, 0, 0x8d9399, STEEL),              // 后梁
  )
  // 后排立柱 + 斜撑（悬挑）
  for (const z of [-2.3, 0, 2.3]) {
    parts.push(cyl(0.06, 0.06, 2.5, -1.0, 1.25, z, 0x9aa1a8, STEEL, 8, true))
    parts.push(tube(new THREE.Vector3(-1.0, 2.0, z), new THREE.Vector3(0.2, 2.55, z), 0.035, 0x9aa1a8, STEEL, 5))
  }
  // 后侧玻璃挡板（两段）+ 金属框
  parts.push(
    box(0.03, 1.7, 3.0, -1.05, 1.25, -1.0, GLASS, GLOSS),
    box(0.06, 0.06, 3.1, -1.05, 2.12, -1.0, 0x9aa1a8, STEEL),
    box(0.06, 0.06, 3.1, -1.05, 0.38, -1.0, 0x9aa1a8, STEEL),
  )
  // 广告灯箱（一端，双面发光）
  parts.push(
    box(0.32, 2.0, 1.3, -1.0, 1.15, 1.65, 0x3a3f46, PAINT),
    box(0.34, 1.6, 1.1, -1.0, 1.2, 1.65, 0xf2efe6, { metal: 0, rough: 0.3, glow: 1.6 }),
  )
  // 长椅：不锈钢座面 + 靠背 + 三条腿
  parts.push(
    box(0.42, 0.05, 2.6, -0.68, 0.46, -1.0, 0xb9c0c7, STEEL),
    box(0.04, 0.35, 2.6, -0.9, 0.7, -1.0, 0xb9c0c7, STEEL),
  )
  for (const z of [-2.2, -1.0, 0.2]) parts.push(box(0.36, 0.44, 0.05, -0.7, 0.22, z, 0x5c6168, PAINT))
  // 站牌柱（路缘侧、顶棚前端外）：杆 + 白色站牌 + 蓝顶
  parts.push(
    cyl(0.045, 0.05, 2.9, 1.0, 1.45, -3.3, GALV, STEEL, 6, true),
    box(0.06, 0.8, 0.5, 1.0, 2.35, -3.3, WHITE, { metal: 0, rough: 0.5, glow: 0.3 }),
    box(0.07, 0.18, 0.52, 1.0, 2.85, -3.3, 0x2e6fb5, PAINT),
  )
  return merge(parts)
}

/** 的士站牌：杆 + 黄色牌（双面黑框）+ 顶帽 */
function taxistand(): THREE.BufferGeometry {
  return merge([
    cyl(0.04, 0.05, 2.6, 0, 1.3, 0, GALV, STEEL, 6, true),
    box(0.62, 0.46, 0.05, 0, 2.25, 0, BLACK, PAINT),
    box(0.56, 0.4, 0.07, 0, 2.25, 0, 0xf2c516, { metal: 0, rough: 0.5, glow: 0.5 }),
    box(0.1, 0.04, 0.1, 0, 2.61, 0, GALV, STEEL),
  ])
}

/** ERP 龙门架横梁（单位长度沿 z，实例按 len 缩放 z）：上下弦杆 + 白色面板 + 蓝色 ERP 显示带 + 底部探测器条 */
function gantryBeam(): THREE.BufferGeometry {
  return merge([
    box(0.12, 0.12, 1, 0.25, 5.95, 0, GALV, STEEL), box(0.12, 0.12, 1, -0.25, 5.95, 0, GALV, STEEL),
    box(0.12, 0.12, 1, 0.25, 5.25, 0, GALV, STEEL), box(0.12, 0.12, 1, -0.25, 5.25, 0, GALV, STEEL),
    box(0.04, 0.62, 1, 0.31, 5.6, 0, WHITE, PAINT), box(0.04, 0.62, 1, -0.31, 5.6, 0, WHITE, PAINT),
    box(0.06, 0.2, 1, 0.34, 5.36, 0, 0x2b6cb0, { metal: 0.1, rough: 0.4, glow: 0.8 }),
    box(0.06, 0.2, 1, -0.34, 5.36, 0, 0x2b6cb0, { metal: 0.1, rough: 0.4, glow: 0.8 }),
    box(0.3, 0.08, 1, 0, 5.1, 0, 0x3a3f46, PAINT),
  ])
}

/**
 * 地铁出口：浅台基 + 四角柱 + 两侧玻璃墙 + 后墙 + 下沉楼梯口（暗色）+ 挑出的金属顶棚 + 两端檐板（Signage 站名牌贴在 z = ±1.63、y ≈ 3.55）
 * + 前角红白 MRT 标志柱（夜间发光）。足迹仍是 3 × 3 m（与碰撞体 / 净空兜底一致）。
 */
function mrtexit(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [
    box(3.1, 0.15, 3.1, 0, 0.075, 0, 0xb4b0a6, ROUGH),
    box(1.8, 0.02, 2.4, 0, 0.16, 0.2, 0x26282c, ROUGH),                  // 楼梯口
  ]
  // 下沉楼梯的几级台阶（暗处可见）
  for (let k = 0; k < 4; k++) parts.push(box(1.7, 0.03, 0.12, 0, 0.17, 1.2 - k * 0.45, 0x5a5d62, ROUGH))
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) parts.push(box(0.14, 3.0, 0.14, sx * 1.42, 1.65, sz * 1.42, 0x7c838b, STEEL))
  for (const sx of [-1, 1]) {
    parts.push(box(0.04, 2.3, 2.7, sx * 1.42, 1.35, 0, GLASS, GLOSS))
    parts.push(box(0.08, 0.1, 2.84, sx * 1.42, 2.55, 0, 0x7c838b, STEEL))
    parts.push(box(0.2, 0.9, 2.6, sx * 1.1, 0.6, 0.1, 0x9aa1a8, STEEL))    // 扶梯侧板
  }
  parts.push(
    box(2.84, 2.6, 0.06, 0, 1.45, -1.42, 0x9aa0a6, PAINT),                 // 后墙
    box(3.7, 0.18, 3.7, 0, 3.12, 0, 0x6a7078, { metal: 0.55, rough: 0.4 }),  // 顶棚
    box(3.5, 0.06, 3.5, 0, 3.0, 0, 0xd8dce0, PAINT),                       // 顶棚底面（浅色吊顶）
  )
  for (const s of [-1, 1]) parts.push(box(3.0, 0.75, 0.08, 0, 3.55, s * 1.56, 0x30353c, PAINT))
  // 标志柱：白柱 + 顶部红底 MRT 标识（发光）
  parts.push(
    box(0.32, 2.9, 0.1, 1.3, 1.6, 1.75, WHITE, PAINT),
    box(0.36, 0.5, 0.14, 1.3, 3.3, 1.75, 0xd7262e, { metal: 0, rough: 0.4, glow: 1.4 }),
  )
  return merge(parts)
}

/** 有盖走廊顶棚（单位长度沿 z）：微拱金属顶（4 片折板）+ 两侧檐沟 + 中梁 */
function linkwayRoof(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = []
  const xs = [-1.3, -0.65, 0, 0.65, 1.3]
  const yOf = (x: number) => 2.95 - 0.16 * (x / 1.3) ** 2
  for (let k = 0; k + 1 < xs.length; k++) {
    const x0 = xs[k], x1 = xs[k + 1], y0 = yOf(x0), y1 = yOf(x1)
    const g = new THREE.BoxGeometry(Math.hypot(x1 - x0, y1 - y0), 0.04, 1).rotateZ(Math.atan2(y1 - y0, x1 - x0)).translate((x0 + x1) / 2, (y0 + y1) / 2, 0)
    parts.push(part(g, 0xb8bcc2, { metal: 0.6, rough: 0.4 }))
  }
  for (const s of [-1, 1]) parts.push(box(0.1, 0.12, 1, s * 1.3, yOf(1.3) - 0.04, 0, 0x6f757c, PAINT))
  parts.push(box(2.3, 0.1, 1, 0, 2.72, 0, 0x6f757c, PAINT))
  return merge(parts)
}

function bridgeDeck(): THREE.BufferGeometry {
  return merge([
    box(2.5, 0.4, 1, 0, 5.5, 0, CONCRETE, ROUGH),
    box(0.06, 0.06, 1, -1.21, 6.6, 0, GALV, STEEL), box(0.06, 0.06, 1, 1.21, 6.6, 0, GALV, STEEL),
    box(0.03, 0.9, 1, -1.21, 6.15, 0, 0x5c7a68, PAINT), box(0.03, 0.9, 1, 1.21, 6.15, 0, 0x5c7a68, PAINT),
    box(2.7, 0.06, 1, 0, 8.4, 0, 0xb8bcc2, { metal: 0.6, rough: 0.4 }),     // 天桥顶棚
  ])
}

/** 天桥楼梯（2.5 × 4 m 足迹）：混凝土斜段 + 顶部平台 + 扶手 */
function stair(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [box(2.5, 5.5, 1.2, 0, 2.75, -1.4, CONCRETE, ROUGH)]
  for (let k = 0; k < 10; k++) parts.push(box(2.3, 0.55 * (k + 1), 0.28, 0, 0.275 * (k + 1), 1.85 - k * 0.28, 0xa7aaae, ROUGH))
  for (const s of [-1, 1]) parts.push(tube(new THREE.Vector3(s * 1.2, 1.0, 2.0), new THREE.Vector3(s * 1.2, 6.4, -0.8), 0.03, GALV, STEEL, 5))
  return merge(parts)
}

/** 通用立柱（单位高，实例按高度缩放 y） */
function post(): THREE.BufferGeometry {
  return merge([cyl(0.12, 0.14, 1, 0, 0.5, 0, 0x7a8087, PAINT, 8, true)])
}

/** 程序化行道树（?props=proc / 外部模型加载失败时）：树干 + 两层树冠 */
function tree(): THREE.BufferGeometry {
  return merge([
    cyl(0.16, 0.25, 2.6, 0, 1.3, 0, 0x6b4a2b, ROUGH, 7, true),
    part(new THREE.IcosahedronGeometry(2.1, 1).scale(1, 0.7, 1).translate(0, 4.3, 0), 0x3f7a2e, ROUGH),
    part(new THREE.IcosahedronGeometry(1.4, 0).scale(1, 0.75, 1).translate(0.4, 5.3, -0.2), 0x4b8a34, ROUGH),
  ])
}

/** 路口行人护栏：一节 2 m（沿 z 居中），镀锌立柱 + 上下横杆 + 竖向栏杆 + 黄色顶带；实例按节平铺 */
function railing(): THREE.BufferGeometry {
  // 竖杆 / 下横杆用 4 段开口方管（8 三角），一节约 70 三角
  const sq = (h: number, r: number, x: number, y: number, z: number, hex: number, o: Pbr) =>
    part(new THREE.CylinderGeometry(r, r, h, 4, 1, true).rotateY(Math.PI / 4).translate(x, y, z), hex, o)
  const parts: THREE.BufferGeometry[] = [
    sq(1.05, 0.04, 0, 0.525, -1.0, GALV, STEEL),
    box(0.05, 0.06, 2.0, 0, 1.0, 0, 0xe2b81c, PAINT),
    part(new THREE.CylinderGeometry(0.028, 0.028, 2.0, 4, 1, true).rotateZ(Math.PI / 2).rotateY(Math.PI / 2).translate(0, 0.25, 0), GALV, STEEL),
  ]
  for (let k = 0; k < 6; k++) parts.push(sq(0.72, 0.018, 0, 0.62, -0.72 + k * 0.29, GALV, STEEL))
  return merge(parts)
}

/** 垃圾桶（新加坡立式）：桶身 + 拱顶盖 + 投口暗带 + 底座；颜色由实例着色（绿 / 灰） */
function bin(): THREE.BufferGeometry {
  const TP: Pbr = { ...PAINT, tint: true }
  return merge([
    cyl(0.25, 0.23, 0.84, 0, 0.42, 0, 0xffffff, TP, 8, true),
    cyl(0.255, 0.255, 0.1, 0, 0.88, 0, 0x1c1e22, ROUGH, 8, true),
    cyl(0.08, 0.27, 0.14, 0, 1.0, 0, 0xe8e8e8, TP, 8),
  ])
}

/** 消防栓：法兰底座 + 栓身 + 两侧出水口 + 顶盖 + 顶螺母；漆色由实例着色（红 / 黄） */
function hydrant(): THREE.BufferGeometry {
  const TP: Pbr = { ...PAINT, tint: true }
  const parts = [
    cyl(0.19, 0.22, 0.08, 0, 0.04, 0, 0xd8d8d8, TP, 8, true),
    cyl(0.14, 0.15, 0.55, 0, 0.355, 0, 0xffffff, TP, 8, true),
    cyl(0.17, 0.17, 0.06, 0, 0.62, 0, 0xd8d8d8, TP, 8, true),
    cyl(0.04, 0.16, 0.18, 0, 0.74, 0, 0xffffff, TP, 8),
  ]
  for (const s of [-1, 1]) {
    const g = new THREE.CylinderGeometry(0.06, 0.06, 0.14, 6).rotateZ(Math.PI / 2).translate(s * 0.18, 0.42, 0)
    parts.push(part(g, 0xd0d0d0, TP))
  }
  return merge(parts)
}

/** 护柱：不锈钢圆柱 + 半球顶 + 反光带（夜间微亮） */
function bollard(): THREE.BufferGeometry {
  return merge([
    cyl(0.1, 0.1, 0.82, 0, 0.41, 0, 0xb9c0c7, { metal: 0.9, rough: 0.25 }, 8, true),
    part(new THREE.SphereGeometry(0.1, 8, 2, 0, Math.PI * 2, 0, Math.PI / 2).translate(0, 0.82, 0), 0xb9c0c7, { metal: 0.9, rough: 0.25 }),
    cyl(0.102, 0.102, 0.06, 0, 0.66, 0, 0xf2f2f2, { metal: 0, rough: 0.3, glow: 0.4 }, 8, true),
  ])
}

/** 花槽：预制混凝土槽（沿 z 1.6 m）+ 土面 + 三丛灌木 */
function planter(): THREE.BufferGeometry {
  return merge([
    box(0.5, 0.5, 1.6, 0, 0.25, 0, 0xb5b1a8, ROUGH),
    box(0.42, 0.02, 1.52, 0, 0.5, 0, 0x3b2c20, ROUGH),
    part(new THREE.IcosahedronGeometry(0.3, 0).scale(1, 0.75, 1.2).translate(0, 0.68, -0.48), 0x3f7a2e, ROUGH),
    part(new THREE.IcosahedronGeometry(0.32, 0).scale(1, 0.8, 1.1).translate(0.03, 0.7, 0.02), 0x4b8a34, ROUGH),
    part(new THREE.IcosahedronGeometry(0.28, 0).scale(1, 0.7, 1.2).translate(-0.02, 0.66, 0.5), 0x3a7030, ROUGH),
  ])
}

export const SHAPES = {
  lamp, signalPole, busstop, taxistand, gantryBeam, mrtexit, linkwayRoof, bridgeDeck, stair, post, tree,
  railing, bin, hydrant, bollard, planter,
}

// ---------------------------------------------------------------------------
// 材质
// ---------------------------------------------------------------------------
/** 道具共享 uniform：uPropTime 由 PropMeshes.update 每帧推进（树的风摆） */
export const PROP_UNIFORMS = { uPropTime: { value: 0 } }

/** 自发光增益：LED / 灯箱在夜里 > 1（HDR，被泛光抓到） */
const GLOW_GAIN = 1.0

/**
 * 道具主材质：Standard（吃 scene.environment 反射与 CSM 阴影），金属度 / 粗糙度 / 夜间自发光逐顶点（aPbr）。
 * simple=true（fx=off）退回 Lambert：只保留实例漆色解码，不读金属度 / 粗糙度 / 自发光。
 */
export function makePropMaterial(simple: boolean): THREE.Material {
  const pal = TINT_SRGB.map((h) => { const c = new THREE.Color(h); return `vec3(${c.r.toFixed(4)}, ${c.g.toFixed(4)}, ${c.b.toFixed(4)})` })
  const tintVert = (sh: { vertexShader: string }) => {
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nattribute vec4 aPbr;\nvarying vec4 vPbr;\nvarying vec3 vTint;')
      .replace('#include <begin_vertex>', `#include <begin_vertex>
\tvPbr = aPbr;
\t#ifdef USE_INSTANCING
\tfloat tk = floor( ( length( instanceMatrix[ 1 ].xyz ) - 1.0 ) * 100.0 + 0.5 );
\t#else
\tfloat tk = 0.0;
\t#endif
\tvTint = tk < 0.5 ? ${pal[0]} : tk < 1.5 ? ${pal[1]} : tk < 2.5 ? ${pal[2]} : ${pal[3]};`)
  }
  const tintFrag = '#include <color_fragment>\n\tdiffuseColor.rgb *= mix( vec3( 1.0 ), vTint, vPbr.w );'
  if (simple) {
    const l = new THREE.MeshLambertMaterial({ vertexColors: true })
    l.onBeforeCompile = (sh) => {
      tintVert(sh)
      sh.fragmentShader = sh.fragmentShader
        .replace('#include <common>', '#include <common>\nvarying vec4 vPbr;\nvarying vec3 vTint;')
        .replace('#include <color_fragment>', tintFrag)
    }
    l.customProgramCacheKey = () => 'rea-props-p144-simple'
    return l
  }
  const m = new THREE.MeshStandardMaterial({ vertexColors: true, metalness: 1, roughness: 1 })
  m.onBeforeCompile = (sh) => {
    sh.uniforms.uSignGlow = LOOK.uSignGlow
    tintVert(sh)
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform float uSignGlow;\nvarying vec4 vPbr;\nvarying vec3 vTint;')
      .replace('#include <color_fragment>', tintFrag)
      .replace('#include <metalnessmap_fragment>', '#include <metalnessmap_fragment>\n\tmetalnessFactor = vPbr.x;')
      .replace('#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>\n\troughnessFactor = vPbr.y;')
      .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
\ttotalEmissiveRadiance += diffuseColor.rgb * vPbr.z * uSignGlow * ${GLOW_GAIN.toFixed(2)};`)
  }
  m.customProgramCacheKey = () => 'rea-props-p144'
  return m
}

/**
 * 行道树材质：Standard + 叶片逆光透射（Barré-Brisebois & Bouchard 快速近似，同 Slop New York 的 FoliageLightingModel：
 * 视线逆着光看时叶子透出光色；乘的是已含阴影的直射光色，所以树冠自己的阴影也会压暗透射）+ 顶点风摆（按高度平方、
 * 世界坐标相位的正弦，整棵树随阵风倾斜 + 叶子细颤）。叶片掩码按顶点色"绿多于红"判定（树干是棕色）。
 */
export function makeTreeMaterial(simple: boolean): THREE.Material {
  if (simple) return new THREE.MeshLambertMaterial({ vertexColors: true })
  const m = new THREE.MeshStandardMaterial({ vertexColors: true, metalness: 0, roughness: 0.82 })
  m.onBeforeCompile = (sh) => {
    sh.uniforms.uPropTime = PROP_UNIFORMS.uPropTime
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nuniform float uPropTime;\nvarying float vLeaf;')
      .replace('#include <begin_vertex>', `#include <begin_vertex>
\tvLeaf = smoothstep(0.015, 0.07, color.g - color.r);
\t{
\t\t#ifdef USE_INSTANCING
\t\tvec3 tOrg = (modelMatrix * instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0)).xyz;
\t\t#else
\t\tvec3 tOrg = (modelMatrix * vec4(0.0, 0.0, 0.0, 1.0)).xyz;
\t\t#endif
\t\tfloat ph = fract(dot(floor(tOrg.xz), vec2(0.0713, 0.1371))) * 6.2832;
\t\tfloat gust = 0.55 + 0.45 * sin(uPropTime * 0.5 - dot(tOrg.xz, vec2(0.86, 0.51)) * 0.045);
\t\tfloat h = max(transformed.y, 0.0) / 7.0;
\t\tfloat bend = h * h;
\t\tvec2 sway = vec2(0.86, 0.51) * (sin(uPropTime * 0.85 + ph) * 0.45 + 0.55) * 0.16 + vec2(-0.51, 0.86) * sin(uPropTime * 0.67 + ph * 1.7) * 0.05;
\t\ttransformed.xz += sway * gust * bend;
\t\ttransformed += normal * sin(uPropTime * 7.0 + dot(position, vec3(3.1, 2.3, 1.7)) + ph) * 0.025 * vLeaf * bend * gust;
\t}`)
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying float vLeaf;')
      .replace('#include <lights_physical_pars_fragment>', `#include <lights_physical_pars_fragment>
void RE_Direct_Foliage( const in IncidentLight directLight, const in vec3 geometryPosition, const in vec3 geometryNormal, const in vec3 geometryViewDir, const in vec3 geometryClearcoatNormal, const in PhysicalMaterial material, inout ReflectedLight reflectedLight ) {
\tvec3 scatter = normalize( directLight.direction + geometryNormal * 0.3 );
\tfloat through = pow( clamp( dot( geometryViewDir, -scatter ), 0.0, 1.0 ), 3.0 );
\treflectedLight.directDiffuse += directLight.color * material.diffuseColor * ( 2.6 * through * vLeaf );
\tRE_Direct_Physical( directLight, geometryPosition, geometryNormal, geometryViewDir, geometryClearcoatNormal, material, reflectedLight );
}
#undef RE_Direct
#define RE_Direct RE_Direct_Foliage`)
  }
  m.customProgramCacheKey = () => 'rea-tree-p144'
  return m
}

/** 信号灯头材质：Basic（不受光照，夜里也清楚）；按实例颜色点亮对应镜片，另两盏显示熄灭的暗色，外壳近黑 */
export function makeSignalHeadMaterial(): THREE.Material {
  const m = new THREE.MeshBasicMaterial({ color: 0xffffff })
  m.onBeforeCompile = (sh) => {
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nattribute float aLens;\nvarying float vLens;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\n\tvLens = aLens;')
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying float vLens;')
      .replace('#include <color_fragment>', `#include <color_fragment>
\t{
\t\t#if defined( USE_COLOR )
\t\tvec3 ic = vColor.rgb;
\t\t#else
\t\tvec3 ic = vec3(1.0, 0.0, 0.0);
\t\t#endif
\t\t// 实例色 → 亮哪盏：绿（g > r）/ 黄（g 明显 > 0）/ 红
\t\tfloat lit = ic.g > ic.r ? 2.0 : ( ic.g > 0.08 ? 1.0 : 0.0 );
\t\tif ( vLens < -0.5 ) diffuseColor.rgb = vec3( 0.018, 0.02, 0.022 );
\t\telse {
\t\t\tvec3 off = vLens < 0.5 ? vec3( 0.09, 0.012, 0.01 ) : vLens < 1.5 ? vec3( 0.09, 0.05, 0.0 ) : vec3( 0.0, 0.07, 0.03 );
\t\t\tdiffuseColor.rgb = abs( vLens - lit ) < 0.5 ? ic * 2.2 : off;
\t\t}
\t}`)
  }
  m.customProgramCacheKey = () => 'rea-signalhead-p144'
  return m
}
