import { airspeed, heading, pitch, roll, type FlightBody, type FlightInput } from '../../physics/ArcadeFlight'

/**
 * 简易自动驾驶（AIR.4 调试 / 测试用，AIR.5 也可拿来做自动降落演示）：纯函数，不依赖 three。
 * - 航向：hdg（与车辆 yaw 同约定，rad）或 to:{x,z}（飞向某点）；滚转角限 30°，P + 角速度阻尼；
 * - 高度 / 速度：alt（m）→ 目标升降率 → 俯仰；spd（m/s）→ 油门；
 * - 地面：满油门滑跑，到 Vr 附近拉杆离地；前轮转向保持航向；
 * - land：沿 3.5° 下滑道对准跑道（{x,z} 接地点 + hdg 跑道方向），6 m 以下拉平收油，接地后刹车。
 */
export interface AutopilotTarget {
  hdg?: number
  to?: { x: number; z: number }
  alt?: number
  spd?: number
  land?: { x: number; z: number; hdg: number }
}

const DEG = Math.PI / 180
const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v)
export const wrapAngle = (a: number) => Math.atan2(Math.sin(a), Math.cos(a))

/** 让飞机滚到 bankT（rad）的横滚输入 */
function rollTo(b: FlightBody, bankT: number) {
  return clamp((bankT - roll(b)) * 2.5 - b.wr * 0.35, -1, 1)
}
/** 航向误差 → 目标坡度（右转 heading 减小 = 右滚正） */
function bankFor(err: number, maxBank = 30 * DEG) {
  return clamp(-err * 1.6, -maxBank, maxBank)
}
/** 目标升降率 → 俯仰输入（P 于升降率 + 俯仰角阻尼） */
function pitchForVs(b: FlightBody, vsT: number) {
  const V = Math.max(airspeed(b), 10)
  const ptT = clamp(vsT / V, -12 * DEG, 14 * DEG) + 3 * DEG
  return clamp((ptT - pitch(b)) * 2.2 + (vsT - b.vy) * 0.06 - b.wp * 0.25, -1, 1)
}

export function autopilotInput(b: FlightBody, ap: AutopilotTarget): FlightInput {
  const hd = heading(b)
  const V = airspeed(b)
  // ---- 降落模式 ----
  if (ap.land) {
    const L = ap.land
    const fx = Math.sin(L.hdg), fz = Math.cos(L.hdg)
    // 沿跑道方向距接地点的距离（接地点前为正）与侧偏
    const dx = L.x - b.x, dz = L.z - b.z
    const along = dx * fx + dz * fz
    const cross = dx * -fz + dz * fx            // 右侧（−x 方向）为正… 直接用于修正航向
    if (b.onGround) return { pitch: 0, roll: clamp(wrapAngle(hd - L.hdg) * 3, -1, 1), yaw: 0, throttle: 0, brake: V > 0.5, flaps: 'auto' }
    // 航向：跑道方向 + 侧偏修正（最多 25°）
    const corr = clamp(Math.atan2(cross, Math.max(80, Math.abs(along))) * 1.8, -25 * DEG, 25 * DEG)
    const hdgT = L.hdg - corr
    const r = rollTo(b, bankFor(wrapAngle(hdgT - hd), 25 * DEG))
    const glide = Math.max(0, along) * Math.tan(3.5 * DEG)
    if (b.y < 3.5 && along < 400) {
      // 拉平：下沉率收到 −0.8 m/s，收油
      return { pitch: pitchForVs(b, -0.8) + 0.15, roll: r, yaw: 0, throttle: 0, brake: false, flaps: 1 }
    }
    const vsT = clamp((glide - b.y) * 0.35 - V * Math.tan(3.5 * DEG), -6, 2)
    const spdT = 27
    return { pitch: pitchForVs(b, vsT), roll: r, yaw: 0, throttle: clamp(0.35 + (spdT - V) * 0.12, 0, 1), brake: false, flaps: 1 }
  }
  // ---- 航向 ----
  let hdgT = ap.hdg ?? hd
  if (ap.to) hdgT = Math.atan2(ap.to.x - b.x, ap.to.z - b.z)
  const err = wrapAngle(hdgT - hd)
  const spdT = ap.spd ?? 50
  if (b.onGround) {
    // 地面滑跑：转向保持航向（roll+yaw 输入相加即前轮转向，右为正 → heading 减小）
    const steer = clamp(-err * 2, -1, 1)
    const wantAir = ap.alt !== undefined && ap.alt > 5
    return { pitch: wantAir && V > 26 ? 0.7 : 0, roll: steer, yaw: 0, throttle: wantAir ? 1 : clamp((spdT - V) * 0.2, 0, 0.6), brake: !wantAir && V > spdT + 2, flaps: 'auto' }
  }
  const r = rollTo(b, bankFor(err))
  const altT = ap.alt ?? b.y
  const vsT = clamp((altT - b.y) * 0.12, -6, 6)
  // 转弯时多给一点杆和油门，补偿坡度损失的升力
  const thr = clamp(0.5 + (spdT - V) * 0.12 + Math.max(0, vsT) * 0.05, 0, 1)
  return { pitch: pitchForVs(b, vsT), roll: r, yaw: 0, throttle: thr, brake: false, flaps: 'auto' }
}
