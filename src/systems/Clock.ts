import { GAME_HOUR_SEC } from '../config'

export type Phase = 'dawn' | 'day' | 'dusk' | 'night'

/** 游戏时钟：day 从 1 起，hour 为 0–24 浮点；现实 GAME_HOUR_SEC 秒 = 游戏 1 小时，再乘 speed */
export class Clock {
  day = 1
  hour = 7.5
  speed: number

  constructor(speed = 1) { this.speed = speed }

  /** 按现实秒推进 */
  advance(dtRealSec: number) {
    this.hour += (dtRealSec * this.speed) / GAME_HOUR_SEC
    this.normalize()
  }

  set(hour: number, day?: number) {
    this.hour = hour
    if (day !== undefined) this.day = Math.max(1, Math.floor(day))
    this.normalize()
  }

  skip(hours: number) { this.hour += hours; this.normalize() }

  /** 以天为单位的连续时间（第 1 天 0 点 = 1.0），用于按小时触发事件 */
  get absHours() { return (this.day - 1) * 24 + this.hour }

  get hhmm(): string {
    const total = Math.floor(this.hour * 60) % (24 * 60)
    const h = Math.floor(total / 60), m = total % 60
    return `${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}`
  }

  get phase(): Phase {
    const h = this.hour
    if (h >= 5.75 && h < 7.5) return 'dawn'
    if (h >= 7.5 && h < 18.25) return 'day'
    if (h >= 18.25 && h < 19.75) return 'dusk'
    return 'night'
  }

  private normalize() {
    while (this.hour >= 24) { this.hour -= 24; this.day++ }
    while (this.hour < 0) { this.hour += 24; this.day = Math.max(1, this.day - 1) }
  }
}
