import * as THREE from 'three'
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js'
import { rand } from '../config'
import type { ChunkProp } from './ChunkFormat'
import type { RoadGraph, RoadNode, RoadEdge, P2 } from './RoadGraph'
import { polyBody, type StaticBody } from './Colliders'
import { signalClusters, type SignalLights } from '../systems/Signals'
import { RoadClearance } from './RoadClearance'

/**
 * 街道道具：全局 InstancedMesh（每种道具一个池），按区块维护实例记录；
 * 区块增删后在 flush() 里整体重写实例缓冲（几千个矩阵，开销可忽略），count 始终紧凑。
 * 对外约定（DayNight / Signals 读取）：
 *   scene.userData.lamps = 灯柱 InstancedMesh，scene.userData.lampHead = 灯头相对实例原点偏移；
 *   scene.userData.signalLights = { mesh: 灯头 InstancedMesh, edgeIds }，第 i 个实例对应 edgeIds[i]（进入路口的边）。
 * 本地坐标：原点在地面，yaw=0 时"前方"为 +z（与 ChunkFormat 的 yaw 约定一致），len 沿 +z。
 * 杆状道具（路灯 / 信号灯杆 / 的士站牌 / 行道树）的 LTA 原始坐标约两成落在建模车行道里：加载时用 RoadClearance
 * 沿法线推到路缘外 0.5 m（实例与碰撞体一起移）；推不出的路灯/树直接不放，信号灯杆保留外观（灯头要用）但不建碰撞体。
 * ERP 龙门架的立柱不挪（横梁要对齐），立柱在车行道内就只去掉碰撞体。
 */

type PoolName = 'lamp' | 'signalPole' | 'signalHead' | 'busstop' | 'taxistand' | 'gantryBeam' | 'mrtexit' | 'linkwayRoof' | 'bridgeDeck' | 'stair' | 'post' | 'tree'
const POOL_NAMES: PoolName[] = ['lamp', 'signalPole', 'signalHead', 'busstop', 'taxistand', 'gantryBeam', 'mrtexit', 'linkwayRoof', 'bridgeDeck', 'stair', 'post', 'tree']

interface Entry { pool: PoolName; m: THREE.Matrix4; edgeId: number }

/** 灯头相对灯柱实例原点的偏移（DayNight 光晕用） */
export const LAMP_HEAD = new THREE.Vector3(0.5, 5.45, 0)
const SIGNAL_SNAP = 20
/** 杆状道具与路缘的净空 (m) */
const KERB_CLEAR = 0.5
const RED = new THREE.Color(0xff2b2b)
const tmpP: P2 = { x: 0, z: 0 }
const tmpV = new THREE.Vector3(), tmpQ = new THREE.Quaternion(), tmpS = new THREE.Vector3()
const Y_AXIS = new THREE.Vector3(0, 1, 0)

/** 给几何加上统一顶点色（合并后用一个 vertexColors 材质） */
function colored(g: THREE.BufferGeometry, hex: number): THREE.BufferGeometry {
  const c = new THREE.Color(hex)
  const n = g.attributes.position.count
  const arr = new Float32Array(n * 3)
  for (let k = 0; k < n; k++) { arr[k * 3] = c.r; arr[k * 3 + 1] = c.g; arr[k * 3 + 2] = c.b }
  g.setAttribute('color', new THREE.BufferAttribute(arr, 3))
  return g
}
const box = (w: number, h: number, d: number, x: number, y: number, z: number, hex: number) => colored(new THREE.BoxGeometry(w, h, d).translate(x, y, z), hex)
const cyl = (rt: number, rb: number, h: number, x: number, y: number, z: number, hex: number, seg = 6) => colored(new THREE.CylinderGeometry(rt, rb, h, seg).translate(x, y, z), hex)
const merge = (parts: THREE.BufferGeometry[]) => {
  const g = mergeGeometries(parts.map((p) => p.toNonIndexed()), false)!
  for (const p of parts) p.dispose()
  return g
}

const METAL = 0x4a4f57, DARK = 0x2b2f36, CONCRETE = 0x9a9ea5, WHITE = 0xe8eef5, BLUE = 0x2b6cb0

