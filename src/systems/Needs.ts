import type { Clock } from './Clock'
import { clamp } from '../config'

export const NEED_LOW = 20

/**
 * 生存需求：hunger / energy 0–100。按游戏小时差推进（clock.skip 大跳也按跳过小时扣）；
 * 交互里有明确数值效果的大跳（睡觉、上班、搬运）在跳完后调用 sync() 避免重复扣除。
 */
export class Needs {
  hunger = 80
  energy = 100
  private lastAbs: number
  constructor(private clock: Clock, private rate = 1) { this.lastAbs = clock.absHours }

  /** 推进；running 为玩家是否奔跑。返回 true 表示 energy 已归零（Game 处理昏倒并回填精力） */
  update(running: boolean): boolean {
    const now = this.clock.absHours
    let dh = now - this.lastAbs
    this.lastAbs = now
    if (dh > 0) {
      if (dh > 48) dh = 48   // 读档/调试大跳保护
      this.hunger = clamp(this.hunger - 6 * this.rate * dh, 0, 100)
      this.energy = clamp(this.energy - (4 * this.rate + (running ? 2 : 0)) * dh, 0, 100)
    }
    return this.energy <= 0
  }

  /** 与时钟对齐（跳时间后调用，不扣需求） */
  sync() { this.lastAbs = this.clock.absHours }

  set(h: number, e: number) { this.hunger = clamp(h, 0, 100); this.energy = clamp(e, 0, 100) }
  add(h: number, e: number) { this.set(this.hunger + h, this.energy + e) }

  get low() { return this.hunger < NEED_LOW || this.energy < NEED_LOW }
  /** 步行/奔跑速度倍率 */
  get speedMul() { return this.low ? 0.7 : 1 }
}
