import * as THREE from 'three'
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js'
import { CAR_LEN, CAR_WID, CAR_CIRCLE_OFF, CAR_CIRCLE_R, type VehicleKind } from '../config'
import { stepVehicle, forwardSpeed, steerFactor, type Controls, type VehicleBody } from '../physics/ArcadeVehicle'
import type { Body } from '../physics/Collision'

export type Driver = 'none' | 'player' | 'traffic' | 'police'

let sharedDetail: THREE.BufferGeometry | null = null
let sharedDetailMat: THREE.Material | null = null
let sharedShadowGeo: THREE.PlaneGeometry | null = null
let sharedShadowMat: THREE.Material | null = null

function detailGeometry() {
  if (sharedDetail) return sharedDetail
  const parts: THREE.BufferGeometry[] = []
  const colored = (g: THREE.BufferGeometry, hex: number) => {
    const c = new THREE.Color(hex), n = g.attributes.position.count, arr = new Float32Array(n * 3)
    for (let i = 0; i < n; i++) { arr[i * 3] = c.r; arr[i * 3 + 1] = c.g; arr[i * 3 + 2] = c.b }
    g.setAttribute('color', new THREE.BufferAttribute(arr, 3)); return g
  }
  // 车顶舱
  parts.push(colored(new THREE.BoxGeometry(CAR_WID - 0.35, 0.55, CAR_LEN * 0.48).translate(0, 1.22, -0.25), 0x1c2733))
  // 四个轮子
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
    parts.push(colored(new THREE.CylinderGeometry(0.36, 0.36, 0.3, 10).rotateZ(Math.PI / 2).translate(sx * (CAR_WID / 2 - 0.1), 0.36, sz * 1.45), 0x151515))
  }
  // 前灯（暖白）后灯（红）
  for (const sx of [-1, 1]) {
    parts.push(colored(new THREE.BoxGeometry(0.4, 0.2, 0.1).translate(sx * 0.7, 0.75, CAR_LEN / 2 + 0.02), 0xfff2b0))
    parts.push(colored(new THREE.BoxGeometry(0.4, 0.2, 0.1).translate(sx * 0.7, 0.75, -CAR_LEN / 2 - 0.02), 0xff2a2a))
  }
  // 保险杠
  parts.push(colored(new THREE.BoxGeometry(CAR_WID, 0.25, 0.2).translate(0, 0.45, CAR_LEN / 2 + 0.05), 0x2a2a2e))
  parts.push(colored(new THREE.BoxGeometry(CAR_WID, 0.25, 0.2).translate(0, 0.45, -CAR_LEN / 2 - 0.05), 0x2a2a2e))
  sharedDetail = mergeGeometries(parts, false)!
  sharedDetailMat = new THREE.MeshLambertMaterial({ vertexColors: true })
  return sharedDetail
}

export class Vehicle implements VehicleBody, Body {
  x = 0; z = 0; yaw = 0; vx = 0; vz = 0
  readonly radius = CAR_CIRCLE_R
  readonly mass = 1200
  health = 100
  wrecked = false
  active = false
  /** 运动学模式：位置由 AI 直接设置，不跑物理积分、不与静态体碰撞 */
  kinematic = false
  driver: Driver = 'none'
  controls: Controls = { throttle: 0, steer: 0, handbrake: false }
  /** 交通 / 警车 AI 的私有状态，由对应系统填充 */
  ai: unknown = null
  /** 最近一次被玩家车辆撞击的时间（任务计数用） */
  lastHitByPlayer = -1
  /** 报废时刻（用于回收） */
  wreckedAt = -1
  group = new THREE.Group()
  private bodyMat: THREE.MeshLambertMaterial
  private bodyMesh: THREE.Mesh
  private siren: THREE.Mesh | null = null
  private sirenMat: THREE.MeshBasicMaterial | null = null
  baseColor: THREE.Color

  constructor(public kind: VehicleKind, color: number) {
    this.baseColor = new THREE.Color(color)
    this.bodyMat = new THREE.MeshLambertMaterial({ color })
    this.bodyMesh = new THREE.Mesh(new THREE.BoxGeometry(CAR_WID, 0.62, CAR_LEN), this.bodyMat)
    this.bodyMesh.position.y = 0.66
    const detail = new THREE.Mesh(detailGeometry(), sharedDetailMat!)
    sharedShadowGeo ??= new THREE.PlaneGeometry(CAR_WID + 0.7, CAR_LEN + 0.7).rotateX(-Math.PI / 2)
    sharedShadowMat ??= new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.35, depthWrite: false })
    const shadow = new THREE.Mesh(sharedShadowGeo, sharedShadowMat)
    shadow.position.y = 0.03
    this.group.add(this.bodyMesh, detail, shadow)
    if (kind === 'police') {
      const stripe = new THREE.Mesh(new THREE.BoxGeometry(CAR_WID + 0.02, 0.2, CAR_LEN * 0.9), new THREE.MeshLambertMaterial({ color: 0x1e4fd8 }))
      stripe.position.y = 0.7
      this.sirenMat = new THREE.MeshBasicMaterial({ color: 0xff2020 })
      this.siren = new THREE.Mesh(new THREE.BoxGeometry(1.1, 0.18, 0.4), this.sirenMat)
      this.siren.position.set(0, 1.58, -0.2)
      this.group.add(stripe, this.siren)
    }
    this.group.visible = false
  }

  get speed() { return forwardSpeed(this) }
  get absSpeed() { return Math.hypot(this.vx, this.vz) }

  activate(x: number, z: number, yaw: number) {
    this.x = x; this.z = z; this.yaw = yaw; this.vx = this.vz = 0
    this.health = 100; this.wrecked = false; this.wreckedAt = -1
    this.bodyMat.color.copy(this.baseColor)
    this.controls.throttle = 0; this.controls.steer = 0; this.controls.handbrake = false
    this.active = true; this.group.visible = true; this.ai = null; this.driver = 'none'; this.kinematic = false
    this.sync(0)
  }
  deactivate() { this.active = false; this.group.visible = false; this.driver = 'none'; this.ai = null; this.kinematic = false }

  /** 前(0)/后(1) 碰撞圆的圆心 */
  circle(i: 0 | 1, out: { x: number; z: number }) {
    const s = i === 0 ? CAR_CIRCLE_OFF : -CAR_CIRCLE_OFF
    out.x = this.x + Math.sin(this.yaw) * s
    out.z = this.z + Math.cos(this.yaw) * s
    return out
  }

  step(dt: number) {
    if (this.wrecked) { this.controls.throttle = 0; this.controls.steer = 0; this.controls.handbrake = true }
    stepVehicle(this, this.controls, this.kind, dt)
  }

  damage(amount: number) {
    if (this.wrecked || amount <= 0) return
    this.health -= amount
    const t = Math.max(0, this.health) / 100
    this.bodyMat.color.copy(this.baseColor).lerp(new THREE.Color(0x2b2b2b), (1 - t) * 0.6)
    if (this.health <= 0) {
      this.wrecked = true
      this.kinematic = false
      this.bodyMat.color.set(0x242424)
    }
  }

  sync(time: number) {
    this.group.position.set(this.x, 0, this.z)
    this.group.rotation.y = this.yaw
    // 转向时车身轻微侧倾
    this.bodyMesh.rotation.z = -this.controls.steer * 0.05 * steerFactor(this.speed) * Math.sign(this.speed || 1)
    if (this.sirenMat) {
      this.sirenMat.color.set(Math.floor(time * 6) % 2 === 0 ? 0xff2020 : 0x2060ff)
    }
  }
}
