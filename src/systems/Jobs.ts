import type { Ctx } from '../core/Context'
import type { RoleId } from '../data/roles'
import type { P2 } from '../world/RoadGraph'
import type { Poi } from './Poi'
import type { PanelButton } from '../ui/Panels'
import type { Pedestrians, Ped } from '../entities/Pedestrians'
import type { Vehicle } from '../entities/Vehicle'
import { Marker } from '../world/Marker'
import { JOB_TEXT, JOB_PARAMS, ASSETS, type AssetId, type JobText } from '../data/jobs'
import { ECONOMY } from '../data/menus'
import { rand, pick } from '../config'

/**
 * 工作系统：按身份提供可开工/下班的工作（的士、外卖、偷车、收保护费、赶会议…）
 * 与被动工作（打卡、工地、投资、加班：只在工作页显示状态/在 POI 面板加按钮）。
 * 目标点用 Marker 光柱（黄 = 去取/接，蓝 = 送达），并通过 targetPoint 交给小地图。
 */
export interface Job {
  id: string
  title: string
  roles: RoleId[]
  desc: string
  /** 被动工作：没有开始/下班，只显示状态、给 POI 面板加按钮 */
  passive?: boolean
  /** true 可开始；字符串为不可用原因 */
  available(ctx: Ctx): boolean | string
  start(ctx: Ctx): void
  update(dt: number, ctx: Ctx): void
  stop(ctx: Ctx): void
  hudText(): string | null
  readonly active: boolean
  /** 工作页状态行 */
  status?(ctx: Ctx): string
  /** 剩余秒数（HUD 大字；负数 = 已超时） */
  timeLeft?(): number | null
  /** 当前目标点（小地图） */
  target?(): P2 | null
  /** POI 面板的额外按钮 */
  poiButtons?(poi: Poi): PanelButton[]
  /** F 键优先处理（的士上客）；返回 true 表示已消费 */
  keyF?(ctx: Ctx): boolean
}

export interface JobStats {
  day: number
  todayIncome: number
  taxiTrips: number
  taxiRatingSum: number
  lastShiftDay: number
  invest: Record<AssetId, number>
  investDay: number
  investChange: Record<AssetId, number>
  /** 各工作完成（收款）次数 */
  done: Record<string, number>
}
export interface JobsSave { stats: JobStats }

export interface JobView {
  id: string; title: string; desc: string; passive: boolean; active: boolean
  /** 不可用原因（null = 可开始） */
  reason: string | null
  status: string | null
}
export interface JobsView {
  jobs: JobView[]
  activeId: string | null
  todayIncome: number
  taxiTrips: number
  taxiRating: number | null
  invest: { total: number; assets: { id: AssetId; name: string; desc: string; value: number; change: number }[] } | null
}

export interface TaxiTrip { dist: number; wait: number; peak: boolean; rating: number; fare: number }

const round2 = (n: number) => Math.round(n * 100) / 100
const dist2 = (a: P2, b: P2) => Math.hypot(a.x - b.x, a.z - b.z)
const defaultStats = (): JobStats => ({
  day: 0, todayIncome: 0, taxiTrips: 0, taxiRatingSum: 0, lastShiftDay: -1,
  invest: { fixed: 0, index: 0, crypto: 0 }, investDay: -1, investChange: { fixed: 0, index: 0, crypto: 0 }, done: {},
})

/** 的士计价：起步 $4.40 含 1 km，之后每 400 m $0.26；等候每 45 s $0.26；高峰 ×1.25；评分 ≥4 小费 10% */
export function taxiFare(distM: number, waitSec: number, peak: boolean, rating: number) {
  const T = JOB_PARAMS.taxi
  let fare = T.base + Math.ceil(Math.max(0, distM - T.baseKm) / T.unitM) * T.unitFare + Math.floor(waitSec / T.waitSec) * T.waitFare
  if (peak) fare *= T.peakMul
  if (rating >= T.tipRating) fare *= 1 + T.tip
  return round2(fare)
}
export function isTaxiPeak(hour: number) { return JOB_PARAMS.taxi.peaks.some(([a, b]) => hour >= a && hour < b) }

