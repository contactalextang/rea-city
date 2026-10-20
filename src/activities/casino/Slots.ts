import type { Input } from '../../core/Input'
import { SLOT_LINES, SLOT_PAYS_3, SLOT_CHERRY, SLOT_SYMS, type SlotSym } from '../../data/casino'
import { SLOT_STRIPS, slotSpin, slotGrid, slotEval, slotTheoryRtp, type SlotWin } from './rules'
import { Table, money } from './table'

const RX = 300, RY = 110, RW = 150, RG = 14, RH = 108
const STOP_T = [1.0, 1.4, 1.8]
const LINE_COL = ['#ffd33d', '#ff6b6b', '#4dabf7', '#69db7c', '#da77f2']
const L = SLOT_STRIPS[0].length
const mod = (a: number, n: number) => ((a % n) + n) % n

/** 老虎机：3 轴 × 3 行，5 条线（中 / 上 / 下 / 两条对角），RTP ≈ 94% */
export class SlotsTable extends Table {
  readonly game = 'slots' as const
  private pos = [0, 7, 15]
  private spin: { t: number; p0: number[]; d: number[]; stops: number[]; bet: number; stopped: boolean[] } | null = null
  private wins: SlotWin[] = []
  private winT = 0
  private tickAcc = 0
  private forced: number[] | null = null
  readonly rtp = slotTheoryRtp()
  protected bannerAt = { x: RX + (RW * 3 + RG * 2) / 2, y: 470 }

  get inRound() { return !!this.spin }
  get phase() { return this.spin ? 'spin' : 'bet' }
  /** 测试：下一转固定停位 */
  forceNext(stops: number[]) { this.forced = stops }

  private start() {
    if (this.spin) return
    const bet = this.chip
    if (bet < this.hall.min || bet > this.hall.max) { this.notice(`本厅每转 ${money(this.hall.min)}–${money(this.hall.max)}`, 1.5); return }
    if (!this.host.stake(this.game, bet)) { this.notice('现金不足', 1.4); return }
    const stops = this.forced ?? slotSpin(); this.forced = null
    const p0 = this.pos.map((p) => mod(p, L))
    const d = stops.map((s, i) => mod(p0[i] - s, L) + L * (3 + i))
    this.spin = { t: 0, p0, d, stops, bet, stopped: [false, false, false] }
    this.wins = []
    this.status = '旋转中…'
  }
  private settle() {
    const sp = this.spin!; this.spin = null
    this.pos = sp.stops.slice()
    const { wins, ret } = slotEval(slotGrid(sp.stops), sp.bet / 5)
    this.wins = wins; this.winT = 0
    const best = wins.reduce((a, w) => Math.max(a, w.pay), 0)
    const tag = wins.length ? `${wins.length} 条线中奖` : '未中奖'
    this.finishRound(sp.bet, ret, ret > 0 ? `${tag} · 返还 ${money(ret)}${best >= sp.bet * 20 ? ' · 大奖！' : ''}` : `${tag} · 输 ${money(sp.bet)}`)
  }
  forceFinish() { if (this.spin) this.settle() }

  protected tick(dt: number) {
    this.winT += dt
    const sp = this.spin; if (!sp) return
    sp.t += dt
    for (let i = 0; i < 3; i++) {
      const k = Math.min(1, sp.t / STOP_T[i])
      // easeOutBack：停轴时略微回弹
      const c = 1.2, e = 1 + (c + 1) * (k - 1) ** 3 + c * (k - 1) ** 2
      this.pos[i] = sp.p0[i] - sp.d[i] * e
      if (k >= 1 && !sp.stopped[i]) { sp.stopped[i] = true; this.pos[i] = sp.stops[i]; this.sfx.reelStop() }
    }
    this.tickAcc += dt
    if (!sp.stopped[2] && this.tickAcc > 0.07) { this.tickAcc = 0; this.sfx.reelTick() }
    if (sp.t >= STOP_T[2] + 0.35) this.settle()
  }

