import { GRID, PITCH, HALF, ROAD, LANE_OFFSET, SIDEWALK_OFFSET } from '../config'
import type { GraphData } from './RoadGraph'

/** 复刻原先硬编码的 (GRID+1)×(GRID+1) 方格路网：双向两点折线，所有节点都是无信号灯路口 */
export function buildGridGraphData(): GraphData {
  const N = GRID + 1
  const data: GraphData = { nodes: [], edges: [] }
  for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
    data.nodes.push({ id: j * N + i, x: i * PITCH - HALF, z: j * PITCH - HALF, junction: true, signal: false, jr: ROAD / 2, i, j })
  }
  const link = (a: number, b: number) => {
    const na = data.nodes[a], nb = data.nodes[b]
    const id1 = data.edges.length, id2 = id1 + 1
    const base = { lanes: 1, laneW: LANE_OFFSET * 2, kind: 'residential' as const, speedLimit: 50, oneway: false, crossings: [] as number[], sidewalkOff: SIDEWALK_OFFSET }
    data.edges.push(
      { id: id1, from: a, to: b, pts: [na.x, na.z, nb.x, nb.z], reverse: id2, ...base },
      { id: id2, from: b, to: a, pts: [nb.x, nb.z, na.x, na.z], reverse: id1, ...base },
    )
  }
  for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
    const n = j * N + i
    if (i + 1 < N) link(n, n + 1)
    if (j + 1 < N) link(n, n + N)
  }
  return data
}
