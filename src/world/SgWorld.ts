import * as THREE from 'three'
import { RoadGraph, type GraphData } from './RoadGraph'
import { StaticWorld } from './Colliders'
import { decodeSkyline, type Manifest } from './ChunkFormat'
import { CLS_COLORS } from './BuildingMesh'
import { PropMeshes } from './PropMeshes'
import { loadPropModels } from './PropModels'
import { RoadMarkings } from './RoadMarkings'
import { ChunkManager, type ChunkStats } from './ChunkManager'
import { Landmarks, skylineHidden } from './Landmarks'
import { Signage, type NamedGraphData } from './Signage'
import type { WorldSource } from './WorldSource'
import type { Poi } from '../systems/Poi'

/**
 * 真实新加坡世界（public/world/sg/ 的烘焙数据）：
 * ready 里并行拉取 manifest / graph / pois / landuse / skyline / minimap / ground；
 * attach 挂地面（ground.png 2 m/px）+ 外圈海面 + 天际线 + 道具/标线池 + 隐形边界墙；
 * update 驱动 ChunkManager 做 5×5 区块流式加载。
 * 地标（Landmarks）常驻：MBS / Flyer / Esplanade 等精做模型 + 滨海湾/新加坡河半透明水面；
 * 被替换的烘焙楼在区块构建与天际线里都跳过（碰撞体保留原足迹）。
 */

export interface LanduseData {
  palette: Record<string, string>
  parks: { ring: number[] }[]
  water: { ring: number[] }[]
}

const SEA_COLOR = 0x2f5d8a
const SEA_MARGIN = 2000

async function fetchJson<T>(url: string): Promise<T> {
  const r = await fetch(url).catch((e) => { throw new Error(`SgWorld: 请求失败 ${url}: ${e}`) })
  if (!r.ok) throw new Error(`SgWorld: HTTP ${r.status} ${url}`)
  return r.json() as Promise<T>
}
async function fetchBuffer(url: string): Promise<ArrayBuffer> {
  const r = await fetch(url).catch((e) => { throw new Error(`SgWorld: 请求失败 ${url}: ${e}`) })
  if (!r.ok) throw new Error(`SgWorld: HTTP ${r.status} ${url}`)
  return r.arrayBuffer()
}
function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => resolve(img)
    img.onerror = () => reject(new Error(`SgWorld: 图片加载失败 ${url}`))
    img.src = url
  })
}

export class SgWorld implements WorldSource {
  readonly kind = 'sg' as const
  graph!: RoadGraph
  world = new StaticWorld()
  pois: Poi[] = []
  spawn = { x: 0, z: 0, yaw: 0 }
  bounds = { minX: 0, maxX: 0, minZ: 0, maxZ: 0 }
  manifest!: Manifest
  landuse: LanduseData | null = null
  readonly ready: Promise<void>
  readonly group = new THREE.Group()
  chunks!: ChunkManager
  props!: PropMeshes
  marks!: RoadMarkings
  skyline: THREE.Mesh | null = null
  landmarks: Landmarks | null = null
  /** 文字类街景（路名牌 / 楼号 / 招牌 / LOOK RIGHT），?signs=0 关闭 */
  signs: Signage | null = null
  /** 天际线里因地标替换丢弃的三角数 */
  skylineDropped = 0
  /** 首个 5×5 全部构建完成的时间戳（performance.now），统计首屏用 */
  firstLoadedAt = 0
  private minimapImg!: HTMLImageElement
  private groundTex!: THREE.Texture
  private loadStart = performance.now()

  constructor(readonly baseUrl = '/world/sg/') {
    this.group.name = 'sgWorld'
    this.ready = this.load()
  }

