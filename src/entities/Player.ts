import * as THREE from 'three'
import { PED_R, clamp } from '../config'
import type { Body } from '../physics/Collision'
import { circleBody } from '../physics/Collision'
import type { AABB, StaticWorld } from '../world/Colliders'
import type { Vehicle } from './Vehicle'
import type { Input } from '../core/Input'
import type { CharacterLibrary } from '../characters/CharacterLibrary'
import { CharacterInstance } from '../characters/CharacterInstance'
import type { CharacterSpec } from '../characters/CharacterSpec'

const tmpBoxes: AABB[] = []
const tmpV = new THREE.Vector3()
/** 右手骨候选名（three 会去掉节点名里的 . 和 :，按顺序找第一个存在的） */
const HAND_BONES = ['Fist.R', 'FistR', 'Hand.R', 'HandR', 'WristR', 'Wrist.R', 'LowerArmR']
/** 速度阈值：低于 WALK_MIN 视为静止，高于 RUN_MIN 播 Run */
const WALK_MIN = 0.3, RUN_MIN = 5

/** 玩家乘坐的非车辆载具（Phase AIR 飞机）：由插件驱动，Player 只读位置与水平速度 */
export interface Mount {
  x: number; y: number; z: number; vx: number; vz: number; yaw: number
  /** 存档落点（空中存档 → 读档落在机库门口）；缺省用当前位置 */
  saveSpot?(): { x: number; z: number; yaw: number }
}

