// ArcadeFlight 单测：node --experimental-transform-types --no-warnings scripts/test/flight.test.ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  FLIGHT_PARAMS, createFlightBody, stepFlight, heading, pitch, roll, airspeed, forward, up,
  classifyTouchdown, liftCoefficient, type FlightBody, type FlightInput, type FlightOpts,
} from '../../src/physics/ArcadeFlight.ts'

const DEG = Math.PI / 180
const P = FLIGHT_PARAMS.cessna
const idle = (o: Partial<FlightInput> = {}): FlightInput => ({ pitch: 0, roll: 0, yaw: 0, brake: false, ...o })
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v))

/** 空中平飞的飞机：高度 y、速度 v、朝 heading，姿态取该速度的配平攻角 */
function airborne(y: number, v: number, h = 0, throttle = 0.5): FlightBody {
  const b = createFlightBody(0, 0, h)
  b.y = y; b.onGround = false; b.throttle = throttle
  b.vx = Math.sin(h) * v; b.vz = Math.cos(h) * v
  // 配平攻角：G·liftK·CL·v² = G
  const clMax = P.cl0 + P.clSlope * P.alphaStall
  const alpha = (clMax * (P.vStall / v) ** 2 - P.cl0) / P.clSlope
  // 机头抬到配平攻角：q = Ry(h)·Rx(−alpha)
  const ch = Math.cos(h / 2), sh = Math.sin(h / 2), cp = Math.cos(-alpha / 2), sp = Math.sin(-alpha / 2)
  b.qx = ch * sp; b.qy = sh * cp; b.qz = -sh * sp; b.qw = ch * cp
  return b
}

/** 定高 + 定速的简单 P 控制 */
function holdInput(b: FlightBody, alt: number, spd: number, extra: Partial<FlightInput> = {}): FlightInput {
  const pIn = clamp((alt - b.y) * 0.04 - b.vy * 0.15, -1, 1)
  const thr = clamp(0.5 + (spd - airspeed(b)) * 0.15, 0, 1)
  return idle({ pitch: pIn, throttle: thr, flaps: 0, ...extra })
}

/** 起飞策略：满油门，到 Vr 后拉杆 0.7；返回离地时的滑跑距离和速度 */
function takeoff(b: FlightBody, dt = 1 / 60) {
  const x0 = b.x, z0 = b.z
  for (let i = 0; i < 60 * 120; i++) {
    const r = stepFlight(b, idle({ throttle: 1, pitch: airspeed(b) >= P.vr * 0.85 ? 0.7 : 0 }), dt)
    if (r.liftoff) return { dist: Math.hypot(b.x - x0, b.z - z0), v: airspeed(b), t: i * dt }
  }
  return null
}

test('createFlightBody 姿态读回：heading 同车辆约定，pitch/roll 为 0', () => {
  const b = createFlightBody(10, -5, 1.0)
  assert.equal(b.y, 0); assert.equal(b.onGround, true)
  assert.ok(Math.abs(heading(b) - 1.0) < 1e-9)
  assert.ok(Math.abs(pitch(b)) < 1e-9 && Math.abs(roll(b)) < 1e-9)
  const f = forward(b), u = up(b)
  assert.ok(Math.abs(f[0] - Math.sin(1)) < 1e-9 && Math.abs(f[2] - Math.cos(1)) < 1e-9)
  assert.ok(Math.abs(u[1] - 1) < 1e-9)
})

test('满油门滑跑 250–450 m 内离地', () => {
  const b = createFlightBody(0, 0, 0)
  // 起步加速度约 4.5 m/s²
  stepFlight(b, idle({ throttle: 1 }), 1)   // 1 s 内油门推满（0.8/s）
  const b2 = createFlightBody(0, 0, 0); b2.throttle = 1
  stepFlight(b2, idle({ throttle: 1 }), 1 / 60)
  const a0 = airspeed(b2) * 60
  console.log(`  起步加速度 ${a0.toFixed(2)} m/s²`)
  assert.ok(a0 > 4.0 && a0 < 5.0)
  const r = takeoff(createFlightBody(0, 0, 0))
  assert.ok(r, '未离地')
  console.log(`  离地：滑跑 ${r.dist.toFixed(0)} m，${r.v.toFixed(1)} m/s，${r.t.toFixed(1)} s`)
  assert.ok(r.dist >= 250 && r.dist <= 450, `滑跑 ${r.dist}`)
  assert.ok(r.v >= 24 && r.v <= 32)
})

