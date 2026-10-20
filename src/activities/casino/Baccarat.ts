import type { Input } from '../../core/Input'
import { BACCARAT } from '../../data/casino'
import { Shoe, baccaratDeal, baccaratReturn, bacTotal, type BacCoup, type BacWinner, type Card } from './rules'
import { Table, DealQueue, money } from './table'

const SHOE_X = 760, SHOE_Y = 40
const WIN_TXT: Record<BacWinner, string> = { player: '闲赢', banker: '庄赢', tie: '和局' }
const WIN_COL: Record<BacWinner, string> = { player: '#1c7ed6', banker: '#e03131', tie: '#2f9e44' }

/** 百家乐：8 副牌，完整补牌规则；闲 1:1、庄 0.95:1（抽 5%）、和 8:1（和局时庄闲退回） */
export class BaccaratTable extends Table {
  readonly game = 'baccarat' as const
  private shoe = new Shoe(BACCARAT.decks, BACCARAT.penetration)
  private coup: BacCoup | null = null
  private live: { stake: number; bets: Record<string, number>; done: number } | null = null
  private dq = new DealQueue(0.6, 0.34)
  private road: BacWinner[] = []
  private pendingStack: Card[] | null = null
  protected bannerAt = { x: 560, y: 266 }

  get inRound() { return !!this.live }
  get phase() { return this.live ? 'deal' : 'bet' }
  /** 测试：下一局从牌鞋顶部发这些牌（闲1 庄1 闲2 庄2 [闲3] [庄3]） */
  stackNext(cards: Card[]) { this.pendingStack = cards }

  private start() {
    if (this.live) return
    const stake = this.commitBets(); if (!stake) return
    this.shoe.checkCut()
    if (this.shoe.shuffled) this.api.toast('洗牌（8 副牌）', 1.2)
    if (this.pendingStack) { this.shoe.stack(this.pendingStack); this.pendingStack = null }
    const c = baccaratDeal(this.shoe)
    this.coup = c; this.dq.reset()
    for (const [side, i] of c.order) this.dq.reg(side === 'P' ? c.player[i] : c.banker[i], this.t + 0.1)
    this.live = { stake, bets: { ...this.bets }, done: -1 }
    this.bets = {}
    this.status = '发牌…'
  }
  private settle() {
    const c = this.coup!, l = this.live!; this.live = null
    const ret = baccaratReturn(l.bets, c.winner)
    this.road.push(c.winner); if (this.road.length > 48) this.road.splice(0, this.road.length - 48)
    const tag = `${WIN_TXT[c.winner]} ${c.pt}:${c.bt}${c.natural ? ' 例牌' : ''}`
    this.finishRound(l.stake, ret, `${tag} · ${ret > l.stake ? `赢 ${money(ret - l.stake)}` : ret === l.stake ? '退回本金' : `输 ${money(l.stake - ret)}`}`)
  }
  forceFinish() { if (this.live) this.settle() }

  protected tick(dt: number) {
    if (this.dq.justStarted(this.t, dt)) this.sfx.card()
    const l = this.live; if (!l) return
    if (!this.dq.busy(this.t)) {
      if (l.done < 0) l.done = this.t
      else if (this.t > l.done + 0.9) this.settle()
    }
  }

  private shown(cards: Card[]) { return cards.filter((c) => this.dq.at(c, this.t) >= 1) }

  private cardAt(c: Card, x: number, y: number, side: boolean) {
    const p = this.dq.at(c, this.t); if (p < 0) return
    const k = Math.min(1, p), e = 1 - (1 - k) ** 3
    const cx = SHOE_X + (x - SHOE_X) * e, cy = SHOE_Y + (y - SHOE_Y) * e
    const flip = k < 0.5 ? -1 : Math.max(0.05, Math.abs(Math.cos(Math.PI * k)))
    if (side) {
      const g = this.g
      g.save(); g.translate(cx + 45, cy + 32); g.rotate(Math.PI / 2 * e); g.translate(-32, -45)
      this.drawCard(0, 0, c, 64, 90, flip); g.restore()
    } else this.drawCard(cx, cy, c, 64, 90, flip)
  }

  private hand(label: string, cards: Card[], x: number, col: string) {
    this.text(label, x + 70, 92, 20, col, 'center', 900)
    cards.forEach((c, i) => this.cardAt(c, i < 2 ? x + i * 72 : x + 150, i < 2 ? 112 : 112, i === 2))
    const sh = this.shown(cards)
    if (sh.length) this.text(`${bacTotal(sh)} 点`, x + 70, 222, 22, '#fff', 'center', 900)
  }

