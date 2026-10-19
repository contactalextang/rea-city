import { clamp, wrapAngle, dampAngle } from '../config'
import type { RoadEdge, RoadNode, P2 } from '../world/RoadGraph'
import type { Ctx } from '../core/Context'
import type { Vehicle } from './Vehicle'
import type { Pedestrians } from './Pedestrians'

interface Turn { p0: P2; p1: P2; p2: P2; len: number }

export interface TrafficState {
  mode: 'kin' | 'phys' | 'return'
  edge: RoadEdge; nextEdge: RoadEdge
  seg: 'edge' | 'turn'; segT: number
  turn: Turn | null
  v: number                    // 运动学当前速度
  token: RoadNode | null
  wait: number; forceGo: number
  redWait: number              // 红灯等待累计（不计入强行通过，超 40 s 兜底）
  physTimer: number
  cruise: number
  dbg: string
}
const tmp: P2 = { x: 0, z: 0 }
const tmp2: P2 = { x: 0, z: 0 }
const dirA: P2 = { x: 0, z: 0 }
const dirB: P2 = { x: 0, z: 0 }

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

/** 两条边在路口处是否改变方向（用于判断是否需要减速过弯） */
function isTurning(g: Ctx['graph'], a: RoadEdge, b: RoadEdge) {
  g.dirAt(a, a.length, dirA); g.dirAt(b, 0, dirB)
  return dirA.x * dirB.x + dirA.z * dirB.z < 0.999
}

/**
 * 路口转弯曲线：p0 = A 直线段末端，p2 = B 直线段起点，控制点 p1 取两方向射线交点；
 * 交点不存在 / 在反方向 / 过远（> 3·jr）则退化为中点
 */
function makeTurn(g: Ctx['graph'], a: RoadEdge, b: RoadEdge): Turn {
  const jr = a.to.jr
  const p0 = g.lanePoint(a, a.length - jr, { x: 0, z: 0 })
  const p2 = g.lanePoint(b, b.from.jr, { x: 0, z: 0 })
  g.dirAt(a, a.length, dirA); g.dirAt(b, 0, dirB)
  const cross = dirA.x * dirB.z - dirA.z * dirB.x
  let p1: P2 | null = null
  if (Math.abs(cross) > 1e-3) {
    // p0 + dirA*s = p2 - dirB*u  →  解 s、u
    const rx = p2.x - p0.x, rz = p2.z - p0.z
    const s = (rx * dirB.z - rz * dirB.x) / cross
    const u = (rx * dirA.z - rz * dirA.x) / cross
    if (s > 0 && u > 0 && s < 3 * jr && u < 3 * jr) p1 = { x: p0.x + dirA.x * s, z: p0.z + dirA.z * s }
  }
  if (!p1) p1 = { x: (p0.x + p2.x) / 2, z: (p0.z + p2.z) / 2 }
  let len = 0, lx = p0.x, lz = p0.z
  for (let i = 1; i <= 8; i++) { bez(p0, p1, p2, i / 8, tmp); len += Math.hypot(tmp.x - lx, tmp.z - lz); lx = tmp.x; lz = tmp.z }
  return { p0, p1, p2, len: Math.max(len, 0.5) }
}
function bez(p0: P2, p1: P2, p2: P2, u: number, out: P2) {
  const a = (1 - u) * (1 - u), b = 2 * (1 - u) * u, c = u * u
  out.x = a * p0.x + b * p1.x + c * p2.x
  out.z = a * p0.z + b * p1.z + c * p2.z
  return out
}

/**
 * 交通 NPC：运动学沿车道折线 + 路口贝塞尔弧线行驶，路口令牌放行，前方避让；
 * 被撞后进入物理模式滑行，再用物理转向归队。
 */
export class TrafficAI {
  constructor(private peds: Pedestrians) {}

  /** 开始沿 edge 行驶；该边无后继（孤立死路）则返回 false */
  start(v: Vehicle, edge: RoadEdge, t: number, ctx: Ctx): boolean {
    const next = ctx.graph.randomNext(edge)
    if (!next) return false
    v.driver = 'traffic'
    v.kinematic = true
    const segT = clamp(t, edge.from.jr, edge.length - edge.to.jr)
    const cruise = Math.min(edge.speedLimit / 3.6 * 0.9, 10 + Math.random() * 3)
    v.ai = {
      mode: 'kin', edge, nextEdge: next, seg: 'edge', segT, turn: null,
      v: 8, token: null, wait: 0, forceGo: 0, redWait: 0, physTimer: 0, cruise, dbg: '',
    } satisfies TrafficState
    ctx.graph.lanePoint(edge, segT, tmp)
    ctx.graph.dirAt(edge, segT, dirA)
    v.x = tmp.x; v.z = tmp.z; v.yaw = Math.atan2(dirA.x, dirA.z)
    v.vx = dirA.x * 8; v.vz = dirA.z * 8
    return true
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

  /** 回收：释放令牌并停用（死路 / 等待过久） */
  private recycle(v: Vehicle) { releaseToken(v); v.deactivate() }

  /** 重新定位到最近车道；无后继边则回收，返回 false */
  private relocate(v: Vehicle, s: TrafficState, ctx: Ctx): boolean {
    const n = ctx.graph.nearestLane(v.x, v.z, Math.sin(v.yaw), Math.cos(v.yaw))
    const next = ctx.graph.randomNext(n.edge)
    if (!next) { this.recycle(v); return false }
    s.edge = n.edge; s.nextEdge = next
    return true
  }

  private updatePhys(v: Vehicle, s: TrafficState, dt: number, ctx: Ctx) {
    s.physTimer -= dt
    v.controls.throttle = 0; v.controls.steer = 0; v.controls.handbrake = true
    if (s.physTimer <= 0 && v.absSpeed < 3) {
      if (!this.relocate(v, s, ctx)) return
      s.mode = 'return'
    }
    s.dbg = `phys ${s.physTimer.toFixed(1)}`
  }

  private updateReturn(v: Vehicle, s: TrafficState, dt: number, ctx: Ctx) {
    const g = ctx.graph
    // 物理转向开回车道：接近且对齐后切回运动学
    let t = g.projectT(s.edge, v.x, v.z)
    if (t > s.edge.length - s.edge.to.jr - 2 || t < 0) {
      // 投影越界：重新选边
      if (!this.relocate(v, s, ctx)) return
      t = g.projectT(s.edge, v.x, v.z)
    }
    const L = s.edge.length
    g.lanePoint(s.edge, clamp(t, 0, L), tmp)
    g.dirAt(s.edge, t, dirA)
    const dist = Math.hypot(tmp.x - v.x, tmp.z - v.z)
    const align = Math.sin(v.yaw) * dirA.x + Math.cos(v.yaw) * dirA.z
    if (dist < 1.2 && align > 0.95) {
      s.mode = 'kin'; s.seg = 'edge'; s.segT = clamp(t, s.edge.from.jr, L - s.edge.to.jr); s.turn = null
      s.v = Math.max(0, v.speed); v.kinematic = true
      return
    }
    g.lanePoint(s.edge, clamp(t + 6, 0, L), tmp2)
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
      const tt = clamp(t, s.edge.from.jr, L - s.edge.to.jr)
      g.lanePoint(s.edge, tt, tmp); g.dirAt(s.edge, tt, dirA)
      v.x = tmp.x; v.z = tmp.z; v.yaw = Math.atan2(dirA.x, dirA.z); v.vx = v.vz = 0
    }
    s.dbg = `return d${dist.toFixed(1)} al${align.toFixed(2)}`
  }

