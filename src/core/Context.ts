import type * as THREE from 'three'
import type { RoadGraph } from '../world/RoadGraph'
import type { StaticWorld } from '../world/Colliders'
import type { Vehicle } from '../entities/Vehicle'
import type { Player } from '../entities/Player'
import type { ChaseCamera } from './Camera'
import type { Settings } from './Settings'
import type { Clock } from '../systems/Clock'
import type { Signals } from '../systems/Signals'
import type { RoleDef } from '../data/roles'

/** 各系统共享的只读上下文（由 Game 构造并填充） */
export interface Ctx {
  scene: THREE.Scene
  graph: RoadGraph
  world: StaticWorld
  vehicles: Vehicle[]
  player: Player
  cam: ChaseCamera
  time: number
  /** 警方响应热度（Law.pursuitLevel；只发罚单不出警时为 0），floor 即星级 */
  pursuitLevel: number
  settings: Settings
  clock: Clock
  signals: Signals
  role: RoleDef
}

export interface GameEvents {
  vehicleHitVehicle: { a: Vehicle; b: Vehicle; impulse: number }
  vehicleHitStatic: { v: Vehicle; impulse: number }
  vehicleHitPed: { v: Vehicle; speed: number }
  playerHitByVehicle: { v: Vehicle; impulse: number }
  vehicleWrecked: { v: Vehicle; byPlayer: boolean }
  carjack: { v: Vehicle; hadDriver: boolean }
}
type Handler<K extends keyof GameEvents> = (e: GameEvents[K]) => void

export class EventBus {
  private map = new Map<string, Handler<never>[]>()
  on<K extends keyof GameEvents>(k: K, h: Handler<K>) {
    const list = this.map.get(k) ?? []
    list.push(h as Handler<never>); this.map.set(k, list)
  }
  emit<K extends keyof GameEvents>(k: K, e: GameEvents[K]) {
    const list = this.map.get(k); if (!list) return
    for (const h of list) (h as Handler<K>)(e)
  }
}
