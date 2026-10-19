import * as THREE from 'three'
import { MAX_PEDS, MAX_TRAFFIC, MAX_POLICE, SPAWN_MIN, SPAWN_MAX, DESPAWN_DIST, TAXI_COLORS, pick, rand } from '../config'
import type { Ctx } from '../core/Context'
import type { RoadEdge, P2 } from '../world/RoadGraph'
import { Vehicle } from '../entities/Vehicle'
import type { Pedestrians } from '../entities/Pedestrians'
import { TrafficAI, releaseToken } from '../entities/TrafficAI'
import type { PoliceAI } from '../entities/PoliceAI'

const CAR_COLORS = [0xc0392b, 0x2980b9, 0x27ae60, 0xf39c12, 0x8e44ad, 0xecf0f1, 0x2c3e50, 0x16a085, 0xd35400, 0x7f8c8d, 0xf5f5f5, 0x1f1f1f, 0xe84393, 0x74b9ff]
const tmp: P2 = { x: 0, z: 0 }
const tmpDir: P2 = { x: 0, z: 0 }
const camDir = new THREE.Vector3()

/** 在玩家周围环形区内生成/回收行人、交通车与警车 */
export class Spawner {
  traffic: Vehicle[] = []
  police: Vehicle[] = []
  /** 租用的士池（不参与自动回收） */
  taxis: Vehicle[] = []
  private timer = 0

  constructor(ctx: Ctx, private peds: Pedestrians, private trafficAI: TrafficAI, private policeAI: PoliceAI) {
    for (let i = 0; i < MAX_TRAFFIC; i++) {
      const v = new Vehicle('civil', pick(CAR_COLORS)); ctx.scene.add(v.group); ctx.vehicles.push(v); this.traffic.push(v)
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
      const e = ctx.graph.randomEdge()
      if (e.length < 14) continue
      if (forPed && e.kind === 'expressway') continue   // 行人不上快速路
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
    for (let i = trafficActive; i < MAX_TRAFFIC && budget > 0; i++) {
      const v = this.traffic.find((q) => !q.active); if (!v) break
      const spot = this.pickSpot(ctx, SPAWN_MIN, SPAWN_MAX, true); if (!spot) break
      ctx.graph.lanePoint(spot.edge, spot.t, tmp)
      if (ctx.vehicles.some((o) => o.active && Math.hypot(o.x - tmp.x, o.z - tmp.z) < 14)) continue
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
      const spot = v && this.pickSpot(ctx, 90, 150, true)
      if (v && spot) {
        ctx.graph.lanePoint(spot.edge, spot.t, tmp)
        ctx.graph.dirAt(spot.edge, spot.t, tmpDir)
        v.activate(tmp.x, tmp.z, Math.atan2(tmpDir.x, tmpDir.z))
        v.vx = tmpDir.x * 15; v.vz = tmpDir.z * 15
        this.policeAI.start(v, spot.edge, activePolice.length % 2 === 0 ? 1 : -1)
      }
    }
  }

  /** 确保指定位置附近存在一辆可用的空车（开局/重生用） */
  parkCarNear(ctx: Ctx, x: number, z: number, yaw: number): Vehicle | null {
    const v = this.traffic.find((q) => !q.active); if (!v) return null
    v.activate(x, z, yaw); v.driver = 'none'; v.controls.handbrake = true
    return v
  }

  /** 在指定位置停一辆的士（涂装随机 Comfort 蓝 / CityCab 黄）；池满则复用最旧的一辆 */
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
