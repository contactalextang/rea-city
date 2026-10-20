import * as THREE from 'three'
import { DIFFICULTY, WEAPONS, EQUIP, type DiffParams, type Difficulty, type ArenaModeId } from '../../data/arena'
import type { ArenaMap } from './ArenaMap'
import { Actor } from './Actor'
import { headCenter, chestPoint, inaccuracy } from './ArenaWeapons'
import { ROUTES, PLANT_SPOTS, HOLDS, POSTPLANT, SITES, type SiteId, type Pt } from './layout'
import type { Grenades, NadeKind } from './Grenades'

export interface SoundEvent { x: number; z: number; by: Actor; kind: 'shot' | 'step' | 'plant' | 'defuse' | 'nade'; t: number }
export interface BombInfo { state: 'none' | 'carried' | 'dropped' | 'planted' | 'defused' | 'exploded'; pos: THREE.Vector3; site: SiteId | null; carrier: Actor | null; defuser: Actor | null }

/** Bot 所在世界（ArenaMode 实现） */
export interface BotWorld {
  map: ArenaMap
  actors: Actor[]
  grenades: Grenades
  time: number
  /** 回合已进行秒数（live 阶段） */
  roundT: number
  roundLeft: number
  phase: 'freeze' | 'live' | 'end' | 'over'
  mode: ArenaModeId
  bomb: BombInfo
  sounds: SoundEvent[]
  player: Actor
  /** 玩家对队友 bot 的指令 */
  command: 'free' | 'follow' | 'hold'
  commandLook: THREE.Vector3
  enemiesOf(a: Actor): Actor[]
  isEnemy(a: Actor, b: Actor): boolean
  canSee(from: Actor, to: Actor): boolean
  visiblePart(from: Actor, to: Actor): 'head' | 'chest' | 'both' | null
  buy(a: Actor, id: string): boolean
  throwNade(a: Actor, kind: NadeKind, lob: boolean): void
  /** 本队最近与敌人接触的包点（CT 回防用） */
  contact: Record<string, { site: SiteId; t: number } | null>
}

/** bot 本帧输出 */
export interface BotOut { mx: number; mz: number; walk: boolean; jump: boolean; fire: boolean; aimYaw: number; aimPitch: number; reload: boolean; use: boolean }

type Goal =
  | { k: 'route'; pts: Pt[]; i: number; stageAt: number; waitUntil: number; site: SiteId }
  | { k: 'site'; site: SiteId; to: Pt; plant: boolean }
  | { k: 'hold'; at: Pt; look: Pt }
  | { k: 'retake'; site: SiteId }
  | { k: 'defuse' }
  | { k: 'pickup' }
  | { k: 'follow' }
  | { k: 'stay'; look: THREE.Vector3 }
  | { k: 'chase'; to: THREE.Vector3; until: number }
  | { k: 'retreat'; to: THREE.Vector3; until: number }
  | { k: 'hunt'; to: Pt }
  | { k: 'idle' }

const D2R = Math.PI / 180
/** 各类武器的交战距离上限（米） */
const ENGAGE: Record<string, number> = { knife: 25, pistol: 38, smg: 45, shotgun: 22, rifle: 95, sniper: 110 }
const angDiff = (a: number, b: number) => { let d = a - b; while (d > Math.PI) d -= Math.PI * 2; while (d < -Math.PI) d += Math.PI * 2; return d }
const _t = new THREE.Vector3()

/**
 * Bot AI：感知（视锥 + 射线遮挡 + 烟雾，分帧检测）→ 反应时间 → 瞄准收敛（误差随时间衰减，按难度）→ 点射/扫射（压枪补偿）
 * → 急停 / 横移；宏观：T 方按回合战术走路线（rush / 分推 / 默认控图后集合）、下包、守包；CT 守点、接触后回防、拆包；
 * 队友 bot 可跟随玩家 / 原地守点。导航：格点 A* + 拉直。
 */
