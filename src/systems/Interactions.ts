import type { Ctx } from '../core/Context'
import type { Vehicle } from '../entities/Vehicle'
import type { Panels, PanelSpec, PanelButton } from '../ui/Panels'
import { HAWKER_MENU, SHOP_MENU, ECONOMY, type MenuItem } from '../data/menus'
import { POI_LABEL, type Poi } from './Poi'
import type { Jobs } from './Jobs'
import type { RestBonus } from './Assets'
import { spend, earn, charge } from './Wallet'
import { venueOf, venueOpen, hoursText } from '../data/venues'

export const INTERACT_DIST = 3.5

/** Game 提供给交互系统的回调 */
export interface InteractionHost {
  toast(s: string, sec?: number): void
  closePanel(): void
  teleport(x: number, z: number, yaw: number): void
  save(): void
  parkTaxi(x: number, z: number, yaw: number): Vehicle | null
  /** 打开衣柜（换装）；返回 false 表示不可用（盒子人模式） */
  wardrobe(): boolean
  /** 这个住家 POI 是否归玩家（身份自带的家，或买下的房产） */
  ownsHome(poiId: string): boolean
  /** 在这个住家睡觉的加成；null = 按原数值（饱食 −20） */
  restBonus(poiId: string): RestBonus | null
}
/** 按钮提供者：给某个 POI 面板追加按钮（工作 / 资产 / 产业…） */
export type ButtonProvider = (poi: Poi) => PanelButton[]

const money = (n: number) => `$${n.toFixed(2)}`
/** 场馆面板「即将开放」占位（有 provider 按钮时自动移除） */
const VENUE_PLACEHOLDER: PanelButton = { label: '即将开放', note: '敬请期待', disabled: true, onClick: () => {} }

/** POI 交互：靠近提示、E 打开面板、各类地点的行为（吃饭/坐地铁/睡觉/上班/搬运/租的士） */
export class Interactions {
  /** 当前可交互的 POI（玩家步行且门口 3.5 m 内） */
  near: Poi | null = null
  current: Poi | null = null
  private taxiRentedDay = -1
  /** 工作系统（的士站「租车并开工」用）；它的面板按钮通过 addProvider 注册 */
  jobs: Jobs | null = null
  /** 面板按钮提供者（工作 / 资产 / 产业），按注册顺序插在「离开」之前 */
  private providers: ButtonProvider[] = []

  constructor(private ctx: Ctx, private panels: Panels, private host: InteractionHost) {}

  update() {
    const pl = this.ctx.player
    this.near = pl.inVehicle ? null : this.ctx.pois.nearest(pl.x, pl.z, INTERACT_DIST)
  }

  get hint() { return this.near ? `按 E 进入 ${this.near.name}` : null }

  /** 打开某个 POI 的面板（由 Game 在 state='panel' 时调用） */
  open(poi: Poi) {
    this.current = poi
    this.panels.show(this.build(poi))
  }
  /** 行为改变了数值后刷新面板 */
  private refresh() { if (this.current) this.panels.show(this.build(this.current)) }
  close() { this.current = null; this.host.closePanel() }
  /** 注册按钮提供者 */
  addProvider(fn: ButtonProvider) { this.providers.push(fn) }

  private build(poi: Poi): PanelSpec {
    const spec = this.buildBase(poi)
    let extra = this.providers.flatMap((fn) => fn(poi))
    const v = venueOf(poi)
    if (v) {
      // 场馆：打烊时只留 anyHour 按钮；有任何 provider 按钮就去掉「即将开放」占位
      if (!venueOpen(v, this.ctx.clock.hour)) extra = extra.filter((b) => b.anyHour)
      if (extra.length) spec.buttons = spec.buttons.filter((b) => b !== VENUE_PLACEHOLDER)
    }
    if (extra.length) spec.buttons.splice(Math.max(0, spec.buttons.length - 1), 0, ...extra)
    return spec
  }
  private buildBase(poi: Poi): PanelSpec {
    switch (poi.type) {
      case 'hawker': return this.menuPanel(poi, HAWKER_MENU, '吃一顿约 20 分钟')
      case 'shop': return this.menuPanel(poi, SHOP_MENU, '随买随吃，约 5 分钟')
      case 'mrt': return this.mrtPanel(poi)
      case 'home': return this.homePanel(poi)
      case 'office': return this.officePanel(poi)
      case 'site': return this.sitePanel(poi)
      case 'taxi': return this.taxiPanel(poi)
      case 'police': return this.info(poi, ['新加坡警察部队。', '交通罚单与扣分记录在这里查询；扣满 24 分吊销驾照一天。', `当前扣分 ${this.ctx.law.demerits}/24 · 累计罚款 $${this.ctx.law.fines}`])
      case 'hospital': return this.info(poi, ['倒下后会被送到这里醒来。', '血量会恢复，但账户里会扣掉一笔医药费。'])
      case 'casino': case 'club': case 'race': case 'arena': return this.venuePanel(poi)
      default: return this.info(poi, ['这里只是看看。'])
    }
  }

