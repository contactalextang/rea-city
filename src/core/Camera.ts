import * as THREE from 'three'
import { dampAngle, damp } from '../config'
import { cine } from './Cine'
import { forward as fwdOf, up as upOf, airspeed, type FlightBody } from '../physics/ArcadeFlight'

const BASE_FOV = 62
/** P13.4 开车速度 FOV：62° → 最高 70°（≈10 → 38 m/s） */
const MAX_FOV = 70
/** 手持晃动幅度（弧度）：步行 ≈0.15°；开车基础 0.08° + 随速度的路面颠簸 ≤0.18° */
const SHAKE_FOOT = THREE.MathUtils.degToRad(0.15)
const SHAKE_CAR = THREE.MathUtils.degToRad(0.08)
const SHAKE_BUMP = THREE.MathUtils.degToRad(0.18)
/** 低频平滑噪声：几组不可通约频率的正弦叠加（-1..1） */
const noise1 = (t: number, s: number) => (Math.sin(t * 1.13 + s) * 0.5 + Math.sin(t * 0.71 + s * 2.3) * 0.3 + Math.sin(t * 2.37 + s * 4.1) * 0.2)

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
  /** P13.4 速度 FOV（度，阻尼）与手持晃动时钟 / 强度 */
  private fov = BASE_FOV
  private shakeT = 0
  private shakeAmt = 0
  /** 由 Game 设置：仅 fx=high 时开启手持晃动与速度 FOV（low/off 不变） */
  cineEnabled = false
  private static readonly SENS = 0.0022
  /** 开场环绕镜头的中心与半径（方格城绕原点 160 m；真实城市绕出生点） */
  orbitCenter = { x: 0, z: 0 }
  orbitRadius = 160
  orbitHeight = 70

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

  /**
   * @param halfLen 驾驶时车辆半车长（轿车 2.3；巴士 6），长车相机拉远、抬高，避免车身挡住视线
   */
  update(dt: number, mode: CamMode, target: { x: number; z: number; yaw: number }, speed: number, time: number, moving = true, aiming = false, halfLen = 2.3) {
    if (mode === 'orbit') {
      const a = time * 0.08
      const o = this.orbitCenter, r = this.orbitRadius
      this.pos.set(o.x + Math.sin(a) * r, this.orbitHeight, o.z + Math.cos(a) * r)
      this.look.set(o.x, 10, o.z)
      this.camera.position.lerp(this.pos, 1 - Math.exp(-2 * dt))
      this.camera.lookAt(this.look)
      this.shakeAmt = 0
      this.applyFov(BASE_FOV, dt)
      return
    }
    const car = mode === 'car'
    this.idle += dt
    const extra = car ? Math.max(0, halfLen - 2.3) : 0   // 比普通轿车长出来的部分
    const wantDist = car ? 8.5 + Math.min(Math.abs(speed), 34) * 0.09 + extra * 1.5 : 5.5
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
    const lookH = car ? 1.0 + extra * 0.4 : 1.3   // 巴士约 2.5
    const hd = this.dist * Math.cos(this.pitch), vd = this.dist * Math.sin(this.pitch)
    const nx = target.x + fx * ahead - fx * hd, ny = Math.max(0.6, lookH + vd), nz = target.z + fz * ahead - fz * hd
    const nlx = target.x + fx * ahead, nly = lookH, nlz = target.z + fz * ahead
    // 过肩瞄准：相机偏到右肩、拉近，注视点沿视线推到 30m 外，准星落在远处
    const shoulder = car ? 1.6 : 0.9
    const aimDist = car ? 5.5 : 3.0
    const eyeH = car ? 1.9 + extra * 0.5 : 1.6
    const cp = Math.cos(this.pitch), sp = Math.sin(this.pitch)
    const ax = target.x + rx * shoulder - fx * aimDist * cp, ay = eyeH + aimDist * sp, az = target.z + rz * shoulder - fz * aimDist * cp
    const alx = ax + fx * cp * 30, aly = ay - sp * 30, alz = az + fz * cp * 30
    this.pos.set(nx + (ax - nx) * b, ny + (ay - ny) * b, nz + (az - nz) * b)
    this.look.set(nlx + (alx - nlx) * b, nly + (aly - nly) * b, nlz + (alz - nlz) * b)
    // 鼠标操作中相机贴得更紧，避免拖影感
    this.camera.position.lerp(this.pos, 1 - Math.exp(-(this.idle < 1.2 || aiming ? 30 : 14) * dt))
    this.camera.lookAt(this.look)
    this.cineFx(dt, car, Math.abs(speed), b)
  }

  /**
   * P13.4 镜头呼吸感（仅 cineEnabled && cine.on）：lookAt 之后叠加低频手持晃动（不累积：下一帧 lookAt 重置朝向），
   * 瞄准时按 aimBlend 关掉；开车 FOV 随速度阻尼变宽。
   */
  private cineFx(dt: number, car: boolean, speed: number, aim: number) {
    const on = this.cineEnabled && cine.on
    const sp = car ? Math.min(1, Math.max(0, (speed - 10) / 28)) : 0
    const fovWant = on && car ? BASE_FOV + (MAX_FOV - BASE_FOV) * sp * sp * (3 - 2 * sp) * cine.fov * (1 - aim) : BASE_FOV
    this.applyFov(fovWant, dt)
    const want = on ? (car ? SHAKE_CAR + SHAKE_BUMP * sp : SHAKE_FOOT) * cine.shake * (1 - aim) : 0
    this.shakeAmt = damp(this.shakeAmt, want, 3, dt)
    if (this.shakeAmt < 1e-5) return
    this.shakeT += dt
    const t = this.shakeT
    let pitch = noise1(t * 0.9, 0.0) * this.shakeAmt
    let yaw = noise1(t * 0.7, 5.0) * this.shakeAmt * 0.8
    let roll = noise1(t * 0.5, 9.0) * this.shakeAmt * 0.5
    if (car && sp > 0) {
      // 路面颠簸：更高频的小幅纵向抖动
      const bump = (Math.sin(t * 17.3) * 0.6 + Math.sin(t * 23.9 + 1.7) * 0.4) * SHAKE_BUMP * 0.35 * sp * cine.shake * (1 - aim)
      pitch += bump; roll += bump * 0.3
    }
    this.camera.rotateX(pitch); this.camera.rotateY(yaw); this.camera.rotateZ(roll)
  }

  /** FOV 阻尼；按 0.1° 量化后才更新投影（CSM 按投影变化重算分割，避免每帧触发） */
  private applyFov(want: number, dt: number) {
    this.fov = damp(this.fov, want, 1.5, dt)
    const q = Math.abs(this.fov - want) < 0.05 ? want : Math.round(this.fov * 10) / 10
    if (q !== this.camera.fov) { this.camera.fov = q; this.camera.updateProjectionMatrix() }
  }

  // ---------- Phase AIR：飞机相机 ----------
  /** 空中自由看的偏航 / 俯仰偏移（rad，鼠标拖动累加，1.5 s 无操作回正） */
  private airLookYaw = 0
  private airLookPitch = 0
  /** 上一帧 updateAir 结束时写回的 yaw / pitch（用来求本帧 applyMouse 的增量） */
  private airYawRef = NaN
  private airPitchRef = 0.27
  /** 追尾相机相对飞机的偏移（阻尼的是偏移而不是绝对位置，55 m/s 也不拖影） */
  private airOff = new THREE.Vector3(0, 4, -14)
  private airUp = new THREE.Vector3(0, 1, 0)
  private airInit = false
  private static readonly V3A = new THREE.Vector3()
  private static readonly V3B = new THREE.Vector3()
  private static readonly QA = new THREE.Quaternion()
  private static readonly QB = new THREE.Quaternion()
  private static readonly EA = new THREE.Euler()

  /** 离开飞机相机（下机 / 坠毁后）时调用：下次进入重新初始化 */
  resetAir() { this.airInit = false; this.airLookYaw = 0; this.airLookPitch = 0; this.airYawRef = NaN }

  /**
   * 飞机相机（不改 update 的车 / 步行分支）：
   * - chase：位置 = 飞机 − 前向 ×(14 + v·0.08) + 混合上方向 ×4，注视前方 25 m，相机 up 取 30% 机体 up（部分跟随横滚）；
   * - cockpit：眼点在机身局部 eye（默认 (0, 1.65, 0.7)），朝向 = 机体姿态。
   * 鼠标拖动自由看（偏移累加），1.5 s 无操作回正。结束时把 this.yaw 写成相机水平朝向（小地图用）。
   */
  updateAir(dt: number, body: FlightBody, view: 'chase' | 'cockpit', eye: { x: number; y: number; z: number } = { x: 0, y: 1.65, z: 0.7 }) {
    // 本帧鼠标增量（applyMouse 改的是 yaw / pitch）
    if (!Number.isNaN(this.airYawRef)) {
      this.airLookYaw += this.yaw - this.airYawRef
      this.airLookPitch -= this.pitch - this.airPitchRef
      this.airLookYaw = Math.atan2(Math.sin(this.airLookYaw), Math.cos(this.airLookYaw))
      this.airLookPitch = Math.max(-1.2, Math.min(1.2, this.airLookPitch))
    }
    this.idle += dt
    if (this.idle > 1.5) {
      this.airLookYaw = damp(this.airLookYaw, 0, 3, dt)
      this.airLookPitch = damp(this.airLookPitch, 0, 3, dt)
    }
    const f = fwdOf(body), u = upOf(body)
    const P = ChaseCamera.V3A.set(body.x, body.y, body.z)
    const cam = this.camera
    if (view === 'cockpit') {
      const q = ChaseCamera.QA.set(body.qx, body.qy, body.qz, body.qw)
      const e = ChaseCamera.V3B.set(eye.x, eye.y, eye.z).applyQuaternion(q)
      cam.position.copy(P).add(e)
      // 相机看 −z、机头 +z：q · Ry(π + lookYaw) · Rx(lookPitch)
      const look = ChaseCamera.QB.setFromEuler(ChaseCamera.EA.set(this.airLookPitch, Math.PI + this.airLookYaw, 0, 'YXZ'))
      cam.quaternion.copy(q).multiply(look)
      this.airInit = false
    } else {
      const v = airspeed(body)
      const dist = 14 + v * 0.08
      // 混合上方向：70% 世界上 + 30% 机体上
      const mu = ChaseCamera.V3B.set(u[0] * 0.3, u[1] * 0.3 + 0.7, u[2] * 0.3).normalize()
      const want = new THREE.Vector3(-f[0] * dist + mu.x * 4, -f[1] * dist + mu.y * 4, -f[2] * dist + mu.z * 4)
      // 自由看：绕世界 y 转 lookYaw，再抬 / 压 lookPitch
      if (this.airLookYaw !== 0 || this.airLookPitch !== 0) {
        want.applyAxisAngle(THREE.Object3D.DEFAULT_UP, this.airLookYaw)
        const side = new THREE.Vector3().crossVectors(want, THREE.Object3D.DEFAULT_UP)
        if (side.lengthSq() > 1e-6) want.applyAxisAngle(side.normalize(), -this.airLookPitch)
      }
      if (!this.airInit) { this.airOff.copy(want); this.airUp.copy(mu); this.airInit = true }
      this.airOff.lerp(want, 1 - Math.exp(-(this.idle < 1.5 ? 20 : 6) * dt))
      this.airUp.lerp(mu, 1 - Math.exp(-5 * dt)).normalize()
      cam.position.copy(P).add(this.airOff)
      // 地面以下不放相机（低空 / 滑跑时追尾相机贴地）
      if (cam.position.y < 1.2) cam.position.y = 1.2
      cam.up.copy(this.airUp)
      cam.lookAt(body.x + f[0] * 25, body.y + f[1] * 25 + 1.5, body.z + f[2] * 25)
      cam.up.set(0, 1, 0)
    }
    this.shakeAmt = 0
    this.applyFov(BASE_FOV + (view === 'chase' ? Math.min(6, Math.max(0, (airspeed(body) - 30) * 0.15)) : 0), dt)
    // 写回：yaw = 相机水平朝向（小地图旋转），pitch 复位成参考值
    const d = cam.getWorldDirection(ChaseCamera.V3B)
    this.yaw = Math.atan2(d.x, d.z)
    this.pitch = 0.27
    this.airYawRef = this.yaw
    this.airPitchRef = this.pitch
  }

  /** 近裁剪面（飞机：座舱 0.1、高空追尾放大到 1.5 防远处 Z 冲突）；只在变化时更新投影 */
  setNear(near: number) { if (near !== this.camera.near) { this.camera.near = near; this.camera.updateProjectionMatrix() } }

  /** 远裁剪面（真实城市要看到天际线，需 ≥ 1000 m） */
  setFar(far: number) { this.camera.far = far; this.camera.updateProjectionMatrix() }

  resize(aspect: number) { this.camera.aspect = aspect; this.camera.updateProjectionMatrix() }
}
