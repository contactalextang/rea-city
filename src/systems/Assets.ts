import type { Ctx, Subsystem, AppView, AppItem } from '../core/Context'
import type { PanelButton } from '../ui/Panels'
import type { Poi } from './Poi'
import type { Spawner } from './Spawner'
import type { Vehicle } from '../entities/Vehicle'
import { SHOP, shopItem, canRoleBuy, ROLE_NAME, GOLD_OWN_CAR, type ShopItem } from '../data/shop'
import { isUnlocked, unlockLevel } from '../data/progression'
import { spend } from './Wallet'
import { t } from '../i18n'

/** 存档：已拥有物品 id、主住处 POI、车库（车 id + 车况）、当前取出的车 */
export interface AssetsSave {
  owned: string[]
  primaryHome: string | null
  garage: { id: string; health: number }[]
  activeCar: string | null
}
/** 在自有房产睡觉的效果：饥饿扣多少（默认 20）、次日 XP 倍率 */
export interface RestBonus { hunger: number; xpMul: number }
/** 已购升级的合计效果（Game / Weapon / Vehicle 读取；中性值 = 无升级） */
export interface AssetEffects { accelMul: number; maxFwdMul: number; armor: number; dmgMul: number; needsMul: number; taxiTipMul: number }
export const NEUTRAL_EFFECTS: AssetEffects = { accelMul: 1, maxFwdMul: 1, armor: 0, dmgMul: 1, needsMul: 1, taxiTipMul: 1 }

/** 当前玩家的升级效果（Vehicle / Weapon / Needs 直接读，免得层层传引用；页面里只有一个 Game） */
let current: AssetEffects = NEUTRAL_EFFECTS
export const playerEffects = (): AssetEffects => current

/** Game 提供给资产系统的依赖 */
export interface AssetsHost {
  toast(s: string, sec?: number): void
  save(): void
  spawner: Spawner
  /** 玩家当前等级（Progress） */
  level(): number
  /** 关闭 POI 面板（在地标豪宅睡觉后） */
  closePanel(): void
  /** 重建当前 POI 面板（买完后按钮状态刷新） */
  refresh?(): void
}

/**
 * Phase AIR：航空插件安装后注入（方格城没有机场 → null，飞机与航电在商店隐藏）。
 * 自有飞机的位置 / 报废状态由插件存档（plugins.aviation），这里只记「拥有」。
 */
export interface AircraftHost {
  /** 自有飞机当前状态（停机位 / 报废待修…）；没有这架 → null */
  info(id: string): { status: string; wrecked: boolean } | null
}
/** 只在有机场的世界出售的物品 */
const AIR_ONLY = new Set(['upg_avionics'])

const empty = (): AssetsSave => ({ owned: [], primaryHome: null, garage: [], activeCar: null })
const usd = (n: number) => `$${Math.round(n).toLocaleString('en-US')}`
/** 门口购买房产的最大距离（调试 buy 也要站在门口） */
const DOOR_DIST = 8

/**
 * 资产（车 / 房 / 升级）：商店购买、车库取车、自有房产睡觉加成、升级效果汇总。
 * value() 返回买价合计（Wallet 再按 60% 折价计入净资产）。
 */
export class Assets implements Subsystem<AssetsSave> {
  private s: AssetsSave = empty()
  /** 当前取出的那辆车（与 s.activeCar 对应） */
  private activeVehicle: Vehicle | null = null
  /** 航空插件（有机场时）；见 AircraftHost */
  aircraftHost: AircraftHost | null = null

  constructor(private ctx: Ctx, private host: AssetsHost) {
    if (ctx.role.id === 'gold') host.spawner.claimOwnCar()
  }

