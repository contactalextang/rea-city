/**
 * Phase AIR 全城高楼高度图（AIR.4）：把天际线（h>40 m 的楼，SgWorld.buildSkyline）与地标（Landmarks）的三角面
 * 栅格化成 8 m 格的最大高度图（Uint16，单位 0.1 m），给飞机做块外高楼兜底碰撞、离地高度与「PULL UP」告警。
 * 纯数据模块（不依赖 three 运行时）：网格以鸭子类型传入（geometry.getAttribute('position') / index / matrixWorld.elements）。
 *
 * 栅格化规则（保守，宁高勿低）：
 * - 法线 |ny| > 0.5 的三角（屋顶 / 斜面）：在 xz 投影上按 ≤ 半格间距撒点覆盖到的格子，高度取三角最高点；
 * - 其余（立面墙）：沿三条边按半格步长描线，高度取三角最高点（墙在 xz 上退化成线段）。
 * - 最高点 < 3 m 的三角（地面、水面）跳过。
 */

export interface HeightBounds { minX: number; maxX: number; minZ: number; maxZ: number }

/** 鸭子类型的网格（THREE.Mesh 满足） */
export interface MeshLike {
  geometry: {
    getAttribute(name: string): { count: number; getX(i: number): number; getY(i: number): number; getZ(i: number): number } | undefined
    index: { count: number; getX(i: number): number } | null
  }
  matrixWorld: { elements: ArrayLike<number> }
}

const UNIT = 10   // 存储单位：0.1 m
const MIN_H = 3

export class HeightField {
  readonly cell: number
  readonly minX: number
  readonly minZ: number
  readonly cols: number
  readonly rows: number
  readonly data: Uint16Array
  /** 栅格化的三角数（统计用） */
  tris = 0

  constructor(b: HeightBounds, cell = 8) {
    this.cell = cell
    this.minX = b.minX; this.minZ = b.minZ
    this.cols = Math.max(1, Math.ceil((b.maxX - b.minX) / cell))
    this.rows = Math.max(1, Math.ceil((b.maxZ - b.minZ) / cell))
    this.data = new Uint16Array(this.cols * this.rows)
  }

  /** (x, z) 所在格的最高高度（m）；范围外 0 */
  sample(x: number, z: number): number {
    const i = Math.floor((x - this.minX) / this.cell), j = Math.floor((z - this.minZ) / this.cell)
    if (i < 0 || j < 0 || i >= this.cols || j >= this.rows) return 0
    return this.data[j * this.cols + i] / UNIT
  }

  /** 以 (x, z) 为中心、半径 r 内各格的最高高度（m） */
  sampleMax(x: number, z: number, r: number): number {
    const c = this.cell
    const i0 = Math.max(0, Math.floor((x - r - this.minX) / c)), i1 = Math.min(this.cols - 1, Math.floor((x + r - this.minX) / c))
    const j0 = Math.max(0, Math.floor((z - r - this.minZ) / c)), j1 = Math.min(this.rows - 1, Math.floor((z + r - this.minZ) / c))
    let m = 0
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) { const v = this.data[j * this.cols + i]; if (v > m) m = v }
    return m / UNIT
  }

  private put(i: number, j: number, h: number) {
    if (i < 0 || j < 0 || i >= this.cols || j >= this.rows) return
    const k = j * this.cols + i
    if (h > this.data[k]) this.data[k] = h
  }
  private putXZ(x: number, z: number, h: number) {
    this.put(Math.floor((x - this.minX) / this.cell), Math.floor((z - this.minZ) / this.cell), h)
  }

  /** 栅格化一个世界坐标三角 */
  addTriangle(ax: number, ay: number, az: number, bx: number, by: number, bz: number, cx: number, cy: number, cz: number) {
    const top = Math.max(ay, by, cy)
    if (top < MIN_H) return
    const h = Math.min(65535, Math.round(top * UNIT))
    this.tris++
    // 法线
    const ux = bx - ax, uy = by - ay, uz = bz - az, vx = cx - ax, vy = cy - ay, vz = cz - az
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx
    const nl = Math.hypot(nx, ny, nz)
    if (nl < 1e-9) return
    this.putXZ(ax, az, h); this.putXZ(bx, bz, h); this.putXZ(cx, cz, h)
    if (Math.abs(ny) / nl > 0.5) {
      // 面：在三角上按 ≤ 半格间距均匀撒点（重心坐标网格），细长屋顶也不会漏格
      const L = Math.max(Math.hypot(bx - ax, bz - az), Math.hypot(cx - ax, cz - az), Math.hypot(cx - bx, cz - bz))
      const n = Math.max(1, Math.ceil(L / (this.cell * 0.5)))
      for (let i = 0; i <= n; i++) for (let j = 0; i + j <= n; j++) {
        const u = i / n, v = j / n
        this.putXZ(ax + (bx - ax) * u + (cx - ax) * v, az + (bz - az) * u + (cz - az) * v, h)
      }
    } else {
      this.line(ax, az, bx, bz, h); this.line(bx, bz, cx, cz, h); this.line(cx, cz, ax, az, h)
    }
  }

  private line(x0: number, z0: number, x1: number, z1: number, h: number) {
    const L = Math.hypot(x1 - x0, z1 - z0)
    const n = Math.max(1, Math.ceil(L / (this.cell * 0.5)))
    for (let k = 0; k <= n; k++) { const t = k / n; this.putXZ(x0 + (x1 - x0) * t, z0 + (z1 - z0) * t, h) }
  }

  /** 栅格化一个网格（按 matrixWorld 变换到世界坐标；调用方先 updateMatrixWorld） */
  addMesh(m: MeshLike) {
    const pos = m.geometry.getAttribute('position')
    if (!pos) return
    const e = m.matrixWorld.elements
    const idx = m.geometry.index
    const n = idx ? idx.count : pos.count
    const w = new Float64Array(9)
    for (let t = 0; t + 2 < n; t += 3) {
      for (let k = 0; k < 3; k++) {
        const v = idx ? idx.getX(t + k) : t + k
        const x = pos.getX(v), y = pos.getY(v), z = pos.getZ(v)
        w[k * 3] = e[0] * x + e[4] * y + e[8] * z + e[12]
        w[k * 3 + 1] = e[1] * x + e[5] * y + e[9] * z + e[13]
        w[k * 3 + 2] = e[2] * x + e[6] * y + e[10] * z + e[14]
      }
      this.addTriangle(w[0], w[1], w[2], w[3], w[4], w[5], w[6], w[7], w[8])
    }
  }

  /** 手写盒子（缺少网格数据的地标兜底） */
  addBox(minX: number, maxX: number, minZ: number, maxZ: number, top: number) {
    const h = Math.min(65535, Math.round(top * UNIT)), c = this.cell
    for (let z = minZ; z <= maxZ + c * 0.5; z += c * 0.5) for (let x = minX; x <= maxX + c * 0.5; x += c * 0.5) this.putXZ(Math.min(x, maxX), Math.min(z, maxZ), h)
  }
}
