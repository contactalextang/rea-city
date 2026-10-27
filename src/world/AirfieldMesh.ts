import * as THREE from 'three'
import type { ChunkMark } from './ChunkFormat'
import { buildWalkGeometry } from './ChunkManager'
import type { RoadMarkings } from './RoadMarkings'
import { loadAirfieldModels, type AirfieldModel } from './AirfieldModels'
import { makeRunwayMaterial, RW_KIND } from './RunwayShader'
import {
  AIR_LANE_W, APRON, CAUSEWAY_DECK, CAUSEWAY_MEDIAN, CAUSEWAY_NB, CAUSEWAY_SB, CITY_EDGE_Z, CONNECTORS, HANGAR, HANGAR_XS,
  HOLD_SHORT_Z, ISLAND, LANDSIDE_ROAD, PARKING, PARKING_ENTRY, RUNWAY, SERVICE_AREA, STANDS, TAXIWAY, TERMINAL, TERMINAL_PLAZA, TOWER,
  WINDSOCKS,
} from './Airfield'

/**
 * AIR.2 滨海南机场场景网格（只在 sg 世界且 SgWorld.airfield 为真时挂载）。全部布局取自 Airfield.ts 常量，
 * 与碰撞体 / 路网 / 地表判定严格对齐。合并成 6 个 Mesh（draw call +6，另有 solid 进 3 级 CSM 投影）：
 *  - ground   岛面草地（y −0.12，20 m 网格逐顶点色差）+ 四周护岸（压顶 +0.3、抛石斜坡落到 −3）+ 堤道两侧抛石坡 + 铺装侧边裙
 *  - pavement 跑道 / 滑行道 / 联络道 / 停机坪 / 服务区（RunwayShader，标线全在着色器里）
 *  - road     堤道桥面、岛上连接段、陆侧路、停车场（复用城市路面材质 ChunkManager.roadMat，同一 program）
 *  - walk     堤道中央分隔带、陆侧路人行道、航站楼前广场（复用 walkMat + buildWalkGeometry 生成路缘）
 *  - solid    航站楼框架、机库拱顶（门洞可见暗色内部）、塔台、护栏、灯杆、风向袋（Lambert 顶点色，投影）
 *  - glow     航站楼玻璃、塔台玻璃舱、机库内灯带、跑道边灯 / 入口灯 / 进近灯 / PAPI / 滑行道蓝灯、障碍灯、路灯灯头
 *             （Lambert 顶点色 + 8 像素调色板 emissiveMap；材质推进 scene.userData.windows，DayNight 夜间点亮）
 * 车道线 / 斑马线 / 车位线走全局 RoadMarkings（固定 key 'airfield'，不增加 draw call）。
 * 不新增任何灯光对象：夜间发光全靠自发光（HDR > 1 被泛光抓到）。
 */

type V3 = [number, number, number]
const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
const UP: V3 = [0, 1, 0]

/** 整数哈希 → [0,1)（确定性，网格每次生成一致） */
function hash2(x: number, z: number): number {
  let h = Math.imul(Math.floor(x) | 0, 374761393) ^ Math.imul(Math.floor(z) | 0, 668265263)
  h = Math.imul(h ^ (h >>> 13), 1274126177)
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296
}
/** 值噪声（双线性） */
function vnoise(x: number, z: number): number {
  const ix = Math.floor(x), iz = Math.floor(z), fx = x - ix, fz = z - iz
  const sx = fx * fx * (3 - 2 * fx), sz = fz * fz * (3 - 2 * fz)
  const a = hash2(ix, iz), b = hash2(ix + 1, iz), c = hash2(ix, iz + 1), d = hash2(ix + 1, iz + 1)
  return (a + (b - a) * sx) * (1 - sz) + (c + (d - c) * sx) * sz
}

// ---- 发光调色板（emissiveMap 16×1，sRGB）：索引 = 顶点 uv.x 的格子；dim* 给标牌字面这类大面积发光 ----
const PAL = {
  none: 0, white: 1, green: 2, red: 3, blue: 4, warm: 5, cool: 6, lamp: 7, amber: 8, dimRed: 9, dimWhite: 10, dimAmber: 11,
} as const
const PAL_N = 16
const PAL_RGB: [number, number, number][] = [
  [0, 0, 0], [255, 246, 225], [60, 255, 120], [255, 34, 24], [60, 110, 255], [104, 86, 62], [92, 108, 124], [255, 196, 120],
  [255, 150, 40], [120, 18, 12], [118, 118, 112], [130, 80, 20],
]
/** 自发光倍数：emissive 颜色 × 调色板 × DayNight 写入的 emissiveIntensity（夜间 1.5） */
const GLOW_GAIN = 3
const palU = (i: number) => (i + 0.5) / PAL_N

/** 几何收集器：position / normal / color（/ uv），按期望外法线自动定绕序 */
class Builder {
  pos: number[] = []
  nrm: number[] = []
  col: number[] = []
  uv: number[] = []
  idx: number[] = []
  constructor(private withUv = false) {}

  private vert(p: V3, n: V3, c: THREE.Color, u: number) {
    this.pos.push(p[0], p[1], p[2]); this.nrm.push(n[0], n[1], n[2]); this.col.push(c.r, c.g, c.b)
    if (this.withUv) this.uv.push(u, 0.5)
  }

  /** 四边形（a b c d 依次相邻），hint = 期望朝外方向 */
  quad(a: V3, b: V3, c: V3, d: V3, hint: V3, color: THREE.Color, u = 0) {
    let n = cross(sub(c, a), sub(d, b))
    if (dot(n, hint) < 0) { const t = b; b = d; d = t; n = [-n[0], -n[1], -n[2]] }
    const l = Math.hypot(n[0], n[1], n[2]) || 1
    n = [n[0] / l, n[1] / l, n[2] / l]
    const v = this.pos.length / 3
    this.vert(a, n, color, u); this.vert(b, n, color, u); this.vert(c, n, color, u); this.vert(d, n, color, u)
    this.idx.push(v, v + 1, v + 2, v, v + 2, v + 3)
  }

  tri(a: V3, b: V3, c: V3, hint: V3, color: THREE.Color, u = 0) {
    let n = cross(sub(b, a), sub(c, a))
    if (dot(n, hint) < 0) { const t = b; b = c; c = t; n = [-n[0], -n[1], -n[2]] }
    const l = Math.hypot(n[0], n[1], n[2]) || 1
    n = [n[0] / l, n[1] / l, n[2] / l]
    const v = this.pos.length / 3
    this.vert(a, n, color, u); this.vert(b, n, color, u); this.vert(c, n, color, u)
    this.idx.push(v, v + 1, v + 2)
  }

  /** 长方体：底面中心 (cx, y0, cz)，尺寸 sx × sy × sz，绕 Y 转 yaw（本地 +z = (sin yaw, cos yaw)）；bottom=false 省底面 */
  box(cx: number, y0: number, cz: number, sx: number, sy: number, sz: number, color: THREE.Color, yaw = 0, u = 0, bottom = false) {
    const c = Math.cos(yaw), s = Math.sin(yaw), hx = sx / 2, hz = sz / 2
    const P = (lx: number, y: number, lz: number): V3 => [cx + lx * c + lz * s, y, cz - lx * s + lz * c]
    const y1 = y0 + sy
    const ex: V3 = [c, 0, -s], ez: V3 = [s, 0, c]
    const neg = (v: V3): V3 => [-v[0], -v[1], -v[2]]
    this.quad(P(-hx, y1, -hz), P(hx, y1, -hz), P(hx, y1, hz), P(-hx, y1, hz), UP, color, u)
    if (bottom) this.quad(P(-hx, y0, -hz), P(hx, y0, -hz), P(hx, y0, hz), P(-hx, y0, hz), [0, -1, 0], color, u)
    this.quad(P(hx, y0, -hz), P(hx, y0, hz), P(hx, y1, hz), P(hx, y1, -hz), ex, color, u)
    this.quad(P(-hx, y0, -hz), P(-hx, y0, hz), P(-hx, y1, hz), P(-hx, y1, -hz), neg(ex), color, u)
    this.quad(P(-hx, y0, hz), P(hx, y0, hz), P(hx, y1, hz), P(-hx, y1, hz), ez, color, u)
    this.quad(P(-hx, y0, -hz), P(hx, y0, -hz), P(hx, y1, -hz), P(-hx, y1, -hz), neg(ez), color, u)
  }

  /** 竖直正多边形柱（n 边，半径 r），cap = 是否加顶面 */
  prism(cx: number, cz: number, r: number, n: number, y0: number, y1: number, color: THREE.Color, u = 0, cap = true, rot = Math.PI / 8) {
    const pt = (k: number, y: number): V3 => [cx + Math.cos(rot + (k / n) * Math.PI * 2) * r, y, cz + Math.sin(rot + (k / n) * Math.PI * 2) * r]
    for (let k = 0; k < n; k++) {
      const a = (rot + ((k + 0.5) / n) * Math.PI * 2)
      this.quad(pt(k, y0), pt(k + 1, y0), pt(k + 1, y1), pt(k, y1), [Math.cos(a), 0, Math.sin(a)], color, u)
      if (cap) this.tri([cx, y1, cz], pt(k, y1), pt(k + 1, y1), UP, color, u)
    }
  }

