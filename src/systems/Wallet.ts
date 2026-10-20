import type { Ctx, AppView } from '../core/Context'

const round2 = (n: number) => Math.round(n * 100) / 100

/**
 * 现金类别（账本按它分类统计今日 / 累计收支）。
 * spend/earn 的 why/src 可以直接写类别（'gamble'），也可以写 `类别:细节`（'gamble:blackjack'、'race:entry'），
 * 旧调用的自由文字（'mrt'、'salary'、'car_used'、职位 id …）由 categorize() 归类，保持兼容。
 */
export type CashCat =
  | 'food' | 'transport' | 'rent' | 'job' | 'biz' | 'shop' | 'fine' | 'medical'
  | 'gamble' | 'entertain' | 'race' | 'arena' | 'date' | 'other'
export const CASH_CATS: readonly CashCat[] = ['food', 'transport', 'rent', 'job', 'biz', 'shop', 'fine', 'medical', 'gamble', 'entertain', 'race', 'arena', 'date', 'other']
export const CASH_CAT_LABEL: Record<CashCat, string> = {
  food: '餐饮', transport: '交通', rent: '房租', job: '工作', biz: '产业', shop: '购物', fine: '罚款', medical: '医疗',
  gamble: '赌博', entertain: '娱乐', race: '赛车', arena: '射击比赛', date: '约会', other: '其他',
}
/** 手机钱包页单独列出的娱乐类别 */
export const FUN_CATS: readonly CashCat[] = ['gamble', 'entertain', 'race', 'arena', 'date']

const isCat = (s: string): s is CashCat => (CASH_CATS as readonly string[]).includes(s)
/** 把调用处的说明文字归到类别 */
export function categorize(tag: string): CashCat {
  const head = tag.split(':')[0]
  if (isCat(head)) return head
  if (/^(gang|gold|white|blue)_/.test(tag) || tag === 'salary' || tag === 'site' || tag === 'taxiTip') return 'job'
  if (/^(biz|bizTier|manager|bizAuto|bizCollect|bizRaid)$/.test(head)) return 'biz'
  if (tag === 'mrt' || tag === 'taxiRent' || tag === 'bus' || tag === 'taxi') return 'transport'
  if (/^(car|home|upg)_/.test(tag)) return 'shop'
  if (tag === 'meal' || tag === 'snack') return 'food'
  return 'other'
}

export interface CatFlow { in: number; out: number }
export type CatTable = Partial<Record<CashCat, CatFlow>>
export interface LedgerSave { day: number; today: CatTable; total: CatTable }

/** 分类账本（模块级：spend/earn 是自由函数，Game 读档时 restoreLedger） */
const ledger: LedgerSave = { day: 1, today: {}, total: {} }
function book(ctx: Ctx, cat: CashCat, delta: number) {
  const day = ctx.clock.day
  if (day !== ledger.day) { ledger.day = day; ledger.today = {} }
  for (const t of [ledger.today, ledger.total]) {
    const f = t[cat] ?? (t[cat] = { in: 0, out: 0 })
    if (delta > 0) f.in = round2(f.in + delta); else f.out = round2(f.out - delta)
  }
}
export function ledgerToday(ctx: Ctx): CatTable { return ctx.clock.day === ledger.day ? ledger.today : {} }
export function ledgerTotal(): CatTable { return ledger.total }
export function serializeLedger(): LedgerSave { return JSON.parse(JSON.stringify(ledger)) as LedgerSave }
export function restoreLedger(d?: LedgerSave) {
  ledger.day = d?.day ?? 1
  ledger.today = { ...(d?.today ?? {}) }
  ledger.total = { ...(d?.total ?? {}) }
}

/** 工资倍率（心情）：Game 注入 () => needs.moodMul；只作用于 job 类收入 */
let wageMul: () => number = () => 1
export function setWageMul(fn: () => number) { wageMul = fn }

/**
 * 现金进出口：spend 不够钱返回 false 且不扣；earn 直接加（金额都按分取整），返回实际入账金额
 * （job 类收入乘心情倍率）。每笔都记分类账、通知 onCashFlow 监听者（Progress 记终身收支）。
 */
