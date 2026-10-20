// 心情常量（纯数据，Node 端 econ-sim 也直接 import）；Needs.ts 重新导出
/**
 * 心情（mood 0–100，默认 70）：清醒时缓降 3/h，但自然衰减到 40 为止（不玩娱乐也不会被罚）；
 * 被捕 / 倒下、上班会继续往下扣，娱乐 / 约会 / 吃饭 / 睡觉加。
 * < 30 → XP 与工资 ×0.85；> 75 → ×1.1（Progress.addXp 与 Wallet.earn('job') 读 moodMul）。
 */
export const MOOD = {
  start: 70,
  decayPerHour: 3,
  /** 自然衰减的下限 */
  decayFloor: 40,
  low: 30,
  high: 75,
  lowMul: 0.85,
  highMul: 1.1,
  // ---- 事件增减（wireMood 里接线；被捕/倒下由 Game.respawn 扣） ----
  ate: 2,
  /** 睡一觉 +10，且至少回到 sleepFloor */
  slept: 10,
  sleepFloor: 50,
  busted: -10,
  dead: -15,
  /** 打卡上班一整天（跳到 18:00，期间不自然衰减） */
  clockIn: -8,
  /** 工地搬运 1 小时（跳时 1 h，抵掉这 1 h 不衰减的心情） */
  siteHour: -3,
  /** 其他工作每完成一单；工作类扣减不会把心情扣到 workFloor 以下 */
  jobDone: -1,
  workFloor: 35,
  gambleWin: 4,
  gambleLose: -2,
  raceWin: 12,
  raceDone: 5,
  matchWin: 10,
  matchDone: 4,
  dated: 12,
  /** 每杯酒，单次 drank 事件封顶 +12 */
  drink: 4,
} as const
