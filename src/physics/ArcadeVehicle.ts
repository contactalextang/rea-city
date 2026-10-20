import { VEHICLE_PARAMS, type VehicleKind } from '../config'

export interface VehicleBody {
  x: number; z: number; yaw: number
  vx: number; vz: number
}
export interface Controls { throttle: number; steer: number; handbrake: boolean }

/** 速度对转向的钟形加权：低速弱（防原地打转）、中速强、高速再衰减（12 m/s 起衰减，30 m/s 约剩一半，高速不飘） */
export function steerFactor(speed: number) {
  const s = Math.abs(speed)
  const lowRamp = Math.min(s / 2.5, 1)
  const highDecay = 1 / (1 + Math.max(0, s - 12) / 20)
  return lowRamp * highDecay
}

/** 调参倍率（玩家自有车 / 引擎升级）：只乘加速与前进极速 */
export interface TuneMul { accel: number; maxFwd: number }

/** 街机车辆运动学：纵向加速/阻力、横向抓地、转向随速度变化 */
export function stepVehicle(b: VehicleBody, c: Controls, kind: VehicleKind, dt: number, grounded = true, mul?: TuneMul) {
  const base = VEHICLE_PARAMS[kind]
  const p = mul && (mul.accel !== 1 || mul.maxFwd !== 1) ? { ...base, accel: base.accel * mul.accel, maxFwd: base.maxFwd * mul.maxFwd } : base
  const fx = Math.sin(b.yaw), fz = Math.cos(b.yaw)   // 车头方向（局部 +z）
  const rx = -fz, rz = fx                            // 右侧：朝向 (dx,dz) 的右侧是 (-dz,dx)
  let vF = b.vx * fx + b.vz * fz
  let vL = b.vx * rx + b.vz * rz

  if (grounded) {
    const t = c.throttle
    if (t > 0) {
      vF += (vF < -0.5 ? p.brake : p.accel) * t * dt
    } else if (t < 0) {
      vF += (vF > 0.5 ? p.brake : p.accel * 0.6) * t * dt
    }
    // 阻力：与速度成正比 + 滚动阻力
    const drag = p.drag * vF * dt + Math.sign(vF) * Math.min(Math.abs(vF), p.rolling * dt)
    vF -= drag
    if (c.handbrake) vF -= Math.sign(vF) * Math.min(Math.abs(vF), p.brake * 0.5 * dt)
    vF = Math.max(-p.maxRev, Math.min(p.maxFwd, vF))

    const grip = c.handbrake ? p.gripDrift : p.grip
    vL *= Math.pow(grip, dt * 60)

    const dir = vF >= 0 ? 1 : -1
    b.yaw -= c.steer * p.maxSteer * steerFactor(vF) * dir * dt   // steer>0 右转（yaw 增大是左转）
  }

  // 重新组合世界速度（用新的朝向）
  const nfx = Math.sin(b.yaw), nfz = Math.cos(b.yaw)
  const nrx = -nfz, nrz = nfx
  b.vx = nfx * vF + nrx * vL
  b.vz = nfz * vF + nrz * vL
  b.x += b.vx * dt
  b.z += b.vz * dt
}

export function forwardSpeed(b: VehicleBody) {
  return b.vx * Math.sin(b.yaw) + b.vz * Math.cos(b.yaw)
}