  /**
   * 追加套件模型几何：缩放 s、绕 Y 转 yaw、平移到 (x, y, z)。顶点色取模型自带；
   * _glow=1 的顶点按 pal(r,g,b) 选调色板格（夜间发光），其余指向 none（不发光）。
   */
  appendGeometry(g: THREE.BufferGeometry, x: number, y: number, z: number, yaw: number, s: number, pal: (r: number, g: number, b: number) => number) {
    const P = g.getAttribute('position'), N = g.getAttribute('normal'), C = g.getAttribute('color'), G = g.getAttribute('_glow')
    const c = Math.cos(yaw), sn = Math.sin(yaw)
    const base = this.pos.length / 3
    for (let i = 0; i < P.count; i++) {
      const lx = P.getX(i) * s, ly = P.getY(i) * s, lz = P.getZ(i) * s
      this.pos.push(x + lx * c + lz * sn, y + ly, z - lx * sn + lz * c)
      const nx = N ? N.getX(i) : 0, ny = N ? N.getY(i) : 1, nz = N ? N.getZ(i) : 0
      this.nrm.push(nx * c + nz * sn, ny, -nx * sn + nz * c)
      const r = C ? C.getX(i) : 0.7, gg = C ? C.getY(i) : 0.7, b = C ? C.getZ(i) : 0.7
      this.col.push(r, gg, b)
      if (this.withUv) this.uv.push(palU(G && G.getX(i) > 0.5 ? pal(r, gg, b) : PAL.none), 0.5)
    }
    if (g.index) { const I = g.index; for (let i = 0; i < I.count; i++) this.idx.push(base + I.getX(i)) }
    else for (let i = 0; i < P.count; i++) this.idx.push(base + i)
  }

  get triangles() { return this.idx.length / 3 }

  toGeometry(): THREE.BufferGeometry {
    const g = new THREE.BufferGeometry()
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3))
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.nrm, 3))
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.col, 3))
    if (this.withUv) g.setAttribute('uv', new THREE.Float32BufferAttribute(this.uv, 2))
    g.setIndex(this.pos.length / 3 > 65535 ? new THREE.Uint32BufferAttribute(this.idx, 1) : new THREE.Uint16BufferAttribute(this.idx, 1))
    g.computeBoundingSphere()
    return g
  }
}

/** 多个收集器拼成一个几何（索引按顶点偏移） */
function mergeBuilders(list: Builder[]): THREE.BufferGeometry {
  const out = new Builder(true)
  for (const b of list) {
    const base = out.pos.length / 3
    // 逐个 push（大数组展开会爆调用栈）
    for (const v of b.pos) out.pos.push(v)
    for (const v of b.nrm) out.nrm.push(v)
    for (const v of b.col) out.col.push(v)
    if (b.uv.length) for (const v of b.uv) out.uv.push(v)
    else for (let i = 0; i < b.pos.length / 3; i++) out.uv.push(palU(PAL.none), 0.5)
    for (const i of b.idx) out.idx.push(base + i)
  }
  return out.toGeometry()
}

/**
 * 套件模型发光顶点的调色板选择：按顶点色色相分类（红 / 琥珀 / 蓝 / 冷白 / 暖白）。
 * dim = 大面积发光（标牌字面、建筑玻璃）用暗一档的颜色，避免整块过曝。
 */
function glowPal(dim: boolean) {
  return (r: number, g: number, b: number): number => {
    if (r > g * 1.6 && r > b * 1.6) return g > b * 2 && g > r * 0.25 ? (dim ? PAL.dimAmber : PAL.amber) : (dim ? PAL.dimRed : PAL.red)
    if (b > r * 1.8) return dim ? PAL.cool : PAL.blue
    if (b > r * 1.15) return PAL.cool
    return dim ? PAL.dimWhite : PAL.lamp
  }
}

/** 近处灯具（套件 runway-edge-light / taxiway-blue-light 每个约 1.5k 三角）：只把相机 R 米内最近的 MAX 个拼进一个动态网格 */
interface FixtureItem { x: number; y: number; z: number; yaw: number; s: number; geo: THREE.BufferGeometry; pal: (r: number, g: number, b: number) => number }
class NearFixtures {
  readonly mesh: THREE.Mesh
  private items: FixtureItem[] = []
  private cx = Infinity
  private cy = Infinity
  private cz = Infinity
  private geo = new THREE.BufferGeometry()
  private capV = 0
  private capI = 0
  static readonly R = 170
  static readonly MAX = 30
  /** 最近一次重建的件数 / 三角数 */
  shown = 0
  tris = 0

  constructor(mat: THREE.Material) {
    this.mesh = new THREE.Mesh(this.geo, mat)
    this.mesh.name = 'air:fixtures'
    this.mesh.frustumCulled = false
    this.mesh.userData.castShadow = false
    this.mesh.receiveShadow = true
    // 套件模型到达前不显示（没有顶点属性）
    this.mesh.visible = false
    // 每次渲染前检查相机位置：移动超过 15 m 才重建（主相机；阴影 pass 不调用 onBeforeRender）
    this.mesh.onBeforeRender = (_r, _s, cam) => {
      const p = cam.position
      if (Math.hypot(p.x - this.cx, p.z - this.cz) < 15 && Math.abs(p.y - this.cy) < 15) return
      this.cx = p.x; this.cy = p.y; this.cz = p.z
      this.rebuild(p)
    }
  }

  setItems(items: FixtureItem[]) {
    this.items = items
    let mv = 0, mi = 0
    for (const it of items) { mv = Math.max(mv, it.geo.getAttribute('position').count); mi = Math.max(mi, it.geo.index ? it.geo.index.count : it.geo.getAttribute('position').count) }
    this.capV = mv * NearFixtures.MAX; this.capI = mi * NearFixtures.MAX
    const dyn = <T extends THREE.BufferAttribute>(a: T) => { a.setUsage(THREE.DynamicDrawUsage); return a }
    this.geo.setAttribute('position', dyn(new THREE.Float32BufferAttribute(new Float32Array(this.capV * 3), 3)))
    this.geo.setAttribute('normal', dyn(new THREE.Float32BufferAttribute(new Float32Array(this.capV * 3), 3)))
    this.geo.setAttribute('color', dyn(new THREE.Float32BufferAttribute(new Float32Array(this.capV * 3), 3)))
    this.geo.setAttribute('uv', dyn(new THREE.Float32BufferAttribute(new Float32Array(this.capV * 2), 2)))
    this.geo.setIndex(dyn(new THREE.Uint32BufferAttribute(new Uint32Array(this.capI), 1)))
    this.geo.setDrawRange(0, 0)
    this.cx = Infinity
    this.mesh.visible = items.length > 0
  }

  private rebuild(cam: THREE.Vector3) {
    const R2 = NearFixtures.R ** 2
    const near: { d: number; it: FixtureItem }[] = []
    for (const it of this.items) {
      const d = (it.x - cam.x) ** 2 + (it.y - cam.y) ** 2 + (it.z - cam.z) ** 2
      if (d < R2) near.push({ d, it })
    }
    near.sort((a, b) => a.d - b.d)
    const P = this.geo.getAttribute('position') as THREE.BufferAttribute, N = this.geo.getAttribute('normal') as THREE.BufferAttribute
    const C = this.geo.getAttribute('color') as THREE.BufferAttribute, U = this.geo.getAttribute('uv') as THREE.BufferAttribute
    const I = this.geo.index!
    const pa = P.array as Float32Array, na = N.array as Float32Array, ca = C.array as Float32Array, ua = U.array as Float32Array, ia = I.array as Uint32Array
    let v = 0, k = 0, n = 0
    for (const { it } of near) {
      if (n >= NearFixtures.MAX) break
      const g = it.geo, gp = g.getAttribute('position'), gn = g.getAttribute('normal'), gc = g.getAttribute('color'), gg = g.getAttribute('_glow')
      const cnt = gp.count
      if (v + cnt > this.capV) break
      const c = Math.cos(it.yaw), sn = Math.sin(it.yaw), s = it.s
      for (let i = 0; i < cnt; i++) {
        const lx = gp.getX(i) * s, ly = gp.getY(i) * s, lz = gp.getZ(i) * s, o = (v + i) * 3
        pa[o] = it.x + lx * c + lz * sn; pa[o + 1] = it.y + ly; pa[o + 2] = it.z - lx * sn + lz * c
        const nx = gn.getX(i), nz = gn.getZ(i)
        na[o] = nx * c + nz * sn; na[o + 1] = gn.getY(i); na[o + 2] = -nx * sn + nz * c
        const r = gc.getX(i), gr = gc.getY(i), b = gc.getZ(i)
        ca[o] = r; ca[o + 1] = gr; ca[o + 2] = b
        ua[(v + i) * 2] = palU(gg && gg.getX(i) > 0.5 ? it.pal(r, gr, b) : PAL.none); ua[(v + i) * 2 + 1] = 0.5
      }
      const gi = g.index
      if (gi) for (let i = 0; i < gi.count; i++) ia[k++] = v + gi.getX(i)
      else for (let i = 0; i < cnt; i++) ia[k++] = v + i
      v += cnt; n++
    }
    for (const a of [P, N, C]) { a.clearUpdateRanges(); a.addUpdateRange(0, v * 3); a.needsUpdate = true }
    U.clearUpdateRanges(); U.addUpdateRange(0, v * 2); U.needsUpdate = true
    I.clearUpdateRanges(); I.addUpdateRange(0, k); I.needsUpdate = true
    this.geo.setDrawRange(0, k)
    this.shown = n; this.tris = k / 3
  }

