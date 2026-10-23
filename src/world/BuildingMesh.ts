import * as THREE from 'three'
import { rand, pick } from '../config'
import type { BuildingCls, ChunkBuilding } from './ChunkFormat'

/**
 * 烘焙建筑足迹 → 挤出几何：侧面四边形（含孔洞内壁）+ 顶面（ShapeUtils 三角化），
 * 侧面 UV 按周长/高度展开配合窗格贴图（fx=off 的 Lambert 路径），顶面 UV 固定在无窗角落；顶点色按建筑类别 + id 确定；
 * 另写 aWall / aBld 属性供程序化外墙（FacadeShader，fx=high/low）使用。
 * 环的朝向约定见 ChunkFormat：外环俯视逆时针（鞋带 < 0），孔顺时针；这里会强制纠正。
 */

/** 贴图每边窗格数（与 CityGenerator 相同：每格 3.2 m） */
export const PANES = 4
const PANE_M = 3.2

/** 类别基础色（与 skyline / minimap 一致）：generic / hdb / shophouse / glass / landmark */
export const CLS_COLORS: readonly number[] = [0x9d9d98, 0xc9b8a0, 0xc78f6d, 0x7f94b8, 0xe0c060]
/** 各类别外墙调色板：普通楼偏中性；HDB 白/米/浅粉/浅绿；店屋粉彩（着色器里每开间再换色）；玻璃塔为玻璃色调 */
const PALETTES: readonly (readonly number[])[] = [
  [0xb9b6ae, 0xa8a8a3, 0xcac3b5, 0x9ea5aa, 0xd3d0c7, 0xb4a995, 0xc2b8a8, 0x8f9496],
  [0xece6d8, 0xe6d9c3, 0xeed8d0, 0xdfe5d6, 0xf2eee6, 0xdccdb6, 0xe8dcc8],
  [0xd98f6a, 0xe6b86a, 0x8fb8a8, 0xe3a3a0, 0xa9c7d8, 0xf0dca0, 0xc9a0c9],
  [0x7f9bb3, 0x6f8f98, 0x8e9caa, 0x5f7f90, 0x86a0a0, 0x9aa6b4],
  [0xd8d4ca, 0xc8ccd2, 0xe0d8c4],
]

/** 整数哈希 → [0,1)（建筑 id 等确定性随机） */
export function hash01(n: number, salt = 0): number {
  let h = (Math.imul(n | 0, 0x27d4eb2d) ^ Math.imul(salt + 0x165667b1, 0x9e3779b1)) | 0
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b)
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35)
  h ^= h >>> 16
  return (h >>> 0) / 4294967296
}

/** 外墙颜色：给 id 时按建筑 id 确定（同一栋每次加载一样），否则随机（带轻微明度扰动） */
export function buildingColor(cls: BuildingCls, out = new THREE.Color(), id?: number): THREE.Color {
  const pal = PALETTES[cls] ?? PALETTES[0]
  if (id === undefined) return out.setHex(pick(pal as number[])).offsetHSL(rand(-0.01, 0.01), rand(-0.03, 0.03), rand(-0.05, 0.05))
  const base = pal[Math.floor(hash01(id, 1) * pal.length)]
  return out.setHex(base).offsetHSL((hash01(id, 2) - 0.5) * 0.02, (hash01(id, 3) - 0.5) * 0.06, (hash01(id, 4) - 0.5) * 0.1)
}

/** 鞋带公式有向面积 ×2（(x,z) 平面） */
export function shoelace(r: ArrayLike<number>): number {
  const n = r.length >> 1
  let a = 0
  for (let k = 0; k < n; k++) {
    const x0 = r[k * 2], z0 = r[k * 2 + 1], x1 = r[((k + 1) % n) * 2], z1 = r[((k + 1) % n) * 2 + 1]
    a += x0 * z1 - x1 * z0
  }
  return a
}

/** 返回朝向满足要求的环（鞋带符号 wantNegative 为 true 时要求 < 0），必要时拷贝反转 */
export function oriented(r: Float32Array, wantNegative: boolean): Float32Array {
  const s = shoelace(r)
  if ((s < 0) === wantNegative || s === 0) return r
  const n = r.length >> 1
  const out = new Float32Array(r.length)
  for (let k = 0; k < n; k++) { out[k * 2] = r[(n - 1 - k) * 2]; out[k * 2 + 1] = r[(n - 1 - k) * 2 + 1] }
  return out
}