export class Bot {
  d: DiffParams
  goal: Goal = { k: 'idle' }
  private path: THREE.Vector3[] = []
  private pathI = 0
  private pathTo = new THREE.Vector3(1e9, 0, 1e9)
  private repathT = 0
  target: Actor | null = null
  private visible = new Map<Actor, number>()
  /** 当前目标露出的部位 */
  private part: 'head' | 'chest' | 'both' = 'both'   // 最近一次看到的时间
  private reactAt = 0
  private aimHead = false
  private errYaw = 0; private errPitch = 0
  aimYaw = 0; aimPitch = 0
  lastSeenPos = new THREE.Vector3()
  lastSeenT = -99
  private thinkT: number
  private burst = 0
  private burstPause = 0
  private strafe = 0
  private strafeT = 0
  private stuckT = 0
  private stuckPos = new THREE.Vector3()
  private lookAt: THREE.Vector3 | null = null
  private heardT = -99
  /** 状态文本（调试） */
  state = 'idle'
  /** 回合内是否已投掷战术道具 */
  private usedUtility = false
  private usedHe = false

  constructor(readonly a: Actor, diff: Difficulty, idx: number) {
    this.d = DIFFICULTY[diff]
    this.thinkT = (idx % 5) * 0.02
    this.aimYaw = a.yaw
  }
  setDifficulty(diff: Difficulty) { this.d = DIFFICULTY[diff]; this.a.diff = diff }

  resetRound() {
    this.goal = { k: 'idle' }; this.path = []; this.pathI = 0; this.target = null; this.visible.clear()
    this.lastSeenT = -99; this.burst = 0; this.burstPause = 0; this.stuckT = 0; this.lookAt = null; this.heardT = -99; this.usedUtility = false; this.usedHe = false
    this.pathTo.set(1e9, 0, 1e9)
    this.aimYaw = this.a.yaw; this.aimPitch = 0
    this.state = 'idle'
  }

  // ———————————————————— 购买 ————————————————————
  buyRound(w: BotWorld, pistolRound: boolean, teamAwp: boolean) {
    const a = this.a
    const rifle = a.side === 'T' ? 'ak47' : 'm4a4', smg = a.side === 'T' ? 'mac10' : 'mp9'
    if (w.mode === 'dm') return
    if (pistolRound) {
      if (Math.random() < 0.6) w.buy(a, 'vest')
      else if (a.money >= 700 && Math.random() < 0.5) w.buy(a, 'deagle')
      if (a.money >= 300 && Math.random() < 0.5) w.buy(a, Math.random() < 0.5 ? 'smoke' : 'flash')
      return
    }
    if (!a.primary) {
      if (a.money >= 4750 + 1000 && !teamAwp && Math.random() < 0.25) w.buy(a, 'awp')
      else if (a.money >= WEAPONS[rifle].price + 1000) w.buy(a, rifle)
      else if (a.money >= 2400 && Math.random() < 0.7) w.buy(a, Math.random() < 0.8 ? smg : 'nova')
      else if (a.money >= 1300 && Math.random() < 0.3) w.buy(a, 'deagle')
    }
    if (a.primary) {
      if (!a.helmet && a.money >= EQUIP.vesthelm.price - (a.armor > 0 ? 650 : 0)) w.buy(a, 'vesthelm')
      else if (a.armor < 50 && a.money >= 650) w.buy(a, 'vest')
      if (a.money >= 300) w.buy(a, a.side === 'T' ? 'smoke' : (Math.random() < 0.5 ? 'smoke' : 'he'))
      if (a.money >= 300 && Math.random() < 0.5) w.buy(a, 'he')
      if (a.money >= 200 && Math.random() < 0.4) w.buy(a, 'flash')
      if (a.side === 'CT' && !a.kit && a.money >= 400) w.buy(a, 'kit')
    }
    a.slot = a.bestSlot()
  }

  // ———————————————————— 宏观目标 ————————————————————
  assignT(site: SiteId, route: number, execAt: number) {
    const r = ROUTES[site][route % ROUTES[site].length]
    this.goal = { k: 'route', pts: r.pts, i: 0, stageAt: r.pts.findIndex((p) => Math.hypot(p.x - r.stage.x, p.z - r.stage.z) < 12), waitUntil: execAt, site }
    this.state = `T:${r.name}`
  }
  assignHold(at: Pt, look: Pt) { this.goal = { k: 'hold', at, look }; this.state = 'CT:守点' }
  assignHunt(w: BotWorld) { this.goal = { k: 'hunt', to: w.map.randomWalkable() }; this.state = '搜索' }

