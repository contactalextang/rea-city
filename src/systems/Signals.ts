import * as THREE from 'three'
import { wrapAngle } from '../config'
import type { RoadGraph, RoadNode, RoadEdge, P2 } from '../world/RoadGraph'

export type Phase = 'green' | 'amber' | 'red'
export interface SignalTiming { green: number; amber: number; allRed: number }
export const DEFAULT_TIMING: SignalTiming = { green: 20, amber: 3, allRed: 2 }

/** 世界加载器挂到 scene.userData.signalLights 的灯具约定：第 i 个实例对应 edgeIds[i]（进入路口的边） */
export interface SignalLights { mesh: THREE.InstancedMesh; edgeIds: number[] }

interface Junction {
  /** 簇 id = 簇内最小节点 id */
  id: number
  nodes: RoadNode[]
  groups: [RoadEdge[], RoadEdge[]]   // 按进入方向轴分成两组（对向车流同组）
  offset: number                     // 相位偏移（秒）
  forced: Phase | null               // 测试用强制相位
}

const COLORS: Record<Phase, THREE.Color> = {
  green: new THREE.Color(0x2cff6a), amber: new THREE.Color(0xffb020), red: new THREE.Color(0xff2b2b),
}
const tmpDir: P2 = { x: 0, z: 0 }
/** OSM 把一个真实路口拆成 2–4 个信号节点（中位间距 ~18 m）：此距离内的信号节点算同一路口 */
export const SIGNAL_CLUSTER_R = 40

/**
 * 信号节点聚簇（并查集）：相距 ≤ radius 的信号节点归为一簇，簇 id 取簇内最小节点 id。
 * 返回 node.id → 簇 id；非信号节点为 -1。PropMeshes 也用它给灯头挑入口边。
 */
export function signalClusters(graph: RoadGraph, radius = SIGNAL_CLUSTER_R): Int32Array {
  const parent = new Int32Array(graph.nodes.length).fill(-1)
  const sig = graph.nodes.filter((n) => n.signal)
  for (const n of sig) parent[n.id] = n.id
  const find = (i: number): number => { while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i] } return i }
  const r2 = radius * radius
  // 信号节点只有几百个，两两比较足够
  for (let a = 0; a < sig.length; a++) for (let b = a + 1; b < sig.length; b++) {
    const A = sig[a], B = sig[b]
    if ((A.x - B.x) ** 2 + (A.z - B.z) ** 2 > r2) continue
    const ra = find(A.id), rb = find(B.id)
    if (ra !== rb) { if (ra < rb) parent[rb] = ra; else parent[ra] = rb }
  }
  for (const n of sig) parent[n.id] = find(n.id)
  return parent
}

/**
 * 红绿灯相位：相距 ≤ 40 m 的信号节点聚成一个路口簇，簇共用相位偏移与参考轴，
 * 簇内所有从簇外进入的边按方向轴分两组，两相位轮换：绿 → 黄 → 全红 → (另一组) 绿 → 黄 → 全红；
 * 簇内部的短边（两端同簇）不设停止线，恒绿（已在路口里的车直接通过）；非信号灯路口恒绿。
 * 参考轴取簇内最长入边的末端方向：主路通常最长，同一路口同向车流必然同相位。
 */
export class Signals {
  time = 0
  readonly cycle: number
  private junctions = new Map<number, Junction>()   // node.id → 所在簇（同簇节点共用一个对象）
  private groupOf: Int8Array          // edge.id → 组号；非信号灯入边为 -1，簇内部边为 -2
  private cluster: Int32Array         // node.id → 簇 id；非信号节点 -1