function makeGeometries(): Record<PoolName, THREE.BufferGeometry> {
  return {
    lamp: merge([cyl(0.1, 0.14, 5.5, 0, 2.75, 0, METAL), box(1.2, 0.25, 0.5, 0.5, 5.6, 0, METAL)]),
    signalPole: merge([cyl(0.07, 0.09, 3.6, 0, 1.8, 0, DARK), box(0.44, 1.3, 0.44, 0, 3.9, 0, DARK)]),
    signalHead: new THREE.BoxGeometry(0.5, 0.42, 0.5).translate(0, 3.9, 0),
    busstop: merge([
      box(1.5, 0.1, 4, 0, 2.6, 0, 0xdddfe3), box(0.05, 1.6, 4, -0.72, 1.7, 0, 0x9fb3c8),
      cyl(0.05, 0.05, 2.6, 0.7, 1.3, -1.9, METAL), cyl(0.05, 0.05, 2.6, 0.7, 1.3, 1.9, METAL),
      cyl(0.04, 0.04, 2.6, 0.7, 1.3, 2.4, METAL), box(0.06, 0.5, 0.45, 0.7, 2.35, 2.4, BLUE),
    ]),
    taxistand: merge([cyl(0.04, 0.05, 2.5, 0, 1.25, 0, METAL), box(0.6, 0.4, 0.06, 0, 2.2, 0, 0xf2c516)]),
    // 横梁单位长（沿 z），实例按 len 缩放 z
    gantryBeam: merge([box(0.5, 0.6, 1, 0, 5.6, 0, WHITE), box(0.52, 0.2, 1, 0, 5.3, 0, BLUE)]),
    mrtexit: merge([box(3, 3, 3, 0, 1.5, 0, 0x8f949c), box(3.6, 0.2, 3.6, 0, 3.1, 0, 0x5a5f66)]),   // 站名牌由 Signage 提供
    linkwayRoof: merge([box(2.5, 0.12, 1, 0, 2.75, 0, 0xb8bcc2)]),
    bridgeDeck: merge([box(2.5, 0.4, 1, 0, 5.5, 0, CONCRETE), box(0.08, 1.0, 1, -1.21, 6.2, 0, METAL), box(0.08, 1.0, 1, 1.21, 6.2, 0, METAL)]),
    stair: merge([box(2.5, 5.5, 4, 0, 2.75, 0, CONCRETE)]),
    // 单位高柱子，实例按高度缩放 y
    post: merge([cyl(0.12, 0.14, 1, 0, 0.5, 0, 0x6e7278)]),
    tree: merge([cyl(0.18, 0.25, 2.2, 0, 1.1, 0, 0x6b4a2b), colored(new THREE.ConeGeometry(2.2, 4.5, 7).translate(0, 4.2, 0), 0x3f7a2e)]),
  }
}

class Pool {
  mesh: THREE.InstancedMesh
  constructor(readonly name: PoolName, public geo: THREE.BufferGeometry, readonly mat: THREE.Material, capacity: number, readonly colorable: boolean) {
    this.mesh = this.make(capacity)
  }
  /** 换几何（外部模型加载完成后）；实例矩阵不动 */
  setGeometry(g: THREE.BufferGeometry) {
    const old = this.geo
    this.geo = g
    this.mesh.geometry = g
    old.dispose()
  }
  private make(capacity: number) {
    const m = new THREE.InstancedMesh(this.geo, this.mat, capacity)
    m.count = 0
    m.frustumCulled = false
    m.castShadow = !this.colorable
    m.receiveShadow = !this.colorable
    m.userData.castShadow = !this.colorable
    if (this.colorable) for (let k = 0; k < capacity; k++) m.setColorAt(k, RED)
    return m
  }
  /** 容量不够时换一个两倍容量的 InstancedMesh（旧的从父节点摘下并释放） */
  ensure(n: number): boolean {
    if (n <= this.mesh.instanceMatrix.count) return false
    let cap = this.mesh.instanceMatrix.count * 2
    while (cap < n) cap *= 2
    const old = this.mesh
    this.mesh = this.make(cap)
    this.mesh.name = old.name
    old.parent?.add(this.mesh)
    old.removeFromParent()
    old.dispose()
    return true
  }
}