  private go(w: BotWorld, x: number, z: number): boolean {
    const a = this.a.body
    if (Math.hypot(this.pathTo.x - x, this.pathTo.z - z) > 1.0 || (this.repathT <= 0 && this.pathI >= this.path.length)) {
      this.pathTo.set(x, 0, z)
      this.path = w.map.findPath(a.x, a.z, x, z) ?? []
      this.pathI = 0
      this.repathT = 3
    }
    return Math.hypot(a.x - x, a.z - z) < 0.9
  }

  /** 每帧 */
  update(w: BotWorld, dt: number, out: BotOut) {
    const a = this.a
    out.mx = 0; out.mz = 0; out.walk = false; out.jump = false; out.fire = false; out.reload = false; out.use = false
    out.aimYaw = this.aimYaw; out.aimPitch = this.aimPitch
    if (!a.alive) return
    this.repathT -= dt
    if (w.phase === 'freeze') { this.faceSmooth(a.yaw, 0, dt); out.aimYaw = this.aimYaw; return }
    // 感知（分帧）
    this.thinkT -= dt
    if (this.thinkT <= 0) { this.thinkT = 0.1; this.perceive(w) }
    if (a.blindT > 0.6) { this.target = null }

    const wpn = a.weapon()
    // 有目标：交火
    const tgt = this.target
    const seeing = tgt && tgt.alive && (w.time - (this.visible.get(tgt) ?? -99)) < 0.25
    let moveGoal = true
    if (tgt && seeing) {
      this.lastSeenPos.set(tgt.body.x, tgt.body.y, tgt.body.z); this.lastSeenT = w.time
      // 切到主武器（拿着刀 / 雷 / C4 时）
      if (a.slot !== 'primary' && a.slot !== 'secondary') a.slot = a.bestSlot()
      // 只露头 → 打头；只露身 → 打身
      const head = this.part === 'head' ? true : this.part === 'chest' ? false : this.aimHead
      const p = head ? headCenter(tgt, _t) : chestPoint(tgt, _t)
      // 没子弹：切副武器 / 刀
      if (wpn.def.kind !== 'knife' && wpn.mag === 0 && wpn.reserve === 0 && !wpn.reloading) {
        a.slot = a.slot === 'primary' && a.secondary && (a.secondary.mag + a.secondary.reserve) > 0 ? 'secondary' : 'knife'
        a.drawT = 0.4
      }
      const ex = a.body.x, ey = a.eyeY, ez = a.body.z
      const dx = p.x - ex, dy = p.y - ey, dz = p.z - ez, dist = Math.hypot(dx, dz)
      const wantYaw = Math.atan2(-dx, -dz), wantPitch = Math.atan2(dy, dist)
      // 瞄准误差收敛
      const tau = this.d.reaction * 1.1 + 0.1
      const k = Math.exp(-dt / tau)
      this.errYaw *= k; this.errPitch *= k
      const jitter = this.d.aimError * D2R * 0.18
      this.faceSmooth(wantYaw + this.errYaw + (Math.random() - 0.5) * jitter, wantPitch + this.errPitch + (Math.random() - 0.5) * jitter, dt)
      const canShoot = w.time >= this.reactAt && a.blindT <= 0
      const tol = Math.atan2(head ? 0.16 : 0.3, Math.max(1, dist)) + inaccuracy(a, wpn) * 0.6
      const onTarget = Math.abs(angDiff(this.aimYaw, wantYaw)) < tol * 1.6 && Math.abs(this.aimPitch - wantPitch) < tol * 1.6
      // 移动：急停 / 横移 / 跑打
      moveGoal = false
      const shootingNow = canShoot && onTarget
      if (this.d.counterStrafe >= 1 || (this.d.counterStrafe > 0 && Math.random() < this.d.counterStrafe)) {
        // 职业：开火前停稳，点射间隙横移
        if (!shootingNow || this.burstPause > 0) this.doStrafe(dt, out, a)
      } else if (this.d.counterStrafe === 0) {
        moveGoal = true   // 新手：边跑边打
      } else if (!shootingNow) this.doStrafe(dt, out, a)
      // 低血撤退
      if (a.hp < 25 && w.enemiesOf(a).filter((e) => e.alive && w.time - (this.visible.get(e) ?? -99) < 0.5).length >= 2 && this.goal.k !== 'retreat' && this.goal.k !== 'defuse') {
        const back = this.path[Math.max(0, this.pathI - 2)] ?? new THREE.Vector3(a.body.x, 0, a.body.z)
        this.goal = { k: 'retreat', to: back.clone(), until: w.time + 2.5 }
      }
      // 开火：点射控制
      this.burstPause -= dt
      if (shootingNow && this.burstPause <= 0 && !wpn.reloading && (wpn.def.kind === 'knife' ? dist < 1.9 : true)) {
        if (wpn.mag <= 0 && wpn.def.kind !== 'knife') out.reload = true
        else {
          out.fire = true
          this.shotDist = dist
        }
      }
      this.state = `交火:${tgt.name}`
      if (wpn.def.kind === 'knife' && dist > 1.5) { moveGoal = false; this.steerTo(w, tgt.body.x, tgt.body.z, out) }
    } else {
      // 失去目标
      if (tgt && w.time - this.lastSeenT > 0.3) {
        if (w.time - this.lastSeenT < 4 && this.goal.k !== 'defuse' && this.goal.k !== 'retreat' && this.goal.k !== 'chase') {
          if (a.side === 'T' || w.mode === 'dm' || w.mode === 'duel' || Math.random() < 0.3) this.goal = { k: 'chase', to: this.lastSeenPos.clone(), until: w.time + 4 }
          else this.lookAt = this.lastSeenPos.clone()
        }
        this.target = null
      }
      // 敌人刚躲进掩体：扔高爆手雷（每回合一次）
      if (!this.usedHe && a.grenades.includes('he') && w.time - this.lastSeenT > 0.8 && w.time - this.lastSeenT < 4) {
        const dx = this.lastSeenPos.x - a.body.x, dz = this.lastSeenPos.z - a.body.z, d = Math.hypot(dx, dz)
        if (d > 7 && d < 16 && !w.map.blocked(a.body.x, a.eyeY, a.body.z, this.lastSeenPos.x, this.lastSeenPos.y + 1, this.lastSeenPos.z)) {
          this.usedHe = true
          this.aimYaw = Math.atan2(-dx, -dz); this.aimPitch = 0.5 * Math.asin(Math.min(1, d * 17.7 / 289))
          a.yaw = this.aimYaw; a.pitch = this.aimPitch
          w.throwNade(a, 'he', false)
        }
      }
      // 换弹 / 切回主武器
      if (wpn.def.kind !== 'knife' && wpn.mag < wpn.def.mag * 0.4 && wpn.reserve > 0 && w.time - this.lastSeenT > 1.5) out.reload = true
      if (a.slot === 'knife' || a.slot === 'grenade') a.slot = a.bestSlot()
    }

    if (moveGoal) this.macro(w, dt, out)
    // 卡住检测
    const moving = out.mx !== 0 || out.mz !== 0
    if (moving) {
      if (Math.hypot(a.body.x - this.stuckPos.x, a.body.z - this.stuckPos.z) > 0.5) { this.stuckPos.set(a.body.x, 0, a.body.z); this.stuckT = 0 }
      else {
        this.stuckT += dt
        if (this.stuckT > 0.8) out.jump = true
        if (this.stuckT > 1.6) { this.repathT = 0; this.path = []; this.pathTo.set(1e9, 0, 1e9); this.stuckT = 0; const s = Math.random() < 0.5 ? 1 : -1, mx = out.mx; out.mx = -out.mz * s; out.mz = mx * s }
      }
    } else this.stuckT = 0
    out.aimYaw = this.aimYaw; out.aimPitch = this.aimPitch
  }

