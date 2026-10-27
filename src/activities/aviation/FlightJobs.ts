import type { Game } from '../../core/Game'
import type { Aircraft } from '../../entities/Aircraft'
import { airspeed, heading } from '../../physics/ArcadeFlight'
import { earn } from '../../systems/Wallet'
import { isUnlocked, unlockLevel } from '../../data/progression'
import { RUNWAY } from '../../world/Airfield'
import { t } from '../../i18n'
import type { AutopilotTarget } from './Autopilot'
import { FlightMission, fmtT, hdist, safeAlt, type FlyState, type MissionHost, type NavPoint } from './missions/Mission'
import { MissionVisuals } from './missions/Visuals'
import { TourMission } from './missions/Tour'
import { PhotoMission, type PhotoTargetDef } from './missions/Photo'
import { DropMission, type DropTargetDef } from './missions/Drop'
import { CharterMission, CHARTER_TARGETS } from './missions/Charter'
import { ROLE_FLIGHT_JOB, flightJobId, FLIGHT_PAY, FLIGHT_JOBS_PER_DAY, GRADE_MUL, type FlightJobKind } from './missions/params'

/**
 * 飞行工作调度（AIR.5b，插件内实现，不经 Jobs.ts）：
 * 接单（机库 / 航站楼面板、手机「飞行」）→ 登机 → 完成本单目标 → 回跑道落地（flightLanded surface 'runway'）并停稳 →
 * 报酬 × 落地倍率（perfect 1.2 / normal 1.0 / hard 0.7）×（包机）涂装 payMul → earn(ctx, amt, '<role>_air_<kind>') + jobDone。
 * 坠毁 / 倒下 / 被捕 = 失败。每个游戏日至多 FLIGHT_JOBS_PER_DAY 单（完成计数）。
 */
export const JOB_TITLE: Record<FlightJobKind, string> = { tour: t('观光载客'), photo: t('航拍'), drop: t('空投'), charter: t('商务包机') }
export const JOB_DESC: Record<FlightJobKind, string> = {
  tour: t('载 2–4 名游客，150–350 m 依次穿过 3 个地标门；飞得越稳舒适奖励越多。$450 起'),
  photo: t('飞到 3 栋指定楼 150–400 m 处，机头对准按 Space 拍照。每张合格 $250'),
  drop: t('把 3 个包裹投到楼顶 / 公园 / 海上接应船，25 m 内算命中。每个 $400'),
  charter: t('载老板低空掠过 2 个商务区，在金沙空中花园高度平飞经过，再平稳降落。$1,200 起'),
}

/** 空投候选：公园（landuse 大块绿地中心）与海上接应船 */
const PARKS: DropTargetDef[] = [
  { kind: 'park', name: t('滨海南公园'), x: 900, z: 611 },
  { kind: 'park', name: t('福康宁公园'), x: -722, z: -209 },
  { kind: 'park', name: t('滨海艺术中心公园'), x: 779, z: -726 },
]
const BOATS: DropTargetDef[] = [
  { kind: 'boat', name: t('接应船'), x: 300, z: 1650 },
  { kind: 'boat', name: t('接应船'), x: 2500, z: 1500 },
]

/** 跑道两端：09 向东降落（接地 x0+100，进近点西边 2.4 km）、27 向西（接地 x1−100，进近点东边 2.3 km） */
const LANDINGS = [
  { name: '09', td: { x: RUNWAY.x0 + 100, z: RUNWAY.z }, hdg: Math.PI / 2, iaf: { x: RUNWAY.x0 + 100 - 2400, z: RUNWAY.z } },
  { name: '27', td: { x: RUNWAY.x1 - 100, z: RUNWAY.z }, hdg: -Math.PI / 2, iaf: { x: RUNWAY.x1 - 100 + 2300, z: RUNWAY.z } },
] as const
type Landing = typeof LANDINGS[number]

