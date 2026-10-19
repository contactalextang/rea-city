import { GRID, DRIVE_SIDE, SIDEWALK_W, pick } from '../config'
import { Pathfinder } from './Pathfinder'

export type RoadKind = 'expressway' | 'trunk' | 'primary' | 'secondary' | 'tertiary' | 'residential' | 'service'

/** 路网数据（可由方格生成器或 OSM 烘焙产出） */
export interface GraphData {
  nodes: { id: number; x: number; z: number; junction: boolean; signal: boolean; jr: number; i?: number; j?: number }[]
  edges: {
    id: number; from: number; to: number
    pts: number[]              // [x0,z0,x1,z1,...] 含首尾节点
    lanes: number; laneW: number; kind: RoadKind
    speedLimit: number         // km/h
    oneway: boolean; reverse: number | null
    crossings: number[]        // 斑马线所在弧长
    sidewalkOff?: number       // 人行道中心距路中线；缺省按车道数 + SIDEWALK_W 推算
  }[]
}

export interface RoadNode {
  id: number; x: number; z: number
  out: RoadEdge[]
  junction: boolean; signal: boolean
  jr: number                 // 路口半径：边的直线段为 [from.jr, L - to.jr]
  i: number; j: number       // 方格城索引（非方格城为 -1）
  occupant: object | null    // 路口令牌：当前放行的车
  occupantSince: number
}
export interface RoadEdge {
  id: number; from: RoadNode; to: RoadNode
  reverse: RoadEdge | null
  pts: Float32Array          // 中线折线 [x0,z0,x1,z1,...]
  cum: Float32Array          // 各折点累计弧长
  length: number
  lanes: number; laneW: number; kind: RoadKind
  speedLimit: number; oneway: boolean
  crossings: number[]
  sidewalkOff: number
  dx: number; dz: number     // 首段单位方向（兼容旧代码）
  rx: number; rz: number     // 首段右侧单位向量
}
export interface P2 { x: number; z: number }

const KIND_WEIGHT: Record<RoadKind, number> = { expressway: 2, trunk: 1.5, primary: 1.5, secondary: 1, tertiary: 1, residential: 0.7, service: 0.2 }
const CELL = 32            // 线段空间哈希格边长 (m)
const QUERY_R = 20         // nearestLane 搜索半径 (m)
const tmpProj = { t: 0, d: 0 }
const tmpDir: P2 = { x: 0, z: 0 }

/** 通用有向路网：节点 = 路口/端点，边 = 带折线中线的有向路段；车道/人行道按 DRIVE_SIDE 偏移 */
export class RoadGraph {
  nodes: RoadNode[] = []
  edges: RoadEdge[] = []
  private gridIndex: RoadNode[] | null = null
  private cells = new Map<number, RoadEdge[]>()
  private stamp: Uint32Array
  private stampNow = 0
  private weightPrefix: Float64Array
  private pathfinder: Pathfinder

  constructor(data: GraphData) {
    const byNodeId = new Map<number, RoadNode>()
    for (const d of data.nodes) {
      const n: RoadNode = { id: this.nodes.length, x: d.x, z: d.z, out: [], junction: d.junction, signal: d.signal, jr: d.jr, i: d.i ?? -1, j: d.j ?? -1, occupant: null, occupantSince: 0 }
      this.nodes.push(n); byNodeId.set(d.id, n)
    }
    const byEdgeId = new Map<number, RoadEdge>()
    for (const d of data.edges) {
      const from = byNodeId.get(d.from), to = byNodeId.get(d.to)
      if (!from || !to) throw new Error(`RoadGraph: 边 ${d.id} 引用了不存在的节点`)
      const pts = new Float32Array(d.pts)
      const n = pts.length >> 1
      if (n < 2) throw new Error(`RoadGraph: 边 ${d.id} 折点不足`)
      const cum = new Float32Array(n)
      for (let k = 1; k < n; k++) cum[k] = cum[k - 1] + Math.hypot(pts[k * 2] - pts[k * 2 - 2], pts[k * 2 + 1] - pts[k * 2 - 1])
      const length = cum[n - 1]
      const dx0 = pts[2] - pts[0], dz0 = pts[3] - pts[1], l0 = Math.hypot(dx0, dz0) || 1
      const dx = dx0 / l0, dz = dz0 / l0
      const e: RoadEdge = {
        id: this.edges.length, from, to, reverse: null, pts, cum, length,
        lanes: d.lanes, laneW: d.laneW, kind: d.kind, speedLimit: d.speedLimit, oneway: d.oneway, crossings: d.crossings.slice(),
        sidewalkOff: d.sidewalkOff ?? (d.lanes * d.laneW / 2 + SIDEWALK_W / 2),
        // y 轴朝上的右手系里，朝向 (dx,dz) 的右侧是 (-dz, dx)
        dx, dz, rx: -dz, rz: dx,
      }
      this.edges.push(e); byEdgeId.set(d.id, e); from.out.push(e)
    }
    for (const d of data.edges) {
      if (d.reverse === null) continue
      const e = byEdgeId.get(d.id)!, r = byEdgeId.get(d.reverse)
      if (!r) throw new Error(`RoadGraph: 边 ${d.id} 的反向边 ${d.reverse} 不存在`)
      e.reverse = r
    }
    // 方格城索引表
    if (this.nodes.length && this.nodes.every((n) => n.i >= 0 && n.j >= 0)) {
      const N = GRID + 1
      this.gridIndex = new Array<RoadNode>(N * N)
      for (const n of this.nodes) if (n.i < N && n.j < N) this.gridIndex[n.j * N + n.i] = n
    }
    this.stamp = new Uint32Array(this.edges.length)
    this.buildCells()
    this.weightPrefix = new Float64Array(this.edges.length)
    let acc = 0
    for (let k = 0; k < this.edges.length; k++) { const e = this.edges[k]; acc += e.length * KIND_WEIGHT[e.kind]; this.weightPrefix[k] = acc }
    this.pathfinder = new Pathfinder(this)
  }