test('起飞后爬升率 ≥ 5 m/s', () => {
  const b = createFlightBody(0, 0, 0)
  assert.ok(takeoff(b))
  // 俯仰角保持 8°、满油门
  let y0 = 0, minY = Infinity
  for (let i = 0; i < 60 * 40; i++) {
    const pIn = clamp((8 * DEG - pitch(b)) * 4 - b.wp * 0.3, -1, 1)
    const r = stepFlight(b, idle({ throttle: 1, pitch: pIn }), 1 / 60)
    assert.ok(!r.touchdown, '起飞后又接地')
    if (i === 60 * 20) y0 = b.y
    minY = Math.min(minY, b.y)
  }
  const rate = (b.y - y0) / 20
  console.log(`  爬升率 ${rate.toFixed(2)} m/s，空速 ${airspeed(b).toFixed(1)} m/s，高度 ${b.y.toFixed(0)} m`)
  assert.ok(rate >= 5, `爬升率 ${rate}`)
  assert.ok(!b.stalled)
})

test('55 m/s 简单 P 控制定高 60 s，漂移 < 15 m', () => {
  const b = airborne(300, 55)
  let maxDev = 0
  for (let i = 0; i < 60 * 60; i++) {
    stepFlight(b, holdInput(b, 300, 55), 1 / 60)
    if (i > 60 * 5) maxDev = Math.max(maxDev, Math.abs(b.y - 300))
  }
  console.log(`  最大高度偏差 ${maxDev.toFixed(2)} m，末速度 ${airspeed(b).toFixed(1)} m/s，油门 ${b.throttle.toFixed(2)}`)
  assert.ok(maxDev < 15)
  assert.ok(Math.abs(airspeed(b) - 55) < 3)
  assert.ok(Math.abs(heading(b)) < 0.05, '无横滚输入时航向不该漂')
})

test('低于 24 m/s 拉满杆会失速且机头下沉', () => {
  // 收襟翼、收油门定高减速到 24 m/s（27 m/s 以上不应失速）
  const b = airborne(500, 30, 0, 0)
  let slowSeen = false
  for (let i = 0; i < 60 * 60 && airspeed(b) > 24 && !b.stalled; i++) {
    stepFlight(b, holdInput(b, 500, 0, { throttle: 0 }), 1 / 60)
    if (airspeed(b) < 27) slowSeen = true
    if (!slowSeen) assert.ok(!b.stalled, `${airspeed(b).toFixed(1)} m/s 就失速了`)
  }
  const v0 = airspeed(b)
  // 拉满杆
  let stallT = -1, pitchAtStall = 0, minAfter = Infinity
  for (let j = 0; j < 60 * 6; j++) {
    const r = stepFlight(b, idle({ pitch: 1, throttle: 0, flaps: 0 }), 1 / 60)
    if (r.stallStart && stallT < 0) { stallT = j; pitchAtStall = pitch(b) }
    if (stallT >= 0) minAfter = Math.min(minAfter, pitch(b))
  }
  assert.ok(stallT >= 0, '没有失速')
  console.log(`  ${v0.toFixed(1)} m/s 拉满杆，${(stallT / 60).toFixed(2)} s 后失速（俯仰 ${(pitchAtStall / DEG).toFixed(1)}°），之后最低俯仰 ${(minAfter / DEG).toFixed(1)}°`)
  assert.ok(minAfter < pitchAtStall - 5 * DEG, '失速后机头没有下沉')
})

test('襟翼放下后失速速度降到约 20 m/s', () => {
  // 平飞升力 = 重力时，CLmax 对应速度
  const clMaxFlap = liftCoefficient(P.alphaStall, 1)
  const clMaxClean = liftCoefficient(P.alphaStall, 0)
  const vsFlap = P.vStall * Math.sqrt(clMaxClean / clMaxFlap)
  assert.ok(Math.abs(vsFlap - 20) < 0.5, `${vsFlap}`)
  assert.ok(liftCoefficient(P.alphaStall + 8 * DEG, 0) < clMaxClean * 0.7, '失速后升力应快速下降')
  // auto：低速自动放下
  const b = airborne(300, 30)
  stepFlight(b, idle(), 2)
  assert.equal(b.flaps, 1)
  assert.ok(b.flapPos > 0.9)
  const c = airborne(300, 55)
  stepFlight(c, idle(), 0.5)
  assert.equal(c.flaps, 0)
})