  // ---------- 查询 ----------
  private get role() { return this.ctx.role.id }
  /** 房产在当前世界对应的 POI（都找不到 → null，该房产隐藏） */
  propPoi(it: ShopItem): Poi | null {
    for (const id of it.poi ?? []) { const p = this.ctx.pois.byId(id); if (p) return p }
    return null
  }
  /** 商店里对本世界可见的物品（隐藏物品、找不到 POI 的房产不列） */
  get catalog() { return SHOP.filter((it) => !it.hidden && (it.kind !== 'property' || this.propPoi(it)) && ((it.kind !== 'aircraft' && !AIR_ONLY.has(it.id)) || !!this.aircraftHost)) }
  /** 是否拥有某物品（商店 id） */
  owns(id: string) { return this.s.owned.includes(id) }
  /** 自有房产里坐落在 poiId 的那一处 */
  private propertyAt(poiId: string) {
    return SHOP.find((it) => it.kind === 'property' && this.owns(it.id) && this.propPoi(it)?.id === poiId) ?? null
  }
  /** 是否拥有某住家 POI（房产对应的 home POI / 地标）；身份自带的家由 Game 另行判断 */
  ownsHome(poiId: string) { return !!this.propertyAt(poiId) }
  /** 主住所 POI id：设过且仍可用 → 它，否则身份自带的家 */
  get primaryHome() {
    const h = this.s.primaryHome
    return h && this.isResidence(h) && this.ctx.pois.byId(h) ? h : this.ctx.role.home
  }
  /** 玩家能住的地方：身份自带的家或自有房产 */
  private isResidence(poiId: string) { return poiId === this.ctx.role.home || this.ownsHome(poiId) }
  /** 在 poiId 睡觉的加成；null = 不是自有房产（按原数值：饥饿 −20） */
  restBonus(poiId?: string): RestBonus | null {
    const it = poiId ? this.propertyAt(poiId) : null
    return it?.rest ? { ...it.rest } : null
  }
  /** 升级合计效果 */
  effects(): AssetEffects { return current }
  /** 已购资产买价合计 */
  value() { return this.s.owned.reduce((a, id) => a + (shopItem(id)?.price ?? 0), 0) }

  /** 不能买的原因（null = 可以买；不含钱和门口距离） */
  private lockReason(it: ShopItem): string | null {
    if (this.owns(it.id)) return t('已拥有')
    if (!canRoleBuy(it, this.role)) return t('仅限{roles}', { roles: it.roles.map((r) => ROLE_NAME[r]).join(' / ') })
    if (!isUnlocked(this.role, this.host.level(), it.id)) return t('Lv{n} 解锁', { n: unlockLevel(this.role, it.id) })
    return null
  }

  private recompute() {
    const e = { ...NEUTRAL_EFFECTS }
    for (const id of this.s.owned) {
      const f = shopItem(id)?.effect; if (!f) continue
      e.accelMul *= f.accelMul ?? 1; e.maxFwdMul *= f.maxFwdMul ?? 1; e.dmgMul *= f.dmgMul ?? 1
      e.needsMul *= f.needsMul ?? 1; e.taxiTipMul *= f.taxiTipMul ?? 1; e.armor = Math.min(0.9, e.armor + (f.armor ?? 0))
    }
    current = e
  }

  // ---------- 操作 ----------
  /**
   * 购买：检查身份 / 等级 / 是否已拥有 / （房产）是否在门口 / 钱，失败 toast 原因并返回原因字符串，成功返回 true。
   * atDoor = 从房产门口面板买（调试调用时按玩家与门口距离判断）。
   */
  buy(id: string, atDoor = false): true | string {
    const fail = (r: string) => { this.host.toast(r, 3); return r }
    const it = shopItem(id)
    if (!it || it.hidden) return fail(t('没有这件商品'))
    if (this.owns(id)) return fail(t('你已经拥有「{name}」', { name: it.name }))
    if (!canRoleBuy(it, this.role)) return fail(t('「{name}」仅限{roles}身份购买', { name: it.name, roles: it.roles.map((r) => ROLE_NAME[r]).join(' / ') }))
    if (!isUnlocked(this.role, this.host.level(), id)) return fail(t('「{name}」需要 Lv{n} 解锁（当前 Lv{lv}）', { name: it.name, n: unlockLevel(this.role, id), lv: this.host.level() }))
    if (it.kind === 'property') {
      const p = this.propPoi(it)
      if (!p) return fail(t('这座城市没有这处房产'))
      const pl = this.ctx.player
      if (!atDoor && Math.hypot(pl.x - p.door.x, pl.z - p.door.z) > DOOR_DIST) return fail(t('房产要到门口购买：{name}', { name: p.name }))
    }
    if ((it.kind === 'aircraft' || AIR_ONLY.has(it.id)) && !this.aircraftHost) return fail(t('这座城市没有机场'))
    if (!spend(this.ctx, it.price, it.id)) return fail(t('钱不够：「{name}」要 {price}，还差 {short}', { name: it.name, price: usd(it.price), short: usd(it.price - this.ctx.player.money) }))
    this.s.owned.push(id)
    if (it.kind === 'vehicle') this.s.garage.push({ id, health: 100 })
    this.recompute()
    this.ctx.events.emit('purchased', { kind: it.kind, id, cost: it.price })
    const where = it.kind === 'vehicle' ? t(' · 已停进车库，到家门口取车') : it.kind === 'property' ? t(' · 门口可设为主住所') : it.kind === 'aircraft' ? t(' · 停在滨海南机场机库') : ''
    this.host.toast(t('买下「{name}」 −{price}', { name: it.name, price: usd(it.price) }) + where, 3.5)
    this.host.save()
    return true
  }

