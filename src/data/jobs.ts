/** 工作系统文案与数值参数（集中放这里便于调平衡；逻辑见 systems/Jobs.ts） */
import type { RoleId } from './roles'

export interface JobText { id: string; title: string; roles: RoleId[]; desc: string }

export const JOB_TEXT: JobText[] = [
  { id: 'gang_steal', title: '偷车交货', roles: ['gang'], desc: '抢指定的路上车辆，限时开到销赃点。$400 + 车况加成。' },
  { id: 'gang_protect', title: '收保护费', roles: ['gang'], desc: '依次走访 3 家店，每家按 E 收 $60–120；店家可能报警。' },
  { id: 'gang_wreck', title: '街头破坏', roles: ['gang'], desc: '90 秒内撞毁 4 辆车，然后甩掉警察（热度归零）。' },
  { id: 'gold_meeting', title: '赶会议', roles: ['gold'], desc: '限时赶到指定办公楼（每公里 60 秒）。$300，迟到减半。' },
  { id: 'gold_invest', title: '投资', roles: ['gold'], desc: '定存 / 指数 / 加密货币，每天 07:00 结算。' },
  { id: 'white_shift', title: '上班', roles: ['white', 'gold'], desc: '09:00–18:00 到办公楼门口按 E 打卡，干到下班领薪。' },
  { id: 'white_overtime', title: '加班', roles: ['white'], desc: '18:00–22:00 在办公楼门口按 E 加班 2 小时，+$80。' },
  { id: 'blue_taxi', title: '的士载客', roles: ['blue'], desc: '在的士里开工：接招手乘客（4 m 内按 F），送到目的地按表计费。' },
  { id: 'blue_delivery', title: '外卖', roles: ['blue'], desc: '接单后去小贩中心取餐（E），限时送到住家/办公楼。$6 + $1/km，超时 $3。' },
  { id: 'blue_site', title: '工地搬运', roles: ['blue'], desc: '到工地门口按 E，搬一小时建材现结 $18。' },
]

export const JOB_PARAMS = {
  steal: { timeLimit: 150, reward: 400, deliverRadius: 10, pickMin: 60, pickMax: 220 },
  protect: { stores: 3, min: 60, max: 120, policeChance: 0.3, heat: 0.5 },
  wreck: { count: 4, timeLimit: 90, reward: 600 },
  meeting: { secPerKm: 60, minSec: 30, reward: 300, radius: 6 },
  overtime: { from: 18, to: 22, hours: 2, pay: 80 },
  taxi: {
    base: 4.4, baseKm: 1000, unitM: 400, unitFare: 0.26, waitSec: 45, waitFare: 0.26,
    peakMul: 1.25, peaks: [[7, 9.5], [18, 24]] as [number, number][],
    tipRating: 4, tip: 0.1, pickupRadius: 4, hailMin: 40, hailMax: 150, arriveRadius: 8, arriveSpeed: 1.5, settleSec: 3, crashImpulse: 4,
    /** 目的地门口到最近车道中心线的最大距离：超过的 POI（门在楼里/离路太远）不当目的地，否则车停不进 arriveRadius */
    destLaneMax: 6,
  },
  delivery: { secPerKm: 90, minSec: 60, base: 6, perKm: 1, late: 3, radius: 6 },
} as const

export type AssetId = 'fixed' | 'index' | 'crypto'
export interface AssetDef { id: AssetId; name: string; desc: string; min: number; max: number }
/** 三档资产：日收益率区间（定存固定、指数 ±2%、币 ±8%） */
export const ASSETS: AssetDef[] = [
  { id: 'fixed', name: '定期存款', desc: '0.1%/天，稳稳的', min: 0.001, max: 0.001 },
  { id: 'index', name: '海峡指数', desc: '±2%/天', min: -0.02, max: 0.02 },
  { id: 'crypto', name: '加密货币', desc: '±8%/天，心脏要好', min: -0.08, max: 0.08 },
]
export const INVEST_AMOUNTS = [100, 1000, 10000]
