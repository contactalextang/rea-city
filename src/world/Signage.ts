import * as THREE from 'three'
import { DRIVE_SIDE, SIDEWALK_W } from '../config'
import { chunkIndexOf, type ChunkData } from './ChunkFormat'
import type { RoadGraph, RoadEdge, RoadKind } from './RoadGraph'
import { isReplaced } from './Landmarks'
import { TextAtlas, FONT_CJK, FONT_LATIN, fitText, roundRect, type Painter, type SlotKind } from './TextAtlas'
import type { Poi } from '../systems/Poi'

/**
 * 文字类街景（一眼认出新加坡）：路名牌、组屋山墙楼号、店屋招牌、小贩中心大招牌、MRT 出口站名牌、
 * 巴士站候车亭站名、斑马线前 LOOK RIGHT/LEFT 地面字。
 * - 所有文字画进一张 2048² 文字图集（TextAtlas），按字符串去重 + 引用计数；
 * - 全部文字面板 = 一个 InstancedMesh（单位平面 + 每实例 uvRect 属性，onBeforeCompile 改 vMapUv），
 *   细杆 = 一个 InstancedMesh；整个世界的文字只占 2 个 draw call，不投影。
 * - 按区块组织：ChunkManager 构建/卸载块时 addChunk/removeChunk 计算/丢弃该块的招牌规格；
 *   只有离玩家所在块 ≤ ACTIVE_R 的块才"激活"（占图集槽、写实例），远处的字反正看不清。
 * - 路口/斑马线/小贩中心来自路网与 POI，构造时按所在块预分桶；楼号/店屋/巴士站/MRT 来自块数据。
 * 本地约定与 PropMeshes 一致：yaw=0 朝 +z；方向 (dx,dz) 的右侧为 (-dz, dx)。
 */

/** 激活半径（块）：5×5 */
export const SIGN_ACTIVE_R = 2
/** 每块最多店屋招牌数 */
const MAX_SHOP_PER_CHUNK = 40
/** 每块最多带 LOOK 字的斑马线数 */
const MAX_LOOK_PER_CHUNK = 6
const LOOK_KINDS: ReadonlySet<RoadKind> = new Set<RoadKind>(['trunk', 'primary', 'secondary'])
const ZEBRA_LEN = 2.4
/** 宽槽宽高比（256×56） */
const WIDE_ASPECT = 256 / 56
/** 楼号槽宽高比（128×56） */
const NUM_ASPECT = 128 / 56

interface SignItem { key: string; kind: SlotKind; paint: Painter; mats: THREE.Matrix4[] }
interface Bucket { items: SignItem[]; poles: THREE.Matrix4[] }
interface ChunkSigns extends Bucket { active: boolean; held: string[]; counts: Record<string, number> }

/** 带路名的原始路网（graph.json 的边带 name） */
export interface NamedGraphData { edges: { name?: string }[] }

const Y_AXIS = new THREE.Vector3(0, 1, 0)
const X_AXIS = new THREE.Vector3(1, 0, 0)
const tmpV = new THREE.Vector3(), tmpS = new THREE.Vector3()
const tmpQ = new THREE.Quaternion(), tmpQ2 = new THREE.Quaternion()

/** 竖直面板：中心 (x,y,z)，正面法线 (nx,nz)，宽 w 高 h */
function panel(x: number, y: number, z: number, nx: number, nz: number, w: number, h: number): THREE.Matrix4 {
  tmpQ.setFromAxisAngle(Y_AXIS, Math.atan2(nx, nz))
  return new THREE.Matrix4().compose(tmpV.set(x, y, z), tmpQ, tmpS.set(w, h, 1))
}
/** 双面竖直面板（背面实例 = 反向法线，前后各错开 1 cm） */
function panel2(x: number, y: number, z: number, nx: number, nz: number, w: number, h: number): THREE.Matrix4[] {
  return [panel(x + nx * 0.01, y, z + nz * 0.01, nx, nz, w, h), panel(x - nx * 0.01, y, z - nz * 0.01, -nx, -nz, w, h)]
}
/** 平躺地面字：文字"上方"朝 (ux,uz) */
function ground(x: number, y: number, z: number, ux: number, uz: number, w: number, h: number): THREE.Matrix4 {
  tmpQ.setFromAxisAngle(Y_AXIS, Math.atan2(-ux, -uz)).multiply(tmpQ2.setFromAxisAngle(X_AXIS, -Math.PI / 2))
  return new THREE.Matrix4().compose(tmpV.set(x, y, z), tmpQ, tmpS.set(w, h, 1))
}
/** 细杆：底部 (x,z)，高 h，半径缩放 r */
function pole(x: number, z: number, h: number, r = 1): THREE.Matrix4 {
  return new THREE.Matrix4().compose(tmpV.set(x, 0, z), tmpQ.identity(), tmpS.set(r, h, r))
}