  constructor(private graph: RoadGraph, readonly timing: SignalTiming = DEFAULT_TIMING) {
    this.cycle = 2 * (timing.green + timing.amber + timing.allRed)
    this.groupOf = new Int8Array(graph.edges.length).fill(-1)
    this.cluster = signalClusters(graph)
    const incoming = new Map<number, RoadEdge[]>()   // 簇 id → 从簇外进入的边
    const members = new Map<number, RoadNode[]>()
    for (const n of graph.nodes) {
      const c = this.cluster[n.id]
      if (c < 0) continue
      const list = members.get(c) ?? []
      list.push(n); members.set(c, list)
    }
    for (const e of graph.edges) {
      const c = this.cluster[e.to.id]
      if (c < 0) continue
      if (this.cluster[e.from.id] === c) { this.groupOf[e.id] = -2; continue }
      const list = incoming.get(c) ?? []
      list.push(e); incoming.set(c, list)
    }
    for (const [c, nodes] of members) {
      const edges = incoming.get(c) ?? []
      const groups: [RoadEdge[], RoadEdge[]] = [[], []]
      let ref: RoadEdge | null = null
      for (const e of edges) if (!ref || e.length > ref.length) ref = e
      if (ref) {
        graph.dirAt(ref, ref.length, tmpDir)
        const a0 = Math.atan2(tmpDir.z, tmpDir.x)
        for (const e of edges) {
          graph.dirAt(e, e.length, tmpDir)
          let d = Math.abs(wrapAngle(Math.atan2(tmpDir.z, tmpDir.x) - a0))
          if (d > Math.PI / 2) d = Math.PI - d        // 对向进入的车流共用一个相位
          const g = d <= Math.PI / 4 ? 0 : 1
          groups[g].push(e); this.groupOf[e.id] = g
        }
      }
      // 初始相位按簇 id 打散，避免全城同步
      const offset = ((c * 7919 + 13) % 1000) / 1000 * this.cycle
      const j: Junction = { id: c, nodes, groups, offset, forced: null }
      for (const n of nodes) this.junctions.set(n.id, j)
    }
  }

  update(dt: number) { this.time += dt }

  /** 所有信号灯路口的节点 id */
  get nodeIds() { return [...this.junctions.keys()] }

  /** 节点所在信号路口簇 id；非信号节点为 -1 */
  clusterOf(nodeId: number) { return this.cluster[nodeId] ?? -1 }

  /** 簇内部边：两端是同一路口簇的信号节点（不设停止线） */
  isInternalEdge(e: RoadEdge) { return this.groupOf[e.id] === -2 }

  /** 组 g 在周期内的时刻（0 = 该组绿灯开始） */
  private groupT(j: Junction, g: number) {
    let t = (this.time + j.offset) % this.cycle
    if (g === 1) t = (t + this.cycle / 2) % this.cycle
    return t
  }

  private groupPhase(j: Junction, g: number): Phase {
    if (j.forced) return j.forced
    if (j.groups[1].length === 0) return 'green'    // 只有一个方向轴：恒绿
    const t = this.groupT(j, g)
    if (t < this.timing.green) return 'green'
    if (t < this.timing.green + this.timing.amber) return 'amber'
    return 'red'
  }

  /** edge 为进入某路口的边；该路口非信号灯或是簇内部边则恒绿 */
  phaseFor(edge: RoadEdge): Phase {
    const g = this.groupOf[edge.id]
    if (g < 0) return 'green'
    const j = this.junctions.get(edge.to.id)
    return j ? this.groupPhase(j, g) : 'green'
  }

  /** 该入边当前红灯已持续的秒数；非红灯为 0（测试强制红灯视为已红很久） */
  redElapsed(edge: RoadEdge): number {
    const g = this.groupOf[edge.id]
    if (g < 0) return 0
    const j = this.junctions.get(edge.to.id)
    if (!j || this.groupPhase(j, g) !== 'red') return 0
    if (j.forced) return Infinity
    return this.groupT(j, g) - this.timing.green - this.timing.amber
  }

  stateOf(node: RoadNode | number) {
    const id = typeof node === 'number' ? node : node.id
    const j = this.junctions.get(id)
    if (!j) return null
    return {
      nodeId: id,
      cluster: j.id,
      clusterNodes: j.nodes.map((n) => n.id),
      phases: [this.groupPhase(j, 0), this.groupPhase(j, 1)] as [Phase, Phase],
      groups: [j.groups[0].map((e) => e.id), j.groups[1].map((e) => e.id)] as [number[], number[]],
      forced: j.forced,
    }
  }

  /** 测试用：强制该路口（整个簇）所有入口为某相位；null 恢复自动轮换 */
  setPhase(nodeId: number, phase: Phase | null) {
    const j = this.junctions.get(nodeId)
    if (j) j.forced = phase
    return !!j
  }

  /** 把当前相位写入灯具实例颜色（只在变化时上传） */
  applyToMesh(mesh: THREE.InstancedMesh, edgeIds: number[]) {
    let cache = mesh.userData.signalPhases as (Phase | null)[] | undefined
    if (!cache || cache.length !== edgeIds.length) cache = mesh.userData.signalPhases = new Array<Phase | null>(edgeIds.length).fill(null)
    let dirty = false
    for (let i = 0; i < edgeIds.length; i++) {
      const p = this.phaseFor(this.graph.edges[edgeIds[i]])
      if (cache[i] === p) continue
      cache[i] = p; mesh.setColorAt(i, COLORS[p]); dirty = true
    }
    if (dirty && mesh.instanceColor) mesh.instanceColor.needsUpdate = true
  }
}
