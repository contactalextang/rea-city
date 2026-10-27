import type { RoleId } from '../../../data/roles'

/**
 * Phase AIR.5 飞行工作数值（纯数据，不依赖 three / i18n：scripts/test/econ-sim.ts 直接引用校准）。
 * 报酬单位美元；落地倍率按 flightLanded.grade；结算标签 '<role>_air_<kind>'（Wallet 归 job 类）。
 */
export type FlightJobKind = 'tour' | 'photo' | 'drop' | 'charter'
export const ROLE_FLIGHT_JOB: Record<RoleId, FlightJobKind> = { blue: 'tour', white: 'photo', gang: 'drop', gold: 'charter' }
/** 结算 / jobDone 用的工作 id */
export const flightJobId = (role: RoleId, kind: FlightJobKind = ROLE_FLIGHT_JOB[role]) => `${role}_air_${kind}`

/** 机库租机：每次 $300，当天有效；坠毁自付 $2,000 */
export const RENT_PRICE = 300
export const RENT_INSURANCE = 2000
/** 自有飞机坠毁后维修价 = 买价 × 5% */
export const REPAIR_SHARE = 0.05

/** 落地倍率 */
export const GRADE_MUL = { perfect: 1.2, normal: 1.0, hard: 0.7 } as const

/** 每个游戏日最多接几单飞行工作（塔台排班；econ-sim 校准，防止飞行收入压过本身份主业） */
export const FLIGHT_JOBS_PER_DAY = 2

export const FLIGHT_PAY = {
  /** 蓝领观光：基础 + 舒适奖励（满分 100 时）+ 时间奖励上限（在 par 秒内完成给满） */
  tour: { base: 450, comfortMax: 250, timeMax: 100, gates: 3, passengers: [2, 4] as const },
  /** 白领航拍：每张合格照片 */
  photo: { perShot: 250, shots: 3 },
  /** 黑帮空投：每个命中（25 m 内） */
  drop: { perHit: 400, packages: 3, hitRadius: 25 },
  /** 金领包机：一单（× 落地倍率 × 涂装 payMul） */
  charter: { base: 1200 },
} as const

/** 典型玩家一单的真实秒数（econ-sim 用：机库 → 起飞 → 目标 → 回跑道落地；不含去机场的路程） */
export const FLIGHT_JOB_SEC: Record<FlightJobKind, number> = { tour: 330, photo: 300, drop: 300, charter: 300 }
