import { clamp } from '../../config'
import type { Ctx } from '../../core/Context'
import type { Vehicle } from '../../entities/Vehicle'
import { steerTowards } from '../../entities/TrafficAI'
import { pointAt, vmaxAt, type BuiltRoute } from './Route'
import { circleBody } from '../../physics/Collision'
import type { AABB } from '../../world/Colliders'

/** 调试：AI 每帧写 r.dbg（__game.plug.race.state().ai[i].dbg）；?racedbg=1 打开 */
const DEBUG_AI = typeof location !== 'undefined' && new URLSearchParams(location.search).has('racedbg')
const tmpBoxes: AABB[] = []
const M = { x: 0, z: 0, dx: 0, dz: 0, hw: 0 }
const T = { x: 0, z: 0, dx: 0, dz: 0, hw: 0 }
const hit = (ctx: Ctx, x: number, z: number, r = 1.25) => ctx.world.query(x, z, r, tmpBoxes).some((b) => circleBody(x, z, r, b) !== null)
function segClear(ctx: Ctx, ax: number, az: number, bx: number, bz: number) {
  const L = Math.hypot(bx - ax, bz - az), n = Math.max(1, Math.ceil(L / 2.5))
  for (let i = 1; i <= n; i++) { const u = i / n; if (hit(ctx, ax + (bx - ax) * u, az + (bz - az) * u)) return false }
  return true
}
/** 以横向偏移 off 走前视路径（车 → 半程点 → 前视点）是否不碰静态体（只查已加载区块，远处恒为通） */
function staticClear(ctx: Ctx, v: Vehicle, route: BuiltRoute, s: number, la: number, off: number) {
  pointAt(route, s + la * 0.5, M); pointAt(route, s + la, T)
  const mx = M.x - M.dz * off, mz = M.z + M.dx * off, tx = T.x - T.dz * off, tz = T.z + T.dx * off
  return segClear(ctx, v.x, v.z, mx, mz) && segClear(ctx, mx, mz, tx, tz)
}

/** 一名参赛者（玩家或 AI）的进度与 AI 状态 */
export interface Racer {
  name: string
  tag: string
  isPlayer: boolean
  /** 车手水平（AI：弯道/直道速度系数；玩家 1） */
  skill: number
  v: Vehicle | null
  /** 路线点索引提示（局部投影窗口中心） */
  idx: number
  /** 圈内弧长（上一帧） */
  s: number
  lap: number
  /** 总路程进度 (m)：lap·L + s（玩家受检查点约束） */
  progress: number
  /** 下一个检查点（全局序号：lap·M + k） */
  nextCp: number
  /** 通过每个检查点的比赛用时 */
  cpTimes: number[]
  finished: boolean
  finishTime: number
  /** 报废 / 离场 */
  dnf: boolean
  // ---- AI ----
  /** 当前横向偏移（相对赛车线中心，右正）与目标偏移 */
  offset: number
  prefOffset: number
  reverseT: number
  slowT: number
  offT: number
  winT: number
  winP: number
  /** 卡住 > 5 s（5 s 内前进 < 8 m）次数 = 复位次数 */
  stuckEvents: number
  offRouteResets: number
  /** 当前橡皮筋系数 */
  rubber: number
  dbg: string
  /** 每 5 s 一个 [用时, 进度] 采样 */
  trace: [number, number][]
}

export function makeRacer(name: string, tag: string, isPlayer: boolean, skill: number): Racer {
  return {
    name, tag, isPlayer, skill, v: null, idx: 0, s: 0, lap: 0, progress: 0, nextCp: 0, cpTimes: [], finished: false, finishTime: 0, dnf: false,
    offset: 0, prefOffset: 0, reverseT: 0, slowT: 0, offT: 0, winT: 0, winP: 0, stuckEvents: 0, offRouteResets: 0, rubber: 1, trace: [], dbg: '',
  }
}

const P = { x: 0, z: 0, dx: 0, dz: 0, hw: 0 }
const Q = { x: 0, z: 0, dx: 0, dz: 0, hw: 0 }

