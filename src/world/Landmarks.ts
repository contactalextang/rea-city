import * as THREE from 'three'
import { makeWallMaterial } from './BuildingMesh'

/**
 * 真实新加坡地标精做（程序化低多边形，Lambert + 顶点色，与区块建筑同风格）。
 * 由 SgWorld.attach 创建并常驻（不随区块流式加载），每个地标按材质合并成 1–4 个 Mesh，总 draw call ≤ 20。
 *
 * 替换约定：
 * - REPLACE_RULES 列出被精做模型取代的烘焙建筑（数据来自 data/geo/build/buildings.json 的足迹 PCA：
 *   质心 cx/cz（顶点平均）、主轴角 th、主轴/副轴范围 a0..a1 / b0..b1）。
 * - ChunkManager 构建区块时对每栋楼调用 isReplaced(name, cx, cz)：命中则不出挤出几何，但碰撞体仍按原足迹。
 * - SgWorld 构建天际线时对每个三角调用 skylineHidden(x, z)：落在被替换足迹矩形内的三角丢弃。
 *
 * 夜间：外墙窗格材质与发光材质（MBS 空中花园灯带、摩天轮轮圈/座舱、超级树冠）推进 scene.userData.windows，
 * DayNight 按夜间强度统一调 emissiveIntensity（本模块不碰 DayNight）。
 * 坐标：x 东 z 南，局部帧 setFrame(cx, cz, th) 把局部 +x 映射到世界 (cos th, sin th)，局部 +z 映射到 (−sin th, cos th)。
 */

type V2 = [number, number]
type V3 = [number, number, number]

interface ReplaceRule {
  id: number
  /** 有名建筑按名称精确匹配 + 质心落在足迹矩形内；无名建筑按质心距离（< 8 m）匹配 */
  name?: string
  cx: number
  cz: number
  th: number
  a0: number
  a1: number
  b0: number
  b1: number
}

/** 被替换的烘焙建筑（buildings.json id 仅供追溯；匹配用名称/质心） */
const REPLACE_RULES: ReplaceRule[] = [
  // Marina Bay Sands：三塔 + 空中花园（裙楼 The Shoppes 保留）
  { id: 182, name: 'SkyPark', cx: 1587.2, cz: -166.8, th: -1.162, a0: -206, a1: 133.6, b0: -29.8, b1: 33.5 },
  { id: 183, name: 'Marina Bay Sands Tower 1', cx: 1523.5, cz: -21.6, th: -0.335, a0: -40.5, a1: 37.6, b0: -35.7, b1: 40.4 },
  { id: 796, name: 'Marina Bay Sands Tower 2', cx: 1583.9, cz: -125.1, th: -0.979, a0: -40.4, a1: 27.7, b0: -30.6, b1: 28.4 },
  { id: 795, name: 'Marina Bay Sands Tower 3', cx: 1613.8, cz: -230.3, th: -1.206, a0: -39.1, a1: 18.1, b0: -16.4, b1: 18.6 },
  // ArtScience Museum（OSM 只有一个 6 m 无名基座）
  { id: 3370, cx: 1431.2, cz: -427.1, th: -0.304, a0: -22.8, a1: 22.4, b0: -15.7, b1: 20.8 },
  // Esplanade 两个"榴莲"穹顶（整体 13 m 裙楼 Esplanade Theatres on the Bay 保留）
  { id: 2890, name: 'Esplanade Concert Hall', cx: 962.1, cz: -753.2, th: -0.449, a0: -42.2, a1: 54.3, b0: -38.3, b1: 26.5 },
  { id: 2891, name: 'Esplanade Theatre', cx: 1005.7, cz: -853, th: 1.183, a0: -53.2, a1: 54, b0: -33.2, b1: 30.4 },
  // Singapore Flyer：航站楼环 + 轮子地面投影条
  { id: 153, name: 'Singapore Flyer', cx: 1859.7, cz: -762.7, th: -0.336, a0: -70, a1: 57.6, b0: -51.2, b1: 51.6 },
  { id: 2843, name: 'Singapore Flyer', cx: 1850.3, cz: -764.1, th: -0.663, a0: -73.5, a1: 73.5, b0: -4, b1: 4 },
  { id: 55, name: 'Lau Pa Sat', cx: 444.7, cz: 201.1, th: 0.174, a0: -37.7, a1: 35.9, b0: -29.1, b1: 43.9 },
  { id: 89, name: 'Buddha Tooth Relic Temple', cx: -242.3, cz: 117.1, th: 0.492, a0: -50.2, a1: 28.3, b0: -15.6, b1: 16.3 },
  { id: 2917, name: 'Sri Mariamman Temple', cx: -156.4, cz: -20.6, th: 0.124, a0: -11.6, a1: 35.4, b0: -13.2, b1: 9.4 },
  // Pinnacle@Duxton：整体外轮廓 + 5 个无名塔楼足迹
  { id: 2937, name: 'The Pinnacle@Duxton', cx: -583.4, cz: 552.5, th: 1.54, a0: -82.6, a1: 110.4, b0: -64.8, b1: 58.4 },
  { id: 157, cx: -537.9, cz: 559.6, th: 1.107, a0: -20.9, a1: 20.9, b0: -12, b1: 12 },
  { id: 159, cx: -617.4, cz: 516.3, th: -0.543, a0: -19.6, a1: 19.6, b0: -12.3, b1: 12.3 },
  { id: 162, cx: -556.9, cz: 617.1, th: -0.449, a0: -20.2, a1: 20.2, b0: -10.9, b1: 10.9 },
  { id: 163, cx: -597.3, cz: 657.2, th: -1.094, a0: -13.3, a1: 26.5, b0: -11.2, b1: 10.9 },
  { id: 164, cx: -567.2, cz: 520.6, th: 0.715, a0: -19.9, a1: 19.9, b0: -12.3, b1: 12.3 },
  // Gardens by the Bay 超级树：OSM 圆柱（高）+ 3 m 基座环（无名）
  ...([
    [783, 1909.8, 131.9, 4.5], [785, 1965.7, 19.2, 8.5], [786, 1962, 93.1, 5], [787, 1901.8, 22.2, 7.7], [788, 1929.9, 7.5, 5.4],
    [790, 1888, 55.3, 5.6], [791, 1993.7, 82.8, 5.3], [3239, 1917.4, 100.9, 8.4], [3240, 1917.3, 101, 8.8], [3241, 1965.6, 19.5, 7.7],
    [3242, 1940.2, 61.8, 13.9], [3280, 1961.7, 93.1, 3.3], [3281, 1909.7, 132.1, 3.8], [3282, 1993.6, 82.7, 2.8], [3283, 2000.6, 34, 4.2],
    [3284, 1929.8, 7.4, 4.7], [3285, 1901.7, 22.3, 6.4], [3286, 1888, 55.3, 4.6],
  ] as const).map(([id, cx, cz, r]) => ({ id, cx, cz, th: 0, a0: -r, a1: r, b0: -r, b1: r })),
]

