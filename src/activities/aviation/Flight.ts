import * as THREE from 'three'
import type { Game } from '../../core/Game'
import type { SgWorld } from '../../world/SgWorld'
import type { AABB } from '../../world/Colliders'
import { circleBody } from '../../physics/Collision'
import { stepFlight, airspeed, heading, pitch, roll, right, classifyTouchdown, type FlightInput, type FlightParams, type TouchdownGrade } from '../../physics/ArcadeFlight'
import { AIRCRAFT_RADIUS, type Aircraft } from '../../entities/Aircraft'
import { HeightField } from '../../world/HeightField'
import { AIRSPACE, inAirspace } from '../../world/Airfield'
import { damp } from '../../config'
import { autopilotInput, type AutopilotTarget } from './Autopilot'
import type { FlightHud } from './FlightHud'
import type { CrashFx } from './Crash'
import { t } from '../../i18n'

/**
 * 飞行逐步推进（AIR.4）：输入 → ArcadeFlight.stepFlight → 碰撞 / 接地分级 / 坠毁 → 网格同步 → HUD、相机、视距。
 *
 * 碰撞顺序（每步）：
 * 1. world.query 半径 6 内的静态体（跳过 tag 'bound' 边界体），圆与足迹相交且楼高 h > y − 1.5 → 撞楼；
 *    地面低速（<12 m/s）滑行时改为推开 + 扣血；
 * 2. 高度图兜底（块外高楼与地标）：HeightField.sampleMax > y − 2 → 撞楼；
 * 3. 接地：AirfieldSurface 分级（跑道 = runway；铺装 / 陆地 = land 允许迫降；水面坠毁）；地面滑到水上也坠毁；
 * 4. 翼尖触地：|roll| > 25° 且离地 < 5 m；
 * 5. 地面滑行 / 低空（<3 m）与车辆的碰撞圆：推开 + 双方扣血，空中相对速度 >15 m/s 坠毁。
 */

export type CrashReason = 'building' | 'touchdown' | 'water' | 'wingtip' | 'vehicle'

const DEG = Math.PI / 180
const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v)
const lerp = (a: number, b: number, k: number) => a + (b - a) * k

/** 视距：地面值与 Game.ts 初始化一致（sg：雾 900 m、远裁剪 1600、近裁剪 0.3） */
const FOG_GROUND = 900 / 380, FOG_HIGH = 2600 / 380
const FAR_GROUND = 1600, FAR_HIGH = 4500
const NEAR_GROUND = 0.3, NEAR_HIGH = 1.5, NEAR_COCKPIT = 0.1
/** 视距随高度插值的满值高度 */
const VIEW_ALT = 400
/** 空域边缘告警距离 */
const AIRSPACE_WARN = 300

export interface FlightHooks {
  onCrash(ac: Aircraft, reason: CrashReason): void
  onTakeoff(ac: Aircraft): void
  onLanded(ac: Aircraft, grade: TouchdownGrade): void
  /** 驾驶中被外部传送强制下机（空中的飞机由调用方移除） */
  onDropped(ac: Aircraft, airborne: boolean): void
  /** AIR.5：这架飞机自己的飞行参数（涡轮改装等；缺省 = FLIGHT_PARAMS.cessna） */
  params?(ac: Aircraft): FlightParams | undefined
}

export interface TouchdownInfo { vy: number; rollDeg: number; pitchDeg: number; grade: TouchdownGrade; surface: string; x: number; z: number; t: number }

export class FlightControl {
  active: Aircraft | null = null
  view: 'chase' | 'cockpit' = 'chase'
  private ap: AutopilotTarget | null = null
  private hf: HeightField | null = null
  private tmp: AABB[] = []
  /** 视距插值用的平滑高度（下机后平滑回 0） */
  private viewAlt = 0
  private viewDirty = false
  private pullUp = false
  private airspaceState: 'ok' | 'near' | 'out' = 'ok'
  private bumpCd = 0
  /** 登机时玩家的 x/z（驾驶期间被外部 place（昏倒回家等）改动 → 强制下机） */
  private boardPos = { x: 0, z: 0 }
  private takeoffAt = 0
  private distM = 0
  lastTouchdown: TouchdownInfo | null = null
  lastCrash: { reason: CrashReason; x: number; y: number; z: number; t: number } | null = null
  private wreckLook: THREE.Vector3 | null = null
  private wreckCam: THREE.Vector3 | null = null