  private shotDist = 0
  /** ArenaMode 每发子弹后回调：远距离按难度点射（打 N 发停一下让后坐恢复） */
  onShot() {
    const w = this.a.weapon()
    if (!w.def.auto || this.shotDist < 14) { this.burst = 0; return }
    if (++this.burst >= this.d.burst) { this.burst = 0; this.burstPause = 0.22 + Math.random() * 0.25 }
  }

  private doStrafe(dt: number, out: BotOut, a: Actor) {
    this.strafeT -= dt
    if (this.strafeT <= 0) { this.strafe = Math.random() < 0.5 ? -1 : 1; this.strafeT = 0.25 + Math.random() * 0.5 }
    const rx = Math.cos(this.aimYaw), rz = -Math.sin(this.aimYaw)
    out.mx = rx * this.strafe; out.mz = rz * this.strafe
    out.walk = a.diff !== 'pro'
  }

  private perceive(w: BotWorld) {
    const a = this.a
    const fov = this.d.fov * D2R * 0.5
    let best: Actor | null = null, bestD = Infinity
    for (const e of w.enemiesOf(a)) {
      if (!e.alive) continue
      const dx = e.body.x - a.body.x, dz = e.body.z - a.body.z, dist = Math.hypot(dx, dz)
      if (dist > 110) continue
      const ang = Math.abs(angDiff(Math.atan2(-dx, -dz), this.aimYaw))
      const touching = dist < 2.2
      if (!touching && ang > fov) continue
      if (a.blindT > 0.6) continue
      const part = w.visiblePart(a, e)
      if (!part) continue
      if (e === this.target || !this.target) this.part = part
      const was = this.visible.get(e) ?? -99
      this.visible.set(e, w.time)
      e.spottedT = w.time
      // 新接触：反应时间、初始误差
      if (w.time - was > 1.2) {
        if (!this.target || this.target === e || !this.target.alive) {
          const r = this.d.reaction * (0.8 + Math.random() * 0.5) * (ang > 0.6 ? 1.3 : 1)
          this.reactAt = Math.max(this.reactAt, w.time + r)
          const err = this.d.aimError * D2R * (1.5 + Math.random() * 1.5)
          this.errYaw = (Math.random() - 0.5) * 2 * err; this.errPitch = (Math.random() - 0.5) * err
          this.aimHead = Math.random() < this.d.headPref * (dist < 25 ? 1 : 0.7)
        }
      }
      // 报点：CT 记录包点接触
      if (a.side === 'CT' && w.mode !== 'dm') {
        const site = siteNear(e.body.x, e.body.z)
        if (site) w.contact[a.team] = { site, t: w.time }
      }
      // 超出武器有效射程：只报点不纠缠（手枪/冲锋枪不隔 80 m 对枪）
      if (dist > ENGAGE[a.weapon().def.kind] && dist > ENGAGE[a.primary?.def.kind ?? 'knife']) continue
      if (dist < bestD) { bestD = dist; best = e }
    }
    if (best && (!this.target || !this.target.alive || (w.time - (this.visible.get(this.target) ?? -99)) > 0.25)) {
      if (this.target !== best) {
        this.target = best
        if (w.time >= this.reactAt) { this.reactAt = w.time + this.d.reaction * 0.5 }
      }
    }
    // 听声辨位
    if (!best) {
      for (const s of w.sounds) {
        if (w.time - s.t > 0.5 || !w.isEnemy(a, s.by)) continue
        const r = s.kind === 'shot' ? 50 : s.kind === 'step' ? 17 : s.kind === 'nade' ? 25 : 20
        const dist = Math.hypot(s.x - a.body.x, s.z - a.body.z)
        if (dist > r) continue
        this.lookAt = new THREE.Vector3(s.x, 0, s.z)
        this.heardT = w.time
        if (a.side === 'CT' && w.mode !== 'dm') { const site = siteNear(s.x, s.z); if (site && s.kind !== 'step') w.contact[a.team] = { site, t: w.time } }
        break
      }
    }
  }