const NAMED_MARGIN = 3
const UNNAMED_DIST = 8
const SKY_MARGIN = 2

function inRule(r: ReplaceRule, x: number, z: number, margin: number): boolean {
  const dx = x - r.cx, dz = z - r.cz
  const c = Math.cos(r.th), s = Math.sin(r.th)
  const a = dx * c + dz * s, b = -dx * s + dz * c
  return a >= r.a0 - margin && a <= r.a1 + margin && b >= r.b0 - margin && b <= r.b1 + margin
}

/** 该烘焙建筑是否被地标模型取代（cx/cz 为足迹顶点平均质心） */
export function isReplaced(name: string | undefined, cx: number, cz: number): boolean {
  for (const r of REPLACE_RULES) {
    if (r.name) { if (name === r.name && inRule(r, cx, cz, NAMED_MARGIN)) return true }
    else if (!name && Math.hypot(cx - r.cx, cz - r.cz) < UNNAMED_DIST) return true
  }
  return false
}

/** 天际线三角（按 xz 质心）是否落在被替换足迹内 */
export function skylineHidden(x: number, z: number): boolean {
  for (const r of REPLACE_RULES) if (inRule(r, x, z, SKY_MARGIN)) return true
  return false
}

/** 地标清单（查看页跳转 / 报告用）：坐标为模型中心 */
export const LANDMARK_SITES: Record<string, { x: number; z: number }> = {
  mbs: { x: 1583, z: -125 },
  artscience: { x: 1431, z: -427 },
  merlion: { x: 890.7, z: -473.6 },
  esplanade: { x: 984, z: -803 },
  flyer: { x: 1850.3, z: -764.1 },
  supertrees: { x: 1940, z: 62 },
  laupasat: { x: 444.7, z: 201.1 },
  buddhatooth: { x: -252, z: 112 },
  mariamman: { x: -145, z: -22 },
  pinnacle: { x: -583, z: 590 },
}

// ---------------------------------------------------------------------------
// 几何累加器：非索引三角，position / normal / uv / color 四个属性（合并要求属性一致）
// ---------------------------------------------------------------------------

const SPRAY_N = 180
/** 水面高度：地面 ground.png 在 −0.12，路面 0；间隔够大以免远处深度冲突 */
const WATER_Y = -0.05
const PANE_UV = 12.8   // 与 BuildingMesh 一致：每张窗格贴图 4 格 × 3.2 m
const tmpC = new THREE.Color()
const tmpV = new THREE.Vector3(), tmpN = new THREE.Vector3()

class Geo {
  pos: number[] = []
  nrm: number[] = []
  uv: number[] = []
  col: number[] = []
  /** 局部帧 → 世界 */
  m = new THREE.Matrix4()
  nm = new THREE.Matrix3()

  setFrame(cx: number, cz: number, th: number, y = 0): this {
    this.m.makeRotationY(-th).setPosition(cx, y, cz)
    this.nm.getNormalMatrix(this.m)
    return this
  }

  get empty() { return this.pos.length === 0 }

