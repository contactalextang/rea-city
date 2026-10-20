/**
 * 赌场规则引擎（纯函数 / 纯数据类，无 DOM）：Canvas UI 与 scripts/casino-sim.ts 共用。
 * 随机数一律经参数 rng 传入（默认 Math.random），seed 不进存档。
 *
 * 金额约定：stake = 押上的本金；return = 结算时返还的总额（含本金，输为 0，和局 = 本金）。
 */
import {
  BJ, BACCARAT, RED_NUMBERS, ROULETTE_PAYS, SICBO_PAYS,
  SLOT_STRIP_COUNTS, SLOT_PAYS_3, SLOT_CHERRY, SLOT_LINES,
  type RouletteBetKind, type SicboBetKind, type SlotSym,
} from '../../data/casino'

export type Rng = () => number
const rand: Rng = Math.random

// ======================= 牌与牌鞋 =======================
/** r：1=A … 11=J 12=Q 13=K；s：0♠ 1♥ 2♦ 3♣ */
export interface Card { r: number; s: number }
export const RANK_TXT = ['', 'A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K']
export const SUIT_TXT = ['♠', '♥', '♦', '♣']

export class Shoe {
  private cards: Card[] = []
  private pos = 0
  /** 本鞋刚洗过（UI 用来提示） */
  shuffled = true
  readonly decks: number
  readonly penetration: number
  private rng: Rng
  constructor(decks: number, penetration: number, rng: Rng = rand) { this.decks = decks; this.penetration = penetration; this.rng = rng; this.shuffle() }
  shuffle() {
    const c: Card[] = []
    for (let d = 0; d < this.decks; d++) for (let s = 0; s < 4; s++) for (let r = 1; r <= 13; r++) c.push({ r, s })
    for (let i = c.length - 1; i > 0; i--) { const j = Math.floor(this.rng() * (i + 1)); const t = c[i]; c[i] = c[j]; c[j] = t }
    this.cards = c; this.pos = 0; this.shuffled = true
  }
  /** 局前调用：过了切牌位就重洗 */
  checkCut() { if (this.pos >= this.cards.length * this.penetration) this.shuffle(); else this.shuffled = false }
  draw(): Card {
    if (this.pos >= this.cards.length) this.shuffle()
    return this.cards[this.pos++]
  }
  /** 测试用：把指定牌插到牌鞋最上面（按顺序发出） */
  stack(cards: Card[]) { this.cards.splice(this.pos, 0, ...cards) }
  get remaining() { return this.cards.length - this.pos }
  get size() { return this.cards.length }
}

// ======================= 21 点 =======================
export const bjValue = (c: Card) => (c.r >= 10 ? 10 : c.r)
export function bjTotal(cards: Card[]): { total: number; soft: boolean } {
  let t = 0, aces = 0
  for (const c of cards) { t += bjValue(c); if (c.r === 1) aces++ }
  const soft = aces > 0 && t + 10 <= 21
  return { total: soft ? t + 10 : t, soft }
}
export const isBlackjack = (cards: Card[]) => cards.length === 2 && bjTotal(cards).total === 21

export type BjResult = 'blackjack' | 'win' | 'push' | 'lose' | 'bust'
export interface BjHand {
  cards: Card[]
  /** 本手押注（加倍后为 2 倍） */
  bet: number
  doubled: boolean
  done: boolean
  fromSplit: boolean
  /** 分 A 后每手只发一张 */
  splitAces: boolean
  result?: BjResult
  /** 结算返还（含本金） */
  ret?: number
}
export type BjPhase = 'insurance' | 'player' | 'dealer' | 'done'
export type BjAction = 'hit' | 'stand' | 'double' | 'split'

/**
 * 一局 21 点：6 副牌鞋、庄家软 17 停（S17）、黑杰克 3:2、任意两张可加倍、分牌后可加倍、
 * 最多分 4 手、分 A 每手只补一张（不可再分、21 点不算黑杰克）、庄家明牌 A 时可买保险（2:1）、
 * 庄家明牌 A / 10 时偷看底牌（美式），庄黑杰克直接结算。无投降。
 *
 * 用法：new BlackjackRound(shoe, bet) → phase 'insurance'? → insurance(yes) → 'player'：
 * act('hit'|'stand'|'double'|'split')（double/split 前调用方先扣 extraStake()）→ 'dealer'：dealerStep() 直到 'done'。
 */
