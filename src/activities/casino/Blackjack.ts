import type { Input } from '../../core/Input'
import { BJ } from '../../data/casino'
import { Shoe, BlackjackRound, bjTotal, bjBasic, type Card, type BjAction } from './rules'
import { Table, DealQueue, VW, money } from './table'

const ACT_TXT: Record<BjAction, string> = { hit: '要牌', stand: '停牌', double: '加倍', split: '分牌' }
const RES_TXT = { blackjack: '黑杰克 3:2', win: '赢', push: '和', lose: '输', bust: '爆牌' } as const
const SHOE_X = 950, SHOE_Y = 70

/** 21 点（6 副牌、S17、3:2、加倍 / 分牌 / 保险） */
export class BlackjackTable extends Table {
  readonly game = 'blackjack' as const
  private shoe = new Shoe(BJ.decks, BJ.penetration)
  round: BlackjackRound | null = null
  private settled = true
  private dq = new DealQueue(0.24, 0.34)
  private dealerWait = 0
  private holeAt = -1
  private pendingStack: Card[] | null = null
  /** 本鞋已用于测试的统计：玩过的动作 */
  readonly actionsUsed = new Set<string>()
  protected bannerAt = { x: VW / 2, y: 232 }

  get inRound() { return !!this.round && !this.settled }
  get phase() { return !this.round || this.settled ? 'bet' : this.round.phase }
  /** 测试：下一局从牌鞋顶部按顺序发这些牌（P1 D1 P2 D2 …） */
  stackNext(cards: Card[]) { this.pendingStack = cards }

  private deal() {
    if (this.inRound) return
    const stake = this.commitBets(); if (!stake) return
    this.shoe.checkCut()
    if (this.shoe.shuffled) this.api.toast('洗牌（6 副牌）', 1.2)
    if (this.pendingStack) { this.shoe.stack(this.pendingStack); this.pendingStack = null }
    const r = new BlackjackRound(this.shoe, stake)
    this.round = r; this.settled = false; this.dq.reset(); this.holeAt = -1; this.dealerWait = 0.4
    this.bets = {}
    const h = r.hands[0].cards
    for (const c of [h[0], r.dealer[0], h[1], r.dealer[1]]) this.dq.reg(c, this.t)
    this.status = ''
  }

  private act(a: BjAction) {
    const r = this.round; if (!r || !r.legal(a) || this.dq.busy(this.t)) return
    const extra = r.extraStake(a)
    if (extra > 0 && !this.host.stake(this.game, extra)) { this.api.toast('现金不足', 1.4); return }
    r.act(a); this.actionsUsed.add(a)
  }
  private insure(take: boolean) {
    const r = this.round; if (!r || r.phase !== 'insurance' || this.dq.busy(this.t)) return
    if (take && !this.host.stake(this.game, r.baseBet / 2)) { this.api.toast('现金不足', 1.4); return }
    r.insurance(take); if (take) this.actionsUsed.add('insurance')
  }

  forceFinish() {
    const r = this.round; if (!r || this.settled) return
    if (r.phase === 'insurance') r.insurance(false)
    while (r.phase === 'player') r.act('stand')
    r.playDealer()
    this.settle()
  }

  private settle() {
    const r = this.round!; this.settled = true
    const res = r.hands.map((h) => RES_TXT[h.result!])
    const net = r.totalReturn - r.totalStake
    const lead = r.hands.length > 1 ? res.join(' / ') + ' · ' : r.hands[0].result === 'blackjack' ? '黑杰克！' : r.hands[0].result === 'bust' ? '爆牌 · ' : ''
    const ins = r.insuranceBet > 0 ? (r.insuranceRet > 0 ? '（保险赔 2:1）' : '（保险输）') : ''
    this.finishRound(r.totalStake, r.totalReturn, `${lead}${net > 0 ? `赢 ${money(net)}` : net < 0 ? `输 ${money(-net)}` : '和局'}${ins}`)
  }

