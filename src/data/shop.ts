import type { RoleId } from './roles'
import { t } from '../i18n'
import type { VehicleKind } from '../config'
import type { CarModel } from '../entities/Vehicle'

/**
 * 商店目录（P8.2）：车辆 4、房产 4、升级 7、飞机 3（Phase AIR）。
 * 等级门槛只在 progression.UNLOCKS 里写（这里不写 level），身份限制写在物品的 roles 里（空 = 所有身份）。
 */
export type ShopKind = 'vehicle' | 'property' | 'upgrade' | 'aircraft'

/** 升级效果（与 Assets.AssetEffects 同名字段；倍率相乘、armor 相加） */
export interface ShopEffect { accelMul?: number; maxFwdMul?: number; armor?: number; dmgMul?: number; needsMul?: number; taxiTipMul?: number }

/**
 * Phase AIR 飞机：paint 机身漆色；tune 推力 / 极速倍率（乘到 ArcadeFlight.FLIGHT_PARAMS.cessna 的 thrust / vMax）；
 * payMul 包机等飞行工作报酬倍率（金领 VIP 涂装）。买下后不进车库，由航空插件停到机库停机位。
 */
export interface AircraftPreset { paint: number; tune?: { thrust: number; vmax: number }; payMul?: number }

/** 车辆外观与调校：kind 决定基础手感（config.VEHICLE_PARAMS），tune 为这辆车自己的加速/极速倍率 */
export interface VehiclePreset { kind: VehicleKind; model: CarModel; color: number; tune?: { accel: number; maxFwd: number } }

export interface ShopItem {
  id: string
  name: string
  kind: ShopKind
  price: number
  /** 可购买的身份；空数组 = 所有身份 */
  roles: RoleId[]
  desc: string
  /** 车辆外观 */
  preset?: VehiclePreset
  /** 房产对应的 POI id 候选（按顺序取世界里第一个存在的；都不存在 → 该房产在此世界隐藏） */
  poi?: string[]
  /** 在此房产睡觉：饥饿扣多少、次日 XP 倍率 */
  rest?: { hunger: number; xpMul: number }
  effect?: ShopEffect
  /** 飞机外观 / 调校（kind 'aircraft'） */
  aircraft?: AircraftPreset
  /** 不在商店出售（金领开局自带的豪车） */
  hidden?: boolean
}

export const ROLE_NAME: Record<RoleId, string> = { gang: t('黑帮'), gold: t('金领'), white: t('白领'), blue: t('蓝领') }

/** 金领开局自带的豪车（并入车库，不出售） */
export const GOLD_OWN_CAR = 'car_lux_own'