  // ---------- 空间哈希 ----------
  private cellKey(cx: number, cz: number) { return (cx + 8192) * 16384 + (cz + 8192) }

  private buildCells() {
    for (const e of this.edges) {
      const pad = e.lanes * e.laneW + 1
      const n = e.pts.length >> 1
      for (let k = 0; k < n - 1; k++) {
        const ax = e.pts[k * 2], az = e.pts[k * 2 + 1], bx = e.pts[k * 2 + 2], bz = e.pts[k * 2 + 3]
        const x0 = Math.floor((Math.min(ax, bx) - pad) / CELL), x1 = Math.floor((Math.max(ax, bx) + pad) / CELL)
        const z0 = Math.floor((Math.min(az, bz) - pad) / CELL), z1 = Math.floor((Math.max(az, bz) + pad) / CELL)
        for (let cx = x0; cx <= x1; cx++) for (let cz = z0; cz <= z1; cz++) {
          const key = this.cellKey(cx, cz)
          let list = this.cells.get(key)
          if (!list) { list = []; this.cells.set(key, list) }
          if (!list.includes(e)) list.push(e)
        }
      }
    }
  }

  // ---------- 方格城兼容 ----------
  /** 方格城节点 (i,j)；非方格路网抛错 */
  node(i: number, j: number): RoadNode {
    if (!this.gridIndex) throw new Error('RoadGraph.node(i,j) 仅方格路网可用')
    const n = this.gridIndex[j * (GRID + 1) + i]
    if (!n) throw new Error(`RoadGraph.node(${i},${j}) 不存在`)
    return n
  }