export class PropMeshes {
  readonly group = new THREE.Group()
  readonly signalLights: SignalLights
  /** 灯柱池换了 InstancedMesh 时 +1 */
  lampsVersion = 0
  /** 每次 flush 实际重写实例时 +1，同步写到 scene.userData.lampsVersion（DayNight 据此重建路灯光晕） */
  version = 0
  private pools: Record<PoolName, Pool>
  private chunks = new Map<string, Entry[]>()
  private dirty = false
  private scene: THREE.Scene | null = null
  private signalNodes: RoadNode[] = []
  /** 信号路口簇 id → 从簇外进入的边（灯头只挂这些边，簇内部短边恒绿） */
  private incoming = new Map<number, RoadEdge[]>()
  private cluster: Int32Array
  private clear: RoadClearance
  /** 杆状道具净空修正统计（调试/验收用）：moved 推出车行道，dropped 推不出而去掉碰撞体，ms 为 addChunk 累计耗时 */
  readonly clearance = { moved: 0, dropped: 0, ms: 0 }

  constructor(private graph: RoadGraph, lampCapacity = 4096) {
    const geos = makeGeometries()
    const lambert = new THREE.MeshLambertMaterial({ vertexColors: true })
    const headMat = new THREE.MeshBasicMaterial({ color: 0xffffff })
    this.pools = {} as Record<PoolName, Pool>
    for (const name of POOL_NAMES) {
      const colorable = name === 'signalHead'
      const cap = name === 'lamp' ? lampCapacity : colorable ? 512 : 256
      const p = new Pool(name, geos[name], colorable ? headMat : lambert, cap, colorable)
      p.mesh.name = `prop:${name}`
      this.pools[name] = p
      this.group.add(p.mesh)
    }
    this.signalLights = { mesh: this.pools.signalHead.mesh, edgeIds: [] }
    for (const n of graph.nodes) if (n.signal) this.signalNodes.push(n)
    this.cluster = signalClusters(graph)
    for (const e of graph.edges) {
      const c = this.cluster[e.to.id]
      if (c < 0 || this.cluster[e.from.id] === c) continue
      const list = this.incoming.get(c) ?? []
      list.push(e); this.incoming.set(c, list)
    }
    this.clear = new RoadClearance(graph)
  }

  attach(scene: THREE.Scene) {
    this.scene = scene
    scene.add(this.group)
    scene.userData.lamps = this.pools.lamp.mesh
    scene.userData.lampHead = LAMP_HEAD.clone()
    scene.userData.signalLights = this.signalLights
  }

  /** 用外部模型替换某池的几何，按 scale 统一缩放（原点须在地面、+z 朝前） */
  useModel(pool: PoolName, geo: THREE.BufferGeometry, scale = 1) {
    const g = geo.clone()
    if (scale !== 1) g.scale(scale, scale, scale)
    this.pools[pool].setGeometry(g)
  }

  get stats() {
    let props = 0
    for (const list of this.chunks.values()) props += list.length
    return { props, pools: POOL_NAMES.map((n) => this.pools[n].mesh.count) }
  }

