import type * as THREE from 'three'
import type { RoadGraph } from './RoadGraph'
import type { StaticWorld } from './Colliders'
import type { Poi } from '../systems/Poi'

/**
 * 世界数据源抽象：Game 只依赖这个接口，不关心是方格城还是烘焙的真实城市。
 * - graph / world / pois 在 ready 兑现后即可用；
 * - attach 把静态网格挂进 scene（地面、天际线、道具实例集合、边界墙）；
 * - update 每帧按玩家位置做区块流式加载/卸载；
 * - minimapBase 给小地图提供 1 px/m 的底图，左上角对应 bounds.minX/minZ。
 */
export interface WorldSource {
  /** 'sg' 真实新加坡切片 / 'grid' 方格城 */
  readonly kind: 'sg' | 'grid'
  graph: RoadGraph
  world: StaticWorld
  pois: Poi[]
  /** 默认出生点（sg：home_gang 的门口） */
  spawn: { x: number; z: number; yaw: number }
  bounds: { minX: number; maxX: number; minZ: number; maxZ: number }
  attach(scene: THREE.Scene): void
  update(px: number, pz: number, dt: number): void
  minimapBase(): HTMLCanvasElement | HTMLImageElement
  readonly ready: Promise<void>
  /** 流式加载统计（loaded = 常驻块数，pending = 目标集合里未完成的块数） */
  readonly stats: { loaded: number; pending: number }
  /** 数据署名（开场覆盖层底部显示） */
  readonly attribution?: string[]
}
