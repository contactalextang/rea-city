import type { Ctx, Subsystem, AppView, AppItem } from '../core/Context'
import type { PanelButton } from '../ui/Panels'
import type { P2 } from '../world/RoadGraph'
import { POI_LABEL, type Poi } from './Poi'
import { spend, earn } from './Wallet'
import { unlockLevel } from '../data/progression'
import { t } from '../i18n'
import { BIZ_TYPES, bizType, bizTypesFor, COLLECT_BONUS, MOOD_EVENTS, BIZ_RESALE, RISK_HOUR, type BizType } from '../data/business'

/** 一个已拥有的产业 */
export interface OwnedBiz {
  /** `${type}@${poi}`（一个 POI 至多一个产业） */
  id: string
  type: string
  poi: string
  /** 档位，从 1 起（的士车队 = 车辆数） */
  tier: number
  /** 钱柜（待收现金） */
  till: number
  manager: boolean
  /** 上次累积到的 clock.absHours */
  lastHour: number
  /** 当日景气倍率（景气 1.3 / 低迷 0.7 / 查封 0） */
  mood: number
  /** 已投入成本（买入 + 升级 + 经理），估值 = ×0.8 */
  invested?: number
}
export interface BizSave {
  owned: OwnedBiz[]
  /** 上次掷每日风险的游戏日 */
  riskDay: number
  /** 事件日志（最近在前，最多 20 条） */
  log: string[]
  /** 今日产业入账合计 */
  today?: { day: number; income: number }
  /** 彭博终端预告：day 当天 07:00 各产业预掷的景气 / 低迷（null = 平稳） */
  forecast?: { day: number; moods: Record<string, 'boom' | 'slump' | null> }
}

/** Game 提供给产业系统的依赖 */
export interface BusinessHost {
  toast(s: string, sec?: number): void
  save(): void
  /** 玩家当前等级（缺省 1） */
  level?(): number
  /** 操作后刷新当前 POI 面板 */
  refresh?(): void
  /** 拥有彭博终端：前一天 18:00 起预告次日 07:00 的景气 / 低迷 */
  hasBloomberg?(): boolean
}

export type BizEventKind = 'raid' | 'boom' | 'slump' | 'inspection'

const empty = (): BizSave => ({ owned: [], riskDay: -1, log: [], today: { day: 0, income: 0 } })
const round2 = (n: number) => Math.round(n * 100) / 100
const usd = (n: number) => `$${Math.round(n).toLocaleString()}`
const LOG_MAX = 20
/** 经理补算离线小时上限（7 天），钱柜本身按 cap 封顶 */
const MAX_CATCHUP_H = 24 * 7
/** 走到导航目标 15 m 内自动取消导航 */
const NAV_ARRIVE = 15
/** 彭博终端预告时刻（前一天 18:00） */
const FORECAST_HOUR = 18

const sumCost = (bt: BizType, tier: number) => bt.tiers.slice(0, tier).reduce((a, x) => a + x.cost, 0)
/** 档位名：有计量单位（「辆」）的写成「3 辆」，英文分单复数；否则 T3 */
export const tierName = (bt: Pick<BizType, 'unit'>, tier: number) =>
  !bt.unit ? `T${tier}`
    : bt.unit === t('辆') ? (tier === 1 ? t('1 辆') : t('{n} 辆', { n: tier }))
    : `${tier} ${bt.unit}`

/**
 * 产业帝国（Schedule I 式被动收入）：
 * - 每游戏小时钱柜 += perDay/24·mood，封顶 cap（= 一天收入）；有经理则每小时直接入账 80%。
 * - 亲自到门口收钱 +10%。
 * - 每日 07:00 掷风险：黑帮对头突袭（8% + 4%/星）、警察查封（5%，停业一天）；全身份景气 / 低迷各 10%。
 * value() = 已投入成本 × 0.8（计入净资产）；list() = 已拥有产业。
 */
