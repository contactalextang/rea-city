import * as THREE from 'three'
import { wrapAngle } from '../config'
import type { RoadGraph, RoadNode, RoadEdge, P2 } from '../world/RoadGraph'

export type Phase = 'green' | 'amber' | 'red'
export interface SignalTiming { green: number; amber: number; allRed: number }
export const DEFAULT_TIMING: SignalTiming = { green: 20, amber: 3, allRed: 2 }

/** 世界加载器挂到 scene.userData.signalLights 的灯具约定：第 i 个实例对应 edgeIds[i]（进入路口的边） */
export interface SignalLights { mesh: THREE.InstancedMesh; edgeIds: number[] }

interface Junction {
  node: RoadNode
  groups: [RoadEdge[], RoadEdge[]]   // 按进入方向轴分成两组（对向车流同组）
  offset: number                     // 相位偏移（秒）
  forced: Phase | null               // 测试用强制相位
}

const COLORS: Record<Phase, THREE.Color> = {
  green: new THREE.Color(0x2cff6a), amber: new THREE.Color(0xffb020), red: new THREE.Color(0xff2b2b),
}
const tmpDir: P2 = { x: 0, z: 0 }

/**
 * 红绿灯相位：每个 node.signal 的路口把入边按方向轴聚成两组，两相位轮换
 * 绿 → 黄 → 全红 → (另一组) 绿 → 黄 → 全红；非信号灯路口恒绿。
 */
export class Signals {
  time = 0
  readonly cycle: number
  private junctions = new Map<number, Junction>()
  private groupOf: Int8Array          // edge.id → 组号；非信号灯入边为 -1

  constructor(private graph: RoadGraph, readonly timing: SignalTiming = DEFAULT_TIMING) {
    this.cycle = 2 * (timing.green + timing.amber + timing.allRed)
    this.groupOf = new Int8Array(graph.edges.length).fill(-1)
    const incoming = new Map<RoadNode, RoadEdge[]>()
    for (const e of graph.edges) {
      if (!e.to.signal) continue
      const list = incoming.get(e.to) ?? []
      list.push(e); incoming.set(e.to, list)
    }
    for (const [node, edges] of incoming) {
      graph.dirAt(edges[0], edges[0].length, tmpDir)
      const a0 = Math.atan2(tmpDir.z, tmpDir.x)
      const groups: [RoadEdge[], RoadEdge[]] = [[], []]
      for (const e of edges) {
        graph.dirAt(e, e.length, tmpDir)
        let d = Math.abs(wrapAngle(Math.atan2(tmpDir.z, tmpDir.x) - a0))
        if (d > Math.PI / 2) d = Math.PI - d        // 对向进入的车流共用一个相位
        const g = d <= Math.PI / 4 ? 0 : 1
        groups[g].push(e); this.groupOf[e.id] = g
      }
      // 初始相位按节点 id 打散，避免全城同步
      const offset = ((node.id * 7919 + 13) % 1000) / 1000 * this.cycle
      this.junctions.set(node.id, { node, groups, offset, forced: null })
    }
  }

  update(dt: number) { this.time += dt }

  /** 所有信号灯路口的节点 id */
  get nodeIds() { return [...this.junctions.keys()] }

  private groupPhase(j: Junction, g: number): Phase {
    if (j.forced) return j.forced
    if (j.groups[1].length === 0) return 'green'    // 只有一个方向轴：恒绿
    let t = (this.time + j.offset) % this.cycle
    if (g === 1) t = (t + this.cycle / 2) % this.cycle
    if (t < this.timing.green) return 'green'
    if (t < this.timing.green + this.timing.amber) return 'amber'
    return 'red'
  }

  /** edge 为进入某路口的边；该路口非信号灯则恒绿 */
  phaseFor(edge: RoadEdge): Phase {
    const g = this.groupOf[edge.id]
    if (g < 0) return 'green'
    const j = this.junctions.get(edge.to.id)
    return j ? this.groupPhase(j, g) : 'green'
  }

  stateOf(node: RoadNode | number) {
    const id = typeof node === 'number' ? node : node.id
    const j = this.junctions.get(id)
    if (!j) return null
    return {
      nodeId: id,
      phases: [this.groupPhase(j, 0), this.groupPhase(j, 1)] as [Phase, Phase],
      groups: [j.groups[0].map((e) => e.id), j.groups[1].map((e) => e.id)] as [number[], number[]],
      forced: j.forced,
    }
  }

  /** 测试用：强制该路口所有入口为某相位；null 恢复自动轮换 */
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