  private faceSmooth(yaw: number, pitch: number, dt: number) {
    const maxStep = this.d.turnSpeed * D2R * dt
    const dy = angDiff(yaw, this.aimYaw)
    // 接近目标时减速（比例 + 限幅）
    const stepY = Math.sign(dy) * Math.min(Math.abs(dy), Math.max(maxStep * 0.15, Math.min(maxStep, Math.abs(dy) * 12 * dt)))
    this.aimYaw += stepY
    const dp = pitch - this.aimPitch
    this.aimPitch += Math.sign(dp) * Math.min(Math.abs(dp), Math.max(maxStep * 0.15, Math.min(maxStep, Math.abs(dp) * 12 * dt)))
    this.a.yaw = this.aimYaw; this.a.pitch = this.aimPitch
  }

  private steerTo(w: BotWorld, x: number, z: number, out: BotOut): boolean {
    const arrived = this.go(w, x, z)
    const a = this.a.body
    while (this.pathI < this.path.length && Math.hypot(this.path[this.pathI].x - a.x, this.path[this.pathI].z - a.z) < 0.7) this.pathI++
    let tx: number, tz: number
    if (this.pathI < this.path.length) { tx = this.path[this.pathI].x; tz = this.path[this.pathI].z }
    else { tx = x; tz = z }
    const dx = tx - a.x, dz = tz - a.z, d = Math.hypot(dx, dz)
    if (arrived || d < 0.25) return true
    out.mx = dx / d; out.mz = dz / d
    return false
  }