export class Business implements Subsystem<BizSave> {
  private s: BizSave = empty()
  /** 手机「导航」选中的产业门口（Game 把它接进小地图目标链） */
  navTarget: P2 | null = null

  constructor(private ctx: Ctx, private host: BusinessHost) {}

  private get level() { return this.host.level?.() ?? 1 }
  private get role() { return this.ctx.role.id }

  // ---------- 每帧 ----------
  update(_dt: number) {
    const c = this.ctx.clock
    if (this.s.riskDay < 0) this.s.riskDay = c.hour >= RISK_HOUR ? c.day : c.day - 1
    const now = c.absHours
    if (c.day > this.s.riskDay && c.hour >= RISK_HOUR) {
      // 先按旧的 mood 累积到今天 07:00，再掷今天的风险，再累积余下的小时
      this.accrue(Math.min(now, (c.day - 1) * 24 + RISK_HOUR))
      this.s.riskDay = c.day
      this.rollRisk()
    }
    this.accrue(now)
    // 彭博终端：今天 07:00 已掷过、18:00 后 → 预掷明天的景气 / 低迷
    if (c.hour >= FORECAST_HOUR && this.s.riskDay === c.day && this.s.forecast?.day !== c.day + 1 && this.host.hasBloomberg?.()) this.makeForecast(c.day + 1)
    if (this.navTarget) {
      const p = this.ctx.player
      if (Math.hypot(p.worldX - this.navTarget.x, p.worldZ - this.navTarget.z) < NAV_ARRIVE) this.navTarget = null
    }
  }

  /** 按整小时补算到 now（睡觉 / 跳时也算） */
  private accrue(now: number) {
    for (const b of this.s.owned) {
      const h = now - b.lastHour
      if (h < 0) { b.lastHour = now; continue }
      if (h < 1) continue
      const whole = Math.floor(h)
      b.lastHour += whole
      const bt = bizType(b.type)
      if (!bt) continue
      const tier = bt.tiers[b.tier - 1]
      const rate = (tier.perDay / 24) * b.mood
      if (rate <= 0) continue
      if (b.manager) {
        const pay = round2(rate * Math.min(whole, MAX_CATCHUP_H) * bt.manager.cut)
        if (pay > 0) this.income(b, pay, true)
      } else {
        b.till = round2(Math.min(tier.cap, b.till + rate * whole))
      }
    }
  }

  private income(b: OwnedBiz, amount: number, auto: boolean) {
    earn(this.ctx, amount, auto ? 'bizAuto' : 'bizCollect')
    const day = this.ctx.clock.day
    const td = this.s.today ?? { day, income: 0 }
    if (td.day !== day) { td.day = day; td.income = 0 }
    td.income = round2(td.income + amount)
    this.s.today = td
    this.ctx.events.emit('bizIncome', { biz: b.id, amount, auto })
  }