/** 字符串 → 稳定 32 位哈希 */
function hash(s: string | number): number {
  const str = String(s)
  let h = 2166136261
  for (let k = 0; k < str.length; k++) { h ^= str.charCodeAt(k); h = Math.imul(h, 16777619) }
  return h >>> 0
}

// ---------------------------------------------------------------------------
// 画法
// ---------------------------------------------------------------------------

/** 新加坡路名牌：绿底、细白边、白色粗体 */
const paintStreet = (name: string): Painter => (c, w, h) => {
  c.fillStyle = '#0b6b3a'; c.fillRect(0, 0, w, h)
  c.strokeStyle = '#ffffff'; c.lineWidth = 2.5
  roundRect(c, 3, 3, w - 6, h - 6, 5); c.stroke()
  c.fillStyle = '#ffffff'
  fitText(c, name, w / 2, h / 2 + 1, w - 20, 30)
}

/** 组屋楼号：直接涂在墙上的大号数字（透明底） */
const paintBlk = (blk: string, color: string): Painter => (c, w, h) => {
  c.fillStyle = color
  fitText(c, blk, w / 2, h / 2 + 2, w - 8, 54, '900')
}

/** 店屋招牌：虚构中英文店名（无真实商标） */
const SHOPS: [string, string, string, string][] = [
  // 中文, 英文, 底色, 字色
  ['海南鸡饭', 'Hainanese Chicken Rice', '#b3171d', '#ffd84a'],
  ['咖啡店', 'Kopi Tiam', '#1d4e89', '#ffffff'],
  ['陈五金', "Tan's Hardware", '#f2e3b3', '#8a1515'],
  ['林记肉骨茶', 'Lim Kee Bak Kut Teh', '#5a2a12', '#f5d48a'],
  ['金福金庄', 'Kim Hock Goldsmith', '#c9a227', '#7a0f0f'],
  ['东兴药行', 'Tong Hing Medical Hall', '#0f5132', '#f0e6c0'],
  ['好味面家', 'Ho Mei Noodle House', '#e8e1d0', '#b01a1a'],
  ['华丰布行', 'Wah Fong Textiles', '#243b6b', '#f3d36b'],
  ['南洋饼家', 'Nanyang Confectionery', '#f7d046', '#7b1d1d'],
  ['阿坤叻沙', "Ah Kun's Laksa", '#d9480f', '#ffffff'],
  ['新兴茶室', 'Sin Heng Tea Room', '#2f6f4f', '#ffffff'],
  ['顺发电器', 'Soon Huat Electrical', '#ffffff', '#1d4ed8'],
  ['福来客栈', 'Hock Lai Inn', '#7a1f1f', '#f0c870'],
  ['大华眼镜', 'Tai Hwa Optical', '#0e3a5c', '#ffffff'],
  ['老曾炒粿条', 'Old Zeng Char Kway Teow', '#f2ead3', '#9b1c1c'],
  ['恒丰杂货', 'Heng Hong Provision Shop', '#3d5a1e', '#fff3b0'],
  ['美珍香料', 'Bee Tin Spices', '#a5402d', '#fff0d6'],
  ['友谊书局', 'Yew Ngee Bookstore', '#ffffff', '#14532d'],
  ['仁和中医', 'Jin Ho TCM Clinic', '#f5f0e1', '#14532d'],
  ['四海汇兑', 'Four Seas Money Changer', '#111827', '#facc15'],
  ['金兰娘惹糕', 'Kim Lan Nyonya Kueh', '#d6336c', '#ffffff'],
  ['德记烧腊', 'Teck Kee Roast Meat', '#991b1b', '#ffffff'],
  ['联合洗衣', 'United Laundry', '#e0f2fe', '#1e3a8a'],
  ['光明照相馆', 'Kwong Ming Photo Studio', '#312e81', '#fde68a'],
  ['竹林素食', 'Bamboo Grove Vegetarian', '#166534', '#ecfccb'],
  ['长春米铺', 'Tiang Choon Rice Dealer', '#fef3c7', '#78350f'],
  ['顺利摩托', 'Soon Lee Motor', '#1f2937', '#f97316'],
  ['宝珍茶庄', 'Poh Tin Tea Merchant', '#3f2a14', '#e9c46a'],
]
const paintShop = (k: number): Painter => (c, w, h) => {
  const [zh, en, bg, fg] = SHOPS[k]
  c.fillStyle = bg; c.fillRect(0, 0, w, h)
  c.strokeStyle = fg; c.lineWidth = 2; c.strokeRect(2, 2, w - 4, h - 4)
  c.fillStyle = fg
  fitText(c, zh, w / 2, 20, w - 16, 28, 'bold', FONT_CJK)
  fitText(c, en, w / 2, 44, w - 16, 14, 'bold', FONT_LATIN)
}

