import { GRID, PITCH, HALF, LANE_OFFSET, SIDEWALK_OFFSET, pick } from '../config'

export interface RoadNode {
  id: number; i: number; j: number; x: number; z: number
  out: RoadEdge[]
  occupant: object | null   // 路口令牌：当前放行的车
  occupantSince: number
}
export interface RoadEdge {
  id: number; from: RoadNode; to: RoadNode
  dx: number; dz: number     // 单位方向
  rx: number; rz: number     // 右侧单位向量（右侧通行）
  length: number
  reverse: RoadEdge
}
export interface P2 { x: number; z: number }

/** 路口网格图：节点 = 路口中心，边 = 有向路段（含车道/人行道偏移） */
export class RoadGraph {
  nodes: RoadNode[] = []
  edges: RoadEdge[] = []

  constructor() {
    const N = GRID + 1
    for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
      this.nodes.push({ id: j * N + i, i, j, x: i * PITCH - HALF, z: j * PITCH - HALF, out: [], occupant: null, occupantSince: 0 })
    }
    const link = (a: RoadNode, b: RoadNode) => {
      const e1 = this.mkEdge(a, b), e2 = this.mkEdge(b, a)
      e1.reverse = e2; e2.reverse = e1
      a.out.push(e1); b.out.push(e2)
      this.edges.push(e1, e2)
    }
    for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
      const n = this.node(i, j)
      if (i + 1 < N) link(n, this.node(i + 1, j))
      if (j + 1 < N) link(n, this.node(i, j + 1))
    }
  }

  private mkEdge(a: RoadNode, b: RoadNode): RoadEdge {
    const dx0 = b.x - a.x, dz0 = b.z - a.z, len = Math.hypot(dx0, dz0)
    const dx = dx0 / len, dz = dz0 / len
    // y 轴朝上的右手系里，朝向 (dx,dz) 的右侧是 (-dz, dx)
    return { id: this.edges.length, from: a, to: b, dx, dz, rx: -dz, rz: dx, length: len, reverse: null as unknown as RoadEdge }
  }

  node(i: number, j: number) { return this.nodes[j * (GRID + 1) + i] }

  lanePoint(e: RoadEdge, t: number, out: P2): P2 {
    out.x = e.from.x + e.dx * t + e.rx * LANE_OFFSET
    out.z = e.from.z + e.dz * t + e.rz * LANE_OFFSET
    return out
  }
  sidewalkPoint(e: RoadEdge, t: number, out: P2): P2 {
    out.x = e.from.x + e.dx * t + e.rx * SIDEWALK_OFFSET
    out.z = e.from.z + e.dz * t + e.rz * SIDEWALK_OFFSET
    return out
  }

  nearestNode(x: number, z: number): RoadNode {
    const i = Math.max(0, Math.min(GRID, Math.round((x + HALF) / PITCH)))
    const j = Math.max(0, Math.min(GRID, Math.round((z + HALF) / PITCH)))
    return this.node(i, j)
  }

  /** 把世界坐标投影到最近的车道上，返回边与沿边距离 */
  nearestLane(x: number, z: number, hx = 0, hz = 0): { edge: RoadEdge; t: number; dist: number } {
    let best: RoadEdge | null = null, bestT = 0, bestD = Infinity, bestScore = Infinity
    const n = this.nearestNode(x, z)
    // 只搜最近节点周边的边（含进入该节点的反向边）
    const cand: RoadEdge[] = []
    for (const e of n.out) { cand.push(e, e.reverse) }
    for (const e of cand) {
      const px = x - e.from.x - e.rx * LANE_OFFSET, pz = z - e.from.z - e.rz * LANE_OFFSET
      const t = Math.max(0, Math.min(e.length, px * e.dx + pz * e.dz))
      const qx = e.from.x + e.dx * t + e.rx * LANE_OFFSET, qz = e.from.z + e.dz * t + e.rz * LANE_OFFSET
      const d = Math.hypot(x - qx, z - qz)
      // 可选：偏好与当前朝向 (hx,hz) 同向的车道
      const score = d - 4 * (e.dx * hx + e.dz * hz)
      if (score < bestScore) { bestScore = score; bestD = d; best = e; bestT = t }
    }
    return { edge: best!, t: bestT, dist: bestD }
  }

  /** 从 e 的终点继续前进可选的边（不掉头，除非死路） */
  nextEdges(e: RoadEdge): RoadEdge[] {
    const opts = e.to.out.filter((o) => o !== e.reverse)
    return opts.length ? opts : [e.reverse]
  }
  randomNext(e: RoadEdge): RoadEdge { return pick(this.nextEdges(e)) }
  randomEdge(): RoadEdge { return pick(this.edges) }

  /** 网格无障碍，贪心选曼哈顿距离更小的邻居即是最短路；若有多个最优随机挑一个 */
  nextTowards(e: RoadEdge, target: RoadNode): RoadEdge {
    const opts = this.nextEdges(e)
    let bestD = Infinity, best: RoadEdge[] = []
    for (const o of opts) {
      const d = Math.abs(o.to.i - target.i) + Math.abs(o.to.j - target.j)
      if (d < bestD - 1e-6) { bestD = d; best = [o] } else if (Math.abs(d - bestD) < 1e-6) best.push(o)
    }
    return pick(best)
  }
}
