import type { Ctx } from '../core/Context'
import type { P2 } from '../world/RoadGraph'
import type { Poi, PoiType } from './Poi'
import { Vehicle } from '../entities/Vehicle'
import { Marker, TARGET_COLOR } from '../world/Marker'
import { QUESTS, type QuestDef, type StepDef, type PoiRef } from '../data/quests'
import { bizType } from '../data/business'
import { SHOP, shopItem, canRoleBuy } from '../data/shop'
import { t } from '../i18n'
import { tierName } from './Business'

export interface QuestsSave {
  done: string[]
  active: { id: string; step: number; progress: number; timer: number; pois: Record<string, string> } | null
}

const STEP_LABEL: Record<StepDef['kind'], string> = {
  goto: t('前往粉色标记'), drive: t('开车到粉色标记'), deliver: t('把金色轿车开到粉色标记'), earn: t('赚钱'), wreck: t('撞毁车辆'),
  eat: t('吃一顿'), sleep: t('回家睡觉'), clockIn: t('去办公楼打卡'), rentTaxi: t('去的士站租车'), job: t('完成工作'), invest: t('投资'),
  buy: t('买下指定物品'), ownBiz: t('拥有产业'), bizIncome: t('产业入账'), netWorth: t('净资产达标'), level: t('升级'),
}
/** 步骤进度后缀：（a/b） */
const paren = (s: string) => t('（{s}）', { s })

/**
 * 帝国线步骤的数据源（Game 在 Business / Assets / Progress / Wallet 建好后调 setSources 注入）。
 * 只用到最小的鸭子类型接口，缺失时相关步骤安全地不推进（进度显示「—」）。
 */
