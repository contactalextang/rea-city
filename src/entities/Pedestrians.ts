import * as THREE from 'three'
import { MAX_PEDS, PED_R, DESPAWN_DIST, rand, pick, wrapAngle, dampAngle } from '../config'
import type { RoadEdge, P2 } from '../world/RoadGraph'
import type { Ctx, EventBus } from '../core/Context'
import { circleBody } from '../physics/Collision'
import type { AABB } from '../world/Colliders'
import type { CharacterLibrary } from '../characters/CharacterLibrary'
import { CharacterInstance } from '../characters/CharacterInstance'
import { randomPedSpec } from '../characters/presets'

/** hail：站在路边招手（的士乘客），不走动、不受惊 */
type PedState = 'walk' | 'flee' | 'return' | 'down' | 'hail'
export interface Ped {
  active: boolean
  x: number; z: number; yaw: number; vx: number; vz: number
  state: PedState
  edge: RoadEdge | null; t: number
  speed: number; timer: number; phase: number
  radius: number
  /** 池内序号（与骨骼角色池 / InstancedMesh 实例下标一致） */
  idx: number
  /** 生成后待换外观（骨骼角色路径：每帧最多重建 RESPEC_PER_FRAME 个几何） */
  respec: boolean
}

/** 骨骼角色 LOD 距离（米）：<LOD0 全速+投影；<LOD1 半频不投影；其余冻结 */
const LOD0 = 40, LOD1 = 90
const RESPEC_PER_FRAME = 2
const frustum = new THREE.Frustum()
const projM = new THREE.Matrix4()
const sphere = new THREE.Sphere(new THREE.Vector3(), 1.3)

const SHIRTS = [0xe74c3c, 0x3498db, 0x2ecc71, 0xf1c40f, 0x9b59b6, 0xecf0f1, 0x34495e, 0xe67e22, 0x1abc9c, 0xff8fab]
const tmpP: P2 = { x: 0, z: 0 }
const tmpDir: P2 = { x: 0, z: 0 }
const tmpBoxes: AABB[] = []
const circ = { x: 0, z: 0 }
const M = new THREE.Matrix4(), Q = new THREE.Quaternion(), V = new THREE.Vector3(), S = new THREE.Vector3(1, 1, 1)
const AX = new THREE.Vector3(1, 0, 0)

/** 行人继续前进的下一条人行道：避开快速路/主干道；孤立死路返回 null */
function nextWalkEdge(ctx: Ctx, e: RoadEdge): RoadEdge | null {
  const opts = ctx.graph.nextEdges(e).filter((o) => o.kind !== 'expressway' && o.kind !== 'trunk')
  return opts.length ? pick(opts) : ctx.graph.randomNext(e)
}

/**
 * 行人群：沿人行道巡走，受惊逃跑，被撞倒地。
 * 渲染两条路径：骨骼角色池（CharacterInstance × MAX_PEDS，每人 1 draw call，按距离/视锥 LOD）；
 * 角色库不可用或 ?chars=box 时回退 InstancedMesh 盒子人（头/身/腿三批）。
 */
export class Pedestrians {
  peds: Ped[] = []
  private head!: THREE.InstancedMesh
  private torso!: THREE.InstancedMesh
  private legs!: THREE.InstancedMesh
  /** 骨骼角色池（与 peds 同下标）；盒子路径为空 */
  readonly chars: CharacterInstance[] = []
  /** 上一帧各 LOD 数量（调试） */
  readonly lodStats = { lod0: 0, lod1: 0, lod2: 0, shadow: 0, respecQueue: 0 }
  /** 冻结（lod2）角色上次摆姿势时的动画名：动画切换后补一次更新，避免远处定格在绑定姿态 */
  private posed: (string | null)[] = []

