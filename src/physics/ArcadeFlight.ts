// 街机固定翼飞行物理（AIR.3）：纯函数模块，不依赖 three，node 可直接跑单测。
// 坐标约定与车辆一致：x 东、z 南、y 上；heading 与车辆 yaw 同约定，机头水平朝向 = (sin heading, cos heading)。
// 机体局部轴：前 = +z、上 = +y、右 = −x（和 three 里模型朝 +z 的习惯一致）。
// 姿态用四元数存（qx,qy,qz,qw），角速度存机体系三个分量：wp 俯仰（+ 机头向上）、wr 横滚（+ 右滚）、wy 偏航（+ 机头向右）。

const G = 9.8
const DEG = Math.PI / 180

export interface FlightParams {
  /** 抬轮速度 m/s：地面上机头可抬起的角度从 0.8·vr 开始放开，到 vr 时放满 */
  vr: number
  /** 失速速度 m/s（收襟翼、平飞、攻角到 alphaStall 时升力刚好等于重力）；升力系数由它反推 */
  vStall: number
  /** 巡航速度 m/s（风标收敛等速率以它为参考速度 vref） */
  vCruise: number
  /** 极速 m/s：推力 = throttle·thrust·(1 − v/vMax)，空中速度硬上限 vMax·1.15 */
  vMax: number
  /** 升限 m：以上推力线性衰减，再高 ceilingFade m 推力归零 */
  ceiling: number
  ceilingFade: number
  /** 静推力（加速度 m/s²，已除以质量） */
  thrust: number
  /** 寄生阻力系数：a = dragK·v² */
  dragK: number
  /** 诱导阻力系数：a = inducedK·CL²·v² */
  inducedK: number
  /** 升力线：CL = cl0 + clSlope·α（α 单位 rad），α 超过 alphaStall 后以 clDrop/rad 快速下降 */
  cl0: number
  clSlope: number
  alphaStall: number
  clDrop: number
  /** 失速后最低剩余升力（占 CLmax 比例） */
  clFloor: number
  /** 襟翼：CL 加值、寄生阻力倍增、auto 模式放下阈值、收放速率（/s） */
  flapCL: number
  flapDrag: number
  flapAutoBelow: number
  flapRate: number
  /** 最大角速度 rad/s：俯仰 / 横滚 / 方向舵 */
  pitchRate: number
  rollRate: number
  yawRate: number
  /** 角速度向目标收敛的速率（/s，一阶滞后） */
  rateResponse: number
  /** 俯仰静稳定：目标俯仰角速度额外减 alphaStab·α，机头自然追速度方向 */
  alphaStab: number
  /** 失速时的机头下沉角速度 rad/s */
  stallPitchDown: number
  /** 松杆自动改平：横滚角速度目标 = −roll·autoLevelGain（再限幅到 rollRate·0.5） */
  autoLevelGain: number
  /** 街机风标：速度方向以 k·(v/vCruise) /s 向机头收敛；侧滑分量用 vaneSide，攻角分量用 vaneVert */
  vaneSide: number
  vaneVert: number
  /** 地面：滚动阻力 m/s²、机轮阻力（随速度增长，按轮载比例），刹车减速度，侧向抓地（每 1/60 s 保留比例） */
  rollRes: number
  wheelDrag: number
  brakeDecel: number
  groundGrip: number
  /** 地面前轮最大转向角速度 rad/s（乘钟形速度权重） */
  steerRate: number
  /** 地面俯仰：抬轮最大角、推杆最低角（rad，负值）、地面俯仰变化速率 rad/s */
  rotateAngle: number
  noseDownLimit: number
  groundPitchRate: number
  /** 油门变化速率（/s） */
  throttleRate: number
}

