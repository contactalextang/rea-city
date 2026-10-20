import type { Ctx } from '../core/Context'
import type { P2 } from '../world/RoadGraph'
import type { Poi, PoiType } from './Poi'
import { Vehicle } from '../entities/Vehicle'
import { Marker, TARGET_COLOR } from '../world/Marker'
import { QUESTS, type QuestDef, type StepDef, type PoiRef } from '../data/quests'

export interface QuestsSave {
  done: string[]
  active: { id: string; step: number; progress: number; timer: number; pois: Record<string, string> } | null
}

const STEP_LABEL: Record<StepDef['kind'], string> = {
  goto: '前往粉色标记', drive: '开车到粉色标记', deliver: '把金色轿车开到粉色标记', earn: '赚钱', wreck: '撞毁车辆',
  eat: '吃一顿', sleep: '回家睡觉', clockIn: '去办公楼打卡', rentTaxi: '去的士站租车', job: '完成工作', invest: '投资',
}

/**
 * 被动工作 id → 去哪类 POI 开展（job / earn 步骤的指引）。
 * 手机开工的工作（收保护费随机挑店、的士载客等）不在此列：开工后由 Jobs 自己给目标，这里指了反而误导。
 */
const JOB_POI: Record<string, PoiType> = { white_shift: 'office', blue_site: 'site' }
/** 事件步骤的指引点每隔多少秒按玩家位置重选"最近" */
const EVENT_RETARGET = 1

/**
 * 数据驱动任务（取代 Missions）：按身份筛选 data/quests.ts；auto 任务开局自动接，
 * POI 给予的任务在门口放黄柱走近即接；步骤由位置检测或事件（吃/睡/打卡/收入…）推进。
 */
export class Quests {
  defs: QuestDef[]
  done = new Set<string>()
  active: QuestDef | null = null
  step = 0
  /** 当前步骤累计（赚到的钱 / 撞毁数 / 完成次数） */
  progress = 0
  /** 剩余秒数（有限时时） */
  timer = 0
  missionCar: Vehicle
  private resolved: Record<string, string> = {}
  private giverMarkers = new Map<string, Marker>()
  private targetMarker = new Marker(TARGET_COLOR)
  /** 事件步骤（吃/睡/打卡…）的就近指引重算计时 */
  private eventTimer = 0
  private result: 'none' | 'win' | 'fail' = 'none'
  resultTimer = 0
  toast: (s: string, sec?: number) => void = () => {}

  constructor(private ctx: Ctx) {
    this.defs = QUESTS.filter((q) => q.roles === 'all' || q.roles.includes(ctx.role.id))
    ctx.scene.add(this.targetMarker.group)
    for (const q of this.defs) if (q.giver !== 'auto') { const m = new Marker(0xffd33d); ctx.scene.add(m.group); this.giverMarkers.set(q.id, m) }
    this.missionCar = new Vehicle('mission', 0xf5b400)
    ctx.scene.add(this.missionCar.group); ctx.vehicles.push(this.missionCar)
    const ev = ctx.events
    ev.on('ate', () => this.onKind('eat'))
    ev.on('slept', () => this.onKind('sleep'))
    ev.on('clockIn', () => this.onKind('clockIn'))
    ev.on('taxiRented', () => this.onKind('rentTaxi'))
    ev.on('invested', ({ amount }) => { const s = this.current; if (s?.kind === 'invest') this.bump(amount, s.amount) })
    ev.on('jobDone', ({ job, amount }) => {
      const s = this.current
      if (s?.kind === 'earn' && (!s.source || s.source === job)) this.bump(amount, s.amount)
      else if (s?.kind === 'job' && s.job === job) this.bump(1, s.count ?? 1)
    })
    ev.on('vehicleWrecked', ({ v, byPlayer }) => {
      const s = this.current
      if (s?.kind === 'deliver' && v === this.missionCar) { this.fail('车报废了'); return }
      if (s?.kind === 'wreck' && byPlayer && v !== this.missionCar) { this.bump(1, s.count); if (this.active) this.toast(`撞毁 ${this.progress}/${s.count}`) }
    })
    this.refreshGivers()
  }

  get current(): StepDef | null { return this.active ? this.active.steps[this.step] ?? null : null }
  get completed() { return this.done.size }
  get allDone() { return this.defs.length > 0 && this.defs.every((q) => this.done.has(q.id)) }
  byId(id: string) { return this.defs.find((q) => q.id === id) ?? null }

  /** 读档/开局：恢复进度并自动接新手任务 */
  init(save?: QuestsSave | null) {
    this.done = new Set(save?.done ?? [])
    this.active = null; this.resolved = {}
    const a = save?.active
    const def = a ? this.byId(a.id) : null
    if (a && def && !this.done.has(def.id)) {
      this.active = def; this.step = Math.min(a.step, def.steps.length - 1); this.progress = a.progress ?? 0
      this.timer = a.timer ?? def.timeLimit ?? 0; this.resolved = { ...(a.pois ?? {}) }
      this.enterStep()
    }
    this.autoStart()
    this.refreshGivers()
  }
  serialize(): QuestsSave {
    return { done: [...this.done], active: this.active ? { id: this.active.id, step: this.step, progress: this.progress, timer: this.timer, pois: { ...this.resolved } } : null }
  }