  private info(poi: Poi, lines: string[]): PanelSpec {
    return { title: poi.name, subtitle: POI_LABEL[poi.type], lines, buttons: [{ label: '离开', onClick: () => this.close() }] }
  }

  private status() {
    const n = this.ctx.needs
    return `现金 ${money(this.ctx.player.money)} · 饱食 ${Math.round(n.hunger)} · 精力 ${Math.round(n.energy)} · 心情 ${Math.round(n.mood)} · ${this.ctx.clock.hhmm}`
  }

  // ---------- 娱乐场馆（P10）：默认面板 = 简介 + 营业状态 + 占位；子系统用 addProvider 塞按钮 ----------
  private venuePanel(poi: Poi): PanelSpec {
    const v = venueOf(poi)
    if (!v) return this.info(poi, ['这里只是看看。'])
    const open = venueOpen(v, this.ctx.clock.hour)
    const lines = [v.desc, this.status()]
    if (!open) lines.push(`已打烊 · ${hoursText(v)}（现在 ${this.ctx.clock.hhmm}）`)
    return {
      title: poi.name, subtitle: `${POI_LABEL[poi.type]} · ${hoursText(v)} · ${open ? '营业中' : '已打烊'}`, lines,
      buttons: [...(open ? [VENUE_PLACEHOLDER] : []), { label: '离开', onClick: () => this.close() }],
    }
  }

  // ---------- 小贩中心 / 商店 ----------
  private menuPanel(poi: Poi, menu: MenuItem[], note: string): PanelSpec {
    const buttons: PanelButton[] = menu.map((m) => ({
      label: m.name,
      note: `${money(m.price)} · 饱食 +${m.hunger}${m.energy ? ` 精力 +${m.energy}` : ''}`,
      onClick: () => {
        if (!spend(this.ctx, m.price, `food:${m.name}`)) { this.host.toast('钱不够了'); return }
        this.ctx.clock.skip((poi.type === 'hawker' ? 20 : 5) / 60)
        this.ctx.needs.sync()
        this.ctx.needs.add(m.hunger, m.energy ?? 0)
        this.host.toast(`${m.name} 真不错 · 饱食 +${m.hunger}`)
        this.ctx.events.emit('ate', { poi })
        this.refresh()
      },
    }))
    buttons.push({ label: '离开', onClick: () => this.close() })
    return { title: poi.name, subtitle: `${POI_LABEL[poi.type]} · ${note}`, lines: [this.status()], buttons }
  }

  // ---------- 地铁 ----------
  static fare(distM: number) {
    const km = distM / 1000
    return Math.min(ECONOMY.mrtCap, Math.round((ECONOMY.mrtBase + km * ECONOMY.mrtPerKm) * 100) / 100)
  }
  private mrtPanel(poi: Poi): PanelSpec {
    const others = this.ctx.pois.byType('mrt').filter((p) => p.id !== poi.id)
    const buttons: PanelButton[] = others.map((p) => {
      const dist = Math.hypot(p.door.x - poi.door.x, p.door.z - poi.door.z)
      const fare = Interactions.fare(dist)
      const minutes = Math.round((dist / 1000 / ECONOMY.mrtSpeedKmh) * 60 + 5)
      return {
        label: `→ ${p.name}`,
        note: `${money(fare)} · ${(dist / 1000).toFixed(1)} km · 约 ${minutes} 分钟`,
        onClick: () => {
          if (!spend(this.ctx, fare, 'transport:mrt')) { this.host.toast('余额不足，先去充值吧'); return }
          this.ctx.clock.skip(dist / 1000 / ECONOMY.mrtSpeedKmh + 5 / 60)
          this.ctx.needs.sync()
          this.host.teleport(p.door.x, p.door.z, p.door.yaw)
          this.host.toast(`到达 ${p.name}`)
          this.close()
        },
      }
    })
    buttons.push({ label: '离开', onClick: () => this.close() })
    return { title: poi.name, subtitle: '地铁站 · 票价 $1.19 起，每公里 +$0.30，上限 $2.50', lines: [this.status()], buttons }
  }