/** 小贩中心：深绿底白字，括号部分作副标题 */
const paintHawker = (name: string): Painter => (c, w, h) => {
  c.fillStyle = '#14532d'; c.fillRect(0, 0, w, h)
  c.fillStyle = '#f59e0b'; c.fillRect(0, h - 5, w, 5)
  c.fillStyle = '#ffffff'
  const m = /^(.*?)\s*\((.*)\)\s*$/.exec(name)
  if (m) {
    fitText(c, m[1], w / 2, 20, w - 14, 26)
    c.fillStyle = '#d1fae5'
    fitText(c, m[2], w / 2, 41, w - 14, 13, 'bold')
  } else fitText(c, name, w / 2, h / 2 - 2, w - 14, 28)
}

/** MRT 出口：深灰底，左侧线路代码色块，右侧站名 */
/** 数据缺 colour 时按线路代码前缀补官方线路色，仍未知则灰 */
const LINE_COLOURS: Record<string, string> = { EW: '#009645', CG: '#009645', NS: '#d42e12', NE: '#9016b2', CC: '#fa9e0d', CE: '#fa9e0d', DT: '#005ec4', TE: '#9d5b25' }
const paintMrt = (name: string, codes: { code: string; colour: string }[]): Painter => (c, w, h) => {
  c.fillStyle = '#2b2f36'; c.fillRect(0, 0, w, h)
  let x = 6
  const list = codes.length ? codes.slice(0, 3) : [{ code: 'MRT', colour: '#8a8f98' }]
  for (const { code, colour } of list) {
    c.font = `bold 15px ${FONT_LATIN}`
    const tw = Math.max(26, c.measureText(code).width + 8)
    c.fillStyle = colour; roundRect(c, x, 14, tw, 28, 5); c.fill()
    c.fillStyle = '#ffffff'; c.textAlign = 'center'; c.textBaseline = 'middle'; c.fillText(code, x + tw / 2, 29)
    x += tw + 4
  }
  c.fillStyle = '#ffffff'
  fitText(c, name, (x + w) / 2 + 1, h / 2 + 1, w - x - 8, 24)
}

/** 巴士站候车亭：深蓝底白字 + 站号 */
const paintBus = (name: string, code: string): Painter => (c, w, h) => {
  c.fillStyle = '#163a6b'; c.fillRect(0, 0, w, h)
  let right = w - 8
  if (code) {
    c.font = `bold 16px ${FONT_LATIN}`
    const tw = c.measureText(code).width + 10
    c.fillStyle = '#ffffff'; roundRect(c, w - tw - 6, 15, tw, 26, 4); c.fill()
    c.fillStyle = '#163a6b'; c.textAlign = 'center'; c.textBaseline = 'middle'; c.fillText(code, w - 6 - tw / 2, 29)
    right = w - tw - 12
  }
  c.fillStyle = '#ffffff'
  fitText(c, name, right / 2 + 4, h / 2 + 1, right - 10, 24)
}

/** 路面字：白色，透明底 */
const paintLook = (right: boolean): Painter => (c, w, h) => {
  c.fillStyle = '#f4f4f0'
  fitText(c, right ? 'LOOK RIGHT →' : '← LOOK LEFT', w / 2, h / 2 + 2, w - 8, 40, '900')
}

// ---------------------------------------------------------------------------
// 道路距离索引（店屋找临街面用；不走 RoadGraph.nearestLane 以免远离路网时全图扫描）
// ---------------------------------------------------------------------------
const RCELL = 32
class RoadSegIndex {
  private cells = new Map<number, number[]>()   // 每段 5 个数：ax az bx bz half
  private segs: number[] = []
  constructor(graph: RoadGraph) {
    for (const e of graph.edges) {
      if (e.reverse && e.reverse.id < e.id) continue
      const half = (e.lanes + (e.reverse ? e.reverse.lanes : 0)) * e.laneW / 2
      const n = e.pts.length >> 1
      for (let k = 0; k < n - 1; k++) {
        const s = this.segs.length / 5
        const ax = e.pts[k * 2], az = e.pts[k * 2 + 1], bx = e.pts[k * 2 + 2], bz = e.pts[k * 2 + 3]
        this.segs.push(ax, az, bx, bz, half)
        for (let cx = Math.floor(Math.min(ax, bx) / RCELL); cx <= Math.floor(Math.max(ax, bx) / RCELL); cx++)
          for (let cz = Math.floor(Math.min(az, bz) / RCELL); cz <= Math.floor(Math.max(az, bz) / RCELL); cz++) {
            const key = (cx + 4096) * 8192 + cz + 4096
            const l = this.cells.get(key)
            if (l) l.push(s); else this.cells.set(key, [s])
          }
      }
    }
  }
  /** 点到最近路面边缘的距离（≤0 = 在路面上）；附近 1 格内无路返回 Infinity */
  edgeDist(x: number, z: number): number {
    let best = Infinity
    const cx0 = Math.floor(x / RCELL), cz0 = Math.floor(z / RCELL)
    for (let cx = cx0 - 1; cx <= cx0 + 1; cx++) for (let cz = cz0 - 1; cz <= cz0 + 1; cz++) {
      const l = this.cells.get((cx + 4096) * 8192 + cz + 4096)
      if (!l) continue
      for (const s of l) {
        const o = s * 5, ax = this.segs[o], az = this.segs[o + 1], bx = this.segs[o + 2], bz = this.segs[o + 3]
        const dx = bx - ax, dz = bz - az, L2 = dx * dx + dz * dz
        const t = L2 > 0 ? Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / L2)) : 0
        const d = Math.hypot(x - ax - dx * t, z - az - dz * t) - this.segs[o + 4]
        if (d < best) best = d
      }
    }
    return best
  }
}