  private requiresOk(q: QuestDef) { return !q.requires || this.done.has(q.requires) }
  private autoStart() {
    if (this.active) return
    const chained = new Set(this.defs.map((q) => q.next).filter((x): x is string => !!x))
    const q = this.defs.find((d) => d.giver === 'auto' && !this.done.has(d.id) && !chained.has(d.id) && this.requiresOk(d))
    if (q) this.begin(q)
  }

  private giverPoi(q: QuestDef): Poi | null {
    if (q.giver === 'auto') return null
    return typeof q.giver === 'string' ? this.ctx.pois.byId(q.giver) : this.ctx.pois.byType(q.giver.type)[0] ?? null
  }
  /** 黄柱：未完成、前置已满足、当前没有任务在进行时显示 */
  private refreshGivers() {
    for (const q of this.defs) {
      const m = this.giverMarkers.get(q.id); if (!m) continue
      const show = !this.active && !this.done.has(q.id) && this.requiresOk(q)
      m.set(show ? this.giverPoi(q)?.door ?? null : null)
    }
  }
  /** 小地图上的任务起点 */
  get starts(): P2[] { const out: P2[] = []; for (const m of this.giverMarkers.values()) { const p = m.point; if (p) out.push(p) } return out }

  private resolve(ref: PoiRef, key: string): Poi | null {
    if (typeof ref === 'string') return this.ctx.pois.byId(ref)
    const saved = this.resolved[key]
    if (saved) { const p = this.ctx.pois.byId(saved); if (p && p.type === ref.type) return p }
    const pl = this.ctx.player
    const p = this.ctx.pois.nearest(pl.worldX, pl.worldZ, Infinity, [ref.type])
    if (p) this.resolved[key] = p.id
    return p
  }

  begin(q: QuestDef) {
    if (this.active) this.end('fail')
    this.active = q; this.step = 0; this.progress = 0; this.result = 'none'
    this.timer = q.timeLimit ?? 0; this.resolved = {}
    this.toast(`${q.title}：${q.intro}`, 4)
    this.enterStep()
    this.refreshGivers()
  }

  private enterStep() {
    const s = this.current; if (!s) return
    const key = (k: string) => `${this.step}:${k}`
    this.targetMarker.set(null)
    if (s.kind === 'goto' || s.kind === 'drive') this.targetMarker.set(this.resolve(s.poi, key('poi'))?.door ?? null)
    else if (s.kind === 'deliver') {
      const from = this.resolve(s.from, key('from')), to = this.resolve(s.to, key('to'))
      if (from) this.parkMissionCar(from.door)
      this.targetMarker.set(to?.door ?? null)
    } else this.retargetEvent()
  }

  /**
   * 事件步骤没有固定地点：按类型给"该去哪"的就近指引（光柱 + 小地图目标），事件触发即推进。
   * eat → 小贩中心（没有则商店）；sleep → 自己的家；clockIn / invest → 办公楼；rentTaxi → 的士站；
   * job / earn → 该工作的 POI（JOB_POI）；wreck → 无（随便哪辆车）。
   */
  private eventPoi(s: StepDef): Poi | null {
    const ctx = this.ctx, pl = ctx.player
    const near = (types: PoiType[]) => ctx.pois.nearest(pl.worldX, pl.worldZ, Infinity, types)
    switch (s.kind) {
      case 'eat': return near(['hawker']) ?? near(['shop'])
      case 'sleep': return ctx.pois.byId(ctx.role.home) ?? near(['home'])
      case 'clockIn': case 'invest': return near(['office'])
      case 'rentTaxi': return near(['taxi'])
      case 'job': { const t = JOB_POI[s.job]; return t ? near([t]) : null }
      case 'earn': { const t = s.source ? JOB_POI[s.source] : undefined; return t ? near([t]) : null }
      default: return null
    }
  }
  private retargetEvent() {
    const s = this.current; if (!s) return
    if (s.kind === 'goto' || s.kind === 'drive' || s.kind === 'deliver') return
    this.eventTimer = EVENT_RETARGET
    this.targetMarker.set(this.eventPoi(s)?.door ?? null)
  }

  /** 把金色任务车停在某门口最近的车道上 */
  private parkMissionCar(door: P2) {
    const ctx = this.ctx
    if (ctx.player.vehicle === this.missionCar) ctx.player.exit(ctx.world)
    const g = ctx.graph
    const near = g.nearestLane(door.x, door.z)
    const e = near.edge, t = Math.max(6, Math.min(e.length - 6, near.t + 9))
    const p = g.lanePoint(e, t, { x: 0, z: 0 })
    const dir = g.dirAt(e, t, { x: 0, z: 0 })
    this.missionCar.activate(p.x, p.z, Math.atan2(dir.x, dir.z))
    this.missionCar.controls.handbrake = true
  }

