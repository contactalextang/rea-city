import type { Ctx } from '../core/Context'

const round2 = (n: number) => Math.round(n * 100) / 100

/**
 * 现金进出口：spend 不够钱返回 false 且不扣；earn 直接加（金额都按分取整）。
 * why / src 只作为调用处的说明（以后做账本时用）；每笔都通知 onCashFlow 监听者（Progress 记终身收支）。
 */
export function spend(ctx: Ctx, amt: number, _why = ''): boolean {
  if (amt <= 0) return true
  if (ctx.player.money < amt) return false
  const m0 = ctx.player.money
  ctx.player.money = round2(m0 - amt)
  flow?.(ctx.player.money - m0)
  return true
}
export function earn(ctx: Ctx, amt: number, _src = '') {
  if (amt <= 0) return
  const m0 = ctx.player.money
  ctx.player.money = round2(m0 + amt)
  flow?.(ctx.player.money - m0)
}

/** 现金流监听（Progress 按笔累计终身收支，不受同一帧内一进一出相互抵消的影响） */
let flow: ((delta: number) => void) | null = null
export function onCashFlow(fn: ((delta: number) => void) | null) { flow = fn }

/** 估值来源：资产按 60% 折价计入，产业按估值计入 */
export interface Valued { value(): number }
/** 资产折价率（车 / 房 / 升级按买价的 60% 算进净资产） */
export const ASSET_RESALE = 0.6

/** 钱包：净资产 = 现金 + 投资持仓 + 资产 × 60% + 产业估值 */
export class Wallet {
  constructor(private ctx: Ctx, private invest: () => number, private assets: Valued, private biz: Valued) {}
  spend(amt: number, why = '') { return spend(this.ctx, amt, why) }
  earn(amt: number, src = '') { earn(this.ctx, amt, src) }
  get cash() { return this.ctx.player.money }
  netWorth() {
    return round2(this.ctx.player.money + this.invest() + this.assets.value() * ASSET_RESALE + this.biz.value())
  }
}