  private async load() {
    const u = (f: string) => this.baseUrl + f
    this.manifest = await fetchJson<Manifest>(u('manifest.json'))
    const f = this.manifest.files
    const [graph, pois, landuse, sky, minimap, ground] = await Promise.all([
      fetchJson<GraphData>(u(f.graph)),
      fetchJson<{ pois: Poi[] }>(u(f.pois)),
      fetchJson<LanduseData>(u(f.landuse)).catch(() => null),
      fetchBuffer(u(f.skyline)),
      loadImage(u(f.minimap)),
      new THREE.TextureLoader().loadAsync(u(f.ground)).catch((e) => { throw new Error(`SgWorld: 贴图加载失败 ${u(f.ground)}: ${e}`) }),
    ])
    this.graph = new RoadGraph(graph)
    this.pois = pois.pois
    this.landuse = landuse
    this.minimapImg = minimap
    this.groundTex = ground
    this.bounds = { ...this.manifest.bbox }
    this.buildSkyline(sky)
    const home = this.pois.find((p) => p.id === 'home_gang')
    if (home) this.spawn = { ...home.door }
    else {
      const cx = (this.bounds.minX + this.bounds.maxX) / 2, cz = (this.bounds.minZ + this.bounds.maxZ) / 2
      const { edge, t } = this.graph.nearestLane(cx, cz)
      const p = this.graph.sidewalkPoint(edge, t, { x: 0, z: 0 })
      this.spawn = { x: p.x, z: p.z, yaw: 0 }
    }
    // 灯柱池容量：最坏 7×7 常驻块的道具总数上限（取道具最多的 49 块之和）
    const counts = this.manifest.chunks.map((c) => c.props).sort((a, b) => b - a)
    const bound = counts.slice(0, 49).reduce((s, n) => s + n, 0) || 4096
    this.props = new PropMeshes(this.graph, Math.max(1024, bound))
    // 行道树默认换成 threejsassets 低模（shade-tree 高 7.1 m，缩到程序化树的 6.45 m）；?props=proc 或加载失败保留程序化树
    if (typeof location !== 'undefined' && new URLSearchParams(location.search).get('props') !== 'proc') {
      const props = this.props
      loadPropModels().then((m) => { const g = m.get('shade-tree'); if (g) props.useModel('tree', g, 6.45 / 7.09) })
        .catch((e) => console.warn('[props] 外部模型加载失败，保留程序化道具', e))
    }
    this.marks = new RoadMarkings()
    const signsOff = typeof location !== 'undefined' && new URLSearchParams(location.search).get('signs') === '0'
    if (!signsOff) this.signs = new Signage(this.graph, graph as GraphData & NamedGraphData, this.pois, this.manifest.grid)
    this.chunks = new ChunkManager(this.manifest, this.baseUrl, this.world, this.props, this.marks, this.signs)
    this.addWalls()
  }