export class BlackjackRound {
  hands: BjHand[]
  dealer: Card[]
  active = 0
  phase: BjPhase = 'player'
  insuranceBet = 0
  insuranceRet = 0
  /** 庄家底牌是否已翻开 */
  holeShown = false
  readonly baseBet: number
  private shoe: Shoe

  constructor(shoe: Shoe, bet: number) {
    this.shoe = shoe
    this.baseBet = bet
    const p1 = shoe.draw(), d1 = shoe.draw(), p2 = shoe.draw(), d2 = shoe.draw()
    this.hands = [{ cards: [p1, p2], bet, doubled: false, done: false, fromSplit: false, splitAces: false }]
    this.dealer = [d1, d2]
    if (d1.r === 1) this.phase = 'insurance'
    else this.afterInsurance()
  }

  get up() { return this.dealer[0] }
  get hand() { return this.hands[this.active] }
  /** 已押总额（各手 + 保险） */
  get totalStake() { return this.hands.reduce((a, h) => a + h.bet, 0) + this.insuranceBet }
  get totalReturn() { return this.hands.reduce((a, h) => a + (h.ret ?? 0), 0) + this.insuranceRet }

  /** 买保险（半注）：调用方先扣 baseBet/2 */
  insurance(take: boolean) {
    if (this.phase !== 'insurance') return
    if (take) this.insuranceBet = this.baseBet / 2
    this.afterInsurance()
  }

  private afterInsurance() {
    this.phase = 'player'
    const peek = this.up.r === 1 || bjValue(this.up) === 10
    const dealerBJ = isBlackjack(this.dealer)
    if (this.insuranceBet > 0) this.insuranceRet = dealerBJ ? this.insuranceBet * (1 + BJ.insurancePays) : 0
    if (peek && dealerBJ) { this.holeShown = true; this.finish(); return }
    if (isBlackjack(this.hands[0].cards)) { this.hands[0].done = true; this.holeShown = true; this.finish(); return }
  }

  canHit() { return this.phase === 'player' && !this.hand.done && !this.hand.splitAces }
  canDouble() {
    const h = this.hand
    return this.phase === 'player' && !h.done && h.cards.length === 2 && !h.splitAces && (!h.fromSplit || BJ.doubleAfterSplit)
  }
  canSplit() {
    const h = this.hand
    return this.phase === 'player' && !h.done && h.cards.length === 2 && this.hands.length < BJ.maxHands &&
      bjValue(h.cards[0]) === bjValue(h.cards[1]) && !h.splitAces
  }
  /** double / split 需要额外押的钱 */
  extraStake(a: BjAction) { return a === 'double' || a === 'split' ? this.hand.bet : 0 }
  legal(a: BjAction) { return a === 'hit' ? this.canHit() : a === 'stand' ? this.phase === 'player' : a === 'double' ? this.canDouble() : this.canSplit() }

  act(a: BjAction) {
    if (!this.legal(a)) return false
    const h = this.hand
    if (a === 'hit') {
      h.cards.push(this.shoe.draw())
      const t = bjTotal(h.cards).total
      if (t >= 21) h.done = true
    } else if (a === 'stand') {
      h.done = true
    } else if (a === 'double') {
      h.bet *= 2; h.doubled = true
      h.cards.push(this.shoe.draw()); h.done = true
    } else {
      const aces = h.cards[0].r === 1
      const second = h.cards.pop()!
      const nh: BjHand = { cards: [second], bet: h.bet, doubled: false, done: false, fromSplit: true, splitAces: aces }
      h.fromSplit = true; h.splitAces = aces
      this.hands.splice(this.active + 1, 0, nh)
      h.cards.push(this.shoe.draw())
      nh.cards.push(this.shoe.draw())
      if (aces) { h.done = true; nh.done = true }
      else if (bjTotal(h.cards).total === 21) h.done = true
    }
    this.advance()
    return true
  }

  private advance() {
    while (this.active < this.hands.length && this.hands[this.active].done) {
      this.active++
      const nh = this.hands[this.active]
      if (nh && !nh.done && bjTotal(nh.cards).total === 21) nh.done = true
    }
    if (this.active >= this.hands.length) {
      this.active = this.hands.length - 1
      this.phase = 'dealer'
      this.holeShown = true
      // 全爆就不用补牌
      if (this.hands.every((x) => bjTotal(x.cards).total > 21)) this.finish()
    }
  }