  /** 设为主住所（商店房产 id 或住家 POI id） */
  setHome(id: string): true | string {
    const it = shopItem(id)
    const poiId = it?.kind === 'property' ? this.propPoi(it)?.id ?? '' : id
    if (!this.isResidence(poiId)) { const r = t('只能把自己的房子设为主住所'); this.host.toast(r); return r }
    this.s.primaryHome = poiId
    this.host.toast(t('主住所：{name} · 车会停在这里', { name: this.ctx.pois.byId(poiId)?.name ?? poiId }), 3)
    return true
  }

  /** 从车库取车：停到 atPoi（缺省主住所）门口的路边；一次只有一辆在外面，再取会收回旧车 */
  spawnCar(id: string, atPoi?: string, silent = false): true | string {
    const fail = (r: string) => { if (!silent) this.host.toast(r, 3); return r }
    const g = this.s.garage.find((c) => c.id === id)
    const it = shopItem(id)
    if (!g || !it?.preset) return fail(t('车库里没有这辆车'))
    const pl = this.ctx.player
    if (this.activeVehicle && pl.vehicle === this.activeVehicle) {
      if (this.s.activeCar === id) return fail(t('你正开着「{name}」', { name: it.name }))
      pl.exit(this.ctx.world)
    }
    const poi = this.ctx.pois.byId(atPoi ?? this.primaryHome) ?? this.ctx.pois.byId(this.ctx.role.home)
    if (!poi) return fail(t('找不到住所'))
    this.syncHealth()
    if (this.activeVehicle) this.host.spawner.recallOwned(this.activeVehicle)
    // 门口最近车道上、往回 10 m（门口 +8 m 处是开局停的那辆空车）
    const gr = this.ctx.graph
    const lane = gr.nearestLane(poi.door.x, poi.door.z)
    const lt = Math.max(6, Math.min(lane.edge.length - 6, lane.t - 10))
    const p = gr.lanePoint(lane.edge, lt, { x: 0, z: 0 })
    const d = gr.dirAt(lane.edge, lt, { x: 0, z: 0 })
    const pre = it.preset
    const v = this.host.spawner.spawnOwned(this.ctx, id, p.x, p.z, Math.atan2(d.x, d.z), pre, id === GOLD_OWN_CAR)
    v.tune = pre.tune ? { ...pre.tune } : { accel: 1, maxFwd: 1 }
    // 车况沿用车库记录（报废的车拖回来修到 30）
    g.health = Math.max(30, g.health)
    if (g.health < 100) v.damage(100 - g.health)
    this.activeVehicle = v
    this.s.activeCar = id
    if (!silent) this.host.toast(t('「{name}」已停在 {poi} 门口', { name: it.name, poi: poi.name }), 3)
    return true
  }

  /** 把当前取出那辆车的车况写回车库 */
  private syncHealth() {
    const v = this.activeVehicle; if (!v || !this.s.activeCar) return
    const g = this.s.garage.find((c) => c.id === this.s.activeCar)
    if (g) g.health = v.wrecked ? 0 : Math.max(0, Math.round(v.health))
  }