  constructor(scene: THREE.Scene, private events: EventBus, lib: CharacterLibrary | null = null) {
    for (let i = 0; i < MAX_PEDS; i++) this.peds.push({ active: false, x: 0, z: 0, yaw: 0, vx: 0, vz: 0, state: 'walk', edge: null, t: 0, speed: 1.4, timer: 0, phase: 0, radius: PED_R, idx: i, respec: false })
    if (lib) {
      // 池化：开局一次建好 MAX_PEDS 个随机外观，之后生成时排队换外观、不重建骨骼
      for (let i = 0; i < MAX_PEDS; i++) {
        const c = new CharacterInstance(lib, randomPedSpec())
        c.mesh.name = 'ped'
        c.mesh.userData.castShadow = false   // 投影由 LOD 每帧决定（DayNight.applyShadowFlags 不接管）
        c.group.visible = false
        c.play('Walk', { fade: 0 })
        c.update(Math.random(), 0)
        scene.add(c.group)
        this.posed.push('Walk')
        this.chars.push(c)
      }
      return
    }
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
    if (this.chars.length) { this.chars[i].group.visible = false; return }
    M.makeScale(0, 0, 0)
    this.head.setMatrixAt(i, M); this.torso.setMatrixAt(i, M); this.legs.setMatrixAt(i, M)
  }

  spawnOnEdge(edge: RoadEdge, t: number, ctx: Ctx): Ped | null {
    const p = this.peds.find((q) => !q.active); if (!p) return null
    ctx.graph.sidewalkPoint(edge, t, tmpP)
    this.init(p, tmpP.x, tmpP.z, 'walk')
    ctx.graph.dirAt(edge, t, tmpDir)
    p.edge = edge; p.t = t; p.yaw = Math.atan2(tmpDir.x, tmpDir.z)
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
    if (this.chars.length) { p.respec = true; return }
    this.torso.setColorAt(p.idx, new THREE.Color(pick(SHIRTS)))
    if (this.torso.instanceColor) this.torso.instanceColor.needsUpdate = true
  }

  /** 枪声：半径内的行人背离声源逃跑 */
  scare(x: number, z: number, radius: number) {
    for (const p of this.peds) {
      if (!p.active || p.state === 'down' || p.state === 'hail') continue
      const dx = p.x - x, dz = p.z - z
      if (dx * dx + dz * dz > radius * radius) continue
      p.state = 'flee'; p.timer = rand(2.5, 4); p.speed = rand(4.5, 5.5)
      p.yaw = Math.atan2(dx, dz) + rand(-0.4, 0.4)
    }
  }

  despawn(p: Ped) { p.active = false; this.hide(p.idx) }

  /** 变成招手乘客：原地站定、举手跳动（的士工作） */
  hail(p: Ped) { if (p.state === 'walk' || p.state === 'return') { p.state = 'hail'; p.vx = p.vz = 0; p.timer = 0 } }
  /** 取消招手，继续走路 */
  unhail(p: Ped) { if (p.state === 'hail') { p.state = 'walk'; p.edge = null } }
  /** 上车：行人隐藏（回收） */
  board(p: Ped) { this.despawn(p) }

  knockDown(p: Ped, vx: number, vz: number) {
    if (p.state === 'down') return
    p.state = 'down'; p.timer = 4; p.vx = vx * 0.6; p.vz = vz * 0.6
  }