export const FLIGHT_PARAMS: Record<'cessna', FlightParams> = {
  cessna: {
    vr: 28, vStall: 24, vCruise: 55, vMax: 75, ceiling: 1200, ceilingFade: 150,
    thrust: 4.75,
    dragK: 2.0e-4, inducedK: 1.3e-3,
    // CLmax = 0.2 + 2.7·15° ≈ 0.907；襟翼 +0.4 → 1.307，失速速度 24·√(0.907/1.307) ≈ 20 m/s
    cl0: 0.2, clSlope: 2.7, alphaStall: 15 * DEG, clDrop: 5, clFloor: 0.35,
    flapCL: 0.4, flapDrag: 0.3, flapAutoBelow: 35, flapRate: 0.6,
    pitchRate: 1.2, rollRate: 2.2, yawRate: 0.4,
    rateResponse: 6, alphaStab: 1.0, stallPitchDown: 0.9, autoLevelGain: 1.8,
    vaneSide: 2.0, vaneVert: 0.3,
    rollRes: 0.25, wheelDrag: 0.1, brakeDecel: 4.5, groundGrip: 0.85,
    steerRate: 0.6, rotateAngle: 10 * DEG, noseDownLimit: -2 * DEG, groundPitchRate: 0.35,
    throttleRate: 0.8,
  },
}

export interface FlightBody {
  x: number; y: number; z: number
  vx: number; vy: number; vz: number
  /** 姿态四元数（机体局部 → 世界） */
  qx: number; qy: number; qz: number; qw: number
  /** 机体系角速度 rad/s：wp 俯仰（+ 抬头）、wr 横滚（+ 右滚）、wy 偏航（+ 右偏） */
  wp: number; wr: number; wy: number
  /** 油门 0–1 */
  throttle: number
  /** 襟翼指令 0/1；flapPos 是实际放出量 0–1（平滑收放，物理用它） */
  flaps: 0 | 1
  flapPos: number
  onGround: boolean
  stalled: boolean
  /** 当前攻角 rad（HUD 用） */
  aoa: number
}

export interface FlightInput {
  /** −1..1，+1 = 拉杆机头向上 */
  pitch: number
  /** −1..1，+1 = 右滚；地面时兼作前轮转向 */
  roll: number
  /** −1..1，+1 = 右偏；地面时也参与转向 */
  yaw: number
  /** 油门增减输入 −1..1（按 throttleRate/s 变化）；与 throttle 同给时以 throttle 为准 */
  throttleDelta?: number
  /** 油门目标 0–1（按 throttleRate/s 逼近） */
  throttle?: number
  brake: boolean
  /** 襟翼：0/1 手动，'auto' 或不给 = 空中速度低于 flapAutoBelow 自动放下（地面收起） */
  flaps?: 0 | 1 | 'auto'
}

export interface FlightOpts {
  /** 松杆自动改平横滚，默认 true */
  autoLevel?: boolean
  /** 本步的地面高度，默认 0（stepFlight 不知道地表类型，只把 y ≤ groundY 视为接地） */
  groundY?: number
}

export interface FlightStepResult {
  /** 本步从空中接地：接地瞬间的下沉率（m/s，负值向下）、横滚角、俯仰角（rad） */
  touchdown?: { vy: number; roll: number; pitch: number }
  /** 本步离地 */
  liftoff?: true
  /** 本步刚进入失速 */
  stallStart?: true
}

export type TouchdownGrade = 'perfect' | 'normal' | 'hard' | 'crash'

// ---------- 最小向量 / 四元数运算 ----------

type V3 = [number, number, number]

function rotate(b: FlightBody, x: number, y: number, z: number): V3 {
  // v' = v + w·t + q×t，t = 2·(q×v)
  const { qx, qy, qz, qw } = b
  const tx = 2 * (qy * z - qz * y), ty = 2 * (qz * x - qx * z), tz = 2 * (qx * y - qy * x)
  return [
    x + qw * tx + (qy * tz - qz * ty),
    y + qw * ty + (qz * tx - qx * tz),
    z + qw * tz + (qx * ty - qy * tx),
  ]
}

/** 由 heading / pitch / roll 设置四元数：q = Ry(heading)·Rx(−pitch)·Rz(roll) */
function setAttitude(b: FlightBody, h: number, p: number, r: number) {
  const ch = Math.cos(h / 2), sh = Math.sin(h / 2)
  const cp = Math.cos(-p / 2), sp = Math.sin(-p / 2)
  const cr = Math.cos(r / 2), sr = Math.sin(r / 2)
  // a = Ry·Rx
  const ax = ch * sp, ay = sh * cp, az = -sh * sp, aw = ch * cp
  // q = a·Rz
  b.qx = ax * cr + ay * sr
  b.qy = ay * cr - ax * sr
  b.qz = aw * sr + az * cr
  b.qw = aw * cr - az * sr
}