  // ---------- 每日风险 ----------
  /** 掷一次景气 / 低迷（全身份） */
  private rollMood(): 'boom' | 'slump' | null {
    const y = Math.random()
    return y < MOOD_EVENTS.boom.p ? 'boom' : y < MOOD_EVENTS.boom.p + MOOD_EVENTS.slump.p ? 'slump' : null
  }
  /** 彭博终端：预掷 day 当天各产业的景气 / 低迷，写日志并 toast 预告 */
  private makeForecast(day: number) {
    const moods: Record<string, 'boom' | 'slump' | null> = {}
    const parts: string[] = []
    for (const b of this.s.owned) {
      const m = this.rollMood()
      moods[b.id] = m
      if (m) parts.push(t('{name}（{where}）', { name: bizType(b.type)?.name ?? b.type, where: this.poiName(b.poi) }) + (m === 'boom' ? t('景气 ×{n}', { n: MOOD_EVENTS.boom.mul }) : t('低迷 ×{n}', { n: MOOD_EVENTS.slump.mul })))
    }
    this.s.forecast = { day, moods }
    if (!this.s.owned.length) return
    const msg = t('彭博终端预告 · 明天 07:00：{list}', { list: parts.length ? parts.join(t('；')) : t('市场平稳') })
    this.addLog(msg)
    this.host.toast(msg, 5)
  }
  private rollRisk() {
    const fc = this.s.forecast?.day === this.ctx.clock.day ? this.s.forecast.moods : null
    this.s.forecast = undefined
    for (const b of this.s.owned) {
      const bt = bizType(b.type)
      if (!bt) continue
      b.mood = 1
      const r = bt.risk
      if (r.raidPerDay > 0 || r.inspectPerDay) {
        const pRaid = r.raidPerDay + (r.raidPerStar ?? 0) * this.ctx.law.stars
        const x = Math.random()
        if (x < pRaid) { this.applyEvent(b, 'raid'); continue }
        if (x < pRaid + (r.inspectPerDay ?? 0)) { this.applyEvent(b, 'inspection'); continue }
      }
      const m = fc && b.id in fc ? fc[b.id] : this.rollMood()
      if (m) this.applyEvent(b, m)
    }
  }

  /** 施加一次事件（每日掷骰或调试 forceEvent） */
  private applyEvent(b: OwnedBiz, kind: BizEventKind): number {
    const bt = bizType(b.type)!
    const tier = bt.tiers[b.tier - 1]
    const where = this.poiName(b.poi)
    let delta = 0, msg = ''
    switch (kind) {
      case 'raid': {
        const k = b.manager ? 0.5 : 1
        const tillLoss = round2(b.till * (bt.risk.lossPct || 0.5) * k)
        const cashLoss = round2(Math.min(Math.max(0, this.ctx.player.money), tier.perDay * k))
        b.till = round2(b.till - tillLoss)
        if (cashLoss > 0) spend(this.ctx, cashLoss, 'bizRaid')
        delta = -round2(tillLoss + cashLoss)
        // 记一笔热度（小额：攒够 1 星才出警）
        if (this.ctx.role.systems.wanted) this.ctx.law.addCrime(0.5, this.ctx.time, 1)
        msg = t('{name}（{where}）遭对头突袭！钱柜 −{till}，现金 −{cash}', { name: bt.name, where, till: usd(tillLoss), cash: usd(cashLoss) }) + (b.manager ? t('（经理挡下一半）') : '')
        break
      }
      case 'inspection':
        b.mood = 0
        msg = t('{name}（{where}）被警察查封，今天停业', { name: bt.name, where })
        break
      case 'boom':
        b.mood = MOOD_EVENTS.boom.mul
        msg = t('{name}（{where}）生意景气，今天收入 ×{n}', { name: bt.name, where, n: MOOD_EVENTS.boom.mul })
        break
      case 'slump':
        b.mood = MOOD_EVENTS.slump.mul
        msg = t('{name}（{where}）生意低迷，今天收入 ×{n}', { name: bt.name, where, n: MOOD_EVENTS.slump.mul })
        break
    }
    this.addLog(msg)
    this.host.toast(msg, 4)
    this.ctx.events.emit('bizEvent', { biz: b.id, kind, delta })
    return delta
  }

  private addLog(msg: string) {
    const c = this.ctx.clock
    this.s.log.unshift(t('第{day}天 {time} {msg}', { day: c.day, time: c.hhmm, msg }))
    if (this.s.log.length > LOG_MAX) this.s.log.length = LOG_MAX
  }

  private poiName(id: string) { return this.ctx.pois.byId(id)?.name ?? id }
  private byId(id: string) { return this.s.owned.find((b) => b.id === id) ?? null }
  private atPoi(poiId: string) { return this.s.owned.find((b) => b.poi === poiId) ?? null }
  private count(type: string) { return this.s.owned.filter((b) => b.type === type).length }

