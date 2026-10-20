import * as THREE from 'three'
import { MAX_PEDS, MAX_TRAFFIC, MAX_POLICE, SPAWN_MIN, SPAWN_MAX, DESPAWN_DIST, TAXI_COLORS, BUS_COLOR, pick, rand } from '../config'
import type { Ctx } from '../core/Context'
import type { RoadEdge, RoadKind, P2 } from '../world/RoadGraph'
import { Vehicle, type CarModel } from '../entities/Vehicle'
import type { Pedestrians } from '../entities/Pedestrians'
import { TrafficAI, releaseToken } from '../entities/TrafficAI'
import type { PoliceAI } from '../entities/PoliceAI'

/** 新加坡私家车配色：白 / 银 / 黑 / 灰占多数，少量彩色 */
const NEUTRAL_COLORS = [0xf4f4f4, 0xe9e9e6, 0xffffff, 0xc3c7cc, 0xa9adb3, 0x8a8f96, 0x5d6168, 0x3a3d42, 0x1b1c1f, 0x111214]
const ACCENT_COLORS = [0x8e1b1b, 0xb8282e, 0x1f3a7a, 0x2f6fb5, 0x3e5f4a, 0x6b4a32, 0xc9a66b, 0xd35400, 0x4a2c5e]
const LUXURY_COLORS = [0x0e0f12, 0x1c1f26, 0x2b2b2e, 0x3b0d12, 0x0d1b2a, 0xf2f2f2]
const carColor = () => (Math.random() < 0.72 ? pick(NEUTRAL_COLORS) : pick(ACCENT_COLORS))
const civilModel = (): CarModel => { const r = Math.random(); return r < 0.5 ? 'sedan' : r < 0.75 ? 'mpv' : 'suv' }
/** 巴士只在主干道 / 次干道 / 一级公路上生成 */
const BUS_ROADS: readonly RoadKind[] = ['trunk', 'primary', 'secondary']
const tmp: P2 = { x: 0, z: 0 }
const tmpDir: P2 = { x: 0, z: 0 }
const camDir = new THREE.Vector3()
/** 行人不走的道路等级（快速路、主干道没有人行道） */
const NO_WALK: readonly RoadKind[] = ['expressway', 'trunk']

/** 在玩家周围环形区内生成/回收行人、交通车与警车 */
export class Spawner {
  traffic: Vehicle[] = []
  police: Vehicle[] = []
  /** 租用的士池（不参与自动回收） */
  taxis: Vehicle[] = []
  /** 金领身份的私人豪车（开局停在家门口） */
  private ownCar: Vehicle | null = null
  private timer = 0

  /** maxTraffic：交通车池大小（方格城 MAX_TRAFFIC，真实城市更大） */
  constructor(ctx: Ctx, private peds: Pedestrians, private trafficAI: TrafficAI, private policeAI: PoliceAI, readonly maxTraffic = MAX_TRAFFIC) {
    // 交通车池：10% 巴士、8% 的士、少量豪车，其余私家车（轿车 / MPV / SUV）
    const nBus = Math.round(maxTraffic * 0.1), nTaxi = Math.round(maxTraffic * 0.08), nLux = Math.max(1, Math.round(maxTraffic * 0.04))
    for (let i = 0; i < maxTraffic; i++) {
      const v = i < nBus ? new Vehicle('bus', BUS_COLOR)
        : i < nBus + nTaxi ? new Vehicle('taxi', pick(TAXI_COLORS))
        : i < nBus + nTaxi + nLux ? new Vehicle('luxury', pick(LUXURY_COLORS))
        : new Vehicle('civil', carColor(), civilModel())
      ctx.scene.add(v.group); ctx.vehicles.push(v); this.traffic.push(v)
    }
    if (ctx.role.id === 'gold') {
      this.ownCar = new Vehicle('luxury', pick(LUXURY_COLORS)); ctx.scene.add(this.ownCar.group); ctx.vehicles.push(this.ownCar)
    }
    for (let i = 0; i < MAX_POLICE; i++) {
      const v = new Vehicle('police', 0xf4f4f4); ctx.scene.add(v.group); ctx.vehicles.push(v); this.police.push(v)
    }
    for (let i = 0; i < 2; i++) {
      const v = new Vehicle('taxi', TAXI_COLORS[i]); ctx.scene.add(v.group); ctx.vehicles.push(v); this.taxis.push(v)
    }
  }

  /** 玩家周围、且优先在相机后方的随机车道点 */
  private pickSpot(ctx: Ctx, min: number, max: number, behind: boolean, forPed = false): { edge: RoadEdge; t: number } | null {
    const px = ctx.player.worldX, pz = ctx.player.worldZ
    const cf = ctx.cam.camera.getWorldDirection(camDir)
    for (let k = 0; k < 24; k++) {
      // 只在玩家周围 max 半径内的路段里采样（真实路网全图采样几乎落不进环形区）
      const e = ctx.graph.randomEdgeNear(px, pz, max, forPed ? NO_WALK : undefined)
      if (!e) return null
      if (e.length < 14) continue
      const t = rand(6, e.length - 6)
      ctx.graph.lanePoint(e, t, tmp)
      const d = Math.hypot(tmp.x - px, tmp.z - pz)
      if (d < min || d > max) continue
      if (behind) {
        const dot = ((tmp.x - px) * cf.x + (tmp.z - pz) * cf.z) / d
        if (dot > 0.35 && k < 18) continue
      }
      return { edge: e, t }
    }
    return null
  }

