import * as THREE from 'three'
import { MAX_PEDS, PED_R, DESPAWN_DIST, rand, pick, wrapAngle, dampAngle } from '../config'
import type { RoadEdge, P2 } from '../world/RoadGraph'
import type { Ctx, EventBus } from '../core/Context'
import { circleAABB } from '../physics/Collision'
import type { AABB } from '../world/Colliders'

type PedState = 'walk' | 'flee' | 'return' | 'down'
export interface Ped {
  active: boolean
  x: number; z: number; yaw: number; vx: number; vz: number
  state: PedState
  edge: RoadEdge | null; t: number
  speed: number; timer: number; phase: number
  radius: number
}

const SHIRTS = [0xe74c3c, 0x3498db, 0x2ecc71, 0xf1c40f, 0x9b59b6, 0xecf0f1, 0x34495e, 0xe67e22, 0x1abc9c, 0xff8fab]
const tmpP: P2 = { x: 0, z: 0 }
const tmpBoxes: AABB[] = []
const circ = { x: 0, z: 0 }
const M = new THREE.Matrix4(), Q = new THREE.Quaternion(), V = new THREE.Vector3(), S = new THREE.Vector3(1, 1, 1)
const AX = new THREE.Vector3(1, 0, 0)

/** 行人群：InstancedMesh 渲染（头/身/腿三批），沿人行道巡走，受惊逃跑，被撞倒地 */
export class Pedestrians {
  peds: Ped[] = []
  private head: THREE.InstancedMesh
  private torso: THREE.InstancedMesh
  private legs: THREE.InstancedMesh

  constructor(scene: THREE.Scene, private events: EventBus) {
    for (let i = 0; i < MAX_PEDS; i++) this.peds.push({ active: false, x: 0, z: 0, yaw: 0, vx: 0, vz: 0, state: 'walk', edge: null, t: 0, speed: 1.4, timer: 0, phase: 0, radius: PED_R })
    const skin = new THREE.MeshLambertMaterial({ color: 0xe8b894 })
    this.head = new THREE.InstancedMesh(new THREE.BoxGeometry(0.28, 0.3, 0.28).translate(0, 1.55, 0), skin, MAX_PEDS)
    this.torso = new THREE.InstancedMesh(new THREE.BoxGeometry(0.46, 0.6, 0.28).translate(0, 1.08, 0), new THREE.MeshLambertMaterial({ color: 0xffffff }), MAX_PEDS)
    this.legs = new THREE.InstancedMesh(new THREE.BoxGeometry(0.4, 0.78, 0.26).translate(0, 0.39, 0), new THREE.MeshLambertMaterial({ color: 0x2b2f3a }), MAX_PEDS)
    for (const m of [this.head, this.torso, this.legs]) { m.frustumCulled = false; m.count = MAX_PEDS }
    scene.add(this.head, this.torso, this.legs)
    for (let i = 0; i < MAX_PEDS; i++) this.hide(i)
  }

  get activeCount() { return this.peds.reduce((n, p) => n + (p.active ? 1 : 0), 0) }

  private hide(i: number) {
    M.makeScale(0, 0, 0)
    this.head.setMatrixAt(i, M); this.torso.setMatrixAt(i, M); this.legs.setMatrixAt(i, M)
  }

  spawnOnEdge(edge: RoadEdge, t: number, ctx: Ctx): Ped | null {
    const p = this.peds.find((q) => !q.active); if (!p) return null
    ctx.graph.sidewalkPoint(edge, t, tmpP)
    this.init(p, tmpP.x, tmpP.z, 'walk')
    p.edge = edge; p.t = t; p.yaw = Math.atan2(edge.dx, edge.dz)
    return p
  }

  /** 在指定位置生成一个处于逃跑状态的行人（被抢车的司机） */
  spawnFleeing(x: number, z: number, awayX: number, awayZ: number): Ped | null {
    const p = this.peds.find((q) => !q.active); if (!p) return null
    this.init(p, x, z, 'flee')
    p.yaw = Math.atan2(x - awayX, z - awayZ); p.timer = 3; p.speed = 5
    return p
  }