/** 绕世界轴 (wx,wy,wz)（角速度向量）转 dt：q = dq·q */
function integrateRotation(b: FlightBody, wx: number, wy: number, wz: number, dt: number) {
  const w = Math.hypot(wx, wy, wz)
  if (w < 1e-9) return
  const half = w * dt / 2, s = Math.sin(half) / w
  const dx = wx * s, dy = wy * s, dz = wz * s, dw = Math.cos(half)
  const { qx, qy, qz, qw } = b
  const nx = dw * qx + dx * qw + dy * qz - dz * qy
  const ny = dw * qy - dx * qz + dy * qw + dz * qx
  const nz = dw * qz + dx * qy - dy * qx + dz * qw
  const nw = dw * qw - dx * qx - dy * qy - dz * qz
  const n = Math.hypot(nx, ny, nz, nw)
  b.qx = nx / n; b.qy = ny / n; b.qz = nz / n; b.qw = nw / n
}

const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v)
const approach = (v: number, target: number, maxStep: number) =>
  v < target ? Math.min(target, v + maxStep) : Math.max(target, v - maxStep)

// ---------- 姿态读取（Camera / HUD 用） ----------

/** 机头方向单位向量（世界） */
export function forward(b: FlightBody): V3 { return rotate(b, 0, 0, 1) }
/** 机顶方向单位向量（世界） */
export function up(b: FlightBody): V3 { return rotate(b, 0, 1, 0) }
/** 右翼方向单位向量（世界） */
export function right(b: FlightBody): V3 { return rotate(b, -1, 0, 0) }

/** 航向：与车辆 yaw 同约定，机头水平朝向 = (sin h, cos h)；右转时减小 */
export function heading(b: FlightBody) {
  const f = forward(b)
  return Math.atan2(f[0], f[2])
}
/** 俯仰角 rad，+ 机头向上 */
export function pitch(b: FlightBody) {
  return Math.asin(clamp(forward(b)[1], -1, 1))
}
/** 横滚角 rad，+ 右翼向下 */
export function roll(b: FlightBody) {
  const r = right(b), u = up(b)
  return Math.atan2(-r[1], u[1])
}
/** 空速 m/s（无风，等于对地速度的模） */
export function airspeed(b: FlightBody) {
  return Math.hypot(b.vx, b.vy, b.vz)
}

// ---------- 创建与接地判定 ----------

/** 停在地面（y=0）、朝 heading、油门 0 的飞机 */
export function createFlightBody(x: number, z: number, h: number): FlightBody {
  const b: FlightBody = {
    x, y: 0, z, vx: 0, vy: 0, vz: 0,
    qx: 0, qy: 0, qz: 0, qw: 1, wp: 0, wr: 0, wy: 0,
    throttle: 0, flaps: 0, flapPos: 0, onGround: true, stalled: false, aoa: 0,
  }
  setAttitude(b, h, 0, 0)
  return b
}

/**
 * 接地质量：vy 为接地下沉率（负值向下），roll/pitch 为接地姿态（rad）。
 * 落水、|roll|>20°、机头朝下（pitch<−5°）或下沉率 ≤ −6 → crash；> −1.2 完美；> −3.5 正常；> −6 重着陆。
 */
export function classifyTouchdown(vy: number, rollRad: number, pitchRad: number, surface: 'runway' | 'land' | 'water'): TouchdownGrade {
  if (surface === 'water' || Math.abs(rollRad) > 20 * DEG || pitchRad < -5 * DEG || vy <= -6) return 'crash'
  if (vy > -1.2) return 'perfect'
  if (vy > -3.5) return 'normal'
  return 'hard'
}

// ---------- 气动 ----------

function clMax(p: FlightParams) { return p.cl0 + p.clSlope * p.alphaStall }
/** 升力加速度系数：a_lift = G·liftK·CL·vf²，使收襟翼 CLmax 在 vStall 时升力 = 重力 */
function liftK(p: FlightParams) { return 1 / (clMax(p) * p.vStall * p.vStall) }

