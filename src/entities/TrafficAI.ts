import { clamp, wrapAngle, dampAngle, LANE_OFFSET, ROAD } from '../config'
import type { RoadEdge, RoadNode, P2 } from '../world/RoadGraph'
import type { Ctx } from '../core/Context'
import type { Vehicle } from './Vehicle'
import type { Pedestrians } from './Pedestrians'

const JUNC = ROAD / 2          // 路口半径：边的直线段为 [JUNC, L-JUNC]

interface Turn { p0: P2; p1: P2; p2: P2; len: number }

export interface TrafficState {
  mode: 'kin' | 'phys' | 'return'
  edge: RoadEdge; nextEdge: RoadEdge
  seg: 'edge' | 'turn'; segT: number
  turn: Turn | null
  v: number                    // 运动学当前速度
  token: RoadNode | null
  wait: number; forceGo: number
  physTimer: number
  cruise: number
  dbg: string
}
const tmp: P2 = { x: 0, z: 0 }
const tmp2: P2 = { x: 0, z: 0 }

/** 把车辆位置投影到边的车道线上得到沿边距离 t */
export function projectT(v: { x: number; z: number }, e: RoadEdge) {
  const px = v.x - e.from.x - e.rx * LANE_OFFSET, pz = v.z - e.from.z - e.rz * LANE_OFFSET
  return px * e.dx + pz * e.dz
}

/** 朝目标点转向：返回 steer ∈ [-1,1]（正 = 右转） */
export function steerTowards(v: Vehicle, tx: number, tz: number, gain = 2.2) {
  const want = Math.atan2(tx - v.x, tz - v.z)
  const diff = wrapAngle(want - v.yaw)   // >0 需要增大 yaw = 左转
  return clamp(-diff * gain, -1, 1)
}

export function throttleFor(v: Vehicle, targetSpeed: number) {
  const err = targetSpeed - v.speed
  return clamp(err * 0.45, -1, 1)
}

/** 前方障碍检测：返回最近障碍的前向距离（无则 Infinity） */
export function obstacleAhead(v: Vehicle, ctx: Ctx, peds: Pedestrians, range: number, lateral: number) {
  const fx = Math.sin(v.yaw), fz = Math.cos(v.yaw)
  let best = Infinity
  for (const o of ctx.vehicles) {
    if (o === v || !o.active) continue
    const dx = o.x - v.x, dz = o.z - v.z
    const f = dx * fx + dz * fz
    if (f < 0.5 || f > range) continue
    const l = Math.abs(dx * fz - dz * fx)
    if (l < lateral) best = Math.min(best, f - 2.3)
  }
  for (const p of peds.peds) {
    if (!p.active || p.state === 'down') continue
    const dx = p.x - v.x, dz = p.z - v.z
    const f = dx * fx + dz * fz
    if (f < 0.5 || f > range * 0.8) continue
    const l = Math.abs(dx * fz - dz * fx)
    if (l < lateral * 0.8) best = Math.min(best, f - 2.0)
  }
  const pl = ctx.player
  if (!pl.inVehicle) {
    const dx = pl.x - v.x, dz = pl.z - v.z
    const f = dx * fx + dz * fz
    const l = Math.abs(dx * fz - dz * fx)
    if (f > 0.5 && f < range * 0.8 && l < lateral * 0.8) best = Math.min(best, f - 2.0)
  }
  return best
}

export function releaseToken(v: Vehicle) {
  const s = v.ai as TrafficState | null
  if (s?.token && s.token.occupant === v) s.token.occupant = null
  if (s) s.token = null
}

/** 两条车道线（A 的出口方向、B 的入口方向）的交点作为贝塞尔控制点；平行则取中点 */
function makeTurn(g: Ctx['graph'], a: RoadEdge, b: RoadEdge): Turn {
  const p0 = g.lanePoint(a, a.length - JUNC, { x: 0, z: 0 })
  const p2 = g.lanePoint(b, JUNC, { x: 0, z: 0 })
  const cross = a.dx * b.dz - a.dz * b.dx
  let p1: P2
  if (Math.abs(cross) < 1e-3) p1 = { x: (p0.x + p2.x) / 2, z: (p0.z + p2.z) / 2 }
  else {
    // p0 + a.dir*s = p2 - b.dir*u  →  解 s
    const rx = p2.x - p0.x, rz = p2.z - p0.z
    const s = (rx * b.dz - rz * b.dx) / cross
    p1 = { x: p0.x + a.dx * s, z: p0.z + a.dz * s }
  }
  let len = 0, lx = p0.x, lz = p0.z
  for (let i = 1; i <= 8; i++) { bez(p0, p1, p2, i / 8, tmp); len += Math.hypot(tmp.x - lx, tmp.z - lz); lx = tmp.x; lz = tmp.z }
  return { p0, p1, p2, len }
}
function bez(p0: P2, p1: P2, p2: P2, u: number, out: P2) {
  const a = (1 - u) * (1 - u), b = 2 * (1 - u) * u, c = u * u
  out.x = a * p0.x + b * p1.x + c * p2.x
  out.z = a * p0.z + b * p1.z + c * p2.z
  return out
}

