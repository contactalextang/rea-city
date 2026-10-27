import type { RoleId } from './roles'
import { t } from '../i18n'
import type { PoiType } from '../systems/Poi'

/**
 * 产业表（P8.3，Schedule I 式被动收入）：每种产业挂在某类 POI 上，一个 POI 至多一个产业。
 * tiers[i].cost = 买下（i=0）或升级到第 i+1 档的价格；perDay = 该档每日收入；cap = 钱柜上限（= 一天收入）。
 * 等级门槛只在 data/progression.ts 的 UNLOCKS 里（id 相同），这里的 level 仅作展示冗余，以 UNLOCKS 为准。
 */
export interface BizTier { cost: number; perDay: number; cap: number }
export interface BizRisk {
  /** 每日被对头突袭的基础概率（黑帮；每颗星再 +raidPerStar） */
  raidPerDay: number
  raidPerStar?: number
  /** 每日被警察查封（停业一天）的概率 */
  inspectPerDay?: number
  /** 买入时增加的热度（黑帮地盘） */
  heatOnBuy?: number
  /** 突袭损失钱柜比例 */
  lossPct: number
}
export interface BizType {
  id: string
  name: string
  roles: RoleId[]
  poiType: PoiType
  level: number
  /** 档位单位（的士车队按「辆」） */
  unit?: string
  tiers: BizTier[]
  manager: { cost: number; cut: number }
  risk: BizRisk
  maxOwned: number
  desc: string
}

const tt = (cost: number, perDay: number): BizTier => ({ cost, perDay, cap: perDay })
const GANG_RISK: BizRisk = { raidPerDay: 0.08, raidPerStar: 0.04, inspectPerDay: 0.05, lossPct: 0.5 }
const SAFE: BizRisk = { raidPerDay: 0, lossPct: 0 }
/** 经理：费用 = T1 价 × 3，自动入账 80% */
const mgr = (t1: number) => ({ cost: t1 * 3, cut: 0.8 })

export const BIZ_TYPES: BizType[] = [
  // ---- 黑帮 ----
  { id: 'biz_protect', name: t('保护费地盘'), roles: ['gang'], poiType: 'shop', level: 1, tiers: [tt(600, 240), tt(1200, 760), tt(2600, 1900)], manager: mgr(600), risk: { ...GANG_RISK, heatOnBuy: 0.3 }, maxOwned: 6, desc: t('罩着这家店，每天按时交数') },
  { id: 'biz_chop', name: t('拆车厂'), roles: ['gang'], poiType: 'site', level: 6, tiers: [tt(5000, 1500), tt(15000, 4000)], manager: mgr(5000), risk: { ...GANG_RISK, heatOnBuy: 0.5 }, maxOwned: 2, desc: t('偷来的车在这里拆件转卖') },
  { id: 'biz_gamble', name: t('地下赌档'), roles: ['gang'], poiType: 'hawker', level: 12, tiers: [tt(25000, 6000), tt(80000, 15000)], manager: mgr(25000), risk: { ...GANG_RISK, heatOnBuy: 0.8 }, maxOwned: 1, desc: t('熟食中心楼上的麻将馆') },
  // ---- 蓝领 ----
  { id: 'biz_hawker', name: t('小贩档口'), roles: ['blue'], poiType: 'hawker', level: 1, tiers: [tt(400, 150), tt(900, 500), tt(2000, 1300)], manager: mgr(400), risk: SAFE, maxOwned: 4, desc: t('炒粿条档，请个帮手就能开') },
  { id: 'biz_fleet', name: t('的士车队'), roles: ['blue'], poiType: 'taxi', level: 4, unit: t('辆'), tiers: [tt(3000, 600), tt(3000, 1200), tt(3000, 1800), tt(3000, 2400), tt(3000, 3000)], manager: mgr(3000), risk: SAFE, maxOwned: 2, desc: t('每辆 $3k、每天 $600，一个车站最多 5 辆') },
  // ---- 白领 ----
  { id: 'biz_startup', name: t('创业公司'), roles: ['white'], poiType: 'office', level: 1, tiers: [tt(2000, 500), tt(2000, 1200), tt(4000, 2600)], manager: mgr(2000), risk: SAFE, maxOwned: 2, desc: t('租一层共享办公，做 SaaS') },
  { id: 'biz_cafe', name: t('咖啡连锁'), roles: ['white'], poiType: 'shop', level: 8, tiers: [tt(15000, 3000)], manager: mgr(15000), risk: SAFE, maxOwned: 3, desc: t('精品咖啡加盟店') },
  // ---- 金领 ----
  { id: 'biz_rental', name: t('商铺出租'), roles: ['gold'], poiType: 'shop', level: 1, tiers: [tt(8000, 2000)], manager: mgr(8000), risk: SAFE, maxOwned: 3, desc: t('买下店面收租') },
  { id: 'biz_office', name: t('写字楼股份'), roles: ['gold'], poiType: 'office', level: 5, tiers: [tt(15000, 3600)], manager: mgr(15000), risk: SAFE, maxOwned: 2, desc: t('甲级写字楼的一成股份') },
  { id: 'biz_landmark', name: t('地标项目'), roles: ['gold'], poiType: 'landmark', level: 12, tiers: [tt(250000, 35000)], manager: mgr(250000), risk: SAFE, maxOwned: 1, desc: t('参股城市地标综合体') },
]

export const bizType = (id: string) => BIZ_TYPES.find((b) => b.id === id) ?? null
export const bizTypesFor = (role: RoleId) => BIZ_TYPES.filter((b) => b.roles.includes(role))

/** 亲自收钱的奖励倍率 */
export const COLLECT_BONUS = 1.1
/** 每日景气 / 低迷概率与倍率（全身份） */
export const MOOD_EVENTS = { boom: { p: 0.1, mul: 1.3 }, slump: { p: 0.1, mul: 0.7 } }
/** 产业估值 = 已投入成本 × 0.8 */
export const BIZ_RESALE = 0.8
/** 每日风险掷骰时刻 */
export const RISK_HOUR = 7