// ---------------------------------------------------------------------------
// 主类
// ---------------------------------------------------------------------------

export class Signage {
  readonly group = new THREE.Group()
  readonly atlas = new TextAtlas()
  textMesh: THREE.InstancedMesh
  poleMesh: THREE.InstancedMesh
  private textMat: THREE.MeshLambertMaterial
  private poleMat = new THREE.MeshLambertMaterial({ color: 0x5b6068 })
  private planeGeo = new THREE.PlaneGeometry(1, 1)
  private poleGeo = new THREE.CylinderGeometry(0.045, 0.05, 1, 6).translate(0, 0.5, 0)
  private uvArr: Float32Array
  private chunks = new Map<string, ChunkSigns>()
  /** 路网/POI 派生的招牌，按块预分桶 */
  private staticBuckets = new Map<string, Bucket>()
  private roads: RoadSegIndex
  private busPois: Poi[]
  private mrtPois: Poi[]
  private center: [number, number] = [-999, -999]
  private dirty = false
  /** 每次重写实例 +1（调试） */
  version = 0

  constructor(private graph: RoadGraph, rawGraph: NamedGraphData, pois: Poi[], private grid: { minX: number; minZ: number }) {
    this.group.name = 'signage'
    this.textMat = new THREE.MeshLambertMaterial({ map: this.atlas.texture, alphaTest: 0.5, emissive: 0x2a2a2a })
    this.textMat.onBeforeCompile = (sh) => {
      sh.vertexShader = sh.vertexShader
        .replace('#include <uv_pars_vertex>', '#include <uv_pars_vertex>\nattribute vec4 uvRect;')
        .replace('#include <uv_vertex>', '#include <uv_vertex>\n\tvMapUv = uvRect.xy + uv * uvRect.zw;')
    }
    this.textMat.customProgramCacheKey = () => 'signage-atlas'
    const tm = this.makeText(1024)
    this.textMesh = tm.mesh; this.uvArr = tm.uv
    this.poleMesh = this.makePole(512)
    this.group.add(this.textMesh, this.poleMesh)
    this.roads = new RoadSegIndex(graph)
    this.busPois = pois.filter((p) => p.type === 'bus')
    this.mrtPois = pois.filter((p) => p.type === 'mrt')
    const names = rawGraph.edges.map((e) => e.name)
    this.buildStreetSigns(names)
    this.buildLookText()
    this.buildHawkers(pois.filter((p) => p.type === 'hawker'))
  }

  attach(scene: THREE.Scene) { scene.add(this.group) }

  // ---------- 实例网格 ----------
  private makeText(cap: number) {
    const geo = this.planeGeo.clone()
    const uv = new Float32Array(cap * 4)
    geo.setAttribute('uvRect', new THREE.InstancedBufferAttribute(uv, 4))
    const m = new THREE.InstancedMesh(geo, this.textMat, cap)
    m.count = 0
    m.frustumCulled = false
    m.name = 'signage:text'
    m.castShadow = false; m.receiveShadow = false
    m.userData.castShadow = false
    return { mesh: m, uv }
  }
  private makePole(cap: number) {
    const m = new THREE.InstancedMesh(this.poleGeo, this.poleMat, cap)
    m.count = 0
    m.frustumCulled = false
    m.name = 'signage:poles'
    m.castShadow = false
    m.userData.castShadow = false
    return m
  }
  private ensureText(n: number) {
    const old = this.textMesh
    if (n <= old.instanceMatrix.count) return
    let cap = old.instanceMatrix.count * 2
    while (cap < n) cap *= 2
    const { mesh, uv } = this.makeText(cap)
    this.textMesh = mesh; this.uvArr = uv
    this.group.add(mesh)
    old.removeFromParent(); old.dispose(); old.geometry.dispose()
  }
  private ensurePole(n: number) {
    const old = this.poleMesh
    if (n <= old.instanceMatrix.count) return
    let cap = old.instanceMatrix.count * 2
    while (cap < n) cap *= 2
    this.poleMesh = this.makePole(cap)
    this.group.add(this.poleMesh)
    old.removeFromParent(); old.dispose()
  }