/** 累加缓冲：先用 JS 数组收集，最后一次转 TypedArray */
export class GeomSink {
  pos: number[] = []
  nrm: number[] = []
  uv: number[] = []
  col: number[] = []
  /** 程序化外墙属性（FacadeShader）：aWall = (s, 立面宽, 立面随机, 闭合)，aBld = (种子, cls, 楼高, 色调) */
  wall: number[] = []
  bld: number[] = []
  idx: number[] = []
  get vertexCount() { return this.pos.length / 3 }
  toGeometry(): THREE.BufferGeometry {
    const g = new THREE.BufferGeometry()
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3))
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.nrm, 3))
    g.setAttribute('uv', new THREE.Float32BufferAttribute(this.uv, 2))
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.col, 3))
    if (this.wall.length === this.pos.length / 3 * 4) {
      g.setAttribute('aWall', new THREE.Float32BufferAttribute(this.wall, 4))
      g.setAttribute('aBld', new THREE.Float32BufferAttribute(this.bld, 4))
    }
    g.setIndex(this.idx)
    g.computeBoundingSphere()
    return g
  }
}

const tmpColor = new THREE.Color()
const roofColor = new THREE.Color()

/** 把一栋建筑的侧面与顶面写入 sink；返回写入的三角数 */
export function appendBuilding(sink: GeomSink, b: ChunkBuilding, color: THREE.Color): number {
  const h = Math.max(2.5, b.h)
  const outer = oriented(b.ring, true)
  const holes = b.holes.filter((r) => r.length >= 6).map((r) => oriented(r, false))
  const rings = [outer, ...holes]
  let tris = 0
  roofColor.copy(color).multiplyScalar(0.72)
  const { pos, nrm, uv, col, wall, bld, idx } = sink
  const seed = hash01(b.id, 11), tone = hash01(b.id, 12)
  // 侧面：每条边 4 顶点 2 三角；法线取 (p1−p0)×(p1top−p0)，与绕向一致必然朝外
  // 立面分段：相邻边转角 < 30° 的连成一段（曲线楼的短边合成一整面，窗格沿整面连续排布），s 从段起点量
  let runNo = 0
  for (const ring of rings) {
    const n = ring.length >> 1
    const len: number[] = [], ux: number[] = [], uz: number[] = []
    for (let k = 0; k < n; k++) {
      const dx = ring[((k + 1) % n) * 2] - ring[k * 2], dz = ring[((k + 1) % n) * 2 + 1] - ring[k * 2 + 1]
      const l = Math.hypot(dx, dz)
      len.push(l); ux.push(l > 0 ? dx / l : 0); uz.push(l > 0 ? dz / l : 0)
    }
    const valid = [...Array(n).keys()].filter((k) => len[k] >= 1e-3)
    if (!valid.length) continue
    // corner[i]：valid[i] 的起点是锐角（与前一条有效边夹角 ≥ 30°）
    const m = valid.length
    const corner = valid.map((k, i) => { const p = valid[(i - 1 + m) % m]; return ux[p] * ux[k] + uz[p] * uz[k] < 0.866 })
    const closed = !corner.some(Boolean)
    const start = closed ? 0 : corner.indexOf(true)
    // 先求每段总宽
    const runOf: number[] = new Array(m), runW: number[] = []
    for (let j = 0; j < m; j++) {
      const i = (start + j) % m
      if (j === 0 || corner[i]) runW.push(0)
      runOf[i] = runW.length - 1
      runW[runW.length - 1] += len[valid[i]]
    }
    let cum = 0, lastRun = -1
    for (let j = 0; j < m; j++) {
      const i = (start + j) % m, k = valid[i]
      if (runOf[i] !== lastRun) { cum = 0; lastRun = runOf[i] }
      const x0 = ring[k * 2], z0 = ring[k * 2 + 1]
      const x1 = ring[((k + 1) % n) * 2], z1 = ring[((k + 1) % n) * 2 + 1]
      const l = len[k]
      // (dx,0,dz)×(0,h,0) = (-h·dz, 0, h·dx) → 归一化 (-dz, 0, dx)
      const nx = -uz[k], nz = ux[k]
      const base = pos.length / 3
      const u0 = cum / (PANE_M * PANES), u1 = (cum + l) / (PANE_M * PANES), v1 = h / (PANE_M * PANES)
      pos.push(x0, 0, z0, x1, 0, z1, x1, h, z1, x0, h, z0)
      const W = runW[runOf[i]], rs = hash01(b.id * 31 + runNo + runOf[i], 13)
      for (let q = 0; q < 4; q++) { nrm.push(nx, 0, nz); col.push(color.r, color.g, color.b); bld.push(seed, b.cls, h, tone) }
      const s1 = cum + l
      wall.push(cum, W, rs, closed ? 1 : 0, s1, W, rs, closed ? 1 : 0, s1, W, rs, closed ? 1 : 0, cum, W, rs, closed ? 1 : 0)
      uv.push(u0, 0, u1, 0, u1, v1, u0, v1)
      idx.push(base, base + 1, base + 2, base, base + 2, base + 3)
      tris += 2
      cum += l
    }
    runNo += runW.length
  }
  // 顶面：ShapeUtils 三角化（含孔），按 y 分量校正绕向使法线朝上
  const contour: THREE.Vector2[] = []
  for (let k = 0; k < outer.length; k += 2) contour.push(new THREE.Vector2(outer[k], outer[k + 1]))
  const holeV: THREE.Vector2[][] = holes.map((r) => {
    const v: THREE.Vector2[] = []
    for (let k = 0; k < r.length; k += 2) v.push(new THREE.Vector2(r[k], r[k + 1]))
    return v
  })
  let faces: number[][]
  try { faces = THREE.ShapeUtils.triangulateShape(contour, holeV) } catch { faces = [] }
  const flat = contour.concat(...holeV)
  const base = pos.length / 3
  for (const p of flat) {
    pos.push(p.x, h, p.y)
    nrm.push(0, 1, 0)
    uv.push(0.03, 0.03)
    col.push(roofColor.r, roofColor.g, roofColor.b)
    wall.push(0, 0, 0, 0)
    bld.push(seed, b.cls, h, tone)
  }
  for (const f of faces) {
    const a = flat[f[0]], bb = flat[f[1]], c = flat[f[2]]
    const ny = (bb.y - a.y) * (c.x - a.x) - (bb.x - a.x) * (c.y - a.y)
    if (ny < 0) idx.push(base + f[0], base + f[2], base + f[1])
    else idx.push(base + f[0], base + f[1], base + f[2])
    tris++
  }
  return tris
}