  /** 在地标豪宅（非住家类 POI）睡觉：与住家面板同样的流程，按房产加成扣饥饿 */
  private sleepAt(it: ShopItem) {
    const clock = this.ctx.clock, needs = this.ctx.needs
    const rest = it.rest ?? { hunger: 20, xpMul: 1 }
    const hours = clock.hour < 7 ? 7 - clock.hour : 24 - clock.hour + 7
    clock.skip(hours)
    clock.set(7, clock.day)
    needs.sync()
    needs.set(needs.hunger - rest.hunger, 100)
    this.host.toast(t('在{name}睡了个好觉', { name: it.name }), 2.5)
    this.ctx.events.emit('slept', { day: clock.day, xpMul: rest.xpMul })
    this.host.save()
    this.host.closePanel()
  }

  // ---------- Subsystem ----------
  update(_dt: number) { this.syncHealth() }

  poiButtons(poi: Poi): PanelButton[] {
    const out: PanelButton[] = []
    // 商店：卖本身份可买的升级
    if (poi.type === 'shop') {
      for (const it of SHOP) {
        if (it.kind !== 'upgrade' || !canRoleBuy(it, this.role) || this.owns(it.id)) continue
        const lock = this.lockReason(it)
        out.push({ label: t('买 {name}', { name: it.name }), note: lock ?? `${usd(it.price)} · ${it.desc}`, disabled: !!lock, onClick: () => { if (this.buy(it.id) === true) this.refresh(poi) } })
      }
    }
    // 房产门口：未拥有 → 买下
    for (const it of SHOP) {
      if (it.kind !== 'property' || this.propPoi(it)?.id !== poi.id || this.owns(it.id)) continue
      const lock = this.lockReason(it)
      out.push({ label: t('买下此处 {price}', { price: usd(it.price) }), note: lock ?? `${it.name} · ${it.desc}`, onClick: () => { if (this.buy(it.id, true) === true) this.refresh(poi) } })
    }
    // 自有住所：取车、设为主住所、（地标豪宅）睡觉
    if (this.isResidence(poi.id)) {
      for (const c of this.s.garage) {
        const it = shopItem(c.id); if (!it) continue
        const out_ = this.s.activeCar === c.id
        out.push({ label: t('取车：{name}', { name: it.name }), note: t('车况 {n}%', { n: c.health }) + (out_ ? t(' · 已取出（重新停到门口）') : ''), onClick: () => { if (this.spawnCar(c.id, poi.id) === true) this.host.closePanel() } })
      }
      if (this.primaryHome !== poi.id) out.push({ label: t('设为主住所'), note: t('车库取车停在这里'), onClick: () => { this.setHome(poi.id); this.refresh(poi) } })
      const prop = this.propertyAt(poi.id)
      if (prop && poi.type !== 'home') {
        out.push({ label: t('睡觉到 07:00'), note: t('精力 100 · 饱食 −{h} · 明天 XP +{xp}%', { h: prop.rest?.hunger ?? 20, xp: Math.round(((prop.rest?.xpMul ?? 1) - 1) * 100) }), onClick: () => this.sleepAt(prop) })
        out.push({ label: t('存档'), onClick: () => { this.host.save(); this.host.toast(t('已存档')) } })
      }
    }
    return out
  }
  /** 面板按钮改变状态后重建面板（无 refresh 钩子时关掉，由玩家再按 E） */
  private refresh(_poi: Poi) { if (this.host.refresh) this.host.refresh(); else this.host.closePanel() }