  // ---------- 操作 ----------
  /** 可否买下：true 或原因 */
  canBuy(typeId: string, poiId: string): true | string {
    const bt = bizType(typeId)
    if (!bt) return t('没有这种产业')
    if (!bt.roles.includes(this.role)) return t('{role}不能经营{name}', { role: this.ctx.role.title, name: bt.name })
    const poi = this.ctx.pois.byId(poiId)
    if (!poi || poi.type !== bt.poiType) return t('{name}只能开在{place}', { name: bt.name, place: POI_LABEL[bt.poiType] })
    const lv = unlockLevel(this.role, bt.id)
    if (this.level < lv) return t('Lv{lv} 解锁{name}', { lv, name: bt.name })
    if (this.atPoi(poiId)) return t('这里已经有你的产业了')
    if (this.count(bt.id) >= bt.maxOwned) return t('{name}最多 {n} 处', { name: bt.name, n: bt.maxOwned })
    if (this.ctx.player.money < bt.tiers[0].cost) return t('钱不够（要 {n}）', { n: usd(bt.tiers[0].cost) })
    return true
  }

  buy(typeId: string, poiId: string): true | string {
    const ok = this.canBuy(typeId, poiId)
    if (ok !== true) return ok
    const bt = bizType(typeId)!
    const cost = bt.tiers[0].cost
    if (!spend(this.ctx, cost, `biz:${bt.id}`)) return t('钱不够')
    const b: OwnedBiz = { id: `${bt.id}@${poiId}`, type: bt.id, poi: poiId, tier: 1, till: 0, manager: false, lastHour: this.ctx.clock.absHours, mood: 1, invested: cost }
    this.s.owned.push(b)
    if (bt.risk.heatOnBuy && this.ctx.role.systems.wanted) this.ctx.law.addCrime(bt.risk.heatOnBuy, this.ctx.time, 1)
    const msg = t('买下{name}（{where}）−{cost}', { name: bt.name, where: this.poiName(poiId), cost: usd(cost) })
    this.addLog(msg)
    this.host.toast(msg + t(' · 每天 {n}', { n: usd(bt.tiers[0].perDay) }), 3)
    this.ctx.events.emit('purchased', { kind: 'biz', id: b.id, cost })
    return true
  }

  upgrade(id: string): true | string {
    const b = this.byId(id)
    if (!b) return t('没有这个产业')
    const bt = bizType(b.type)!
    const next = bt.tiers[b.tier]
    if (!next) return t('已经是最高档')
    if (!spend(this.ctx, next.cost, `bizTier:${bt.id}`)) return t('钱不够（要 {n}）', { n: usd(next.cost) })
    this.accrue(this.ctx.clock.absHours)
    b.tier++
    b.invested = (b.invested ?? 0) + next.cost
    const msg = t('{name}（{where}）升级到 {tier} −{cost}', { name: bt.name, where: this.poiName(b.poi), tier: tierName(bt, b.tier), cost: usd(next.cost) })
    this.addLog(msg)
    this.host.toast(msg + t(' · 每天 {n}', { n: usd(next.perDay) }), 3)
    this.ctx.events.emit('purchased', { kind: 'bizTier', id: b.id, cost: next.cost })
    return true
  }

  hire(id: string): true | string {
    const b = this.byId(id)
    if (!b) return t('没有这个产业')
    if (b.manager) return t('已经有经理了')
    const bt = bizType(b.type)!
    if (!spend(this.ctx, bt.manager.cost, `manager:${bt.id}`)) return t('钱不够（要 {n}）', { n: usd(bt.manager.cost) })
    this.accrue(this.ctx.clock.absHours)
    b.manager = true
    b.invested = (b.invested ?? 0) + bt.manager.cost
    const msg = t('{name}（{where}）雇了经理 −{cost}', { name: bt.name, where: this.poiName(b.poi), cost: usd(bt.manager.cost) })
    this.addLog(msg)
    this.host.toast(msg + t(' · 每小时自动入账 {n}%', { n: Math.round(bt.manager.cut * 100) }), 3)
    this.ctx.events.emit('purchased', { kind: 'manager', id: b.id, cost: bt.manager.cost })
    return true
  }