/** 玩家：步行控制、上下车、血量与金钱 */
export class Player implements Body {
  x = 0; z = 0; y = 0; vy = 0; yaw = 0; vx = 0; vz = 0
  readonly radius = PED_R
  readonly mass = 90
  health = 100
  money = 0
  vehicle: Vehicle | null = null
  /** 正在驾驶的飞机（不在 game.vehicles 里；与 vehicle 互斥） */
  mount: Mount | null = null
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
  /** 步行/奔跑速度倍率（Needs 低饥饿/低精力时 0.7） */
  speedMul = 1
  /** 本步是否在奔跑（Needs 额外耗精力） */
  running = false
  /** 醉意系数 0–1（Game 每步按夜店醉意写入；0 = 清醒，手感完全不变）：开车转向带噪声、步行左右飘 */
  drunk = 0
  private drunkT = 0
  /** 骨骼角色（chars=gltf 且角色库加载成功）；null = 盒子人 */
  char: CharacterInstance | null = null
  /** 盒子人部件（骨骼角色启用后从 group 移除） */
  private box = new THREE.Group()
  private handBone: THREE.Bone | null = null
  private shootT = 0
  private tinted = false

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
    this.box.add(this.legs, torso, head, armL, armR, cap, this.gun)
    this.group.add(this.box)
  }

  /** 换成骨骼角色：盒子部件移出 group；枪改为挂在右手骨位置（每帧在 animate 里跟随） */
  useCharacter(lib: CharacterLibrary, spec: CharacterSpec) {
    if (this.char) { this.char.setSpec(spec); return }
    this.char = new CharacterInstance(lib, spec)
    this.char.mesh.name = 'player'
    this.group.remove(this.box)
    this.group.add(this.char.group)
    for (const n of HAND_BONES) {
      const b = this.char.skeleton.bones.find((x) => x.name === n)
      if (b) { this.handBone = b; break }
    }
    // 小黑盒手枪：直接挂在 player.group 下，按手骨世界坐标摆放、朝向跟随身体（不受骨骼缩放/朝向影响）
    this.box.remove(this.gun)
    this.gun.geometry.dispose()
    this.gun.geometry = new THREE.BoxGeometry(0.05, 0.1, 0.22)
    this.group.add(this.gun)
    this.char.play('Idle', { fade: 0 })
  }

  /** 换装：只换外观几何，动画状态不变 */
  setSpec(spec: CharacterSpec) { this.char?.setSpec(spec) }
  get spec(): CharacterSpec | null { return this.char?.spec ?? null }

  /** 枪可见（只有能开枪的身份显示） */
  showGun = true

  /** 开枪瞬间：播一次 Shoot（静止瞄准时） */
  onShoot() { this.shootT = 0.3 }

  get inVehicle() { return this.vehicle !== null }
  /** 正在开飞机 */
  get piloting() { return this.mount !== null }
  /** 步行（不在车里也不在飞机里） */
  get onFoot() { return !this.vehicle && !this.mount }
  get worldX() { return this.vehicle ? this.vehicle.x : this.mount ? this.mount.x : this.x }
  get worldZ() { return this.vehicle ? this.vehicle.z : this.mount ? this.mount.z : this.z }
  get worldVX() { return this.vehicle ? this.vehicle.vx : this.mount ? this.mount.vx : this.vx }
  get worldVZ() { return this.vehicle ? this.vehicle.vz : this.mount ? this.mount.vz : this.vz }
  /** 世界高度（飞机在空中时 > 0） */
  get worldY() { return this.mount ? this.mount.y : this.y }

  place(x: number, z: number, yaw: number) {
    this.x = x; this.z = z; this.yaw = yaw; this.vx = this.vz = 0; this.y = 0; this.vy = 0
  }

  /** 读取输入 → 车辆控制 或 步行运动 */
  update(dt: number, input: Input, camYaw: number, world: StaticWorld, enabled: boolean) {
    const live = input.locked || input.lookActive   // 鼠标 / 触屏控制视角时，移动方向实时跟随相机
    this.hurtTimer = Math.max(0, this.hurtTimer - dt)
    this.running = false
    if (this.mount) return   // 飞行输入由 aviation 插件读取
    if (this.vehicle) {
      const c = this.vehicle.controls
      if (enabled) {
        const mv = input.moveAxis()
        c.throttle = mv.fwd
        c.steer = mv.side
        // 键盘转向做平滑：低速打满约 0.15 s，速度越高打方向越慢（30 m/s 约 0.4 s），回正始终较快，避免一按就甩
        const want = clamp(c.steer, -1, 1)
        const sp = Math.abs(this.vehicle.speed)
        const rate = Math.abs(want) > Math.abs(this.steerCur) ? 7 / (1 + Math.max(0, sp - 8) / 12) : 12
        this.steerCur += clamp(want - this.steerCur, -rate * dt, rate * dt)
        c.steer = this.steerCur
        if (this.drunk > 0) {
          // 醉驾：低频的方向漂移（两个不成倍数的正弦叠加），随车速略增，最多约 ±0.22 打角
          this.drunkT += dt
          const t = this.drunkT, k = this.drunk * Math.min(1, 0.4 + sp / 25)
          c.steer = clamp(c.steer + (Math.sin(t * 1.3) + 0.6 * Math.sin(t * 2.9 + 1.7)) * 0.14 * k, -1, 1)
        }
        c.handbrake = input.down('Space')
      } else { c.throttle = 0; c.steer = 0; c.handbrake = false }
      return
    }
    // 步行：输入组合变化时锁定当时的相机朝向，避免相机跟随造成螺旋
    const mv = enabled ? input.moveAxis() : { fwd: 0, side: 0 }
    const fwdIn = mv.fwd, sideIn = mv.side
    // 摇杆是模拟量、每帧微变：按 8 方向量化后再判断“输入组合变化”，否则每帧重锁朝向
    const keys = fwdIn !== 0 || sideIn !== 0 ? String(Math.round(Math.atan2(sideIn, fwdIn) / (Math.PI / 4))) : ''
    if (keys !== this.lastKeys || live) { this.lastKeys = keys; this.latchYaw = camYaw }
    const running = enabled && (input.down('ShiftLeft') || input.down('ShiftRight')) && (fwdIn !== 0 || sideIn !== 0)
    this.running = running
    const speed = (running ? 7.5 : 3.6) * this.speedMul
    let mx = 0, mz = 0
    if (fwdIn !== 0 || sideIn !== 0) {
      const fx = Math.sin(this.latchYaw), fz = Math.cos(this.latchYaw)
      const rx = -fz, rz = fx
      mx = fx * fwdIn + rx * sideIn; mz = fz * fwdIn + rz * sideIn
      const len = Math.hypot(mx, mz); mx /= len; mz /= len
      if (this.drunk > 0) {
        // 醉酒步行：移动方向左右摆（最多约 ±20°）
        this.drunkT += dt
        const a = (Math.sin(this.drunkT * 1.1) + 0.5 * Math.sin(this.drunkT * 2.3 + 0.9)) * 0.24 * this.drunk
        const ca = Math.cos(a), sa = Math.sin(a)
        const nx = mx * ca + mz * sa, nz = -mx * sa + mz * ca
        mx = nx; mz = nz
      }
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
      const c = circleBody(this.x, this.z, this.radius, b)
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
    const blocked = world.query(ex, ez, this.radius, tmpBoxes).some((b) => circleBody(ex, ez, this.radius, b) !== null)
    if (blocked) { ex = v.x - rx * 2.3; ez = v.z - rz * 2.3 }
    this.place(ex, ez, v.yaw)
    this.vx = v.vx * 0.3; this.vz = v.vz * 0.3
    v.driver = 'none'; v.controls.throttle = 0; v.controls.steer = 0; v.controls.handbrake = true
    this.vehicle = null
    this.group.visible = true
  }

  /** 登机：角色隐藏，位置跟随飞机（worldX/Z） */
  board(m: Mount) {
    this.mount = m
    this.vx = this.vz = 0
    this.group.visible = false
  }

  /** 下飞机：站到 (x, z)，朝向 yaw */
  leaveMount(x: number, z: number, yaw: number) {
    if (!this.mount) return
    this.mount = null
    this.place(x, z, yaw)
    this.group.visible = true
  }

  damage(amount: number) {
    if (amount <= 0) return
    this.health = Math.max(0, this.health - amount)
    this.hurtTimer = 0.25
  }

  sync() {
    if (this.vehicle || this.mount) return
    this.group.position.set(this.x, this.y, this.z)
    this.group.rotation.y = this.yaw
    if (this.char) return
    const moving = Math.hypot(this.vx, this.vz) > 0.3
    this.legs.rotation.x = moving ? Math.sin(this.phase * 3) * 0.5 : 0
    this.group.position.y += moving ? Math.abs(Math.sin(this.phase * 3)) * 0.06 : 0
    this.skinMat.color.set(this.hurtTimer > 0 ? 0xff6b6b : 0xf1c7a3)
    // 瞄准时右臂抬平、枪举到胸前
    this.armR.rotation.x = this.aiming ? -Math.PI / 2 : 0
    this.armR.position.set(0.33, this.aiming ? 1.3 : 1.1, this.aiming ? 0.3 : 0)
    this.gun.position.set(0.36, this.aiming ? 1.3 : 1.0, this.aiming ? 0.62 : 0.3)
  }

  /**
   * 骨骼角色动画状态机（每帧一次，帧 dt）：
   * 死亡 Death（定格）> 瞄准（静止 Aim / 开枪瞬间 Shoot，移动 RunShoot）> 跑 Run > 走 Walk（timeScale 随速度 0.8–1.3）> Idle。
   * 跳跃不换动画（保持当前动作，group 随 y 抬高）。受伤 emissive 闪红。
   */
  animate(dt: number) {
    const c = this.char
    if (!c || this.vehicle || this.mount) return
    this.shootT = Math.max(0, this.shootT - dt)
    const speed = Math.hypot(this.vx, this.vz)
    if (this.health <= 0) {
      if (c.current !== 'Death') c.play('Death', { loop: false, fade: 0.2 })
    } else if (this.aiming) {
      if (speed > 1.2) c.play('RunShoot', { timeScale: Math.min(1.3, Math.max(0.8, speed / 6)) })
      else if (this.shootT > 0) { if (c.current !== 'Shoot') c.play('Shoot', { loop: false, fade: 0.05 }) }
      else if (c.current !== 'Shoot' || c.finished) c.play('Aim', { fade: 0.12 })
    } else if (this.y > 0.05 && c.current !== 'Death') {
      // 空中：保持当前动画
    } else if (speed > RUN_MIN) c.play('Run', { timeScale: Math.min(1.3, Math.max(0.8, speed / 7.5)) })
    else if (speed > WALK_MIN) c.play('Walk', { timeScale: Math.min(1.3, Math.max(0.8, speed / 3.0)) })
    else c.play('Idle', { fade: 0.25 })
    const hurt = this.hurtTimer > 0
    if (hurt !== this.tinted) { this.tinted = hurt; c.setTint(hurt ? 0xff2a2a : null, 0.6) }
    c.update(dt, 0)
    // 枪跟手：手骨世界坐标 → group 局部；朝向沿身体前方
    this.gun.visible = this.showGun
    if (this.showGun && this.handBone) {
      this.group.updateMatrixWorld()
      this.handBone.getWorldPosition(tmpV)
      this.group.worldToLocal(tmpV)
      this.gun.position.set(tmpV.x, tmpV.y, tmpV.z + 0.08)
      this.gun.rotation.set(0, 0, 0)
    }
  }

  /** 枪口世界坐标 */
  muzzle(out: THREE.Vector3) {
    if (this.vehicle) {
      const v = this.vehicle
      return out.set(v.x - Math.cos(v.yaw) * 1.0, 1.25, v.z + Math.sin(v.yaw) * 1.0)
    }
    if (this.char && this.handBone) {
      // 手骨世界坐标 + 身体前向 0.25 m
      this.handBone.getWorldPosition(out)
      return out.set(out.x + Math.sin(this.yaw) * 0.25, out.y, out.z + Math.cos(this.yaw) * 0.25)
    }
    const fx = Math.sin(this.yaw), fz = Math.cos(this.yaw)
    const rx = -fz, rz = fx
    return out.set(this.x + fx * 0.75 + rx * 0.36, this.y + (this.aiming ? 1.3 : 1.0), this.z + fz * 0.75 + rz * 0.36)
  }
}