  private zone(key: 'player' | 'tie' | 'banker', x: number, y: number, w: number, h: number, label: string, odds: string, col: string) {
    const g = this.g, betting = !this.live
    const won = this.coup && !this.live && this.coup.winner === key
    g.fillStyle = col + '55'; this.rr(x, y, w, h, 40); g.fill()
    if (betting && this.hovered(`bet:${key}`)) { g.fillStyle = 'rgba(255,255,255,.14)'; this.rr(x, y, w, h, 40); g.fill() }
    g.strokeStyle = won ? '#ffd33d' : col; g.lineWidth = won ? 4 : 2.5; this.rr(x, y, w, h, 40); g.stroke()
    this.text(label, x + 70, y + h / 2 - 10, 24, '#fff', 'center', 900)
    this.text(odds, x + 70, y + h / 2 + 16, 13, '#ffd33d', 'center', 600)
    const amt = (this.live ? this.live.bets : this.bets)[key]
    if (amt) this.drawStack(x + w - 70, y + h / 2 + 2, amt, 16)
    this.region(`bet:${key}`, x, y, w, h, betting, () => this.place(key))
  }

  protected draw() {
    const g = this.g
    // 牌鞋
    g.fillStyle = '#2b1d10'; this.rr(SHOE_X - 10, SHOE_Y - 10, 84, 108, 10); g.fill()
    this.drawCard(SHOE_X, SHOE_Y, null)
    const c = this.coup
    if (c) {
      this.hand('闲 PLAYER', c.player, 120, '#74c0fc')
      this.hand('庄 BANKER', c.banker, 440, '#ff8787')
    } else {
      this.text('闲 PLAYER', 190, 92, 20, '#74c0fc', 'center', 900)
      this.text('庄 BANKER', 510, 92, 20, '#ff8787', 'center', 900)
    }
    // 珠盘路
    const rx = 880, ry = 120, cs = 24
    this.text('珠盘路', rx, ry - 22, 12, 'rgba(255,255,255,.7)', 'left')
    g.fillStyle = 'rgba(255,255,255,.9)'; g.fillRect(rx, ry, cs * 8, cs * 6)
    g.strokeStyle = '#ccc'; g.lineWidth = 1
    for (let i = 0; i <= 8; i++) { g.beginPath(); g.moveTo(rx + i * cs, ry); g.lineTo(rx + i * cs, ry + cs * 6); g.stroke() }
    for (let j = 0; j <= 6; j++) { g.beginPath(); g.moveTo(rx, ry + j * cs); g.lineTo(rx + cs * 8, ry + j * cs); g.stroke() }
    this.road.forEach((w, i) => {
      const x = rx + Math.floor(i / 6) * cs + cs / 2, y = ry + (i % 6) * cs + cs / 2
      g.fillStyle = WIN_COL[w]; g.beginPath(); g.arc(x, y, cs * 0.4, 0, Math.PI * 2); g.fill()
      this.text(w === 'player' ? '闲' : w === 'banker' ? '庄' : '和', x, y, 11, '#fff', 'center', 800)
    })
    const cnt = (w: BacWinner) => this.road.filter((x) => x === w).length
    this.text(`庄 ${cnt('banker')}  闲 ${cnt('player')}  和 ${cnt('tie')}`, rx + cs * 4, ry + cs * 6 + 16, 12, '#fff')
    // 下注区
    this.zone('player', 60, 300, 330, 120, '闲', '1:1', '#1c7ed6')
    this.zone('tie', 400, 300, 300, 120, '和', '8:1 · 和局时庄闲退回', '#2f9e44')
    this.zone('banker', 710, 300, 350, 120, '庄', '0.95:1（抽 5% 佣金）', '#e03131')
    this.text('闲 0–5 补牌；庄按闲第三张补牌（3 点除 8、4 点 2–7、5 点 4–7、6 点 6–7）；任一方 8/9 点例牌不补', 560, 446, 12, 'rgba(255,255,255,.62)')
    // 按钮
    const betting = !this.live, bx = 640, by = 540
    this.button('btn:clear', bx, by, 100, 52, '清除', betting && this.betTotal > 0, () => this.clearBets(), '#adb5bd')
    this.button('btn:rebet', bx + 110, by, 100, 52, '重复', betting && this.betTotal === 0 && Object.keys(this.lastBets).length > 0, () => this.rebet(), '#adb5bd')
    this.button('btn:deal', bx + 220, by, 200, 52, '发牌', betting && this.betTotal > 0, () => this.start(), '#ffd33d', 'Space')
    if (betting) this.status = this.betTotal ? `下注 ${money(this.betTotal)}` : '选筹码 → 押 庄 / 闲 / 和 → 发牌'
    this.chipRack(betting)
  }

  protected keys(input: Input) {
    if ((input.justPressed('Space') || input.justPressed('Enter')) && !this.live && this.betTotal > 0) this.start()
  }
}
