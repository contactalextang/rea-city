import * as THREE from 'three'
import { rand } from '../config'
import { loadSettings } from '../core/Settings'
import type { ChunkProp } from './ChunkFormat'
import type { RoadGraph, RoadNode, RoadEdge, P2 } from './RoadGraph'
import { polyBody, type StaticBody } from './Colliders'
import { signalClusters, type SignalLights } from '../systems/Signals'
import { RoadClearance } from './RoadClearance'
import { LAMP_HEAD, PROP_UNIFORMS, SHAPES, SIGNAL, tintScale, makePropMaterial, makeSignalHeadMaterial, makeTreeMaterial, signalHead } from './PropShapes'

export { LAMP_HEAD }

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
 *
 * P14.4：形体全部改由 PropShapes 程序化生成（弯臂 LED 路灯、带悬臂的信号灯杆 + 遮光檐灯箱、新加坡式候车亭、MRT 出口亭…），
 * 另加 5 种街道小件池（railing / bin / hydrant / bollard / planter，06-props 沿人行道烘焙）。材质：除信号灯头外全部共用
 * PropShapes.makePropMaterial（Standard，金属度/粗糙度/夜间自发光逐顶点），行道树单独一个带逆光透射 + 风摆的材质；
 * ?fx=off 退回 Lambert。垃圾桶 / 消防栓的漆色编码在实例 y 缩放里（PropShapes.tintScale），不用 instanceColor，不额外分 program。
 * 路灯弯臂、信号灯悬臂、候车亭开口用 RoadClearance.roadDir 转向最近车行道；信号灯头朝进入路口的边的来车方向。
 */

type PoolName = 'lamp' | 'signalPole' | 'signalHead' | 'busstop' | 'taxistand' | 'gantryBeam' | 'mrtexit' | 'linkwayRoof' | 'bridgeDeck' | 'stair' | 'post' | 'tree'
  | 'railing' | 'bin' | 'hydrant' | 'bollard' | 'planter'
const POOL_NAMES: PoolName[] = ['lamp', 'signalPole', 'signalHead', 'busstop', 'taxistand', 'gantryBeam', 'mrtexit', 'linkwayRoof', 'bridgeDeck', 'stair', 'post', 'tree',
  'railing', 'bin', 'hydrant', 'bollard', 'planter']

interface Entry { pool: PoolName; m: THREE.Matrix4; edgeId: number }

const NO_CAST = new Set<PoolName>(['railing', 'bin', 'hydrant', 'bollard', 'planter'])
const SIGNAL_SNAP = 20
/** 杆状道具与路缘的净空 (m) */
const KERB_CLEAR = 0.5
const RED = new THREE.Color(0xff2b2b)
const tmpP: P2 = { x: 0, z: 0 }
const tmpD: P2 = { x: 0, z: 0 }
const tmpV = new THREE.Vector3(), tmpQ = new THREE.Quaternion(), tmpS = new THREE.Vector3()
const Y_AXIS = new THREE.Vector3(0, 1, 0)
/** 垃圾桶（绿 / 灰）与消防栓（红 / 黄）的漆色号（PropShapes.TINT_SRGB 下标），按坐标哈希挑 */
const BIN_TINTS = [0, 0, 0, 1, 1]
const HYDRANT_TINTS = [2, 2, 3]
/** 坐标整数哈希（确定性：同一道具每次加载颜色一致） */
const hash2 = (x: number, z: number) => ((Math.imul(Math.round(x * 10), 73856093) ^ Math.imul(Math.round(z * 10), 19349663)) >>> 0)
/** 让本地 +x 指向世界方向 (tx, tz) 的 yaw（本地 +x 在世界里是 (cos yaw, −sin yaw)） */
const yawFacingX = (tx: number, tz: number) => Math.atan2(-tz, tx)

function makeGeometries(): Record<PoolName, THREE.BufferGeometry> {
  const g = {} as Record<PoolName, THREE.BufferGeometry>
  for (const n of POOL_NAMES) g[n] = n === 'signalHead' ? signalHead() : SHAPES[n]()
  return g
}

