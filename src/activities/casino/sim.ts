/**
 * 无 UI 快速模拟：scripts/casino-sim.ts 与 __game.plug.casino.simulate() 共用。
 * RTP = 1 + 净输赢 / 初始注总额（21 点按首注计，与业内「庄家优势」口径一致）。
 */
import { BACCARAT, BJ, ROULETTE_RTP, type CasinoGameId } from '../../data/casino'
import {
  Shoe, BlackjackRound, bjBasic, bjTotal, rouletteSpin, rouletteReturn, rollDice, sicboReturn,
  baccaratDeal, baccaratReturn, slotSpin, slotGrid, slotEval, slotTheoryRtp, type Rng, type BacKey,
} from './rules'

export interface SimResult {
  game: CasinoGameId
  strategy: string
  rounds: number
  /** 初始注总额 */
  wagered: number
  /** 净输赢（输为负） */
  net: number
  rtp: number
  /** 庄家优势 = 1 − RTP */
  edge: number
  /** RTP 的标准误 */
  se: number
  /** 理论 RTP */
  theory: number
}

/** 骰宝单注精确 RTP：枚举 216 种骰面 */
export function sicboTheory(key: string): number {
  let s = 0
  for (let a = 1; a <= 6; a++) for (let b = 1; b <= 6; b++) for (let c = 1; c <= 6; c++) s += sicboReturn({ [key]: 1 }, [a, b, c])
  return s / 216
}

export const SIM_STRATEGIES: Record<CasinoGameId, string[]> = {
  blackjack: ['basic', 'mimic'],
  roulette: ['red', 'straight', 'dozen', 'column', 'odd'],
  sicbo: ['big', 'small', 'single:3', 'total:10', 'anyTriple', 'triple:6', 'double:2'],
  baccarat: ['banker', 'player', 'tie'],
  slots: ['5lines'],
}

/** 模拟 rounds 局，每局初始注 1 */
export function simulate(game: CasinoGameId, rounds: number, strategy?: string, rng: Rng = Math.random): SimResult {
  const strat = strategy ?? SIM_STRATEGIES[game][0]
  let net = 0, sq = 0, theory = 1
  const add = (x: number) => { net += x; sq += x * x }
  if (game === 'blackjack') {
    const shoe = new Shoe(BJ.decks, BJ.penetration, rng)
    theory = strat === 'basic' ? BJ.theoryRtp : 0.943
    for (let i = 0; i < rounds; i++) {
      shoe.checkCut()
      const r = new BlackjackRound(shoe, 1)
      if (r.phase === 'insurance') r.insurance(false)
      while (r.phase === 'player') {
        if (strat === 'basic') r.act(bjBasic(r))
        else r.act(bjTotal(r.hand.cards).total < 17 ? 'hit' : 'stand')
      }
      r.playDealer()
      add(r.totalReturn - r.totalStake)
    }
  } else if (game === 'roulette') {
    theory = ROULETTE_RTP
    const key = strat === 'straight' ? 'straight:17' : strat === 'dozen' ? 'dozen:2' : strat === 'column' ? 'column:1' : strat
    for (let i = 0; i < rounds; i++) add(rouletteReturn({ [key]: 1 }, rouletteSpin(rng)) - 1)
  } else if (game === 'sicbo') {
    theory = sicboTheory(strat)
    for (let i = 0; i < rounds; i++) add(sicboReturn({ [strat]: 1 }, rollDice(rng)) - 1)
  } else if (game === 'baccarat') {
    const shoe = new Shoe(BACCARAT.decks, BACCARAT.penetration, rng)
    const key = strat as BacKey
    theory = BACCARAT.theory[key]
    for (let i = 0; i < rounds; i++) {
      shoe.checkCut()
      add(baccaratReturn({ [key]: 1 }, baccaratDeal(shoe).winner) - 1)
    }
  } else {
    theory = slotTheoryRtp()
    for (let i = 0; i < rounds; i++) add(slotEval(slotGrid(slotSpin(rng)), 1 / 5).ret - 1)
  }
  const mean = net / rounds
  const sd = Math.sqrt(Math.max(0, sq / rounds - mean * mean))
  return { game, strategy: strat, rounds, wagered: rounds, net, rtp: 1 + mean, edge: -mean, se: sd / Math.sqrt(rounds), theory }
}
