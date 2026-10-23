import * as THREE from 'three'
import { CHUNK_SIZE, chunkIndexOf, decodeChunk, type ChunkData, type Manifest } from './ChunkFormat'
import { polyBody, type StaticBody, type StaticWorld } from './Colliders'
import { GeomSink, appendBuilding, buildingColor, makeWallMaterial } from './BuildingMesh'
import { FACADE, makeFacadeMaterial } from './FacadeShader'
import type { PropMeshes } from './PropMeshes'
import type { RoadMarkings } from './RoadMarkings'
import type { Signage } from './Signage'
import { isReplaced } from './Landmarks'
import { makeRoadMaterial } from './RoadMaterial'
import { KERB_TOP, patchSidewalk } from './StreetShaders'
import { BuildingDetail } from './BuildingDetail'

/**
 * 区块流式加载：以玩家所在块为中心的 5×5 为目标集合，每帧最多发起 1 次 fetch、构建 1 个块；
 * 离开 7×7 的块卸载（释放几何、world.removeChunk、道具/标线实例移除）。
 * 每块产物：路面 Mesh（y=0）、人行道 Mesh（y=0.12，含运行时从人行道边界生成的路缘立面，见 buildWalkGeometry）、建筑合并 Mesh（窗格贴图 + 顶点色）、碰撞体、道具实例、标线实例、
 * 文字招牌（Signage，可选：只在玩家周围 5×5 块激活）。
 * P14.2 建筑几何细节件（BuildingDetail：女儿墙/檐口/屋顶设备/五脚基檐篷/空调外机/建筑前铺装）只在 3×3 内生成并合并成全局网格。
 */
export const LOAD_RADIUS = 2
export const UNLOAD_RADIUS = 3

export interface ChunkStats {
  /** 常驻（已构建）块数：目标 5×5 之外、7×7 之内的块保留不卸载，所以可达 49 */
  loaded: number
  /** 目标 5×5 里尚未构建完成的块数 */
  pending: number
  buildings: number
  props: number
  marks: number
  triangles: number
  failed: number
  /** P14.2 细节件：合并块数 / 三角数（细节 + 铺装）/ 每块生成耗时 */
  detailChunks: number
  detailTris: number
  detailGenMs: number
}

interface Built {
  key: string
  meshes: THREE.Mesh[]
  tris: number
  buildings: number
  props: number
}

const WALK_Y = 0.12
/** 路缘石顶高（比人行道高 3 cm）与宽 */
const KERB_H = 0.15
const KERB_W = 0.15
/** 外缘立面下沿：与地面同高（SgWorld 地面 y=−0.12） */
const OUTER_Y0 = -0.12
const tmpColor = new THREE.Color()

export class ChunkManager {
  readonly group = new THREE.Group()
  readonly roadMat = makeRoadMaterial({ side: THREE.DoubleSide })
  readonly walkMat = makeWalkMaterial()
  readonly wallMat: THREE.MeshLambertMaterial
  /** P14.1 程序化外墙（fx=high/low）；fx=off 用 wallMat。FACADE.on 由 DayNight 按画质写入，切档时整体换材质 */
  readonly facadeMat = makeFacadeMaterial()
  private facadeOn = FACADE.on
  private files = new Map<string, string>()
  private fetching = new Set<string>()
  private decoded = new Map<string, ChunkData>()
  private built = new Map<string, Built>()
  private failed = new Set<string>()
  private lastCenter = ''
  /** 累计被地标模型取代而跳过挤出的楼栋数（调试用） */
  replaced = 0
  private wanted: string[] = []
  /** P14.2 建筑几何细节件（3×3） */
  readonly detail: BuildingDetail

  constructor(
    private manifest: Manifest,
    private baseUrl: string,
    private world: StaticWorld,
    private props: PropMeshes,
    private marks: RoadMarkings,
    private signs: Signage | null = null,
  ) {
    this.group.name = 'chunks'
    for (const c of manifest.chunks) this.files.set(`${c.i}_${c.j}`, c.file)
    this.wallMat = makeWallMaterial()
    this.detail = new BuildingDetail(world, this.walkMat)
    this.group.add(this.detail.group)
  }

  private get bldMat(): THREE.Material { return this.facadeOn ? this.facadeMat : this.wallMat }

