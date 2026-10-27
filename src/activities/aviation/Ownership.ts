import type { Game } from '../../core/Game'
import type { Aircraft } from '../../entities/Aircraft'
import { FLIGHT_PARAMS, type FlightParams } from '../../physics/ArcadeFlight'
import { SHOP, shopItem, type ShopItem } from '../../data/shop'
import { STANDS } from '../../world/Airfield'
import { spend } from '../../systems/Wallet'
import { t } from '../../i18n'
import { REPAIR_SHARE } from './missions/params'

/**
 * 自有飞机（AIR.5a）：商店买下（Assets.buy → purchased {kind:'aircraft'}）后停到空闲停机位；
 * 存档在 plugins.aviation.own（每架：商店 id、报废、停放位置）；读档按 Assets 的「已拥有」重新生成。
 * 坠毁 → 报废（网格移除），机库面板「维修（买价 × 5%）」后回到停机位。
 * 涡轮 / VIP：spawn 时按商店 aircraft.tune 生成自己的 FlightParams（推力 / 极速倍率），FlightControl 经 params 钩子读取。
 */
export interface OwnedSave { id: string; wrecked: boolean; x: number; z: number; yaw: number; stand: number }

export interface OwnedHost {
  spawn(o: { id: string; owner: 'own'; paint?: number; stand?: number; at?: { x: number; z: number; yaw: number } }): Aircraft | null
  remove(ac: Aircraft): boolean
  freeStand(): number
  active(): Aircraft | null
}

const usd = (n: number) => `$${Math.round(n).toLocaleString('en-US')}`
/** 离停机位多远算「停在机位上」 */
const AT_STAND = 15

/** 按商店调校生成飞行参数（无调校 → 默认 Cessna） */
export function paramsFor(it: ShopItem | undefined): FlightParams {
  const base = FLIGHT_PARAMS.cessna
  const tu = it?.aircraft?.tune
  return tu ? { ...base, thrust: base.thrust * tu.thrust, vMax: base.vMax * tu.vmax } : base
}

export class OwnedFleet {
  list: OwnedSave[] = []
  readonly planes = new Map<string, Aircraft>()
  readonly params = new WeakMap<Aircraft, FlightParams>()

  constructor(private game: Game, private host: OwnedHost) {}

  /** 资产里拥有的飞机 id（商店顺序） */
  private ownedIds() { return SHOP.filter((it) => it.kind === 'aircraft' && this.game.assets.owns(it.id)).map((it) => it.id) }
  entry(id: string) { return this.list.find((e) => e.id === id) ?? null }

  private spawnEntry(e: OwnedSave, atStand = false): Aircraft | null {
    const it = shopItem(e.id)
    let stand = e.stand
    let at: { x: number; z: number; yaw: number } | undefined
    if (atStand || stand < 0) {
      stand = this.host.freeStand()
      if (stand < 0) { stand = -1; at = { x: STANDS[0].x + 60, z: STANDS[0].z + 8, yaw: 0 } }   // 停机位满：停到停机坪东边
    } else at = { x: e.x, z: e.z, yaw: e.yaw }
    const ac = this.host.spawn({ id: e.id, owner: 'own', paint: it?.aircraft?.paint, ...(at ? { at } : { stand }) })
    if (!ac) return null
    this.params.set(ac, paramsFor(it))
    e.stand = stand >= 0 ? stand : e.stand
    e.x = ac.x; e.z = ac.z; e.yaw = ac.yaw
    this.planes.set(e.id, ac)
    return ac
  }

  /** 买下：建档并停到空闲停机位 */
  onPurchased(id: string) {
    if (this.entry(id)) return
    const e: OwnedSave = { id, wrecked: false, x: 0, z: 0, yaw: 0, stand: -1 }
    this.list.push(e)
    const ac = this.spawnEntry(e, true)
    const name = shopItem(id)?.name ?? id
    this.game.hud.toast(ac && e.stand >= 0 ? t('「{name}」停在机库 {n} 号停机位', { name, n: e.stand + 1 }) : t('「{name}」停在机场停机坪', { name }), 3.5)
  }

  /** 坠毁：记报废 */
  onCrash(ac: Aircraft) {
    const e = this.entry(ac.id)
    if (!e || this.planes.get(ac.id) !== ac) return
    e.wrecked = true
    this.planes.delete(ac.id)
  }

  repairCost(id: string) { return Math.round((shopItem(id)?.price ?? 0) * REPAIR_SHARE) }
  /** 维修报废飞机：扣钱，停回空闲停机位 */
  repair(id: string): true | string {
    const e = this.entry(id)
    if (!e || !e.wrecked) return t('这架飞机不需要维修')
    const cost = this.repairCost(id)
    if (!spend(this.game.ctx, cost, 'plane_repair')) return t('钱不够（维修要 {n}）', { n: usd(cost) })
    e.wrecked = false
    this.spawnEntry(e, true)
    this.game.hud.toast(t('「{name}」修好了 · {n} 号停机位', { name: shopItem(id)?.name ?? id, n: e.stand + 1 }), 3)
    this.game.saveGame(false)
    return true
  }

