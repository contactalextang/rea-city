import type { RoleId } from './roles'
import { t } from '../i18n'

/**
 * 成长数据：等级曲线、身份头衔、等级门槛表（商店 / 产业唯一的解锁来源）、成就定义、XP 来源数值。
 * Progress 系统按这里结算；P8.2 商店与 P8.3 产业只从 UNLOCKS 读门槛，不在自己的表里另写等级。
 */

export const MAX_LEVEL = 30

/** 从 L 级升到 L+1 级所需 XP：round(100·L^1.6)（Lv1→2 要 100，Lv10→11 约 3981） */
export const xpFor = (level: number) => Math.round(100 * Math.pow(level, 1.6))

/** XP 来源（数值见计划 P8.1）：收入每 $10 得 1，任务得奖励的 1/5，购买 cost/50（上限 200），产业收入 /20 */
export const XP = {
  perJobDollar: 1 / 10,
  questRewardDiv: 5,
  ate: 2,
  slept: 10,
  clockIn: 15,
  purchaseDiv: 50,
  purchaseCap: 200,
  bizIncomeDiv: 20,
  // ---- P10 娱乐（适度：一晚娱乐 ≈ 打一会儿工的 XP，避免刷级） ----
  /** 每局赌博（下注 ≥ gambleMinBet 才给，防 $1 刷局） */
  gambleRound: 1,
  gambleMinBet: 10,
  /** 赛车名次 XP（1–3 名），其余完赛 raceFinish */
  racePlace: [0, 60, 40, 25] as readonly number[],
  raceFinish: 15,
  matchWin: 80,
  matchLose: 30,
  perKill: 3,
  killCap: 60,
  dated: 20,
} as const

/** 每身份 6 个头衔，每 5 级换一个：Lv1–4 / 5–9 / 10–14 / 15–19 / 20–24 / 25–30 */
export const TITLES: Record<RoleId, readonly string[]> = {
  gang: [t('小弟'), t('打手'), t('头目'), t('堂主'), t('话事人'), t('教父')],
  gold: [t('理财新秀'), t('基金经理'), t('合伙人'), t('私募大佬'), t('家族办公室'), t('金融巨鳄')],
  white: [t('实习生'), t('专员'), t('主管'), t('经理'), t('总监'), 'CEO'],
  blue: [t('散工'), t('熟练工'), t('工头'), t('小老板'), t('承包商'), t('大头家')],
}
export const titleFor = (role: RoleId, level: number) => {
  const t = TITLES[role]
  return t[Math.min(t.length - 1, Math.floor(Math.max(1, level) / 5))]
}

/**
 * 等级门槛：某身份要到 level 级才能买 id（商店物品 / 产业类型）。
 * 表里没有某身份的条目 = 该身份对这个物品没有等级门槛（能不能买由物品自己的 roles 决定）。
 * 商店物品 id：car_used / car_taxi / car_sports / car_super、home_hdb / home_shophouse / home_condo / home_penthouse、
 *   upg_armor / upg_pistol / upg_engine / upg_ergo / upg_ridehail / upg_bloomberg（只有带等级的列在下面）。
 * 产业 id：biz_protect / biz_chop / biz_gamble、biz_hawker / biz_fleet、biz_startup / biz_cafe、biz_rental / biz_office / biz_landmark。
 */
export interface Unlock { level: number; roles: RoleId[]; id: string; label: string }
const ALL_ROLES: RoleId[] = ['gang', 'gold', 'white', 'blue']
export const UNLOCKS: Unlock[] = [
  // ---- 商店（P8.2） ----
  { level: 5, roles: ['gang'], id: 'upg_pistol', label: t('改装手枪（伤害 ×1.5）') },
  { level: 8, roles: ['gang'], id: 'car_sports', label: t('跑车') },
  { level: 10, roles: ['gold'], id: 'car_super', label: t('超跑') },
  // ---- 产业（P8.3） ----
  { level: 1, roles: ['gang'], id: 'biz_protect', label: t('保护费地盘') },
  { level: 6, roles: ['gang'], id: 'biz_chop', label: t('拆车厂') },
  { level: 12, roles: ['gang'], id: 'biz_gamble', label: t('地下赌档') },
  { level: 1, roles: ['blue'], id: 'biz_hawker', label: t('小贩档口') },
  { level: 4, roles: ['blue'], id: 'biz_fleet', label: t('的士车队') },
  { level: 1, roles: ['white'], id: 'biz_startup', label: t('创业公司') },
  { level: 8, roles: ['white'], id: 'biz_cafe', label: t('咖啡连锁') },
  { level: 1, roles: ['gold'], id: 'biz_rental', label: t('商铺出租') },
  { level: 5, roles: ['gold'], id: 'biz_office', label: t('写字楼股份') },
  { level: 12, roles: ['gold'], id: 'biz_landmark', label: t('地标项目') },
  // ---- 娱乐（P10，由各娱乐子系统用 isUnlocked(role, level, id) 读取） ----
  { level: 3, roles: ALL_ROLES, id: 'club_vip', label: t('夜店 VIP 卡座') },
  { level: 4, roles: ALL_ROLES, id: 'arena_ranked', label: t('竞技场天梯（排位赛）') },
  { level: 6, roles: ALL_ROLES, id: 'race_pro', label: t('高级赛事（滨海湾全程）') },
  { level: 6, roles: ALL_ROLES, id: 'casino_high', label: t('高额赌桌') },
  { level: 10, roles: ALL_ROLES, id: 'casino_vip', label: t('VIP 赌厅') },
  { level: 12, roles: ALL_ROLES, id: 'arena_pro', label: t('职业难度 Bot') },
]