  drawSym(sym: SlotSym, x: number, y: number, s: number) {
    const g = this.g
    const col = SLOT_SYMS.find((q) => q.id === sym)!.color
    // 按 97 px 基准画，再整体缩放
    g.save(); g.translate(x, y); g.scale(s / 97, s / 97); s = 97
    switch (sym) {
      case 'cherry':
        g.strokeStyle = '#2b8a3e'; g.lineWidth = 4
        g.beginPath(); g.moveTo(-14, 6); g.quadraticCurveTo(-4, -24, 10, -30); g.moveTo(14, 10); g.quadraticCurveTo(8, -16, 10, -30); g.stroke()
        for (const [cx, cy] of [[-16, 14], [14, 18]]) {
          g.fillStyle = col; g.beginPath(); g.arc(cx, cy, s * 0.17, 0, Math.PI * 2); g.fill()
          g.fillStyle = 'rgba(255,255,255,.55)'; g.beginPath(); g.arc(cx - 5, cy - 5, 4, 0, Math.PI * 2); g.fill()
        }
        break
      case 'lemon': case 'orange': case 'plum': {
        const rx = sym === 'lemon' ? s * 0.36 : s * 0.3, ry = sym === 'lemon' ? s * 0.25 : s * 0.3
        g.fillStyle = col; g.beginPath(); g.ellipse(0, 4, rx, ry, sym === 'plum' ? 0.3 : 0, 0, Math.PI * 2); g.fill()
        g.fillStyle = 'rgba(255,255,255,.4)'; g.beginPath(); g.ellipse(-rx * 0.35, -ry * 0.3, rx * 0.25, ry * 0.18, -0.5, 0, Math.PI * 2); g.fill()
        g.fillStyle = '#2f9e44'; g.beginPath(); g.ellipse(6, -ry - 2, 10, 5, -0.5, 0, Math.PI * 2); g.fill()
        break
      }
      case 'bell':
        g.fillStyle = col
        g.beginPath(); g.moveTo(-s * 0.32, s * 0.22); g.quadraticCurveTo(-s * 0.26, -s * 0.34, 0, -s * 0.34); g.quadraticCurveTo(s * 0.26, -s * 0.34, s * 0.32, s * 0.22); g.closePath(); g.fill()
        g.fillStyle = '#b8860b'; g.fillRect(-s * 0.36, s * 0.2, s * 0.72, 7)
        g.beginPath(); g.arc(0, s * 0.3, 7, 0, Math.PI * 2); g.fill()
        break
      case 'bar':
        g.fillStyle = '#111'; this.rr(-s * 0.4, -s * 0.18, s * 0.8, s * 0.36, 6); g.fill()
        g.strokeStyle = '#e9ecef'; g.lineWidth = 3; g.stroke()
        this.text('BAR', 0, 1, s * 0.26, '#fff', 'center', 900)
        break
      case 'seven':
        g.save(); g.shadowColor = '#000'; g.shadowBlur = 4
        this.text('7', 0, 2, s * 0.8, col, 'center', 900)
        g.restore()
        break
      case 'merlion':
        g.fillStyle = '#e7f5ff'; g.beginPath(); g.arc(0, -6, s * 0.2, 0, Math.PI * 2); g.fill()
        g.fillStyle = col
        g.beginPath(); g.moveTo(-s * 0.18, 0); g.quadraticCurveTo(-s * 0.3, s * 0.3, 0, s * 0.36); g.quadraticCurveTo(s * 0.3, s * 0.3, s * 0.14, 0); g.closePath(); g.fill()
        g.fillStyle = '#1864ab'; g.beginPath(); g.arc(6, -10, 3, 0, Math.PI * 2); g.fill()
        g.strokeStyle = '#74c0fc'; g.lineWidth = 3; g.beginPath(); g.moveTo(s * 0.18, -6); g.quadraticCurveTo(s * 0.4, -4, s * 0.42, s * 0.12); g.stroke()
        break
    }
    g.restore()
  }