  attach(scene: THREE.Scene) {
    scene.add(this.group)
    const roads = (scene.userData.roads as THREE.Material[] | undefined) ?? []
    // 人行道也走 Weather 的天空环境反射（湿时），颜色/粗糙度由街面着色器按湿度自己算
    roads.push(this.roadMat, this.walkMat)
    scene.userData.roads = roads
    const windows = (scene.userData.windows as THREE.Material[] | undefined) ?? []
    windows.push(this.wallMat, this.facadeMat)
    scene.userData.windows = windows
  }

  get stats(): ChunkStats {
    let buildings = 0, props = 0, triangles = 0
    for (const b of this.built.values()) { buildings += b.buildings; props += b.props; triangles += b.tris }
    let pending = 0
    for (const k of this.wanted) if (!this.built.has(k)) pending++
    const d = this.detail.stats
    return {
      loaded: this.built.size, pending, buildings, props, marks: this.marks.count, triangles, failed: this.failed.size,
      detailChunks: d.chunks, detailTris: d.tris + d.apronTris, detailGenMs: d.genMsAvg,
    }
  }

  /** 目标集合里的块是否全部构建完成 */
  get idle() { return this.wanted.every((k) => this.built.has(k)) && this.decoded.size === 0 }

  update(px: number, pz: number) {
    const [ci, cj] = chunkIndexOf(px, pz, this.manifest.grid)
    const center = `${ci}_${cj}`
    if (center !== this.lastCenter) {
      this.lastCenter = center
      this.recomputeWanted(ci, cj)
      this.unloadFar(ci, cj)
      this.signs?.setCenter(ci, cj)
    }
    // 1. 发起一次 fetch（按距离排序的待取列表里第一个未取的）
    for (const key of this.wanted) {
      if (this.built.has(key) || this.decoded.has(key) || this.fetching.has(key) || this.failed.has(key)) continue
      this.fetch(key)
      break
    }
    // 2. 构建一个块（优先离中心近的）
    let built = false
    for (const key of this.wanted) {
      const data = this.decoded.get(key)
      if (!data) continue
      this.decoded.delete(key)
      this.build(key, data)
      built = true
      break
    }
    this.detail.update(ci, cj, FACADE.on, built)
    if (FACADE.on !== this.facadeOn) {
      this.facadeOn = FACADE.on
      for (const b of this.built.values()) for (const m of b.meshes) if (m.name.startsWith('bld:')) m.material = this.bldMat
    }
    this.props.flush()
    this.marks.flush()
    this.signs?.flush()
  }

  private recomputeWanted(ci: number, cj: number) {
    const { cols, rows } = this.manifest.grid
    const list: { key: string; d: number }[] = []
    for (let j = cj - LOAD_RADIUS; j <= cj + LOAD_RADIUS; j++) for (let i = ci - LOAD_RADIUS; i <= ci + LOAD_RADIUS; i++) {
      if (i < 0 || j < 0 || i >= cols || j >= rows) continue
      const key = `${i}_${j}`
      if (!this.files.has(key)) continue
      list.push({ key, d: (i - ci) * (i - ci) + (j - cj) * (j - cj) })
    }
    list.sort((a, b) => a.d - b.d)
    this.wanted = list.map((l) => l.key)
  }

  private unloadFar(ci: number, cj: number) {
    const far = (key: string) => {
      const [i, j] = key.split('_').map(Number)
      return Math.abs(i - ci) > UNLOAD_RADIUS || Math.abs(j - cj) > UNLOAD_RADIUS
    }
    for (const key of [...this.built.keys()]) if (far(key)) this.unload(key)
    for (const key of [...this.decoded.keys()]) if (far(key)) this.decoded.delete(key)
  }