  view(): AppView {
    const money = this.ctx.player.money
    const home = this.ctx.pois.byId(this.primaryHome)?.name ?? this.primaryHome
    const item = (it: ShopItem): AppItem => {
      const lock = this.lockReason(it)
      const owned = this.owns(it.id)
      const a: AppItem = { title: it.name, desc: it.desc, value: usd(it.price) }
      if (owned) { a.status = t('已拥有'); a.tone = 'owned'; return a }
      if (lock) { a.status = lock; a.tone = 'locked'; return a }
      if (it.kind === 'property') { a.status = t('到门口购买 · {name}', { name: this.propPoi(it)?.name ?? '' }); return a }
      if (money < it.price) a.status = t('还差 {n}', { n: usd(it.price - money) })
      a.actions = [{ label: t('购买'), disabled: money < it.price, onClick: () => { this.buy(it.id) } }]
      return a
    }
    const cat = this.catalog
    const group = (k: ShopItem['kind']) => cat.filter((it) => it.kind === k).map(item)
    const planes = group('aircraft').map((a, i) => {
      const it = cat.filter((x) => x.kind === 'aircraft')[i]
      const st = this.owns(it.id) ? this.aircraftHost?.info(it.id) : null
      if (st) { a.status = st.status; a.tone = st.wrecked ? undefined : 'owned' }
      return a
    })
    const garage: AppItem[] = this.s.garage.map((c) => {
      const it = shopItem(c.id)
      return { title: it?.name ?? c.id, value: t('车况 {n}%', { n: c.health }), status: this.s.activeCar === c.id ? t('已取出 · 停在 {home} 附近', { home }) : t('在车库（到住所门口取车）'), tone: 'owned' }
    })
    if (!garage.length) garage.push({ title: t('车库空空'), desc: t('买下的车会停在主住所，到门口面板「取车」。') })
    return {
      lines: [t('现金 {cash} · 资产 {n} 件，买价合计 {total}', { cash: usd(money), n: this.s.owned.length, total: usd(this.value()) }), t('主住所：{home}', { home })],
      sections: [
        { title: t('车辆'), items: group('vehicle') },
        { title: t('房产（到门口购买）'), items: group('property') },
        { title: t('升级'), items: group('upgrade') },
        ...(planes.length ? [{ title: t('飞机（停在机库）'), items: planes }] : []),
        { title: t('车库'), items: garage },
      ],
    }
  }

  serialize(): AssetsSave { this.syncHealth(); return JSON.parse(JSON.stringify(this.s)) as AssetsSave }

  restore(s?: AssetsSave) {
    const b = empty()
    const known = (id: string) => !!shopItem(id)
    this.s = s ? {
      owned: [...new Set((s.owned ?? []).filter(known))],
      primaryHome: s.primaryHome ?? null,
      garage: (s.garage ?? []).filter((c) => known(c.id)).map((c) => ({ id: c.id, health: Math.max(0, Math.min(100, Number(c.health) || 0)) })),
      activeCar: s.activeCar ?? null,
    } : b
    // 金领开局那辆豪车并入车库（新开局 / 旧存档默认取出）
    if (this.role === 'gold' && !this.s.garage.some((c) => c.id === GOLD_OWN_CAR)) {
      this.s.garage.unshift({ id: GOLD_OWN_CAR, health: 100 })
      if (!s?.garage?.length) this.s.activeCar = GOLD_OWN_CAR
    }
    for (const it of SHOP) if (it.kind === 'vehicle' && this.owns(it.id) && !this.s.garage.some((c) => c.id === it.id)) this.s.garage.push({ id: it.id, health: 100 })
    this.recompute()
    // 收回旧车，读档后把取出的车停回主住所门口
    if (this.activeVehicle) { if (this.ctx.player.vehicle === this.activeVehicle) this.ctx.player.exit(this.ctx.world); this.host.spawner.recallOwned(this.activeVehicle) }
    this.activeVehicle = null
    const car = this.s.activeCar
    this.s.activeCar = null
    if (car && this.spawnCar(car, undefined, true) !== true) this.s.activeCar = null
  }

  /** window.__game.shop 调试对象 */
  get debug() {
    const self = this
    return {
      get catalog() { return self.catalog.map((it) => ({ id: it.id, name: it.name, kind: it.kind, price: it.price, roles: it.roles, poi: it.kind === 'property' ? self.propPoi(it)?.id ?? null : undefined, lock: self.lockReason(it) })) },
      get owned() { return [...self.s.owned] },
      get garage() { self.syncHealth(); return self.s.garage.map((c) => ({ ...c })) },
      get activeCar() {
        const v = self.activeVehicle
        return self.s.activeCar && v ? { id: self.s.activeCar, active: v.active, x: v.x, z: v.z, health: v.health, kind: v.kind, driving: self.ctx.player.vehicle === v } : null
      },
      get primaryHome() { return self.primaryHome },
      get effects() { return { ...current } },
      /** 玩家当前所开车的实际调参倍率（车自身 tune × 引擎升级） */
      get driveMul() { return self.ctx.player.vehicle?.tuneMul ?? null },
      get value() { return self.value() },
      buy(id: string) { return self.buy(id) },
      setHome(id: string) { return self.setHome(id) },
      spawnCar(id: string) { return self.spawnCar(id) },
    }
  }
}