  /** 宏观行为（无交火时） */
  private macro(w: BotWorld, dt: number, out: BotOut) {
    const a = this.a
    const g = this.goal
    let faceYaw: number | null = null
    // 投掷物：进点前在路线上丢烟
    if (g.k === 'route' && g.i >= g.pts.length - 2 && !this.usedUtility && a.grenades.includes('smoke') && w.time > g.waitUntil) {
      this.usedUtility = true
      const site = SITES[g.site].center
      this.faceSmooth(Math.atan2(-(site.x - a.body.x), -(site.z - a.body.z)), 0.35, 1)
      w.throwNade(a, 'smoke', false)
    }
    // 队友指令（玩家队伍）
    const mine = w.mode !== 'dm' && a.team === w.player.team && a !== w.player
    if (mine && w.command === 'follow' && w.player.alive && g.k !== 'defuse' && !(g.k === 'site' && g.plant)) this.goal = { k: 'follow' }
    else if (mine && w.command === 'hold' && g.k !== 'stay' && g.k !== 'defuse') this.goal = { k: 'stay', look: w.commandLook.clone() }
    else if (mine && w.command === 'free' && (g.k === 'follow' || g.k === 'stay')) this.goal = { k: 'idle' }
    // 炸弹逻辑（优先级最高）
    if (w.mode !== 'dm' && w.mode !== 'duel') this.bombLogic(w)
    const G = this.goal
    switch (G.k) {
      case 'route': {
        if (G.i < G.pts.length) {
          const p = G.pts[G.i]
          if (G.i === G.stageAt && w.roundT < G.waitUntil) {
            if (this.steerTo(w, p.x, p.z, out)) { out.mx = out.mz = 0; this.lookTowards(G.pts[Math.min(G.i + 1, G.pts.length - 1)], dt); this.state = 'T:等待集合' }
            break
          }
          if (this.steerTo(w, p.x, p.z, out)) G.i++
          this.state = `T:推进${G.site}`
          // 静步接近包点
          out.walk = a.diff === 'pro' && G.i >= G.pts.length - 2 && w.roundT < 60
        } else {
          const spot = a.hasC4 ? PLANT_SPOTS[G.site][a.id % PLANT_SPOTS[G.site].length] : POSTPLANT[G.site][a.id % POSTPLANT[G.site].length].at
          this.goal = { k: 'site', site: G.site, to: spot, plant: a.hasC4 }
        }
        break
      }
      case 'site': {
        if (G.plant && a.hasC4 && !inSite(G.to.x, G.to.z)) G.to = PLANT_SPOTS[G.site][a.id % PLANT_SPOTS[G.site].length]
        if (!G.plant && a.hasC4 && w.bomb.state === 'carried') { G.plant = true; G.to = PLANT_SPOTS[G.site][a.id % PLANT_SPOTS[G.site].length] }
        this.state = G.plant ? 'T:去下包' : 'T:去控点'
        if (this.steerTo(w, G.to.x, G.to.z, out)) {
          out.mx = out.mz = 0
          if (G.plant && a.hasC4 && inSite(a.body.x, a.body.z)) { a.slot = 'c4'; out.use = true; this.state = 'T:下包中' }
          else { this.lookTowards(POSTPLANT[G.site][a.id % 3].look, dt); this.state = 'T:控点' }
        }
        break
      }
      case 'hold': {
        if (this.steerTo(w, G.at.x, G.at.z, out)) { out.mx = out.mz = 0; this.lookTowards(G.look, dt) }
        else out.walk = false
        this.state = 'CT:守点'
        // CT：收到包点接触 → 回防
        const c = w.contact[a.team]
        if (c && w.time - c.t < 8 && siteNear(G.at.x, G.at.z) !== c.site && Math.random() < 0.02) this.goal = { k: 'retake', site: c.site }
        break
      }
      case 'retake': {
        const s = SITES[G.site].center
        if (this.steerTo(w, s.x, s.z, out)) { out.mx = out.mz = 0; this.goal = { k: 'hold', at: HOLDS[G.site][a.id % HOLDS[G.site].length].at, look: HOLDS[G.site][a.id % HOLDS[G.site].length].look } }
        this.state = `CT:回防 ${G.site}`
        break
      }
      case 'defuse': {
        const b = w.bomb
        if (b.state !== 'planted') { this.goal = { k: 'idle' }; break }
        if (this.steerTo(w, b.pos.x, b.pos.z, out) || Math.hypot(b.pos.x - a.body.x, b.pos.z - a.body.z) < 1.2) { out.mx = out.mz = 0; out.use = true; this.state = 'CT:拆包中'; faceYaw = Math.atan2(-(b.pos.x - a.body.x), -(b.pos.z - a.body.z)) }
        else this.state = 'CT:去拆包'
        break
      }
      case 'pickup': {
        const b = w.bomb
        if (b.state !== 'dropped') { this.goal = { k: 'idle' }; break }
        this.steerTo(w, b.pos.x, b.pos.z, out); this.state = 'T:捡包'
        break
      }
      case 'follow': {
        const p = w.player.body
        const d = Math.hypot(p.x - a.body.x, p.z - a.body.z)
        if (d > 4) this.steerTo(w, p.x, p.z, out)
        else this.lookTowards({ x: a.body.x - Math.sin(w.player.yaw) * 10, z: a.body.z - Math.cos(w.player.yaw) * 10 }, dt)
        this.state = '跟随玩家'
        break
      }
      case 'stay': this.lookTowards(G.look, dt); this.state = '原地守点'; break
      case 'chase': {
        if (w.time > G.until || this.steerTo(w, G.to.x, G.to.z, out)) this.goal = { k: 'idle' }
        this.state = '追击'
        break
      }
      case 'retreat': {
        if (w.time > G.until || this.steerTo(w, G.to.x, G.to.z, out)) this.goal = { k: 'idle' }
        this.state = '撤退'
        break
      }
      case 'hunt': {
        if (this.steerTo(w, G.to.x, G.to.z, out)) G.to = w.map.randomWalkable()
        break
      }
      case 'idle': {
        // 回合中途无事可做：T 去最近的包点，CT 回守点，死斗/单挑搜索
        if (w.mode === 'dm' || w.mode === 'duel') this.assignHunt(w)
        else if (a.side === 'T') { const site: SiteId = Math.hypot(a.body.x - SITES.A.center.x, a.body.z - SITES.A.center.z) < Math.hypot(a.body.x - SITES.B.center.x, a.body.z - SITES.B.center.z) ? 'A' : 'B'; this.goal = { k: 'site', site, to: a.hasC4 ? PLANT_SPOTS[site][0] : POSTPLANT[site][a.id % 3].at, plant: a.hasC4 } }
        else { const list = [...HOLDS.A, ...HOLDS.B, ...HOLDS.mid]; const h = list[a.id % list.length]; this.assignHold(h.at, h.look) }
        break
      }
    }
    // 朝向：听到声音 / 指定看向 / 移动方向
    if (faceYaw !== null) this.faceSmooth(faceYaw, 0, dt)
    else if (this.lookAt && w.time - this.heardT < 2.5) this.lookTowards(this.lookAt, dt)
    else if (out.mx || out.mz) this.faceSmooth(Math.atan2(-out.mx, -out.mz), -0.02, dt)
  }

