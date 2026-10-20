import type { RoadGraph } from './RoadGraph'

/**
 * 车行道净空：判断点是否落在建模车行道内（与 08-roadmesh 同口径：每对互为 reverse 的边一条带，
 * 半宽 = (lanes + reverse.lanes) × laneW / 2；单向 = lanes × laneW / 2；每个节点加半径 jr 的圆帽），
 * 并把杆状道具沿法线推到路缘外。LTA 原始坐标常落在车道里或贴着路缘，运行时修正即可，不必重新烘焙区块。
 * 空间哈希只在构造时建一次（O(E)），每次查询只看所在格附近的线段/圆帽。
 */
const CELL = 32
const MAX_ITER = 4
/** 建索引时额外外扩（≥ 查询时的 r + margin） */
const PAD = 2

export interface FitResult {
  /** false：推不出（路口圆心附近 / 两条路夹缝里来回顶 / 位移过大） */
  ok: boolean
  x: number; z: number
  /** 原本是否侵入车行道（含净空） */
  moved: boolean
}

export class RoadClearance {
  /** 线段：ax, az, bx, bz, 半宽 */
  private segs: Float32Array
  /** 圆帽：x, z, r */
  private caps: Float32Array
  private segCells = new Map<number, number[]>()
  private capCells = new Map<number, number[]>()
  private hit = { depth: 0, nx: 0, nz: 0 }

  constructor(graph: RoadGraph) {
    const segs: number[] = [], caps: number[] = []
    for (const e of graph.edges) {
      if (e.reverse && e.reverse.id < e.id) continue   // 成对只取 id 小的
      const half = (e.lanes + (e.reverse ? e.reverse.lanes : 0)) * e.laneW / 2
      const n = e.pts.length >> 1
      for (let k = 0; k < n - 1; k++) {
        const i = segs.length / 5
        const ax = e.pts[k * 2], az = e.pts[k * 2 + 1], bx = e.pts[k * 2 + 2], bz = e.pts[k * 2 + 3]
        segs.push(ax, az, bx, bz, half)
        const w = half + PAD
        this.insert(this.segCells, i, Math.min(ax, bx) - w, Math.min(az, bz) - w, Math.max(ax, bx) + w, Math.max(az, bz) + w)
      }
    }
    // 只在有边相连的节点上加圆帽（与路面网格一致）
    for (const n of graph.nodes) {
      if (!n.out.length) continue
      const i = caps.length / 3
      caps.push(n.x, n.z, n.jr)
      const w = n.jr + PAD
      this.insert(this.capCells, i, n.x - w, n.z - w, n.x + w, n.z + w)
    }
    this.segs = new Float32Array(segs)
    this.caps = new Float32Array(caps)
  }

  private key(cx: number, cz: number) { return (cx + 8192) * 16384 + (cz + 8192) }
  private insert(map: Map<number, number[]>, i: number, x0: number, z0: number, x1: number, z1: number) {
    for (let cx = Math.floor(x0 / CELL); cx <= Math.floor(x1 / CELL); cx++) for (let cz = Math.floor(z0 / CELL); cz <= Math.floor(z1 / CELL); cz++) {
      const k = this.key(cx, cz)
      let list = map.get(k)
      if (!list) { list = []; map.set(k, list) }
      list.push(i)
    }
  }

  /** 侵入最深的车行道要素：depth = 需要外推的距离（≤0 表示不侵入）；(nx,nz) 外推方向 */
  private deepest(x: number, z: number, margin: number) {
    const h = this.hit
    h.depth = 0; h.nx = 0; h.nz = 0
    const k = this.key(Math.floor(x / CELL), Math.floor(z / CELL))
    const S = this.segs, C = this.caps
    for (const i of this.segCells.get(k) ?? []) {
      const o = i * 5
      const ax = S[o], az = S[o + 1], bx = S[o + 2], bz = S[o + 3], half = S[o + 4]
      const dx = bx - ax, dz = bz - az, L2 = dx * dx + dz * dz
      if (L2 < 1e-8) continue
      let u = ((x - ax) * dx + (z - az) * dz) / L2
      // 线段两端交给圆帽处理，这里只算侧向（与带状多边形一致）
      if (u < 0 || u > 1) continue
      const qx = ax + dx * u, qz = az + dz * u
      let ex = x - qx, ez = z - qz
      const d = Math.hypot(ex, ez)
      const depth = half + margin - d
      if (depth <= h.depth) continue
      if (d < 1e-4) { const L = Math.sqrt(L2); ex = -dz / L; ez = dx / L } else { ex /= d; ez /= d }
      h.depth = depth; h.nx = ex; h.nz = ez
    }
    for (const i of this.capCells.get(k) ?? []) {
      const o = i * 3
      const ex = x - C[o], ez = z - C[o + 1]
      const d = Math.hypot(ex, ez)
      const depth = C[o + 2] + margin - d
      if (depth <= h.depth) continue
      // 圆心上无从判断方向：标记为推不出
      if (d < 0.5) { h.depth = depth; h.nx = 0; h.nz = 0; continue }
      h.depth = depth; h.nx = ex / d; h.nz = ez / d
    }
    return h
  }

  /** 点（半径 r 的杆）是否侵入车行道 + 净空 margin（r + margin 需 ≤ PAD） */
  intrudes(x: number, z: number, r: number, margin = 0) {
    return this.deepest(x, z, r + margin).depth > 1e-3
  }

  /**
   * 把半径 r 的杆推到路缘外 margin 处；最多迭代几次（推出一条路可能顶进另一条），
   * 总位移超过 maxPush 或仍侵入则 ok=false。
   */
  fit(x: number, z: number, r: number, margin = 0.5, maxPush = 8): FitResult {
    let px = x, pz = z
    let moved = false
    for (let it = 0; it < MAX_ITER; it++) {
      const h = this.deepest(px, pz, r + margin)
      if (h.depth <= 1e-3) return { ok: true, x: px, z: pz, moved }
      if (h.nx === 0 && h.nz === 0) return { ok: false, x, z, moved: true }
      moved = true
      px += h.nx * (h.depth + 0.01); pz += h.nz * (h.depth + 0.01)
      if (Math.hypot(px - x, pz - z) > maxPush) return { ok: false, x, z, moved }
    }
    return this.deepest(px, pz, r + margin).depth <= 1e-3 ? { ok: true, x: px, z: pz, moved } : { ok: false, x, z, moved }
  }
}