  constructor(private game: Game, private sg: SgWorld, private hud: FlightHud, private fx: CrashFx, private hooks: FlightHooks) {}

  // ---------- 高度图 ----------
  /** 首次登机时构建（天际线 + 地标），之后常驻 */
  private heightField(): HeightField {
    if (this.hf) return this.hf
    const t0 = performance.now()
    const hf = new HeightField(this.sg.bounds, 8)
    this.sg.group.updateMatrixWorld(true)
    if (this.sg.skyline) hf.addMesh(this.sg.skyline)
    const lm = this.sg.landmarks
    if (lm) {
      lm.group.updateMatrixWorld(true)
      lm.group.traverse((o) => {
        const m = o as THREE.Mesh
        if (m.isMesh && !(m as THREE.InstancedMesh).isInstancedMesh) hf.addMesh(m)
      })
    } else {
      // 地标缺失兜底：金沙三塔 194 m、摩天轮 165 m（按已知尺寸手写盒子）
      hf.addBox(1480, 1560, -60, 20, 200); hf.addBox(1545, 1625, -165, -85, 200); hf.addBox(1580, 1650, -265, -195, 200)
      hf.addBox(1790, 1910, -780, -745, 165)
    }
    console.info(`[aviation] 高度图 ${hf.cols}×${hf.rows}（8 m 格）三角 ${hf.tris}，用时 ${(performance.now() - t0).toFixed(0)} ms`)
    this.hf = hf
    return hf
  }
  heightAt(x: number, z: number, r = 0) { const hf = this.heightField(); return r > 0 ? hf.sampleMax(x, z, r) : hf.sample(x, z) }

  // ---------- 登机 / 下机 ----------
  board(ac: Aircraft) {
    const pl = this.game.player
    if (pl.vehicle) pl.exit(this.game.world)
    this.heightField()
    pl.board(ac)
    this.boardPos = { x: pl.x, z: pl.z }
    this.active = ac
    ac.engineOn = true
    this.ap = null
    this.view = 'chase'
    this.game.cam.resetAir()
    this.hud.show(true)
    this.distM = 0
  }

  /** 下机点：左侧机门外 2.5 m（左 = 机体 +x）；被静态体挡住改右侧 */
  exitSpot(ac: Aircraft) {
    const b = ac.body, r = right(b)
    const lx = -r[0], lz = -r[2], n = Math.hypot(lx, lz) || 1
    const h = heading(b)
    for (const s of [1, -1]) {
      const x = b.x + (lx / n) * (2.5 + 0.6) * s, z = b.z + (lz / n) * (2.5 + 0.6) * s
      const hit = this.game.world.query(x, z, 0.4, this.tmp).some((bd) => circleBody(x, z, 0.4, bd) !== null)
      if (!hit) return { x, z, yaw: h }
    }
    return { x: b.x + lx / n * 3.1, z: b.z + lz / n * 3.1, yaw: h }
  }

  /** 正常下机：地面且空速 < 3 m/s */
  leave(): true | string {
    const ac = this.active
    if (!ac) return t('不在飞机上')
    if (!ac.body.onGround || airspeed(ac.body) >= 3) return t('先停稳再下机')
    const s = this.exitSpot(ac)
    this.unmount(s)
    ac.engineOn = false
    ac.body.throttle = 0
    ac.body.vx = ac.body.vy = ac.body.vz = 0
    return true
  }

  private unmount(s: { x: number; z: number; yaw: number }) {
    const pl = this.game.player
    this.active?.setCockpit(false)
    pl.leaveMount(s.x, s.z, s.yaw)
    this.active = null
    this.ap = null
    this.hud.show(false)
    this.game.cam.resetAir()
    this.game.cam.snap(s.yaw)
    this.game.audio.engineKind = 'car'
  }