  // ---------- 分桶 ----------
  private keyAt(x: number, z: number) {
    const [i, j] = chunkIndexOf(x, z, this.grid)
    return `${i}_${j}`
  }
  private bucket(x: number, z: number): Bucket {
    const k = this.keyAt(x, z)
    let b = this.staticBuckets.get(k)
    if (!b) this.staticBuckets.set(k, (b = { items: [], poles: [] }))
    return b
  }

  /** 路名牌：每个路口最多 2 块不同路名，立在出边起点的路角人行道上，牌面与该路平行 */
  private buildStreetSigns(names: (string | undefined)[]) {
    for (const n of this.graph.nodes) {
      if (!n.junction || n.out.length < 3) continue
      const seen = new Set<string>()
      // 等级高的路优先
      const outs = n.out.filter((e) => names[e.id]).sort((a, b) => b.lanes * b.laneW - a.lanes * a.laneW)
      for (const e of outs) {
        const name = names[e.id]!
        if (seen.has(name)) continue
        if (seen.size >= 2) break
        seen.add(name)
        const along = Math.min(n.jr + 1.5, e.length * 0.4)
        const dx = e.dx, dz = e.dz, rx = -dz, rz = dx
        const half = (e.lanes + (e.reverse ? e.reverse.lanes : 0)) * e.laneW / 2
        const off = DRIVE_SIDE * (half + SIDEWALK_W * 0.65)
        const x = n.x + dx * along + rx * off, z = n.z + dz * along + rz * off
        const b = this.bucket(x, z)
        b.items.push({ key: `st:${name}`, kind: 'wide', paint: paintStreet(name), mats: panel2(x, 2.45, z, rx, rz, 1.6, 0.35) })
        b.poles.push(pole(x, z, 2.62))
      }
    }
  }

  /** 斑马线前 LOOK RIGHT/LEFT：只在 trunk/primary/secondary 上，路两侧各一块，放在来车一侧的斑马线旁 */
  private buildLookText() {
    const perChunk = new Map<string, number>()
    for (const e of this.graph.edges) {
      if (!LOOK_KINDS.has(e.kind) || !e.crossings.length) continue
      if (e.reverse && e.reverse.id < e.id) continue
      const W = (e.lanes + (e.reverse ? e.reverse.lanes : 0)) * e.laneW
      if (W < 6) continue
      for (const c of e.crossings) {
        const p = sampleEdge(e, c)
        const ck = this.keyAt(p.x, p.z)
        const used = perChunk.get(ck) ?? 0
        if (used >= MAX_LOOK_PER_CHUNK) continue
        perChunk.set(ck, used + 1)
        const rx = -p.dz, rz = p.dx
        for (const s of [-1, 1]) {
          // 行人站在 s 侧路缘，面朝对岸 f = −s·r
          const fx = -s * rx, fz = -s * rz
          // 最近车道的车流方向：双向路 +d 车流在 DRIVE_SIDE·r 一侧；单行道恒为 +d
          const sgn = e.reverse ? (s === DRIVE_SIDE ? 1 : -1) : 1
          const lookX = -sgn * p.dx, lookZ = -sgn * p.dz          // 来车方向
          const prX = -fz, prZ = fx                                // 行人右手
          const right = lookX * prX + lookZ * prZ > 0
          const w = 2.6, h = w / WIDE_ASPECT
          const along = ZEBRA_LEN / 2 + w / 2 + 0.3
          const cx = p.x + rx * s * (W / 2 - h / 2 - 0.35) + lookX * along
          const cz = p.z + rz * s * (W / 2 - h / 2 - 0.35) + lookZ * along
          this.bucket(p.x, p.z).items.push({ key: right ? 'look:R' : 'look:L', kind: 'wide', paint: paintLook(right), mats: [ground(cx, 0.03, cz, fx, fz, w, h)] })
        }
      }
    }
  }

  /** 小贩中心：门口向楼内退 1.5 m 立双柱大招牌，面朝马路 */
  private buildHawkers(list: Poi[]) {
    for (const p of list) {
      const { x: doorX, z: doorZ, yaw } = p.door
      const dx = Math.sin(yaw), dz = Math.cos(yaw)
      const lx = dz, lz = -dx                       // 门口朝向的左手 = 楼的方向（07-pois 约定）
      const x = doorX + lx * 1.5, z = doorZ + lz * 1.5
      const w = 6, h = w / WIDE_ASPECT
      const b = this.bucket(x, z)
      b.items.push({ key: `hk:${p.id}`, kind: 'wide', paint: paintHawker(p.name), mats: panel2(x, 4.1, z, -lx, -lz, w, h) })
      for (const s of [-1, 1]) b.poles.push(pole(x + dx * s * (w / 2 - 0.3), z + dz * s * (w / 2 - 0.3), 4.7, 2.4))
    }
  }