  /** 亲自收钱：钱柜 ×1.1 入账；返回入账金额（0 = 没钱可收） */
  collect(id: string): number {
    const b = this.byId(id)
    if (!b) return 0
    this.accrue(this.ctx.clock.absHours)
    if (b.till <= 0) return 0
    const amount = round2(b.till * COLLECT_BONUS)
    b.till = 0
    this.income(b, amount, false)
    this.host.toast(t('收钱 +{n}（亲自收 +10%）', { n: usd(amount) }), 2.5)
    return amount
  }

  /** 黑帮被捕 / 死亡：所有黑帮产业钱柜清零；返回损失（P8.4 在 Game 接） */
  onBustOrDeath(): number {
    let lost = 0
    for (const b of this.s.owned) {
      const bt = bizType(b.type)
      if (!bt?.roles.includes('gang') || b.till <= 0) continue
      lost += b.till; b.till = 0
    }
    lost = round2(lost)
    if (lost > 0) { const msg = t('出事了，各处钱柜被人卷走 −{n}', { n: usd(lost) }); this.addLog(msg); this.host.toast(msg, 4) }
    return lost
  }

  // ---------- POI 面板 ----------
  poiButtons(poi: Poi): PanelButton[] {
    const done = (r: true | string | number) => {
      if (typeof r === 'string') this.host.toast(r, 2.5)
      else if (r === 0) this.host.toast(t('钱柜是空的'), 2)
      this.host.refresh?.()
    }
    const own = this.atPoi(poi.id)
    if (own) {
      const bt = bizType(own.type)!
      const tier = bt.tiers[own.tier - 1]
      this.accrue(this.ctx.clock.absHours)
      const out: PanelButton[] = [
        { label: t('收钱 {n}', { n: usd(own.till) }), note: t('{name} {tier} · 钱柜 {till}/{cap} · 亲自收 +10%', { name: bt.name, tier: tierName(bt, own.tier), till: usd(own.till), cap: usd(tier.cap) }), disabled: own.till <= 0, onClick: () => done(this.collect(own.id)) },
      ]
      const next = bt.tiers[own.tier]
      if (next) out.push({ label: t('升级到 {tier} {cost}', { tier: tierName(bt, own.tier + 1), cost: usd(next.cost) }), note: t('每天 {a} → {b}', { a: usd(tier.perDay), b: usd(next.perDay) }), disabled: this.ctx.player.money < next.cost, onClick: () => done(this.upgrade(own.id)) })
      if (!own.manager) out.push({ label: t('雇经理 {cost}', { cost: usd(bt.manager.cost) }), note: t('每小时自动入账 {n}%，突袭损失减半', { n: Math.round(bt.manager.cut * 100) }), disabled: this.ctx.player.money < bt.manager.cost, onClick: () => done(this.hire(own.id)) })
      return out
    }
    const out: PanelButton[] = []
    for (const bt of bizTypesFor(this.role)) {
      if (bt.poiType !== poi.type) continue
      const lv = unlockLevel(this.role, bt.id)
      const cost = bt.tiers[0].cost
      if (this.level < lv) { out.push({ label: t('Lv{lv} 解锁 {name}', { lv, name: bt.name }), note: usd(cost) + t(' · 每天 {n}', { n: usd(bt.tiers[0].perDay) }), disabled: true, onClick: () => {} }); continue }
      if (this.count(bt.id) >= bt.maxOwned) { out.push({ label: t('{name}已达上限 {n} 处', { name: bt.name, n: bt.maxOwned }), disabled: true, onClick: () => {} }); continue }
      out.push({ label: t('买下 {name} {cost}', { name: bt.name, cost: usd(cost) }), note: t('每天 {n}', { n: usd(bt.tiers[0].perDay) }) + ` · ${bt.desc}`, disabled: this.ctx.player.money < cost, onClick: () => done(this.buy(bt.id, poi.id)) })
    }
    return out
  }