  dispose() { this.geo.dispose() }
}

const col = (hex: number) => new THREE.Color(hex)
/** 颜色乘明度扰动（k 为 0..1 随机数，幅度 amp） */
const jit = (c: THREE.Color, k: number, amp: number) => c.clone().multiplyScalar(1 + (k - 0.5) * 2 * amp)

/** 折线（x,z 交替）在 z 处的 x（线性插值，超出两端取端点） */
function xAtZ(poly: number[], z: number): number {
  if (z <= poly[1]) return poly[0]
  for (let i = 0; i + 3 < poly.length; i += 2) {
    const z0 = poly[i + 1], z1 = poly[i + 3]
    if (z >= z0 && z <= z1) return poly[i] + (poly[i + 2] - poly[i]) * ((z - z0) / ((z1 - z0) || 1))
  }
  return poly[poly.length - 2]
}

/** 沿折线按弧长取样：返回点、单位方向；off = 右法线方向偏移（与 RoadGraph.sample 一致：(−dz, dx)·off） */
function polyLength(poly: number[]) {
  let L = 0
  for (let i = 0; i + 3 < poly.length; i += 2) L += Math.hypot(poly[i + 2] - poly[i], poly[i + 3] - poly[i + 1])
  return L
}
function samplePoly(poly: number[], s: number, off: number) {
  let acc = 0
  for (let i = 0; i + 3 < poly.length; i += 2) {
    const ax = poly[i], az = poly[i + 1], bx = poly[i + 2], bz = poly[i + 3]
    const L = Math.hypot(bx - ax, bz - az)
    if (s <= acc + L || i + 4 >= poly.length - 1) {
      const t = L > 1e-6 ? Math.min(1, Math.max(0, (s - acc) / L)) : 0
      const dx = (bx - ax) / (L || 1), dz = (bz - az) / (L || 1)
      return { x: ax + (bx - ax) * t - dz * off, z: az + (bz - az) * t + dx * off, dx, dz }
    }
    acc += L
  }
  return { x: poly[0], z: poly[1], dx: 0, dz: 1 }
}

// 车辆靠左行驶：单行边车道铺在中线的 DRIVE_SIDE（−1）一侧，车行道 = 中线 → 中线偏 2 车道
const CARRIAGE_W = AIR_LANE_W * 2
const WALK_Y = 0.12

export interface AirfieldMeshStats { meshes: number; triangles: number; marks: number }

export class AirfieldMesh {
  readonly group = new THREE.Group()
  private groundMat: THREE.MeshLambertMaterial
  private glowMat: THREE.MeshLambertMaterial
  private paveMat: THREE.MeshStandardMaterial
  private palette: THREE.DataTexture
  private marks: ChunkMark[] = []
  private tris = 0
  private solidBase!: Builder
  private solidMesh!: THREE.Mesh
  private fixtures!: NearFixtures
  private disposed = false
  /** 套件模型是否已替换占位 */
  modelsReady = false

  constructor(private opts: { roadMat: THREE.Material; walkMat: THREE.Material; marks: RoadMarkings }) {
    this.group.name = 'airfield'
    this.groundMat = new THREE.MeshLambertMaterial({ vertexColors: true })
    const pal = new Uint8Array(PAL_N * 4)
    PAL_RGB.forEach((c, i) => { pal[i * 4] = c[0]; pal[i * 4 + 1] = c[1]; pal[i * 4 + 2] = c[2]; pal[i * 4 + 3] = 255 })
    this.palette = new THREE.DataTexture(pal, PAL_N, 1, THREE.RGBAFormat)
    this.palette.colorSpace = THREE.SRGBColorSpace
    this.palette.magFilter = this.palette.minFilter = THREE.NearestFilter
    this.palette.generateMipmaps = false
    this.palette.needsUpdate = true
    this.glowMat = new THREE.MeshLambertMaterial({ vertexColors: true, emissive: new THREE.Color(GLOW_GAIN, GLOW_GAIN, GLOW_GAIN), emissiveMap: this.palette, emissiveIntensity: 0 })
    this.paveMat = makeRunwayMaterial()

    // solid / glow / 占位件共用 glowMat（Lambert 顶点色 + 调色板 emissiveMap，一个 program）；solid 投影、glow 不投影
    const ground = new Builder(), solid = new Builder(true), glow = new Builder(true), ph = new Builder(true)
    this.buildIsland(ground)
    this.buildRevetment(ground)
    this.buildCausewayBanks(ground, solid)
    const pave = this.buildPavement(ground)
    const { road, walk } = this.buildRoads(solid, glow)
    this.buildTerminal(solid, glow)
    this.buildLights(glow)
    // 程序化占位（机库 / 塔台 / 风向袋）：套件模型异步加载完成后整体换掉
    this.buildHangars(ph, ph)
    this.buildTower(ph, ph)
    this.buildWindsocks(ph)
    this.solidBase = solid

    const add = (g: THREE.BufferGeometry, m: THREE.Material, name: string, cast: boolean) => {
      const mesh = new THREE.Mesh(g, m)
      mesh.name = name
      mesh.receiveShadow = true
      mesh.userData.castShadow = cast
      mesh.castShadow = cast
      this.group.add(mesh)
      this.tris += (g.index ? g.index.count : g.attributes.position.count) / 3
      return mesh
    }
    add(ground.toGeometry(), this.groundMat, 'air:ground', false)
    add(pave, this.paveMat, 'air:pavement', false)
    add(road, opts.roadMat, 'air:road', false)
    add(walk, opts.walkMat, 'air:walk', false)
    this.solidMesh = add(mergeBuilders([solid, ph]), this.glowMat, 'air:solid', true)
    add(glow.toGeometry(), this.glowMat, 'air:glow', false)
    this.fixtures = new NearFixtures(this.glowMat)
    this.group.add(this.fixtures.mesh)
    // AIR.1 套件模型（塔台 / 机库 / 风向袋 / 标牌 / 拖车 / 轮挡 / 灯具）：异步加载，成功后替换占位
    if (typeof window !== 'undefined') {
      loadAirfieldModels().then((m) => { if (!this.disposed) this.useModels(m) })
        .catch((e) => console.warn('[airfield] 套件模型加载失败，保留程序化占位', e))
    }
    // 调试：?air=0 隐藏机场网格（测 draw / 三角 / program 增量）；window.__airfield 可切 group.visible
    if (typeof location !== 'undefined' && new URLSearchParams(location.search).get('air') === '0') this.group.visible = false
    if (typeof window !== 'undefined') (window as unknown as { __airfield: unknown }).__airfield = this
  }

  // ---------------------------------------------------------------------------
  // 岛面 / 护岸 / 堤道边坡
  // ---------------------------------------------------------------------------

  /** 岛的倒角多边形（顺时针：从西北角开始），倒角 C */
  private static readonly CHAMFER = 24
  private islandRing(): [number, number][] {
    const I = ISLAND, C = AirfieldMesh.CHAMFER
    return [
      [I.minX + C, I.minZ], [I.maxX - C, I.minZ], [I.maxX, I.minZ + C], [I.maxX, I.maxZ - C],
      [I.maxX - C, I.maxZ], [I.minX + C, I.maxZ], [I.minX, I.maxZ - C], [I.minX, I.minZ + C],
    ]
  }