  private fetch(key: string) {
    const url = this.baseUrl + this.files.get(key)!
    this.fetching.add(key)
    fetch(url)
      .then((r) => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.arrayBuffer() })
      .then((buf) => {
        this.fetching.delete(key)
        if (!this.wanted.includes(key)) return   // 已离开目标集合
        this.decoded.set(key, decodeChunk(buf))
      })
      .catch((err) => {
        this.fetching.delete(key)
        this.failed.add(key)
        console.error(`[SgWorld] 区块加载失败 ${url}:`, err)
      })
  }

  private build(key: string, c: ChunkData) {
    if (this.built.has(key)) this.unload(key)
    const meshes: THREE.Mesh[] = []
    let tris = 0
    const flat = (pos: Float32Array, idx: Uint32Array, y: number, mat: THREE.Material, name: string) => {
      if (idx.length < 3) return
      const n = pos.length >> 1
      const p = new Float32Array(n * 3), nrm = new Float32Array(n * 3)
      for (let k = 0; k < n; k++) { p[k * 3] = pos[k * 2]; p[k * 3 + 1] = y; p[k * 3 + 2] = pos[k * 2 + 1]; nrm[k * 3 + 1] = 1 }
      const g = new THREE.BufferGeometry()
      g.setAttribute('position', new THREE.BufferAttribute(p, 3))
      g.setAttribute('normal', new THREE.BufferAttribute(nrm, 3))
      g.setIndex(new THREE.BufferAttribute(idx.slice(), 1))
      g.computeBoundingSphere()
      const m = new THREE.Mesh(g, mat)
      m.name = `${name}:${key}`
      m.receiveShadow = true
      m.userData.castShadow = false
      meshes.push(m)
      tris += idx.length / 3
    }
    flat(c.roadPos, c.roadIdx, 0, this.roadMat, 'road')
    // 人行道：顶面 + 路缘/外缘立面合成一个几何（不增加 draw call）
    if (c.walkIdx.length >= 3) {
      const [i, j] = key.split('_').map(Number)
      const { minX, minZ } = this.manifest.grid
      const g = buildWalkGeometry(c, minX + i * CHUNK_SIZE, minZ + j * CHUNK_SIZE)
      const m = new THREE.Mesh(g, this.walkMat)
      m.name = `walk:${key}`
      m.receiveShadow = true
      m.userData.castShadow = false
      meshes.push(m)
      tris += (g.index!.count) / 3
    }

    // 建筑：合并成一个 Mesh；碰撞体按足迹。被地标精做模型取代的楼（Landmarks.isReplaced）只留碰撞体
    const bodies: StaticBody[] = []
    /** 被地标取代的楼（细节件也跳过） */
    const skip = new Uint8Array(c.buildings.length)
    if (c.buildings.length) {
      const sink = new GeomSink()
      for (let bi = 0; bi < c.buildings.length; bi++) {
        const b = c.buildings[bi]
        if (b.ring.length < 6) continue
        bodies.push(polyBody(b.ring, b.h))
        const name = b.nameIdx >= 0 ? c.names[b.nameIdx] : undefined
        if (b.cls === 4 || !name) {
          // 只有 landmark 类或无名楼才可能被替换（超级树 / Pinnacle 塔楼足迹无名）
          let cx = 0, cz = 0
          const n = b.ring.length >> 1
          for (let k = 0; k < b.ring.length; k += 2) { cx += b.ring[k]; cz += b.ring[k + 1] }
          if (isReplaced(name, cx / n, cz / n)) { this.replaced++; skip[bi] = 1; continue }
        }
        tris += appendBuilding(sink, b, buildingColor(b.cls, tmpColor, b.id))
      }
      if (sink.vertexCount) {
        const m = new THREE.Mesh(sink.toGeometry(), this.bldMat)
        m.name = `bld:${key}`
        m.castShadow = true; m.receiveShadow = true
        meshes.push(m)
      }
    }
    {
      const [i, j] = key.split('_').map(Number)
      const { minX, minZ } = this.manifest.grid
      this.detail.addChunk(key, c, skip, minX + i * CHUNK_SIZE, minZ + j * CHUNK_SIZE)
    }
    this.props.addChunk(key, c.props, bodies)
    this.marks.addChunk(key, c.marks)
    this.signs?.addChunk(key, c)
    this.world.addChunk(key, bodies)
    for (const m of meshes) this.group.add(m)
    this.built.set(key, { key, meshes, tris, buildings: c.buildings.length, props: c.props.length })
  }

  private unload(key: string) {
    const b = this.built.get(key)
    if (!b) return
    this.built.delete(key)
    for (const m of b.meshes) { this.group.remove(m); m.geometry.dispose() }
    this.world.removeChunk(key)
    this.props.removeChunk(key)
    this.marks.removeChunk(key)
    this.signs?.removeChunk(key)
    this.detail.removeChunk(key)
  }

  /** 全部卸载（切换世界时） */
  dispose() {
    for (const key of [...this.built.keys()]) this.unload(key)
    this.decoded.clear()
    this.wanted = []
    this.props.flush(); this.marks.flush(); this.signs?.flush()
    this.detail.dispose()
    this.roadMat.dispose(); this.walkMat.dispose(); this.wallMat.dispose(); this.facadeMat.dispose()
    this.group.removeFromParent()
  }
}