/** 升力系数：线性段 + 失速后快速下降（对称处理负攻角）+ 襟翼加值 */
export function liftCoefficient(alpha: number, flapPos: number, p: FlightParams = FLIGHT_PARAMS.cessna) {
  const a = p.alphaStall
  let cl: number
  if (alpha > a) {
    const top = clMax(p)
    cl = Math.max(top * p.clFloor, top - (alpha - a) * p.clDrop)
  } else if (alpha < -a) {
    const bot = p.cl0 - p.clSlope * a
    cl = Math.min(bot * p.clFloor, bot + (-a - alpha) * p.clDrop)
  } else {
    cl = p.cl0 + p.clSlope * alpha
  }
  return cl + p.flapCL * flapPos
}

function updateFlaps(b: FlightBody, input: FlightInput, speed: number, p: FlightParams, dt: number) {
  const mode = input.flaps ?? 'auto'
  // auto：空中低于 flapAutoBelow 放下；地面保持收起（按 Vr 抬轮起飞，落地后自动收）
  b.flaps = mode === 'auto' ? (!b.onGround && speed < p.flapAutoBelow ? 1 : 0) : mode
  b.flapPos = approach(b.flapPos, b.flaps, p.flapRate * dt)
}

function updateThrottle(b: FlightBody, input: FlightInput, p: FlightParams, dt: number) {
  if (input.throttle !== undefined) b.throttle = approach(b.throttle, clamp(input.throttle, 0, 1), p.throttleRate * dt)
  else if (input.throttleDelta) b.throttle = clamp(b.throttle + input.throttleDelta * p.throttleRate * dt, 0, 1)
}

function thrustAccel(b: FlightBody, vf: number, p: FlightParams) {
  const alt = b.y > p.ceiling ? Math.max(0, 1 - (b.y - p.ceiling) / p.ceilingFade) : 1
  return b.throttle * p.thrust * Math.max(0, 1 - Math.max(0, vf) / p.vMax) * alt
}

/** 地面前轮转向的钟形速度权重（同 ArcadeVehicle.steerFactor 思路）：低速可原地小转、滑行最灵、高速大幅衰减防侧翻 */
function groundSteerFactor(speed: number) {
  const s = Math.abs(speed)
  const lowRamp = Math.min(s / 2, 1)
  const highDecay = 1 / (1 + Math.max(0, s - 8) / 6)
  return lowRamp * highDecay
}

// ---------- 单步 ----------

/** 单子步上限：大于它时内部拆分，保证 30 fps 与 120 fps 结果接近 */
const MAX_SUB = 1 / 60

/** 推进一步飞行物理；返回本步的接地 / 离地 / 失速事件。确定性：同输入同结果。 */
export function stepFlight(b: FlightBody, input: FlightInput, dt: number, params: FlightParams = FLIGHT_PARAMS.cessna, opts: FlightOpts = {}): FlightStepResult {
  const res: FlightStepResult = {}
  if (!(dt > 0)) return res
  const n = Math.ceil(dt / MAX_SUB - 1e-9)
  const h = dt / n
  for (let i = 0; i < n; i++) {
    if (b.onGround) groundStep(b, input, h, params, opts, res)
    else airStep(b, input, h, params, opts, res)
  }
  return res
}