/** 便捷：单栋建筑独立几何（测试/查看用） */
export function buildingGeometry(b: ChunkBuilding): THREE.BufferGeometry {
  const sink = new GeomSink()
  appendBuilding(sink, b, buildingColor(b.cls, tmpColor, b.id))
  return sink.toGeometry()
}

/**
 * 窗格贴图（与 CityGenerator.makeWindowTexture 同款）：漫反射每格相同，
 * 自发光图随机点亮约 55% 的窗格；夜间由 DayNight 驱动 emissiveIntensity。
 */
export function makeWindowTexture(): { map: THREE.Texture; emissive: THREE.Texture } {
  const size = 64 * PANES
  const mk = () => { const c = document.createElement('canvas'); c.width = c.height = size; return c }
  const diff = mk(), glow = mk()
  const d = diff.getContext('2d')!, g = glow.getContext('2d')!
  d.fillStyle = '#ffffff'; d.fillRect(0, 0, size, size)
  g.fillStyle = '#000000'; g.fillRect(0, 0, size, size)
  for (let j = 0; j < PANES; j++) for (let i = 0; i < PANES; i++) {
    const ox = i * 64, oy = j * 64
    d.fillStyle = '#3a4a66'; d.fillRect(ox + 16, oy + 14, 32, 36)
    d.fillStyle = '#7f94b8'; d.fillRect(ox + 18, oy + 16, 12, 14)
    if (Math.random() < 0.55) {
      const v = Math.floor(rand(150, 255))
      g.fillStyle = `rgb(${v},${Math.floor(v * 0.86)},${Math.floor(v * 0.6)})`; g.fillRect(ox + 16, oy + 14, 32, 36)
    }
  }
  const tex = (c: HTMLCanvasElement) => {
    const t = new THREE.CanvasTexture(c)
    t.wrapS = t.wrapT = THREE.RepeatWrapping
    t.magFilter = THREE.NearestFilter
    t.colorSpace = THREE.SRGBColorSpace
    return t
  }
  return { map: tex(diff), emissive: tex(glow) }
}

/** 外墙材质：顶点色 × 窗格贴图，自发光图夜间点亮（推进 scene.userData.windows） */
export function makeWallMaterial(): THREE.MeshLambertMaterial {
  const { map, emissive } = makeWindowTexture()
  return new THREE.MeshLambertMaterial({ map, vertexColors: true, emissive: 0xffd27a, emissiveMap: emissive, emissiveIntensity: 0 })
}