  /** 庄家是否还要补牌 */
  dealerNeedsCard() {
    const { total, soft } = bjTotal(this.dealer)
    return total < 17 || (total === 17 && soft && BJ.dealerHitsSoft17)
  }
  /** 庄家补一步：补一张或结算；返回是否补了牌 */
  dealerStep(): boolean {
    if (this.phase !== 'dealer') return false
    if (this.dealerNeedsCard()) { this.dealer.push(this.shoe.draw()); return true }
    this.finish(); return false
  }
  /** 无动画直接走完庄家 */
  playDealer() { while (this.phase === 'dealer') this.dealerStep() }

  private finish() {
    this.phase = 'done'; this.holeShown = true
    const d = bjTotal(this.dealer).total, dBJ = isBlackjack(this.dealer)
    for (const h of this.hands) {
      const t = bjTotal(h.cards).total
      const natural = isBlackjack(h.cards) && this.hands.length === 1 && !h.fromSplit
      if (t > 21) { h.result = 'bust'; h.ret = 0 }
      else if (dBJ) { h.result = natural ? 'push' : 'lose'; h.ret = natural ? h.bet : 0 }
      else if (natural) { h.result = 'blackjack'; h.ret = h.bet * (1 + BJ.blackjackPays) }
      else if (d > 21 || t > d) { h.result = 'win'; h.ret = h.bet * 2 }
      else if (t === d) { h.result = 'push'; h.ret = h.bet }
      else { h.result = 'lose'; h.ret = 0 }
    }
  }
}

/** 基本策略（6D S17 DAS 无投降）：模拟与 UI 提示共用 */
export function bjBasic(r: BlackjackRound): BjAction {
  const h = r.hand, up = bjValue(r.up) === 1 ? 11 : bjValue(r.up)
  const { total, soft } = bjTotal(h.cards)
  const pick = (a: BjAction): BjAction => {
    if (a === 'double' && !r.canDouble()) return soft && total === 18 ? 'stand' : 'hit'
    if (a === 'split' && !r.canSplit()) return 'hit'
    if (a === 'hit' && !r.canHit()) return 'stand'
    return a
  }
  if (r.canSplit()) {
    const v = bjValue(h.cards[0])
    const sp =
      v === 1 || v === 8 ? true :
      v === 2 || v === 3 || v === 7 ? up <= 7 :
      v === 4 ? up === 5 || up === 6 :
      v === 6 ? up <= 6 :
      v === 9 ? up <= 9 && up !== 7 : false
    if (sp) return 'split'
  }
  if (soft) {
    if (total >= 19) return 'stand'
    if (total === 18) return up >= 3 && up <= 6 ? pick('double') : up <= 8 ? 'stand' : pick('hit')
    if (total === 17) return up >= 3 && up <= 6 ? pick('double') : pick('hit')
    if (total >= 15) return up >= 4 && up <= 6 ? pick('double') : pick('hit')
    return up === 5 || up === 6 ? pick('double') : pick('hit')
  }
  if (total >= 17) return 'stand'
  if (total >= 13) return up <= 6 ? 'stand' : pick('hit')
  if (total === 12) return up >= 4 && up <= 6 ? 'stand' : pick('hit')
  if (total === 11) return up <= 10 ? pick('double') : pick('hit')
  if (total === 10) return up <= 9 ? pick('double') : pick('hit')
  if (total === 9) return up >= 3 && up <= 6 ? pick('double') : pick('hit')
  return pick('hit')
}