  // ---------- 家 ----------
  private homePanel(poi: Poi): PanelSpec {
    const role = this.ctx.role
    if (!this.host.ownsHome(poi.id)) {
      return { title: poi.name, subtitle: '住家', lines: ['这不是你家。'], buttons: [{ label: '离开', onClick: () => this.close() }] }
    }
    const clock = this.ctx.clock
    // 自有房产：饥饿少扣、次日 XP 加成（默认 = 原数值），并且不交房租
    const bonus = this.host.restBonus(poi.id)
    const rentBase = role.systems.rent ? (ECONOMY.rent[role.id] ?? 0) : 0
    const rent = bonus ? 0 : rentBase
    const lines = [this.status()]
    if (rent) lines.push(`房租 ${money(rent)}/天，每过一夜结算`)
    else if (rentBase && bonus) lines.push('自有物业，免交房租')
    const hungerCost = bonus?.hunger ?? 20
    const xpMul = bonus?.xpMul ?? 1
    // 精力 > 70 不能睡（防止雇经理后连睡刷产业收入）；昏倒强制睡走 Game.faint，不受影响
    const notTired = this.ctx.needs.energy > 70
    return {
      title: poi.name, subtitle: '住家', lines,
      buttons: [
        { label: notTired ? '还不困（精力 >70）' : '睡觉到 07:00', note: notTired ? '' : `精力 100 · 饱食 −${hungerCost}${xpMul > 1 ? ` · 明天 XP +${Math.round((xpMul - 1) * 100)}%` : ''}`, disabled: notTired, onClick: () => {
          if (this.ctx.needs.energy > 70) return
          const hours = clock.hour < 7 ? 7 - clock.hour : 24 - clock.hour + 7
          clock.skip(hours)
          clock.set(7, clock.day)
          this.ctx.needs.sync()
          this.ctx.needs.set(this.ctx.needs.hunger - hungerCost, 100)
          if (rent) { charge(this.ctx, rent, 'rent'); this.host.toast(`新的一天 · 房租 −${money(rent)}`, 3) }
          else this.host.toast('睡了个好觉', 2.5)
          this.ctx.events.emit('slept', { day: clock.day, xpMul })
          this.host.save()
          this.close()
        } },
        { label: '存档', onClick: () => { this.host.save(); this.host.toast('已存档'); this.refresh() } },
        { label: '换装', note: '衣柜', onClick: () => { if (!this.host.wardrobe()) this.host.toast('方块角色模式（?chars=box）不支持换装', 2.5) } },
        { label: '离开', onClick: () => this.close() },
      ],
    }
  }

  // ---------- 办公楼 ----------
  private officePanel(poi: Poi): PanelSpec {
    const role = this.ctx.role
    const salary = ECONOMY.salary[role.id]
    const clock = this.ctx.clock
    if (!salary) {
      return { title: poi.name, subtitle: '办公楼', lines: ['前台：请问您预约了吗？（只有白领/金领身份能在这里上班）'], buttons: [{ label: '离开', onClick: () => this.close() }] }
    }
    const h = clock.hour
    const late = h > 9.5 && h < 12
    const tooLate = h >= 12
    const pay = late ? salary / 2 : salary
    const lines = [this.status(), '工作时间 09:00–18:00；09:30 后到算迟到，薪资减半；12:00 后当天不再接收。']
    return {
      title: poi.name, subtitle: '办公楼', lines,
      buttons: [
        { label: tooLate ? '今天太晚了，明天再来' : late ? '迟到打卡，干到 18:00' : '打卡上班，干到 18:00', note: tooLate ? '' : `${money(pay)} · 饱食 −30 精力 −25`, disabled: tooLate, onClick: () => {
          clock.set(18, clock.day)
          this.ctx.needs.sync()
          this.ctx.needs.add(-30, -25)
          const got = earn(this.ctx, pay, 'salary')
          this.host.toast(`下班了 · 薪水 +${money(got)}${got !== pay ? `（心情 ×${this.ctx.needs.moodMul}）` : ''}`, 3)
          this.ctx.events.emit('clockIn', { day: clock.day, pay })
          this.ctx.events.emit('jobDone', { job: 'white_shift', amount: pay })
          this.close()
        } },
        { label: '离开', onClick: () => this.close() },
      ],
    }
  }

