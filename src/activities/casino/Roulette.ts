import type { Input } from '../../core/Input'
import { WHEEL_ORDER } from '../../data/casino'
import { rouletteSpin, rouletteReturn, rouletteColor, rouletteParse } from './rules'
import { Table, money } from './table'
import { t } from '../../i18n'

const CX = 250, CY = 290, R = 205
const BX = 520, BY = 110, CW = 42, CH = 52
const SPIN_T = 5.2
const TAU = Math.PI * 2, SEG = TAU / 37
const COL = { red: '#c1121f', black: '#161616', green: '#138a36' }

/** 欧式单零轮盘：直注 35:1、红黑 / 单双 / 大小 1:1、打 / 列 2:1，可多注 */
export class RouletteTable extends Table {
  readonly game = 'roulette' as const
  private wa = 0
  private spin: { t: number; n: number; w0: number; wv: number; b0: number; bv: number; stake: number; bets: Record<string, number>; lastSeg: number } | null = null
  private history: number[] = []
  private lastWin: number | null = null
  private forced: number | null = null
  protected bannerAt = { x: 830, y: 455 }

  get inRound() { return !!this.spin }
  get phase() { return this.spin ? 'spin' : 'bet' }
  /** 测试：下一转固定开出 n */
  forceNext(n: number) { this.forced = n }

  private start() {
    if (this.spin) return
    const stake = this.commitBets(); if (!stake) return
    const n = this.forced ?? rouletteSpin(); this.forced = null
    const w0 = this.wa, wv = TAU * 0.55
    const wEnd = w0 + wv * SPIN_T / 2
    const target = wEnd + WHEEL_ORDER.indexOf(n) * SEG
    const b0 = Math.random() * TAU
    const d = (((b0 - target) % TAU) + TAU) % TAU + TAU * 7
    this.spin = { t: 0, n, w0, wv, b0, bv: (2 * d) / SPIN_T, stake, bets: { ...this.bets }, lastSeg: 0 }
    this.lastWin = null
    this.status = t('买定离手…')
  }

  private settle() {
    const sp = this.spin!; this.spin = null
    const ret = rouletteReturn(sp.bets, sp.n)
    this.history.unshift(sp.n); this.history.length = Math.min(this.history.length, 14)
    this.lastWin = sp.n
    this.bets = {}
    const c = rouletteColor(sp.n)
    this.finishRound(sp.stake, ret, `${sp.n} ${c === 'red' ? t('红') : c === 'black' ? t('黑') : t('零')} · ${ret > sp.stake ? t('赢 {n}', { n: money(ret - sp.stake) }) : ret === sp.stake ? t('持平') : t('输 {n}', { n: money(sp.stake - ret) })}`)
  }
  forceFinish() { if (this.spin) this.settle() }

  private ballPos(): { a: number; r: number } | null {
    const sp = this.spin; if (!sp) return this.lastWin === null ? null : { a: this.wa + WHEEL_ORDER.indexOf(this.lastWin) * SEG, r: R * 0.6 }
    const tau = Math.min(sp.t, SPIN_T), f = tau - (tau * tau) / (2 * SPIN_T)
    const a = sp.b0 - sp.bv * f
    const k = tau / SPIN_T
    let r = R * 0.9
    if (k > 0.55) {
      const q = Math.min(1, (k - 0.55) / 0.35)
      r = R * (0.9 - 0.3 * q) + Math.abs(Math.sin(q * Math.PI * 3)) * (1 - q) * R * 0.05
    }
    return { a, r }
  }

  protected tick(dt: number) {
    const sp = this.spin
    if (!sp) { this.wa += dt * 0.15; return }
    sp.t += dt
    const tau = Math.min(sp.t, SPIN_T)
    this.wa = sp.w0 + sp.wv * (tau - (tau * tau) / (2 * SPIN_T))
    const b = this.ballPos()!
    const seg = Math.floor((b.a - this.wa) / SEG)
    if (seg !== sp.lastSeg) {
      sp.lastSeg = seg
      const k = sp.t / SPIN_T
      if (k > 0.55 && k < 1) this.sfx.tick(0.06 + 0.12 * (1 - k))
      else if (k <= 0.55 && Math.random() < 0.15) this.sfx.tick(0.04)
    }
    if (sp.t >= SPIN_T && sp.t - dt < SPIN_T) this.sfx.ballDrop()
    if (sp.t >= SPIN_T + 0.8) this.settle()
  }