export interface FlightJobsHost {
  game: Game
  /** 正在驾驶的飞机 */
  active(): Aircraft | null
  autopilot(a: AutopilotTarget | null): void
  hf(x: number, z: number, r?: number): number
  /** 给本单找一架飞机：自有可用 → 已租 → 现租；返回飞机或原因 */
  acquire(): Aircraft | string
  /** 涂装报酬倍率（VIP 1.2） */
  payMul(ac: Aircraft): number
}

export interface FlightJobsSave { day: number; today: number; total: number; done: Record<string, number>; log: string[] }

type Phase = 'board' | 'fly' | 'stopping'

export class FlightJobs {
  mission: FlightMission | null = null
  phase: Phase = 'board'
  /** 本单用的飞机 */
  plane: Aircraft | null = null
  private landed: { grade: 'perfect' | 'normal' | 'hard' } | null = null
  private landing: Landing = LANDINGS[1]
  private autoFinal = false
  private climbHdg = 0
  /** 调试：任务感知自动驾驶（飞向当前目标，自动拍照 / 投放，完成后自动进近降落） */
  autofly = false
  private seed = 1
  readonly visuals: MissionVisuals
  s: FlightJobsSave = { day: 1, today: 0, total: 0, done: {}, log: [] }
  last: { job: string; amount: number; base: number; grade: string; detail: string } | null = null
  lastFail: string | null = null

  constructor(private host: FlightJobsHost) {
    const g = host.game
    this.visuals = new MissionVisuals(g.scene)
    g.events.on('flightLanded', ({ grade, surface }) => {
      if (!this.mission || this.phase !== 'fly' || !this.mission.done || host.active() !== this.plane) return
      if (surface !== 'runway') { g.hud.toast(t('要在跑道上落地才能结算'), 2.5); return }
      this.landed = { grade }
      this.phase = 'stopping'
    })
    g.events.on('flightTakeoff', () => { if (this.phase === 'stopping') { this.phase = 'fly'; this.landed = null } })
    g.events.on('aircraftCrashed', ({ aircraft }) => { if (this.mission && this.plane && this.plane.id === aircraft) this.fail(t('飞机坠毁')) })
  }

  private get role() { return this.host.game.ctx.role.id }
  get kind(): FlightJobKind { return ROLE_FLIGHT_JOB[this.role] }
  get jobId() { return flightJobId(this.role) }
  private today() { const d = this.host.game.clock.day; if (this.s.day !== d) { this.s.day = d; this.s.today = 0 } return this.s.today }

  /** 接不了的原因（null = 可以接） */
  lockReason(): string | null {
    const g = this.host.game
    if (this.mission) return t('已经在做一单飞行工作')
    if (!isUnlocked(this.role, g.progress.level, 'air_rent')) return t('Lv{n} 解锁飞行工作', { n: unlockLevel(this.role, 'air_rent') })
    if (this.today() >= FLIGHT_JOBS_PER_DAY) return t('今天的航班排满了（每天 {n} 单），明天再来', { n: FLIGHT_JOBS_PER_DAY })
    return null
  }

  private rand = () => { this.seed = (this.seed * 16807) % 2147483647; return (this.seed - 1) / 2147483646 }
  private missionHost(): MissionHost {
    const g = this.host.game
    return { hf: (x, z, r) => this.host.hf(x, z, r ?? 0), toast: (s, sec) => g.hud.toast(s, sec), visuals: this.visuals, rand: this.rand }
  }

