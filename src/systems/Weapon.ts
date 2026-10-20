import * as THREE from 'three'
import type { Ctx } from '../core/Context'
import type { Vehicle } from '../entities/Vehicle'
import type { Ped, Pedestrians } from '../entities/Pedestrians'
import { BUS_HEIGHT } from '../config'
import { rayBody } from '../physics/Collision'
import type { StaticBody } from '../world/Colliders'

export type ShotHit =
  | { kind: 'ped'; ped: Ped; point: THREE.Vector3 }
  | { kind: 'vehicle'; vehicle: Vehicle; point: THREE.Vector3 }
  | { kind: 'world'; point: THREE.Vector3 }
  | { kind: 'none'; point: THREE.Vector3 }

const RANGE = 120
const o2 = new THREE.Vector2(), d2 = new THREE.Vector2(), f2 = new THREE.Vector2()
const tmpBodies: StaticBody[] = []

/** 手枪：从相机准星发出的即时射线，命中行人/车辆/建筑；带曳光、枪口焰、击中火花 */
export class Weapon {
  readonly fireInterval = 0.26
  readonly vehicleDamage = 14
  private cooldown = 0
  private tracer: THREE.Line
  private tracerMat: THREE.LineBasicMaterial
  private flash: THREE.Mesh
  private spark: THREE.Mesh
  private flashT = 0
  private sparkT = 0
  private tracerT = 0

  constructor(scene: THREE.Scene) {
    this.tracerMat = new THREE.LineBasicMaterial({ color: 0xfff2a8, transparent: true, opacity: 0 })
    const g = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3()])
    this.tracer = new THREE.Line(g, this.tracerMat); this.tracer.frustumCulled = false
    this.flash = new THREE.Mesh(new THREE.BoxGeometry(0.25, 0.25, 0.5), new THREE.MeshBasicMaterial({ color: 0xffe08a }))
    this.spark = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.3, 0.3), new THREE.MeshBasicMaterial({ color: 0xffb347 }))
    this.flash.visible = this.spark.visible = false
    scene.add(this.tracer, this.flash, this.spark)
  }

  get ready() { return this.cooldown <= 0 }

  update(dt: number) {
    this.cooldown -= dt
    this.flashT -= dt; this.sparkT -= dt; this.tracerT -= dt
    this.flash.visible = this.flashT > 0
    this.spark.visible = this.sparkT > 0
    this.tracerMat.opacity = Math.max(0, this.tracerT / 0.08)
  }

  /** 开一枪：origin 为枪口，相机射线决定方向。返回命中信息 */
  fire(ctx: Ctx, peds: Pedestrians, camera: THREE.PerspectiveCamera, muzzle: THREE.Vector3): ShotHit {
    this.cooldown = this.fireInterval
    const o = camera.position.clone()
    const dir = camera.getWorldDirection(new THREE.Vector3()).normalize()
    // 忽略相机与玩家之间的那段（第三人称相机在身后）
    const px = ctx.player.worldX, pz = ctx.player.worldZ
    const tPlayer = Math.max(0, ((px - o.x) * dir.x + (pz - o.z) * dir.z) / (dir.x * dir.x + dir.z * dir.z || 1e-6))
    let tMin = tPlayer + 1.2
    let best = RANGE
    if (dir.y < -1e-4) best = Math.min(best, -o.y / dir.y)   // 打到地面
    let hit: ShotHit = { kind: 'none', point: new THREE.Vector3() }

    // 建筑/围墙：用 xz 分量在空间哈希上走格粗筛，再按 AABB/多边形足迹精确求交；
    // 2D 的 t 与 3D 射线参数一致，命中点高度 o.y + dir.y*t 需落在 [-0.1, body.h) 内
    for (const b of ctx.world.queryRay(o.x, o.z, dir.x, dir.z, best, tmpBodies)) {
      const t = rayBody(o.x, o.z, dir.x, dir.z, b)
      if (t !== null && t > tMin && t < best && o.y + dir.y * t < b.h && o.y + dir.y * t > -0.1) { best = t; hit = { kind: 'world', point: o.clone().addScaledVector(dir, t) } }
    }
    // 车辆：沿车身的若干圆柱（轿车 2 个，巴士 4 个）
    const c = { x: 0, z: 0 }
    for (const v of ctx.vehicles) {
      if (!v.active || v === ctx.player.vehicle) continue
      const dx = v.x - o.x, dz = v.z - o.z
      const reach = best + v.halfLen + 1
      if (dx * dx + dz * dz > reach * reach) continue
      const topY = v.model === 'bus' ? BUS_HEIGHT : 1.6
      for (let i = 0; i < v.circleCount; i++) {
        v.circle(i, c)
        const t = rayCircle(o, dir, c.x, c.z, v.radius + 0.1)
        if (t !== null && t > tMin && t < best) {
          const y = o.y + dir.y * t
          if (y >= 0 && y <= topY) { best = t; hit = { kind: 'vehicle', vehicle: v, point: o.clone().addScaledVector(dir, t) } }
        }
      }
    }
    // 行人
    for (const p of peds.peds) {
      if (!p.active || p.state === 'down') continue
      const t = rayCircle(o, dir, p.x, p.z, 0.55)
      if (t !== null && t > tMin && t < best) {
        const y = o.y + dir.y * t
        if (y >= 0 && y <= 1.9) { best = t; hit = { kind: 'ped', ped: p, point: o.clone().addScaledVector(dir, t) } }
      }
    }
    if (hit.kind === 'none') hit.point.copy(o).addScaledVector(dir, best)

    // 特效
    const pos = this.tracer.geometry.attributes.position as THREE.BufferAttribute
    pos.setXYZ(0, muzzle.x, muzzle.y, muzzle.z); pos.setXYZ(1, hit.point.x, hit.point.y, hit.point.z); pos.needsUpdate = true
    this.tracerT = 0.08
    this.flash.position.copy(muzzle); this.flash.lookAt(hit.point); this.flashT = 0.05
    if (hit.kind !== 'none') { this.spark.position.copy(hit.point); this.sparkT = 0.09 }
    return hit
  }
}

function rayCircle(o: THREE.Vector3, dir: THREE.Vector3, cx: number, cz: number, r: number): number | null {
  o2.set(o.x, o.z); d2.set(dir.x, dir.z)
  const L = d2.length(); if (L < 1e-6) return null
  d2.divideScalar(L)
  f2.set(cx - o2.x, cz - o2.y)
  const tca = f2.dot(d2)
  if (tca < 0) return null
  const dd = f2.lengthSq() - tca * tca
  if (dd > r * r) return null
  const t2 = tca - Math.sqrt(r * r - dd)
  return t2 / L   // 换算回 3D 射线参数
}