abstract class BaseJob implements Job {
  id: string; title: string; roles: RoleId[]; desc: string
  passive = false
  active = false
  constructor(protected J: Jobs, id: string) {
    const t = JOB_TEXT.find((x) => x.id === id) as JobText
    this.id = t.id; this.title = t.title; this.roles = t.roles; this.desc = t.desc
  }
  available(_ctx: Ctx): boolean | string { return true }
  start(ctx: Ctx) { this.active = true; this.begin(ctx) }
  stop(ctx: Ctx) { if (!this.active) return; this.active = false; this.end(ctx); this.J.notifyStopped(this) }
  update(_dt: number, _ctx: Ctx) {}
  hudText(): string | null { return null }
  protected begin(_ctx: Ctx) {}
  protected end(_ctx: Ctx) {}
  /** 完成并结束 */
  protected finish(ctx: Ctx, amount: number, msg: string) { this.J.earn(this.id, amount, msg); this.stop(ctx) }
  protected fail(ctx: Ctx, reason: string) { this.J.toast(`${this.title}失败：${reason}`, 3); this.stop(ctx) }
  protected pdist(ctx: Ctx, p: P2) { return Math.round(Math.hypot(ctx.player.worldX - p.x, ctx.player.worldZ - p.z)) }
}

// ---------- 黑帮 ----------
class GangSteal extends BaseJob {
  private car: Vehicle | null = null
  private fence: Poi | null = null
  private timer = 0
  private phase: 'find' | 'deliver' = 'find'
  constructor(J: Jobs) { super(J, 'gang_steal') }
  available(ctx: Ctx) { return ctx.pois.byType('shop').length + ctx.pois.byType('landmark').length > 0 ? true : '没有销赃点' }
  protected begin(ctx: Ctx) {
    this.timer = JOB_PARAMS.steal.timeLimit; this.phase = 'find'; this.car = null
    this.fence = pick([...ctx.pois.byType('shop'), ...ctx.pois.byType('landmark')])
    this.pickTarget(ctx)
    this.J.toast(this.car ? '目标车已标记（蓝柱），抢到后开去销赃点' : '附近没有合适的车，等一下…', 3)
  }
  private pickTarget(ctx: Ctx) {
    const px = ctx.player.worldX, pz = ctx.player.worldZ
    const cars = ctx.vehicles.filter((v) => v.active && v.driver === 'traffic' && !v.wrecked && v.kind === 'civil')
    const inRange = cars.filter((v) => { const d = Math.hypot(v.x - px, v.z - pz); return d >= JOB_PARAMS.steal.pickMin && d <= JOB_PARAMS.steal.pickMax })
    this.car = inRange.length ? pick(inRange) : cars.length ? pick(cars) : null
  }
  update(dt: number, ctx: Ctx) {
    this.timer -= dt
    if (this.timer <= 0) { this.fail(ctx, '超时'); return }
    const t = this.car
    if (this.phase === 'find') {
      if (!t || !t.active || t.wrecked || (t.driver !== 'traffic' && ctx.player.vehicle !== t)) { this.pickTarget(ctx); this.J.blue.set(this.car); return }
      this.J.blue.set(t)
      if (ctx.player.vehicle === t) { this.phase = 'deliver'; this.J.blue.set(this.fence!.door); this.J.toast(`开到销赃点：${this.fence!.name}`, 3) }
      return
    }
    if (!t || !t.active || t.wrecked) { this.fail(ctx, '车报废了'); return }
    if (ctx.player.vehicle === t && dist2(t, this.fence!.door) < JOB_PARAMS.steal.deliverRadius && t.absSpeed < 2) {
      const bonus = Math.round(Math.max(0, t.health))
      ctx.player.exit(ctx.world); t.deactivate()
      this.finish(ctx, JOB_PARAMS.steal.reward + bonus, `交货成功 +$${JOB_PARAMS.steal.reward} · 车况加成 +$${bonus}`)
    }
  }
  hudText() {
    const t = this.car
    if (this.phase === 'find') return t ? `抢蓝柱标记的车（${this.pdist(this.J.ctx, t)} m）` : '寻找目标车…'
    return `开到 ${this.fence!.name}（${this.pdist(this.J.ctx, this.fence!.door)} m）`
  }
  timeLeft() { return this.timer }
  target() { return this.phase === 'find' ? (this.car && this.car.active ? { x: this.car.x, z: this.car.z } : null) : this.fence!.door }
  get targetCar() { return this.car }
}