  // ---------- 区块生命周期 ----------
  addChunk(key: string, c: ChunkData) {
    if (this.chunks.has(key)) this.removeChunk(key)
    const st = this.staticBuckets.get(key)
    const items: SignItem[] = st ? st.items.slice() : []
    const poles: THREE.Matrix4[] = st ? st.poles.slice() : []
    const counts: Record<string, number> = { blk: 0, shop: 0, bus: 0, mrt: 0 }
    // 楼号表：09-chunks 以 `blk:<id>=<楼号>` 写在名称表
    const blk = new Map<number, string>()
    for (const s of c.names) {
      if (!s.startsWith('blk:')) continue
      const eq = s.indexOf('=')
      if (eq > 4) blk.set(Number(s.slice(4, eq)), s.slice(eq + 1))
    }
    for (const b of c.buildings) {
      if (b.ring.length < 6) continue
      if (b.cls !== 1 && b.cls !== 2) continue
      const name = b.nameIdx >= 0 ? c.names[b.nameIdx] : undefined
      if (!name) {
        // 与 ChunkManager 一致：被地标精做模型取代的楼不画字
        let cx = 0, cz = 0
        const n = b.ring.length >> 1
        for (let k = 0; k < b.ring.length; k += 2) { cx += b.ring[k]; cz += b.ring[k + 1] }
        if (isReplaced(name, cx / n, cz / n)) continue
      }
      if (b.cls === 1) {
        const no = blk.get(b.id)
        if (no && this.addBlk(items, b.ring, b.h, no, b.id)) counts.blk++
      } else if (counts.shop < MAX_SHOP_PER_CHUNK) {
        if (this.addShop(items, b.ring, b.id)) counts.shop++
      }
    }
    for (const p of c.props) {
      if (p.type === 2) { if (this.addBus(items, p.x, p.z, p.yaw)) counts.bus++ }
      else if (p.type === 5) { if (this.addMrt(items, p.x, p.z, p.yaw)) counts.mrt++ }
    }
    this.chunks.set(key, { items, poles, active: false, held: [], counts })
    this.dirty = true
  }

  removeChunk(key: string) {
    const ch = this.chunks.get(key)
    if (!ch) return
    for (const k of ch.held) this.atlas.release(k)
    this.chunks.delete(key)
    this.dirty = true
  }

  /** 玩家所在块变化时调用 */
  setCenter(ci: number, cj: number) {
    if (ci === this.center[0] && cj === this.center[1]) return
    this.center = [ci, cj]
    this.dirty = true
  }

  /** 组屋：在长轴两端的山墙高处画楼号 */
  private addBlk(items: SignItem[], ringIn: Float32Array, h: number, no: string, id: number): boolean {
    const ring = outerCCW(ringIn)
    const n = ring.length >> 1
    // 主轴（顶点 PCA）
    let mx = 0, mz = 0
    for (let k = 0; k < n; k++) { mx += ring[k * 2]; mz += ring[k * 2 + 1] }
    mx /= n; mz /= n
    let sxx = 0, szz = 0, sxz = 0
    for (let k = 0; k < n; k++) { const x = ring[k * 2] - mx, z = ring[k * 2 + 1] - mz; sxx += x * x; szz += z * z; sxz += x * z }
    const th = 0.5 * Math.atan2(2 * sxz, sxx - szz)
    const ax = Math.cos(th), az = Math.sin(th)
    type End = [number, number, number, number, number]   // proj, midx, midz, len, sign
    let best: End | null = null, worst: End | null = null
    for (let k = 0; k < n; k++) {
      const x0 = ring[k * 2], z0 = ring[k * 2 + 1], x1 = ring[((k + 1) % n) * 2], z1 = ring[((k + 1) % n) * 2 + 1]
      const len = Math.hypot(x1 - x0, z1 - z0)
      if (len < 4) continue
      const nx = -(z1 - z0) / len, nz = (x1 - x0) / len
      const dot = nx * ax + nz * az
      const midx = (x0 + x1) / 2, midz = (z0 + z1) / 2
      const proj = (midx - mx) * ax + (midz - mz) * az
      if (dot > 0.85 && (!best || proj > best[0])) best = [proj, midx, midz, len, 1]
      if (dot < -0.85 && (!worst || proj < worst[0])) worst = [proj, midx, midz, len, -1]
    }
    const color = hash(id) & 1 ? '#8e1b1b' : '#1f3a7a'
    const key = `blk:${no}:${color}`
    let added = false
    for (const e of [best, worst]) {
      if (!e) continue
      const [, midx, midz, len, sg] = e
      const dh = Math.min(2.4, (len * 0.8) / NUM_ASPECT)
      if (dh < 0.9) continue
      const nx = ax * sg, nz = az * sg
      const y = Math.max(dh / 2 + 3, h - dh / 2 - 1.6)
      items.push({ key, kind: 'num', paint: paintBlk(no, color), mats: [panel(midx + nx * 0.05, y, midz + nz * 0.05, nx, nz, dh * NUM_ASPECT, dh)] })
      added = true
    }
    return added
  }