  protected draw() {
    const g = this.g
    // 机身
    g.fillStyle = '#3a0d14'; this.rr(RX - 50, RY - 70, RW * 3 + RG * 2 + 100, RH * 3 + 140, 26); g.fill()
    g.strokeStyle = '#d4af37'; g.lineWidth = 4; g.stroke()
    this.text('MERLION 777', RX + (RW * 3 + RG * 2) / 2, RY - 38, 28, '#ffd33d', 'center', 900)
    for (let i = 0; i < 3; i++) {
      const x = RX + i * (RW + RG)
      const grd = g.createLinearGradient(0, RY, 0, RY + RH * 3)
      grd.addColorStop(0, '#9a9a9a'); grd.addColorStop(0.18, '#fff'); grd.addColorStop(0.82, '#fff'); grd.addColorStop(1, '#9a9a9a')
      g.fillStyle = grd; g.fillRect(x, RY, RW, RH * 3)
      g.save(); g.beginPath(); g.rect(x, RY, RW, RH * 3); g.clip()
      const p = this.pos[i], strip = SLOT_STRIPS[i]
      const moving = this.spin && !this.spin.stopped[i]
      for (let j = Math.floor(p) - 2; j <= Math.floor(p) + 3; j++) {
        const y = RY + RH * 1.5 + (j - p) * RH
        if (moving) g.globalAlpha = 0.75
        this.drawSym(strip[mod(j, L)], x + RW / 2, y, RH * 0.9)
        g.globalAlpha = 1
      }
      g.restore()
      g.strokeStyle = '#d4af37'; g.lineWidth = 2; g.strokeRect(x, RY, RW, RH * 3)
    }
    // 线号
    SLOT_LINES.forEach((rows, li) => {
      const y0 = RY + RH * (rows[0] + 0.5), y2 = RY + RH * (rows[2] + 0.5)
      this.g.fillStyle = LINE_COL[li]; this.g.beginPath(); this.g.arc(RX - 26, y0 + (li >= 3 ? (li === 3 ? -22 : 22) : 0), 11, 0, Math.PI * 2); this.g.fill()
      this.text(String(li + 1), RX - 26, y0 + (li >= 3 ? (li === 3 ? -22 : 22) : 0), 12, '#111', 'center', 900)
      void y2
    })
    // 中奖线
    if (!this.spin && this.wins.length) {
      const blink = Math.floor(this.winT * 3) % 2 === 0 || this.winT > 3
      this.wins.forEach((w) => {
        const rows = SLOT_LINES[w.line]
        g.strokeStyle = LINE_COL[w.line]; g.lineWidth = blink ? 6 : 3; g.globalAlpha = 0.9
        g.beginPath()
        rows.forEach((r, i) => { const x = RX + i * (RW + RG) + RW / 2, y = RY + RH * (r + 0.5); if (i) g.lineTo(x, y); else g.moveTo(x - RW / 2, y) })
        g.lineTo(RX + 2 * (RW + RG) + RW, RY + RH * (rows[2] + 0.5))
        g.stroke(); g.globalAlpha = 1
      })
    }
    // 赔率表
    const px = 850
    this.text('赔率（× 每线注）', px, 108, 14, '#ffd33d', 'left', 800)
    const order: SlotSym[] = ['merlion', 'seven', 'bar', 'bell', 'plum', 'orange', 'lemon', 'cherry']
    order.forEach((s, i) => {
      const y = 140 + i * 36
      for (let k = 0; k < 3; k++) this.drawSym(s, px + 14 + k * 30, y, 30)
      this.text(`${SLOT_PAYS_3[s]}`, px + 120, y, 15, '#fff', 'left', 800)
    })
    this.text(`樱桃：第 1 轴起 1 颗 ×${SLOT_CHERRY.one} · 2 颗 ×${SLOT_CHERRY.two}`, px, 140 + 8 * 36, 12, '#fff', 'left', 600)
    this.text(`5 条线 · 每线注 = 总注 / 5 · RTP ${(this.rtp * 100).toFixed(1)}%`, px, 140 + 8 * 36 + 22, 11, 'rgba(255,255,255,.7)', 'left', 500)
    // 按钮
    const betting = !this.spin, bx = 640, by = 540
    this.button('btn:spin', bx + 220, by, 200, 52, `旋转 ${money(this.chip)}`, betting && this.cash >= this.chip, () => this.start(), '#ffd33d', 'Space')
    if (betting) this.status = `每转 ${money(this.chip)}（点筹码改注）· 每线 ${money(this.chip / 5)}`
    this.chipRack(betting)
  }

  protected keys(input: Input) {
    if ((input.justPressed('Space') || input.justPressed('Enter')) && !this.spin) this.start()
  }
}