// ======================= 轮盘 =======================
/** 下注键：'straight:17' | 'red' | 'black' | 'odd' | 'even' | 'low' | 'high' | 'dozen:1..3' | 'column:1..3' */
export type RouletteKey = string
export const rouletteSpin = (rng: Rng = rand) => Math.floor(rng() * 37)
export const rouletteColor = (n: number) => (n === 0 ? 'green' : RED_NUMBERS.has(n) ? 'red' : 'black')
export function rouletteParse(key: RouletteKey): { kind: RouletteBetKind; n: number } {
  const [k, v] = key.split(':')
  return { kind: k as RouletteBetKind, n: v === undefined ? 0 : +v }
}
export function rouletteWins(key: RouletteKey, x: number): boolean {
  const { kind, n } = rouletteParse(key)
  if (kind === 'straight') return x === n
  if (x === 0) return false
  switch (kind) {
    case 'red': return RED_NUMBERS.has(x)
    case 'black': return !RED_NUMBERS.has(x)
    case 'odd': return x % 2 === 1
    case 'even': return x % 2 === 0
    case 'low': return x <= 18
    case 'high': return x >= 19
    case 'dozen': return Math.ceil(x / 12) === n
    case 'column': return ((x - 1) % 3) + 1 === n
  }
  return false
}
/** 一组下注在开出 x 时的返还 */
export function rouletteReturn(bets: Record<RouletteKey, number>, x: number) {
  let ret = 0
  for (const [k, amt] of Object.entries(bets)) if (amt > 0 && rouletteWins(k, x)) ret += amt * (1 + ROULETTE_PAYS[rouletteParse(k).kind])
  return ret
}

// ======================= 骰宝 =======================
/** 下注键：'small' | 'big' | 'odd' | 'even' | 'single:1..6' | 'total:4..17' | 'anyTriple' | 'triple:1..6' | 'double:1..6' */
export type SicboKey = string
export const rollDice = (rng: Rng = rand): [number, number, number] => [1 + Math.floor(rng() * 6), 1 + Math.floor(rng() * 6), 1 + Math.floor(rng() * 6)]
/** 单注在骰面 d 时的赔率倍数（x:1）；输返回 -1 */
export function sicboOdds(key: SicboKey, d: number[]): number {
  const [k, v] = key.split(':'); const n = +v
  const sum = d[0] + d[1] + d[2], triple = d[0] === d[1] && d[1] === d[2]
  const cnt = (f: number) => d.filter((x) => x === f).length
  switch (k as SicboBetKind) {
    case 'small': return !triple && sum <= 10 ? SICBO_PAYS.small : -1
    case 'big': return !triple && sum >= 11 ? SICBO_PAYS.big : -1
    case 'odd': return !triple && sum % 2 === 1 ? SICBO_PAYS.odd : -1
    case 'even': return !triple && sum % 2 === 0 ? SICBO_PAYS.even : -1
    case 'single': { const c = cnt(n); return c > 0 ? SICBO_PAYS.single[c] : -1 }
    case 'total': return sum === n && SICBO_PAYS.total[n] ? SICBO_PAYS.total[n] : -1   // 总点数不受围骰影响
    case 'anyTriple': return triple ? SICBO_PAYS.anyTriple : -1
    case 'triple': return triple && d[0] === n ? SICBO_PAYS.triple : -1
    case 'double': return cnt(n) >= 2 ? SICBO_PAYS.double : -1
  }
  return -1
}
export function sicboReturn(bets: Record<SicboKey, number>, d: number[]) {
  let ret = 0
  for (const [k, amt] of Object.entries(bets)) { const o = sicboOdds(k, d); if (amt > 0 && o >= 0) ret += amt * (1 + o) }
  return ret
}

// ======================= 百家乐 =======================
export const bacValue = (c: Card) => (c.r >= 10 ? 0 : c.r)
export const bacTotal = (cards: Card[]) => cards.reduce((a, c) => a + bacValue(c), 0) % 10
export type BacWinner = 'player' | 'banker' | 'tie'
export interface BacCoup {
  player: Card[]
  banker: Card[]
  /** 发牌顺序（UI 依次翻）：['P',0] ['B',0] ['P',1] ['B',1] 然后可能 P2 / B2 */
  order: ['P' | 'B', number][]
  pt: number
  bt: number
  winner: BacWinner
  natural: boolean
}
/** 庄家第三张牌规则（闲补了第三张、其点数 p3 时，庄 bt 点是否补） */
export function bankerDraws(bt: number, p3: number | null): boolean {
  if (p3 === null) return bt <= 5
  if (bt <= 2) return true
  if (bt === 3) return p3 !== 8
  if (bt === 4) return p3 >= 2 && p3 <= 7
  if (bt === 5) return p3 >= 4 && p3 <= 7
  if (bt === 6) return p3 === 6 || p3 === 7
  return false
}
/** 发一局百家乐（完整补牌规则） */
export function baccaratDeal(shoe: Shoe): BacCoup {
  const player = [shoe.draw()], banker = [shoe.draw()]
  player.push(shoe.draw()); banker.push(shoe.draw())
  const order: ['P' | 'B', number][] = [['P', 0], ['B', 0], ['P', 1], ['B', 1]]
  let pt = bacTotal(player), bt = bacTotal(banker)
  const natural = pt >= 8 || bt >= 8
  if (!natural) {
    let p3: number | null = null
    if (pt <= 5) { const c = shoe.draw(); player.push(c); p3 = bacValue(c); order.push(['P', 2]); pt = bacTotal(player) }
    if (bankerDraws(bt, p3)) { banker.push(shoe.draw()); order.push(['B', 2]); bt = bacTotal(banker) }
  }
  return { player, banker, order, pt, bt, natural, winner: pt > bt ? 'player' : bt > pt ? 'banker' : 'tie' }
}
export type BacKey = 'player' | 'banker' | 'tie'
export function baccaratReturn(bets: Partial<Record<BacKey, number>>, w: BacWinner) {
  let ret = 0
  const p = bets.player ?? 0, b = bets.banker ?? 0, t = bets.tie ?? 0
  if (w === 'tie') ret += p + b + t * (1 + BACCARAT.tiePays)
  else if (w === 'player') ret += p * (1 + BACCARAT.playerPays)
  else ret += b * (1 + BACCARAT.bankerPays)
  return Math.round(ret * 100) / 100
}

