/**
 * P10.B 赌场（滨海湾金沙）数据：赌厅限额、五个游戏的赔率表。
 * 规则逻辑（发牌、补牌、结算）在 src/activities/casino/rules.ts，纯函数，scripts/casino-sim.ts 直接调用。
 * 本文件不依赖 DOM / three，Node 原生可跑。
 */
import { t } from '../i18n'

export type CasinoGameId = 'blackjack' | 'roulette' | 'sicbo' | 'baccarat' | 'slots'
export const CASINO_GAMES: { id: CasinoGameId; name: string; desc: string }[] = [
  { id: 'blackjack', name: t('21 点'), desc: t('6 副牌 · 庄家软 17 停 · 黑杰克 3:2') },
  { id: 'roulette', name: t('轮盘'), desc: t('欧式单零 · 直注 35:1') },
  { id: 'sicbo', name: t('骰宝'), desc: t('大小 1:1（围骰庄赢）· 全围 30:1') },
  { id: 'baccarat', name: t('百家乐'), desc: t('庄 0.95:1 · 闲 1:1 · 和 8:1') },
  { id: 'slots', name: t('老虎机'), desc: t('3 轴 5 线 · RTP≈94%') },
]
export const gameName = (id: string) => CASINO_GAMES.find((g) => g.id === id)?.name ?? id

export type HallId = 'main' | 'high' | 'vip'
export interface HallDef {
  id: HallId
  name: string
  /** 单局总注下限 / 上限（21 点为首注；加倍、分牌追加不受上限约束） */
  min: number
  max: number
  /** 筹码面额 */
  chips: number[]
  /** progression.ts 的解锁 id（null = 无门槛） */
  unlock: string | null
}
export const HALLS: HallDef[] = [
  { id: 'main', name: t('普通厅'), min: 10, max: 500, chips: [10, 25, 50, 100, 500], unlock: null },
  { id: 'high', name: t('高额厅'), min: 100, max: 5000, chips: [100, 500, 1000, 2500, 5000], unlock: 'casino_high' },
  { id: 'vip', name: t('VIP 厅'), min: 1000, max: 50000, chips: [1000, 5000, 10000, 25000, 50000], unlock: 'casino_vip' },
]
export const hallById = (id: string) => HALLS.find((h) => h.id === id) ?? HALLS[0]

// ---------------- 21 点 ----------------
export const BJ = {
  decks: 6,
  /** 发到这个比例就洗牌（切牌位置） */
  penetration: 0.75,
  /** 黑杰克赔 3:2 */
  blackjackPays: 1.5,
  /** 保险赔 2:1 */
  insurancePays: 2,
  /** 最多分成几手 */
  maxHands: 4,
  /** 庄家软 17 停（S17） */
  dealerHitsSoft17: false,
  /** 分牌后可加倍（DAS） */
  doubleAfterSplit: true,
  /** 理论 RTP（6D S17 DAS 不可再分 A、无投降，基本策略） */
  theoryRtp: 0.996,
}

// ---------------- 轮盘（欧式单零） ----------------
/** 欧式轮盘转盘上的号码顺序（顺时针，从 0 开始） */
export const WHEEL_ORDER = [0, 32, 15, 19, 4, 21, 2, 25, 17, 34, 6, 27, 13, 36, 11, 30, 8, 23, 10, 5, 24, 16, 33, 1, 20, 14, 31, 9, 22, 18, 29, 7, 28, 12, 35, 3, 26]
export const RED_NUMBERS = new Set([1, 3, 5, 7, 9, 12, 14, 16, 18, 19, 21, 23, 25, 27, 30, 32, 34, 36])
export type RouletteBetKind = 'straight' | 'red' | 'black' | 'odd' | 'even' | 'low' | 'high' | 'dozen' | 'column'
/** 赔率（x:1，赢了返还本金 + x 倍） */
export const ROULETTE_PAYS: Record<RouletteBetKind, number> = {
  straight: 35, red: 1, black: 1, odd: 1, even: 1, low: 1, high: 1, dozen: 2, column: 2,
}
export const ROULETTE_RTP = 36 / 37

// ---------------- 骰宝（澳门 / 新加坡常见赔率表） ----------------
export type SicboBetKind = 'small' | 'big' | 'odd' | 'even' | 'single' | 'total' | 'anyTriple' | 'triple' | 'double'
export const SICBO_PAYS = {
  /** 小 4–10 / 大 11–17，遇围骰庄赢 */
  small: 1, big: 1, odd: 1, even: 1,
  /** 单点：出现 1 / 2 / 3 颗赔 1 / 2 / 3 */
  single: [0, 1, 2, 3] as const,
  /** 总点数 4–17 */
  total: { 4: 60, 5: 30, 6: 17, 7: 12, 8: 8, 9: 6, 10: 6, 11: 6, 12: 6, 13: 8, 14: 12, 15: 17, 16: 30, 17: 60 } as Record<number, number>,
  /** 全围（任意三同） */
  anyTriple: 30,
  /** 指定围骰 */
  triple: 180,
  /** 指定对子（至少两颗） */
  double: 11,
}

// ---------------- 百家乐 ----------------
export const BACCARAT = {
  decks: 8,
  penetration: 0.8,
  /** 庄赢抽 5% → 0.95:1 */
  bankerPays: 0.95,
  playerPays: 1,
  tiePays: 8,
  theory: { banker: 0.98942, player: 0.98764, tie: 0.85640 },
}

// ---------------- 老虎机（3 轴 × 3 行，5 条线） ----------------
export type SlotSym = 'cherry' | 'lemon' | 'orange' | 'plum' | 'bell' | 'bar' | 'seven' | 'merlion'
export const SLOT_SYMS: { id: SlotSym; label: string; color: string }[] = [
  { id: 'cherry', label: t('樱桃'), color: '#e5383b' },
  { id: 'lemon', label: t('柠檬'), color: '#ffd60a' },
  { id: 'orange', label: t('橙子'), color: '#fb8500' },
  { id: 'plum', label: t('李子'), color: '#9d4edd' },
  { id: 'bell', label: t('铃铛'), color: '#f4c430' },
  { id: 'bar', label: 'BAR', color: '#e9ecef' },
  { id: 'seven', label: '7', color: '#ff2d55' },
  { id: 'merlion', label: t('鱼尾狮'), color: '#4cc9f0' },
]
/** 每条轴的符号带（每轴 32 格，三轴相同；停位均匀随机） */
export const SLOT_STRIP_COUNTS: Record<SlotSym, number> = {
  cherry: 5, lemon: 7, orange: 6, plum: 5, bell: 4, bar: 3, seven: 1, merlion: 1,
}
/** 三连赔率（× 每线注，含本金） */
export const SLOT_PAYS_3: Record<SlotSym, number> = {
  cherry: 20, lemon: 12, orange: 16, plum: 26, bell: 40, bar: 60, seven: 300, merlion: 1000,
}
/** 樱桃：第 1 轴起连续 1 / 2 颗（不足三连时）赔 × 每线注 */
export const SLOT_CHERRY = { one: 2, two: 5 }
/** 5 条线：每条给出三轴各自的行号（0 上 1 中 2 下） */
export const SLOT_LINES: [number, number, number][] = [
  [1, 1, 1], [0, 0, 0], [2, 2, 2], [0, 1, 2], [2, 1, 0],
]
export const SLOT_TARGET_RTP = 0.94
