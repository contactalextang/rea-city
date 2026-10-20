import type { Ctx, Subsystem, AppView, PurchaseKind } from '../core/Context'
import type { PanelButton } from '../ui/Panels'
import type { Poi } from './Poi'
import { MAX_LEVEL, XP, xpFor, titleFor, nextUnlocks, ACHIEVEMENTS, type AchievementId } from '../data/progression'

/** 终身统计 */
export interface LifeStats {
  /** 现金累计流入 / 流出（按每帧现金变化自动累计，含工作、任务、投资回款、罚款等） */
  earned: number
  spent: number
  /** 产业收入（bizIncome 事件累计） */
  bizIncome: number
  /** 移动里程（步行 + 驾车，瞬移不算） */
  distanceKm: number
  /** 的士完成趟数 */
  trips: number
  arrests: number
  daysPlayed: number
  peakNetWorth: number
  /** 各类购买次数（purchased 事件按 kind 计） */
  bought: Partial<Record<PurchaseKind, number>>
}
export interface ProgressSave {
  level: number
  /** 当前等级内的 XP */
  xp: number
  stats: LifeStats
  achievements: string[]
  /** 自有房产睡醒后的 XP 加成：buffDay 当天 XP × buffMul */
  buffDay?: number
  buffMul?: number
}
/** Game 提供的估值查询（净资产 / 已拥有产业数） */
export interface ProgressHost {
  netWorth(): number
  bizCount(): number
}

const round2 = (n: number) => Math.round(n * 100) / 100
const defaultStats = (): LifeStats => ({ earned: 0, spent: 0, bizIncome: 0, distanceKm: 0, trips: 0, arrests: 0, daysPlayed: 1, peakNetWorth: 0, bought: {} })
const usd = (n: number) => `$${Math.round(n).toLocaleString()}`

/**
 * 成长：XP（挂在 jobDone / ate / slept / clockIn / purchased / bizIncome 事件与任务完成上）、
 * 等级与身份头衔、成就、终身统计。升级 / 解锁成就时发 levelUp / achievement 事件（Game 弹 toast）。
 */
export class Progress implements Subsystem<ProgressSave> {
  level = 1
  xp = 0
  stats: LifeStats = defaultStats()
  achievements = new Set<string>()
  private buffDay = -1
  private buffMul = 1
  /** 每帧差分的基线（现金 / 位置 / 日期 / 被捕次数）；读档、调试改钱后 resync() */
  private lastCash = 0
  private lastX = 0
  private lastZ = 0
  private lastDay = 1
  private lastArrests = 0
  private checkTimer = 0
  private raidSurvived = false

  constructor(private ctx: Ctx, private host: ProgressHost) {
    const ev = ctx.events
    ev.on('jobDone', ({ job, amount }) => {
      this.addXp(amount * XP.perJobDollar)
      if (job === 'blue_taxi') this.stats.trips++
    })
    ev.on('ate', () => this.addXp(XP.ate))
    ev.on('slept', ({ day, xpMul }) => {
      if (xpMul && xpMul > 1) { this.buffDay = day; this.buffMul = xpMul }
      this.addXp(XP.slept)
    })
    ev.on('clockIn', () => this.addXp(XP.clockIn))
    ev.on('purchased', ({ kind, cost }) => {
      this.stats.bought[kind] = (this.stats.bought[kind] ?? 0) + 1
      this.addXp(Math.min(XP.purchaseCap, cost / XP.purchaseDiv))
      this.check()
    })
    ev.on('bizIncome', ({ amount }) => {
      this.stats.bizIncome = round2(this.stats.bizIncome + amount)
      this.addXp(amount / XP.bizIncomeDiv)
    })
    ev.on('bizEvent', ({ kind }) => { if (kind === 'raid') { this.raidSurvived = true; this.check() } })
    this.resync()
  }

  get title() { return titleFor(this.ctx.role.id, this.level) }
  /** 升到下一级还需的总 XP（满级为 0） */
  get need() { return this.level >= MAX_LEVEL ? 0 : xpFor(this.level) }
  /** 当前等级进度 0–1 */
  get pct() { return this.level >= MAX_LEVEL ? 1 : Math.min(1, this.xp / this.need) }

  /** 加 XP（自有房产睡醒当天 ×buffMul）；可连升多级，每级发一次 levelUp */
  addXp(n: number) {
    if (!(n > 0)) return
    if (this.ctx.clock.day === this.buffDay) n *= this.buffMul
    if (this.level >= MAX_LEVEL) return
    this.xp += n
    while (this.level < MAX_LEVEL && this.xp >= xpFor(this.level)) {
      this.xp -= xpFor(this.level)
      this.level++
      this.ctx.events.emit('levelUp', { level: this.level })
    }
    if (this.level >= MAX_LEVEL) this.xp = 0
    this.check()
  }
  /** 任务完成（Game 比对 quests.done 后调用）：XP = 奖励的 1/5 */
  questDone(reward: number) { this.addXp(reward / XP.questRewardDiv) }

  /** 重设差分基线（读档 / 调试改钱 / 瞬移后调用，避免把跳变算进统计） */
  resync() {
    const c = this.ctx
    this.lastCash = c.player.money
    this.lastX = c.player.worldX; this.lastZ = c.player.worldZ
    this.lastDay = c.clock.day
    this.lastArrests = c.law.arrests
  }