  private buildSkyline(buf: ArrayBuffer) {
    const raw = decodeSkyline(buf)
    // 丢弃落在地标替换足迹内的三角（按 xz 质心判断）
    const keep: number[] = []
    for (let t = 0; t < raw.cls.length; t += 3) {
      const p = raw.pos, o = t * 3
      if (!skylineHidden((p[o] + p[o + 3] + p[o + 6]) / 3, (p[o + 2] + p[o + 5] + p[o + 8]) / 3)) keep.push(t)
    }
    const pos = new Float32Array(keep.length * 9), cls = new Uint8Array(keep.length * 3)
    keep.forEach((t, i) => { pos.set(raw.pos.subarray(t * 3, t * 3 + 9), i * 9); cls.set(raw.cls.subarray(t, t + 3), i * 3) })
    this.skylineDropped = raw.cls.length / 3 - keep.length
    const n = cls.length
    if (!n) return
    const g = new THREE.BufferGeometry()
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3))
    const col = new Float32Array(n * 3)
    const c = new THREE.Color()
    // 每个三角一个明度扰动（±6%），同类别同基色
    for (let t = 0; t < n; t += 3) {
      const k = (t * 2654435761) >>> 0
      const jitter = 0.94 + ((k % 1000) / 1000) * 0.12
      c.setHex(CLS_COLORS[cls[t]] ?? CLS_COLORS[0]).multiplyScalar(jitter)
      for (let q = 0; q < 3; q++) { col[(t + q) * 3] = c.r; col[(t + q) * 3 + 1] = c.g; col[(t + q) * 3 + 2] = c.b }
    }
    g.setAttribute('color', new THREE.BufferAttribute(col, 3))
    g.computeVertexNormals()
    g.computeBoundingSphere()
    // polygonOffset 把天际线在深度上略微推后：近块的真实建筑与之重叠时由真实建筑胜出
    const mat = new THREE.MeshLambertMaterial({ vertexColors: true, polygonOffset: true, polygonOffsetFactor: 2, polygonOffsetUnits: 4 })
    this.skyline = new THREE.Mesh(g, mat)
    this.skyline.name = 'skyline'
    this.skyline.frustumCulled = true
    this.skyline.userData.castShadow = false
    this.skyline.receiveShadow = false
    this.group.add(this.skyline)
  }

  private addWalls() {
    const { minX, maxX, minZ, maxZ } = this.bounds
    const T = 2
    this.world.add({ minX: minX - T, maxX: minX, minZ: minZ - T, maxZ: maxZ + T }, 80)
    this.world.add({ minX: maxX, maxX: maxX + T, minZ: minZ - T, maxZ: maxZ + T }, 80)
    this.world.add({ minX: minX - T, maxX: maxX + T, minZ: minZ - T, maxZ: minZ }, 80)
    this.world.add({ minX: minX - T, maxX: maxX + T, minZ: maxZ, maxZ: maxZ + T }, 80)
  }

  attach(scene: THREE.Scene) {
    const { minX, maxX, minZ, maxZ } = this.bounds
    const w = maxX - minX, h = maxZ - minZ
    // 外圈海面
    const sea = new THREE.Mesh(new THREE.PlaneGeometry(w + SEA_MARGIN * 2, h + SEA_MARGIN * 2), new THREE.MeshLambertMaterial({ color: SEA_COLOR }))
    sea.rotation.x = -Math.PI / 2
    sea.position.set((minX + maxX) / 2, -0.2, (minZ + maxZ) / 2)
    sea.userData.castShadow = false
    sea.name = 'sea'
    // 地面：ground.png（2 m/px，上边 = minZ）
    const tex = this.groundTex
    tex.colorSpace = THREE.SRGBColorSpace
    tex.minFilter = THREE.LinearMipmapLinearFilter
    tex.magFilter = THREE.LinearFilter
    tex.anisotropy = 4
    const ground = new THREE.Mesh(new THREE.PlaneGeometry(w, h), new THREE.MeshLambertMaterial({ map: tex }))
    ground.rotation.x = -Math.PI / 2
    // 地面压低到 −0.12：给地标水面（−0.05）与路面（0）留出深度间隔
    ground.position.set((minX + maxX) / 2, -0.12, (minZ + maxZ) / 2)
    ground.userData.castShadow = false
    ground.receiveShadow = true
    ground.name = 'ground'
    this.group.add(sea, ground)
    scene.add(this.group)
    this.props.attach(scene)
    this.marks.attach(scene)
    this.signs?.attach(scene)
    this.chunks.attach(scene)
    // 地标（须在 DayNight.attachWorld 之前：它在那时读取 scene.userData.windows）
    this.landmarks = new Landmarks(this.landuse?.water ?? null)
    this.landmarks.attach(scene)
  }

  update(px: number, pz: number, dt: number) {
    this.chunks.update(px, pz)
    this.landmarks?.update(dt)
    if (!this.firstLoadedAt && this.chunks.idle && this.chunks.stats.loaded > 0) this.firstLoadedAt = performance.now()
  }

  /** 首个目标集合加载完成所用毫秒（未完成为 -1） */
  get firstLoadMs() { return this.firstLoadedAt ? Math.round(this.firstLoadedAt - this.loadStart) : -1 }

  minimapBase(): HTMLImageElement { return this.minimapImg }

  get attribution(): string[] { return this.manifest?.attribution ?? [] }

  get stats(): ChunkStats & { skylineTris: number } {
    const s = this.chunks.stats
    return { ...s, skylineTris: this.skyline ? this.skyline.geometry.attributes.position.count / 3 : 0 }
  }

  dispose() {
    this.chunks.dispose()
    this.landmarks?.dispose()
    this.props.dispose()
    this.marks.dispose()
    this.signs?.dispose()
    this.skyline?.geometry.dispose()
    this.groundTex.dispose()
    this.group.removeFromParent()
  }
}