  /** 取我的飞机：在机位上 → 告诉位置；停在别处（迫降后） → 拖回空闲停机位 */
  fetch(id: string): true | string {
    const e = this.entry(id)
    if (!e) return t('你没有这架飞机')
    if (e.wrecked) return t('飞机已报废，先维修')
    const ac = this.planes.get(id)
    if (ac && this.host.active() === ac) return t('你正驾驶着它')
    const st = this.standOf(ac ?? null)
    if (ac && st >= 0) { this.game.hud.toast(t('「{name}」就在 {n} 号停机位', { name: shopItem(id)?.name ?? id, n: st + 1 }), 3); return true }
    if (ac) { this.host.remove(ac); this.planes.delete(id) }
    const nac = this.spawnEntry(e, true)
    if (!nac) return t('停机位都满了，稍后再来')
    this.game.hud.toast(t('地勤把「{name}」拖回了 {n} 号停机位', { name: shopItem(id)?.name ?? id, n: e.stand + 1 }), 3)
    return true
  }

  /** 飞机停在哪个停机位（-1 = 不在机位上） */
  standOf(ac: Aircraft | null) {
    if (!ac) return -1
    for (let i = 0; i < STANDS.length; i++) if (Math.hypot(ac.x - STANDS[i].x, ac.z - STANDS[i].z) < AT_STAND) return i
    return -1
  }

  /** 第一架可用（未报废、已生成、没在被别人驾驶）的自有飞机 */
  available(): Aircraft | null {
    for (const id of this.ownedIds()) { const ac = this.planes.get(id); if (ac && !ac.wrecked) return ac }
    return null
  }

  /** Assets 商店页的状态行 */
  info(id: string): { status: string; wrecked: boolean } | null {
    const e = this.entry(id)
    if (!e) return null
    if (e.wrecked) return { status: t('已报废 · 到机库维修 {n}', { n: usd(this.repairCost(id)) }), wrecked: true }
    const ac = this.planes.get(id)
    if (ac && this.host.active() === ac) return { status: t('驾驶中'), wrecked: false }
    const st = this.standOf(ac ?? null)
    return { status: st >= 0 ? t('停在机库 {n} 号停机位', { n: st + 1 }) : t('停在机场外（机库可拖回）'), wrecked: false }
  }

  /** 资产有、档案没有（旧存档 / 调试买入）→ 补档并生成；档案里多出的（不再拥有）→ 删除 */
  sync() {
    const ids = this.ownedIds()
    for (const e of [...this.list]) if (!ids.includes(e.id)) { const ac = this.planes.get(e.id); if (ac) this.host.remove(ac); this.planes.delete(e.id); this.list.splice(this.list.indexOf(e), 1) }
    for (const id of ids) {
      let e = this.entry(id)
      if (!e) { e = { id, wrecked: false, x: 0, z: 0, yaw: 0, stand: -1 }; this.list.push(e) }
      if (!e.wrecked && !this.planes.has(id)) this.spawnEntry(e, e.stand < 0)
    }
  }

  serialize(): OwnedSave[] {
    return this.list.map((e) => {
      const ac = this.planes.get(e.id)
      // 地面停着（不在驾驶）存实际位置；空中 / 驾驶中存档 → 回原停机位
      if (ac && this.host.active() !== ac && ac.body.onGround && !e.wrecked) return { ...e, x: ac.x, z: ac.z, yaw: ac.yaw }
      const s = STANDS[Math.max(0, e.stand)]
      return { ...e, x: s.x, z: s.z, yaw: s.yaw }
    })
  }

  /** 读档：先由调用方清掉旧的自有飞机实体 */
  restore(list: OwnedSave[] | undefined) {
    this.planes.clear()
    this.list = (list ?? []).filter((e) => !!shopItem(e.id)).map((e) => ({ id: e.id, wrecked: !!e.wrecked, x: +e.x || 0, z: +e.z || 0, yaw: +e.yaw || 0, stand: Number.isInteger(e.stand) ? e.stand : -1 }))
    this.sync()
  }

  debug() {
    return this.list.map((e) => { const ac = this.planes.get(e.id); return { ...e, spawned: !!ac, x: ac ? +ac.x.toFixed(1) : e.x, z: ac ? +ac.z.toFixed(1) : e.z, standNow: this.standOf(ac ?? null), params: ac ? { thrust: this.params.get(ac)?.thrust, vMax: this.params.get(ac)?.vMax } : null } })
  }
}