  private init(p: Ped, x: number, z: number, state: PedState) {
    p.active = true; p.x = x; p.z = z; p.vx = p.vz = 0; p.state = state
    p.speed = rand(1.2, 1.9); p.timer = 0; p.phase = Math.random() * 10; p.edge = null
    this.torso.setColorAt(this.peds.indexOf(p), new THREE.Color(pick(SHIRTS)))
    if (this.torso.instanceColor) this.torso.instanceColor.needsUpdate = true
  }

  /** 枪声：半径内的行人背离声源逃跑 */
  scare(x: number, z: number, radius: number) {
    for (const p of this.peds) {
      if (!p.active || p.state === 'down') continue
      const dx = p.x - x, dz = p.z - z
      if (dx * dx + dz * dz > radius * radius) continue
      p.state = 'flee'; p.timer = rand(2.5, 4); p.speed = rand(4.5, 5.5)
      p.yaw = Math.atan2(dx, dz) + rand(-0.4, 0.4)
    }
  }

  despawn(p: Ped) { p.active = false; this.hide(this.peds.indexOf(p)) }

  knockDown(p: Ped, vx: number, vz: number) {
    if (p.state === 'down') return
    p.state = 'down'; p.timer = 4; p.vx = vx * 0.6; p.vz = vz * 0.6
  }

  update(dt: number, ctx: Ctx) {
    const px = ctx.player.worldX, pz = ctx.player.worldZ
    for (const p of this.peds) {
      if (!p.active) continue
      const dPlayer = Math.hypot(p.x - px, p.z - pz)
      if (dPlayer > DESPAWN_DIST) { this.despawn(p); continue }

      if (p.state === 'walk') {
        if (!p.edge) { const n = ctx.graph.nearestLane(p.x, p.z); p.edge = n.edge; p.t = n.t }
        ctx.graph.sidewalkPoint(p.edge, p.t, tmpP)
        let dx = tmpP.x - p.x, dz = tmpP.z - p.z, d = Math.hypot(dx, dz)
        if (d < 0.8) {
          p.t += p.speed * dt
          if (p.t >= p.edge.length) { p.t -= p.edge.length; p.edge = ctx.graph.randomNext(p.edge) }
          ctx.graph.sidewalkPoint(p.edge, p.t, tmpP)
          dx = tmpP.x - p.x; dz = tmpP.z - p.z; d = Math.hypot(dx, dz) || 0.001
        }
        const step = Math.min(d, p.speed * 1.3 * dt)
        p.vx = (dx / d) * (step / dt); p.vz = (dz / d) * (step / dt)
        p.x += (dx / d) * step; p.z += (dz / d) * step
        p.yaw = dampAngle(p.yaw, Math.atan2(dx, dz), 8, dt)
        // 受惊：高速车辆逼近
        if (dPlayer < 60) this.checkScare(p, ctx)
      } else if (p.state === 'flee') {
        p.timer -= dt
        const fx = Math.sin(p.yaw), fz = Math.cos(p.yaw)
        p.vx = fx * p.speed; p.vz = fz * p.speed
        p.x += p.vx * dt; p.z += p.vz * dt
        for (const b of ctx.world.query(p.x, p.z, p.radius, tmpBoxes)) {
          const c = circleAABB(p.x, p.z, p.radius, b)
          if (c) { p.x += c.nx * c.depth; p.z += c.nz * c.depth; p.yaw += rand(-1.2, 1.2) }
        }
        if (p.timer <= 0) { const n = ctx.graph.nearestLane(p.x, p.z); p.edge = n.edge; p.t = n.t; p.state = 'return'; p.speed = rand(1.2, 1.9) }
      } else if (p.state === 'return') {
        ctx.graph.sidewalkPoint(p.edge!, p.t, tmpP)
        const dx = tmpP.x - p.x, dz = tmpP.z - p.z, d = Math.hypot(dx, dz)
        if (d < 0.4) { p.state = 'walk' } else {
          const s = 2.2
          p.vx = (dx / d) * s; p.vz = (dz / d) * s
          p.x += p.vx * dt; p.z += p.vz * dt
          p.yaw = Math.atan2(dx, dz)
          for (const b of ctx.world.query(p.x, p.z, p.radius, tmpBoxes)) {
            const c = circleAABB(p.x, p.z, p.radius, b)
            if (c) { p.x += c.nx * c.depth; p.z += c.nz * c.depth; p.t += 3 }
          }
        }
        if (dPlayer < 60) this.checkScare(p, ctx)
      } else { // down
        p.timer -= dt
        p.x += p.vx * dt; p.z += p.vz * dt
        p.vx *= 0.9; p.vz *= 0.9
        if (p.timer <= 0) { this.despawn(p); continue }
      }

      // 与车辆碰撞
      if (p.state !== 'down') {
        for (const v of ctx.vehicles) {
          if (!v.active) continue
          const dx = v.x - p.x, dz = v.z - p.z
          if (dx * dx + dz * dz > 36) continue
          for (const i of [0, 1] as const) {
            v.circle(i, circ)
            const ex = p.x - circ.x, ez = p.z - circ.z, d2 = ex * ex + ez * ez, rr = v.radius + p.radius
            if (d2 >= rr * rr) continue
            const d = Math.sqrt(d2) || 0.001
            const vs = v.absSpeed
            if (vs > 2.5) {
              this.knockDown(p, v.vx + (ex / d) * 3, v.vz + (ez / d) * 3)
              this.events.emit('vehicleHitPed', { v, speed: vs })
            } else {
              p.x += (ex / d) * (rr - d); p.z += (ez / d) * (rr - d)
              if (p.state === 'walk') { p.state = 'flee'; p.timer = 1.5; p.speed = 4.5; p.yaw = Math.atan2(ex, ez) }
            }
            break
          }
        }
      }
      p.phase += Math.hypot(p.vx, p.vz) * dt * 2.5
    }
    this.sync()
  }