  protected tick(dt: number) {
    const r = this.round; if (!r) return
    for (const h of r.hands) for (const c of h.cards) this.dq.reg(c, this.t)
    for (const c of r.dealer) this.dq.reg(c, this.t)
    if (this.dq.justStarted(this.t, dt)) this.sfx.card()
    if (r.holeShown && this.holeAt < 0 && !this.dq.busy(this.t)) { this.holeAt = this.t; this.sfx.flip() }
    if (this.settled) return
    const flipDone = this.holeAt >= 0 && this.t > this.holeAt + 0.4
    if (r.phase === 'dealer' && flipDone && !this.dq.busy(this.t)) {
      this.dealerWait -= dt
      if (this.dealerWait <= 0) { r.dealerStep(); this.dealerWait = 0.55 }
    }
    if (r.phase === 'done' && flipDone && !this.dq.busy(this.t)) this.settle()
  }

  private cardAt(c: Card, x: number, y: number, hidden = false) {
    const p = this.dq.at(c, this.t); if (p < 0) return
    const k = Math.min(1, p), e = 1 - (1 - k) ** 3
    const cx = SHOE_X + (x - SHOE_X) * e, cy = SHOE_Y + (y - SHOE_Y) * e
    let flip = k < 0.5 ? -1 : Math.max(0.05, Math.abs(Math.cos(Math.PI * k)))
    if (hidden) flip = -1
    this.drawCard(cx, cy, c, 64, 90, flip)
  }