test('45° 坡度稳定转弯，半径 100–600 m', () => {
  const b = airborne(400, 55)
  const opts: FlightOpts = { autoLevel: false }
  let t0 = 0, turned = 0, prevH = heading(b), maxDev = 0
  const steps = 60 * 40
  for (let i = 0; i < steps; i++) {
    const rIn = clamp((45 * DEG - roll(b)) * 3 - b.wr * 0.2, -1, 1)
    stepFlight(b, holdInput(b, 400, 55, { roll: rIn }), 1 / 60, P, opts)
    const h = heading(b)
    let d = h - prevH
    if (d > Math.PI) d -= 2 * Math.PI
    if (d < -Math.PI) d += 2 * Math.PI
    prevH = h
    if (i === 60 * 15) { t0 = i; turned = 0 }
    if (i > 60 * 15) { turned += d; maxDev = Math.max(maxDev, Math.abs(roll(b) - 45 * DEG)) }
  }
  const rate = Math.abs(turned) / ((steps - 1 - t0) / 60)
  const V = airspeed(b)
  const radius = V / rate
  console.log(`  坡度 ${(roll(b) / DEG).toFixed(1)}°，转弯角速度 ${(rate / DEG).toFixed(1)}°/s，半径 ${radius.toFixed(0)} m（理论 ${(V * V / 9.8).toFixed(0)} m），高度 ${b.y.toFixed(0)} m`)
  assert.ok(turned < 0, '右压坡度应右转（heading 减小）')
  assert.ok(radius >= 100 && radius <= 600, `半径 ${radius}`)
  assert.ok(maxDev < 5 * DEG)
  assert.ok(Math.abs(b.y - 400) < 40)
})

test('无输入时横滚自动回平', () => {
  const b = airborne(400, 55)
  for (let i = 0; i < 40; i++) stepFlight(b, holdInput(b, 400, 55, { roll: 1 }), 1 / 60)
  const r0 = roll(b)
  assert.ok(r0 > 30 * DEG, `压坡度 ${r0 / DEG}`)
  for (let i = 0; i < 60 * 4; i++) stepFlight(b, holdInput(b, 400, 55), 1 / 60)
  console.log(`  松杆前 ${(r0 / DEG).toFixed(1)}°，4 s 后 ${(roll(b) / DEG).toFixed(2)}°`)
  assert.ok(Math.abs(roll(b)) < 3 * DEG)
  // autoLevel=false 时保持坡度
  const c = airborne(400, 55)
  for (let i = 0; i < 40; i++) stepFlight(c, holdInput(c, 400, 55, { roll: 1 }), 1 / 60, P, { autoLevel: false })
  const c0 = roll(c)
  for (let i = 0; i < 60; i++) stepFlight(c, holdInput(c, 400, 55), 1 / 60, P, { autoLevel: false })
  assert.ok(roll(c) > c0 - 2 * DEG, `关闭自动改平后坡度不应回落：${c0 / DEG} → ${roll(c) / DEG}`)
})

test('地面：横滚输入兼作前轮转向，刹车能停，升力不足不离地', () => {
  const b = createFlightBody(0, 0, 0)
  for (let i = 0; i < 60 * 4; i++) stepFlight(b, idle({ throttle: 0.4, roll: 1 }), 1 / 60)
  assert.ok(heading(b) < -0.3, `右转 heading 应减小：${heading(b)}`)
  assert.ok(b.onGround && b.y === 0 && Math.abs(roll(b)) < 1e-9)
  // 低速拉满杆：不离地，俯仰不超过抬轮角
  for (let i = 0; i < 60 * 2; i++) stepFlight(b, idle({ throttle: 0.4, pitch: 1 }), 1 / 60)
  assert.ok(b.onGround)
  assert.ok(pitch(b) <= P.rotateAngle + 1e-9 && pitch(b) >= P.noseDownLimit - 1e-9)
  for (let i = 0; i < 60 * 10; i++) stepFlight(b, idle({ throttle: 0, brake: true }), 1 / 60)
  assert.ok(airspeed(b) < 0.01)
})