// ======================= 老虎机 =======================
/**
 * 由数量表生成符号带：按 seed 做确定性洗牌（每轴不同排列，首尾相接也不让同符号相邻）。
 * RTP 只取决于各符号数量（每条线三轴各自均匀独立取一格），排列只影响观感。
 */
export function buildStrip(counts: Record<SlotSym, number>, seed: number): SlotSym[] {
  const base: SlotSym[] = []
  for (const [sym, c] of Object.entries(counts) as [SlotSym, number][]) for (let i = 0; i < c; i++) base.push(sym)
  let st = seed >>> 0
  const lcg = () => { st = (Math.imul(st, 1664525) + 1013904223) >>> 0; return st / 4294967296 }
  for (let tries = 0; tries < 500; tries++) {
    const a = base.slice()
    for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(lcg() * (i + 1)); const t = a[i]; a[i] = a[j]; a[j] = t }
    if (a.every((x, i) => x !== a[(i + 1) % a.length])) return a
  }
  return base
}
export const SLOT_STRIPS: SlotSym[][] = [buildStrip(SLOT_STRIP_COUNTS, 11), buildStrip(SLOT_STRIP_COUNTS, 2027), buildStrip(SLOT_STRIP_COUNTS, 65)]
export const slotSpin = (rng: Rng = rand): number[] => SLOT_STRIPS.map((s) => Math.floor(rng() * s.length))
/** 停位 → 可见窗口 grid[轴][行]（停位在中行） */
export function slotGrid(stops: number[]): SlotSym[][] {
  return stops.map((p, i) => { const s = SLOT_STRIPS[i], L = s.length; return [s[(p - 1 + L) % L], s[p], s[(p + 1) % L]] })
}
/** 一条线的三个符号 → 赔率（× 每线注） */
export function slotLinePay(a: SlotSym, b: SlotSym, c: SlotSym): number {
  if (a === b && b === c) return SLOT_PAYS_3[a]
  if (a === 'cherry') return b === 'cherry' ? SLOT_CHERRY.two : SLOT_CHERRY.one
  return 0
}
export interface SlotWin { line: number; syms: SlotSym[]; pay: number }
export function slotEval(grid: SlotSym[][], lineBet: number): { wins: SlotWin[]; ret: number } {
  const wins: SlotWin[] = []
  SLOT_LINES.forEach((rows, li) => {
    const syms = rows.map((r, reel) => grid[reel][r])
    const m = slotLinePay(syms[0], syms[1], syms[2])
    if (m > 0) wins.push({ line: li, syms, pay: m * lineBet })
  })
  return { wins, ret: wins.reduce((a, w) => a + w.pay, 0) }
}
/** 精确 RTP：每条线三轴各自均匀独立取一格 → 枚举三轴所有组合 */
export function slotTheoryRtp(): number {
  const [s0, s1, s2] = SLOT_STRIPS
  let sum = 0
  for (const a of s0) for (const b of s1) for (const c of s2) sum += slotLinePay(a, b, c)
  return sum / (s0.length * s1.length * s2.length)
}