  protected draw() {
    const r = this.round
    // 桌面印字
    this.text('BLACKJACK PAYS 3 TO 2', VW / 2, 228, 20, 'rgba(255,215,0,.75)', 'center', 800)
    this.text('庄家软 17 停 · 保险赔 2:1 · 6 副牌', VW / 2, 252, 13, 'rgba(255,255,255,.6)', 'center', 500)
    // 牌鞋
    const g = this.g
    g.fillStyle = '#2b1d10'; this.rr(SHOE_X - 10, SHOE_Y - 14, 92, 112, 10); g.fill()
    this.drawCard(SHOE_X, SHOE_Y, null)
    this.text(`剩 ${this.shoe.remaining}`, SHOE_X + 36, SHOE_Y + 110, 11, 'rgba(255,255,255,.6)')
    // 庄家
    if (r) {
      const n = r.dealer.length, x0 = VW / 2 - (n * 40 + 24) / 2
      r.dealer.forEach((c, i) => {
        let hidden = false
        if (i === 1) {
          if (this.holeAt < 0) hidden = true
          else {
            const k = Math.min(1, (this.t - this.holeAt) / 0.35)
            if (k < 1 && this.dq.at(c, this.t) >= 1) {
              this.drawCard(x0 + i * 40, 92, c, 64, 90, k < 0.5 ? -Math.max(0.05, Math.cos(Math.PI * k)) : Math.max(0.05, -Math.cos(Math.PI * k)))
              return
            }
          }
        }
        this.cardAt(c, x0 + i * 40, 92, hidden)
      })
      const show = this.holeAt >= 0 ? r.dealer : [r.dealer[0]]
      if (this.dq.at(r.dealer[0], this.t) >= 1) {
        const tt = bjTotal(show)
        this.text(`庄家 ${tt.total}${tt.soft && tt.total < 21 ? '（软）' : ''}`, VW / 2, 70, 16, '#fff')
      }
    } else this.text('庄家', VW / 2, 70, 16, 'rgba(255,255,255,.6)')
    // 玩家手牌
    if (r) {
      const n = r.hands.length
      r.hands.forEach((h, i) => {
        const cx = VW / 2 + (i - (n - 1) / 2) * 250
        const w = h.cards.length * 28 + 36, x0 = cx - w / 2
        const active = r.phase === 'player' && i === r.active && n > 1
        if (active) { g.strokeStyle = '#ffd33d'; g.lineWidth = 3; this.rr(x0 - 10, 296, w + 20, 112, 12); g.stroke() }
        h.cards.forEach((c, j) => this.cardAt(c, x0 + j * 28, 306 - j * 4))
        const tt = bjTotal(h.cards)
        if (h.cards.every((c) => this.dq.at(c, this.t) >= 1)) {
          const lbl = tt.total > 21 ? `${tt.total} 爆` : `${tt.total}${tt.soft && tt.total < 21 ? '（软）' : ''}`
          const res = h.result && this.settled ? ` · ${RES_TXT[h.result]}` : ''
          const col = res ? (h.result === 'win' || h.result === 'blackjack' ? '#ffd33d' : h.result === 'push' ? '#ddd' : '#ff6b6b') : tt.total > 21 ? '#ff6b6b' : '#fff'
          this.text(lbl + res, cx, 280, 16, col, 'center', 800)
        }
        if (this.inRound) {
          this.drawStack(cx, 440, h.bet, 15)
          if (h.doubled) this.text('加倍', cx + 40, 440, 12, '#ffd33d')
        }
      })
      if (r.insuranceBet > 0) { this.text('保险', 200, 200, 12, '#ccc'); this.drawStack(200, 230, r.insuranceBet, 13) }
    }
    // 下注圈（下注阶段）
    const betting = !this.inRound
    if (betting) {
      g.strokeStyle = this.hovered('bet:main') ? '#ffd33d' : 'rgba(255,255,255,.6)'; g.lineWidth = 3
      g.beginPath(); g.arc(VW / 2, 470, 44, 0, Math.PI * 2); g.stroke()
      if (!r || this.settled) this.text(this.betTotal ? '' : '点击下注', VW / 2, 470, 13, 'rgba(255,255,255,.7)')
      this.drawStack(VW / 2, 474, this.betTotal, 18)
      this.region('bet:main', VW / 2 - 46, 424, 92, 92, true, () => this.place('main'))
    }
    // 按钮
    const bx = 640, by = 540, bw = 100, bh = 52
    if (betting) {
      this.button('btn:clear', bx, by, bw, bh, '清除', this.betTotal > 0, () => this.clearBets(), '#adb5bd')
      this.button('btn:rebet', bx + 110, by, bw, bh, '重复', this.betTotal === 0 && Object.keys(this.lastBets).length > 0, () => this.rebet(), '#adb5bd')
      this.button('btn:deal', bx + 220, by, 200, bh, '发牌', this.betTotal > 0, () => this.deal(), '#ffd33d', 'Space')
      this.status = this.betTotal ? `下注 ${money(this.betTotal)} · 最低 ${money(this.hall.min)}` : '选筹码 → 点下注圈 → 发牌'
    } else if (r && r.phase === 'insurance') {
      const busy = this.dq.busy(this.t)
      this.button('btn:insure', bx, by, 190, bh, `买保险 ${money(r.baseBet / 2)}`, !busy && this.cash >= r.baseBet / 2, () => this.insure(true), '#74c0fc', 'I')
      this.button('btn:noinsure', bx + 200, by, 190, bh, '不买', !busy, () => this.insure(false), '#adb5bd', 'N')
      this.status = '庄家明牌 A：要买保险吗？（保险赔 2:1，基本策略建议不买）'
    } else if (r && r.phase === 'player') {
      const busy = this.dq.busy(this.t), extra = r.hand.bet
      const acts: [BjAction, string, string][] = [['hit', '#ffd33d', 'H'], ['stand', '#ff922b', 'S'], ['double', '#69db7c', 'D'], ['split', '#74c0fc', 'P']]
      acts.forEach(([a, col, key], i) => {
        const needCash = a === 'double' || a === 'split'
        const ok = !busy && r.legal(a) && (!needCash || this.cash >= extra)
        this.button(`btn:${a}`, bx + i * 110 - 60, by, bw, bh, ACT_TXT[a], ok, () => this.act(a), col, key)
      })
      this.status = `建议（基本策略）：${ACT_TXT[bjBasic(r)]}${r.hands.length > 1 ? ` · 第 ${r.active + 1}/${r.hands.length} 手` : ''}`
    } else this.status = '庄家补牌…'
    this.chipRack(betting)
  }

  protected keys(input: Input) {
    if (input.justPressed('Space') || input.justPressed('Enter')) { if (!this.inRound && this.betTotal > 0) this.deal() }
    const r = this.round; if (!r || this.settled) return
    if (r.phase === 'insurance') { if (input.justPressed('KeyI')) this.insure(true); if (input.justPressed('KeyN')) this.insure(false); return }
    if (input.justPressed('KeyH')) this.act('hit')
    if (input.justPressed('KeyS')) this.act('stand')
    if (input.justPressed('KeyD') && this.cash >= r.hand.bet) this.act('double')
    if (input.justPressed('KeyP') && this.cash >= r.hand.bet) this.act('split')
  }
}
