import type { Clock } from './Clock'
import { clamp } from '../config'
import { playerEffects } from './Assets'
import type { EventBus } from '../core/Context'

export const NEED_LOW = 20

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

/**
 * 生存需求：hunger / energy 0–100。按游戏小时差推进（clock.skip 大跳也按跳过小时扣）；
 * 交互里有明确数值效果的大跳（睡觉、上班、搬运）在跳完后调用 sync() 避免重复扣除。
 */
export class Needs {
  hunger = 80
  energy = 100
  /** 心情 0–100（见 MOOD） */
  private _mood: number = MOOD.start
  private lastAbs: number
  constructor(private clock: Clock, private rate = 1) { this.lastAbs = clock.absHours }

  /** 推进；running 为玩家是否奔跑。返回 true 表示 energy 已归零（Game 处理昏倒并回填精力） */
  update(running: boolean): boolean {
    const now = this.clock.absHours
    let dh = now - this.lastAbs
    this.lastAbs = now
    if (dh > 0) {
      if (dh > 48) dh = 48   // 读档/调试大跳保护
      const k = playerEffects().needsMul   // 人体工学装备 ×0.85
      this.hunger = clamp(this.hunger - 6 * this.rate * k * dh, 0, 100)
      this.energy = clamp(this.energy - (4 * this.rate + (running ? 2 : 0)) * k * dh, 0, 100)
      if (this._mood > MOOD.decayFloor) this._mood = Math.max(MOOD.decayFloor, this._mood - MOOD.decayPerHour * dh)
    }
    return this.energy <= 0
  }

  /** 与时钟对齐（跳时间后调用，不扣需求） */
  sync() { this.lastAbs = this.clock.absHours }

  set(h: number, e: number) { this.hunger = clamp(h, 0, 100); this.energy = clamp(e, 0, 100) }
  add(h: number, e: number) { this.set(this.hunger + h, this.energy + e) }

  get mood() { return this._mood }
  set mood(v: number) { this._mood = clamp(Number.isFinite(v) ? v : MOOD.start, 0, 100) }
  /** 加减心情；floor 给定时，负向变化不会把心情压到 floor 以下（已低于 floor 则不再扣） */
  addMood(n: number, floor?: number) {
    if (n < 0 && floor !== undefined) { if (this._mood <= floor) return; this.mood = Math.max(floor, this._mood + n); return }
    this.mood = this._mood + n
  }
  /** XP / 工资倍率：< 30 ×0.85，> 75 ×1.1，其余 ×1 */
  get moodMul() { return this._mood < MOOD.low ? MOOD.lowMul : this._mood > MOOD.high ? MOOD.highMul : 1 }
  /** 心情档位文字 */
  get moodLabel() { return this._mood < MOOD.low ? '低落' : this._mood > MOOD.high ? '愉快' : '平静' }

  get low() { return this.hunger < NEED_LOW || this.energy < NEED_LOW }
  /** 步行/奔跑速度倍率 */
  get speedMul() { return this.low ? 0.7 : 1 }
}

/** 心情事件规则（Game 构造后调用一次）：吃饭 / 睡觉 / 上班 / 娱乐事件 → 心情增减 */
export function wireMood(ev: EventBus, needs: Needs) {
  ev.on('ate', () => needs.addMood(MOOD.ate))
  ev.on('slept', () => { needs.addMood(MOOD.slept); if (needs.mood < MOOD.sleepFloor) needs.mood = MOOD.sleepFloor })
  ev.on('clockIn', () => needs.addMood(MOOD.clockIn, MOOD.workFloor))
  // white_shift 与 clockIn 同时发，已在 clockIn 扣过
  ev.on('jobDone', ({ job }) => { if (job !== 'white_shift') needs.addMood(job === 'blue_site' ? MOOD.siteHour : MOOD.jobDone, MOOD.workFloor) })
  // 赌输只扣到 workFloor：小注连输不至于把心情刷到惩罚档
  ev.on('gambled', ({ net }) => { if (net > 0) needs.addMood(MOOD.gambleWin); else if (net < 0) needs.addMood(MOOD.gambleLose, MOOD.workFloor) })
  ev.on('raceDone', ({ place }) => needs.addMood(place === 1 ? MOOD.raceWin : MOOD.raceDone))
  ev.on('matchDone', ({ won }) => needs.addMood(won ? MOOD.matchWin : MOOD.matchDone))
  ev.on('dated', () => needs.addMood(MOOD.dated))
  ev.on('drank', ({ n }) => needs.addMood(Math.min(12, Math.max(0, n) * MOOD.drink)))
}