  /** 白领航拍目标：办公楼 + 地标 POI 里挑 3 个，按离机场由近到远 */
  private photoTargets(): PhotoTargetDef[] {
    const g = this.host.game
    const pool = [...g.pois.byType('office'), ...g.pois.byType('landmark')].filter((p) => Math.abs(p.x) < 2300 && Math.abs(p.z) < 1350)
    const pick: PhotoTargetDef[] = []
    while (pool.length && pick.length < FLIGHT_PAY.photo.shots) {
      const p = pool.splice(Math.floor(this.rand() * pool.length), 1)[0]
      if (pick.some((q) => hdist(q.x, q.z, p.x, p.z) < 500)) continue
      pick.push({ id: p.id, name: p.name, x: p.x, z: p.z })
    }
    return orderNearest(pick, { x: 1500, z: 1980 })
  }
  /** 黑帮空投：楼顶（办公楼）/ 公园 / 接应船各一 */
  private dropTargets(): DropTargetDef[] {
    const g = this.host.game
    const offices = g.pois.byType('office')
    const o = offices[Math.floor(this.rand() * offices.length)]
    const roof: DropTargetDef = o ? { kind: 'roof', name: o.name, x: o.x, z: o.z } : { kind: 'roof', name: t('楼顶'), x: 483, z: -75 }
    const park = PARKS[Math.floor(this.rand() * PARKS.length)]
    const boat = BOATS[Math.floor(this.rand() * BOATS.length)]
    return orderNearest([boat, park, roof], { x: 1500, z: 1980 })
  }

  /** 接单；返回 true 或原因 */
  start(): true | string {
    const lock = this.lockReason(); if (lock) return lock
    const ac = this.host.acquire()
    if (typeof ac === 'string') return ac
    const g = this.host.game
    this.seed = (Math.floor(g.time * 1000) % 2147483646) + 1
    const h = this.missionHost()
    const k = this.kind
    const m: FlightMission = k === 'tour' ? new TourMission(h)
      : k === 'photo' ? new PhotoMission(h, this.photoTargets())
      : k === 'drop' ? new DropMission(h, this.dropTargets())
      : new CharterMission(h, CHARTER_TARGETS)
    m.startedAt = g.time
    this.mission = m
    this.plane = ac
    this.phase = this.host.active() === ac ? 'fly' : 'board'
    this.landed = null; this.autoFinal = false; this.lastFail = null
    g.hud.toast(t('接单：{title}', { title: JOB_TITLE[k] }), 3)
    if (g.state === 'panel') g.closePanel()
    return true
  }

  cancel(reason = t('放弃')) { if (this.mission) this.fail(reason, true) }

  fail(reason: string, quiet = false) {
    const m = this.mission
    if (!m) return
    m.dispose()
    this.mission = null; this.plane = null; this.landed = null
    if (this.autofly) this.host.autopilot(null)
    this.lastFail = reason
    this.log(t('{title} 失败：{reason}', { title: JOB_TITLE[m.kind], reason }))
    if (!quiet) this.host.game.hud.toast(t('飞行工作失败：{reason}', { reason }), 3)
  }

  private settle() {
    const m = this.mission!, g = this.host.game
    const grade = this.landed?.grade ?? 'normal'
    const p = m.payout(g.time)
    const payMul = m.kind === 'charter' && this.plane ? this.host.payMul(this.plane) : 1
    const base = Math.round(p.amount * GRADE_MUL[grade] * payMul)
    const job = this.jobId
    const got = earn(g.ctx, base, job)
    g.events.emit('jobDone', { job, amount: got, base })
    this.today(); this.s.today++; this.s.total++
    this.s.done[job] = (this.s.done[job] ?? 0) + 1
    const gl = grade === 'perfect' ? t('完美落地 ×1.2') : grade === 'hard' ? t('重着陆 ×0.7') : t('平稳落地 ×1.0')
    const detail = `${p.detail} · ${gl}${payMul !== 1 ? ` · ${t('VIP 涂装 ×{m}', { m: payMul })}` : ''}`
    this.last = { job, amount: got, base, grade, detail }
    this.log(t('{title} +${n}（{detail}）', { title: JOB_TITLE[m.kind], n: Math.round(got).toLocaleString(), detail }))
    g.hud.toast(t('{title}完成 +${n} · {detail}', { title: JOB_TITLE[m.kind], n: Math.round(got).toLocaleString(), detail }), 5)
    m.dispose()
    this.mission = null; this.plane = null; this.landed = null
    if (this.autofly) this.host.autopilot(null)
    g.saveGame(false)
  }