  // ---------- 手机「生意」 ----------
  view(): AppView {
    const day = this.ctx.clock.day
    const today = this.s.today?.day === day ? this.s.today.income : 0
    const owned = this.s.owned
    let daily = 0, till = 0
    const items: AppItem[] = owned.map((b) => {
      const bt = bizType(b.type)!
      const tier = bt.tiers[b.tier - 1]
      const per = tier.perDay * b.mood
      daily += per; till += b.till
      const poi = this.ctx.pois.byId(b.poi)
      const status = b.mood === 0 ? t('查封停业中') : b.mood > 1 ? t('景气 ×{n}', { n: b.mood }) : b.mood < 1 ? t('低迷 ×{n}', { n: b.mood }) : t('正常营业')
      return {
        title: `${bt.name} ${tierName(bt, b.tier)}`,
        desc: `${poi?.name ?? b.poi}` + t(' · 每天 {n}', { n: usd(per) }) + ' · ' + (b.manager ? t('经理自动入账 80%') : t('无经理，去门口收钱 +10%')),
        value: t('钱柜 {till}/{cap}', { till: usd(b.till), cap: usd(tier.cap) }),
        status,
        tone: 'owned' as const,
        actions: poi ? [{ label: this.navTarget && this.navTarget.x === poi.door.x && this.navTarget.z === poi.door.z ? t('导航中') : t('导航'), onClick: () => { this.navTarget = { x: poi.door.x, z: poi.door.z }; this.host.toast(t('导航到 {name}', { name: poi.name }), 2) } }] : [],
      }
    })
    const lines = [t('今日入账 {today} · 每日收入 {daily} · 钱柜合计 {till}', { today: usd(today), daily: usd(daily), till: usd(till) }), t('产业 {n} 个 · 估值 {v}', { n: owned.length, v: usd(this.value()) })]
    const shop: AppItem[] = bizTypesFor(this.role).map((bt) => {
      const lv = unlockLevel(this.role, bt.id)
      const locked = this.level < lv
      const n = this.count(bt.id)
      return {
        title: bt.name,
        desc: t('去{place}门口买下 · 每天 {n} 起 · 已有 {own}/{max}', { place: POI_LABEL[bt.poiType], n: usd(bt.tiers[0].perDay), own: n, max: bt.maxOwned }),
        value: usd(bt.tiers[0].cost),
        status: locked ? t('需要 Lv{lv}', { lv }) : undefined,
        tone: locked ? 'locked' as const : undefined,
      }
    })
    const fc = this.s.forecast
    if (this.host.hasBloomberg?.()) {
      if (fc && fc.day === day + 1) {
        const ev = owned.filter((b) => fc.moods[b.id]).map((b) => t('{name}（{where}）', { name: bizType(b.type)!.name, where: this.poiName(b.poi) }) + (fc.moods[b.id] === 'boom' ? t('景气 ×{n}', { n: MOOD_EVENTS.boom.mul }) : t('低迷 ×{n}', { n: MOOD_EVENTS.slump.mul })))
        lines.push(t('彭博终端 · 明日预告：{list}', { list: ev.length ? ev.join(t('；')) : t('市场平稳') }))
      } else lines.push(t('彭博终端 · 每天 {h}:00 预告次日景气 / 低迷', { h: FORECAST_HOUR }))
    }
    const v: AppView = { lines, sections: [], log: this.s.log.slice() }
    if (items.length) v.sections!.push({ title: t('我的产业'), items })
    else {
      const first = bizTypesFor(this.role).find((bt) => this.level >= unlockLevel(this.role, bt.id))
      v.empty = first ? t('还没有产业。去任意{place}门口按 E，买下「{name}」（{cost}），每小时自动进账。', { place: POI_LABEL[first.poiType], name: first.name, cost: usd(first.tiers[0].cost) }) : t('还没有可买的产业。')
    }
    v.sections!.push({ title: t('可经营的产业'), items: shop })
    return v
  }