  update(dt: number, ctx: Ctx, policeWanted: number) {
    this.timer -= dt
    if (this.timer > 0) return
    this.timer = 0.4
    const px = ctx.player.worldX, pz = ctx.player.worldZ
    // 回收
    for (const v of this.traffic) {
      if (!v.active || v.driver === 'player') continue
      const d = Math.hypot(v.x - px, v.z - pz)
      // 远离回收；报废车 20 秒后且不在眼前（>45m）回收
      if (d > DESPAWN_DIST || (v.wrecked && ctx.time - v.wreckedAt > 20 && d > 45)) { releaseToken(v); v.deactivate() }
    }
    // 行人
    let budget = 6
    while (budget-- > 0 && this.peds.activeCount < MAX_PEDS) {
      const spot = this.pickSpot(ctx, SPAWN_MIN * 0.6, SPAWN_MAX, true, true)
      if (!spot) break
      this.peds.spawnOnEdge(spot.edge, spot.t, ctx)
    }
    // 交通车
    budget = 2
    const trafficActive = this.traffic.filter((v) => v.active).length
    for (let i = trafficActive; i < this.maxTraffic && budget > 0; i++) {
      const spot = this.pickSpot(ctx, SPAWN_MIN, SPAWN_MAX, true); if (!spot) break
      // 随机取一辆空闲车（保持池内车型比例）；路段不允许巴士时只取非巴士
      const busOk = BUS_ROADS.includes(spot.edge.kind)
      const free = this.traffic.filter((q) => !q.active && (busOk || q.kind !== 'bus'))
      if (!free.length) break
      const v = pick(free)
      ctx.graph.lanePoint(spot.edge, spot.t, tmp)
      const gap = v.kind === 'bus' ? 20 : 14
      if (ctx.vehicles.some((o) => o.active && Math.hypot(o.x - tmp.x, o.z - tmp.z) < gap)) continue
      ctx.graph.dirAt(spot.edge, spot.t, tmpDir)
      v.activate(tmp.x, tmp.z, Math.atan2(tmpDir.x, tmpDir.z))
      if (!this.trafficAI.start(v, spot.edge, spot.t, ctx)) { v.deactivate(); continue }
      budget--
    }
    // 报废/离场的警车回收
    for (const v of this.police) {
      if (!v.active || v.driver === 'player') continue
      const d = Math.hypot(v.x - px, v.z - pz)
      if (d > DESPAWN_DIST || (v.wrecked && ctx.time - v.wreckedAt > 12 && d > 50)) v.deactivate()
    }
    // 警车：数量随星级
    const want = policeWanted
    const activePolice = this.police.filter((v) => v.active && v.driver === 'police')
    if (activePolice.length < want) {
      const v = this.police.find((q) => !q.active)
      const spot = v ? this.policeSpot(ctx) : null
      if (v && spot) {
        ctx.graph.lanePoint(spot.edge, spot.t, tmp)
        ctx.graph.dirAt(spot.edge, spot.t, tmpDir)
        v.activate(tmp.x, tmp.z, Math.atan2(tmpDir.x, tmpDir.z))
        v.vx = tmpDir.x * 15; v.vz = tmpDir.z * 15
        this.policeAI.start(v, spot.edge, activePolice.length % 2 === 0 ? 1 : -1)
      }
    }
  }

  /**
   * 警车出生点：在 90–150 m 环里抽几个候选，取沿路网开到玩家所在路段起点最近的那个
   * （真实城市单行道多，直线近的点可能要绕一大圈）
   */
  private policeSpot(ctx: Ctx): { edge: RoadEdge; t: number } | null {
    const g = ctx.graph
    const pl = g.nearestLane(ctx.player.worldX, ctx.player.worldZ)
    const target = pl.t < pl.edge.length / 2 ? pl.edge.from : pl.edge.to
    let best: { edge: RoadEdge; t: number } | null = null, bestD = Infinity
    for (let k = 0; k < 8; k++) {
      const s = this.pickSpot(ctx, 90, 150, k < 4)
      if (!s) continue
      const d = g.routeDist(s.edge, s.t, target)
      if (d < bestD) { bestD = d; best = s }
    }
    return best
  }

  /** 确保指定位置附近存在一辆可用的空车（开局/重生用） */
  parkCarNear(ctx: Ctx, x: number, z: number, yaw: number): Vehicle | null {
    // 金领：停自己的豪车；其他身份：一辆空闲私家车（不停巴士 / 的士）
    const own = this.ownCar && this.ownCar.driver !== 'player' ? this.ownCar : null
    const v = own ?? this.traffic.find((q) => !q.active && q.kind === 'civil') ?? this.traffic.find((q) => !q.active && q.kind !== 'bus')
    if (!v) return null
    v.activate(x, z, yaw); v.driver = 'none'; v.controls.handbrake = true
    return v
  }

  /** 在指定位置停一辆的士（涂装随机 Comfort / CityCab / Strides / TransCab）；池满则复用最旧的一辆 */
  parkTaxiNear(ctx: Ctx, x: number, z: number, yaw: number): Vehicle | null {
    const v = this.taxis.find((q) => !q.active) ?? this.taxis.find((q) => q.driver !== 'player') ?? null
    if (!v) return null
    v.setColor(pick(TAXI_COLORS))
    v.activate(x, z, yaw); v.driver = 'none'; v.controls.handbrake = true
    return v
  }
}

export function policeCountFor(stars: number) {
  return [0, 1, 2, 4, 5, MAX_POLICE][Math.min(5, Math.max(0, stars))]
}