  private log(line: string) {
    const c = this.host.game.clock
    this.s.log.unshift(t('第{day}天 {time} {line}', { day: c.day, time: c.hhmm, line }))
    this.s.log.length = Math.min(this.s.log.length, 12)
  }

  private flyState(ac: Aircraft, dt: number): FlyState {
    return { b: ac.body, airborne: !ac.body.onGround, speed: airspeed(ac.body), dt, time: this.host.game.time }
  }

  /** 选降落方向：在机场东边（x > 跑道中点）用 27 向西，否则 09 向东 */
  private pickLanding(x: number) { return x > (RUNWAY.x0 + RUNWAY.x1) / 2 ? LANDINGS[1] : LANDINGS[0] }

  update(dt: number) {
    const m = this.mission
    if (!m) return
    const g = this.host.game
    this.visuals.sync(g.time)
    const ac = this.host.active()
    if (this.phase === 'board') {
      if (ac) { this.plane = ac; this.phase = 'fly' } else return
    }
    if (!ac || ac !== this.plane) return
    const s = this.flyState(ac, dt)
    m.update(s)
    if (!this.mission) return
    // Space（空中）→ 拍照 / 投放
    const control = g.state === 'play' && !g.phone.open
    if (control && s.airborne && m.action && g.input.justPressed('Space')) m.action(s)
    if (this.autofly && s.airborne && m.action && m.autoAction?.(s)) m.action(s)
    if (!m.done) this.landing = this.pickLanding(ac.x)
    if (this.phase === 'stopping' && ac.body.onGround && s.speed < 3) { this.settle(); return }
    if (this.autofly) this.autoPilot(s)
  }

  /** 调试：任务感知自动驾驶 */
  private autoPilot(s: FlyState) {
    const m = this.mission!
    if (!m.done) {
      // 起飞段：沿当前航向滑跑离地，爬到 60 m 再转向目标（调试前先 place 到跑道头）
      if (!s.airborne) this.climbHdg = heading(s.b)
      if (!s.airborne || s.b.y < 60) { this.host.autopilot({ hdg: this.climbHdg, alt: 150, spd: 48 }); return }
      this.host.autopilot(this.guard(s, m.auto(s)))
      return
    }
    if (this.phase === 'stopping') { this.host.autopilot({ land: { ...this.landing.td, hdg: this.landing.hdg } }); return }
    const L = this.landing
    const d = hdist(s.b.x, s.b.z, L.iaf.x, L.iaf.z)
    if (!this.autoFinal && d < 350) this.autoFinal = true
    if (this.autoFinal) this.host.autopilot({ land: { ...L.td, hdg: L.hdg } })
    else this.host.autopilot(this.guard(s, { to: L.iaf, alt: d < 1500 ? 160 : safeAlt(this.missionHost(), s.b.x, s.b.z, L.iaf.x, L.iaf.z, 160), spd: 45 }))
  }

  /**
   * 调试自动驾驶防撞：前方 900 m 航线上或身边 250 m 内有高过自己（−10 m 余量内）的楼 →
   * 向远离最高点的一侧盘旋爬升到安全高度再继续（包机在低空目标 700 m 内故意贴着楼群，只看前方航线）。
   */
  private guard(s: FlyState, cmd: AutopilotTarget): AutopilotTarget {
    if (!cmd.to) return cmd
    const b = s.b, host = this.missionHost()
    const hd = heading(b)
    let top = 0, tx = 0, tz = 0
    const probe = (x: number, z: number) => { const h = host.hf(x, z, 30); if (h > top) { top = h; tx = x; tz = z } }
    const L = hdist(b.x, b.z, cmd.to.x, cmd.to.z), k = Math.min(1, 900 / Math.max(1, L))
    for (let i = 1; i <= 22; i++) probe(b.x + (cmd.to.x - b.x) * k * i / 22, b.z + (cmd.to.z - b.z) * k * i / 22)
    if (this.mission?.kind !== 'charter' || L > 700) for (const r of [90, 170, 250]) for (let j = 0; j < 12; j++) probe(b.x + Math.sin(j * Math.PI / 6) * r, b.z + Math.cos(j * Math.PI / 6) * r)
    if (b.y > top + 25) return cmd
    // 最高点在左（heading 增大方向）还是右 → 往另一侧转
    const rel = Math.atan2(Math.sin(Math.atan2(tx - b.x, tz - b.z) - hd), Math.cos(Math.atan2(tx - b.x, tz - b.z) - hd))
    return { hdg: hd + (rel > 0 ? -0.7 : 0.7), alt: top + 60, spd: 42 }
  }