class GangProtect extends BaseJob {
  private stores: Poi[] = []
  private idx = 0
  constructor(J: Jobs) { super(J, 'gang_protect') }
  available(ctx: Ctx) { return ctx.pois.byType('shop').length + ctx.pois.byType('hawker').length > 0 ? true : '附近没有店' }
  protected begin(ctx: Ctx) {
    const pool = [...ctx.pois.byType('shop'), ...ctx.pois.byType('hawker')].sort(() => Math.random() - 0.5)
    this.stores = []
    for (let i = 0; i < JOB_PARAMS.protect.stores; i++) this.stores.push(pool[i % pool.length])
    this.idx = 0
    this.J.yellow.set(this.stores[0].door)
    this.J.toast(`去 ${this.stores[0].name} 门口按 E 收钱`, 3)
  }
  get current() { return this.stores[this.idx] ?? null }
  poiButtons(poi: Poi): PanelButton[] {
    if (!this.active || poi !== this.current) return []
    return [{ label: '收保护费', note: `$${JOB_PARAMS.protect.min}–${JOB_PARAMS.protect.max}`, onClick: () => this.collect(this.J.ctx) }]
  }
  private collect(ctx: Ctx) {
    const amount = Math.round(rand(JOB_PARAMS.protect.min, JOB_PARAMS.protect.max))
    this.J.earn(this.id, amount, `收到 $${amount}（${this.idx + 1}/${this.stores.length}）`)
    if (Math.random() < JOB_PARAMS.protect.policeChance) { ctx.law.crime('carjack', JOB_PARAMS.protect.heat, ctx); this.J.toast('店家报警了！', 3) }
    this.idx++
    this.J.closePanel()
    if (this.idx >= this.stores.length) { this.J.toast('三家收齐，收工', 3); this.stop(ctx); return }
    this.J.yellow.set(this.current!.door)
  }
  hudText() { const s = this.current; return s ? `第 ${this.idx + 1}/${this.stores.length} 家：${s.name}（${this.pdist(this.J.ctx, s.door)} m）门口按 E` : null }
  target() { return this.current?.door ?? null }
}

class GangWreck extends BaseJob {
  private count = 0
  private timer = 0
  private phase: 'wreck' | 'escape' = 'wreck'
  constructor(J: Jobs) {
    super(J, 'gang_wreck')
    J.ctx.events.on('vehicleWrecked', ({ byPlayer }) => {
      if (!this.active || this.phase !== 'wreck' || !byPlayer) return
      this.count++
      J.toast(`撞毁 ${this.count}/${JOB_PARAMS.wreck.count}`)
    })
  }
  protected begin(_ctx: Ctx) { this.count = 0; this.timer = JOB_PARAMS.wreck.timeLimit; this.phase = 'wreck'; this.J.toast('开撞！先去找辆车', 3) }
  update(dt: number, ctx: Ctx) {
    if (this.phase === 'wreck') {
      this.timer -= dt
      if (this.timer <= 0) { this.fail(ctx, '超时'); return }
      if (this.count >= JOB_PARAMS.wreck.count) { this.phase = 'escape'; this.J.toast('够了！甩掉警察', 3) }
      return
    }
    if (ctx.law.pursuitLevel <= 0) this.finish(ctx, JOB_PARAMS.wreck.reward, `街头破坏完成 +$${JOB_PARAMS.wreck.reward}`)
  }
  hudText() { return this.phase === 'wreck' ? `已撞毁 ${this.count}/${JOB_PARAMS.wreck.count}` : `甩掉警察（热度 ${this.J.ctx.law.pursuitLevel.toFixed(1)}）` }
  timeLeft() { return this.phase === 'wreck' ? this.timer : null }
}

// ---------- 金领 ----------
class GoldMeeting extends BaseJob {
  private office: Poi | null = null
  private elapsed = 0
  private limit = 60
  constructor(J: Jobs) { super(J, 'gold_meeting') }
  available(ctx: Ctx) { return ctx.pois.byType('office').length ? true : '附近没有办公楼' }
  protected begin(ctx: Ctx) {
    const px = ctx.player.worldX, pz = ctx.player.worldZ
    const all = ctx.pois.byType('office')
    const far = all.filter((p) => Math.hypot(p.door.x - px, p.door.z - pz) > 60)
    this.office = pick(far.length ? far : all)
    const d = Math.hypot(this.office.door.x - px, this.office.door.z - pz)
    this.limit = Math.max(JOB_PARAMS.meeting.minSec, Math.round(d / 1000 * JOB_PARAMS.meeting.secPerKm))
    this.elapsed = 0
    this.J.blue.set(this.office.door)
    this.J.toast(`会议在 ${this.office.name}，${Math.round(d)} m，${this.limit} 秒内到`, 3)
  }
  update(dt: number, ctx: Ctx) {
    this.elapsed += dt
    const o = this.office!
    if (this.elapsed > this.limit * 2) { this.fail(ctx, '太晚了，会议取消'); return }
    if (this.pdist(ctx, o.door) < JOB_PARAMS.meeting.radius) {
      const late = this.elapsed > this.limit
      const pay = late ? JOB_PARAMS.meeting.reward / 2 : JOB_PARAMS.meeting.reward
      this.finish(ctx, pay, late ? `迟到了，只拿到 $${pay}` : `准时到会 +$${pay}`)
    }
  }
  hudText() { return `赶到 ${this.office!.name}（${this.pdist(this.J.ctx, this.office!.door)} m）` }
  timeLeft() { return this.limit - this.elapsed }
  target() { return this.office?.door ?? null }
}