function groundStep(b: FlightBody, input: FlightInput, dt: number, p: FlightParams, opts: FlightOpts, res: FlightStepResult) {
  const gy = opts.groundY ?? 0
  // 地面突然变低（滑出崖边 / 高台）→ 转为空中
  if (b.y > gy + 0.5) { b.onGround = false; airStep(b, input, dt, p, opts, res); return }

  let hd = heading(b), pt = pitch(b), rl = roll(b)
  let fx = Math.sin(hd), fz = Math.cos(hd)
  let vF = b.vx * fx + b.vz * fz
  let vL = b.vx * -fz + b.vz * fx
  updateThrottle(b, input, p, dt)
  updateFlaps(b, input, Math.abs(vF), p, dt)

  // 纵向：推力 − 气动阻力 − 机轮阻力（按轮载，升力越大轮子越轻）− 刹车
  const cl = liftCoefficient(pt, b.flapPos, p)
  const liftG = liftK(p) * cl * vF * Math.abs(vF)             // 升力 / 重力
  const load = clamp(1 - liftG, 0, 1)
  const aero = (p.dragK * (1 + p.flapDrag * b.flapPos) + p.inducedK * cl * cl) * vF * Math.abs(vF)
  vF += (thrustAccel(b, vF, p) - aero) * dt
  let fric = (p.rollRes + p.wheelDrag * Math.abs(vF)) * load
  if (input.brake) fric += p.brakeDecel * Math.max(0.3, load)
  vF = Math.max(0, vF - Math.min(Math.max(0, vF), fric * dt))  // 摩擦只减速不倒车；Cessna 不能倒车

  // 侧向抓地衰减
  vL *= Math.pow(p.groundGrip, dt * 60)

  // 前轮转向：roll + yaw 输入，右为正，右转 heading 减小
  const steer = clamp(input.roll + input.yaw, -1, 1)
  const dh = -steer * p.steerRate * groundSteerFactor(vF)
  hd += dh * dt

  // 俯仰：抬轮角随速度放开；推杆最多 noseDownLimit；松杆回 0
  const maxUp = p.rotateAngle * clamp((vF - 0.8 * p.vr) / (0.2 * p.vr), 0, 1)
  const target = input.pitch > 0 ? input.pitch * maxUp : input.pitch < 0 ? -input.pitch * p.noseDownLimit : 0
  const prevPt = pt
  pt = approach(pt, target, p.groundPitchRate * dt)
  pt = clamp(pt, p.noseDownLimit, Math.max(p.rotateAngle, 0))
  rl *= Math.exp(-10 * dt)                                     // 横滚回 0

  setAttitude(b, hd, pt, rl)
  b.wp = (pt - prevPt) / dt; b.wr = 0; b.wy = -dh
  fx = Math.sin(hd); fz = Math.cos(hd)
  b.vx = fx * vF - fz * vL
  b.vz = fz * vF + fx * vL
  b.vy = 0
  b.x += b.vx * dt; b.z += b.vz * dt; b.y = gy
  b.aoa = pt
  b.stalled = false

  // 离地：升力 > 重力且在拉杆
  const liftNow = liftK(p) * liftCoefficient(pt, b.flapPos, p) * vF * vF
  if (liftNow > 1 && input.pitch > 0) {
    b.onGround = false
    res.liftoff = true
  }
}