  /** 店屋：临街面（外法线方向 4 m 处离路面最近的边）一层上方挂横招牌 */
  private addShop(items: SignItem[], ringIn: Float32Array, id: number): boolean {
    const ring = outerCCW(ringIn)
    const n = ring.length >> 1
    let best: { d: number; x: number; z: number; nx: number; nz: number; len: number } | null = null
    for (let k = 0; k < n; k++) {
      const x0 = ring[k * 2], z0 = ring[k * 2 + 1], x1 = ring[((k + 1) % n) * 2], z1 = ring[((k + 1) % n) * 2 + 1]
      const len = Math.hypot(x1 - x0, z1 - z0)
      if (len < 3) continue
      const nx = -(z1 - z0) / len, nz = (x1 - x0) / len
      const x = (x0 + x1) / 2, z = (z0 + z1) / 2
      const d = this.roads.edgeDist(x + nx * 4, z + nz * 4)
      if (d < this.roads.edgeDist(x, z) && (!best || d < best.d)) best = { d, x, z, nx, nz, len }
    }
    if (!best || best.d > 10) return false
    const w = Math.min(best.len * 0.85, 4.5), h = w / WIDE_ASPECT
    const k = hash(id) % SHOPS.length
    items.push({ key: `shop:${k}`, kind: 'wide', paint: paintShop(k), mats: [panel(best.x + best.nx * 0.06, 3.5 + h / 2, best.z + best.nz * 0.06, best.nx, best.nz, w, h)] })
    return true
  }

  /** 巴士站：候车亭顶上立站名牌（双面，沿路方向） */
  private addBus(items: SignItem[], x: number, z: number, yaw: number): boolean {
    const p = nearest(this.busPois, x, z, 40)
    if (!p) return false
    const c = Math.cos(yaw), s = Math.sin(yaw)
    const code = typeof p.meta?.code === 'string' ? p.meta.code : ''
    const w = 3, h = w / WIDE_ASPECT
    items.push({ key: `bus:${p.id}`, kind: 'wide', paint: paintBus(p.name, code), mats: panel2(x, 2.66 + h / 2, z, c, -s, w, h) })
    return true
  }