  private checkScare(p: Ped, ctx: Ctx) {
    for (const v of ctx.vehicles) {
      if (!v.active || v.absSpeed < 9) continue
      const dx = p.x - v.x, dz = p.z - v.z, d2 = dx * dx + dz * dz
      if (d2 > 14 * 14) continue
      // 车辆是否朝行人开来
      const d = Math.sqrt(d2), toward = (dx / d) * v.vx + (dz / d) * v.vz
      if (toward > 6 && Math.abs(wrapAngle(Math.atan2(dx, dz) - Math.atan2(v.vx, v.vz))) < 0.5) {
        p.state = 'flee'; p.timer = rand(1.5, 2.5); p.speed = rand(4.5, 5.5)
        // 向车辆侧向逃开
        const side = Math.sign((dx) * v.vz - (dz) * v.vx) || 1
        p.yaw = Math.atan2(v.vx, v.vz) + side * (Math.PI / 2) * 0.9
        return
      }
    }
  }

  private sync() {
    for (let i = 0; i < this.peds.length; i++) {
      const p = this.peds[i]
      if (!p.active) continue
      const bob = p.state === 'down' ? 0 : Math.abs(Math.sin(p.phase * 3)) * 0.05
      if (p.state === 'down') {
        Q.setFromAxisAngle(AX, -Math.PI / 2)
        Q.premultiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), p.yaw))
        V.set(p.x, 0.2, p.z)
      } else {
        Q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), p.yaw)
        V.set(p.x, bob, p.z)
      }
      M.compose(V, Q, S)
      this.head.setMatrixAt(i, M); this.torso.setMatrixAt(i, M); this.legs.setMatrixAt(i, M)
    }
    this.head.instanceMatrix.needsUpdate = true
    this.torso.instanceMatrix.needsUpdate = true
    this.legs.instanceMatrix.needsUpdate = true
  }
}