class Pool {
  mesh: THREE.InstancedMesh
  /** colorable：信号灯头（Signals 每帧写 instanceColor） */
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
    // P14.4 新增小件（护栏 / 垃圾桶 / 消防栓 / 护柱 / 花槽）不投影：数量多、影子细碎，进 CSM 三级阴影 pass 不划算；仍接收阴影
    const cast = !this.colorable && !NO_CAST.has(this.name)
    m.castShadow = cast
    m.receiveShadow = !this.colorable
    m.userData.castShadow = cast
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
    // fx=off：退回 Lambert（启动时读一次档位；运行时切档沿用当前材质）
    let simple = false
    try { simple = loadSettings().fx === 'off' } catch { /* 非浏览器环境 */ }
    const propMat = makePropMaterial(simple)
    const treeMat = makeTreeMaterial(simple)
    const headMat = makeSignalHeadMaterial()
    this.pools = {} as Record<PoolName, Pool>
    for (const name of POOL_NAMES) {
      const colorable = name === 'signalHead'
      const cap = name === 'lamp' ? lampCapacity : colorable ? 1024 : 256
      const p = new Pool(name, geos[name], colorable ? headMat : name === 'tree' ? treeMat : propMat, cap, colorable)
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

  /** 每帧推进道具着色器时钟（树的风摆） */
  update(dt: number) {
    const u = PROP_UNIFORMS.uPropTime
    u.value = (u.value + dt) % 3600
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
    const push = (pool: PoolName, x: number, z: number, yaw: number, sx = 1, sy = 1, sz = 1, edgeId = -1, lx = 0, lz = 0, y = 0) => {
      // 本地偏移 (lx, lz) 先按 yaw 旋转：x' = x cos + z sin，z' = −x sin + z cos
      const c = Math.cos(yaw), s = Math.sin(yaw)
      tmpV.set(x + lx * c + lz * s, y, z - lx * s + lz * c)
      tmpQ.setFromAxisAngle(Y_AXIS, yaw)
      tmpS.set(sx, sy, sz)
      entries.push({ pool, m: new THREE.Matrix4().compose(tmpV, tmpQ, tmpS), edgeId })
    }
    // 朝最近车行道转 yaw（本地 +x 指向路面）；找不到（离路缘 > 3 m）返回 fallback
    const towardRoad = (x: number, z: number, fallback: number) => this.clear.roadDir(x, z, tmpD) ? yawFacingX(tmpD.x, tmpD.z) : fallback
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
          // 弯臂朝路面：灯头（LAMP_HEAD）伸到车行道上方
          push('lamp', q.x, q.z, towardRoad(q.x, q.z, yaw)); aabb(q.x, q.z, 0.2, 6)
          break
        }
        case 1: {
          const q = fit(x, z, 0.15)
          if (q) { x = q.x; z = q.z }
          const edgeId = this.signalEdge(x, z)
          // 杆：悬臂朝最近车行道；灯头：杆上一盏 + 悬臂末端一盏，都朝该入口边的来车方向（同 edgeId，Signals 一起变色）
          const py = towardRoad(x, z, yaw)
          push('signalPole', x, z, py)
          if (edgeId >= 0) {
            this.graph.dirAt(this.graph.edges[edgeId], this.graph.edges[edgeId].length, tmpD)
            const hy = Math.atan2(-tmpD.x, -tmpD.z)
            push('signalHead', x - tmpD.x * SIGNAL.headOut, z - tmpD.z * SIGNAL.headOut, hy, 1, 1, 1, edgeId, 0, 0, SIGNAL.poleHeadY)
            const [ax, az] = local(x, z, py, SIGNAL.armHeadX, 0)
            push('signalHead', ax, az, hy, 1, 1, 1, edgeId, 0, 0, SIGNAL.armHeadY)
          }
          if (q) aabb(x, z, 0.15, 5.6)          // 推不出：保留外观（灯头）但不建碰撞体
          break
        }
        case 2: {
          // 候车亭开口（+x）朝路面：数据 yaw 沿路，只需判断是否翻转 180°
          const y2 = this.clear.roadDir(x, z, tmpD) && tmpD.x * Math.cos(yaw) - tmpD.z * Math.sin(yaw) < 0 ? yaw + Math.PI : yaw
          push('busstop', x, z, y2)
          rect(x, z, y2, -1.0, 0, 0.36, 5.4, 2.5)                      // 后排立柱 + 玻璃挡板 + 广告灯箱
          rect(x, z, y2, -0.7, -1.0, 0.44, 2.6, 0.5)                   // 长椅
          { const [px, pz] = local(x, z, y2, 1.0, -3.3); aabb(px, pz, 0.08, 2.9) }   // 站牌柱
          break
        }
        case 3: {
          const q = fit(x, z, 0.1)
          if (q) { push('taxistand', q.x, q.z, yaw); aabb(q.x, q.z, 0.1, 2.6) }
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
        // ---- P14.4 街道小件（烘焙时已避开车行道 / 建筑 / 其它道具，这里不再挪位）；都建碰撞体：人走不过去、车撞得上 ----
        case 9: {
          // 护栏：按 2 m 一节平铺（整段均分，节长 = len / n），末端补一根立柱
          const len = Math.max(2, p.len || 4)
          const n = Math.max(1, Math.round(len / 2)), seg = len / n
          for (let k = 0; k < n; k++) push('railing', x, z, yaw, 1, 1, seg / 2, -1, 0, -len / 2 + (k + 0.5) * seg)
          push('post', x, z, yaw, 0.35, 1.05, 0.35, -1, 0, len / 2)
          rect(x, z, yaw, 0, 0, 0.12, len, 1.05)
          break
        }
        case 10: push('bin', x, z, yaw, 1, tintScale(BIN_TINTS[hash2(x, z) % BIN_TINTS.length])); aabb(x, z, 0.27, 1.05); break
        case 11: push('hydrant', x, z, yaw + (hash2(x, z) % 7) * 0.4, 1, tintScale(HYDRANT_TINTS[hash2(z, x) % HYDRANT_TINTS.length])); aabb(x, z, 0.18, 0.85); break
        case 12: push('bollard', x, z, yaw); aabb(x, z, 0.1, 0.9); break
        case 13: push('planter', x, z, yaw); rect(x, z, yaw, 0, 0, 0.5, 1.6, 0.6); break
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