  /** 岛面草地：20 m 网格，四角顶点压到倒角线上；逐顶点草色斑驳（深浅草块 + 枯黄斑） */
  private buildIsland(b: Builder) {
    const I = ISLAND, C = AirfieldMesh.CHAMFER, S = 20
    const nx = Math.round((I.maxX - I.minX) / S), nz = Math.round((I.maxZ - I.minZ) / S)
    const grass = col(0x4b6f37), dry = col(0x8a8656)
    const vx = (i: number, j: number): V3 => {
      let x = I.minX + (i / nx) * (I.maxX - I.minX), z = I.minZ + (j / nz) * (I.maxZ - I.minZ)
      const dx = Math.min(x - I.minX, I.maxX - x), dz = Math.min(z - I.minZ, I.maxZ - z)
      if (dx + dz < C) {
        // 压到倒角线上（沿对角线向内推）
        const k = (C - dx - dz) / 2
        x += x - I.minX < I.maxX - x ? k : -k
        z += z - I.minZ < I.maxZ - z ? k : -k
      }
      return [x, -0.12, z]
    }
    const tint = (p: V3) => {
      const n1 = vnoise(p[0] * 0.012, p[2] * 0.012), n2 = vnoise(p[0] * 0.05 + 7, p[2] * 0.05 - 3)
      const c = grass.clone().lerp(dry, Math.max(0, n2 - 0.55) * 1.4)
      return c.multiplyScalar(0.82 + 0.36 * n1)
    }
    // 逐顶点着色需要共享顶点：这里直接写缓冲（法线全 +Y）
    const base = b.pos.length / 3
    for (let j = 0; j <= nz; j++) for (let i = 0; i <= nx; i++) {
      const p = vx(i, j), c = tint(p)
      b.pos.push(p[0], p[1], p[2]); b.nrm.push(0, 1, 0); b.col.push(c.r, c.g, c.b)
    }
    const at = (i: number, j: number) => base + j * (nx + 1) + i
    for (let j = 0; j < nz; j++) for (let i = 0; i < nx; i++) {
      // 绕序：从上往下看逆时针（x 东、z 南：(i,j)→(i,j+1)→(i+1,j+1)）
      b.idx.push(at(i, j), at(i, j + 1), at(i + 1, j + 1), at(i, j), at(i + 1, j + 1), at(i + 1, j))
    }
  }

  /**
   * 护岸：沿岛倒角多边形一圈，内侧立面（−0.12→+0.3）、1.2 m 混凝土压顶（+0.3）、两段抛石斜坡落到 −3（中间一排顶点按位置哈希起伏）。
   * 北边在堤道处断开（x 1521–1555）。转角处补扇形。
   */
  private buildRevetment(b: Builder) {
    const ring = this.islandRing()
    const cx = (ISLAND.minX + ISLAND.maxX) / 2, cz = (ISLAND.minZ + ISLAND.maxZ) / 2
    const coping = col(0xaaa69c), rock = col(0x7c766b)
    // 断口：北边（第 0 条边）在堤道两侧裁开
    const edges: { a: [number, number]; b: [number, number]; capA: boolean; capB: boolean }[] = []
    for (let k = 0; k < ring.length; k++) {
      const a = ring[k], c = ring[(k + 1) % ring.length]
      if (k === 0) {
        edges.push({ a, b: [1521, a[1]], capA: true, capB: false })
        edges.push({ a: [1555, a[1]], b: c, capA: false, capB: true })
      } else edges.push({ a, b: c, capA: true, capB: true })
    }
    const profile = (x: number, z: number, nx: number, nz: number): V3[] => {
      const j = hash2(x * 0.7 + 3, z * 0.7 - 5)
      return [
        [x, -0.12, z], [x, 0.3, z],
        [x + nx * 1.2, 0.3, z + nz * 1.2],
        [x + nx * (3.4 + j * 0.8), -1.15 + (j - 0.5) * 0.5, z + nz * (3.4 + j * 0.8)],
        [x + nx * 6.5, -3, z + nz * 6.5],
      ]
    }
    const hints = (nx: number, nz: number): V3[] => [[-nx, 0, -nz], UP, [nx, 1, nz], [nx, 0.7, nz]]
    const outward = (ax: number, az: number, bx: number, bz: number) => {
      const L = Math.hypot(bx - ax, bz - az)
      let nx = -(bz - az) / L, nz = (bx - ax) / L
      if (nx * ((ax + bx) / 2 - cx) + nz * ((az + bz) / 2 - cz) < 0) { nx = -nx; nz = -nz }
      return [nx, nz]
    }
    for (const e of edges) {
      const [ax, az] = e.a, [bx, bz] = e.b
      const L = Math.hypot(bx - ax, bz - az)
      const [nx, nz] = outward(ax, az, bx, bz)
      const n = Math.max(1, Math.round(L / 8))
      const H = hints(nx, nz)
      for (let s = 0; s < n; s++) {
        const t0 = s / n, t1 = (s + 1) / n
        const p = profile(ax + (bx - ax) * t0, az + (bz - az) * t0, nx, nz)
        const q = profile(ax + (bx - ax) * t1, az + (bz - az) * t1, nx, nz)
        const k = hash2(ax + s * 13.1, az - s * 7.7)
        for (let r = 0; r < 4; r++) b.quad(p[r], q[r], q[r + 1], p[r + 1], H[r], r < 2 ? jit(coping, k, 0.04) : jit(rock, hash2(s * 3 + r, ax + az), 0.16))
      }
    }
    // 转角：相邻两条边在顶点处的剖面之间补四边形（凸角的楔形缺口）
    for (let k = 0; k < ring.length; k++) {
      const prev = ring[(k + ring.length - 1) % ring.length], v = ring[k], next = ring[(k + 1) % ring.length]
      const [n1x, n1z] = outward(prev[0], prev[1], v[0], v[1])
      const [n2x, n2z] = outward(v[0], v[1], next[0], next[1])
      const p = profile(v[0], v[1], n1x, n1z), q = profile(v[0], v[1], n2x, n2z)
      const hx = n1x + n2x, hz = n1z + n2z
      for (let r = 1; r < 4; r++) b.quad(p[r], q[r], q[r + 1], p[r + 1], r === 1 ? UP : [hx, 0.8, hz], r < 2 ? coping : rock)
    }
  }

  /** 堤道两侧：抛石边坡（桥面边缘 y 0 → −3）+ 混凝土护栏（与碰撞体同宽 1.2 m、高 1.1 m，居中在桥面边线上） */
  private buildCausewayBanks(ground: Builder, solid: Builder) {
    const d = CAUSEWAY_DECK
    // 西侧折线（城市 → 岛）：顶点 0 → 5 → 4；东侧：1 → 2 → 3
    const sides: { pts: number[]; sign: number }[] = [
      { pts: [d[0], d[1], d[10], d[11], d[8], d[9]], sign: -1 },
      { pts: [d[2], d[3], d[4], d[5], d[6], d[7]], sign: 1 },
    ]
    const rock = col(0x7a746a), barrier = col(0xbdbab2)
    for (const side of sides) {
      const p = side.pts
      for (let i = 0; i + 3 < p.length; i += 2) {
        const ax = p[i], az = p[i + 1], bx = p[i + 2], bz = Math.min(p[i + 3], ISLAND.minZ)
        const L = Math.hypot(bx - ax, bz - az)
        // 外法线：西侧朝 −x、东侧朝 +x
        let nx = -(bz - az) / L, nz = (bx - ax) / L
        if (nx * side.sign < 0) { nx = -nx; nz = -nz }
        const n = Math.max(1, Math.round(L / 8))
        const prof = (x: number, z: number): V3[] => {
          const j = hash2(x * 0.9 - 11, z * 0.9 + 4)
          return [[x, 0, z], [x + nx * (2.2 + j * 0.6), -1.0 + (j - 0.5) * 0.4, z + nz * (2.2 + j * 0.6)], [x + nx * 5.5, -3, z + nz * 5.5]]
        }
        for (let s = 0; s < n; s++) {
          const t0 = s / n, t1 = (s + 1) / n
          const P = prof(ax + (bx - ax) * t0, az + (bz - az) * t0), Q = prof(ax + (bx - ax) * t1, az + (bz - az) * t1)
          for (let r = 0; r < 2; r++) ground.quad(P[r], Q[r], Q[r + 1], P[r + 1], [nx, 0.8, nz], jit(rock, hash2(s * 5 + r, ax + i), 0.16))
        }
        // 护栏：沿边线的长条（单个长方体，yaw 对齐边方向）
        const yaw = Math.atan2(bx - ax, bz - az)
        solid.box((ax + bx) / 2, 0, (az + bz) / 2, 0.6, 1.1, L, barrier, yaw)
      }
    }
  }

  // ---------------------------------------------------------------------------
  // 铺装（跑道着色器）
  // ---------------------------------------------------------------------------

