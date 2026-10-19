import * as THREE from 'three'
import { dampAngle, damp } from '../config'

export type CamMode = 'foot' | 'car' | 'orbit'

/** 第三人称追尾相机：鼠标控制偏航/俯仰，空闲后自动回到目标身后；步行与驾驶两套参数 */
export class ChaseCamera {
  camera: THREE.PerspectiveCamera
  yaw = 0
  pitch = 0.27
  private pos = new THREE.Vector3(0, 40, 80)
  private look = new THREE.Vector3()
  private dist = 6
  private idle = 10        // 距上次鼠标操作的秒数
  private aimBlend = 0     // 0 普通追尾，1 过肩瞄准
  private static readonly SENS = 0.0022

  constructor(aspect: number) {
    this.camera = new THREE.PerspectiveCamera(62, aspect, 0.3, 420)
    this.camera.position.copy(this.pos)
  }

  snap(yaw: number) { this.yaw = yaw; this.pitch = 0.27 }

  /** 鼠标输入：左右转偏航，上下调俯仰 */
  applyMouse(dx: number, dy: number) {
    if (dx === 0 && dy === 0) return
    this.yaw -= dx * ChaseCamera.SENS
    this.pitch = Math.max(-0.12, Math.min(0.95, this.pitch + dy * ChaseCamera.SENS))
    this.idle = 0
  }

  update(dt: number, mode: CamMode, target: { x: number; z: number; yaw: number }, speed: number, time: number, moving = true, aiming = false) {
    if (mode === 'orbit') {
      const a = time * 0.08
      this.pos.set(Math.sin(a) * 160, 70, Math.cos(a) * 160)
      this.look.set(0, 10, 0)
      this.camera.position.lerp(this.pos, 1 - Math.exp(-2 * dt))
      this.camera.lookAt(this.look)
      return
    }
    const car = mode === 'car'
    this.idle += dt
    const wantDist = car ? 8.5 + Math.min(Math.abs(speed), 34) * 0.09 : 5.5
    this.dist = damp(this.dist, wantDist, 3, dt)
    // 鼠标空闲一段时间后自动回到目标身后（开车 1.2s；步行只在移动时 1.5s 后缓慢跟随）
    const follow = car ? this.idle > 1.2 : (moving && this.idle > 1.5)
    if (follow) {
      this.yaw = dampAngle(this.yaw, target.yaw, car ? 4.0 : 2.5, dt)
      this.pitch = damp(this.pitch, 0.27, 2, dt)
    }
    const fx = Math.sin(this.yaw), fz = Math.cos(this.yaw)
    const rx = -fz, rz = fx
    this.aimBlend = damp(this.aimBlend, aiming ? 1 : 0, 10, dt)
    const b = this.aimBlend
    // 普通追尾：注视点在目标身前
    const ahead = car ? 3 : 0.8
    const lookH = car ? 1.0 : 1.3
    const hd = this.dist * Math.cos(this.pitch), vd = this.dist * Math.sin(this.pitch)
    const nx = target.x + fx * ahead - fx * hd, ny = Math.max(0.6, lookH + vd), nz = target.z + fz * ahead - fz * hd
    const nlx = target.x + fx * ahead, nly = lookH, nlz = target.z + fz * ahead
    // 过肩瞄准：相机偏到右肩、拉近，注视点沿视线推到 30m 外，准星落在远处
    const shoulder = car ? 1.6 : 0.9
    const aimDist = car ? 5.5 : 3.0
    const eyeH = car ? 1.9 : 1.6
    const cp = Math.cos(this.pitch), sp = Math.sin(this.pitch)
    const ax = target.x + rx * shoulder - fx * aimDist * cp, ay = eyeH + aimDist * sp, az = target.z + rz * shoulder - fz * aimDist * cp
    const alx = ax + fx * cp * 30, aly = ay - sp * 30, alz = az + fz * cp * 30
    this.pos.set(nx + (ax - nx) * b, ny + (ay - ny) * b, nz + (az - nz) * b)
    this.look.set(nlx + (alx - nlx) * b, nly + (aly - nly) * b, nlz + (alz - nlz) * b)
    // 鼠标操作中相机贴得更紧，避免拖影感
    this.camera.position.lerp(this.pos, 1 - Math.exp(-(this.idle < 1.2 || aiming ? 30 : 14) * dt))
    this.camera.lookAt(this.look)
  }

  resize(aspect: number) { this.camera.aspect = aspect; this.camera.updateProjectionMatrix() }
}