class GoldInvest extends BaseJob {
  passive = true
  constructor(J: Jobs) { super(J, 'gold_invest') }
  update(_dt: number, ctx: Ctx) {
    const s = this.J.stats
    // 首次：07:00 前开局则当天 07:00 也要结算
    if (s.investDay < 0) { s.investDay = ctx.clock.hour >= 7 ? ctx.clock.day : ctx.clock.day - 1; return }
    if (ctx.clock.day > s.investDay && ctx.clock.hour >= 7) this.settle(ctx)
  }
  /** 每游戏日 07:00 结算一次（跳过多天只结一次） */
  private settle(ctx: Ctx) {
    const s = this.J.stats
    s.investDay = ctx.clock.day
    const parts: string[] = []
    for (const a of ASSETS) {
      const v = s.invest[a.id]
      if (v <= 0) { s.investChange[a.id] = 0; continue }
      const rate = a.min === a.max ? a.min : rand(a.min, a.max)
      const delta = round2(v * rate)
      s.invest[a.id] = round2(v + delta); s.investChange[a.id] = delta
      parts.push(`${a.name} ${delta >= 0 ? '+' : ''}${delta.toFixed(2)}`)
    }
    if (parts.length) this.J.toast(`投资结算：${parts.join(' · ')}`, 4)
  }
  status() { const s = this.J.stats; return `持仓 $${(s.invest.fixed + s.invest.index + s.invest.crypto).toFixed(2)}` }
  buy(ctx: Ctx, asset: AssetId, amount: number) {
    if (amount <= 0) return false
    if (ctx.player.money < amount) { this.J.toast('现金不够'); return false }
    ctx.player.money = round2(ctx.player.money - amount)
    this.J.stats.invest[asset] = round2(this.J.stats.invest[asset] + amount)
    ctx.events.emit('invested', { asset, amount })
    this.J.toast(`买入 ${ASSETS.find((a) => a.id === asset)!.name} $${amount}`)
    return true
  }
  sell(ctx: Ctx, asset: AssetId) {
    const v = this.J.stats.invest[asset]
    if (v <= 0) return false
    ctx.player.money = round2(ctx.player.money + v)
    this.J.stats.invest[asset] = 0; this.J.stats.investChange[asset] = 0
    this.J.toast(`卖出 ${ASSETS.find((a) => a.id === asset)!.name} 回款 $${v.toFixed(2)}`)
    return true
  }
}

// ---------- 白领 ----------
class WhiteShift extends BaseJob {
  passive = true
  constructor(J: Jobs) {
    super(J, 'white_shift')
    J.ctx.events.on('clockIn', ({ day }) => { J.stats.lastShiftDay = day })
  }
  status(ctx: Ctx) {
    const h = ctx.clock.hour, salary = ECONOMY.salary[ctx.role.id] ?? 0
    if (this.J.stats.lastShiftDay === ctx.clock.day) return '今天已打卡 · 明天 09:00 再来'
    if (h < 9) return `今天 09:00 可打卡 · 日薪 $${salary}`
    if (h < 9.5) return `现在去办公楼打卡 · 日薪 $${salary}`
    if (h < 12) return `迟到打卡（薪资减半 $${salary / 2}）· 12:00 前`
    return '今天已过打卡时间 · 明天 09:00'
  }
}

class WhiteOvertime extends BaseJob {
  passive = true
  constructor(J: Jobs) { super(J, 'white_overtime') }
  private open(ctx: Ctx) { const h = ctx.clock.hour; return h >= JOB_PARAMS.overtime.from && h < JOB_PARAMS.overtime.to }
  status(ctx: Ctx) { return this.open(ctx) ? '现在可到办公楼门口按 E 加班' : `${JOB_PARAMS.overtime.from}:00–${JOB_PARAMS.overtime.to}:00 办公楼门口按 E` }
  poiButtons(poi: Poi): PanelButton[] {
    const ctx = this.J.ctx
    if (poi.type !== 'office' || ctx.role.id !== 'white') return []
    const O = JOB_PARAMS.overtime
    return [{ label: `加班 ${O.hours} 小时`, note: `+$${O.pay} · 精力 −15 饱食 −10`, disabled: !this.open(ctx), onClick: () => {
      ctx.clock.skip(O.hours); ctx.needs.sync(); ctx.needs.add(-10, -15)
      this.J.earn(this.id, O.pay, `加班结束 +$${O.pay}`)
      this.J.closePanel()
    } }]
  }
}