  /** 单个三角（局部坐标），法线按 (b−a)×(c−a) 计算 */
  tri(a: V3, b: V3, c: V3, color: number, uvs?: [V2, V2, V2]) {
    const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2]
    const vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2]
    tmpN.set(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx).normalize().applyMatrix3(this.nm).normalize()
    tmpC.setHex(color)
    const pts = [a, b, c]
    for (let k = 0; k < 3; k++) {
      tmpV.set(pts[k][0], pts[k][1], pts[k][2]).applyMatrix4(this.m)
      this.pos.push(tmpV.x, tmpV.y, tmpV.z)
      this.nrm.push(tmpN.x, tmpN.y, tmpN.z)
      const t = uvs ? uvs[k] : [0.03, 0.03]
      this.uv.push(t[0], t[1])
      this.col.push(tmpC.r, tmpC.g, tmpC.b)
    }
  }

  /** 四边形 a→b→c→d（从外侧看逆时针） */
  quad(a: V3, b: V3, c: V3, d: V3, color: number, uvs?: [V2, V2, V2, V2]) {
    this.tri(a, b, c, color, uvs && [uvs[0], uvs[1], uvs[2]])
    this.tri(a, c, d, color, uvs && [uvs[0], uvs[2], uvs[3]])
  }

  /**
   * 放样棱柱：rings 自下而上，每环点数相同（局部 xz，会被强制成俯视逆时针 = 鞋带 < 0），
   * 侧面按周长/高度生成窗格 UV；top/bottom 封顶（ShapeUtils 三角化）。color 可按层（下标为下面那环）给。
   */
  loft(rings: { pts: V2[]; y: number }[], color: number | ((layer: number, edge: number) => number), opts: { top?: boolean; bottom?: boolean; roof?: number; inward?: boolean } = {}) {
    const fixed = rings.map((r) => ({ pts: orient(r.pts, !opts.inward), y: r.y }))
    const n = fixed[0].pts.length
    for (let l = 0; l + 1 < fixed.length; l++) {
      const lo = fixed[l], hi = fixed[l + 1]
      let cum = 0
      for (let k = 0; k < n; k++) {
        const p0 = lo.pts[k], p1 = lo.pts[(k + 1) % n], q0 = hi.pts[k], q1 = hi.pts[(k + 1) % n]
        const len = Math.hypot(p1[0] - p0[0], p1[1] - p0[1])
        const u0 = cum / PANE_UV, u1 = (cum + len) / PANE_UV
        const c = typeof color === 'number' ? color : color(l, k)
        this.quad([p0[0], lo.y, p0[1]], [p1[0], lo.y, p1[1]], [q1[0], hi.y, q1[1]], [q0[0], hi.y, q0[1]], c,
          [[u0, lo.y / PANE_UV], [u1, lo.y / PANE_UV], [u1, hi.y / PANE_UV], [u0, hi.y / PANE_UV]])
        cum += len
      }
    }
    const capColor = opts.roof ?? (typeof color === 'number' ? color : color(fixed.length - 1, 0))
    if (opts.top) this.cap(fixed[fixed.length - 1].pts, fixed[fixed.length - 1].y, true, capColor)
    if (opts.bottom) this.cap(fixed[0].pts, fixed[0].y, false, capColor)
  }

  /** 水平多边形封面 */
  cap(pts: V2[], y: number, up: boolean, color: number) {
    const contour = pts.map((p) => new THREE.Vector2(p[0], p[1]))
    let faces: number[][]
    try { faces = THREE.ShapeUtils.triangulateShape(contour, []) } catch { faces = [] }
    for (const f of faces) {
      const a = pts[f[0]], b = pts[f[1]], c = pts[f[2]]
      // 俯视下 (b−a)×(c−a) 的 y 分量 = (bz−az)(cx−ax) − (bx−ax)(cz−az)
      const ny = (b[1] - a[1]) * (c[0] - a[0]) - (b[0] - a[0]) * (c[1] - a[1])
      const flip = (ny < 0) === up
      const A: V3 = [a[0], y, a[1]], B: V3 = [b[0], y, b[1]], C: V3 = [c[0], y, c[1]]
      if (flip) this.tri(A, C, B, color)
      else this.tri(A, B, C, color)
    }
  }

  /** 轴对齐盒（局部帧）：中心 (x, y0..y1, z)，半宽 hx/hz */
  box(x: number, z: number, hx: number, hz: number, y0: number, y1: number, color: number, roof?: number) {
    this.loft([{ pts: rect(x, z, hx, hz), y: y0 }, { pts: rect(x, z, hx, hz), y: y1 }], color, { top: true, roof })
  }

  /** 截头四棱台（屋顶 / 台基）：底面 hx0×hz0 → 顶面 hx1×hz1 */
  frustum(x: number, z: number, hx0: number, hz0: number, y0: number, hx1: number, hz1: number, y1: number, color: number, opts: { top?: boolean; bottom?: boolean } = { top: true }) {
    this.loft([{ pts: rect(x, z, hx0, hz0), y: y0 }, { pts: rect(x, z, hx1, hz1), y: y1 }], color, opts)
  }

  /** 正多边形棱台：半径 r0 → r1，相位 rot */
  ngon(x: number, z: number, sides: number, r0: number, y0: number, r1: number, y1: number, color: number, rot = 0, opts: { top?: boolean; bottom?: boolean } = { top: true }) {
    this.loft([{ pts: poly(x, z, sides, r0, rot), y: y0 }, { pts: poly(x, z, sides, r1, rot), y: y1 }], color, opts)
  }

  /** 合并一个 three 几何（局部变换 local 后再套帧）；color 可按三角下标给 */
  geom(g: THREE.BufferGeometry, color: number | ((tri: number) => number), local?: THREE.Matrix4) {
    const src = g.index ? g.toNonIndexed() : g
    const p = src.attributes.position, nAttr = src.attributes.normal
    const m = local ? new THREE.Matrix4().multiplyMatrices(this.m, local) : this.m
    const nm = new THREE.Matrix3().getNormalMatrix(m)
    for (let i = 0; i < p.count; i++) {
      tmpV.fromBufferAttribute(p, i).applyMatrix4(m)
      this.pos.push(tmpV.x, tmpV.y, tmpV.z)
      if (nAttr) tmpN.fromBufferAttribute(nAttr, i).applyMatrix3(nm).normalize()
      else tmpN.set(0, 1, 0)
      this.nrm.push(tmpN.x, tmpN.y, tmpN.z)
      this.uv.push(0.03, 0.03)   // 非窗格部件：UV 固定在贴图无窗角落
      tmpC.setHex(typeof color === 'number' ? color : color(Math.floor(i / 3)))
      this.col.push(tmpC.r, tmpC.g, tmpC.b)
    }
    if (src !== g) src.dispose()
    g.dispose()
  }

  /** 两点之间的圆柱梁（局部坐标） */
  beam(p: V3, q: V3, r: number, color: number, seg = 6) {
    const a = new THREE.Vector3(...p), b = new THREE.Vector3(...q)
    const dir = b.clone().sub(a)
    const len = dir.length()
    if (len < 1e-3) return
    const local = new THREE.Matrix4().compose(
      a.clone().add(b).multiplyScalar(0.5),
      new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.normalize()),
      new THREE.Vector3(1, 1, 1),
    )
    this.geom(new THREE.CylinderGeometry(r, r, len, seg, 1, true), color, local)
  }

  /** 生成网格（空则返回 null） */
  mesh(mat: THREE.Material, name: string): THREE.Mesh | null {
    if (this.empty) return null
    const g = new THREE.BufferGeometry()
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3))
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.nrm, 3))
    g.setAttribute('uv', new THREE.Float32BufferAttribute(this.uv, 2))
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.col, 3))
    g.computeBoundingSphere()
    const m = new THREE.Mesh(g, mat)
    m.name = name
    return m
  }
}

/** 鞋带公式 ×2（xz 平面） */
function shoelace(pts: V2[]): number {
  let a = 0
  for (let k = 0; k < pts.length; k++) {
    const p = pts[k], q = pts[(k + 1) % pts.length]
    a += p[0] * q[1] - q[0] * p[1]
  }
  return a
}
/** 外表面朝外：鞋带 < 0（与 BuildingMesh 一致）；inward 时反过来 */
function orient(pts: V2[], outward: boolean): V2[] {
  const s = shoelace(pts)
  return (s < 0) === outward ? pts : [...pts].reverse()
}
function rect(x: number, z: number, hx: number, hz: number): V2[] {
  return [[x - hx, z - hz], [x + hx, z - hz], [x + hx, z + hz], [x - hx, z + hz]]
}
function poly(x: number, z: number, sides: number, r: number, rot = 0): V2[] {
  const out: V2[] = []
  for (let k = 0; k < sides; k++) {
    const a = rot + (k / sides) * Math.PI * 2
    out.push([x + Math.cos(a) * r, z + Math.sin(a) * r])
  }
  return out
}

// ---------------------------------------------------------------------------
// 配色
// ---------------------------------------------------------------------------
const C = {
  mbsFacade: 0xc9d3dc, deck: 0xd9dde0, deckSide: 0xb5bcc3, pool: 0x3aa6d8, green: 0x4f8a3e,
  white: 0xf2f0ea, cream: 0xe8dcc0, stone: 0x9a968c, steel: 0x8d969f, darkSteel: 0x4d555e,
  shell: 0xb8ad8e, shellDark: 0x9b9175, glass: 0x8fa6b8,
  trunk: 0x7a6088, vine: 0x5f9a50, canopy: 0xa57bbb,
  roofGrey: 0x7d8a8c, red: 0xa8281e, roofRed: 0x6e2418, gold: 0xd4a838,
  pinnacle: 0xd6d2c8, bridge: 0xbfc3c8,
}
const GOPURAM_BANDS = [0xe8c040, 0x3a8fd0, 0xd8483c, 0x48a858, 0xe070a0, 0xf4efe0]

// ---------------------------------------------------------------------------
// 地标
// ---------------------------------------------------------------------------

export interface LandmarkStats { meshes: number; triangles: number; names: string[] }