  // ---------- 工地 ----------
  private sitePanel(poi: Poi): PanelSpec {
    const role = this.ctx.role
    if (role.id !== 'blue') {
      return { title: poi.name, subtitle: '工地', lines: ['工头：没有工作准证不能进来。（只有蓝领身份能在这里打工）'], buttons: [{ label: '离开', onClick: () => this.close() }] }
    }
    const needs = this.ctx.needs
    const tired = needs.energy < 15
    return {
      title: poi.name, subtitle: '工地 · 计时工', lines: [this.status(), tired ? '精力不足 15，先去吃点东西或睡一觉。' : '搬一小时建材，现结现金。'],
      buttons: [
        { label: '搬运 1 小时', note: `+${money(ECONOMY.siteWage)} · 精力 −12 饱食 −6`, disabled: tired, onClick: () => {
          this.ctx.clock.skip(1)
          needs.sync()
          needs.add(-6, -12)
          const got = earn(this.ctx, ECONOMY.siteWage, 'site')
          this.host.toast(`工钱 +${money(got)}`)
          this.ctx.events.emit('jobDone', { job: 'blue_site', amount: ECONOMY.siteWage })
          this.refresh()
        } },
        { label: '离开', onClick: () => this.close() },
      ],
    }
  }

  // ---------- 的士站 ----------
  private taxiPanel(poi: Poi): PanelSpec {
    const role = this.ctx.role
    const price = role.id === 'blue' ? ECONOMY.taxiRentBlue : ECONOMY.taxiRent
    const rented = this.taxiRentedDay === this.ctx.clock.day
    const pl = this.ctx.player
    const rent = (thenWork: boolean) => {
      if (pl.money < price) { this.host.toast('钱不够租车'); return }
      // 停在门口最近的车道上
      const g = this.ctx.graph
      const lane = g.nearestLane(poi.door.x, poi.door.z)
      const t = Math.max(6, Math.min(lane.edge.length - 6, lane.t))
      const p = g.lanePoint(lane.edge, t, { x: 0, z: 0 })
      const d = g.dirAt(lane.edge, t, { x: 0, z: 0 })
      const v = this.host.parkTaxi(p.x, p.z, Math.atan2(d.x, d.z))
      if (!v) { this.host.toast('暂时没有空车'); return }
      spend(this.ctx, price, 'transport:taxiRent')
      this.taxiRentedDay = this.ctx.clock.day
      pl.enter(v)
      this.host.toast(`的士到手 · −${money(price)}`, 3)
      this.ctx.events.emit('taxiRented', { v })
      this.close()
      if (thenWork && this.jobs) { const r = this.jobs.start('blue_taxi'); if (r !== true) this.host.toast(r) }
    }
    const buttons: PanelButton[] = [
      { label: rented ? '今天已经租过了' : '租一辆的士', note: rented ? '' : `${money(price)}/天`, disabled: rented, onClick: () => rent(false) },
    ]
    if (role.id === 'blue') buttons.push({ label: '租车并开工载客', note: rented ? '' : `${money(price)}/天 · 的士载客`, disabled: rented, onClick: () => rent(true) })
    buttons.push({ label: '离开', onClick: () => this.close() })
    return {
      title: poi.name, subtitle: '的士站 · 日租', lines: [this.status(), role.id === 'blue' ? '同行优惠：蓝领租金 $30/天。' : '租金 $50/天，当天只能租一次。'],
      buttons,
    }
  }
}