/**
 * AI 车手：沿赛道折线开车。
 * - 转向：steerTowards 前视点（6 m + 0.32·速度），前视点按当前横向偏移平移（超车 / 避车）
 * - 速度：赛道满速线限速 vmax（曲率 + 刹车距离反向传播）× 水平 × 橡皮筋，throttleFor 式比例油门，超速重刹
 * - 避车：前方 30 m 内比自己慢的车占用横向区间，选离当前偏移最近的空档；无空档且很近 → 跟车减速
 * - 卡住：想走却几乎不动 1.2 s → 倒车 1.1 s；5 s 内前进不足 8 m 或偏离赛道 > 2 s → 复位到赛道上（计数）
 */
export function driveAI(r: Racer, route: BuiltRoute, ctx: Ctx, dt: number, raceT: number, playerProgress: number, racers: Racer[]) {
  const v = r.v!
  const speed = v.speed
  // 橡皮筋：落后玩家 > 60 m 逐步加速（≤ +10%），领先 > 100 m 逐步收油（≥ −12%）
  const delta = r.progress - playerProgress
  const rb = delta < -60 ? 1 + Math.min(0.1, (-delta - 60) / 1500) : delta > 100 ? Math.max(0.88, 1 - (delta - 100) / 2000) : 1
  r.rubber = rb
  v.tune = { accel: rb > 1 ? 1.15 : 1, maxFwd: r.skill * rb }

  const la = 6 + 0.32 * Math.abs(speed)
  pointAt(route, r.s + la, P)
  const hw = Math.max(0.3, Math.min(P.hw, pointAt(route, r.s, Q).hw))
  // ---- 避车：在赛道坐标系里找前方慢车占用的横向区间 ----
  const fx = Q.dx, fz = Q.dz, rx = -fz, rz = fx
  const myLat = (v.x - Q.x) * rx + (v.z - Q.z) * rz
  const blocks: [number, number, number, number][] = []   // [latMin, latMax, 前向距离, 对方沿线速度]
  const range = clamp(Math.abs(speed) * 1.5, 30, 60)
  for (const o of ctx.vehicles) {
    if (o === v || !o.active) continue
    const dx = o.x - v.x, dz = o.z - v.z
    if (dx * dx + dz * dz > (range + 4) ** 2) continue
    const f = dx * fx + dz * fz
    if (f < 1.5 || f > range) continue
    const ov = o.vx * fx + o.vz * fz
    if (ov > speed - 0.5 && f > 7) continue        // 跑得比我快、又不贴脸：不用让
    const lat = (o.x - Q.x) * rx + (o.z - Q.z) * rz
    const w = o.kind === 'bus' ? 3.0 : 2.5
    blocks.push([lat - w, lat + w, f, ov])
  }
  const freeOfCars = (lat: number) => blocks.every(([a, b]) => lat < a || lat > b)
  // 候选横向偏移：首选（偏好线）→ 当前线 → 由近到远扫一遍；要求不被慢车占用、且前视路径不压静态碰撞体（楼 / 灯杆 / 隔离墩）
  const cands: number[] = [r.prefOffset, r.offset]
  for (let k = 1; k <= 10; k++) { const d = (k * hw) / 5; cands.push(r.offset + d, r.offset - d) }
  // 半宽内都躲不开（路口短边半宽很小、路中间立着灯杆 / 信号杆）：允许出半宽 1.5–6 m
  const ext = cands.length
  for (const d of [1.5, 3, 4.5, 6]) cands.push(hw + d, -hw - d)
  let want: number | null = null, carFree: number | null = null
  for (let ci = 0; ci < cands.length; ci++) {
    const c0 = cands[ci]
    const c = ci >= ext ? c0 : clamp(c0, -hw, hw)
    if (!freeOfCars(c)) continue
    carFree ??= c
    if (staticClear(ctx, v, route, r.s, Math.max(la, 8 + 0.6 * Math.abs(speed)), c)) { want = c; break }
  }
  let followSpeed = Infinity
  if (want === null) {
    // 静态障碍躲不开：减速慢慢挤过去；车躲不开：跟住最近那辆
    if (carFree !== null) followSpeed = 9
    want = carFree ?? r.offset
  }
  // 跟车：当前线路上（按实际横向位置）前方慢车，按刹车距离限速，避免追尾
  // （目标线也被占 → 真跟车；只是当前位置还没让开 → 保留 ≥ 7 m/s 让转向有效，变线绕过去）
  for (const [a, b, f, ov] of blocks) {
    const brake = Math.sqrt(Math.max(0, ov) ** 2 + 2 * 14 * Math.max(0, f - 7))
    if (want > a && want < b) followSpeed = Math.min(followSpeed, brake)
    else if (myLat > a - 0.3 && myLat < b + 0.3) followSpeed = Math.min(followSpeed, Math.max(7, brake))
  }
  r.offset += clamp(want - r.offset, -6 * dt, 6 * dt)
  const lim = Math.max(hw, Math.abs(want))
  r.offset = clamp(r.offset, -lim, lim)

  const tx = P.x + -P.dz * r.offset, tz = P.z + P.dx * r.offset
  let steer = steerTowards(v, tx, tz, 2.1)

  // ---- 目标速度 ----
  let vt = Math.min(vmaxAt(route, r.s + 2), vmaxAt(route, r.s + 8)) * r.skill * rb
  vt = Math.min(vt, followSpeed)
  // 偏离赛车线越多越慢（回线）
  const latErr = Math.abs(myLat - r.offset)
  if (latErr > 4) vt = Math.min(vt, Math.max(8, 30 - latErr * 2))
  // 车头朝向与赛道方向偏差大（被撞歪 / 掉头）→ 低速转回来
  const align = Math.sin(v.yaw) * fx + Math.cos(v.yaw) * fz
  if (align < 0.5) vt = Math.min(vt, 7)
  if (r.finished) vt = Math.min(vt, Math.max(0, 14 - (raceT - r.finishTime) * 6))

  let throttle = speed > vt + 0.8 ? clamp((vt - speed) * 0.5, -1, 0) : clamp((vt - speed) * 0.45, -1, 1)

  // ---- 卡住处理 ----
  if (r.reverseT > 0) {
    r.reverseT -= dt
    throttle = -1; steer = -steer
  } else if (!r.finished) {
    if (vt > 4 && v.absSpeed < 1.2) r.slowT += dt; else r.slowT = Math.max(0, r.slowT - dt)
    if (r.slowT > 1.2) { r.reverseT = 1.1; r.slowT = 0 }
  }
  if (DEBUG_AI) r.dbg = `hw${hw.toFixed(1)} lat${myLat.toFixed(1)} off${r.offset.toFixed(1)} want${want.toFixed(1)} vt${vt.toFixed(0)} fs${followSpeed === Infinity ? '-' : followSpeed.toFixed(0)} bl${blocks.length}`
  v.controls.throttle = throttle
  v.controls.steer = steer
  v.controls.handbrake = false

  if (!r.finished) {
    if (raceT - r.winT >= 5) {
      if (r.progress - r.winP < 8) { r.stuckEvents++; resetOnRoute(r, route, ctx, racers) }
      r.winT = raceT; r.winP = r.progress
    }
  }
}

/** 把 AI 复位到赛道当前进度处（避开已有车辆，必要时往回挪） */
export function resetOnRoute(r: Racer, route: BuiltRoute, ctx: Ctx, _racers: Racer[], back = 4) {
  const v = r.v!
  for (let k = 0; k < 8; k++) {
    pointAt(route, r.s - back - k * 7, Q)
    const occupied = ctx.vehicles.some((o) => o !== v && o.active && Math.hypot(o.x - Q.x, o.z - Q.z) < 4.5)
    if (!occupied || k === 7) break
  }
  v.x = Q.x; v.z = Q.z; v.yaw = Math.atan2(Q.dx, Q.dz)
  v.vx = Q.dx * 6; v.vz = Q.dz * 6
  r.offset = 0; r.reverseT = 0; r.slowT = 0; r.offT = 0
}
