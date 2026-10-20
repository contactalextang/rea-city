import type { Ctx, Subsystem, AppView } from '../core/Context'
import type { PanelButton } from '../ui/Panels'
import type { Poi } from './Poi'
import type { Spawner } from './Spawner'

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

/** Game 提供给资产系统的依赖 */
export interface AssetsHost {
  toast(s: string, sec?: number): void
  save(): void
  spawner: Spawner
}

const empty = (): AssetsSave => ({ owned: [], primaryHome: null, garage: [], activeCar: null })

/**
 * 资产（车 / 房 / 升级）——P8.1 桩：接口与存档已接好，商店目录与购买逻辑由 P8.2 填。
 * value() 返回买价合计（Wallet 再按 60% 折价计入净资产）。
 */
export class Assets implements Subsystem<AssetsSave> {
  private s: AssetsSave = empty()

  constructor(private ctx: Ctx, private host: AssetsHost) { void this.ctx; void this.host }

  update(_dt: number) {}
  poiButtons(_poi: Poi): PanelButton[] { return [] }
  view(): AppView { return { empty: '商店即将开放：车、房产与升级装备。' } }
  serialize(): AssetsSave { return JSON.parse(JSON.stringify(this.s)) as AssetsSave }
  restore(s?: AssetsSave) {
    const b = empty()
    this.s = s ? { ...b, ...s, owned: [...(s.owned ?? [])], garage: [...(s.garage ?? [])] } : b
  }

  /** 是否拥有某物品（商店 id） */
  owns(id: string) { return this.s.owned.includes(id) }
  /** 是否拥有某住家 POI（房产对应的 home POI / 地标）；身份自带的家由 Game 另行判断 */
  ownsHome(_poiId: string) { return false }
  /** 在 poiId 睡觉的加成；null = 不是自有房产（按原数值：饥饿 −20） */
  restBonus(_poiId?: string): RestBonus | null { return null }
  /** 升级合计效果 */
  effects(): AssetEffects { return NEUTRAL_EFFECTS }
  /** 已购资产买价合计 */
  value() { return 0 }
}