  private lookTowards(p: Pt | THREE.Vector3, dt: number) {
    const a = this.a.body
    const dx = p.x - a.x, dz = p.z - a.z
    if (dx * dx + dz * dz < 0.01) return
    this.faceSmooth(Math.atan2(-dx, -dz), 0, dt)
  }

  private bombLogic(w: BotWorld) {
    const a = this.a, b = w.bomb
    const g = this.goal
    if (a.side === 'T') {
      if (b.state === 'dropped' && g.k !== 'pickup') {
        // 最近的 T bot 去捡
        const ts = w.actors.filter((x) => x.alive && x.team === a.team && !x.isPlayer)
        ts.sort((p, q) => Math.hypot(p.body.x - b.pos.x, p.body.z - b.pos.z) - Math.hypot(q.body.x - b.pos.x, q.body.z - b.pos.z))
        if (ts[0] === a) this.goal = { k: 'pickup' }
      }
      if (b.state === 'planted' && b.site && !(g.k === 'site' && !g.plant && g.site === b.site)) {
        const spots = POSTPLANT[b.site]
        this.goal = { k: 'site', site: b.site, to: spots[a.id % spots.length].at, plant: false }
      }
      // 携包者：到点后一律去下包点
      if (b.state === 'carried' && b.carrier === a && g.k === 'site' && !g.plant) {
        this.goal = { k: 'site', site: g.site, to: PLANT_SPOTS[g.site][a.id % PLANT_SPOTS[g.site].length], plant: true }
      }
      // 时间快到还没下包：携包者直奔包点
      if (b.state === 'carried' && b.carrier === a && w.roundLeft < 30 && g.k === 'route') {
        this.goal = { k: 'site', site: g.site, to: PLANT_SPOTS[g.site][0], plant: true }
      }
    } else if (a.side === 'CT') {
      if (b.state === 'planted') {
        const cts = w.actors.filter((x) => x.alive && x.team === a.team && !x.isPlayer)
        cts.sort((p, q) => Math.hypot(p.body.x - b.pos.x, p.body.z - b.pos.z) - Math.hypot(q.body.x - b.pos.x, q.body.z - b.pos.z))
        const tsAlive = w.actors.filter((x) => x.alive && x.side === 'T').length
        const someoneDefusing = b.defuser && b.defuser !== a
        // 最近者拆包（时间紧迫或无人可见），其余回防
        const needDefuse = cts[0] === a && !someoneDefusing && (tsAlive === 0 || w.time - this.lastSeenT > 2.5 || w.roundLeft < (a.kit ? 7 : 12))
        if (needDefuse) { if (g.k !== 'defuse') this.goal = { k: 'defuse' } }
        else if (g.k !== 'retake' && g.k !== 'defuse' && !(g.k === 'hold' && siteNear(g.at.x, g.at.z) === b.site) && b.site) this.goal = { k: 'retake', site: b.site }
      }
    }
  }
}

export function inSite(x: number, z: number): SiteId | null {
  for (const id of ['A', 'B'] as SiteId[]) {
    const s = SITES[id]
    const cx0 = (s.x0 - 30) * 2, cx1 = (s.x1 - 30) * 2 + 2, cz0 = (s.z0 - 30) * 2, cz1 = (s.z1 - 30) * 2 + 2
    if (x >= cx0 && x <= cx1 && z >= cz0 && z <= cz1) return id
  }
  return null
}
/** 位置是否在包点附近（含入口，用于报点） */
export function siteNear(x: number, z: number): SiteId | null {
  for (const id of ['A', 'B'] as SiteId[]) if (Math.hypot(x - SITES[id].center.x, z - SITES[id].center.z) < 22) return id
  return null
}