  private updateKin(v: Vehicle, s: TrafficState, dt: number, ctx: Ctx) {
    const g = ctx.graph
    const E = s.edge, L = E.length
    const endT = L - E.to.jr                     // 直线段终点弧长
    let targetSpeed = s.cruise
    const turning = isTurning(g, E, s.nextEdge)
    let stoppedByRed = false

    if (s.seg === 'edge') {
      const remaining = endT - s.segT            // 到路口边缘（停止线）的距离
      if (turning && remaining < 10) targetSpeed = Math.min(targetSpeed, 5.5)
      // 红绿灯：红灯停在停止线前；黄灯能停则停，已越线/刹不住则继续；等超 40 s 按原兜底规则
      if (E.to.signal && remaining < 15 && s.redWait < 40) {
        const phase = ctx.signals.phaseFor(E)
        const mustStop = phase === 'red' || (phase === 'amber' && remaining > s.v * s.v / 24 + 1.5)
        if (mustStop) {
          targetSpeed = remaining > 1.5 ? Math.min(targetSpeed, (remaining - 1) * 2) : 0
          stoppedByRed = true
        }
      }
      if (s.token && s.token !== E.to) {
        // 持有的是上一个路口的令牌：驶离路口后释放
        if (s.segT > E.from.jr + 5) releaseToken(v)
      }
      // 令牌只在真正的路口节点上申请；普通折点/端点直接通过
      if (E.to.junction && !stoppedByRed && (!s.token || s.token !== E.to)) {
        if (remaining < 6) {
          const node = E.to
          const stale = node.occupant && ctx.time - node.occupantSince > 7
          const exitBlocked = [10, 15].some((d) => {
            g.lanePoint(s.nextEdge, Math.min(d, s.nextEdge.length), tmp)
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
    if (targetSpeed <= 0.3 && s.v < 0.5) {
      if (stoppedByRed) s.redWait += dt; else s.wait += dt
    } else { s.wait = 0; s.redWait = 0 }
    if (s.wait > 8 && s.forceGo <= 0) s.forceGo = 4
    if (s.wait > 14 && Math.hypot(v.x - ctx.player.worldX, v.z - ctx.player.worldZ) > 80) { this.recycle(v); return }

    // 速度逼近目标
    const rate = targetSpeed > s.v ? 5 : 12
    s.v = targetSpeed > s.v ? Math.min(targetSpeed, s.v + rate * dt) : Math.max(targetSpeed, s.v - rate * dt)
    s.segT += s.v * dt

    // 段推进
    if (s.seg === 'edge' && s.segT >= endT) {
      s.turn = makeTurn(g, E, s.nextEdge); s.seg = 'turn'; s.segT -= endT
    }
    if (s.seg === 'turn' && s.segT >= s.turn!.len) {
      const next = g.randomNext(s.nextEdge)
      if (!next) { this.recycle(v); return }   // 下一条边是孤立死路：回收
      s.segT = s.nextEdge.from.jr + (s.segT - s.turn!.len)
      s.edge = s.nextEdge; s.nextEdge = next; s.seg = 'edge'; s.turn = null
    }

    // 采样位置与朝向
    const ox = v.x, oz = v.z
    if (s.seg === 'edge') {
      g.lanePoint(s.edge, s.segT, tmp)
      g.dirAt(s.edge, s.segT, dirA)
      v.yaw = dampAngle(v.yaw, Math.atan2(dirA.x, dirA.z), 10, dt)
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
    s.dbg = `kin ${s.seg} E${E2.id}(${E2.from.id}>${E2.to.id}) t${s.segT.toFixed(0)} v${s.v.toFixed(0)} tgt${targetSpeed.toFixed(0)} tok${s.token ? 1 : 0}${stoppedByRed ? ' RED' : ''} obs${obs === Infinity ? '-' : obs.toFixed(0)} wait${s.wait.toFixed(0)}`
  }
}
