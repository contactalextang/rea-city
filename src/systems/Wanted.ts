import type { Ctx } from '../core/Context'

/** 通缉系统：热度值 0~5，整数部分为星级；一段时间无犯罪且远离警车则衰减 */
export class Wanted {
  heat = 0
  lastCrime = -100
  flash = 0

  get stars() { return Math.min(5, Math.floor(this.heat + 1e-6)) }

  addCrime(amount: number, time: number) {
    const before = this.stars
    this.heat = Math.min(5, this.heat + amount)
    this.lastCrime = time
    if (this.stars > before) this.flash = 1
  }

  reset() { this.heat = 0; this.lastCrime = -100 }

  update(dt: number, ctx: Ctx) {
    this.flash = Math.max(0, this.flash - dt)
    if (this.heat <= 0) return
    const since = ctx.time - this.lastCrime
    if (since < 12) return
    let nearest = Infinity
    for (const v of ctx.vehicles) {
      if (!v.active || v.driver !== 'police') continue
      nearest = Math.min(nearest, Math.hypot(v.x - ctx.player.worldX, v.z - ctx.player.worldZ))
    }
    if (nearest < 70) return
    // 每 10 秒掉一星；不满一星的热度更快清零
    this.heat = Math.max(0, this.heat - dt * (this.heat < 1 ? 0.25 : 0.1))
  }
}