/**
 * 交通 NPC：运动学沿车道直线 + 路口贝塞尔弧线行驶，路口令牌放行，前方避让；
 * 被撞后进入物理模式滑行，再用物理转向归队。
 */
export class TrafficAI {
  constructor(private peds: Pedestrians) {}

  start(v: Vehicle, edge: RoadEdge, t: number, ctx: Ctx) {
    v.driver = 'traffic'
    v.kinematic = true
    const segT = clamp(t, JUNC, edge.length - JUNC)
    v.ai = {
      mode: 'kin', edge, nextEdge: ctx.graph.randomNext(edge), seg: 'edge', segT, turn: null,
      v: 8, token: null, wait: 0, forceGo: 0, physTimer: 0, cruise: 10 + Math.random() * 3, dbg: '',
    } satisfies TrafficState
    ctx.graph.lanePoint(edge, segT, tmp)
    v.x = tmp.x; v.z = tmp.z; v.yaw = Math.atan2(edge.dx, edge.dz)
    v.vx = edge.dx * 8; v.vz = edge.dz * 8
  }

  /** 被明显撞击时由 Game 调用：切换为物理滑行 */
  knock(v: Vehicle) {
    const s = v.ai as TrafficState | null
    if (!s || s.mode === 'phys') return
    s.mode = 'phys'; s.physTimer = 2
    v.kinematic = false
    releaseToken(v)
  }

  update(dt: number, ctx: Ctx) {
    for (const v of ctx.vehicles) {
      if (!v.active || v.driver !== 'traffic' || v.wrecked) continue
      const s = v.ai as TrafficState
      if (s.mode === 'phys') this.updatePhys(v, s, dt, ctx)
      else if (s.mode === 'return') this.updateReturn(v, s, dt, ctx)
      else this.updateKin(v, s, dt, ctx)
    }
  }

  private updatePhys(v: Vehicle, s: TrafficState, dt: number, ctx: Ctx) {
    s.physTimer -= dt
    v.controls.throttle = 0; v.controls.steer = 0; v.controls.handbrake = true
    if (s.physTimer <= 0 && v.absSpeed < 3) {
      const n = ctx.graph.nearestLane(v.x, v.z, Math.sin(v.yaw), Math.cos(v.yaw))
      s.edge = n.edge; s.nextEdge = ctx.graph.randomNext(n.edge)
      s.mode = 'return'
    }
    s.dbg = `phys ${s.physTimer.toFixed(1)}`
  }

  private updateReturn(v: Vehicle, s: TrafficState, dt: number, ctx: Ctx) {
    // 物理转向开回车道：接近且对齐后切回运动学
    const t = projectT(v, s.edge)
    const L = s.edge.length
    if (t > L - JUNC - 2 || t < 0) {
      // 投影越界：重新选边
      const n = ctx.graph.nearestLane(v.x, v.z, Math.sin(v.yaw), Math.cos(v.yaw))
      s.edge = n.edge; s.nextEdge = ctx.graph.randomNext(n.edge)
    }
    ctx.graph.lanePoint(s.edge, clamp(t, 0, L), tmp)
    const dist = Math.hypot(tmp.x - v.x, tmp.z - v.z)
    const align = Math.sin(v.yaw) * s.edge.dx + Math.cos(v.yaw) * s.edge.dz
    if (dist < 1.2 && align > 0.95) {
      s.mode = 'kin'; s.seg = 'edge'; s.segT = clamp(t, JUNC, L - JUNC); s.turn = null
      s.v = Math.max(0, v.speed); v.kinematic = true
      return
    }
    ctx.graph.lanePoint(s.edge, clamp(t + 6, 0, L), tmp2)
    v.controls.steer = steerTowards(v, tmp2.x, tmp2.z, 2.5)
    const obs = obstacleAhead(v, ctx, this.peds, 10, 2.2)
    let target = align < 0 ? 3 : 6
    if (obs < 6) target = 0
    v.controls.throttle = throttleFor(v, target)
    v.controls.handbrake = false
    // 卡住太久：直接瞬移回车道（通常在视野外）
    s.wait = v.absSpeed < 0.5 ? s.wait + dt : 0
    if (s.wait > 6) {
      s.wait = 0
      ctx.graph.lanePoint(s.edge, clamp(t, JUNC, L - JUNC), tmp)
      v.x = tmp.x; v.z = tmp.z; v.yaw = Math.atan2(s.edge.dx, s.edge.dz); v.vx = v.vz = 0
    }
    s.dbg = `return d${dist.toFixed(1)} al${align.toFixed(2)}`
  }