// ---------- 蓝领 ----------
class BlueTaxi extends BaseJob {
  private taxi: Vehicle | null = null
  private passenger: Ped | null = null
  private dest: Poi | null = null
  private phase: 'hail' | 'ride' | 'wait' = 'wait'
  private odometer = 0
  private waitSec = 0
  private rating = 5
  private peak = false
  private lastX = 0; private lastZ = 0
  private stopTimer = 0
  private nextTimer = 0
  private awayTimer = 0
  lastTrip: TaxiTrip | null = null
  constructor(J: Jobs) {
    super(J, 'blue_taxi')
    const crash = (v: Vehicle, impulse: number) => {
      if (!this.active || this.phase !== 'ride' || v !== this.taxi || impulse <= JOB_PARAMS.taxi.crashImpulse) return
      this.rating = Math.max(1, this.rating - 1)
      J.toast(`乘客吓了一跳 · 本单评分 ${this.rating}`, 2)
    }
    J.ctx.events.on('vehicleHitVehicle', ({ a, b, impulse }) => crash(a.driver === 'player' ? a : b, impulse))
    J.ctx.events.on('vehicleHitStatic', ({ v, impulse }) => crash(v, impulse))
  }
  available(ctx: Ctx) { return ctx.player.vehicle?.kind === 'taxi' ? true : '需要先坐在的士里（的士站租车）' }
  protected begin(ctx: Ctx) {
    this.taxi = ctx.player.vehicle
    this.phase = 'wait'; this.nextTimer = 0
    this.J.toast('开工！等乘客招手（黄柱）', 3)
  }
  protected end(_ctx: Ctx) {
    if (this.passenger && this.passenger.state === 'hail') this.J.peds.unhail(this.passenger)
    this.passenger = null; this.dest = null; this.phase = 'wait'
  }
  /** 从 40–150 m 内的行人里挑一位招手；没有就在人行道上生成一位 */
  private findPassenger(ctx: Ctx) {
    const T = JOB_PARAMS.taxi
    const px = ctx.player.worldX, pz = ctx.player.worldZ
    const cands = this.J.peds.peds.filter((p) => { if (!p.active || p.state !== 'walk') return false; const d = Math.hypot(p.x - px, p.z - pz); return d >= T.hailMin && d <= T.hailMax })
    let p: Ped | null = cands.length ? pick(cands) : null
    if (!p) {
      const tmp = { x: 0, z: 0 }
      for (let k = 0; k < 40 && !p; k++) {
        const e = ctx.graph.randomEdgeNear(px, pz, T.hailMax, ['expressway', 'trunk'])
        if (!e) break
        if (e.length < 14) continue
        const t = rand(6, e.length - 6)
        ctx.graph.sidewalkPoint(e, t, tmp)
        const d = Math.hypot(tmp.x - px, tmp.z - pz)
        if (d < T.hailMin || d > T.hailMax) continue
        p = this.J.peds.spawnOnEdge(e, t, ctx)
      }
    }
    if (!p) { this.nextTimer = 1; return }
    this.J.peds.hail(p)
    this.passenger = p; this.phase = 'hail'
    this.J.yellow.set(p)
    this.J.toast('有人招手（黄柱），开过去 4 m 内按 F 上客', 3)
  }
  keyF(ctx: Ctx) {
    if (!this.active || this.phase !== 'hail' || !this.passenger || ctx.player.vehicle !== this.taxi) return false
    const t = this.taxi!, p = this.passenger
    if (Math.hypot(t.x - p.x, t.z - p.z) > JOB_PARAMS.taxi.pickupRadius) return false
    this.J.peds.board(p)
    this.passenger = null
    // 目的地：≥120 m 的随机 POI 门口；没有就取最远的
    const all = ctx.pois.all.filter((q) => dist2(q.door, t) >= 120)
    this.dest = all.length ? pick(all) : ctx.pois.all.slice().sort((a, b) => dist2(b.door, t) - dist2(a.door, t))[0] ?? null
    if (!this.dest) { this.J.toast('没有目的地可去'); this.phase = 'wait'; this.nextTimer = 2; return true }
    this.phase = 'ride'; this.odometer = 0; this.waitSec = 0; this.rating = 5; this.stopTimer = 0; this.awayTimer = 0
    this.peak = isTaxiPeak(ctx.clock.hour); this.lastX = t.x; this.lastZ = t.z
    this.J.yellow.set(null); this.J.blue.set(this.dest.door)
    this.J.toast(`乘客上车 → ${this.dest.name}（${Math.round(dist2(this.dest.door, t))} m）${this.peak ? ' · 高峰 ×1.25' : ''}`, 3)
    return true
  }
  update(dt: number, ctx: Ctx) {
    const t = this.taxi!
    if (t.wrecked || !t.active) { this.J.toast('的士报废，收工了', 3); this.stop(ctx); return }
    if (this.phase === 'wait') { this.nextTimer -= dt; if (this.nextTimer <= 0) this.findPassenger(ctx); return }
    if (this.phase === 'hail') {
      const p = this.passenger
      if (!p || !p.active || p.state !== 'hail') { this.J.toast('乘客走了，再找一位', 2); this.passenger = null; this.phase = 'wait'; this.nextTimer = 1; this.J.yellow.set(null); return }
      this.J.yellow.set(p)
      return
    }
    // ride
    this.odometer += Math.hypot(t.x - this.lastX, t.z - this.lastZ); this.lastX = t.x; this.lastZ = t.z
    if (ctx.player.vehicle !== t) { this.awayTimer += dt; if (this.awayTimer > 15) { this.J.toast('乘客等不及，跑了', 3); this.phase = 'wait'; this.nextTimer = 2; this.J.blue.set(null) } return }
    this.awayTimer = 0
    if (t.absSpeed < 1) this.waitSec += dt
    const d = this.dest!
    if (dist2(t, d.door) < JOB_PARAMS.taxi.arriveRadius && t.absSpeed < 0.6) this.stopTimer += dt; else this.stopTimer = 0
    if (this.stopTimer >= JOB_PARAMS.taxi.settleSec) {
      const fare = taxiFare(this.odometer, this.waitSec, this.peak, this.rating)
      this.lastTrip = { dist: Math.round(this.odometer), wait: Math.round(this.waitSec), peak: this.peak, rating: this.rating, fare }
      this.J.stats.taxiTrips++; this.J.stats.taxiRatingSum += this.rating
      this.J.earn(this.id, fare, `到达 ${d.name} · ${(this.odometer / 1000).toFixed(2)} km · 车资 $${fare.toFixed(2)}${this.rating >= JOB_PARAMS.taxi.tipRating ? '（含小费）' : ''}`)
      this.phase = 'wait'; this.nextTimer = 2; this.dest = null; this.J.blue.set(null)
    }
  }
  hudText() {
    if (this.phase === 'wait') return '等待下一位乘客…'
    if (this.phase === 'hail') return `乘客在 ${this.pdist(this.J.ctx, this.passenger!)} m 外招手 · 停到 4 m 内按 F`
    const d = this.dest!
    return `送到 ${d.name}（${this.pdist(this.J.ctx, d.door)} m）· 已行驶 ${(this.odometer / 1000).toFixed(2)} km · 停车 3 s 结算`
  }
  target() { return this.phase === 'hail' && this.passenger ? { x: this.passenger.x, z: this.passenger.z } : this.phase === 'ride' ? this.dest!.door : null }
  get state() { return { phase: this.phase, passenger: this.passenger ? { x: this.passenger.x, z: this.passenger.z, state: this.passenger.state } : null, dest: this.dest ? { id: this.dest.id, door: this.dest.door } : null, odometer: this.odometer, wait: this.waitSec, rating: this.rating, peak: this.peak } }
}