export class Landmarks {
  readonly group = new THREE.Group()
  readonly solidMat = new THREE.MeshLambertMaterial({ vertexColors: true })
  readonly facadeMat = makeWallMaterial()
  /** 发光材质：白天 emissiveIntensity=0，夜间由 DayNight 调高 */
  readonly glowWarm = new THREE.MeshLambertMaterial({ vertexColors: true, emissive: 0xfff0c8, emissiveIntensity: 0 })
  readonly glowCool = new THREE.MeshLambertMaterial({ vertexColors: true, emissive: 0x9fd8ff, emissiveIntensity: 0 })
  readonly glowPurple = new THREE.MeshLambertMaterial({ vertexColors: true, emissive: 0xc060ff, emissiveIntensity: 0, side: THREE.DoubleSide })
  readonly capsuleMat = new THREE.MeshLambertMaterial({ color: 0xdfe9f2, emissive: 0xbfe4ff, emissiveIntensity: 0 })
  readonly waterMat = new THREE.MeshPhongMaterial({ color: 0x2a5f8f, specular: 0x8fb4d8, shininess: 80, transparent: true, opacity: 0.85, depthFunc: THREE.LessDepth })
  readonly sprayMat = new THREE.PointsMaterial({ color: 0xe6f6ff, size: 0.45, transparent: true, opacity: 0.75, depthWrite: false })
  private wheel = new THREE.Group()
  private capsules!: THREE.InstancedMesh
  private wheelAngle = 0
  private spray!: THREE.Points
  private sprayPhase: Float32Array
  private sprayJit: Float32Array
  private time = 0
  readonly names: string[] = []

  constructor(water: { ring: number[] }[] | null) {
    this.group.name = 'landmarks'
    this.sprayPhase = new Float32Array(SPRAY_N)
    this.sprayJit = new Float32Array(SPRAY_N * 2)
    for (let i = 0; i < SPRAY_N; i++) { this.sprayPhase[i] = i / SPRAY_N; this.sprayJit[i * 2] = Math.random() - 0.5; this.sprayJit[i * 2 + 1] = Math.random() - 0.5 }
    this.buildMbs()
    this.buildMerlion()
    this.buildEsplanade()
    this.buildFlyer()
    this.buildSupertrees()
    this.buildLauPaSat()
    this.buildBuddhaTooth()
    this.buildMariamman()
    this.buildPinnacle()
    if (water) this.buildWater(water)
  }

  private add(m: THREE.Mesh | THREE.Points | THREE.InstancedMesh | null, parent: THREE.Object3D = this.group) {
    if (!m) return
    if ((m as THREE.Mesh).isMesh) { m.castShadow = true; m.receiveShadow = true }
    parent.add(m)
  }

  // ---------------- Marina Bay Sands ----------------
  private buildMbs() {
    this.names.push('Marina Bay Sands')
    // 帧：原点 = 1 号塔质心，局部 x = 三塔连线（1 号 → 3 号，向北偏东），局部 z = 东侧
    const TH = -1.164, UC = 3, H = 194
    const facade = new Geo().setFrame(1523.5, -21.6, TH)
    const solid = new Geo().setFrame(1523.5, -21.6, TH)
    const glow = new Geo().setFrame(1523.5, -21.6, TH)
    const towerS = [0, 119, 227.5]
    // 每塔沿连线方向长约 56 m（OSM 3 号塔足迹 57 m × 35 m），由东西两条板楼"腿"组成
    const sec = (s: number, u0: number, u1: number): V2[] => [[s - 28, UC + u0], [s + 28, UC + u0], [s + 28, UC + u1], [s - 28, UC + u1]]
    for (const s of towerS) {
      // 西腿：直立板楼
      facade.loft([{ pts: sec(s, -16, -1), y: 0 }, { pts: sec(s, -16, -1), y: H }], C.mbsFacade, { top: true })
      // 东腿：底部向东分叉，向内弯，约 80 m 处与西腿合拢
      facade.loft([
        { pts: sec(s, 9, 25), y: 0 }, { pts: sec(s, 5.5, 21.5), y: 40 }, { pts: sec(s, 1, 17.5), y: 80 }, { pts: sec(s, -1, 16), y: H },
      ], C.mbsFacade, { top: true })
    }
    // 空中花园：340 m 船形平台，北端（局部 +x）悬挑约 65 m
    const half: [number, number][] = [[-47, 7], [-38, 16], [-20, 21], [120, 22], [240, 21], [268, 16], [285, 10], [293, 3]]
    const outline = (k: number): V2[] => [
      ...half.map(([s, w]) => [s, UC - w * k] as V2),
      ...half.slice().reverse().map(([s, w]) => [s, UC + w * k] as V2),
    ]
    solid.loft([{ pts: outline(0.72), y: H - 6 }, { pts: outline(0.97), y: H + 2.5 }, { pts: outline(1), y: H + 4 }], C.deckSide, { top: true, bottom: true, roof: C.deck })
    // 夜间灯带：平台边沿外扩一圈
    glow.loft([{ pts: outline(1.015), y: H + 1.2 }, { pts: outline(1.015), y: H + 3.8 }], 0xf4ead0)
    // 无边泳池（西侧，面向城市）与绿化
    solid.box(170, UC - 13, 75, 3.2, H + 4, H + 4.5, C.pool)
    for (let k = 0; k < 14; k++) {
      const s = -25 + k * 21, u = UC + 6 + ((k * 37) % 9)
      solid.box(s, u, 4, 3, H + 4, H + 7 + (k % 3), C.green)
    }
    // 楼顶机房 / 观景台
    solid.box(270, UC + 4, 10, 6, H + 4, H + 8, C.steel)
    // ArtScience Museum 就在 MBS 西北 200 m，并进同一个网格省一个 draw call
    this.buildArtScience(solid)
    this.add(facade.mesh(this.facadeMat, 'lm:mbs:towers'))
    this.add(solid.mesh(this.solidMat, 'lm:mbs:skypark+artscience'))
    this.add(glow.mesh(this.glowWarm, 'lm:mbs:glow'))
  }

  // ---------------- ArtScience Museum（莲花）----------------
  private buildArtScience(g: Geo) {
    this.names.push('ArtScience Museum')
    g.setFrame(1431.2, -427.1, Math.PI * 0.75)
    g.ngon(0, 0, 16, 15, 0, 14, 7, C.white)
    const PET = 10
    for (let i = 0; i < PET; i++) {
      const a = (i / PET) * Math.PI * 2
      const k = 0.5 + 0.5 * Math.cos(a)          // 朝局部 +x 的花瓣更高更长（"手指"）
      const R = 24 + 14 * k, Y = 22 + 34 * k
      const dir: V2 = [Math.cos(a), Math.sin(a)], side: V2 = [-dir[1], dir[0]]
      // 中心线：根部 (r=6, y=6) → 中段 → 尖端；宽度 11 → 9 → 0.6，略向上翘
      const pts = [
        { r: 6, y: 6, w: 5.5 }, { r: R * 0.5, y: Y * 0.38, w: 4.8 }, { r: R * 0.82, y: Y * 0.72, w: 3 }, { r: R, y: Y, w: 0.4 },
      ]
      for (let j = 0; j + 1 < pts.length; j++) {
        const p = pts[j], q = pts[j + 1]
        const L0: V3 = [dir[0] * p.r - side[0] * p.w, p.y, dir[1] * p.r - side[1] * p.w]
        const R0: V3 = [dir[0] * p.r + side[0] * p.w, p.y, dir[1] * p.r + side[1] * p.w]
        const L1: V3 = [dir[0] * q.r - side[0] * q.w, q.y, dir[1] * q.r - side[1] * q.w]
        const R1: V3 = [dir[0] * q.r + side[0] * q.w, q.y, dir[1] * q.r + side[1] * q.w]
        const c = j % 2 ? 0xe9ece9 : C.white
        g.quad(L0, R0, R1, L1, c)       // 上表面
        g.quad(R0, L0, L1, R1, 0xcfd3d2) // 下表面（双面）
      }
    }
    // 中央碗状屋顶
    g.ngon(0, 0, 16, 9, 7, 12, 10, 0xdfe3e2)
  }