export const SHOP: ShopItem[] = [
  // ---- 车辆 ----
  { id: 'car_used', name: t('二手 Toyota'), kind: 'vehicle', price: 1200, roles: [], desc: t('开了十年的 Corolla，皮实耐用。'),
    preset: { kind: 'civil', model: 'sedan', color: 0xc3c7cc } },
  { id: 'car_taxi', name: t('自有的士'), kind: 'vehicle', price: 3500, roles: ['blue'], desc: t('挂牌的士，不用每天交租就能载客。'),
    preset: { kind: 'taxi', model: 'sedan', color: 0x1f5fbf } },
  { id: 'car_sports', name: t('跑车'), kind: 'vehicle', price: 25000, roles: ['gold', 'gang'], desc: t('低趴双门跑车，起步快。'),
    preset: { kind: 'luxury', model: 'sports', color: 0xb8282e } },
  { id: 'car_super', name: t('超跑'), kind: 'vehicle', price: 120000, roles: ['gold'], desc: t('限量超跑：加速 ×1.25、极速 ×1.15。'),
    preset: { kind: 'luxury', model: 'sports', color: 0xf2c516, tune: { accel: 1.25, maxFwd: 1.15 } } },
  { id: GOLD_OWN_CAR, name: t('私人豪车'), kind: 'vehicle', price: 0, roles: ['gold'], desc: t('金领开局自带。'), hidden: true,
    preset: { kind: 'luxury', model: 'sports', color: 0x1c1f26 } },
  // ---- 房产（到门口买） ----
  { id: 'home_hdb', name: t('HDB 房间'), kind: 'property', price: 8000, roles: [], desc: t('组屋单间，睡觉饥饿只扣 10，次日 XP +10%。'),
    poi: ['home_blue'], rest: { hunger: 10, xpMul: 1.1 } },
  { id: 'home_shophouse', name: t('店屋'), kind: 'property', price: 30000, roles: [], desc: t('牛车水老店屋，睡觉饥饿只扣 10，次日 XP +10%。'),
    poi: ['home_gang'], rest: { hunger: 10, xpMul: 1.1 } },
  { id: 'home_condo', name: t('公寓'), kind: 'property', price: 60000, roles: [], desc: t('中峇鲁公寓，睡觉饥饿只扣 10，次日 XP +10%。'),
    poi: ['home_white'], rest: { hunger: 10, xpMul: 1.1 } },
  { id: 'home_penthouse', name: t('顶层豪宅'), kind: 'property', price: 400000, roles: [], desc: t('滨海湾顶层，睡觉饥饿只扣 5，次日 XP +10%。'),
    poi: ['landmark_marina_bay_sands', 'landmark_merlion'], rest: { hunger: 5, xpMul: 1.1 } },
  // ---- 升级 ----
  { id: 'upg_armor', name: t('防弹衣'), kind: 'upgrade', price: 800, roles: ['gang'], desc: t('受到的伤害 −30%。'), effect: { armor: 0.3 } },
  { id: 'upg_pistol', name: t('改装手枪'), kind: 'upgrade', price: 1500, roles: ['gang'], desc: t('枪械伤害 ×1.5。'), effect: { dmgMul: 1.5 } },
  { id: 'upg_engine', name: t('引擎套件'), kind: 'upgrade', price: 2000, roles: [], desc: t('你驾驶的车加速 ×1.2、极速 ×1.05。'), effect: { accelMul: 1.2, maxFwdMul: 1.05 } },
  { id: 'upg_ergo', name: t('人体工学装备'), kind: 'upgrade', price: 400, roles: [], desc: t('饥饿与精力消耗 ×0.85。'), effect: { needsMul: 0.85 } },
  { id: 'upg_ridehail', name: t('网约车 App'), kind: 'upgrade', price: 600, roles: ['blue'], desc: t('的士小费 ×1.2。'), effect: { taxiTipMul: 1.2 } },
  { id: 'upg_bloomberg', name: t('彭博终端'), kind: 'upgrade', price: 5000, roles: ['gold'], desc: t('提前看到市场事件。') },
  { id: 'upg_avionics', name: t('航电升级'), kind: 'upgrade', price: 6000, roles: [], desc: t('飞行 HUD 加下滑道指示，T 键定高定向。') },
  // ---- 飞机（Phase AIR：停在滨海南机场机库，标签前缀 plane_） ----
  { id: 'plane_cessna', name: t('二手 Cessna 172'), kind: 'aircraft', price: 48000, roles: [], desc: t('飞行俱乐部转手的教练机，停在机库停机位，随取随飞。'),
    aircraft: { paint: 0x2f6f4f } },
  { id: 'plane_cessna_turbo', name: t('Cessna 涡轮改装版'), kind: 'aircraft', price: 95000, roles: [], desc: t('涡轮增压改装：推力 ×1.25、极速 ×1.12。'),
    aircraft: { paint: 0x1c1f26, tune: { thrust: 1.25, vmax: 1.12 } } },
  { id: 'plane_cessna_vip', name: t('Cessna VIP 金色涂装'), kind: 'aircraft', price: 180000, roles: ['gold'], desc: t('金色涂装的 VIP 座舱：推力 ×1.25、极速 ×1.12，商务包机报酬 +20%。'),
    aircraft: { paint: 0xd4a72c, tune: { thrust: 1.25, vmax: 1.12 }, payMul: 1.2 } },
]

export const SHOP_BY_ID = new Map(SHOP.map((s) => [s.id, s]))
export const shopItem = (id: string) => SHOP_BY_ID.get(id)
export const canRoleBuy = (it: ShopItem, role: RoleId) => !it.roles.length || it.roles.includes(role)