export interface QuestSources {
  business?: { list(): readonly { type: string; poi: string; tier: number }[] }
  assets?: { owns(id: string): boolean }
  progress?: { readonly level: number }
  netWorth?: () => number
}
/** 轮询型步骤（ownBiz / netWorth / level / 已拥有的 buy）的检查间隔（秒） */
const POLL_EVERY = 0.5
const usd = (n: number) => `$${Math.round(n).toLocaleString()}`

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
  private src: QuestSources = {}
  private pollTimer = 0

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
    ev.on('purchased', ({ kind, id }) => {
      const s = this.current
      if (s?.kind !== 'buy') return
      const base = id.split('@')[0]
      if ((s.item && (s.item === id || s.item === base)) || (!s.item && s.itemKind && s.itemKind === kind)) this.advance()
    })
    ev.on('bizIncome', ({ amount }) => { const s = this.current; if (s?.kind === 'bizIncome') this.bump(Math.round(amount * 100) / 100, s.amount) })
    ev.on('invested', ({ amount }) => { const s = this.current; if (s?.kind === 'invest') this.bump(amount, s.amount) })
    ev.on('jobDone', ({ job, amount }) => {
      const s = this.current
      if (s?.kind === 'earn' && (!s.source || s.source === job)) this.bump(amount, s.amount)
      else if (s?.kind === 'job' && s.job === job) this.bump(1, s.count ?? 1)
    })
    ev.on('vehicleWrecked', ({ v, byPlayer }) => {
      const s = this.current
      if (s?.kind === 'deliver' && v === this.missionCar) { this.fail(t('车报废了')); return }
      if (s?.kind === 'wreck' && byPlayer && v !== this.missionCar) { this.bump(1, s.count); if (this.active) this.toast(t('撞毁 {a}/{b}', { a: this.progress, b: s.count })) }
    })
    this.refreshGivers()
    // 调试：headless 测试可直接拿到实例（__game.quests 是包装对象）
    ;(globalThis as unknown as { __quests?: Quests }).__quests = this
  }

  /** 注入帝国线数据源（可多次调用、可部分注入） */
  setSources(src: QuestSources) { this.src = { ...this.src, ...src }; this.pollTimer = 0 }

  get current(): StepDef | null { return this.active ? this.active.steps[this.step] ?? null : null }
  get completed() { return this.done.size }
  private get story() { return this.defs.filter((q) => (q.tier ?? 'story') === 'story') }
  private get empire() { return this.defs.filter((q) => q.tier === 'empire') }
  /** 故事线全部完成（帝国线不计） */
  get allDone() { const st = this.story; return st.length > 0 && st.every((q) => this.done.has(q.id)) }
  /** 本身份帝国线全部完成 */
  empireDone() { const em = this.empire; return em.length > 0 && em.every((q) => this.done.has(q.id)) }
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
  /**
   * 自动接任务：giver=auto、未完成、前置满足；被某任务 next 串着的，要等上一环完成才接；
   * 帝国线要等故事线全部完成（旧通关存档读档后也由此接上）。
   */
  private autoStart() {
    if (this.active) return
    const parent = new Map<string, string>()
    for (const q of this.defs) if (q.next) parent.set(q.next, q.id)
    const storyDone = this.allDone
    const q = this.defs.find((d) => {
      if (d.giver !== 'auto' || this.done.has(d.id) || !this.requiresOk(d)) return false
      if (d.tier === 'empire' && !storyDone) return false
      const p = parent.get(d.id)
      return p ? this.done.has(p) : true
    })
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
    this.toast(t('{title}：{intro}', { title: q.title, intro: q.intro }), 4)
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
      case 'ownBiz': return this.bizPoi(s)
      case 'buy': return this.buyPoi(s)
      case 'bizIncome': {
        // 最近的自有产业门口（去收钱）
        const owned = this.src.business?.list() ?? []
        let best: Poi | null = null, bd = Infinity
        for (const b of owned) { const p = ctx.pois.byId(b.poi); if (!p) continue; const d = Math.hypot(p.door.x - pl.worldX, p.door.z - pl.worldZ); if (d < bd) { bd = d; best = p } }
        return best
      }
      default: return null
    }
  }
  /** ownBiz 指引：有 tier 要求且已有该产业 → 自有那处（去升级）；否则最近的、还没被自己占用的该类 POI */
  private bizPoi(s: Extract<StepDef, { kind: 'ownBiz' }>): Poi | null {
    const t = s.type ? bizType(s.type) : null
    if (!t) return null
    const ctx = this.ctx, pl = ctx.player
    const owned = this.src.business?.list() ?? []
    if (s.tier) { const mine = owned.find((b) => b.type === t.id); const p = mine && ctx.pois.byId(mine.poi); if (p) return p }
    const taken = new Set(owned.map((b) => b.poi))
    let best: Poi | null = null, bd = Infinity
    for (const p of ctx.pois.byType(t.poiType)) {
      if (taken.has(p.id)) continue
      const d = Math.hypot(p.door.x - pl.worldX, p.door.z - pl.worldZ)
      if (d < bd) { bd = d; best = p }
    }
    return best
  }
  /** buy 指引：只有房产有门口（车 / 升级在手机商店买，无目标） */
  private buyPoi(s: Extract<StepDef, { kind: 'buy' }>): Poi | null {
    const ctx = this.ctx
    const items = s.item ? [shopItem(s.item)].filter((x) => !!x) : s.itemKind === 'property' ? SHOP.filter((it) => it.kind === 'property' && !it.hidden) : []
    for (const it of items) {
      if (!it || it.kind !== 'property' || !canRoleBuy(it, ctx.role.id) || this.src.assets?.owns(it.id)) continue
      for (const id of it.poi ?? []) { const p = ctx.pois.byId(id); if (p) return p }
    }
    return null
  }
  /** ownBiz 实际要求的数量：不超过本世界该类 POI 数与产业上限（?world=grid 只有 1 家商店等） */
  private bizNeed(s: Extract<StepDef, { kind: 'ownBiz' }>) {
    const t = s.type ? bizType(s.type) : null
    if (!t) return s.count
    return Math.max(1, Math.min(s.count, t.maxOwned, this.ctx.pois.byType(t.poiType).length))
  }
  /** 轮询型步骤的当前值（缺数据源 → null，不推进） */
  private pollValue(s: StepDef): number | null {
    const src = this.src
    switch (s.kind) {
      case 'ownBiz': {
        const l = src.business?.list(); if (!l) return null
        return l.filter((b) => (!s.type || b.type === s.type) && (!s.tier || b.tier >= s.tier)).length
      }
      case 'netWorth': return src.netWorth ? src.netWorth() : null
      case 'level': return src.progress ? src.progress.level : null
      default: return null
    }
  }
  private poll() {
    const s = this.current; if (!s) return
    if (s.kind === 'buy') { if (s.item && this.src.assets?.owns(s.item)) this.advance(); return }
    const v = this.pollValue(s); if (v === null) return
    const need = s.kind === 'ownBiz' ? this.bizNeed(s) : s.kind === 'netWorth' ? s.amount : s.kind === 'level' ? s.level : Infinity
    this.progress = s.kind === 'netWorth' ? Math.round(v) : v
    if (v >= need) this.advance()
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
    this.toast(t('下一步：{step}', { step: this.stepLabel() }), 3)
    this.enterStep()
  }
  private finish() {
    const q = this.active!
    this.done.add(q.id)
    this.ctx.player.money = Math.round((this.ctx.player.money + q.reward) * 100) / 100
    const last = q.tier === 'empire' && this.empireDone()
    this.toast(last ? t('帝国建成！「{title}」+{reward} · 手机「成长」看你的终身战绩', { title: q.title, reward: usd(q.reward) }) : t('任务完成「{title}」+{reward}', { title: q.title, reward: usd(q.reward) }), last ? 6 : 3)
    this.ctx.events.emit('questDone', { id: q.id, reward: q.reward })
    this.end('win')
    const next = q.next ? this.byId(q.next) : null
    if (next && !this.done.has(next.id)) this.begin(next)
  }
  fail(reason: string) {
    if (!this.active) return
    this.toast(t('任务失败：{reason}', { reason }), 3)
    this.end('fail')
  }
  private end(r: 'win' | 'fail') {
    this.result = r; this.resultTimer = 3
    this.active = null; this.step = 0; this.progress = 0
    this.targetMarker.set(null)
    if (this.missionCar.active && this.ctx.player.vehicle !== this.missionCar) this.missionCar.deactivate()
    this.refreshGivers()
  }
  onPlayerDown() { if (this.active?.timeLimit) this.fail(t('你倒下了')) }

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
      // 故事线刚通关（结果卡片消失后）→ 接上帝国线
      if (!this.active && this.allDone && !this.empireDone()) this.autoStart()
      return
    }
    const q = this.active
    if (q.timeLimit) { this.timer -= dt; if (this.timer <= 0) { this.fail(t('超时')); return } }
    const s = this.current; if (!s) return
    const key = (k: string) => `${this.step}:${k}`
    this.eventTimer -= dt
    if (this.eventTimer <= 0) this.retargetEvent()
    this.pollTimer -= dt
    if (this.pollTimer <= 0) { this.pollTimer = POLL_EVERY; this.poll(); if (this.active !== q || this.current !== s) return }
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
    if (s.kind === 'earn') l += paren(`$${this.progress}/$${s.amount}`)
    else if (s.kind === 'wreck') l += paren(`${this.progress}/${s.count}`)
    else if (s.kind === 'job' && (s.count ?? 1) > 1) l += paren(`${this.progress}/${s.count}`)
    else if (s.kind === 'invest') l += paren(`$${this.progress}/$${s.amount}`)
    else if (s.kind === 'bizIncome') l += paren(`${usd(this.progress)}/${usd(s.amount)}`)
    else if (s.kind === 'ownBiz' || s.kind === 'netWorth' || s.kind === 'level') {
      const v = this.pollValue(s)
      if (s.kind === 'ownBiz') l += paren(`${v ?? '—'}/${this.bizNeed(s)}${s.tier ? ' · ' + t('需 {x}', { x: tierName(bizType(s.type ?? '') ?? {}, s.tier) }) : ''}`)
      else if (s.kind === 'netWorth') l += paren(`${v === null ? '—' : usd(v)}/${usd(s.amount)}`)
      else l += paren(`Lv${v ?? '—'}/Lv${s.level}`)
    }
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
    if (!this.active) return this.resultTimer > 0 ? { title: this.result === 'win' ? t('任务完成') : t('任务失败'), desc: '', timer: '' } : null
    return { title: this.active.title + paren(`${this.step + 1}/${this.active.steps.length}`), desc: this.stepLabel(), timer: this.active.timeLimit ? `${Math.ceil(this.timer)}s` : '' }
  }
  /** hideTarget：有工作目标在进行时隐藏任务光柱（只藏模型，targetPoint 不受影响），避免同时出现两根品红光柱 */
  sync(t: number, hideTarget = false) {
    for (const c of this.targetMarker.group.children) c.visible = !hideTarget
    this.targetMarker.sync(t); for (const m of this.giverMarkers.values()) m.sync(t)
  }
}