  // ---------- 几何采样 ----------
  /** 弧长 t 所在折线段索引（cum[k] <= t < cum[k+1]） */
  private segAt(e: RoadEdge, t: number) {
    const cum = e.cum
    let lo = 0, hi = cum.length - 2
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1
      if (cum[mid] <= t) lo = mid; else hi = mid - 1
    }
    return lo
  }

  /** 中线上弧长 t 的位置与该段右法线（写入 out 与 tmpDir 的右向量） */
  private sample(e: RoadEdge, t: number, off: number, out: P2): P2 {
    const tt = t < 0 ? 0 : t > e.length ? e.length : t
    const k = this.segAt(e, tt)
    const ax = e.pts[k * 2], az = e.pts[k * 2 + 1], bx = e.pts[k * 2 + 2], bz = e.pts[k * 2 + 3]
    const segLen = e.cum[k + 1] - e.cum[k]
    const u = segLen > 1e-6 ? (tt - e.cum[k]) / segLen : 0
    const dx = segLen > 1e-6 ? (bx - ax) / segLen : e.dx, dz = segLen > 1e-6 ? (bz - az) / segLen : e.dz
    // 允许 t 越界外推（路口内），便于转弯曲线首尾与直线段相接
    const ext = t - tt
    out.x = ax + (bx - ax) * u + dx * ext - dz * off
    out.z = az + (bz - az) * u + dz * ext + dx * off
    return out
  }

  /** 第 lane 条车道（0 = 最靠行驶侧）上弧长 t 的点 */
  lanePoint(e: RoadEdge, t: number, out: P2, lane = 0): P2 {
    return this.sample(e, t, DRIVE_SIDE * (lane + 0.5) * e.laneW, out)
  }
  /** 行驶侧人行道上弧长 t 的点 */
  sidewalkPoint(e: RoadEdge, t: number, out: P2): P2 {
    return this.sample(e, t, DRIVE_SIDE * e.sidewalkOff, out)
  }
  /** 弧长 t 处的单位方向 */
  dirAt(e: RoadEdge, t: number, out: P2): P2 {
    const tt = t < 0 ? 0 : t > e.length ? e.length : t
    const k = this.segAt(e, tt)
    const dx = e.pts[k * 2 + 2] - e.pts[k * 2], dz = e.pts[k * 2 + 3] - e.pts[k * 2 + 1]
    const l = Math.hypot(dx, dz)
    if (l < 1e-6) { out.x = e.dx; out.z = e.dz } else { out.x = dx / l; out.z = dz / l }
    return out
  }

  /** 把世界点投影到该边 lane 0 车道线上：逐段投影取最近，返回弧长 t 与距离 d */
  private projectLane(e: RoadEdge, x: number, z: number, out: { t: number; d: number }) {
    const off = DRIVE_SIDE * 0.5 * e.laneW
    const n = e.pts.length >> 1
    let bestT = 0, bestD = Infinity
    for (let k = 0; k < n - 1; k++) {
      const ax = e.pts[k * 2], az = e.pts[k * 2 + 1], bx = e.pts[k * 2 + 2], bz = e.pts[k * 2 + 3]
      const segLen = e.cum[k + 1] - e.cum[k]
      if (segLen < 1e-6) continue
      const dx = (bx - ax) / segLen, dz = (bz - az) / segLen
      const ox = -dz * off, oz = dx * off
      const px = x - ax - ox, pz = z - az - oz
      let s = px * dx + pz * dz
      if (s < 0) s = 0; else if (s > segLen) s = segLen
      const qx = ax + ox + dx * s, qz = az + oz + dz * s
      const d = Math.hypot(x - qx, z - qz)
      if (d < bestD) { bestD = d; bestT = e.cum[k] + s }
    }
    out.t = bestT; out.d = bestD
    return out
  }
  projectT(e: RoadEdge, x: number, z: number): number {
    return this.projectLane(e, x, z, tmpProj).t
  }

  // ---------- 查询 ----------
  nearestNode(x: number, z: number): RoadNode {
    let best = this.nodes[0], bestD = Infinity
    for (const n of this.nodes) {
      const d = (n.x - x) * (n.x - x) + (n.z - z) * (n.z - z)
      if (d < bestD) { bestD = d; best = n }
    }
    return best
  }

  /** 把世界坐标投影到最近的车道上，返回边与沿边距离；(hx,hz) 为可选的朝向偏好 */
  nearestLane(x: number, z: number, hx = 0, hz = 0): { edge: RoadEdge; t: number; dist: number } {
    let best: RoadEdge | null = null, bestT = 0, bestD = Infinity, bestScore = Infinity
    const consider = (e: RoadEdge) => {
      this.projectLane(e, x, z, tmpProj)
      this.dirAt(e, tmpProj.t, tmpDir)
      const score = tmpProj.d - 4 * (tmpDir.x * hx + tmpDir.z * hz)
      if (score < bestScore) { bestScore = score; bestD = tmpProj.d; best = e; bestT = tmpProj.t }
    }
    this.stampNow++
    const x0 = Math.floor((x - QUERY_R) / CELL), x1 = Math.floor((x + QUERY_R) / CELL)
    const z0 = Math.floor((z - QUERY_R) / CELL), z1 = Math.floor((z + QUERY_R) / CELL)
    for (let cx = x0; cx <= x1; cx++) for (let cz = z0; cz <= z1; cz++) {
      const list = this.cells.get(this.cellKey(cx, cz)); if (!list) continue
      for (const e of list) {
        if (this.stamp[e.id] === this.stampNow) continue
        this.stamp[e.id] = this.stampNow
        consider(e)
      }
    }
    if (!best) for (const e of this.edges) consider(e)   // 远离路网：全图扫描
    return { edge: best!, t: bestT, dist: bestD }
  }

  /** 从 e 的终点继续前进可选的边（不掉头，除非死路） */
  nextEdges(e: RoadEdge): RoadEdge[] {
    const opts = e.to.out.filter((o) => o !== e.reverse)
    return opts.length ? opts : e.reverse ? [e.reverse] : []
  }
  /** 随机后继边；孤立死路返回 null */
  randomNext(e: RoadEdge): RoadEdge | null {
    const opts = this.nextEdges(e)
    return opts.length ? pick(opts) : null
  }
  /** 按 长度 × 道路等级权重 采样一条边 */
  randomEdge(): RoadEdge {
    const total = this.weightPrefix[this.edges.length - 1]
    const r = Math.random() * total
    let lo = 0, hi = this.edges.length - 1
    while (lo < hi) { const mid = (lo + hi) >> 1; if (this.weightPrefix[mid] < r) lo = mid + 1; else hi = mid }
    return this.edges[lo]
  }

  /** 沿最短路（Dijkstra，按长度）朝 target 前进的下一条边；不可达时随机 */
  nextTowards(e: RoadEdge, target: RoadNode): RoadEdge | null {
    const { dist } = this.pathfinder.tableFor(target)
    let best: RoadEdge | null = null, bestD = Infinity
    for (const o of this.nextEdges(e)) {
      const d = o.length + dist[o.to.id]
      if (d < bestD) { bestD = d; best = o }
    }
    return best ?? this.randomNext(e)
  }
  /** 目标点移动/路网变化后清掉寻路缓存 */
  invalidatePaths() { this.pathfinder.invalidate() }

  stats() {
    let length = 0, junctions = 0, signals = 0
    for (const e of this.edges) length += e.length
    for (const n of this.nodes) { if (n.junction) junctions++; if (n.signal) signals++ }
    return { nodes: this.nodes.length, edges: this.edges.length, length: Math.round(length), junctions, signals, cells: this.cells.size }
  }
}