/** 该身份买 id 需要的等级（无门槛 = 1） */
export function unlockLevel(role: RoleId, id: string): number {
  let lv = 1
  for (const u of UNLOCKS) if (u.id === id && u.roles.includes(role)) lv = Math.max(lv, u.level)
  return lv
}
export const isUnlocked = (role: RoleId, level: number, id: string) => level >= unlockLevel(role, id)
/** 该身份接下来（> level）会解锁的条目，按等级升序 */
export const nextUnlocks = (role: RoleId, level: number) =>
  UNLOCKS.filter((u) => u.roles.includes(role) && u.level > level).sort((a, b) => a.level - b.level)

/** 成就（12 + 8 个 P10 娱乐）：条件由 Progress.check 判断 */
export type AchievementId =
  | 'first_buy' | 'first_biz' | 'biz_3' | 'nw_10k' | 'nw_100k' | 'nw_1m'
  | 'lv_10' | 'lv_20' | 'taxi_100' | 'survive_raid' | 'buy_car' | 'two_homes'
  | 'first_bet' | 'high_roller' | 'race_win' | 'race_10' | 'arena_win' | 'streak_5' | 'headshot_king' | 'lover' | 'no_drive' | 'race_legend' | 'arena_legend'
export const ACHIEVEMENTS: { id: AchievementId; name: string; desc: string }[] = [
  { id: 'first_buy', name: t('第一笔消费'), desc: t('在商店买下第一件东西') },
  { id: 'first_biz', name: t('开门营业'), desc: t('拥有第一个产业') },
  { id: 'biz_3', name: t('连锁经营'), desc: t('同时拥有 3 个产业') },
  { id: 'nw_10k', name: t('小有积蓄'), desc: t('净资产达到 $10,000') },
  { id: 'nw_100k', name: t('十万身家'), desc: t('净资产达到 $100,000') },
  { id: 'nw_1m', name: t('百万富翁'), desc: t('净资产达到 $1,000,000') },
  { id: 'lv_10', name: t('站稳脚跟'), desc: t('达到 10 级') },
  { id: 'lv_20', name: t('狮城名人'), desc: t('达到 20 级') },
  { id: 'taxi_100', name: t('路路通'), desc: t('累计完成 100 趟的士') },
  { id: 'survive_raid', name: t('大难不死'), desc: t('产业挺过一次突袭') },
  { id: 'buy_car', name: t('有车一族'), desc: t('买下自己的车') },
  { id: 'two_homes', name: t('两处物业'), desc: t('名下有两套房产') },
  { id: 'first_bet', name: t('第一次下注'), desc: t('在赌场玩完第一局') },
  { id: 'high_roller', name: t('赌神'), desc: t('单局净赢 $10,000') },
  { id: 'race_win', name: t('街头赛冠军'), desc: t('赢下一场赛车') },
  { id: 'race_10', name: t('滨海湾车神'), desc: t('累计赢下 10 场赛车') },
  { id: 'arena_win', name: t('初尝胜果'), desc: t('赢下一局射击比赛') },
  { id: 'streak_5', name: t('五连胜'), desc: t('射击比赛连胜 5 局') },
  { id: 'headshot_king', name: t('爆头王'), desc: t('射击比赛累计爆头 50 次') },
  { id: 'lover', name: t('恋人'), desc: t('和一位约会对象成为恋人') },
  { id: 'race_legend', name: t('传奇车手'), desc: t('在 T10 传奇难度赢下一场赛车') },
  { id: 'arena_legend', name: t('传奇枪手'), desc: t('在 T10 传奇难度赢下一局射击比赛') },
  { id: 'no_drive', name: t('不想开车'), desc: t('用手机叫车（Taxi / Grab）出行 10 次') },
]
