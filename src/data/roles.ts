/** 玩家身份定义：决定初始资金、可用系统与需求衰减速度（建角色界面与 Law/Needs 共用） */
import { t } from '../i18n'
export type RoleId = 'gang' | 'gold' | 'white' | 'blue'

export interface RoleDef {
  id: RoleId
  title: string
  desc: string
  home: string          // 出生/家的 POI id：home_gang 等
  cash: number          // 初始现金
  systems: {
    gun: boolean        // 可开枪（射击输入、武器 HUD）
    wanted: boolean     // 犯罪走通缉星逻辑；否则犯罪事件降级为交通执法
    luxury: boolean     // 奢侈消费线
    rent: boolean       // 房租压力线
  }
  needsRate: number     // 需求衰减倍率（1 = 基准）
}

export const ROLES: Record<RoleId, RoleDef> = {
  gang: {
    id: 'gang', title: t('黑帮成员'), desc: t('街头讨生活：偷车、火拼、躲警察。'), home: 'home_gang', cash: 500,
    systems: { gun: true, wanted: true, luxury: false, rent: false }, needsRate: 1,
  },
  gold: {
    id: 'gold', title: t('金领'), desc: t('资本玩家：豪车、会所、投资。'), home: 'home_gold', cash: 20000,
    systems: { gun: false, wanted: false, luxury: true, rent: false }, needsRate: 1,
  },
  white: {
    id: 'white', title: t('白领'), desc: t('朝九晚五，房租与 KPI 两头烧。'), home: 'home_white', cash: 2000,
    systems: { gun: false, wanted: false, luxury: false, rent: true }, needsRate: 1,
  },
  blue: {
    id: 'blue', title: t('蓝领'), desc: t('工地与小贩中心之间奔波，手停口停。'), home: 'home_blue', cash: 300,
    systems: { gun: false, wanted: false, luxury: false, rent: true }, needsRate: 1.3,
  },
}

export const DEFAULT_ROLE: RoleId = 'gang'
export const isRoleId = (v: unknown): v is RoleId => typeof v === 'string' && v in ROLES