  private updateKin(v: Vehicle, s: TrafficState, dt: number, ctx: Ctx) {
    const g = ctx.graph
    const E = s.edge, L = E.length
    let targetSpeed = s.cruise
    const turning = s.nextEdge.dx !== E.dx || s.nextEdge.dz !== E.dz

    if (s.seg === 'edge') {
      const remaining = L - JUNC - s.segT          // 到路口边缘的距离
      if (turning && remaining < 10) targetSpeed = Math.min(targetSpeed, 5.5)
      if (s.token && s.token !== E.to) {
        // 持有的是上一个路口的令牌：驶离路口后释放
        if (s.segT > JUNC + 5) releaseToken(v)
      }
      if (!s.token || s.token !== E.to) {
        if (remaining < 6) {
          const node = E.to
          const stale = node.occupant && ctx.time - node.occupantSince > 7
          const exitBlocked = [10, 15].some((d) => {
            g.lanePoint(s.nextEdge, d, tmp)
            return ctx.vehicles.some((o) => o !== v && o.active && o.absSpeed < 2 && Math.hypot(o.x - tmp.x, o.z - tmp.z) < 3.2)
          })
          if (s.forceGo > 0 || (!exitBlocked && (!node.occupant || stale || node.occupant === v))) {
            if (s.token) releaseToken(v)
            node.occupant = v; node.occupantSince = ctx.time; s.token = node
          } else {
            // 停在路口边缘前 1m
            targetSpeed = remaining > 1.5 ? Math.min(targetSpeed, (remaining - 1) * 2) : 0
          }
        }
      }
    } else {
      targetSpeed = Math.min(targetSpeed, turning ? 5.5 : s.cruise)
    }

    // 前方避让
    const inJunction = s.seg === 'turn' || (s.token === E.to)
    const obs = obstacleAhead(v, ctx, this.peds, 16, s.forceGo > 0 ? 1.2 : inJunction ? 1.6 : 2.6)
    if (obs < 14) targetSpeed = Math.min(targetSpeed, obs < 3.5 ? 0 : (obs - 3) * 1.2)

    // 停等计时：等太久强行通过；更久且远离玩家则回收
    s.forceGo = Math.max(0, s.forceGo - dt)
    if (targetSpeed <= 0.3 && s.v < 0.5) s.wait += dt; else s.wait = 0
    if (s.wait > 8 && s.forceGo <= 0) s.forceGo = 4
    if (s.wait > 14 && Math.hypot(v.x - ctx.player.worldX, v.z - ctx.player.worldZ) > 80) { releaseToken(v); v.deactivate(); return }

    // 速度逼近目标
    const rate = targetSpeed > s.v ? 5 : 12
    s.v = targetSpeed > s.v ? Math.min(targetSpeed, s.v + rate * dt) : Math.max(targetSpeed, s.v - rate * dt)
    s.segT += s.v * dt

    // 段推进
    if (s.seg === 'edge' && s.segT >= L - JUNC) {
      s.turn = makeTurn(g, E, s.nextEdge); s.seg = 'turn'; s.segT -= L - JUNC
    }
    if (s.seg === 'turn' && s.segT >= s.turn!.len) {
      s.segT = JUNC + (s.segT - s.turn!.len)
      s.edge = s.nextEdge; s.nextEdge = g.randomNext(s.edge); s.seg = 'edge'; s.turn = null
    }

    // 采样位置与朝向
    const ox = v.x, oz = v.z
    if (s.seg === 'edge') {
      g.lanePoint(s.edge, s.segT, tmp)
      v.yaw = dampAngle(v.yaw, Math.atan2(s.edge.dx, s.edge.dz), 10, dt)
    } else {
      const u = clamp(s.segT / s.turn!.len, 0, 1)
      bez(s.turn!.p0, s.turn!.p1, s.turn!.p2, u, tmp)
      bez(s.turn!.p0, s.turn!.p1, s.turn!.p2, Math.min(1, u + 0.05), tmp2)
      if (Math.hypot(tmp2.x - tmp.x, tmp2.z - tmp.z) > 1e-3) v.yaw = dampAngle(v.yaw, Math.atan2(tmp2.x - tmp.x, tmp2.z - tmp.z), 12, dt)
    }
    // 被轻微推开后平滑回到轨迹
    v.x += (tmp.x - v.x) * Math.min(1, 10 * dt)
    v.z += (tmp.z - v.z) * Math.min(1, 10 * dt)
    v.vx = (v.x - ox) / dt; v.vz = (v.z - oz) / dt
    v.controls.steer = 0; v.controls.throttle = 0; v.controls.handbrake = false

    const E2 = s.edge
    s.dbg = `kin ${s.seg} E(${E2.from.i},${E2.from.j}>${E2.to.i},${E2.to.j}) t${s.segT.toFixed(0)} v${s.v.toFixed(0)} tgt${targetSpeed.toFixed(0)} tok${s.token ? 1 : 0} obs${obs === Infinity ? '-' : obs.toFixed(0)} wait${s.wait.toFixed(0)}`
  }
}
