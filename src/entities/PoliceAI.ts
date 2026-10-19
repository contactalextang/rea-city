import { clamp } from '../config'
import type { RoadEdge, P2 } from '../world/RoadGraph'
import type { Ctx } from '../core/Context'
import type { Vehicle } from './Vehicle'
import { projectT, steerTowards, throttleFor, obstacleAhead } from './TrafficAI'
import type { Pedestrians } from './Pedestrians'

export interface PoliceState {
  edge: RoadEdge; nextEdge: RoadEdge | null
  mode: 'path' | 'ram' | 'leave'
  side: number
  leaveTimer: number
  stuck: number
}
const tmp: P2 = { x: 0, z: 0 }

/** 警车：沿路网向玩家所在路口寻路，接近后直线追撞；通缉清零后离开 */
export class PoliceAI {
  constructor(private peds: Pedestrians) {}

  start(v: Vehicle, edge: RoadEdge, side: number) {
    v.driver = 'police'
    v.ai = { edge, nextEdge: null, mode: 'path', side, leaveTimer: 0, stuck: 0 } satisfies PoliceState
  }

  update(dt: number, ctx: Ctx) {
    const pl = ctx.player
    const px = pl.worldX, pz = pl.worldZ
    const playerLane = ctx.graph.nearestLane(px, pz)
    const playerEdge = playerLane.edge
    const playerNode = playerEdge.from
    for (const v of ctx.vehicles) {
      if (!v.active || v.driver !== 'police' || v.wrecked) continue
      const s = v.ai as PoliceState
      const dist = Math.hypot(px - v.x, pz - v.z)
      if (ctx.wantedStars === 0 && s.mode !== 'leave') { s.mode = 'leave'; s.leaveTimer = 0 }
      if (s.mode === 'leave') {
        s.leaveTimer += dt
        if (s.leaveTimer > 6 && dist > 90) { v.deactivate(); continue }
      } else {
        // 与玩家同一条路（任一方向）且 120m 内，或 40m 内 → 直接追撞
        const sameRoad = s.edge === playerEdge || s.edge === playerEdge.reverse
        const fx = Math.sin(v.yaw), fz = Math.cos(v.yaw)
        const behind = ((px - v.x) * fx + (pz - v.z) * fz) < 0
        s.mode = dist < 40 || (sameRoad && dist < 120) || (behind && dist < 70) ? 'ram' : 'path'
      }

      let targetSpeed: number
      if (s.mode === 'ram') {
        // 预判玩家位置，相邻警车各偏一侧包抄
        const lead = pl.inVehicle ? 0.45 : 0.1
        let tx = px + pl.worldVX * lead, tz = pz + pl.worldVZ * lead
        if (dist > 10) {
          const nx = -(pz - v.z) / dist, nz = (px - v.x) / dist
          tx += nx * s.side * 2.5; tz += nz * s.side * 2.5
        }
        v.controls.steer = steerTowards(v, tx, tz, 2.6)
        const fx = Math.sin(v.yaw), fz = Math.cos(v.yaw)
        const ahead = ((px - v.x) * fx + (pz - v.z) * fz) / Math.max(1, dist)
        const playerSlow = Math.hypot(pl.worldVX, pl.worldVZ) < 3
        // 玩家车停着：靠上去围堵（准备逮捕）而不是反复撞
        targetSpeed = pl.inVehicle ? (playerSlow && dist < 12 ? clamp(dist * 0.9, 1, 8) : 34) : clamp(dist * 1.3, 2, 16)
        // 目标在侧后方：减速掉头
        if (ahead < 0.3) targetSpeed = Math.min(targetSpeed, 7)
        if (pl.inVehicle && dist < 8 && !playerSlow) targetSpeed = 34
        v.controls.throttle = throttleFor(v, targetSpeed)
        if (!pl.inVehicle && dist < 7) v.controls.throttle = clamp(v.controls.throttle, -1, 0.3)
      } else {
        // 沿路网朝玩家所在路口
        let t = projectT(v, s.edge)
        ctx.graph.lanePoint(s.edge, clamp(t, 0, s.edge.length), tmp)
        if (Math.hypot(tmp.x - v.x, tmp.z - v.z) > 6) {
          const n = ctx.graph.nearestLane(v.x, v.z, Math.sin(v.yaw), Math.cos(v.yaw))
          s.edge = n.edge; s.nextEdge = null; t = n.t
        }
        const L = s.edge.length
        if (t >= L - 0.3) { s.edge = s.nextEdge ?? ctx.graph.nextTowards(s.edge, playerNode); s.nextEdge = null; t = projectT(v, s.edge) }
        if (!s.nextEdge) {
          if (s.mode === 'leave') s.nextEdge = ctx.graph.randomNext(s.edge)
          else {
            // 若下一条边就是玩家所在的路，优先选它
            const direct = ctx.graph.nextEdges(s.edge).find((o) => o === playerEdge || o === playerEdge.reverse)
            s.nextEdge = direct ?? ctx.graph.nextTowards(s.edge, playerNode)
          }
        }
        const look = t + 9
        if (look <= L) ctx.graph.lanePoint(s.edge, look, tmp)
        else ctx.graph.lanePoint(s.nextEdge, look - L, tmp)
        v.controls.steer = steerTowards(v, tmp.x, tmp.z, 2.4)
        const turning = s.nextEdge.dx !== s.edge.dx || s.nextEdge.dz !== s.edge.dz
        targetSpeed = s.mode === 'leave' ? 12 : 24
        if (turning && L - t < 14) targetSpeed = Math.min(targetSpeed, 9)
        const obs = obstacleAhead(v, ctx, this.peds, 14, 2.4)
        if (obs < 10 && s.mode === 'leave') targetSpeed = Math.min(targetSpeed, Math.max(0, (obs - 3) * 1.2))
        else if (obs < 6) targetSpeed = Math.min(targetSpeed, 6)
        v.controls.throttle = throttleFor(v, targetSpeed)
      }
      v.controls.handbrake = false
      if (targetSpeed > 2 && v.absSpeed < 0.4) s.stuck += dt; else s.stuck = 0
      if (s.stuck > 3) { v.controls.throttle = -1; v.controls.steer = -v.controls.steer; if (s.stuck > 4.5) s.stuck = 0 }
    }
  }
}