export function spend(ctx: Ctx, amt: number, why = ''): boolean {
  if (amt <= 0) return true
  if (ctx.player.money < amt) return false
  move(ctx, -amt, categorize(why))
  return true
}
export function earn(ctx: Ctx, amt: number, src = ''): number {
  if (amt <= 0) return 0
  const cat = categorize(src)
  if (cat === 'job') amt = round2(amt * wageMul())
  return move(ctx, amt, cat)
}
/** 强制扣款（房租 / 罚款 / 医药费）：钱不够也扣，可为负 */
export function charge(ctx: Ctx, amt: number, why = ''): void {
  if (amt <= 0) return
  move(ctx, -amt, categorize(why))
}
function move(ctx: Ctx, amt: number, cat: CashCat) {
  const m0 = ctx.player.money
  ctx.player.money = round2(m0 + amt)
  const d = ctx.player.money - m0
  book(ctx, cat, d)
  flow?.(d, cat)
  return d
}

/** 现金流监听（Progress 按笔累计终身收支，不受同一帧内一进一出相互抵消的影响） */
let flow: ((delta: number, cat: CashCat) => void) | null = null
export function onCashFlow(fn: ((delta: number, cat: CashCat) => void) | null) { flow = fn }

/** 估值来源：资产按 60% 折价计入，产业按估值计入 */
export interface Valued { value(): number }
/** 资产折价率（车 / 房 / 升级按买价的 60% 算进净资产） */
export const ASSET_RESALE = 0.6

const usd = (n: number) => `${n < 0 ? '-' : ''}$${Math.abs(Math.round(n)).toLocaleString()}`

/** 钱包：净资产 = 现金 + 投资持仓 + 资产 × 60% + 产业估值；手机「钱包」页 */
export class Wallet {
  constructor(private ctx: Ctx, private invest: () => number, private assets: Valued, private biz: Valued) {}
  spend(amt: number, why = '') { return spend(this.ctx, amt, why) }
  earn(amt: number, src = '') { return earn(this.ctx, amt, src) }
  charge(amt: number, why = '') { charge(this.ctx, amt, why) }
  get cash() { return this.ctx.player.money }
  netWorth() {
    return round2(this.ctx.player.money + this.invest() + this.assets.value() * ASSET_RESALE + this.biz.value())
  }
  /** 某类别今日 / 累计 { in, out } */
  flow(cat: CashCat, scope: 'today' | 'total' = 'today'): CatFlow {
    const t = scope === 'today' ? ledgerToday(this.ctx) : ledgerTotal()
    return { in: t[cat]?.in ?? 0, out: t[cat]?.out ?? 0 }
  }

  /** 手机「钱包」页：现金 / 净资产、娱乐类收支（今日 / 累计）、各类别今日收支 */
  view(): AppView {
    const today = ledgerToday(this.ctx), total = ledgerTotal()
    const net = (f?: CatFlow) => (f ? f.in - f.out : 0)
    const item = (cat: CashCat) => {
      const t = today[cat], a = total[cat]
      return { title: CASH_CAT_LABEL[cat], value: `今日 ${usd(net(t))}`, desc: `今日 +${usd(t?.in ?? 0)} / −${usd(t?.out ?? 0)} · 累计 ${usd(net(a))}（+${usd(a?.in ?? 0)} / −${usd(a?.out ?? 0)}）` }
    }
    const used = CASH_CATS.filter((c) => !FUN_CATS.includes(c) && (today[c]?.in || today[c]?.out))
    const funNet = FUN_CATS.reduce((s, c) => s + net(total[c]), 0)
    return {
      lines: [`现金 ${usd(this.cash)} · 净资产 ${usd(this.netWorth())}`, `娱乐累计净收支 ${usd(funNet)}`],
      sections: [
        { title: '娱乐 / 赌博 / 比赛', items: FUN_CATS.map(item) },
        { title: '今日其他收支', items: used.length ? used.map(item) : [{ title: '今天还没有其他收支' }] },
      ],
    }
  }
}