  // ---------------- Merlion ----------------
  private buildMerlion() {
    this.names.push('Merlion')
    const X = 890.7, Z = -473.6
    const g = new Geo().setFrame(X, Z, 0)   // 局部 +x = 东（面向滨海湾）
    g.ngon(0, 0, 10, 3.2, 0, 3, 1.4, C.stone)
    // 鱼身：三段渐细、向后弯的柱体 + 卷尾
    g.geom(new THREE.CylinderGeometry(1.35, 1.7, 2.6, 10), C.white, new THREE.Matrix4().makeTranslation(-0.4, 2.7, 0))
    g.geom(new THREE.CylinderGeometry(1.2, 1.35, 1.8, 10), C.white, new THREE.Matrix4().compose(new THREE.Vector3(-0.2, 4.8, 0), new THREE.Quaternion().setFromEuler(new THREE.Euler(0, 0, -0.18)), new THREE.Vector3(1, 1, 1)))
    g.geom(new THREE.TorusGeometry(1.1, 0.45, 6, 10, Math.PI * 1.3), C.white, new THREE.Matrix4().compose(new THREE.Vector3(-1.9, 2.0, 0), new THREE.Quaternion().setFromEuler(new THREE.Euler(0, 0, 1.2)), new THREE.Vector3(1, 1, 1)))
    // 鳞片环（浅灰带）
    g.geom(new THREE.CylinderGeometry(1.42, 1.5, 0.3, 10), 0xd9d7cf, new THREE.Matrix4().makeTranslation(-0.4, 3.3, 0))
    // 狮头 + 鬃毛 + 口鼻
    g.geom(new THREE.IcosahedronGeometry(1.75, 0), 0xe9e6dc, new THREE.Matrix4().compose(new THREE.Vector3(-0.2, 7.0, 0), new THREE.Quaternion(), new THREE.Vector3(1, 1.15, 1.2)))
    g.geom(new THREE.BoxGeometry(2.2, 2.2, 2.2), C.white, new THREE.Matrix4().makeTranslation(0.5, 7.2, 0))
    g.geom(new THREE.BoxGeometry(1.2, 1.0, 1.4), C.white, new THREE.Matrix4().makeTranslation(1.9, 6.8, 0))
    g.geom(new THREE.BoxGeometry(0.6, 0.6, 0.3), C.white, new THREE.Matrix4().makeTranslation(0.6, 8.5, 0.7))
    g.geom(new THREE.BoxGeometry(0.6, 0.6, 0.3), C.white, new THREE.Matrix4().makeTranslation(0.6, 8.5, -0.7))
    g.geom(new THREE.BoxGeometry(0.25, 0.25, 0.25), 0x333333, new THREE.Matrix4().makeTranslation(1.65, 7.6, 0.45))
    g.geom(new THREE.BoxGeometry(0.25, 0.25, 0.25), 0x333333, new THREE.Matrix4().makeTranslation(1.65, 7.6, -0.45))
    this.add(g.mesh(this.solidMat, 'lm:merlion'))
    // 喷水：粒子沿抛物线从口部向东喷出
    const geo = new THREE.BufferGeometry()
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(SPRAY_N * 3), 3))
    this.spray = new THREE.Points(geo, this.sprayMat)
    this.spray.name = 'lm:merlion:spray'
    this.spray.frustumCulled = false
    this.spray.position.set(X + 2.5, 6.6, Z)
    this.group.add(this.spray)
    this.updateSpray(0)
  }

  private updateSpray(dt: number) {
    this.time += dt
    const arr = this.spray.geometry.attributes.position as THREE.BufferAttribute
    const T = 1.25   // 落水时间（s）：y0=6.6, vy=1.8 → t≈1.37
    for (let i = 0; i < SPRAY_N; i++) {
      const t = ((this.time / T + this.sprayPhase[i]) % 1) * T
      const vx = 6.5 + this.sprayJit[i * 2] * 0.8
      arr.setXYZ(i, vx * t, 1.8 * t - 4.9 * t * t, this.sprayJit[i * 2 + 1] * (0.15 + t * 0.5))
    }
    arr.needsUpdate = true
  }

  // ---------------- Esplanade ----------------
  private buildEsplanade() {
    this.names.push('Esplanade')
    const g = new Geo()
    const shells: { cx: number; cz: number; th: number; a: number; b: number; ox: number; oz: number; h: number }[] = [
      { cx: 962.1, cz: -753.2, th: -0.449, ox: 6.05, oz: -5.9, a: 48.2, b: 32.4, h: 33 },
      { cx: 1005.7, cz: -853, th: 1.183, ox: 0.4, oz: -1.4, a: 53.6, b: 31.8, h: 31 },
    ]
    for (const s of shells) {
      g.setFrame(s.cx, s.cz, s.th)
      const W = 36, Hs = 9
      const sph = new THREE.SphereGeometry(1, W, Hs, 0, Math.PI * 2, 0, Math.PI / 2)
      // 带刺壳：交错把顶点外推 / 内收，非索引后逐面法线 → 三角遮阳板的锯齿感
      const p = sph.attributes.position
      for (let iy = 1; iy < Hs; iy++) for (let ix = 0; ix <= W; ix++) {
        const i = iy * (W + 1) + ix
        const k = ((ix % W) + iy) % 2 ? 1.07 : 0.97
        p.setXYZ(i, p.getX(i) * k, p.getY(i) * k, p.getZ(i) * k)
      }
      const flat = sph.toNonIndexed()
      sph.dispose()
      flat.computeVertexNormals()
      const local = new THREE.Matrix4().compose(new THREE.Vector3(s.ox, 0, s.oz), new THREE.Quaternion(), new THREE.Vector3(s.a, s.h, s.b))
      g.geom(flat, (t) => (t % 3 === 0 ? C.shellDark : t % 3 === 1 ? C.shell : 0xc7bd9f), local)
    }
    this.add(g.mesh(this.solidMat, 'lm:esplanade'))
  }

  // ---------------- Singapore Flyer ----------------
  private buildFlyer() {
    this.names.push('Singapore Flyer')
    const CX = 1850.3, CZ = -764.1, TH = -0.663, HUB = 90, R = 75, NCAP = 28
    // 静态：航站楼（低矮环形）+ 两侧 A 字支架（轮平面帧：局部 x = 轮面水平方向，局部 z = 轮轴）
    const st = new Geo().setFrame(1859.7, -762.7, 0)
    const outer = poly(0, 0, 28, 50), inner = poly(0, 0, 28, 30)
    const tc = st
    tc.loft([{ pts: outer, y: 0 }, { pts: outer, y: 10 }], C.glass)
    tc.loft([{ pts: inner, y: 0 }, { pts: inner, y: 10 }], C.glass, { inward: true })
    {
      const o = orient(outer, true), n = o.length
      const inn = o.map((p) => [p[0] * 0.6, p[1] * 0.6] as V2)
      for (let k = 0; k < n; k++) {
        const a = o[k], b = o[(k + 1) % n], c = inn[(k + 1) % n], d = inn[k]
        tc.quad([a[0], 10, a[1]], [d[0], 10, d[1]], [c[0], 10, c[1]], [b[0], 10, b[1]], 0xd4d9de)
      }
    }
    st.setFrame(CX, CZ, TH)
    for (const zs of [-1, 1]) {
      const z0 = zs * 9, z1 = zs * 4.5
      st.beam([-30, 0, z0], [0, HUB, z1], 1.3, C.steel, 8)
      st.beam([30, 0, z0], [0, HUB, z1], 1.3, C.steel, 8)
      st.beam([-15, HUB / 2, (z0 + z1) / 2], [15, HUB / 2, (z0 + z1) / 2], 0.6, C.steel)
    }
    st.geom(new THREE.CylinderGeometry(3.2, 3.2, 12, 12), C.darkSteel, new THREE.Matrix4().compose(new THREE.Vector3(0, HUB, 0), new THREE.Quaternion().setFromEuler(new THREE.Euler(Math.PI / 2, 0, 0)), new THREE.Vector3(1, 1, 1)))
    this.add(st.mesh(this.solidMat, 'lm:flyer:static'))
    // 旋转轮：局部 xy 为轮面，绕局部 z 旋转
    const frame = new THREE.Group()
    frame.position.set(CX, HUB, CZ)
    frame.rotation.y = -TH
    frame.name = 'lm:flyer'
    this.group.add(frame)
    frame.add(this.wheel)
    const spokes = new Geo(), rim = new Geo()
    rim.geom(new THREE.TorusGeometry(R, 1.1, 6, 96), 0xe8eef4)
    spokes.geom(new THREE.TorusGeometry(R - 4, 0.55, 4, 96), C.steel)
    for (let k = 0; k < NCAP; k++) {
      const a = (k / NCAP) * Math.PI * 2, c = Math.cos(a), s = Math.sin(a)
      for (const z of [-2.5, 2.5]) spokes.beam([c * 3, s * 3, z], [c * (R - 4), s * (R - 4), z * 0.3], 0.22, 0xb9c2ca, 4)
      // 轮圈之间的三角桁架
      spokes.beam([c * (R - 4), s * (R - 4), 0], [c * R, s * R, 0], 0.3, C.steel, 4)
    }
    this.add(rim.mesh(this.glowCool, 'lm:flyer:rim'), this.wheel)
    this.add(spokes.mesh(this.solidMat, 'lm:flyer:spokes'), this.wheel)
    // 28 个座舱：不随轮子自转（始终水平），每帧重写实例矩阵
    const cap = new THREE.CapsuleGeometry(1.9, 4.6, 3, 10).rotateX(Math.PI / 2)
    this.capsules = new THREE.InstancedMesh(cap, this.capsuleMat, NCAP)
    this.capsules.name = 'lm:flyer:capsules'
    this.capsules.frustumCulled = false
    this.capsules.castShadow = true
    frame.add(this.capsules)
    this.updateWheel(0)
  }

  private updateWheel(dt: number) {
    this.wheelAngle += dt * ((Math.PI * 2) / 600)   // 10 分钟一圈（真实 30 分钟，放快一些便于看出在转）
    this.wheel.rotation.z = this.wheelAngle
    const n = this.capsules.count, R = 79.5
    const m = new THREE.Matrix4()
    for (let k = 0; k < n; k++) {
      const a = this.wheelAngle + (k / n) * Math.PI * 2
      m.makeTranslation(Math.cos(a) * R, Math.sin(a) * R, 0)
      this.capsules.setMatrixAt(k, m)
    }
    this.capsules.instanceMatrix.needsUpdate = true
  }

  // ---------------- Gardens by the Bay Supertrees ----------------
  private buildSupertrees() {
    this.names.push('Gardens by the Bay Supertrees')
    // OSM 圆柱足迹的质心与高度（data/geo/build/buildings.json）；17 m 那棵按最低 25 m 处理
    const TREES: [number, number, number][] = [
      [1917.4, 100.9, 40], [1965.6, 19.5, 36], [1940.2, 61.8, 46], [1961.7, 93.1, 30], [1909.7, 132.1, 36],
      [1993.6, 82.7, 25], [2000.6, 34, 30], [1929.8, 7.4, 33], [1901.7, 22.3, 33], [1888, 55.3, 33],
    ]
    const trunk = new Geo(), crown = new Geo()
    for (const [x, z, h] of TREES) {
      trunk.setFrame(x, z, 0); crown.setFrame(x, z, 0)
      const ht = h * 0.8, rTop = 1.6 + h * 0.05, rBot = 1.2 + h * 0.015
      trunk.geom(new THREE.CylinderGeometry(rTop, rBot, ht, 10, 1, true), (t) => ((t >> 1) % 2 ? C.vine : C.trunk), new THREE.Matrix4().makeTranslation(0, ht / 2, 0))
      trunk.ngon(0, 0, 10, rBot + 1.2, 0, rBot + 0.8, 1.2, C.stone)
      // 伞形冠：外扩的开口锥面（双面材质）+ 顶部圆盘
      const ch = h - ht, rc = h * 0.3 + 3
      crown.geom(new THREE.CylinderGeometry(rc, rTop, ch, 16, 1, true), (t) => ((t >> 1) % 2 ? C.canopy : 0xbf98d0), new THREE.Matrix4().makeTranslation(0, ht + ch / 2, 0))
      crown.geom(new THREE.CircleGeometry(rc * 0.98, 16).rotateX(-Math.PI / 2), 0x8a6a98, new THREE.Matrix4().makeTranslation(0, h - 0.6, 0))
    }
    this.add(trunk.mesh(this.solidMat, 'lm:supertrees:trunks'))
    this.add(crown.mesh(this.glowPurple, 'lm:supertrees:crowns'))
  }

  // ---------------- Lau Pa Sat ----------------
  private buildLauPaSat() {
    this.names.push('Lau Pa Sat')
    const g = new Geo().setFrame(444.7, 201.1, 0.174)
    const rot = Math.PI / 8
    // 中心取 OSM 12 边形足迹的顶点平均（外接约 34 m）
    const O: [number, number] = [0, 0]
    // 八角铸铁亭：外廊墙 → 一层坡屋顶 → 高侧窗鼓座 → 二层坡屋顶 → 中央钟楼
    g.ngon(O[0], O[1], 8, 32, 0, 32, 5.5, C.cream, rot, {})
    g.ngon(O[0], O[1], 8, 34.5, 5.5, 23, 9, C.roofGrey, rot)
    g.ngon(O[0], O[1], 8, 23, 9, 23, 11.5, 0xf0e8d4, rot, {})
    g.ngon(O[0], O[1], 8, 24.5, 11.5, 10, 14.5, C.roofGrey, rot)
    g.ngon(O[0], O[1], 8, 10, 14.5, 10, 16, 0xf0e8d4, rot)
    // 外廊铸铁柱（深绿灰）
    for (let k = 0; k < 16; k++) {
      const a = rot + (k / 16) * Math.PI * 2
      g.box(O[0] + Math.cos(a) * 32.6, O[1] + Math.sin(a) * 32.6, 0.5, 0.5, 0, 5.6, 0x4f5d58)
    }
    // 钟楼
    g.box(O[0], O[1], 3.6, 3.6, 16, 28, 0xf3ecdc, 0x7d8a8c)
    for (const [dx, dz, hx, hz] of [[3.7, 0, 0.15, 1.5], [-3.7, 0, 0.15, 1.5], [0, 3.7, 1.5, 0.15], [0, -3.7, 1.5, 0.15]] as const)
      g.box(O[0] + dx, O[1] + dz, hx, hz, 24.5, 27.5, 0xffffff)
    g.frustum(O[0], O[1], 4.2, 4.2, 28, 0.3, 0.3, 35, 0x5d6866)
    g.box(O[0], O[1], 0.12, 0.12, 35, 37.5, 0x3a3f3e)
    this.add(g.mesh(this.solidMat, 'lm:laupasat'))
  }

  // ---------------- Buddha Tooth Relic Temple ----------------
  private buildBuddhaTooth() {
    this.names.push('Buddha Tooth Relic Temple')
    const g = new Geo().setFrame(-242.3, 117.1, 0.492)
    const ox = -10.95, oz = 0.35
    // 唐风：灰石台基 → 三层红墙 + 深红瓦重檐（檐口外挑、上翘感用薄檐板），顶部庑殿 + 金色正脊
    g.box(ox, oz, 39, 16, 0, 1.5, C.stone)
    const tiers: [number, number, number, number][] = [ // hx, hz, y0, y1（墙身）
      [36, 13.5, 1.5, 9], [29, 10.5, 12, 17.5], [22, 8, 20.5, 25],
    ]
    for (let i = 0; i < tiers.length; i++) {
      const [hx, hz, y0, y1] = tiers[i]
      g.box(ox, oz, hx, hz, y0, y1, C.red)
      // 檐下金色额枋
      g.box(ox, oz, hx + 0.3, hz + 0.3, y1 - 1, y1, C.gold)
      if (i < tiers.length - 1) {
        // 腰檐：薄檐板（外挑 4 m）+ 坡面
        g.frustum(ox, oz, hx + 4.5, hz + 4.5, y1, hx + 4.2, hz + 4.2, y1 + 0.5, C.roofRed, { top: false, bottom: true })
        g.frustum(ox, oz, hx + 4.2, hz + 4.2, y1 + 0.5, tiers[i + 1][0] + 0.5, tiers[i + 1][1] + 0.5, tiers[i + 1][2], C.roofRed)
      }
    }
    // 顶层庑殿顶
    const [hx, hz, , y1] = tiers[2]
    g.frustum(ox, oz, hx + 5, hz + 5, y1, hx + 4.6, hz + 4.6, y1 + 0.6, C.roofRed, { top: false, bottom: true })
    g.frustum(ox, oz, hx + 4.6, hz + 4.6, y1 + 0.6, hx - 6, 0.6, y1 + 7, C.roofRed)
    g.box(ox, oz, hx - 5.5, 0.5, y1 + 7, y1 + 7.8, C.gold)
    // 正门门楼（面向南桥路一侧的长边中央）
    g.box(ox, oz - 15, 6, 2.5, 1.5, 7, C.red)
    g.frustum(ox, oz - 15, 8, 4, 7, 5, 0.5, 10, C.roofRed)
    this.add(g.mesh(this.solidMat, 'lm:buddhatooth'))
  }

  // ---------------- Sri Mariamman Temple ----------------
  private buildMariamman() {
    this.names.push('Sri Mariamman Temple')
    const g = new Geo().setFrame(-156.4, -20.6, 0.124)
    const ox = 11.9, oz = -1.9
    // 院墙 + 主殿（米白），院墙顶的牛像以小白块示意
    g.box(ox - 2, oz, 21.5, 11.3, 0, 4.5, C.cream, 0xd8cbb0)
    for (let k = 0; k < 10; k++) g.box(ox - 20 + k * 4.2, oz + 11.1, 0.5, 0.3, 4.5, 5.4, 0xffffff)
    g.box(ox - 6, oz, 9, 6, 4.5, 8, 0xf0e2c4)
    // 主殿上方的小型 vimana（阶梯塔）
    for (let k = 0; k < 4; k++) g.frustum(ox - 6, oz, 3.4 - k * 0.7, 3.4 - k * 0.7, 8 + k * 1.6, 3.1 - k * 0.7, 3.1 - k * 0.7, 9.6 + k * 1.6, GOPURAM_BANDS[k])
    g.geom(new THREE.SphereGeometry(1, 8, 4, 0, Math.PI * 2, 0, Math.PI / 2), C.gold, new THREE.Matrix4().compose(new THREE.Vector3(ox - 6, 14.4, oz), new THREE.Quaternion(), new THREE.Vector3(1.2, 1.4, 1.2)))
    // 塔门 gopuram：位于临南桥路（局部 +x）端，6 层彩色阶梯 + 桶形顶 + 金色尖顶饰
    const gx = ox + 19.5
    g.box(gx, oz, 4, 9, 0, 6, 0xf2e6c8, 0xe8c040)
    g.box(gx + 4.05, oz, 0.1, 2, 0, 4.2, 0x3b2a1e)   // 门洞
    let hx = 3.6, hz = 8.2, y = 6
    for (let k = 0; k < 6; k++) {
      const c = GOPURAM_BANDS[k % GOPURAM_BANDS.length]
      g.frustum(gx, oz, hx + 0.35, hz + 0.35, y, hx + 0.35, hz + 0.35, y + 0.35, 0xf4efe0, { top: true, bottom: true })   // 檐线
      g.frustum(gx, oz, hx, hz, y + 0.35, hx - 0.3, hz - 0.85, y + 1.6, c, { top: false })
      // 每层的小神龛凸起（交错色块）
      for (let j = -2; j <= 2; j++) g.box(gx + hx - 0.1, oz + j * (hz / 3), 0.35, 0.6, y + 0.5, y + 1.4, GOPURAM_BANDS[(k + j + 6) % 6])
      hx -= 0.3; hz -= 0.85; y += 1.6
    }
    g.geom(new THREE.CylinderGeometry(1.7, 1.7, 2 * hz + 0.6, 10, 1, false, 0, Math.PI), 0xe8a040, new THREE.Matrix4().compose(new THREE.Vector3(gx, y, oz), new THREE.Quaternion().setFromEuler(new THREE.Euler(Math.PI / 2, Math.PI / 2, 0)), new THREE.Vector3(1, 1, 1)))
    for (let j = -2; j <= 2; j++) g.geom(new THREE.ConeGeometry(0.28, 1.4, 6), C.gold, new THREE.Matrix4().makeTranslation(gx, y + 2.2, oz + j * (hz / 2.5)))
    this.add(g.mesh(this.solidMat, 'lm:mariamman'))
  }

  // ---------------- Pinnacle@Duxton ----------------
  private buildPinnacle() {
    this.names.push('Pinnacle@Duxton')
    // 7 栋 50 层（156 m）塔楼：5 栋取 OSM 无名塔楼足迹，西侧两栋按整体外轮廓西翼补齐；26 / 50 层两道环形空中连桥
    const T: { x: number; z: number; th: number; ha: number; hb: number }[] = [
      { x: -617.4, z: 516.3, th: -0.543, ha: 19.6, hb: 12.3 },
      { x: -567.2, z: 520.6, th: 0.715, ha: 19.9, hb: 12.3 },
      { x: -537.9, z: 559.6, th: 1.107, ha: 20.9, hb: 12 },
      { x: -556.9, z: 617.1, th: -0.449, ha: 20.2, hb: 10.9 },
      { x: -594.2, z: 651.6, th: -1.094, ha: 19.9, hb: 11 },
      { x: -618, z: 616, th: 1.39, ha: 19, hb: 11 },
      { x: -629, z: 566, th: 1.39, ha: 19, hb: 11 },
    ]
    const H = 156
    const fac = new Geo(), sol = new Geo()
    for (const t of T) {
      fac.setFrame(t.x, t.z, t.th)
      fac.box(0, 0, t.ha, t.hb, 0, H, C.pinnacle, 0xa9a59c)
      sol.setFrame(t.x, t.z, t.th)
      sol.box(0, 0, t.ha * 0.4, t.hb * 0.5, H, H + 4, C.steel)
    }
    sol.setFrame(0, 0, 0)
    for (let i = 0; i < T.length; i++) {
      const a = T[i], b = T[(i + 1) % T.length]
      const dx = b.x - a.x, dz = b.z - a.z, len = Math.hypot(dx, dz), th = Math.atan2(dz, dx)
      sol.setFrame((a.x + b.x) / 2, (a.z + b.z) / 2, th)
      for (const y of [78, 150]) {
        sol.box(0, 0, len / 2, 4.5, y, y + 3, C.bridge)
        sol.box(0, -4.3, len / 2, 0.2, y + 3, y + 4.2, 0x6f8a5a)   // 空中花园栏杆绿化
        sol.box(0, 4.3, len / 2, 0.2, y + 3, y + 4.2, 0x6f8a5a)
      }
    }
    this.add(fac.mesh(this.facadeMat, 'lm:pinnacle:towers'))
    this.add(sol.mesh(this.solidMat, 'lm:pinnacle:bridges'))
  }

  // ---------------- 滨海湾 / 新加坡河水面 ----------------
  private buildWater(water: { ring: number[] }[]) {
    const pos: number[] = [], nrm: number[] = []
    for (const w of water) {
      const r = w.ring
      if (r.length < 6) continue
      let cx = 0, cz = 0
      for (let k = 0; k < r.length; k += 2) { cx += r[k]; cz += r[k + 1] }
      cx /= r.length / 2; cz /= r.length / 2
      // 只取滨海湾（东）与新加坡河（北半、x > −1500）；南侧与西端零散水塘不铺
      if (cz > 400 || cx < -1500) continue
      const contour: THREE.Vector2[] = []
      for (let k = 0; k < r.length; k += 2) contour.push(new THREE.Vector2(r[k], r[k + 1]))
      let faces: number[][]
      try { faces = THREE.ShapeUtils.triangulateShape(contour, []) } catch { continue }
      for (const f of faces) {
        const a = contour[f[0]], b = contour[f[1]], c = contour[f[2]]
        const ny = (b.y - a.y) * (c.x - a.x) - (b.x - a.x) * (c.y - a.y)
        const tri = ny < 0 ? [a, c, b] : [a, b, c]
        for (const p of tri) { pos.push(p.x, WATER_Y, p.y); nrm.push(0, 1, 0) }
      }
    }
    if (!pos.length) return
    const g = new THREE.BufferGeometry()
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3))
    g.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3))
    g.computeBoundingSphere()
    const m = new THREE.Mesh(g, this.waterMat)
    m.name = 'lm:water'
    m.userData.castShadow = false
    m.renderOrder = -1
    this.group.add(m)
  }

  attach(scene: THREE.Scene) {
    scene.add(this.group)
    const windows = (scene.userData.windows as THREE.Material[] | undefined) ?? []
    windows.push(this.facadeMat, this.glowWarm, this.glowCool, this.glowPurple, this.capsuleMat)
    scene.userData.windows = windows
  }

  update(dt: number) {
    this.updateWheel(dt)
    this.updateSpray(dt)
  }

  get stats(): LandmarkStats {
    let meshes = 0, triangles = 0
    this.group.traverse((o) => {
      const m = o as THREE.Mesh
      if (!m.isMesh && !(o as THREE.Points).isPoints) return
      meshes++
      const g = m.geometry
      const n = g.index ? g.index.count : g.attributes.position.count
      triangles += (o as THREE.Points).isPoints ? 0 : (n / 3) * ((m as THREE.InstancedMesh).isInstancedMesh ? (m as THREE.InstancedMesh).count : 1)
    })
    return { meshes, triangles: Math.round(triangles), names: [...this.names] }
  }

  dispose() {
    this.group.traverse((o) => { const m = o as THREE.Mesh; if (m.geometry) m.geometry.dispose() })
    for (const m of [this.solidMat, this.facadeMat, this.glowWarm, this.glowCool, this.glowPurple, this.capsuleMat, this.waterMat, this.sprayMat]) m.dispose()
    this.group.removeFromParent()
  }
}