test('接地事件：进近拉平落地返回 touchdown，并能分类', () => {
  // 25 m/s 进近，下沉 1.5 m/s，离地 4 m 拉平到 0.6 m/s
  const b = airborne(30, 26, 0, 0.3)
  let td: { vy: number; roll: number; pitch: number } | undefined
  for (let i = 0; i < 60 * 60 && !td; i++) {
    const sink = b.y < 4 ? -0.6 : -1.5
    const thr = clamp(0.3 + (25 - airspeed(b)) * 0.2, 0, 1)
    const r = stepFlight(b, idle({ throttle: thr, pitch: clamp((sink - b.vy) * 0.5, -1, 1) }), 1 / 60)
    td = r.touchdown
  }
  assert.ok(td, '没接地')
  const g = classifyTouchdown(td.vy, td.roll, td.pitch, 'runway')
  console.log(`  接地 vy=${td.vy.toFixed(2)} roll=${(td.roll / DEG).toFixed(1)}° pitch=${(td.pitch / DEG).toFixed(1)}° → ${g}`)
  assert.ok(b.onGround && b.y === 0)
  assert.ok(g === 'perfect' || g === 'normal', g)
  assert.equal(classifyTouchdown(td.vy, td.roll, td.pitch, 'water'), 'crash')
  // 俯冲撞地
  const d = airborne(60, 55, 0, 1)
  let hard: { vy: number; roll: number; pitch: number } | undefined
  for (let i = 0; i < 60 * 30 && !hard; i++) hard = stepFlight(d, idle({ throttle: 1, pitch: -1 }), 1 / 60).touchdown
  assert.ok(hard)
  assert.equal(classifyTouchdown(hard.vy, hard.roll, hard.pitch, 'runway'), 'crash')
  // 自定义地面高度
  const c = airborne(55, 30, 0, 0.2)
  let hit = false
  for (let i = 0; i < 60 * 30 && !hit; i++) hit = !!stepFlight(c, idle({ throttle: 0.2, pitch: -0.2 }), 1 / 60, P, { groundY: 50 }).touchdown
  assert.ok(hit && c.y === 50)
})

test('classifyTouchdown 分类表', () => {
  const cases: [number, number, number, 'runway' | 'land' | 'water', string][] = [
    [-0.5, 0, 3 * DEG, 'runway', 'perfect'],
    [-1.19, 0, 0, 'runway', 'perfect'],
    [-1.2, 0, 0, 'runway', 'normal'],
    [-3.4, 5 * DEG, 0, 'land', 'normal'],
    [-3.5, 0, 0, 'runway', 'hard'],
    [-5.9, 0, 0, 'runway', 'hard'],
    [-6, 0, 0, 'runway', 'crash'],
    [-0.5, 21 * DEG, 0, 'runway', 'crash'],
    [-0.5, -21 * DEG, 0, 'runway', 'crash'],
    [-0.5, 19 * DEG, 0, 'runway', 'perfect'],
    [-0.5, 0, -6 * DEG, 'runway', 'crash'],
    [-0.5, 0, -4 * DEG, 'land', 'perfect'],
    [-0.2, 0, 0, 'water', 'crash'],
  ]
  for (const [vy, r, p, s, want] of cases) assert.equal(classifyTouchdown(vy, r, p, s), want, `${vy},${r},${p},${s}`)
})

/** 固定剧本：起飞 → 爬升 → 右转 → 松杆，返回终态 */
function script(dt: number) {
  const b = createFlightBody(100, 200, 0.3)
  const T = 50, n = Math.round(T / dt)
  for (let i = 0; i < n; i++) {
    const t = i * dt
    const inp = idle({ throttle: 1, flaps: 'auto' })
    if (b.onGround) inp.pitch = airspeed(b) > P.vr * 0.85 ? 0.7 : 0
    else inp.pitch = clamp((8 * DEG - pitch(b)) * 4, -1, 1)
    if (t > 30 && t < 32) inp.roll = 0.6
    if (t > 40 && t < 41) inp.yaw = -0.5
    stepFlight(b, inp, dt)
  }
  return b
}

test('确定性：同输入两次结果逐字段相等', () => {
  assert.deepEqual(script(1 / 60), script(1 / 60))
})

test('子步长稳定：dt=1/120 与 1/60、1/30 结果接近', () => {
  const a = script(1 / 120), b = script(1 / 60), c = script(1 / 30)
  const d = (p: FlightBody, q: FlightBody) => Math.hypot(p.x - q.x, p.y - q.y, p.z - q.z)
  const travel = Math.hypot(a.x - 100, a.y, a.z - 200)
  console.log(`  50 s 航程 ${travel.toFixed(0)} m；1/120 vs 1/60 位置差 ${d(a, b).toFixed(2)} m，vs 1/30 ${d(a, c).toFixed(2)} m；航向差 ${((heading(a) - heading(b)) / DEG).toFixed(2)}°`)
  assert.ok(d(a, b) < travel * 0.02, `位置差 ${d(a, b)}`)
  assert.ok(d(a, c) < travel * 0.03)
  assert.ok(Math.abs(airspeed(a) - airspeed(b)) < 1)
  assert.ok(Math.abs(heading(a) - heading(b)) < 3 * DEG)
})
