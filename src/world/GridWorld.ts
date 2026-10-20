import type * as THREE from 'three'
import { CITY_MIN, CITY_MAX } from '../config'
import { RoadGraph } from './RoadGraph'
import { buildGridGraphData } from './GridGraph'
import { StaticWorld } from './Colliders'
import { CityGenerator } from './CityGenerator'
import { gridPois, type Poi } from '../systems/Poi'
import type { WorldSource } from './WorldSource'

/**
 * 方格城的 WorldSource 薄包装（回归基线，?world=grid）：
 * 路网 = GridGraph，POI = gridPois 合成集，attach 时由 CityGenerator 一次性生成整座城（无流式加载）。
 */
export class GridWorld implements WorldSource {
  readonly kind = 'grid' as const
  graph = new RoadGraph(buildGridGraphData())
  world = new StaticWorld()
  pois: Poi[]
  spawn: { x: number; z: number; yaw: number }
  bounds = { minX: CITY_MIN, maxX: CITY_MAX, minZ: CITY_MIN, maxZ: CITY_MAX }
  readonly ready = Promise.resolve()
  city: CityGenerator | null = null
  private minimap: HTMLCanvasElement | null = null

  constructor() {
    this.pois = gridPois(this.graph)
    const home = this.pois.find((p) => p.id === 'home_gang')
    this.spawn = home ? { ...home.door } : { x: 0, z: 0, yaw: 0 }
  }

  attach(scene: THREE.Scene) {
    if (this.city) return
    this.city = new CityGenerator(scene, this.graph, this.world)
    this.city.build()
  }

  update(_px: number, _pz: number, _dt: number) { /* 整城常驻，无需流式 */ }

  get stats() { return { loaded: 1, pending: 0, buildings: this.city?.buildings.length ?? 0, firstLoadMs: 0 } }

  /** 小地图底图：1 px/m，左上角 = (CITY_MIN, CITY_MIN)；按街区/楼房合成（需先 attach） */
  minimapBase(): HTMLCanvasElement {
    if (this.minimap) return this.minimap
    const span = CITY_MAX - CITY_MIN
    const base = document.createElement('canvas')
    base.width = base.height = Math.ceil(span)
    const c = base.getContext('2d')!
    c.fillStyle = '#5c5c63'; c.fillRect(0, 0, span, span)
    if (this.city) {
      for (const b of this.city.blocks) {
        c.fillStyle = b.park ? '#4f7a3a' : '#9d9d98'
        c.fillRect(b.cx - 23 - CITY_MIN, b.cz - 23 - CITY_MIN, 46, 46)
      }
      for (const b of this.city.buildings) {
        c.fillStyle = '#' + b.color.clone().multiplyScalar(0.85).getHexString()
        c.fillRect(b.box.minX - CITY_MIN, b.box.minZ - CITY_MIN, b.box.maxX - b.box.minX, b.box.maxZ - b.box.minZ)
      }
    }
    this.minimap = base
    return base
  }
}
