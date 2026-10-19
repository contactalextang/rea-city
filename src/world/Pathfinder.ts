import type { RoadGraph, RoadNode, RoadEdge } from './RoadGraph'

export interface PathTable {
  /** 每个节点到 target 的最短路长（不可达 = Infinity） */
  dist: Float64Array
  /** 从该节点出发沿最短路应走的下一条边（target 本身或不可达 = null） */
  nextEdgeFromNode: (RoadEdge | null)[]
  at: number
}

const TTL = 1          // 缓存有效期（秒）

/** 以目标节点为源在反向图上跑 Dijkstra（边权 = 长度），得到"每个节点的下一条边"表；按 target.id 缓存 */
export class Pathfinder {
  private cache = new Map<number, PathTable>()
  private inEdges: RoadEdge[][]

  constructor(private graph: RoadGraph) {
    this.inEdges = graph.nodes.map(() => [])
    for (const e of graph.edges) this.inEdges[e.to.id].push(e)
  }

  invalidate(targetId?: number) {
    if (targetId === undefined) this.cache.clear(); else this.cache.delete(targetId)
  }

  tableFor(target: RoadNode): PathTable {
    const now = performance.now() / 1000
    const hit = this.cache.get(target.id)
    if (hit && now - hit.at < TTL) return hit
    const table = this.compute(target, now)
    this.cache.set(target.id, table)
    return table
  }

  private compute(target: RoadNode, now: number): PathTable {
    const N = this.graph.nodes.length
    const dist = new Float64Array(N).fill(Infinity)
    const next: (RoadEdge | null)[] = new Array(N).fill(null)
    const heap = new MinHeap()
    dist[target.id] = 0
    heap.push(target.id, 0)
    while (heap.size) {
      const { id: u, key: du } = heap.pop()
      if (du > dist[u]) continue   // 过期条目
      for (const e of this.inEdges[u]) {
        const v = e.from.id, nd = du + e.length
        if (nd < dist[v]) { dist[v] = nd; next[v] = e; heap.push(v, nd) }
      }
    }
    return { dist, nextEdgeFromNode: next, at: now }
  }
}

/** 简单二叉最小堆（节点 id + 键值） */
class MinHeap {
  private ids: number[] = []
  private keys: number[] = []
  get size() { return this.ids.length }
  push(id: number, key: number) {
    const ids = this.ids, keys = this.keys
    ids.push(id); keys.push(key)
    let i = ids.length - 1
    while (i > 0) {
      const p = (i - 1) >> 1
      if (keys[p] <= keys[i]) break
      ;[ids[p], ids[i]] = [ids[i], ids[p]]; [keys[p], keys[i]] = [keys[i], keys[p]]
      i = p
    }
  }
  pop() {
    const ids = this.ids, keys = this.keys
    const top = { id: ids[0], key: keys[0] }
    const lastId = ids.pop()!, lastKey = keys.pop()!
    if (ids.length) {
      ids[0] = lastId; keys[0] = lastKey
      let i = 0
      for (;;) {
        const l = i * 2 + 1, r = l + 1
        let m = i
        if (l < ids.length && keys[l] < keys[m]) m = l
        if (r < ids.length && keys[r] < keys[m]) m = r
        if (m === i) break
        ;[ids[m], ids[i]] = [ids[i], ids[m]]; [keys[m], keys[i]] = [keys[i], keys[m]]
        i = m
      }
    }
    return top
  }
}