  /** MRT 出口：小屋顶两端的站名牌（站名 + 线路代码色块） */
  private addMrt(items: SignItem[], x: number, z: number, yaw: number): boolean {
    let p: Poi | null = null, bestD = 700
    for (const m of this.mrtPois) {
      const exits = (m.meta?.exits as { x: number; z: number }[] | undefined) ?? []
      for (const q of [{ x: m.x, z: m.z }, ...exits]) {
        const d = Math.hypot(q.x - x, q.z - z)
        if (d < bestD) { bestD = d; p = m }
      }
    }
    if (!p) return false
    const codes = Array.isArray(p.meta?.codes) ? (p.meta.codes as string[]) : []
    const colours = typeof p.meta?.colour === 'string' ? p.meta.colour.split(';') : []
    const pairs = codes.map((code, k) => ({ code, colour: /^#[0-9a-f]{3,8}$/i.test(colours[k] ?? '') ? colours[k] : LINE_COLOURS[code.slice(0, 2)] ?? '#8a8f98' }))
    const dx = Math.sin(yaw), dz = Math.cos(yaw)
    const w = 2.4, h = w / WIDE_ASPECT
    const item: SignItem = { key: `mrt:${p.id}`, kind: 'wide', paint: paintMrt(p.name, pairs), mats: [] }
    for (const s of [-1, 1]) item.mats.push(panel(x + dx * s * 1.63, 3.55, z + dz * s * 1.63, dx * s, dz * s, w, h))
    items.push(item)
    return true
  }

  // ---------- 刷新 ----------
  /** 块增删或中心变化后：激活/停用块（占/还图集槽），整体重写实例缓冲 */
  flush() {
    if (!this.dirty) return
    this.dirty = false
    const [ci, cj] = this.center
    // 先停用（释放槽），再激活，让闲置槽可被复用
    const toActivate: ChunkSigns[] = []
    for (const [key, ch] of this.chunks) {
      const [i, j] = key.split('_').map(Number)
      const want = Math.abs(i - ci) <= SIGN_ACTIVE_R && Math.abs(j - cj) <= SIGN_ACTIVE_R
      if (want === ch.active) continue
      if (!want) { for (const k of ch.held) this.atlas.release(k); ch.held = []; ch.active = false }
      else toActivate.push(ch)
    }
    for (const ch of toActivate) {
      ch.active = true
      for (const it of ch.items) if (this.atlas.acquire(it.key, it.kind, it.paint)) ch.held.push(it.key)
    }
    // 统计 + 扩容
    let nText = 0, nPole = 0
    const slotOf = new Map<string, readonly number[]>()
    for (const ch of this.chunks.values()) {
      if (!ch.active) continue
      const held = new Set(ch.held)
      for (const it of ch.items) if (held.has(it.key)) nText += it.mats.length
      nPole += ch.poles.length
    }
    this.ensureText(nText); this.ensurePole(nPole)
    let t = 0, q = 0
    for (const ch of this.chunks.values()) {
      if (!ch.active) continue
      const held = new Set(ch.held)
      for (const it of ch.items) {
        if (!held.has(it.key)) continue
        let r = slotOf.get(it.key)
        if (!r) { r = this.atlas.rectOf(it.key) ?? [0, 0, 0, 0]; slotOf.set(it.key, r) }
        for (const m of it.mats) {
          this.textMesh.setMatrixAt(t, m)
          this.uvArr.set(r, t * 4)
          t++
        }
      }
      for (const m of ch.poles) this.poleMesh.setMatrixAt(q++, m)
    }
    this.textMesh.count = t
    this.poleMesh.count = q
    this.textMesh.instanceMatrix.needsUpdate = true
    this.poleMesh.instanceMatrix.needsUpdate = true
    const attr = this.textMesh.geometry.getAttribute('uvRect') as THREE.InstancedBufferAttribute
    attr.needsUpdate = true
    this.atlas.flush()
    this.version++
  }

  get stats() {
    let active = 0, blk = 0, shop = 0, bus = 0, mrt = 0
    for (const ch of this.chunks.values()) {
      if (!ch.active) continue
      active++; blk += ch.counts.blk; shop += ch.counts.shop; bus += ch.counts.bus; mrt += ch.counts.mrt
    }
    return { chunks: this.chunks.size, active, text: this.textMesh.count, poles: this.poleMesh.count, blk, shop, bus, mrt, atlas: this.atlas.stats }
  }

  /** 调试：激活块里 key 以 prefix 开头的招牌（位置 + 正面法线），截图定位用 */
  find(prefix: string, limit = 20): { key: string; x: number; y: number; z: number; nx: number; ny: number; nz: number; ux: number; uz: number }[] {
    const out: { key: string; x: number; y: number; z: number; nx: number; ny: number; nz: number; ux: number; uz: number }[] = []
    const p = new THREE.Vector3(), q = new THREE.Quaternion(), sc = new THREE.Vector3(), nrm = new THREE.Vector3()
    for (const ch of this.chunks.values()) {
      if (!ch.active) continue
      for (const it of ch.items) {
        if (!it.key.startsWith(prefix) || !ch.held.includes(it.key)) continue
        it.mats[0].decompose(p, q, sc)
        nrm.set(0, 0, 1).applyQuaternion(q)
        const nx = nrm.x, ny = nrm.y, nz = nrm.z
        nrm.set(0, 1, 0).applyQuaternion(q)
        out.push({ key: it.key, x: p.x, y: p.y, z: p.z, nx, ny, nz, ux: nrm.x, uz: nrm.z })
        if (out.length >= limit) return out
      }
    }
    return out
  }

  dispose() {
    this.chunks.clear()
    this.textMesh.dispose(); this.textMesh.geometry.dispose()
    this.poleMesh.dispose()
    this.planeGeo.dispose(); this.poleGeo.dispose()
    this.textMat.dispose(); this.poleMat.dispose()
    this.atlas.dispose()
    this.group.removeFromParent()
  }
}

/** 边上弧长 t 处的位置与单位方向 */
function sampleEdge(e: RoadEdge, t: number): { x: number; z: number; dx: number; dz: number } {
  const n = e.pts.length >> 1
  let k = 0
  while (k < n - 2 && e.cum[k + 1] < t) k++
  const ax = e.pts[k * 2], az = e.pts[k * 2 + 1], bx = e.pts[k * 2 + 2], bz = e.pts[k * 2 + 3]
  const L = Math.hypot(bx - ax, bz - az) || 1
  const u = Math.max(0, Math.min(1, (t - e.cum[k]) / L))
  return { x: ax + (bx - ax) * u, z: az + (bz - az) * u, dx: (bx - ax) / L, dz: (bz - az) / L }
}

/** 返回俯视"逆时针"（鞋带 < 0，与 BuildingMesh 一致）的外环，使 (-dz, dx) 为外法线 */
function outerCCW(r: Float32Array): Float32Array {
  const n = r.length >> 1
  let a = 0
  for (let k = 0; k < n; k++) a += r[k * 2] * r[((k + 1) % n) * 2 + 1] - r[((k + 1) % n) * 2] * r[k * 2 + 1]
  if (a <= 0) return r
  const out = new Float32Array(r.length)
  for (let k = 0; k < n; k++) { out[k * 2] = r[(n - 1 - k) * 2]; out[k * 2 + 1] = r[(n - 1 - k) * 2 + 1] }
  return out
}

function nearest(list: Poi[], x: number, z: number, maxD: number): Poi | null {
  let best: Poi | null = null, bd = maxD
  for (const p of list) {
    const d = Math.hypot(p.x - x, p.z - z)
    if (d < bd) { bd = d; best = p }
  }
  return best
}