function airStep(b: FlightBody, input: FlightInput, dt: number, p: FlightParams, opts: FlightOpts, res: FlightStepResult) {
  const gy = opts.groundY ?? 0
  const autoLevel = opts.autoLevel ?? true
  let f = forward(b), u = up(b), r = right(b)
  const V = Math.hypot(b.vx, b.vy, b.vz)
  const vf = b.vx * f[0] + b.vy * f[1] + b.vz * f[2]
  const vu = b.vx * u[0] + b.vy * u[1] + b.vz * u[2]
  updateThrottle(b, input, p, dt)
  updateFlaps(b, input, V, p, dt)

  // 攻角与失速（带 3° 回滞）
  const alpha = V > 0.5 ? Math.atan2(-vu, vf) : 0
  b.aoa = alpha
  const wasStalled = b.stalled
  if (alpha > p.alphaStall) b.stalled = true
  else if (alpha < p.alphaStall - 3 * DEG) b.stalled = false
  if (b.stalled && !wasStalled) res.stallStart = true
  const cl = liftCoefficient(alpha, b.flapPos, p)

  // ---- 转动：目标角速度 = 输入 × 舵效 × 最大角速度，一阶逼近 ----
  let auth = clamp((V - 8) / 30, 0.15, 1)
  if (b.stalled) auth *= 0.5
  const rl = roll(b)
  let tp = clamp(input.pitch, -1, 1) * p.pitchRate * auth - p.alphaStab * alpha
  if (b.stalled) tp -= p.stallPitchDown
  let tr: number
  if (autoLevel && Math.abs(input.roll) < 0.02) {
    const lim = p.rollRate * 0.5
    tr = clamp(-rl * p.autoLevelGain, -lim, lim)
  } else {
    tr = clamp(input.roll, -1, 1) * p.rollRate * auth
  }
  // 协调转弯：压坡度自动带方向舵
  const ty = clamp(input.yaw, -1, 1) * p.yawRate * auth + G * Math.sin(rl) / Math.max(V, 10)
  const k = 1 - Math.exp(-p.rateResponse * dt)
  b.wp += (tp - b.wp) * k
  b.wr += (tr - b.wr) * k
  b.wy += (ty - b.wy) * k
  // 世界角速度 = wp·右 + wr·前 + wy·(−上)
  integrateRotation(b,
    b.wp * r[0] + b.wr * f[0] - b.wy * u[0],
    b.wp * r[1] + b.wr * f[1] - b.wy * u[1],
    b.wp * r[2] + b.wr * f[2] - b.wy * u[2], dt)
  f = forward(b); u = up(b); r = right(b)

  // ---- 受力（加速度） ----
  let ax = 0, ay = -G, az = 0
  const T = thrustAccel(b, vf, p)
  ax += f[0] * T; ay += f[1] * T; az += f[2] * T
  if (V > 0.1) {
    const dx = b.vx / V, dy = b.vy / V, dz = b.vz / V
    // 阻力：寄生（襟翼 +30%）+ 诱导 ∝ CL²
    const D = (p.dragK * (1 + p.flapDrag * b.flapPos) + p.inducedK * cl * cl) * V * V
    ax -= dx * D; ay -= dy * D; az -= dz * D
    // 升力：垂直于速度、在 (速度, 机顶) 平面内，大小 ∝ CL·vf²
    const ud = u[0] * dx + u[1] * dy + u[2] * dz
    let lx = u[0] - ud * dx, ly = u[1] - ud * dy, lz = u[2] - ud * dz
    const ln = Math.hypot(lx, ly, lz)
    if (ln > 1e-6) {
      const L = G * liftK(p) * cl * Math.max(0, vf) * Math.max(0, vf)
      lx /= ln; ly /= ln; lz /= ln
      ax += lx * L; ay += ly * L; az += lz * L
    }
  }
  b.vx += ax * dt; b.vy += ay * dt; b.vz += az * dt

  // ---- 街机风标：速度方向向机头收敛（保持速率） ----
  const V2 = Math.hypot(b.vx, b.vy, b.vz)
  if (V2 > 1) {
    const rate = (V2 / p.vCruise)
    const kS = 1 - Math.exp(-p.vaneSide * rate * dt)
    const kV = b.stalled ? 0 : 1 - Math.exp(-p.vaneVert * rate * dt)
    const vs = b.vx * r[0] + b.vy * r[1] + b.vz * r[2]
    const vu2 = b.vx * u[0] + b.vy * u[1] + b.vz * u[2]
    const fwdOk = b.vx * f[0] + b.vy * f[1] + b.vz * f[2] > 0
    if (fwdOk) {
      b.vx -= r[0] * vs * kS + u[0] * vu2 * kV
      b.vy -= r[1] * vs * kS + u[1] * vu2 * kV
      b.vz -= r[2] * vs * kS + u[2] * vu2 * kV
      const V3 = Math.hypot(b.vx, b.vy, b.vz)
      if (V3 > 1e-6) { const s = V2 / V3; b.vx *= s; b.vy *= s; b.vz *= s }
    }
  }
  // 速度硬上限（俯冲也不超过 vMax·1.15）
  const cap = p.vMax * 1.15, Vn = Math.hypot(b.vx, b.vy, b.vz)
  if (Vn > cap) { const s = cap / Vn; b.vx *= s; b.vy *= s; b.vz *= s }

  b.x += b.vx * dt; b.y += b.vy * dt; b.z += b.vz * dt

  // ---- 接地 ----
  if (b.y <= gy) {
    res.touchdown = { vy: b.vy, roll: roll(b), pitch: pitch(b) }
    b.y = gy
    b.vy = 0
    b.onGround = true
    b.stalled = false
    b.wp = 0; b.wr = 0; b.wy = 0
  }
}