/** 人行道材质：Standard（湿时有天空反射）+ 程序化地砖/路缘着色器（StreetShaders.patchSidewalk） */
function makeWalkMaterial(): THREE.MeshStandardMaterial {
  const m = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.86, metalness: 0, side: THREE.DoubleSide })
  m.userData.receiveShadow = true
  m.userData.streetWet = true
  m.onBeforeCompile = patchSidewalk
  m.customProgramCacheKey = () => 'rea-walk-p143'
  return m
}

/**
 * 人行道几何：顶面（y=0.12）+ 由三角网边界生成的立面。
 * 边界边 = 只属于一个三角形的边（按 0.01 m 量化坐标配对，容忍不同多边形重复顶点）；块边界上的裁剪边跳过。
 * 外法线：边的垂线中背离所在三角形第三个顶点的方向。
 * 与路面边界重合（中点到路面边界线段距离 < 5 cm，2 m 网格桶查）的边 = 临车道路缘：
 *   立面 y −0.02→0.15（类型 1）+ 0.15 m 宽路缘石顶面（类型 3，高出人行道 3 cm）+ 内侧 3 cm 小立面（类型 4）；
 * 其余边 = 外缘（接地面/绿地）：立面 y −0.12→0.12（类型 2）。
 * 顶点属性：position / normal / aKerb = (面类型, 沿边弧长)。
 */