class BlueDelivery extends BaseJob {
  private hawker: Poi | null = null
  private dest: Poi | null = null
  private phase: 'pickup' | 'deliver' = 'pickup'
  private elapsed = 0
  private limit = 60
  private dist = 0
  constructor(J: Jobs) { super(J, 'blue_delivery') }
  available(ctx: Ctx) { return ctx.pois.byType('hawker').length && (ctx.pois.byType('home').length + ctx.pois.byType('office').length) ? true : '附近没有餐馆/收件地址' }
  protected begin(ctx: Ctx) {
    this.hawker = pick(ctx.pois.byType('hawker')); this.phase = 'pickup'; this.dest = null
    this.J.yellow.set(this.hawker.door)
    this.J.toast(`接单：去 ${this.hawker.name} 门口按 E 取餐`, 3)
  }
  poiButtons(poi: Poi): PanelButton[] {
    if (!this.active || this.phase !== 'pickup' || poi !== this.hawker) return []
    return [{ label: '取餐', note: '外卖单', onClick: () => this.pickup(this.J.ctx) }]
  }
  private pickup(ctx: Ctx) {
    const h = this.hawker!
    this.dest = pick([...ctx.pois.byType('home'), ...ctx.pois.byType('office')])
    this.dist = dist2(h.door, this.dest.door)
    this.limit = Math.max(JOB_PARAMS.delivery.minSec, Math.round(this.dist / 1000 * JOB_PARAMS.delivery.secPerKm))
    this.elapsed = 0; this.phase = 'deliver'
    this.J.yellow.set(null); this.J.blue.set(this.dest.door)
    this.J.closePanel()
    this.J.toast(`送到 ${this.dest.name}（${Math.round(this.dist)} m），${this.limit} 秒内`, 3)
  }
  update(dt: number, ctx: Ctx) {
    if (this.phase !== 'deliver') return
    this.elapsed += dt
    const d = this.dest!
    const v = ctx.player.vehicle
    if (this.pdist(ctx, d.door) < JOB_PARAMS.delivery.radius && (!v || v.absSpeed < 3)) {
      const late = this.elapsed > this.limit
      const pay = late ? JOB_PARAMS.delivery.late : round2(JOB_PARAMS.delivery.base + this.dist / 1000 * JOB_PARAMS.delivery.perKm)
      this.finish(ctx, pay, late ? `送达但超时，只拿到 $${pay}` : `送达 ${d.name} +$${pay.toFixed(2)}`)
    }
  }
  hudText() {
    if (this.phase === 'pickup') return `去 ${this.hawker!.name} 取餐（${this.pdist(this.J.ctx, this.hawker!.door)} m）门口按 E`
    return `送到 ${this.dest!.name}（${this.pdist(this.J.ctx, this.dest!.door)} m）`
  }
  timeLeft() { return this.phase === 'deliver' ? this.limit - this.elapsed : null }
  target() { return this.phase === 'pickup' ? this.hawker!.door : this.dest!.door }
}

