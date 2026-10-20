import * as THREE from 'three'
import { CHUNK_SIZE, chunkIndexOf, decodeChunk, type ChunkData, type Manifest } from './ChunkFormat'
import { polyBody, type StaticBody, type StaticWorld } from './Colliders'
import { GeomSink, appendBuilding, buildingColor, makeWallMaterial } from './BuildingMesh'
import type { PropMeshes } from './PropMeshes'
import type { RoadMarkings } from './RoadMarkings'
import type { Signage } from './Signage'
import { isReplaced } from './Landmarks'

/**
 * 区块流式加载：以玩家所在块为中心的 5×5 为目标集合，每帧最多发起 1 次 fetch、构建 1 个块；
 * 离开 7×7 的块卸载（释放几何、world.removeChunk、道具/标线实例移除）。
 * 每块产物：路面 Mesh（y=0）、人行道 Mesh（y=0.12）、建筑合并 Mesh（窗格贴图 + 顶点色）、碰撞体、道具实例、标线实例、
 * 文字招牌（Signage，可选：只在玩家周围 5×5 块激活）。
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
}

interface Built {
  key: string
  meshes: THREE.Mesh[]
  tris: number
  buildings: number
  props: number
}

const WALK_Y = 0.12
const tmpColor = new THREE.Color()

export class ChunkManager {
  readonly group = new THREE.Group()
  readonly roadMat = new THREE.MeshLambertMaterial({ color: 0x3b3b41, side: THREE.DoubleSide })
  readonly walkMat = new THREE.MeshLambertMaterial({ color: 0x9d9d98, side: THREE.DoubleSide })
  readonly wallMat: THREE.MeshLambertMaterial
  private files = new Map<string, string>()
  private fetching = new Set<string>()
  private decoded = new Map<string, ChunkData>()
  private built = new Map<string, Built>()
  private failed = new Set<string>()
  private lastCenter = ''
  /** 累计被地标模型取代而跳过挤出的楼栋数（调试用） */
  replaced = 0
  private wanted: string[] = []

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
  }

  attach(scene: THREE.Scene) {
    scene.add(this.group)
    const roads = (scene.userData.roads as THREE.Material[] | undefined) ?? []
    roads.push(this.roadMat)
    scene.userData.roads = roads
    const windows = (scene.userData.windows as THREE.Material[] | undefined) ?? []
    windows.push(this.wallMat)
    scene.userData.windows = windows
  }

  get stats(): ChunkStats {
    let buildings = 0, props = 0, triangles = 0
    for (const b of this.built.values()) { buildings += b.buildings; props += b.props; triangles += b.tris }
    let pending = 0
    for (const k of this.wanted) if (!this.built.has(k)) pending++
    return { loaded: this.built.size, pending, buildings, props, marks: this.marks.count, triangles, failed: this.failed.size }
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
    for (const key of this.wanted) {
      const data = this.decoded.get(key)
      if (!data) continue
      this.decoded.delete(key)
      this.build(key, data)
      break
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
    flat(c.walkPos, c.walkIdx, WALK_Y, this.walkMat, 'walk')

    // 建筑：合并成一个 Mesh；碰撞体按足迹。被地标精做模型取代的楼（Landmarks.isReplaced）只留碰撞体
    const bodies: StaticBody[] = []
    if (c.buildings.length) {
      const sink = new GeomSink()
      for (const b of c.buildings) {
        if (b.ring.length < 6) continue
        bodies.push(polyBody(b.ring, b.h))
        const name = b.nameIdx >= 0 ? c.names[b.nameIdx] : undefined
        if (b.cls === 4 || !name) {
          // 只有 landmark 类或无名楼才可能被替换（超级树 / Pinnacle 塔楼足迹无名）
          let cx = 0, cz = 0
          const n = b.ring.length >> 1
          for (let k = 0; k < b.ring.length; k += 2) { cx += b.ring[k]; cz += b.ring[k + 1] }
          if (isReplaced(name, cx / n, cz / n)) { this.replaced++; continue }
        }
        tris += appendBuilding(sink, b, buildingColor(b.cls, tmpColor))
      }
      if (sink.vertexCount) {
        const m = new THREE.Mesh(sink.toGeometry(), this.wallMat)
        m.name = `bld:${key}`
        m.castShadow = true; m.receiveShadow = true
        meshes.push(m)
      }
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
  }

  /** 全部卸载（切换世界时） */
  dispose() {
    for (const key of [...this.built.keys()]) this.unload(key)
    this.decoded.clear()
    this.wanted = []
    this.props.flush(); this.marks.flush(); this.signs?.flush()
    this.roadMat.dispose(); this.walkMat.dispose(); this.wallMat.dispose()
    this.group.removeFromParent()
  }
}

/** 世界坐标所在块的 key（调试用） */
export function chunkKeyAt(x: number, z: number, grid: { minX: number; minZ: number }): string {
  const [i, j] = chunkIndexOf(x, z, grid)
  return `${i}_${j}`
}

export { CHUNK_SIZE }