export function buildWalkGeometry(c: Pick<ChunkData, 'walkPos' | 'walkIdx' | 'roadPos' | 'roadIdx'>, x0: number, z0: number): THREE.BufferGeometry {
  const wp = c.walkPos, wi = c.walkIdx
  const nTop = wp.length >> 1
  const pos: number[] = [], nrm: number[] = [], kb: number[] = [], idx: number[] = []
  for (let k = 0; k < nTop; k++) { pos.push(wp[k * 2], WALK_Y, wp[k * 2 + 1]); nrm.push(0, 1, 0); kb.push(0, 0) }
  for (let k = 0; k < wi.length; k++) idx.push(wi[k])

  const q = (v: number) => Math.round(v * 100)
  /** 边界边：key → [a, b, 第三点]；出现第二次即删除 */
  const boundary = (P: Float32Array, I: Uint32Array) => {
    const map = new Map<string, [number, number, number]>()
    for (let t = 0; t < I.length; t += 3) {
      for (let e = 0; e < 3; e++) {
        const a = I[t + e], b = I[t + (e + 1) % 3], o = I[t + (e + 2) % 3]
        const ka = `${q(P[a * 2])},${q(P[a * 2 + 1])}`, kb2 = `${q(P[b * 2])},${q(P[b * 2 + 1])}`
        if (ka === kb2) continue
        const key = ka < kb2 ? ka + '|' + kb2 : kb2 + '|' + ka
        if (map.has(key)) map.delete(key)
        else map.set(key, [a, b, o])
      }
    }
    return map.values()
  }

  // 路面边界线段 → 2 m 网格桶
  const CELL = 2
  const rp = c.roadPos
  const segs: number[] = []
  const grid = new Map<number, number[]>()
  const cellKey = (ix: number, iz: number) => (ix + 1024) * 4096 + (iz + 1024)
  for (const [a, b] of boundary(rp, c.roadIdx)) {
    const ax = rp[a * 2], az = rp[a * 2 + 1], bx = rp[b * 2], bz = rp[b * 2 + 1]
    const s = segs.length / 4
    segs.push(ax, az, bx, bz)
    const ix0 = Math.floor((Math.min(ax, bx) - x0 - 0.1) / CELL), ix1 = Math.floor((Math.max(ax, bx) - x0 + 0.1) / CELL)
    const iz0 = Math.floor((Math.min(az, bz) - z0 - 0.1) / CELL), iz1 = Math.floor((Math.max(az, bz) - z0 + 0.1) / CELL)
    for (let iz = iz0; iz <= iz1; iz++) for (let ix = ix0; ix <= ix1; ix++) {
      const k = cellKey(ix, iz)
      let arr = grid.get(k)
      if (!arr) grid.set(k, (arr = []))
      arr.push(s)
    }
  }
  const nearRoad = (mx: number, mz: number) => {
    const arr = grid.get(cellKey(Math.floor((mx - x0) / CELL), Math.floor((mz - z0) / CELL)))
    if (!arr) return false
    for (const s of arr) {
      const ax = segs[s * 4], az = segs[s * 4 + 1], dx = segs[s * 4 + 2] - ax, dz = segs[s * 4 + 3] - az
      const L2 = dx * dx + dz * dz || 1
      const t = Math.max(0, Math.min(1, ((mx - ax) * dx + (mz - az) * dz) / L2))
      const ex = ax + dx * t - mx, ez = az + dz * t - mz
      if (ex * ex + ez * ez < 0.05 * 0.05) return true
    }
    return false
  }

  /** 竖直或水平四边形：a→b 底边，(ox,oz) 为顶边相对底边的水平偏移（竖直面为 0），y0→y1 */
  const quad = (ax: number, az: number, bx: number, bz: number, y0: number, y1: number, ox: number, oz: number,
    nx: number, ny: number, nz: number, type: number, sa: number, sb: number) => {
    const v = pos.length / 3
    pos.push(ax, y0, az, bx, y0, bz, bx + ox, y1, bz + oz, ax + ox, y1, az + oz)
    for (let k = 0; k < 4; k++) nrm.push(nx, ny, nz)
    kb.push(type, sa, type, sb, type, sb, type, sa)
    idx.push(v, v + 1, v + 2, v, v + 2, v + 3)
  }

  const x1 = x0 + CHUNK_SIZE, z1 = z0 + CHUNK_SIZE
  const onEdge = (u: number, w: number, e: number) => Math.abs(u - e) < 0.02 && Math.abs(w - e) < 0.02
  for (const [a, b, o] of boundary(wp, wi)) {
    const ax = wp[a * 2], az = wp[a * 2 + 1], bx = wp[b * 2], bz = wp[b * 2 + 1]
    // 块边界裁剪边：相邻块的人行道接着画，不是真实边缘
    if (onEdge(ax, bx, x0) || onEdge(ax, bx, x1) || onEdge(az, bz, z0) || onEdge(az, bz, z1)) continue
    const dx = bx - ax, dz = bz - az, L = Math.hypot(dx, dz)
    if (L < 1e-3) continue
    const tx = dx / L, tz = dz / L
    // 外法线：垂线 (−tz, tx) 若指向第三点则取反
    let nx = -tz, nz = tx
    if (nx * (wp[o * 2] - ax) + nz * (wp[o * 2 + 1] - az) > 0) { nx = -nx; nz = -nz }
    const sa = ax * tx + az * tz, sb = sa + L
    if (nearRoad((ax + bx) / 2, (az + bz) / 2)) {
      quad(ax, az, bx, bz, -0.02, KERB_H, 0, 0, nx, 0, nz, 1, sa, sb)
      quad(ax, az, bx, bz, KERB_H, KERB_H, -nx * KERB_W, -nz * KERB_W, 0, 1, 0, KERB_TOP, sa, sb)
      const ix = -nx * KERB_W, iz = -nz * KERB_W
      quad(ax + ix, az + iz, bx + ix, bz + iz, WALK_Y - 0.01, KERB_H, 0, 0, -nx, 0, -nz, 4, sa, sb)
    } else {
      quad(ax, az, bx, bz, OUTER_Y0, WALK_Y, 0, 0, nx, 0, nz, 2, sa, sb)
    }
  }

  const g = new THREE.BufferGeometry()
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3))
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3))
  g.setAttribute('aKerb', new THREE.Float32BufferAttribute(kb, 2))
  g.setIndex(pos.length / 3 > 65535 ? new THREE.Uint32BufferAttribute(idx, 1) : new THREE.Uint16BufferAttribute(idx, 1))
  g.computeBoundingSphere()
  return g
}

/** 世界坐标所在块的 key（调试用） */
export function chunkKeyAt(x: number, z: number, grid: { minX: number; minZ: number }): string {
  const [i, j] = chunkIndexOf(x, z, grid)
  return `${i}_${j}`
}

export { CHUNK_SIZE }