class BlueSite extends BaseJob {
  passive = true
  constructor(J: Jobs) { super(J, 'blue_site') }
  status(ctx: Ctx) { return ctx.needs.energy < 15 ? '精力不足 15，先吃点东西' : `工地门口按 E · 每小时 $${ECONOMY.siteWage}` }
}

export class Jobs {
  all: Job[]
  active: Job | null = null
  stats: JobStats = defaultStats()
  blue = new Marker(0x3ea6ff)
  yellow = new Marker(0xffd33d)
  toast: (s: string, sec?: number) => void = () => {}
  closePanel: () => void = () => {}
  private readonly taxi: BlueTaxi
  private readonly invest: GoldInvest

  constructor(public ctx: Ctx, public peds: Pedestrians) {
    this.taxi = new BlueTaxi(this); this.invest = new GoldInvest(this)
    this.all = [new GangSteal(this), new GangProtect(this), new GangWreck(this), new GoldMeeting(this), this.invest, new WhiteShift(this), new WhiteOvertime(this), this.taxi, new BlueDelivery(this), new BlueSite(this)]
    ctx.scene.add(this.blue.group, this.yellow.group)
    this.stats.day = ctx.clock.day
  }

  /** 当前身份可见的工作 */
  get forRole() { return this.all.filter((j) => j.roles.includes(this.ctx.role.id)) }
  byId(id: string) { return this.all.find((j) => j.id === id) ?? null }

  /** 开始工作：true 成功；字符串为原因 */
  start(id: string): true | string {
    const j = this.byId(id)
    if (!j) return '没有这项工作'
    if (j.passive) return '这项工作直接去地点按 E'
    if (!j.roles.includes(this.ctx.role.id)) return '身份不符'
    const a = j.available(this.ctx)
    if (a !== true) return a === false ? '现在不能开始' : a
    if (this.active) this.active.stop(this.ctx)
    this.active = j
    j.start(this.ctx)
    return true
  }
  stop() {
    const j = this.active; if (!j) return
    this.active = null
    j.stop(this.ctx)
    this.clearMarkers()
    this.toast(`${j.title}：下班`, 2)
  }
  /** 测试/调试：抢车目标 */
  get stealTarget() { const j = this.byId('gang_steal') as GangSteal; const c = j.targetCar; return c && c.active ? { x: c.x, z: c.z, driver: c.driver } : null }
  clearMarkers() { this.blue.set(null); this.yellow.set(null) }
  /** 工作自行结束（完成/失败）时回调 */
  notifyStopped(j: Job) { if (this.active === j) this.active = null; this.clearMarkers() }