  // ---------- 存档 ----------
  serialize(): BizSave { return JSON.parse(JSON.stringify(this.s)) as BizSave }
  restore(s?: BizSave) {
    const b = empty()
    this.navTarget = null
    if (!s) { this.s = b; return }
    const now = this.ctx.clock.absHours
    const owned: OwnedBiz[] = []
    for (const o of s.owned ?? []) {
      const bt = bizType(o.type)
      if (!bt || owned.some((x) => x.poi === o.poi)) continue
      const tier = Math.max(1, Math.min(bt.tiers.length, Math.floor(o.tier || 1)))
      owned.push({
        id: o.id || `${bt.id}@${o.poi}`, type: bt.id, poi: o.poi, tier,
        till: round2(Math.max(0, Math.min(bt.tiers[tier - 1].cap, o.till || 0))),
        manager: !!o.manager,
        lastHour: Number.isFinite(o.lastHour) ? Math.min(o.lastHour, now) : now,
        mood: Number.isFinite(o.mood) ? o.mood : 1,
        invested: o.invested ?? sumCost(bt, tier) + (o.manager ? bt.manager.cost : 0),
      })
    }
    this.s = { owned, riskDay: Number.isFinite(s.riskDay) ? s.riskDay : -1, log: [...(s.log ?? [])].slice(0, LOG_MAX), today: s.today ? { ...s.today } : b.today, forecast: s.forecast ? { day: s.forecast.day, moods: { ...s.forecast.moods } } : undefined }
    // 读档补算：钱柜按 cap 封顶，不会爆表
    this.accrue(now)
  }

  list(): readonly OwnedBiz[] { return this.s.owned }
  value() { return round2(this.s.owned.reduce((a, b) => a + (b.invested ?? 0), 0) * BIZ_RESALE) }
  /** 已拥有产业的位置（小地图金圈） */
  points(): P2[] {
    const out: P2[] = []
    for (const b of this.s.owned) { const p = this.ctx.pois.byId(b.poi); if (p) out.push({ x: p.x, z: p.z }) }
    return out
  }

  /** window.__game.biz 调试钩子 */
  debugApi() {
    const self = this
    return {
      get types() { return BIZ_TYPES },
      get list() {
        return self.s.owned.map((b) => { const bt = bizType(b.type)!; const tier = bt.tiers[b.tier - 1]; return { ...b, name: bt.name, perDay: tier.perDay, cap: tier.cap } })
      },
      get log() { return self.s.log.slice() },
      get today() { return self.s.today?.day === self.ctx.clock.day ? self.s.today.income : 0 },
      get forecast() { return self.s.forecast ? { day: self.s.forecast.day, moods: { ...self.s.forecast.moods } } : null },
      get value() { return self.value() },
      get navTarget() { return self.navTarget },
      buy: (type: string, poi: string) => self.buy(type, poi),
      upgrade: (id: string) => self.upgrade(id),
      hire: (id: string) => self.hire(id),
      collect: (id: string) => self.collect(id),
      /** 推进游戏时钟 h 小时并立即结算累积 / 07:00 风险 */
      advanceHours(h: number) { self.ctx.clock.skip(h); self.ctx.needs.sync(); self.update(0); return this.list },
      forceEvent(id: string, kind: BizEventKind) { const b = self.byId(id); return b ? self.applyEvent(b, kind) : null },
      onBustOrDeath: () => self.onBustOrDeath(),
      nav(id: string) { const b = self.byId(id); const p = b && self.ctx.pois.byId(b.poi); self.navTarget = p ? { x: p.door.x, z: p.door.z } : null; return self.navTarget },
    }
  }
}