  private drawWheel() {
    const g = this.g
    g.save(); g.translate(CX, CY)
    // 木框
    g.fillStyle = '#4a2c14'; g.beginPath(); g.arc(0, 0, R + 18, 0, TAU); g.fill()
    g.fillStyle = '#6b3f1d'; g.beginPath(); g.arc(0, 0, R + 6, 0, TAU); g.fill()
    g.fillStyle = '#2a1708'; g.beginPath(); g.arc(0, 0, R * 0.95, 0, TAU); g.fill()
    g.rotate(this.wa)
    for (let i = 0; i < 37; i++) {
      const n = WHEEL_ORDER[i], a0 = i * SEG - SEG / 2 - Math.PI / 2
      g.fillStyle = COL[rouletteColor(n)]
      g.beginPath(); g.moveTo(0, 0); g.arc(0, 0, R * 0.82, a0, a0 + SEG); g.closePath(); g.fill()
      g.strokeStyle = '#d4af37'; g.lineWidth = 1; g.stroke()
      g.save(); g.rotate(i * SEG)
      this.text(String(n), 0, -R * 0.74, 13, '#fff', 'center', 800)
      g.restore()
    }
    // 球袋内圈
    g.fillStyle = '#3b2412'; g.beginPath(); g.arc(0, 0, R * 0.55, 0, TAU); g.fill()
    for (let i = 0; i < 37; i++) {
      const a = i * SEG - SEG / 2 - Math.PI / 2
      g.strokeStyle = '#d4af37'; g.lineWidth = 1.5
      g.beginPath(); g.moveTo(Math.cos(a) * R * 0.55, Math.sin(a) * R * 0.55); g.lineTo(Math.cos(a) * R * 0.66, Math.sin(a) * R * 0.66); g.stroke()
    }
    const grd = g.createRadialGradient(-10, -10, 4, 0, 0, R * 0.42)
    grd.addColorStop(0, '#f6e7b0'); grd.addColorStop(1, '#8a6a1f')
    g.fillStyle = grd; g.beginPath(); g.arc(0, 0, R * 0.42, 0, TAU); g.fill()
    g.strokeStyle = '#d4af37'; g.lineWidth = 6
    for (let i = 0; i < 4; i++) { const a = (i * Math.PI) / 2; g.beginPath(); g.moveTo(0, 0); g.lineTo(Math.cos(a) * R * 0.36, Math.sin(a) * R * 0.36); g.stroke() }
    g.fillStyle = '#d4af37'; g.beginPath(); g.arc(0, 0, 12, 0, TAU); g.fill()
    g.restore()
    // 小球（-π/2 为 12 点方向，与格子起点一致）
    const b = this.ballPos()
    if (b) {
      const x = CX + Math.cos(b.a - Math.PI / 2) * b.r, y = CY + Math.sin(b.a - Math.PI / 2) * b.r
      g.fillStyle = 'rgba(0,0,0,.4)'; g.beginPath(); g.arc(x + 2, y + 2, 7, 0, TAU); g.fill()
      const bg = g.createRadialGradient(x - 2, y - 2, 1, x, y, 7)
      bg.addColorStop(0, '#fff'); bg.addColorStop(1, '#bbb')
      g.fillStyle = bg; g.beginPath(); g.arc(x, y, 7, 0, TAU); g.fill()
    }
  }