  /** 当前导航点：登机 → 飞机；目标中 → 任务目标；完成 → 进近点 / 跑道接地点 */
  navTarget(): NavPoint | null {
    const m = this.mission
    if (!m) return null
    if (this.phase === 'board') return this.plane ? { x: this.plane.x, z: this.plane.z } : null
    const t0 = m.target()
    if (t0) return t0
    const ac = this.host.active()
    const L = this.landing
    if (ac && !ac.body.onGround && !this.autoFinal && hdist(ac.x, ac.z, L.td.x, L.td.z) > 2600) return L.iaf
    return L.td
  }
  navPath(): NavPoint[] | null {
    const m = this.mission
    const ac = this.host.active()
    if (!m || !ac || this.phase === 'board') return null
    const L = this.landing
    return [{ x: ac.x, z: ac.z }, ...m.path(), L.iaf, L.td, { x: L.td.x + Math.sin(L.hdg) * 900, z: L.td.z }]
  }

  hudCard(): { title: string; desc: string; timer: string; sub?: string } | null {
    const m = this.mission
    if (!m) return null
    const g = this.host.game
    const ac = this.host.active()
    const s = ac && ac === this.plane ? this.flyState(ac, 0) : null
    const title = t("{title}（{p}）", { title: JOB_TITLE[m.kind], p: m.progress() })
    const timer = fmtT(g.time - m.startedAt)
    if (this.phase === 'board') return { title, desc: t('去停机位登机（按 F）'), timer }
    if (this.phase === 'stopping') return { title, desc: t('刹车停稳结算'), timer }
    if (m.done) return { title, desc: t('回跑道落地（{rw} 号跑道）· {desc}', { rw: this.landing.name, desc: m.desc(s) }), timer }
    return { title, desc: m.desc(s), timer, sub: m.hint?.() }
  }

  serialize(): FlightJobsSave { return { ...this.s, done: { ...this.s.done }, log: [...this.s.log] } }
  restore(d?: Partial<FlightJobsSave>) {
    if (this.mission) this.fail(t('读档'), true)
    this.s = { day: d?.day ?? 1, today: d?.today ?? 0, total: d?.total ?? 0, done: { ...(d?.done ?? {}) }, log: [...(d?.log ?? [])] }
  }

  debugState() {
    const m = this.mission
    return m ? { kind: m.kind, job: this.jobId, phase: this.phase, done: m.done, progress: m.progress(), target: m.target(), landing: this.landing.name, autoFinal: this.autoFinal, autofly: this.autofly, plane: this.plane?.id ?? null, detail: m.debug(), visuals: this.visuals.counts } : { kind: null, last: this.last, lastFail: this.lastFail, today: this.today(), total: this.s.total }
  }
  /** 调试：直接完成目标（进入回跑道阶段） */
  forceComplete() { if (!this.mission) return false; this.mission.done = true; return true }
}

function orderNearest<T extends { x: number; z: number }>(arr: T[], from: { x: number; z: number }): T[] {
  const left = [...arr], out: T[] = []
  let p: { x: number; z: number } = from
  while (left.length) {
    let bi = 0
    for (let i = 1; i < left.length; i++) if (hdist(p.x, p.z, left[i].x, left[i].z) < hdist(p.x, p.z, left[bi].x, left[bi].z)) bi = i
    const q = left.splice(bi, 1)[0]; out.push(q); p = q
  }
  return out
}