  update(dt: number, ctx: Ctx) {
    const px = ctx.player.worldX, pz = ctx.player.worldZ
    for (const p of this.peds) {
      if (!p.active) continue
      const dPlayer = Math.hypot(p.x - px, p.z - pz)
      // 招手的乘客不按距离回收：的士常因单行道 / 绕路先开远，超过 DESPAWN_DIST 乘客就凭空消失（收工时 unhail 恢复成普通行人再照常回收）
      if (dPlayer > DESPAWN_DIST && p.state !== 'hail') { this.despawn(p); continue }

      if (p.state === 'walk') {
        if (!p.edge) { const n = ctx.graph.nearestLane(p.x, p.z); p.edge = n.edge; p.t = n.t }
        ctx.graph.sidewalkPoint(p.edge, p.t, tmpP)
        let dx = tmpP.x - p.x, dz = tmpP.z - p.z, d = Math.hypot(dx, dz)
        if (d < 0.8) {
          p.t += p.speed * dt
          if (p.t >= p.edge.length) { p.t -= p.edge.length; p.edge = nextWalkEdge(ctx, p.edge) }
          if (!p.edge) continue   // 死路：下一帧重新就近选边
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
          const c = circleBody(p.x, p.z, p.radius, b)
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
            const c = circleBody(p.x, p.z, p.radius, b)
            if (c) { p.x += c.nx * c.depth; p.z += c.nz * c.depth; p.t += 3 }
          }
        }
        if (dPlayer < 60) this.checkScare(p, ctx)
      } else if (p.state === 'hail') {
        p.timer += dt
        p.vx = p.vz = 0
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
          const reach = v.halfLen + 3.5
          if (dx * dx + dz * dz > reach * reach) continue
          for (let i = 0; i < v.circleCount; i++) {
            v.circle(i, circ)
            const ex = p.x - circ.x, ez = p.z - circ.z, d2 = ex * ex + ez * ez, rr = v.radius + p.radius
            if (d2 >= rr * rr) continue
            const d = Math.sqrt(d2) || 0.001
            const vs = v.absSpeed
            // 招手乘客（的士单）只推开不撞倒：车贴边靠过来时常擦到，撞倒会让这单直接作废
            if (vs > 2.5 && p.state !== 'hail') {
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

  /**
   * 骨骼角色：状态 → 动画、位置朝向、LOD（每渲染帧一次，帧 dt）。
   * 距相机 <40 m lod0+投影；40–90 m lod1 不投影；>90 m 或视锥外 lod2（冻结）。
   */
  animate(dt: number, camera: THREE.Camera) {
    if (!this.chars.length) return
    const st = this.lodStats
    st.lod0 = st.lod1 = st.lod2 = st.shadow = st.respecQueue = 0
    projM.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse)
    frustum.setFromProjectionMatrix(projM)
    const cx = camera.position.x, cz = camera.position.z
    let budget = RESPEC_PER_FRAME
    for (const p of this.peds) {
      const c = this.chars[p.idx]
      if (!p.active) { if (c.group.visible) c.group.visible = false; continue }
      // 换外观：先处理视锥外/远处的，按预算排队
      if (p.respec) {
        if (budget > 0) { c.setSpec(randomPedSpec()); p.respec = false; budget-- }
        else st.respecQueue++
      }
      c.group.visible = true
      c.group.position.set(p.x, 0, p.z)
      c.group.rotation.y = p.yaw
      switch (p.state) {
        case 'walk': case 'return': c.play('Walk', { timeScale: Math.min(1.3, Math.max(0.8, Math.hypot(p.vx, p.vz) / 1.5)) }); break
        case 'flee': c.play('Run', { timeScale: 1.1 }); break
        case 'hail': c.play('Wave', { fade: 0.2 }); break
        case 'down': if (c.current !== 'Death') c.play('Death', { loop: false, fade: 0.1 }); break
      }
      const d = Math.hypot(p.x - cx, p.z - cz)
      sphere.center.set(p.x, 0.95, p.z)
      const onScreen = frustum.intersectsSphere(sphere)
      const lod: 0 | 1 | 2 = !onScreen || d > LOD1 ? 2 : d > LOD0 ? 1 : 0
      const shadow = d < LOD0
      if (c.mesh.castShadow !== shadow) c.mesh.castShadow = shadow
      if (shadow) st.shadow++
      st[lod === 0 ? 'lod0' : lod === 1 ? 'lod1' : 'lod2']++
      if (lod === 2) {
        if (onScreen && this.posed[p.idx] !== c.current) { c.update(0.4, 0); this.posed[p.idx] = c.current }
      } else { c.update(dt, lod); this.posed[p.idx] = null }
    }
  }

  private sync() {
    if (this.chars.length) return
    for (let i = 0; i < this.peds.length; i++) {
      const p = this.peds[i]
      if (!p.active) continue
      const bob = p.state === 'down' ? 0 : p.state === 'hail' ? Math.abs(Math.sin(p.timer * 7)) * 0.18 : Math.abs(Math.sin(p.phase * 3)) * 0.05
      if (p.state === 'hail') {
        // 招手：身体前倾一点 + 跳动
        Q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), p.yaw)
        Q.multiply(new THREE.Quaternion().setFromAxisAngle(AX, 0.22))
        V.set(p.x, bob, p.z)
      } else if (p.state === 'down') {
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