  private cell(key: string, x: number, y: number, w: number, h: number, label: string, fill: string, size = 15) {
    const g = this.g, betting = !this.spin
    const { kind, n } = rouletteParse(key)
    const win = this.lastWin !== null && !this.spin && (kind === 'straight' ? n === this.lastWin : false)
    g.fillStyle = fill; g.fillRect(x, y, w, h)
    if (betting && this.hovered(key)) { g.fillStyle = 'rgba(255,255,255,.18)'; g.fillRect(x, y, w, h) }
    g.strokeStyle = '#f1f1f1'; g.lineWidth = 1.5; g.strokeRect(x, y, w, h)
    if (win) { g.strokeStyle = '#ffd33d'; g.lineWidth = 4; g.strokeRect(x + 2, y + 2, w - 4, h - 4) }
    this.text(label, x + w / 2, y + h / 2, size, '#fff', 'center', 800)
    const amt = (this.spin ? this.spin.bets : this.bets)[key]
    if (amt) this.drawChip(x + w / 2 + 8, y + h / 2 - 6, amt, 12)
    this.region(key, x, y, w, h, betting, () => this.place(key))
  }

  protected draw() {
    this.drawWheel()
    // 下注台
    this.cell('straight:0', BX - 42, BY, 42, CH * 3, '0', COL.green, 18)
    for (let c = 0; c < 12; c++) for (let r = 0; r < 3; r++) {
      const n = c * 3 + (3 - r)
      this.cell(`straight:${n}`, BX + c * CW, BY + r * CH, CW, CH, String(n), COL[rouletteColor(n) as 'red' | 'black'])
    }
    for (let r = 0; r < 3; r++) this.cell(`column:${3 - r}`, BX + 12 * CW, BY + r * CH, 48, CH, '2:1', '#0d5c37', 13)
    const dz = [t('第一打 1–12'), t('第二打 13–24'), t('第三打 25–36')]
    for (let i = 0; i < 3; i++) this.cell(`dozen:${i + 1}`, BX + i * 4 * CW, BY + 3 * CH, 4 * CW, 40, dz[i], '#0d5c37', 13)
    const out: [string, string, string][] = [['low', '1–18', '#0d5c37'], ['even', t('双'), '#0d5c37'], ['red', t('红'), COL.red], ['black', t('黑'), COL.black], ['odd', t('单'), '#0d5c37'], ['high', '19–36', '#0d5c37']]
    out.forEach(([k, l, f], i) => this.cell(k, BX + i * 2 * CW, BY + 3 * CH + 40, 2 * CW, 40, l, f, 14))
    this.text(t('直注 35:1 · 打 / 列 2:1 · 红黑 / 单双 / 大小 1:1 · 开 0 时外围注全输'), BX + 6 * CW, BY - 18, 12, 'rgba(255,255,255,.7)')
    // 历史
    const hy = BY + 3 * CH + 110
    this.text(t('最近开出'), BX - 42, hy, 12, 'rgba(255,255,255,.7)', 'left')
    this.history.forEach((n, i) => {
      const x = BX + 20 + i * 36
      this.g.fillStyle = COL[rouletteColor(n)]; this.g.beginPath(); this.g.arc(x, hy, 14, 0, TAU); this.g.fill()
      this.text(String(n), x, hy, 12, '#fff', 'center', 800)
    })
    // 按钮
    const betting = !this.spin, bx = 640, by = 540
    this.button('btn:clear', bx, by, 100, 52, t('清除'), betting && this.betTotal > 0, () => this.clearBets(), '#adb5bd')
    this.button('btn:rebet', bx + 110, by, 100, 52, t('重复'), betting && this.betTotal === 0 && Object.keys(this.lastBets).length > 0, () => this.rebet(), '#adb5bd')
    this.button('btn:spin', bx + 220, by, 200, 52, t('开转'), betting && this.betTotal > 0, () => this.start(), '#ffd33d', 'Space')
    if (betting) {
      const n = Object.keys(this.bets).length
      this.status = this.betTotal ? t('{n} 注 · 共 {total}', { n, total: money(this.betTotal) }) : t('选筹码 → 点格子下注（可多注）→ 开转')
    }
    this.chipRack(betting)
  }

  protected keys(input: Input) {
    if ((input.justPressed('Space') || input.justPressed('Enter')) && !this.spin && this.betTotal > 0) this.start()
  }
}