  /** 加入一个区块的道具；碰撞体追加到 bodies */
  addChunk(key: string, props: ChunkProp[], bodies: StaticBody[]) {
    if (this.chunks.has(key)) this.removeChunk(key)
    const entries: Entry[] = []
    const push = (pool: PoolName, x: number, z: number, yaw: number, sx = 1, sy = 1, sz = 1, edgeId = -1, lx = 0, lz = 0) => {
      // 本地偏移 (lx, lz) 先按 yaw 旋转：x' = x cos + z sin，z' = −x sin + z cos
      const c = Math.cos(yaw), s = Math.sin(yaw)
      tmpV.set(x + lx * c + lz * s, 0, z - lx * s + lz * c)
      tmpQ.setFromAxisAngle(Y_AXIS, yaw)
      tmpS.set(sx, sy, sz)
      entries.push({ pool, m: new THREE.Matrix4().compose(tmpV, tmpQ, tmpS), edgeId })
    }
    const aabb = (x: number, z: number, r: number, h: number) => bodies.push({ minX: x - r, maxX: x + r, minZ: z - r, maxZ: z + r, h })
    // 旋转矩形足迹（本地中心 (lx,lz)，尺寸 w×d）→ 多边形碰撞体
    const rect = (x: number, z: number, yaw: number, lx: number, lz: number, w: number, d: number, h: number) => {
      const c = Math.cos(yaw), s = Math.sin(yaw)
      const ring = new Float32Array(8)
      const corners = [[-w / 2, -d / 2], [w / 2, -d / 2], [w / 2, d / 2], [-w / 2, d / 2]]
      corners.forEach(([cx, cz], k) => { const px = lx + cx, pz = lz + cz; ring[k * 2] = x + px * c + pz * s; ring[k * 2 + 1] = z - px * s + pz * c })
      bodies.push(polyBody(ring, h))
    }
    // 本地点 → 世界
    const local = (x: number, z: number, yaw: number, lx: number, lz: number): [number, number] => {
      const c = Math.cos(yaw), s = Math.sin(yaw)
      return [x + lx * c + lz * s, z - lx * s + lz * c]
    }
    const t0 = performance.now()
    const st = this.clearance
    // 杆状道具推出车行道：返回新位置；推不出返回 null
    const fit = (x: number, z: number, r: number) => {
      const q = this.clear.fit(x, z, r, KERB_CLEAR)
      if (!q.moved) return q
      if (q.ok) st.moved++; else st.dropped++
      return q.ok ? q : null
    }
    for (const p of props) {
      const { yaw } = p
      let { x, z } = p
      switch (p.type) {
        case 0: {
          const q = fit(x, z, 0.2)
          if (!q) break                          // 落在路口圆心 / 夹缝里：数据误差，直接不放
          push('lamp', q.x, q.z, yaw); aabb(q.x, q.z, 0.2, 5.5)
          break
        }
        case 1: {
          const q = fit(x, z, 0.15)
          if (q) { x = q.x; z = q.z }
          const edgeId = this.signalEdge(x, z)
          push('signalPole', x, z, yaw)
          if (edgeId >= 0) push('signalHead', x, z, yaw, 1, 1, 1, edgeId)
          if (q) aabb(x, z, 0.15, 3.6)          // 推不出：保留外观（灯头）但不建碰撞体
          break
        }
        case 2: {
          push('busstop', x, z, yaw)
          for (const lz of [-1.9, 1.9, 2.4]) { const [px, pz] = local(x, z, yaw, 0.7, lz); aabb(px, pz, 0.12, 2.6) }
          rect(x, z, yaw, -0.72, 0, 0.1, 4, 1.7)
          break
        }
        case 3: {
          const q = fit(x, z, 0.1)
          if (q) { push('taxistand', q.x, q.z, yaw); aabb(q.x, q.z, 0.1, 2.5) }
          break
        }
        case 4: {
          const len = Math.max(4, p.len || 10)
          push('gantryBeam', x, z, yaw, 1, 1, len)
          for (const lz of [-len / 2, len / 2]) {
            push('post', x, z, yaw, 1.6, 5.6, 1.6, -1, 0, lz)
            const [px, pz] = local(x, z, yaw, 0, lz)
            if (this.clear.intrudes(px, pz, 0.22)) st.dropped++; else aabb(px, pz, 0.22, 5.6)
          }
          break
        }
        case 5: {
          // 地铁出口（3×3 m 盒，半对角 ≈ 2.1 m）：烘焙时已推出路缘，这里再兜底一次；
          // 仍侵入车行道则只渲染不建碰撞体，免得在路中间挡车
          const q = this.clear.fit(x, z, 2.2, 0.5)
          if (q.ok) { if (q.moved) st.moved++; x = q.x; z = q.z }
          push('mrtexit', x, z, yaw)
          if (q.ok && !this.clear.intrudes(x, z, 2.2)) rect(x, z, yaw, 0, 0, 3, 3, 3); else st.dropped++
          break
        }
        case 6: {
          const len = Math.max(2, p.len || 6)
          push('linkwayRoof', x, z, yaw, 1, 1, len)
          const n = Math.min(40, Math.floor(len / 6) + 1)
          const step = n > 1 ? len / (n - 1) : 0
          for (let k = 0; k < n; k++) {
            const lz = -len / 2 + step * k
            for (const lx of [-1.1, 1.1]) {
              push('post', x, z, yaw, 1, 2.75, 1, -1, lx, lz)
              const [px, pz] = local(x, z, yaw, lx, lz); aabb(px, pz, 0.14, 2.75)
            }
          }
          break
        }
        case 7: {
          const len = Math.max(4, p.len || 20)
          push('bridgeDeck', x, z, yaw, 1, 1, len)
          for (const sgn of [-1, 1]) {
            push('post', x, z, yaw, 2, 5.5, 2, -1, 0, sgn * (len / 2 - 0.5))
            // 楼梯（2.5×4，半对角 ≈ 2.4）沿桥轴向外找第一个不压车行道的位置，找不到就不放
            let off = -1
            for (let o = len / 2 + 2; o <= len / 2 + 10; o++) {
              const [px, pz] = local(x, z, yaw, 0, sgn * o)
              if (!this.clear.intrudes(px, pz, 2.4, 0.3)) { off = o; break }
            }
            if (off < 0) { st.dropped++; continue }
            push('stair', x, z, yaw, 1, 1, 1, -1, 0, sgn * off)
            rect(x, z, yaw, 0, sgn * off, 2.5, 4, 5.5)
          }
          break
        }
        case 8: {
          const s = rand(0.8, 1.3)
          const q = fit(x, z, 0.35)
          if (q) { push('tree', q.x, q.z, yaw, s, s, s); aabb(q.x, q.z, 0.35, 2.2) }
          break
        }
        default: break
      }
    }
    st.ms += performance.now() - t0
    this.chunks.set(key, entries)
    this.dirty = true
  }

