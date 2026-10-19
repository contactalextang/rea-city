import * as THREE from 'three'
import { PED_R, clamp } from '../config'
import type { Body } from '../physics/Collision'
import { circleAABB } from '../physics/Collision'
import type { AABB, StaticWorld } from '../world/Colliders'
import type { Vehicle } from './Vehicle'
import type { Input } from '../core/Input'

const tmpBoxes: AABB[] = []

/** 玩家：步行控制、上下车、血量与金钱 */
export class Player implements Body {
  x = 0; z = 0; y = 0; vy = 0; yaw = 0; vx = 0; vz = 0
  readonly radius = PED_R
  readonly mass = 90
  health = 100
  money = 0
  vehicle: Vehicle | null = null
  group = new THREE.Group()
  private legs: THREE.Mesh
  private phase = 0
  private latchYaw = 0
  private lastKeys = ''
  private hurtTimer = 0
  private steerCur = 0
  private skinMat: THREE.MeshLambertMaterial
  private gun: THREE.Mesh
  private armR: THREE.Mesh
  aiming = false

  constructor() {
    this.skinMat = new THREE.MeshLambertMaterial({ color: 0xf1c7a3 })
    const shirt = new THREE.MeshLambertMaterial({ color: 0xf2f2f2 })
    const pants = new THREE.MeshLambertMaterial({ color: 0x2f3b5c })
    this.legs = new THREE.Mesh(new THREE.BoxGeometry(0.42, 0.8, 0.28), pants); this.legs.position.y = 0.4
    const torso = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.62, 0.3), shirt); torso.position.y = 1.11
    const head = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.32, 0.3), this.skinMat); head.position.y = 1.6
    const armL = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.6, 0.14), this.skinMat); armL.position.set(-0.33, 1.1, 0)
    const armR = armL.clone(); armR.position.x = 0.33
    this.armR = armR
    this.gun = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.14, 0.34), new THREE.MeshLambertMaterial({ color: 0x1c1c1c }))
    this.gun.position.set(0.36, 1.0, 0.3)
    const cap = new THREE.Mesh(new THREE.BoxGeometry(0.34, 0.1, 0.36), new THREE.MeshLambertMaterial({ color: 0xc0392b })); cap.position.set(0, 1.79, 0.02)
    this.group.add(this.legs, torso, head, armL, armR, cap, this.gun)
  }

  get inVehicle() { return this.vehicle !== null }
  get worldX() { return this.vehicle ? this.vehicle.x : this.x }
  get worldZ() { return this.vehicle ? this.vehicle.z : this.z }
  get worldVX() { return this.vehicle ? this.vehicle.vx : this.vx }
  get worldVZ() { return this.vehicle ? this.vehicle.vz : this.vz }

  place(x: number, z: number, yaw: number) {
    this.x = x; this.z = z; this.yaw = yaw; this.vx = this.vz = 0; this.y = 0; this.vy = 0
  }

  /** 读取输入 → 车辆控制 或 步行运动 */
  update(dt: number, input: Input, camYaw: number, world: StaticWorld, enabled: boolean) {
    const live = input.locked   // 鼠标控制视角时，移动方向实时跟随相机
    this.hurtTimer = Math.max(0, this.hurtTimer - dt)
    if (this.vehicle) {
      const c = this.vehicle.controls
      if (enabled) {
        c.throttle = input.axis('KeyS', 'KeyW') + input.axis('ArrowDown', 'ArrowUp')
        c.steer = input.axis('KeyA', 'KeyD') + input.axis('ArrowLeft', 'ArrowRight')
        c.throttle = clamp(c.throttle, -1, 1)
        // 键盘转向做平滑：打满约 0.15s，回正更快，避免一按就甩
        const want = clamp(c.steer, -1, 1)
        const rate = Math.abs(want) > Math.abs(this.steerCur) ? 7 : 12
        this.steerCur += clamp(want - this.steerCur, -rate * dt, rate * dt)
        c.steer = this.steerCur
        c.handbrake = input.down('Space')
      } else { c.throttle = 0; c.steer = 0; c.handbrake = false }
      return
    }
    // 步行：输入组合变化时锁定当时的相机朝向，避免相机跟随造成螺旋
    const fwdIn = enabled ? input.axis('KeyS', 'KeyW') + input.axis('ArrowDown', 'ArrowUp') : 0
    const sideIn = enabled ? input.axis('KeyA', 'KeyD') + input.axis('ArrowLeft', 'ArrowRight') : 0
    const keys = `${fwdIn},${sideIn}`
    if (keys !== this.lastKeys || live) { this.lastKeys = keys; this.latchYaw = camYaw }
    const running = enabled && (input.down('ShiftLeft') || input.down('ShiftRight'))
    const speed = running ? 7.5 : 3.6
    let mx = 0, mz = 0
    if (fwdIn !== 0 || sideIn !== 0) {
      const fx = Math.sin(this.latchYaw), fz = Math.cos(this.latchYaw)
      const rx = -fz, rz = fx
      mx = fx * fwdIn + rx * sideIn; mz = fz * fwdIn + rz * sideIn
      const len = Math.hypot(mx, mz); mx /= len; mz /= len
      if (!this.aiming) this.yaw = Math.atan2(mx, mz)
    }
    // 瞄准模式（指针锁定）：始终面向相机方向，移动变成平移
    if (this.aiming) this.yaw = camYaw
    const accel = 1 - Math.exp(-12 * dt)
    this.vx += (mx * speed - this.vx) * accel
    this.vz += (mz * speed - this.vz) * accel
    if (enabled && input.justPressed('Space') && this.y <= 0.001) this.vy = 5.2
    this.vy -= 16 * dt
    this.y += this.vy * dt
    if (this.y < 0) { this.y = 0; this.vy = 0 }
    this.x += this.vx * dt; this.z += this.vz * dt
    // 与楼房/路灯/围墙碰撞：只推出不反弹
    for (const b of world.query(this.x, this.z, this.radius, tmpBoxes)) {
      const c = circleAABB(this.x, this.z, this.radius, b)
      if (c) { this.x += c.nx * c.depth; this.z += c.nz * c.depth }
    }
    this.phase += Math.hypot(this.vx, this.vz) * dt * 2.2
  }

  /** 搜索可上的车：中心距 < 3.6m 的最近车辆 */
  findNearbyVehicle(vehicles: Vehicle[]): Vehicle | null {
    let best: Vehicle | null = null, bestD = 3.6
    for (const v of vehicles) {
      if (!v.active || v.driver === 'player') continue
      const d = Math.hypot(v.x - this.x, v.z - this.z)
      if (d < bestD) { bestD = d; best = v }
    }
    return best
  }

  enter(v: Vehicle) {
    this.vehicle = v
    v.driver = 'player'; v.ai = null; v.kinematic = false
    v.controls.throttle = 0; v.controls.steer = 0; v.controls.handbrake = false
    this.group.visible = false
  }

  /** 下车：驾驶座在右（靠左行驶），优先从右侧下；右侧被静态体挡住则改左侧 */
  exit(world: StaticWorld) {
    const v = this.vehicle; if (!v) return
    const fx = Math.sin(v.yaw), fz = Math.cos(v.yaw)
    const rx = -fz, rz = fx            // 右侧单位向量
    let ex = v.x + rx * 2.3, ez = v.z + rz * 2.3
    const blocked = world.query(ex, ez, this.radius, tmpBoxes).some((b) => circleAABB(ex, ez, this.radius, b) !== null)
    if (blocked) { ex = v.x - rx * 2.3; ez = v.z - rz * 2.3 }
    this.place(ex, ez, v.yaw)
    this.vx = v.vx * 0.3; this.vz = v.vz * 0.3
    v.driver = 'none'; v.controls.throttle = 0; v.controls.steer = 0; v.controls.handbrake = true
    this.vehicle = null
    this.group.visible = true
  }

  damage(amount: number) {
    if (amount <= 0) return
    this.health = Math.max(0, this.health - amount)
    this.hurtTimer = 0.25
  }

  sync() {
    if (this.vehicle) return
    this.group.position.set(this.x, this.y, this.z)
    this.group.rotation.y = this.yaw
    const moving = Math.hypot(this.vx, this.vz) > 0.3
    this.legs.rotation.x = moving ? Math.sin(this.phase * 3) * 0.5 : 0
    this.group.position.y += moving ? Math.abs(Math.sin(this.phase * 3)) * 0.06 : 0
    this.skinMat.color.set(this.hurtTimer > 0 ? 0xff6b6b : 0xf1c7a3)
    // 瞄准时右臂抬平、枪举到胸前
    this.armR.rotation.x = this.aiming ? -Math.PI / 2 : 0
    this.armR.position.set(0.33, this.aiming ? 1.3 : 1.1, this.aiming ? 0.3 : 0)
    this.gun.position.set(0.36, this.aiming ? 1.3 : 1.0, this.aiming ? 0.62 : 0.3)
  }

  /** 枪口世界坐标 */
  muzzle(out: THREE.Vector3) {
    if (this.vehicle) {
      const v = this.vehicle
      return out.set(v.x - Math.cos(v.yaw) * 1.0, 1.25, v.z + Math.sin(v.yaw) * 1.0)
    }
    const fx = Math.sin(this.yaw), fz = Math.cos(this.yaw)
    const rx = -fz, rz = fx
    return out.set(this.x + fx * 0.75 + rx * 0.36, this.y + (this.aiming ? 1.3 : 1.0), this.z + fz * 0.75 + rz * 0.36)
  }
}