  /** 结算一笔收入：加钱、今日收入、完成计数、jobDone 事件 */
  earn(job: string, amount: number, msg?: string) {
    const pl = this.ctx.player
    pl.money = round2(pl.money + amount)
    this.stats.todayIncome = round2(this.stats.todayIncome + amount)
    this.stats.done[job] = (this.stats.done[job] ?? 0) + 1
    this.ctx.events.emit('jobDone', { job, amount })
    if (msg) this.toast(msg, 3)
  }

  update(dt: number, ctx: Ctx) {
    if (ctx.clock.day !== this.stats.day) { this.stats.day = ctx.clock.day; this.stats.todayIncome = 0 }
    for (const j of this.all) if (j.passive && j.roles.includes(ctx.role.id)) j.update(dt, ctx)
    const a = this.active
    if (a) {
      a.update(dt, ctx)
      if (!a.active) { this.active = null; this.clearMarkers() }
    }
  }
  sync(t: number) { this.blue.sync(t); this.yellow.sync(t) }

  /** F 键：的士上客优先于上下车 */
  keyF(ctx: Ctx) { return this.active?.keyF?.(ctx) ?? false }
  /** POI 面板的工作相关按钮 */
  poiButtons(poi: Poi): PanelButton[] {
    const out: PanelButton[] = []
    for (const j of this.all) if ((j.passive || j === this.active) && j.roles.includes(this.ctx.role.id)) out.push(...(j.poiButtons?.(poi) ?? []))
    return out
  }
  onPlayerDown() { if (this.active) { const j = this.active; this.active = null; j.stop(this.ctx); this.clearMarkers(); this.toast(`${j.title}中断：你倒下了`, 3) } }

  hudText(): string | null { return this.active?.hudText() ?? null }
  hudCard(): { title: string; desc: string; timer: string } | null {
    const a = this.active; if (!a) return null
    const t = a.timeLeft?.() ?? null
    return { title: a.title, desc: a.hudText() ?? '', timer: t === null ? '' : t >= 0 ? `${Math.ceil(t)}s` : `迟到 ${Math.ceil(-t)}s` }
  }
  /** 小地图目标点 */
  get targetPoint(): P2 | null { return this.active?.target?.() ?? this.blue.point ?? this.yellow.point }
  get taxiRating() { return this.stats.taxiTrips ? this.stats.taxiRatingSum / this.stats.taxiTrips : null }
  get lastTrip() { return this.taxi.lastTrip }
  get taxiState() { return this.taxi.state }

  // ---------- 投资 ----------
  buy(asset: AssetId, amount: number) { return this.invest.buy(this.ctx, asset, amount) }
  sell(asset: AssetId) { return this.invest.sell(this.ctx, asset) }

  /** 手机工作页视图 */
  view(): JobsView {
    const ctx = this.ctx
    const jobs = this.forRole.map((j) => {
      const a = j.passive ? true : j.available(ctx)
      return { id: j.id, title: j.title, desc: j.desc, passive: !!j.passive, active: j === this.active, reason: a === true ? null : a === false ? '现在不能开始' : a, status: j.status?.(ctx) ?? null }
    })
    const s = this.stats
    const invest = ctx.role.id === 'gold' ? { total: round2(s.invest.fixed + s.invest.index + s.invest.crypto), assets: ASSETS.map((a) => ({ id: a.id, name: a.name, desc: a.desc, value: s.invest[a.id], change: s.investChange[a.id] })) } : null
    return { jobs, activeId: this.active?.id ?? null, todayIncome: s.todayIncome, taxiTrips: s.taxiTrips, taxiRating: this.taxiRating, invest }
  }

  serialize(): JobsSave { return { stats: JSON.parse(JSON.stringify(this.stats)) as JobStats } }
  restore(d: JobsSave | undefined) {
    if (!d?.stats) return
    const base = defaultStats()
    this.stats = { ...base, ...d.stats, invest: { ...base.invest, ...(d.stats.invest ?? {}) }, investChange: { ...base.investChange, ...(d.stats.investChange ?? {}) }, done: { ...(d.stats.done ?? {}) } }
  }
}