  private bump(n: number, need: number) {
    if (!this.active) return
    this.progress += n
    if (this.progress >= need) this.advance()
  }
  private onKind(kind: StepDef['kind']) { if (this.current?.kind === kind) this.advance() }

  /** 当前步骤完成 → 下一步或结束（测试钩子也调用） */
  advance() {
    const q = this.active; if (!q) return
    this.step++; this.progress = 0
    if (this.step >= q.steps.length) { this.finish(); return }
    this.toast(`下一步：${this.stepLabel()}`, 3)
    this.enterStep()
  }
  private finish() {
    const q = this.active!
    this.done.add(q.id)
    this.ctx.player.money = Math.round((this.ctx.player.money + q.reward) * 100) / 100
    this.toast(`任务完成「${q.title}」+$${q.reward}`, 3)
    this.end('win')
    const next = q.next ? this.byId(q.next) : null
    if (next && !this.done.has(next.id)) this.begin(next)
  }
  fail(reason: string) {
    if (!this.active) return
    this.toast(`任务失败：${reason}`, 3)
    this.end('fail')
  }
  private end(r: 'win' | 'fail') {
    this.result = r; this.resultTimer = 3
    this.active = null; this.step = 0; this.progress = 0
    this.targetMarker.set(null)
    if (this.missionCar.active && this.ctx.player.vehicle !== this.missionCar) this.missionCar.deactivate()
    this.refreshGivers()
  }
  onPlayerDown() { if (this.active?.timeLimit) this.fail('你倒下了') }

  update(dt: number) {
    const ctx = this.ctx, pl = ctx.player
    const px = pl.worldX, pz = pl.worldZ
    this.resultTimer = Math.max(0, this.resultTimer - dt)
    if (!this.active) {
      if (this.resultTimer > 0) return
      for (const q of this.defs) {
        const p = this.giverMarkers.get(q.id)?.point
        if (p && Math.hypot(px - p.x, pz - p.z) < 4) { this.begin(q); break }
      }
      return
    }
    const q = this.active
    if (q.timeLimit) { this.timer -= dt; if (this.timer <= 0) { this.fail('超时'); return } }
    const s = this.current; if (!s) return
    const key = (k: string) => `${this.step}:${k}`
    this.eventTimer -= dt
    if (this.eventTimer <= 0) this.retargetEvent()
    if (s.kind === 'goto') {
      const p = this.resolve(s.poi, key('poi'))
      if (p && Math.hypot(px - p.door.x, pz - p.door.z) < (s.radius ?? 5)) this.advance()
    } else if (s.kind === 'drive') {
      const p = this.resolve(s.poi, key('poi')), v = pl.vehicle
      if (p && v && (s.vehicle !== 'taxi' || v.kind === 'taxi') && Math.hypot(px - p.door.x, pz - p.door.z) < (s.radius ?? 6)) this.advance()
    } else if (s.kind === 'deliver') {
      const to = this.resolve(s.to, key('to'))
      if (to && pl.vehicle === this.missionCar && Math.hypot(px - to.door.x, pz - to.door.z) < (s.radius ?? 8) && this.missionCar.absSpeed < 3) this.advance()
    }
  }

  stepLabel() {
    const s = this.current; if (!s) return ''
    let l = s.label ?? STEP_LABEL[s.kind]
    if (s.kind === 'earn') l += `（$${this.progress}/$${s.amount}）`
    else if (s.kind === 'wreck') l += `（${this.progress}/${s.count}）`
    else if (s.kind === 'job' && (s.count ?? 1) > 1) l += `（${this.progress}/${s.count}）`
    else if (s.kind === 'invest') l += `（$${this.progress}/$${s.amount}）`
    return l
  }
  /** 当前应在小地图上指示的目标点 */
  get targetPoint(): P2 | null {
    const s = this.current
    if (s?.kind === 'deliver' && this.ctx.player.vehicle !== this.missionCar && this.missionCar.active) return { x: this.missionCar.x, z: this.missionCar.z }
    return this.targetMarker.point
  }
  /** 金色任务车（未上车时）的小地图点 */
  get carPoint(): P2 | null { return this.missionCar.active && this.ctx.player.vehicle !== this.missionCar ? { x: this.missionCar.x, z: this.missionCar.z } : null }

  hudCard(): { title: string; desc: string; timer: string } | null {
    if (!this.active) return this.resultTimer > 0 ? { title: this.result === 'win' ? '任务完成' : '任务失败', desc: '', timer: '' } : null
    return { title: `${this.active.title}（${this.step + 1}/${this.active.steps.length}）`, desc: this.stepLabel(), timer: this.active.timeLimit ? `${Math.ceil(this.timer)}s` : '' }
  }
  /** hideTarget：有工作目标在进行时隐藏任务光柱（只藏模型，targetPoint 不受影响），避免同时出现两根品红光柱 */
  sync(t: number, hideTarget = false) {
    for (const c of this.targetMarker.group.children) c.visible = !hideTarget
    this.targetMarker.sync(t); for (const m of this.giverMarkers.values()) m.sync(t)
  }
}