  update(dt: number) {
    const c = this.ctx, s = this.stats
    const d = c.player.money - this.lastCash
    if (d > 0) s.earned = round2(s.earned + d); else if (d < 0) s.spent = round2(s.spent - d)
    this.lastCash = c.player.money
    const x = c.player.worldX, z = c.player.worldZ
    const step = Math.hypot(x - this.lastX, z - this.lastZ)
    if (step < 60) s.distanceKm += step / 1000   // 一步跳 60 m 以上视为瞬移（地铁 / 重生 / 读档）
    this.lastX = x; this.lastZ = z
    if (c.clock.day > this.lastDay) s.daysPlayed += c.clock.day - this.lastDay
    this.lastDay = c.clock.day
    if (c.law.arrests > this.lastArrests) s.arrests += c.law.arrests - this.lastArrests
    this.lastArrests = c.law.arrests
    this.checkTimer += dt
    if (this.checkTimer >= 1) { this.checkTimer = 0; this.check() }
  }

  /** 刷新净资产峰值并检查成就 */
  check() {
    const s = this.stats
    const nw = this.host.netWorth()
    if (nw > s.peakNetWorth) s.peakNetWorth = round2(nw)
    const biz = Math.max(this.host.bizCount(), s.bought.biz ?? 0)
    const anyBuy = Object.values(s.bought).some((n) => (n ?? 0) > 0)
    const cond: Record<AchievementId, boolean> = {
      first_buy: anyBuy,
      first_biz: biz >= 1,
      biz_3: this.host.bizCount() >= 3,
      nw_10k: s.peakNetWorth >= 10_000,
      nw_100k: s.peakNetWorth >= 100_000,
      nw_1m: s.peakNetWorth >= 1_000_000,
      lv_10: this.level >= 10,
      lv_20: this.level >= 20,
      taxi_100: s.trips >= 100,
      survive_raid: this.raidSurvived,
      buy_car: (s.bought.vehicle ?? 0) >= 1,
      two_homes: (s.bought.property ?? 0) >= 2,
    }
    for (const a of ACHIEVEMENTS) {
      if (!cond[a.id] || this.achievements.has(a.id)) continue
      this.achievements.add(a.id)
      this.ctx.events.emit('achievement', { id: a.id })
    }
  }

  poiButtons(_poi: Poi): PanelButton[] { return [] }

  /** 手机「成长」页 */
  view(): AppView {
    const s = this.stats, role = this.ctx.role.id
    const need = this.need
    const next = nextUnlocks(role, this.level).slice(0, 3)
    return {
      lines: [
        `Lv${this.level} ${this.title}${this.ctx.clock.day === this.buffDay && this.buffMul > 1 ? ` · 今日 XP ×${this.buffMul}` : ''}`,
        need ? `距 Lv${this.level + 1} 还差 ${Math.ceil(need - this.xp)} XP` : '已满级',
      ],
      bars: [{ label: '经验', pct: this.pct, text: need ? `${Math.floor(this.xp)} / ${need}` : 'MAX' }],
      sections: [
        { title: '下一个解锁', items: next.length ? next.map((u) => ({ title: u.label, value: `Lv${u.level}`, tone: 'locked' as const })) : [{ title: '没有更多等级门槛了' }] },
        { title: '终身统计', items: [
          { title: '累计收入', value: usd(s.earned) }, { title: '累计花费', value: usd(s.spent) },
          { title: '产业收入', value: usd(s.bizIncome) }, { title: '净资产峰值', value: usd(s.peakNetWorth) },
          { title: '里程', value: `${s.distanceKm.toFixed(1)} km` }, { title: '的士趟数', value: `${s.trips}` },
          { title: '被捕次数', value: `${s.arrests}` }, { title: '游戏天数', value: `${s.daysPlayed}` },
        ] },
        { title: `成就 ${this.achievements.size}/${ACHIEVEMENTS.length}`, items: ACHIEVEMENTS.map((a) => {
          const got = this.achievements.has(a.id)
          return { title: `${got ? '★' : '☆'} ${a.name}`, desc: a.desc, tone: got ? 'owned' as const : 'locked' as const }
        }) },
      ],
    }
  }

  serialize(): ProgressSave {
    return { level: this.level, xp: this.xp, stats: JSON.parse(JSON.stringify(this.stats)) as LifeStats, achievements: [...this.achievements], buffDay: this.buffDay, buffMul: this.buffMul }
  }
  restore(d?: ProgressSave) {
    const base = defaultStats()
    this.level = Math.max(1, Math.min(MAX_LEVEL, Math.floor(d?.level ?? 1)))
    this.xp = Math.max(0, d?.xp ?? 0)
    this.stats = { ...base, ...(d?.stats ?? {}), bought: { ...(d?.stats?.bought ?? {}) } }
    this.achievements = new Set(d?.achievements ?? [])
    this.raidSurvived = this.achievements.has('survive_raid')
    this.buffDay = d?.buffDay ?? -1
    this.buffMul = d?.buffMul ?? 1
    this.resync()
  }
}