  /** 跑道 / 滑行道 / 联络道 / 停机坪 / 服务区：互不重叠的矩形（每 100 m 细分），顶点属性 aRw = 类型；外缘补 0 → −0.12 裙边 */
  private buildPavement(ground: Builder): THREE.BufferGeometry {
    const pos: number[] = [], kind: number[] = [], idx: number[] = []
    const rect = (x0: number, z0: number, x1: number, z1: number, k: number) => {
      const nx = Math.max(1, Math.ceil((x1 - x0) / 100)), nz = Math.max(1, Math.ceil((z1 - z0) / 100))
      const base = pos.length / 3
      for (let j = 0; j <= nz; j++) for (let i = 0; i <= nx; i++) {
        pos.push(x0 + ((x1 - x0) * i) / nx, 0, z0 + ((z1 - z0) * j) / nz); kind.push(k)
      }
      for (let j = 0; j < nz; j++) for (let i = 0; i < nx; i++) {
        const a = base + j * (nx + 1) + i
        idx.push(a, a + nx + 1, a + nx + 2, a, a + nx + 2, a + 1)
      }
    }
    const R = RUNWAY, T = TAXIWAY, hw = T.width / 2
    const rz0 = R.z - R.width / 2, rz1 = R.z + R.width / 2
    rect(R.x0, rz0, R.x1, rz1, RW_KIND.runway)
    rect(T.x0 - hw, T.z - hw, T.x1 + hw, T.z + hw, RW_KIND.taxiway)
    for (const cx of CONNECTORS) rect(cx - hw, T.z + hw, cx + hw, rz0, RW_KIND.connector)
    rect(APRON.minX, APRON.minZ, APRON.maxX, APRON.maxZ, RW_KIND.apron)
    rect(SERVICE_AREA.minX, SERVICE_AREA.minZ, SERVICE_AREA.maxX, SERVICE_AREA.maxZ, RW_KIND.service)

    // 裙边（外缘竖面，草地低 12 cm）
    const edge = col(0x8c8a83)
    const skirt = (ax: number, az: number, bx: number, bz: number, nx: number, nz: number) =>
      ground.quad([ax, 0, az], [bx, 0, bz], [bx, -0.12, bz], [ax, -0.12, az], [nx, 0, nz], edge)
    skirt(R.x0, rz0, R.x1, rz0, 0, -1); skirt(R.x0, rz1, R.x1, rz1, 0, 1)
    skirt(R.x0, rz0, R.x0, rz1, -1, 0); skirt(R.x1, rz0, R.x1, rz1, 1, 0)
    skirt(T.x0 - hw, T.z - hw, T.x0 - hw, T.z + hw, -1, 0); skirt(T.x1 + hw, T.z - hw, T.x1 + hw, T.z + hw, 1, 0)
    skirt(T.x0 - hw, T.z - hw, APRON.minX, T.z - hw, 0, -1); skirt(APRON.maxX, T.z - hw, T.x1 + hw, T.z - hw, 0, -1)
    let x = T.x0 - hw
    for (const cx of CONNECTORS) { skirt(x, T.z + hw, cx - hw, T.z + hw, 0, 1); x = cx + hw }
    skirt(x, T.z + hw, T.x1 + hw, T.z + hw, 0, 1)
    for (const cx of CONNECTORS) { skirt(cx - hw, T.z + hw, cx - hw, rz0, -1, 0); skirt(cx + hw, T.z + hw, cx + hw, rz0, 1, 0) }
    skirt(APRON.minX, SERVICE_AREA.minZ, APRON.minX, APRON.maxZ, -1, 0); skirt(APRON.maxX, SERVICE_AREA.minZ, APRON.maxX, APRON.maxZ, 1, 0)
    skirt(SERVICE_AREA.minX, SERVICE_AREA.minZ, SERVICE_AREA.maxX, SERVICE_AREA.minZ, 0, -1)

    const g = new THREE.BufferGeometry()
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3))
    const nrm = new Float32Array(pos.length)
    for (let i = 1; i < nrm.length; i += 3) nrm[i] = 1
    g.setAttribute('normal', new THREE.BufferAttribute(nrm, 3))
    g.setAttribute('aRw', new THREE.Float32BufferAttribute(kind, 1))
    g.setIndex(idx)
    g.computeBoundingSphere()
    return g
  }

  // ---------------------------------------------------------------------------
  // 道路：堤道、岛上连接段、陆侧路、停车场；人行道与分隔带；车道线；路灯
  // ---------------------------------------------------------------------------

  private buildRoads(solid: Builder, glow: Builder): { road: THREE.BufferGeometry; walk: THREE.BufferGeometry } {
    const roadP: number[] = [], roadI: number[] = [], walkP: number[] = [], walkI: number[] = []
    const quad2 = (P: number[], I: number[], q: number[]) => {
      const v = P.length / 2
      P.push(...q)
      I.push(v, v + 1, v + 2, v, v + 2, v + 3)
    }
    const rectQ = (x0: number, z0: number, x1: number, z1: number) => [x0, z0, x1, z0, x1, z1, x0, z1]
    const d = CAUSEWAY_DECK
    const westX = (z: number) => xAtZ([d[0], d[1], d[10], d[11], d[8], d[9]], z)
    const eastX = (z: number) => xAtZ([d[2], d[3], d[4], d[5], d[6], d[7]], z)
    const medL = (z: number) => xAtZ(CAUSEWAY_NB, z) + 0.6
    const medR = (z: number) => xAtZ(CAUSEWAY_SB, z) - 0.6
    const deckEnd = d[7]
    // 堤道：按 z 分段；中央分隔带段 = 左右两条车行道 + 分隔带，其余整幅铺路面
    const zs = [CITY_EDGE_Z, CAUSEWAY_MEDIAN.z0, 1395, 1410, 1420]
    for (let z = 1450; z < CAUSEWAY_MEDIAN.z1; z += 30) zs.push(z)
    zs.push(CAUSEWAY_MEDIAN.z1, 1690, deckEnd)
    zs.sort((a, b) => a - b)
    for (let i = 0; i + 1 < zs.length; i++) {
      const za = zs[i], zb = zs[i + 1]
      if (za >= CAUSEWAY_MEDIAN.z0 && zb <= CAUSEWAY_MEDIAN.z1) {
        quad2(roadP, roadI, [westX(za), za, medL(za), za, medL(zb), zb, westX(zb), zb])
        quad2(walkP, walkI, [medL(za), za, medR(za), za, medR(zb), zb, medL(zb), zb])
        quad2(roadP, roadI, [medR(za), za, eastX(za), za, eastX(zb), zb, medR(zb), zb])
      } else quad2(roadP, roadI, [westX(za), za, eastX(za), za, eastX(zb), zb, westX(zb), zb])
    }
    // 岛上连接段 + 陆侧路（按堤道口 / 停车场入口切段，共享边配对）
    const L = LANDSIDE_ROAD, rz0 = L.z - AIR_LANE_W, rz1 = L.z + AIR_LANE_W
    const cw0 = d[8], cw1 = d[6]
    quad2(roadP, roadI, rectQ(cw0, deckEnd, cw1, rz0))
    const xs = [L.x0, cw0, cw1, PARKING_ENTRY.x0, PARKING_ENTRY.x1, L.x1]
    for (let i = 0; i + 1 < xs.length; i++) quad2(roadP, roadI, rectQ(xs[i], rz0, xs[i + 1], rz1))
    // 停车场 + 入口车道
    quad2(roadP, roadI, rectQ(PARKING_ENTRY.x0, rz1, PARKING_ENTRY.x1, PARKING.minZ))
    quad2(roadP, roadI, rectQ(PARKING.minX, PARKING.minZ, PARKING.maxX, PARKING.maxZ))
    // 人行道：陆侧路北侧（堤道口断开）、南侧（停车场入口断开）、航站楼前广场
    const sw = 3
    quad2(walkP, walkI, rectQ(L.x0, rz0 - sw, cw0, rz0))
    quad2(walkP, walkI, rectQ(cw1, rz0 - sw, L.x1, rz0))
    quad2(walkP, walkI, rectQ(L.x0, rz1, PARKING_ENTRY.x0, TERMINAL_PLAZA.minZ))
    quad2(walkP, walkI, rectQ(PARKING_ENTRY.x1, rz1, L.x1, TERMINAL_PLAZA.minZ))
    const TP = TERMINAL_PLAZA
    quad2(walkP, walkI, rectQ(TP.minX, TP.minZ, TP.maxX, TP.maxZ))

    // 路面几何（y 0，法线 +Y；路面材质着色器自己取 +Y）
    const road = new THREE.BufferGeometry()
    const rp = new Float32Array((roadP.length / 2) * 3), rn = new Float32Array(rp.length)
    for (let k = 0; k < roadP.length / 2; k++) { rp[k * 3] = roadP[k * 2]; rp[k * 3 + 2] = roadP[k * 2 + 1]; rn[k * 3 + 1] = 1 }
    road.setAttribute('position', new THREE.BufferAttribute(rp, 3))
    road.setAttribute('normal', new THREE.BufferAttribute(rn, 3))
    road.setIndex(roadI)
    road.computeBoundingSphere()
    // 人行道几何：复用城市的 buildWalkGeometry（临路边生成路缘石，其余边生成接地立面）；
    // 原点取不与任何边重合的奇数坐标，避免被当成区块裁剪边跳过
    const walk = buildWalkGeometry({
      walkPos: new Float32Array(walkP), walkIdx: new Uint32Array(walkI),
      roadPos: new Float32Array(roadP), roadIdx: new Uint32Array(roadI),
    }, 1000.37, 1000.37)

    // 路面外缘裙边（停车场 / 陆侧路两端，草地低 12 cm）——放进 solid 不投影也无妨，这里只是竖面
    const edge = col(0x5a5a5e)
    const skirt = (ax: number, az: number, bx: number, bz: number, nx: number, nz: number) =>
      solid.quad([ax, 0, az], [bx, 0, bz], [bx, -0.12, bz], [ax, -0.12, az], [nx, 0, nz], edge)
    skirt(L.x0, rz0, L.x0, rz1, -1, 0); skirt(L.x1, rz0, L.x1, rz1, 1, 0)
    skirt(PARKING.minX, PARKING.minZ, PARKING.minX, PARKING.maxZ, -1, 0); skirt(PARKING.maxX, PARKING.minZ, PARKING.maxX, PARKING.maxZ, 1, 0)
    skirt(PARKING.minX, PARKING.maxZ, PARKING.maxX, PARKING.maxZ, 0, 1)
    skirt(PARKING.minX, PARKING.minZ, PARKING_ENTRY.x0, PARKING.minZ, 0, -1); skirt(PARKING_ENTRY.x1, PARKING.minZ, PARKING.maxX, PARKING.minZ, 0, -1)
    skirt(PARKING_ENTRY.x0, rz1, PARKING_ENTRY.x0, PARKING.minZ, -1, 0); skirt(PARKING_ENTRY.x1, rz1, PARKING_ENTRY.x1, PARKING.minZ, 1, 0)

    this.buildRoadMarks()
    this.buildStreetLamps(solid, glow)
    return { road, walk }
  }

  /** 车道线（RoadMarkings 实例）：堤道车道分隔虚线 + 外侧边线、陆侧路中线、航站楼前斑马线、停车位线 */
  private buildRoadMarks() {
    const M = this.marks
    const dash = (x: number, z: number, yaw: number, len: number, w = 0.15) => M.push({ type: 0, x, z, yaw, len, w })
    for (const poly of [CAUSEWAY_SB, CAUSEWAY_NB]) {
      // 只画到分隔带结束（之后进入汇合段）
      const end = poly.slice(0, 8)
      const Lp = polyLength(end)
      // 车道分隔虚线（3 m 实 / 6 m 空），外侧边线（连续，10 m 一段）
      for (let s = 6; s < Lp - 2; s += 9) {
        const p = samplePoly(end, s, -AIR_LANE_W)
        dash(p.x, p.z, Math.atan2(p.dx, p.dz), 3)
      }
      for (let s = 5; s < Lp; s += 10) {
        const p = samplePoly(end, s, -(CARRIAGE_W - 0.3))
        dash(p.x, p.z, Math.atan2(p.dx, p.dz), 10.02)
      }
    }
    // 陆侧路中线虚线（避开堤道口）
    const L = LANDSIDE_ROAD
    for (let x = L.x0 + 4; x < L.x1 - 2; x += 9) if (x < CAUSEWAY_DECK[8] - 4 || x > CAUSEWAY_DECK[6] + 4) dash(x, L.z, Math.PI / 2, 3)
    // 航站楼门口斑马线（横跨陆侧路）
    const tc = (TERMINAL.minX + TERMINAL.maxX) / 2
    M.push({ type: 1, x: tc, z: L.z, yaw: Math.PI / 2, len: 3, w: AIR_LANE_W * 2 })
    // 停车位：南排（靠南缘）与中间背靠背两排，车位宽 2.6 m、深 5 m
    const P = PARKING
    for (const [z0, z1] of [[P.maxZ - 5, P.maxZ], [1738, 1743], [1743, 1748]]) {
      for (let x = P.minX + 3; x <= P.maxX - 3; x += 2.6) dash(x, (z0 + z1) / 2, 0, 5)
      dash((P.minX + P.maxX) / 2, z0, Math.PI / 2, P.maxX - P.minX - 6)
    }
    dash((P.minX + P.maxX) / 2, 1748, Math.PI / 2, P.maxX - P.minX - 6)
  }

  /** 路灯：堤道中央分隔带双臂灯（40 m 一根）、陆侧路两侧单臂灯；灯杆在 solid，灯头在 glow（暖白） */
  private buildStreetLamps(solid: Builder, glow: Builder) {
    const pole = col(0x6d7378), head = col(0xd8d4c8)
    const H = 9
    for (let z = CAUSEWAY_MEDIAN.z0 + 20; z < CAUSEWAY_MEDIAN.z1 - 5; z += 40) {
      const x = (xAtZ(CAUSEWAY_NB, z) + xAtZ(CAUSEWAY_SB, z)) / 2
      solid.box(x, WALK_Y, z, 0.24, H, 0.24, pole)
      solid.box(x, H - 0.2, z, 7, 0.16, 0.16, pole)
      for (const sx of [-1, 1]) glow.box(x + sx * 3.3, H - 0.45, z, 0.9, 0.25, 0.45, head, 0, palU(PAL.lamp), true)
    }
    const L = LANDSIDE_ROAD
    for (let x = L.x0 + 15; x < L.x1; x += 40) {
      for (const side of [-1, 1]) {
        const z = L.z + side * (AIR_LANE_W + 0.9)
        if (side < 0 && x > CAUSEWAY_DECK[8] - 3 && x < CAUSEWAY_DECK[6] + 3) continue
        if (side > 0 && x > PARKING_ENTRY.x0 - 3 && x < PARKING_ENTRY.x1 + 3) continue
        solid.box(x, WALK_Y, z, 0.2, 8, 0.2, pole)
        solid.box(x, 7.8, z - side * 1.2, 0.14, 0.14, 2.4, pole)
        glow.box(x, 7.55, z - side * 2.2, 0.45, 0.22, 0.85, head, 0, palU(PAL.lamp), true)
      }
    }
  }

  // ---------------------------------------------------------------------------
  // 建筑
  // ---------------------------------------------------------------------------

  /** 航站楼：两层玻璃幕墙（glow，夜间暖光）+ 楼板带、屋顶挑檐、竖梃、门口雨棚、屋顶设备、顶边蓝白灯带 */
  private buildTerminal(solid: Builder, glow: Builder) {
    const T = TERMINAL, y0 = WALK_Y
    const glass = col(0x52646c), frame = col(0xc9ccce), roofC = col(0x8e9296), dark = col(0x3a3d40)
    const cx = (T.minX + T.maxX) / 2, cz = (T.minZ + T.maxZ) / 2, w = T.maxX - T.minX, d = T.maxZ - T.minZ
    const bands: [number, number][] = [[y0, 6.6], [7.3, 13.2]]
    const walls: { a: [number, number]; b: [number, number]; n: V3 }[] = [
      { a: [T.minX, T.minZ], b: [T.maxX, T.minZ], n: [0, 0, -1] },
      { a: [T.maxX, T.minZ], b: [T.maxX, T.maxZ], n: [1, 0, 0] },
      { a: [T.maxX, T.maxZ], b: [T.minX, T.maxZ], n: [0, 0, 1] },
      { a: [T.minX, T.maxZ], b: [T.minX, T.minZ], n: [-1, 0, 0] },
    ]
    // 底层到达 / 出发大厅暖光，上层办公冷白
    for (const wall of walls) bands.forEach(([ya, yb], k) => {
      const [ax, az] = wall.a, [bx, bz] = wall.b
      glow.quad([ax, ya, az], [bx, ya, bz], [bx, yb, bz], [ax, yb, az], wall.n, glass, palU(k ? PAL.cool : PAL.warm))
    })
    // 楼板带、屋顶（挑檐 2 m）、女儿墙
    solid.box(cx, 6.6, cz, w + 0.4, 0.7, d + 0.4, frame)
    solid.box(cx, 13.2, cz, w + 4, 0.9, d + 4, roofC, 0, 0, true)
    solid.box(cx, 0, cz, w + 0.3, y0 + 0.02, d + 0.3, dark)
    // 竖梃：每 4 m 一根，贴在玻璃外 0.15 m
    for (let x = T.minX; x <= T.maxX + 0.01; x += 4) {
      solid.box(x, y0, T.minZ - 0.15, 0.25, 13.1, 0.3, frame)
      solid.box(x, y0, T.maxZ + 0.15, 0.25, 13.1, 0.3, frame)
    }
    for (let z = T.minZ + 4; z < T.maxZ - 0.01; z += 4) {
      solid.box(T.minX - 0.15, y0, z, 0.3, 13.1, 0.25, frame)
      solid.box(T.maxX + 0.15, y0, z, 0.3, 13.1, 0.25, frame)
    }
    // 门口：深色入口门洞（北立面中部，玻璃前一层）+ 悬挑雨棚（下沿灯带）
    solid.box(cx, y0, T.minZ - 0.2, 10, 3.2, 0.12, dark)
    solid.box(cx, 5.0, T.minZ - 3.8, 52, 0.45, 7.6, frame)
    glow.box(cx, 4.92, T.minZ - 3.8, 48, 0.08, 0.5, frame, 0, palU(PAL.warm), true)
    // 屋顶设备与顶边灯带（蓝白，远处可认出航站楼）
    solid.box(cx - 20, 14.1, cz + 4, 8, 1.6, 5, dark)
    solid.box(cx + 14, 14.1, cz - 3, 6, 1.2, 4, dark)
    glow.box(cx, 13.4, T.minZ - 2.05, w + 3, 0.35, 0.1, frame, 0, palU(PAL.cool))
    glow.box(cx, 13.4, T.maxZ + 2.05, w + 3, 0.35, 0.1, frame, 0, palU(PAL.cool))
    // 屋顶四角障碍灯
    for (const [x, z] of [[T.minX, T.minZ], [T.maxX, T.minZ], [T.minX, T.maxZ], [T.maxX, T.maxZ]]) glow.box(x, 14.1, z, 0.35, 0.35, 0.35, col(0x802020), 0, palU(PAL.red))
  }

  /**
   * 机库：拱顶（4 m 竖墙 + 8 m 椭圆拱，总高 12）沿 z 拉伸 25 m，门朝南。
   * 外壳 + 向内偏 0.3 m 的暗色内壳；北山墙封闭，南山墙留 22 × 8.6 m 门洞（门洞内能看到暗色内部和顶灯）。
   */
  private buildHangars(solid: Builder, glow: Builder) {
    const tints = [0xc6ccd0, 0xb4bec4, 0xd0cec6, 0xaab6ae]
    const inner = col(0x2c2e31), frame = col(0x55595e)
    const W2 = HANGAR.w / 2, WALL = 4, ARC = HANGAR.h - WALL, DOOR = 11, DOOR_H = 8.6
    // 剖面 x 采样（含门洞边 ±DOOR），y = 拱高
    const xs: number[] = []
    for (let k = 0; k <= 16; k++) xs.push(-W2 * Math.cos((k / 16) * Math.PI))
    xs.push(-DOOR, DOOR)
    xs.sort((a, b) => a - b)
    const yTop = (x: number) => WALL + ARC * Math.sqrt(Math.max(0, 1 - (x / W2) ** 2))
    for (let i = 0; i < HANGAR_XS.length; i++) {
      const xc = HANGAR_XS[i], z0 = HANGAR.minZ, z1 = HANGAR.minZ + HANGAR.d
      const base = col(tints[i % tints.length])
      // 剖面点（外壳）：左墙底 → 左墙顶 → 拱 → 右墙顶 → 右墙底
      const prof: [number, number][] = [[-W2, 0], ...xs.map((x) => [x, yTop(x)] as [number, number]), [W2, 0]]
      for (let k = 0; k + 1 < prof.length; k++) {
        const [xa, ya] = prof[k], [xb, yb] = prof[k + 1]
        if (Math.abs(xa - xb) < 1e-6 && Math.abs(ya - yb) < 1e-6) continue
        const mx = (xa + xb) / 2, my = (ya + yb) / 2
        const hint: V3 = Math.abs(xa - xb) < 1e-6 ? [Math.sign(mx), 0, 0] : [mx / W2, Math.max(0.05, (my - WALL) / ARC), 0]
        // 瓦楞感：相邻条带明暗交替
        const c = base.clone().multiplyScalar(k % 2 ? 0.94 : 1.03)
        solid.quad([xc + xa, ya, z0], [xc + xb, yb, z0], [xc + xb, yb, z1], [xc + xa, ya, z1], hint, c)
        // 内壳（暗色，朝内）
        const ia = 1 - 0.3 / W2
        solid.quad([xc + xa * ia, Math.max(0, ya - 0.3), z0 + 0.3], [xc + xb * ia, Math.max(0, yb - 0.3), z0 + 0.3], [xc + xb * ia, Math.max(0, yb - 0.3), z1], [xc + xa * ia, Math.max(0, ya - 0.3), z1], [-hint[0], -hint[1], 0], inner)
      }
      // 山墙：竖条带（北墙整幅；南墙门洞上方与两侧）
      for (let k = 0; k + 1 < xs.length; k++) {
        const xa = xs[k], xb = xs[k + 1]
        if (xb - xa < 1e-6) continue
        const ya = yTop(xa), yb = yTop(xb)
        const ca = base.clone().multiplyScalar(0.9)
        solid.quad([xc + xa, 0, z0], [xc + xb, 0, z0], [xc + xb, yb, z0], [xc + xa, ya, z0], [0, 0, -1], ca)
        solid.quad([xc + xa, 0, z0 + 0.3], [xc + xb, 0, z0 + 0.3], [xc + xb, yb - 0.3, z0 + 0.3], [xc + xa, ya - 0.3, z0 + 0.3], [0, 0, 1], inner)
        const inDoor = xa >= -DOOR - 1e-6 && xb <= DOOR + 1e-6
        const yb0 = inDoor ? DOOR_H : 0
        solid.quad([xc + xa, yb0, z1], [xc + xb, yb0, z1], [xc + xb, yb, z1], [xc + xa, ya, z1], [0, 0, 1], ca)
        solid.quad([xc + xa, yb0, z1 - 0.3], [xc + xb, yb0, z1 - 0.3], [xc + xb, yb - 0.3, z1 - 0.3], [xc + xa, ya - 0.3, z1 - 0.3], [0, 0, -1], inner)
      }
      // 门框（门洞顶梁 + 两侧立柱）与门洞内底面（暗色地坪，略高于混凝土避免 Z 冲突）
      solid.box(xc, DOOR_H - 0.5, z1 + 0.15, DOOR * 2 + 0.6, 0.5, 0.3, frame)
      solid.box(xc - DOOR - 0.15, 0, z1 + 0.15, 0.3, DOOR_H, 0.3, frame)
      solid.box(xc + DOOR + 0.15, 0, z1 + 0.15, 0.3, DOOR_H, 0.3, frame)
      solid.box(xc, 0, (z0 + z1) / 2 + 0.1, HANGAR.w - 0.7, 0.04, HANGAR.d - 0.5, inner)
      // 内部顶灯两条（冷白）+ 门楣上的机库号灯牌位置用暖色小灯
      for (const sx of [-5, 5]) glow.box(xc + sx, 10.6, (z0 + z1) / 2, 0.6, 0.12, HANGAR.d - 4, inner, 0, palU(PAL.cool), true)
      glow.box(xc, HANGAR.h + 0.05, z1 - 0.6, 0.35, 0.35, 0.35, col(0x802020), 0, palU(PAL.red))
    }
  }

  /** 塔台（程序化占位，约 32 m）：方形底座、八棱柱塔身、玻璃舱（夜间冷光）、挑檐顶、桅杆 + 红色障碍灯 */
  private buildTower(solid: Builder, glow: Builder) {
    const { x, z, size } = TOWER
    const concrete = col(0xc4c2bb), dark = col(0x3a3d40), glass = col(0x4a5e66)
    solid.box(x, 0, z, size, 5, size, concrete)
    solid.box(x - size / 2 - 0.05, 0, z, 0.1, 2.6, 1.8, dark)                         // 西侧门
    glow.box(x, 2.6, z - size / 2 - 0.05, 6, 1.2, 0.1, glass, 0, palU(PAL.warm))       // 底座窗带
    solid.prism(x, z, 2.7, 8, 5, 24.6, concrete, 0, false)
    solid.prism(x, z, 4.7, 8, 24, 24.6, concrete)
    glow.prism(x, z, 4.4, 8, 24.6, 28, glass, palU(PAL.cool), false)
    solid.prism(x, z, 5.0, 8, 28, 28.7, dark)
    solid.box(x, 28.7, z, 0.22, 3.6, 0.22, dark)
    glow.box(x, 32.3, z, 0.45, 0.45, 0.45, col(0x802020), 0, palU(PAL.red))
  }

  /** 风向袋：6 m 杆 + 红白相间锥形袋（指向 +x，略下垂） */
  private buildWindsocks(solid: Builder) {
    const pole = col(0xe8e8e8), orange = col(0xf06a1c), white = col(0xf2f2f0)
    for (const w of WINDSOCKS) {
      solid.box(w.x, -0.12, w.z, 0.14, 6.2, 0.14, pole)
      solid.box(w.x, -0.12, w.z, 1.2, 0.2, 1.2, col(0x8c8a83))
      const N = 8, L = 3.6, bands = 4
      for (let k = 0; k < bands; k++) {
        const t0 = k / bands, t1 = (k + 1) / bands
        const r0 = 0.45 - 0.25 * t0, r1 = 0.45 - 0.25 * t1
        const x0 = w.x + 0.1 + L * t0, x1 = w.x + 0.1 + L * t1
        const y0 = 5.9 - 0.35 * t0, y1 = 5.9 - 0.35 * t1
        for (let s = 0; s < N; s++) {
          const a0 = (s / N) * Math.PI * 2, a1 = ((s + 1) / N) * Math.PI * 2, am = (a0 + a1) / 2
          const P = (xx: number, yy: number, r: number, a: number): V3 => [xx, yy + Math.cos(a) * r, w.z + Math.sin(a) * r]
          solid.quad(P(x0, y0, r0, a0), P(x1, y1, r1, a0), P(x1, y1, r1, a1), P(x0, y0, r0, a1), [0.1, Math.cos(am), Math.sin(am)], k % 2 ? white : orange)
        }
      }
    }
  }

  // ---------------------------------------------------------------------------
  // 机场灯光（小发光体，合并进 glow 网格）
  // ---------------------------------------------------------------------------

  /**
   * 灯光：远处靠这些小发光体（合并进 glow，夜间 HDR 被泛光抓到）。
   * 跑道边灯 / 滑行道蓝灯只画一个 0.18 m 的"灯芯"，位置在套件灯具模型的灯罩里——近处由 NearFixtures 补出完整灯具，远处只剩光点。
   * 入口灯（绿）/ 末端灯（红）/ 进近灯 / PAPI 没有对应模型，保持程序化小盒。
   */
  private buildLights(glow: Builder) {
    const R = RUNWAY
    const housing = col(0xd9d2a0), blueC = col(0x3a62c8), greenC = col(0x2f9a4c), redC = col(0xb0302a)
    const lamp = (x: number, z: number, c: THREE.Color, p: number, s = 0.4, h = 0.5) => glow.box(x, -0.12, z, s, h, s, c, 0, palU(p))
    const core = (x: number, z: number, c: THREE.Color, p: number) => glow.box(x, 0.2, z, 0.18, 0.18, 0.18, c, 0, palU(p), true)
    const { edge, blue } = this.lightSpots()
    for (const [x, z] of edge) core(x, z, housing, PAL.white)
    for (const [x, z] of blue) core(x, z, blueC, PAL.blue)
    // 入口灯（绿）与跑道末端灯（红）
    for (let z = R.z - R.width / 2 + 1; z <= R.z + R.width / 2 - 1 + 0.01; z += 3.5) {
      lamp(R.x0 - 1, z, greenC, PAL.green); lamp(R.x1 + 1, z, greenC, PAL.green)
    }
    for (let z = R.z - R.width / 2 + 2; z <= R.z + R.width / 2 - 2 + 0.01; z += 7) {
      lamp(R.x0 - 4, z, redC, PAL.red); lamp(R.x1 + 4, z, redC, PAL.red)
    }
    // 进近灯（白，跑道两端向外 10 m 一盏，50 m 处一道横排）
    for (const [x0, dir] of [[R.x0, -1], [R.x1, 1]] as const) {
      for (let k = 2; k <= 7; k++) lamp(x0 + dir * k * 10, R.z, housing, PAL.white, 0.5, 0.8)
      for (let dz = -8; dz <= 8; dz += 2) if (dz !== 0) lamp(x0 + dir * 50, R.z + dz, housing, PAL.white, 0.45, 0.8)
    }
    // PAPI（4 盏，距入口 270 m，09 号在北侧、27 号在南侧；外两红内两白 = 正常下滑道）
    for (const [x, side] of [[R.x0 + 270, -1], [R.x1 - 270, 1]] as const) {
      for (let k = 0; k < 4; k++) {
        const z = R.z + side * (R.width / 2 + 12 + k * 9)
        const red = k >= 2
        glow.box(x, -0.12, z, 1.4, 0.9, 0.9, red ? redC : housing, 0, palU(red ? PAL.red : PAL.white))
      }
    }
  }

  // ---------------------------------------------------------------------------

  attach(scene: THREE.Scene) {
    scene.add(this.group)
    // 夜间发光：DayNight.attachWorld 读取 scene.userData.windows（须在它之前调用）
    const windows = (scene.userData.windows as THREE.Material[] | undefined) ?? []
    windows.push(this.glowMat)
    scene.userData.windows = windows
    // 铺装也走 Weather 的湿地环境反射（湿度由街面着色器自己算）
    const roads = (scene.userData.roads as THREE.Material[] | undefined) ?? []
    roads.push(this.paveMat)
    scene.userData.roads = roads
    this.opts.marks.addChunk('airfield', this.marks)
    this.opts.marks.flush()
  }

  // ---------------------------------------------------------------------------
  // AIR.1 套件模型
  // ---------------------------------------------------------------------------

  /** 位置表（也供近处灯具用）：跑道边灯 60 m、滑行道蓝灯 30 m（与 buildLights 的程序化光点同位） */
  private lightSpots() {
    const R = RUNWAY, T = TAXIWAY, hw = T.width / 2, re = R.width / 2 + 1, te = hw + 0.8
    const edge: [number, number][] = [], blue: [number, number][] = []
    for (let x = R.x0; x <= R.x1 + 0.01; x += 60) edge.push([x, R.z - re], [x, R.z + re])
    for (let x = T.x0 - hw + 4; x <= T.x1 + hw - 4; x += 30) {
      if (!CONNECTORS.some((cx) => Math.abs(x - cx) < hw + 2)) blue.push([x, T.z + te])
      if (x < APRON.minX - 2 || x > APRON.maxX + 2) blue.push([x, T.z - te])
    }
    for (const cx of CONNECTORS) for (let z = T.z + hw + 8; z < R.z - R.width / 2 - 3; z += 15) blue.push([cx - te, z], [cx + te, z])
    for (let z = SERVICE_AREA.minZ + 10; z < APRON.maxZ; z += 25) blue.push([APRON.minX - 0.8, z], [APRON.maxX + 0.8, z])
    return { edge, blue }
  }

  /** 用套件模型替换程序化占位：塔台、4 座机库、风向袋并入 solid（投影）；标牌 / 拖车 / 轮挡也并入；灯具进近处动态网格 */
  private useModels(m: Map<string, AirfieldModel>) {
    const get = (id: string) => m.get(id)?.geometry
    const tower = get('control-tower'), hangar = get('hangar')
    if (!tower || !hangar) { console.warn('[airfield] 套件缺塔台 / 机库，保留占位'); return }
    const b = new Builder(true)
    const bld = glowPal(true)
    b.appendGeometry(tower, TOWER.x, 0, TOWER.z, 0, 1, bld)
    // 机库：门朝 +z，模型最南端对齐 HANGAR 矩形南缘（= 停机坪北缘）
    const hb = hangar.boundingBox!
    for (let i = 0; i < HANGAR_XS.length; i++) {
      const sx = HANGAR.w / (hb.max.x - hb.min.x)
      b.appendGeometry(hangar, HANGAR_XS[i] - (hb.max.x + hb.min.x) / 2 * sx, 0, HANGAR.minZ + HANGAR.d - hb.max.z * sx, 0, sx, bld)
    }
    const sock = get('windsock')
    if (sock) for (const w of WINDSOCKS) b.appendGeometry(sock, w.x, -0.12, w.z, Math.PI / 2, 1.4, glowPal(false))
    // 等待位置标牌：每条联络道西侧，面朝北（迎着从滑行道驶来的飞机）；位置标牌：主滑行道北侧两块
    const hold = get('hold-short-sign'), loc = get('taxiway-loc-sign')
    if (hold) for (const cx of CONNECTORS) b.appendGeometry(hold, cx - TAXIWAY.width / 2 - 3, -0.12, HOLD_SHORT_Z, Math.PI, 1.6, glowPal(true))
    if (loc) for (const x of [1200, 1900]) b.appendGeometry(loc, x, -0.12, TAXIWAY.z - TAXIWAY.width / 2 - 3, Math.PI, 1.6, glowPal(true))
    // 停机坪道具：2 号机库门前的拖车与两组轮挡（放在停机位框外侧，不挡飞机）
    const tug = get('pushback-tug'), chocks = get('wheel-chocks')
    if (tug) b.appendGeometry(tug, HANGAR_XS[1] + 11, 0, APRON.minZ + 6.5, Math.PI / 2, 1, glowPal(false))
    if (chocks) for (const st of [STANDS[0], STANDS[2]]) b.appendGeometry(chocks, st.x + 9, 0, st.z - 6, 0, 1, glowPal(false))
    const old = this.solidMesh.geometry
    this.tris -= (old.index ? old.index.count : 0) / 3
    this.solidMesh.geometry = mergeBuilders([this.solidBase, b])
    this.tris += this.solidMesh.geometry.index!.count / 3
    old.dispose()
    // 近处灯具
    const edgeL = get('runway-edge-light'), blueL = get('taxiway-blue-light')
    const { edge, blue } = this.lightSpots()
    const items: FixtureItem[] = []
    if (edgeL) for (const [x, z] of edge) items.push({ x, y: -0.12, z, yaw: Math.PI / 2, s: 1.2, geo: edgeL, pal: glowPal(false) })
    if (blueL) for (const [x, z] of blue) items.push({ x, y: -0.12, z, yaw: 0, s: 1.2, geo: blueL, pal: glowPal(false) })
    this.fixtures.setItems(items)
    this.modelsReady = true
  }

  get stats(): AirfieldMeshStats & { modelsReady: boolean; fixtures: number; fixtureTris: number } {
    return { meshes: this.group.children.length, triangles: Math.round(this.tris), marks: this.marks.length, modelsReady: this.modelsReady, fixtures: this.fixtures.shown, fixtureTris: this.fixtures.tris }
  }

  dispose() {
    this.disposed = true
    this.opts.marks.removeChunk('airfield')
    for (const o of this.group.children) (o as THREE.Mesh).geometry.dispose()
    this.fixtures.dispose()
    this.groundMat.dispose(); this.glowMat.dispose(); this.paveMat.dispose(); this.palette.dispose()
    this.group.removeFromParent()
  }
}