  /**
   * 强制下机清理（倒下 / 被捕 / 读档 / 被外部传送）：返回原飞机与是否在空中（调用方决定移除）；没在驾驶返回 null。
   */
  forceLeave(): { ac: Aircraft; airborne: boolean } | null {
    const ac = this.active
    if (!ac) return null
    const airborne = !ac.body.onGround
    const s = ac.wrecked || airborne ? { x: ac.x, z: ac.z, yaw: ac.yaw } : this.exitSpot(ac)
    this.unmount(s)
    this.wreckLook = this.wreckCam = null
    ac.engineOn = false
    ac.body.throttle = 0
    ac.body.vx = ac.body.vy = ac.body.vz = 0
    return { ac, airborne }
  }

  // ---------- 调试 ----------
  autopilot(a: AutopilotTarget | null) { this.ap = a ? { ...a } : null; return this.ap }

  place(x: number, y: number, z: number, spd: number, hdg: number, pitchDeg: number) {
    const ac = this.active; if (!ac) return
    const b = ac.body
    const p = pitchDeg * DEG
    const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(-p, hdg, 0, 'YXZ'))
    b.x = x; b.y = Math.max(0, y); b.z = z
    b.qx = q.x; b.qy = q.y; b.qz = q.z; b.qw = q.w
    const cp = Math.cos(p)
    b.vx = Math.sin(hdg) * cp * spd; b.vz = Math.cos(hdg) * cp * spd; b.vy = Math.sin(p) * spd
    b.wp = b.wr = b.wy = 0
    b.onGround = b.y <= 0.01
    if (b.onGround) b.vy = 0
    b.stalled = false
    b.throttle = spd > 20 ? 0.6 : b.throttle
    this.game.cam.resetAir()
    ac.sync(0)
  }

  debugState(crashCount: number) {
    const ac = this.active, pl = this.game.player
    const st = this.sg.stats
    const base = { piloting: !!ac, health: pl.health, crashCount, lastTouchdown: this.lastTouchdown, lastCrash: this.lastCrash, view: this.view, autopilot: this.ap, chunksPending: st.pending, viewAlt: +this.viewAlt.toFixed(1), far: this.game.cam.camera.far, near: this.game.cam.camera.near, fogScale: +this.game.dayNight.fogScale.toFixed(2) }
    if (!ac) return base
    const b = ac.body
    return {
      ...base,
      x: +b.x.toFixed(1), y: +b.y.toFixed(1), z: +b.z.toFixed(1),
      speed: +airspeed(b).toFixed(1), vy: +b.vy.toFixed(2),
      heading: +heading(b).toFixed(3), pitchDeg: +(pitch(b) / DEG).toFixed(1), rollDeg: +(roll(b) / DEG).toFixed(1),
      throttle: +b.throttle.toFixed(2), flaps: +b.flapPos.toFixed(2),
      onGround: b.onGround, stalled: b.stalled, wrecked: ac.wrecked, pullUp: this.pullUp, airspace: this.airspaceState,
    }
  }

  // ---------- 每步 ----------
  update(dt: number) {
    this.fx.update(dt)
    this.bumpCd = Math.max(0, this.bumpCd - dt)
    const ac = this.active
    const pl = this.game.player
    // 驾驶中被外部传送（昏倒回家等）：玩家已不在飞机位置，强制下机
    if (ac && pl.mount === ac && (pl.x !== this.boardPos.x || pl.z !== this.boardPos.z)) {
      const px = pl.x, pz = pl.z, yaw = pl.yaw
      const r = this.forceLeave()
      pl.place(px, pz, yaw)
      if (r) this.hooks.onDropped(r.ac, r.airborne)
    } else if (ac && pl.mount !== ac) {
      this.active = null; this.hud.show(false)
    }
    this.updateView(dt)
    const a = this.active
    if (!a) return
    if (a.wrecked) return
    this.game.audio.engineKind = 'plane'
    const b = a.body
    const game = this.game
    const input = game.input
    const control = game.state === 'play' && !game.phone.open
    if (control && input.justPressed('KeyV')) this.view = this.view === 'chase' ? 'cockpit' : 'chase'

    // ---- 输入 ----
    let inp: FlightInput
    const mv = input.moveAxis()
    const yawIn = input.axis('KeyQ', 'KeyE')
    const thrIn = (input.down('ShiftLeft') || input.down('ShiftRight') ? 1 : 0) - (input.down('ControlLeft') || input.down('ControlRight') ? 1 : 0)
    const manual = control && (Math.abs(mv.fwd) > 0.05 || Math.abs(mv.side) > 0.05 || yawIn !== 0 || thrIn !== 0)
    if (this.ap && manual) { this.ap = null; game.hud.toast(t('自动驾驶已断开'), 1.5) }
    if (this.ap) inp = autopilotInput(b, this.ap)
    else if (control) {
      const inv = game.settings.invertPitch ? -1 : 1
      // W / 摇杆前推 = 推杆机头向下 → pitch −1
      inp = { pitch: -mv.fwd * inv, roll: mv.side, yaw: yawIn, throttleDelta: thrIn, brake: input.down('Space'), flaps: 'auto' }
    } else inp = { pitch: 0, roll: 0, yaw: 0, throttleDelta: 0, brake: b.onGround, flaps: 'auto' }

    // ---- 空域：边缘告警，出界注入横滚自动掉头（飞向空域中心，保持高度 ≥150 m） ----
    const dEdge = Math.min(b.x - AIRSPACE.minX, AIRSPACE.maxX - b.x, b.z - AIRSPACE.minZ, AIRSPACE.maxZ - b.z)
    this.airspaceState = !inAirspace(b.x, b.z) ? 'out' : dEdge < AIRSPACE_WARN ? 'near' : 'ok'
    if (this.airspaceState === 'out' && !b.onGround) {
      const cx = (AIRSPACE.minX + AIRSPACE.maxX) / 2, cz = (AIRSPACE.minZ + AIRSPACE.maxZ) / 2
      const auto = autopilotInput(b, { to: { x: cx, z: cz }, alt: Math.max(150, b.y), spd: Math.max(40, airspeed(b)) })
      inp = { ...inp, roll: auto.roll, pitch: auto.pitch, yaw: 0 }
    }

    // ---- 物理 ----
    const x0 = b.x, z0 = b.z
    const res = stepFlight(b, inp, dt, this.hooks.params?.(a), { groundY: 0, autoLevel: true })
    if (!b.onGround) this.distM += Math.hypot(b.x - x0, b.z - z0)
    if (res.liftoff) {
      this.takeoffAt = game.time; this.distM = 0
      this.hooks.onTakeoff(a)
      game.events.emit('flightTakeoff', { aircraft: a.id, owner: a.owner, x: b.x, z: b.z })
    }
    if (res.stallStart) game.audio.crash(5)

    // ---- 碰撞 ----
    if (this.collide(a, dt)) return
    if (res.touchdown && this.touchdown(a, res.touchdown)) return
    if (b.onGround && this.sg.surface.at(b.x, b.z) === 'water') { this.crash(a, 'water'); return }
    if (!b.onGround && b.y < 5 && Math.abs(roll(b)) > 25 * DEG) { this.crash(a, 'wingtip'); return }

    // ---- PULL UP：前方 2/4/6 s 的预测点撞高楼，或低空大下沉率 ----
    this.pullUp = false
    if (!b.onGround) {
      const hf = this.heightField()
      for (const k of [2, 4, 6]) {
        const h = hf.sampleMax(b.x + b.vx * k, b.z + b.vz * k, 6)
        if (h > 0 && b.y + b.vy * k < h + 8) { this.pullUp = true; break }
      }
      if ((b.y < 60 && b.vy < -8) || (b.y < 150 && b.vy < -15)) this.pullUp = true
    }

    a.sync(dt)
    const agl = b.y - (this.hf?.sample(b.x, b.z) ?? 0)
    this.hud.update({
      speed: airspeed(b), alt: b.y, agl, vs: b.vy, hdg: ((Math.PI - heading(b)) / DEG + 360) % 360,
      throttle: b.throttle, flaps: b.flapPos, stalled: b.stalled, pullUp: this.pullUp, airspace: this.airspaceState,
      onGround: b.onGround, autopilot: !!this.ap,
    })
  }

  /** 静态体 / 高度图 / 车辆；返回 true = 已坠毁 */
  private collide(a: Aircraft, dt: number): boolean {
    const b = a.body
    const game = this.game
    const V = airspeed(b)
    const r = b.onGround ? 3.2 : AIRCRAFT_RADIUS
    for (const body of game.world.query(b.x, b.z, 6, this.tmp)) {
      if (body.tag === 'bound') continue
      if (!(body.h > b.y - 1.5)) continue
      const c = circleBody(b.x, b.z, r, body)
      if (!c) continue
      if (b.onGround && V < 12) {
        // 低速滑行蹭到楼：推开、停下、扣点血
        b.x += c.nx * c.depth; b.z += c.nz * c.depth
        const vn = b.vx * c.nx + b.vz * c.nz
        if (vn < 0) { b.vx -= vn * c.nx; b.vz -= vn * c.nz }
        b.vx *= 0.3; b.vz *= 0.3
        if (this.bumpCd <= 0 && V > 2) { game.player.damage(V * 1.5); game.audio.crash(V); this.bumpCd = 0.6 }
        continue
      }
      this.crash(a, 'building'); return true
    }
    const hf = this.heightField()
    const top = hf.sampleMax(b.x, b.z, b.onGround ? 3 : 4)
    if (top > 0 && top > b.y - 2) {
      if (b.onGround && V < 12) { b.vx = b.vy = b.vz = 0 }
      else { this.crash(a, 'building'); return true }
    }
    // 车辆：地面或低空
    if (b.onGround || b.y < 3) {
      for (const v of game.vehicles) {
        if (!v.active) continue
        const dx = v.x - b.x, dz = v.z - b.z, d = Math.hypot(dx, dz)
        const minD = AIRCRAFT_RADIUS * 0.75 + v.radius
        if (d >= minD || d < 1e-3) continue
        const nx = dx / d, nz = dz / d
        const rel = Math.hypot(b.vx - v.vx, b.vz - v.vz)
        // 把车推出去（飞机质量大得多）
        v.x = b.x + nx * minD; v.z = b.z + nz * minD
        const vn = (v.vx - b.vx) * nx + (v.vz - b.vz) * nz
        if (vn < 0) { v.vx -= vn * nx * 1.3; v.vz -= vn * nz * 1.3 }
        if (!b.onGround && rel > 15) { this.crash(a, 'vehicle'); return true }
        if (rel > 3 && this.bumpCd <= 0) {
          game.player.damage(Math.min(35, rel * 1.5))
          v.damage(rel * 4)
          game.audio.crash(Math.min(12, rel))
          this.bumpCd = 0.6
          b.vx *= 0.5; b.vz *= 0.5
        }
      }
    }
    void dt
    return false
  }

  /** 接地分级；返回 true = 坠毁 */
  private touchdown(a: Aircraft, td: { vy: number; roll: number; pitch: number }): boolean {
    const b = a.body
    const s = this.sg.surface.at(b.x, b.z)
    const surf = s === 'runway' ? 'runway' : s === 'water' ? 'water' : 'land'
    const grade = classifyTouchdown(td.vy, td.roll, td.pitch, surf)
    this.lastTouchdown = { vy: +td.vy.toFixed(2), rollDeg: +(td.roll / DEG).toFixed(1), pitchDeg: +(td.pitch / DEG).toFixed(1), grade, surface: surf, x: +b.x.toFixed(1), z: +b.z.toFixed(1), t: this.game.time }
    if (grade === 'crash') { this.crash(a, surf === 'water' ? 'water' : 'touchdown'); return true }
    const label = grade === 'perfect' ? t('完美落地！') : grade === 'normal' ? t('平稳落地') : t('重着陆！')
    this.game.hud.toast(surf === 'runway' ? label : `${label} · ${t('迫降')}`, 2.5)
    if (grade === 'hard') { this.game.player.damage(20); this.game.audio.crash(10) }
    this.hooks.onLanded(a, grade)
    this.game.events.emit('flightLanded', { aircraft: a.id, owner: a.owner, grade, surface: surf === 'runway' ? 'runway' : 'land', vy: td.vy, x: b.x, z: b.z, airTime: this.game.time - this.takeoffAt, distKm: this.distM / 1000 })
    return false
  }

  private crash(a: Aircraft, reason: CrashReason) {
    const b = a.body
    const game = this.game
    const water = reason === 'water' || (b.y < 3 && this.sg.surface.at(b.x, b.z) === 'water')
    // 撞楼：火球往来向退 6 m，免得一半埋进墙里看不见
    const V = Math.hypot(b.vx, b.vy, b.vz) || 1, back = reason === 'building' ? 6 : 0
    this.fx.spawn(b.x - b.vx / V * back, b.y - b.vy / V * back, b.z - b.vz / V * back, water)
    game.audio.crash(20)
    this.lastCrash = { reason, x: +b.x.toFixed(1), y: +b.y.toFixed(1), z: +b.z.toFixed(1), t: game.time }
    // 相机：停在当前位置（座舱视角则退到追尾位），看着火球
    const cam = game.cam.camera
    this.wreckLook = new THREE.Vector3(b.x, Math.max(1, b.y), b.z)
    this.wreckCam = this.view === 'cockpit' ? new THREE.Vector3(b.x - b.vx * 0.4, b.y + 12, b.z - b.vz * 0.4) : cam.position.clone()
    if (this.wreckCam.distanceTo(this.wreckLook) < 18) this.wreckCam.sub(this.wreckLook).setLength(22).add(this.wreckLook).setY(Math.max(this.wreckCam.y, b.y + 8))
    a.wrecked = true
    a.engineOn = false
    a.group.removeFromParent()
    b.vx = b.vy = b.vz = 0
    this.hud.show(false)
    game.audio.engineKind = 'car'
    this.pullUp = false
    game.events.emit('aircraftCrashed', { aircraft: a.id, owner: a.owner, reason, x: b.x, z: b.z })
    this.hooks.onCrash(a, reason)
    game.player.health = 0
  }

  // ---------- 相机 / 视距 / 音频 / 提示 ----------
  driveCamera(dt: number): boolean {
    const a = this.active
    if (!a) return false
    const cam = this.game.cam
    if (a.wrecked) {
      if (this.wreckCam && this.wreckLook) { cam.camera.position.copy(this.wreckCam); cam.camera.lookAt(this.wreckLook) }
      return true
    }
    a.setCockpit(this.view === 'cockpit')
    cam.updateAir(dt, a.body, this.view, a.eye)
    return true
  }

  /** 雾距 / 远近裁剪随高度插值；下机后平滑回地面值，回到地面值后不再改动 */
  private updateView(dt: number) {
    const a = this.active
    const want = a && !a.wrecked ? Math.max(0, a.body.y) : 0
    if (!a && !this.viewDirty) return
    this.viewAlt = damp(this.viewAlt, want, a ? 1.5 : 3, dt)
    const k = clamp(this.viewAlt / VIEW_ALT, 0, 1)
    const cam = this.game.cam
    const dn = this.game.dayNight
    if (!a && this.viewAlt < 0.5) {
      dn.fogScale = FOG_GROUND
      if (cam.camera.far !== FAR_GROUND) cam.setFar(FAR_GROUND)
      cam.setNear(NEAR_GROUND)
      this.viewAlt = 0; this.viewDirty = false
      return
    }
    this.viewDirty = true
    dn.fogScale = lerp(FOG_GROUND, FOG_HIGH, k)
    // 远裁剪按 100 m 量化（CSM 按投影变化重算分割，避免每帧触发）
    const far = Math.round(lerp(FAR_GROUND, FAR_HIGH, k) / 100) * 100
    if (far !== cam.camera.far) cam.setFar(far)
    const near = a && this.view === 'cockpit' && !a.wrecked ? NEAR_COCKPIT : Math.round(lerp(NEAR_GROUND, NEAR_HIGH, clamp(this.viewAlt / 100, 0, 1)) * 10) / 10
    cam.setNear(near)
  }

  audioMount(): { speed: number; throttle: number } | null {
    const a = this.active
    if (!a || a.wrecked) return null
    return { speed: airspeed(a.body), throttle: a.body.throttle }
  }

  hint(): string | null {
    const a = this.active
    if (!a || a.wrecked) return null
    const b = a.body
    if (b.onGround && airspeed(b) < 3) return this.game.input.touch ? t('点「下机」下飞机 · 「油门+」加油门') : t('按 F 下机 · Shift 加油门滑跑')
    return null
  }
}