  removeChunk(key: string) {
    if (this.chunks.delete(key)) this.dirty = true
  }

  /** 信号灯道具 → 进入路口的边：取 20 m 内最近的信号灯节点，在其所在路口簇的入边（簇外进入）里选停止线旁人行道点离道具最近的那条 */
  private signalEdge(x: number, z: number): number {
    let node: RoadNode | null = null, best = SIGNAL_SNAP * SIGNAL_SNAP
    for (const n of this.signalNodes) {
      const d = (n.x - x) * (n.x - x) + (n.z - z) * (n.z - z)
      if (d < best) { best = d; node = n }
    }
    if (!node) return -1
    const edges = this.incoming.get(this.cluster[node.id])
    if (!edges || !edges.length) return -1
    let bestE = edges[0], bestD = Infinity
    for (const e of edges) {
      this.graph.sidewalkPoint(e, e.length - e.to.jr - 0.8, tmpP)
      const d = (tmpP.x - x) * (tmpP.x - x) + (tmpP.z - z) * (tmpP.z - z)
      if (d < bestD) { bestD = d; bestE = e }
    }
    return bestE.id
  }

  /** 区块有增删时重写各池的实例缓冲 */
  flush() {
    if (!this.dirty) return
    this.dirty = false
    const counts = {} as Record<PoolName, number>
    for (const n of POOL_NAMES) counts[n] = 0
    for (const list of this.chunks.values()) for (const e of list) counts[e.pool]++
    for (const n of POOL_NAMES) {
      const pool = this.pools[n]
      if (pool.ensure(counts[n])) {
        if (n === 'lamp') { this.lampsVersion++; if (this.scene) this.scene.userData.lamps = pool.mesh }
        if (n === 'signalHead') this.signalLights.mesh = pool.mesh
      }
      counts[n] = 0
    }
    const edgeIds = this.signalLights.edgeIds
    edgeIds.length = 0
    for (const list of this.chunks.values()) for (const e of list) {
      const pool = this.pools[e.pool]
      pool.mesh.setMatrixAt(counts[e.pool]++, e.m)
      if (e.pool === 'signalHead') edgeIds.push(e.edgeId)
    }
    for (const n of POOL_NAMES) {
      const m = this.pools[n].mesh
      m.count = counts[n]
      m.instanceMatrix.needsUpdate = true
    }
    this.version++
    if (this.scene) this.scene.userData.lampsVersion = this.version
    const heads = this.pools.signalHead.mesh
    for (let k = 0; k < heads.count; k++) heads.setColorAt(k, RED)
    if (heads.instanceColor) heads.instanceColor.needsUpdate = true
    heads.userData.signalPhases = undefined   // 让 Signals.applyToMesh 重新刷新全部颜色
  }

  dispose() {
    for (const n of POOL_NAMES) { this.pools[n].mesh.dispose(); this.pools[n].geo.dispose() }
    this.group.removeFromParent()
  }
}
