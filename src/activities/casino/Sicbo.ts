import type { Input } from '../../core/Input'
import { SICBO_PAYS } from '../../data/casino'
import { rollDice, sicboReturn, sicboOdds } from './rules'
import { Table, money } from './table'
import { t } from '../../i18n'

const BX = 420, BW = 660
const SHAKE_T = 1.7
const PIPS: Record<number, [number, number][]> = {
  1: [[0, 0]], 2: [[-1, -1], [1, 1]], 3: [[-1, -1], [0, 0], [1, 1]],
  4: [[-1, -1], [1, -1], [-1, 1], [1, 1]], 5: [[-1, -1], [1, -1], [0, 0], [-1, 1], [1, 1]],
  6: [[-1, -1], [1, -1], [-1, 0], [1, 0], [-1, 1], [1, 1]],
}

/** 骰宝：大小（围骰庄赢）、单双、单点 1/2/3 倍、总点数、全围、指定围骰、指定对子 */
export class SicboTable extends Table {
  readonly game = 'sicbo' as const
  private roll: { t: number; d: [number, number, number]; stake: number; bets: Record<string, number>; shakeT: number } | null = null
  private last: number[] | null = null
  private history: number[][] = []
  private forced: [number, number, number] | null = null
  protected bannerAt = { x: BX + BW / 2, y: 52 }

  get inRound() { return !!this.roll }
  get phase() { return this.roll ? 'roll' : 'bet' }
  forceNext(d: [number, number, number]) { this.forced = d }

  private start() {
    if (this.roll) return
    const stake = this.commitBets(); if (!stake) return
    const d = this.forced ?? rollDice(); this.forced = null
    this.roll = { t: 0, d, stake, bets: { ...this.bets }, shakeT: 0 }
    this.last = null
    this.status = t('摇骰中…')
  }
  private settle() {
    const r = this.roll!; this.roll = null
    const ret = sicboReturn(r.bets, r.d)
    this.last = r.d
    this.history.unshift(r.d); this.history.length = Math.min(this.history.length, 8)
    this.bets = {}
    const sum = r.d[0] + r.d[1] + r.d[2], tri = r.d[0] === r.d[1] && r.d[1] === r.d[2]
    const tag = tri ? t('围骰 {n}', { n: r.d[0] }) : t('{n} 点 {bs}', { n: sum, bs: sum >= 11 ? t('大') : t('小') })
    this.finishRound(r.stake, ret, `${r.d.join('-')} · ${tag} · ${ret > r.stake ? t('赢 {n}', { n: money(ret - r.stake) }) : ret === r.stake ? t('持平') : t('输 {n}', { n: money(r.stake - ret) })}`)
  }
  forceFinish() { if (this.roll) this.settle() }

  protected tick(dt: number) {
    const r = this.roll; if (!r) return
    r.t += dt
    if (r.t < SHAKE_T) { r.shakeT -= dt; if (r.shakeT <= 0) { this.sfx.rattle(); r.shakeT = 0.16 } }
    else if (r.t - dt < SHAKE_T) this.sfx.thump()
    if (r.t >= SHAKE_T + 1.0) this.settle()
  }

  drawDie(x: number, y: number, s: number, face: number, rot = 0, hl = false) {
    const g = this.g
    g.save(); g.translate(x, y); g.rotate(rot)
    g.fillStyle = 'rgba(0,0,0,.35)'; this.rr(-s / 2 + 3, -s / 2 + 4, s, s, s * 0.18); g.fill()
    g.fillStyle = hl ? '#fff3bf' : '#fbfbf8'; this.rr(-s / 2, -s / 2, s, s, s * 0.18); g.fill()
    g.strokeStyle = '#bbb'; g.lineWidth = 1; g.stroke()
    for (const [px, py] of PIPS[face]) {
      g.fillStyle = face === 1 || face === 4 ? '#c1121f' : '#111'
      g.beginPath(); g.arc(px * s * 0.26, py * s * 0.26, s * (face === 1 ? 0.13 : 0.09), 0, Math.PI * 2); g.fill()
    }
    g.restore()
  }

  private cell(key: string, x: number, y: number, w: number, h: number, label: string, odds: string, fill = '#0d5c37', dieFace = 0) {
    const g = this.g, betting = !this.roll
    const win = this.last && !this.roll && sicboOdds(key, this.last) >= 0
    g.fillStyle = fill; this.rr(x, y, w, h, 6); g.fill()
    if (betting && this.hovered(key)) { g.fillStyle = 'rgba(255,255,255,.16)'; this.rr(x, y, w, h, 6); g.fill() }
    g.strokeStyle = win ? '#ffd33d' : 'rgba(255,255,255,.6)'; g.lineWidth = win ? 3.5 : 1.2; this.rr(x, y, w, h, 6); g.stroke()
    if (dieFace) {
      this.drawDie(x + w / 2, y + h / 2 - 7, Math.min(28, h - 26), dieFace)
      this.text(odds, x + w / 2, y + h - 10, 11, '#ffd33d', 'center', 600)
    } else {
      this.text(label, x + w / 2, y + h / 2 - (odds ? 8 : 0), h > 50 ? 20 : 15, '#fff', 'center', 800)
      if (odds) this.text(odds, x + w / 2, y + h / 2 + 13, 11, '#ffd33d', 'center', 600)
    }
    const amt = (this.roll ? this.roll.bets : this.bets)[key]
    if (amt) this.drawChip(x + w - 16, y + 16, amt, 12)
    this.region(key, x, y, w, h, betting, () => this.place(key))
  }

  private drawTriple(key: string, x: number, y: number, w: number, h: number, f: number, odds: string, n: number) {
    this.cell(key, x, y, w, h, '', '', '#0b4a2e')
    const s = n === 3 ? 18 : 20
    for (let i = 0; i < n; i++) this.drawDie(x + w / 2 + (i - (n - 1) / 2) * (s + 4), y + h / 2 - 6, s, f)
    this.text(odds, x + w / 2, y + h - 9, 10, '#ffd33d', 'center', 600)
    const amt = (this.roll ? this.roll.bets : this.bets)[key]
    if (amt) this.drawChip(x + w - 14, y + 14, amt, 11)   // 骰子画在 cell 的筹码之上，这里再画一次保证可见
  }

  protected draw() {
    const g = this.g
    // 骰盅
    const cx = 210, cy = 210
    g.fillStyle = '#3d2410'; g.beginPath(); g.ellipse(cx, cy + 20, 160, 120, 0, 0, Math.PI * 2); g.fill()
    g.fillStyle = '#d9c7a0'; g.beginPath(); g.ellipse(cx, cy + 10, 140, 100, 0, 0, Math.PI * 2); g.fill()
    const r = this.roll
    const shaking = r && r.t < SHAKE_T
    const faces = r ? (shaking ? [0, 1, 2].map(() => 1 + Math.floor(Math.random() * 6)) : r.d) : this.last ?? [1, 2, 3]
    faces.forEach((f, i) => {
      const jx = shaking ? (Math.random() - 0.5) * 30 : 0, jy = shaking ? (Math.random() - 0.5) * 24 : 0
      const rot = shaking ? Math.random() * 6 : [-0.2, 0.15, 0.4][i]
      this.drawDie(cx - 60 + i * 60 + jx, cy + 10 + (i === 1 ? -22 : 10) + jy, 50, f, rot, !!this.last && !r)
    })
    if (shaking) {
      // 盅盖
      const lift = Math.sin(r!.t * 30) * 6
      g.fillStyle = 'rgba(160,110,40,.92)'; g.beginPath(); g.ellipse(cx, cy - 10 + lift, 130, 110, 0, Math.PI, 0); g.lineTo(cx + 130, cy + 30 + lift); g.ellipse(cx, cy + 30 + lift, 130, 30, 0, 0, Math.PI); g.closePath(); g.fill()
      g.strokeStyle = '#ffd33d'; g.lineWidth = 3; g.stroke()
      this.text(t('骰宝'), cx, cy - 40 + lift, 28, '#fff3bf', 'center', 900)
    }
    if (this.last && !r) {
      const s = this.last[0] + this.last[1] + this.last[2], tri = this.last[0] === this.last[1] && this.last[1] === this.last[2]
      this.text(tri ? t('围骰 {n}', { n: this.last[0] }) : t('{n} 点 · {bs} · {oe}', { n: s, bs: s >= 11 ? t('大') : t('小'), oe: s % 2 ? t('单') : t('双') }), cx, cy + 150, 20, '#ffd33d', 'center', 800)
    }
    // 历史
    this.text(t('最近'), 40, 395, 12, 'rgba(255,255,255,.7)', 'left')
    this.history.forEach((d, i) => {
      const y = 420 + Math.floor(i / 2) * 26, x = 60 + (i % 2) * 160
      d.forEach((f, j) => this.drawDie(x + j * 24, y, 20, f))
      const s = d[0] + d[1] + d[2]
      this.text(`${s}`, x + 80, y, 13, '#fff', 'left')
    })
    // 下注台
    let y = 96
    this.cell('small', BX, y, 150, 66, t('小 4–10'), t('1:1 · 围骰庄赢'))
    this.cell('odd', BX + 158, y, 108, 66, t('单'), '1:1')
    this.cell('anyTriple', BX + 274, y, 112, 66, t('全围'), `${SICBO_PAYS.anyTriple}:1`, '#7a1f1f')
    this.cell('even', BX + 394, y, 108, 66, t('双'), '1:1')
    this.cell('big', BX + 510, y, 150, 66, t('大 11–17'), t('1:1 · 围骰庄赢'))
    y = 172
    const cw = (BW - 5 * 6) / 6
    for (let f = 1; f <= 6; f++) this.drawTriple(`triple:${f}`, BX + (f - 1) * (cw + 6), y, cw, 54, f, t('围骰 {n}', { n: `${SICBO_PAYS.triple}:1` }), 3)
    y = 232
    for (let f = 1; f <= 6; f++) this.drawTriple(`double:${f}`, BX + (f - 1) * (cw + 6), y, cw, 50, f, t('对子 {n}:1', { n: SICBO_PAYS.double }), 2)
    y = 290
    const tw = (BW - 13 * 3) / 14
    for (let t = 4; t <= 17; t++) this.cell(`total:${t}`, BX + (t - 4) * (tw + 3), y, tw, 58, String(t), `${SICBO_PAYS.total[t]}:1`)
    y = 356
    for (let f = 1; f <= 6; f++) this.cell(`single:${f}`, BX + (f - 1) * (cw + 6), y, cw, 70, '', t('1/2/3 颗 1:1/2:1/3:1'), '#0d5c37', f)
    this.text(t('单点：押的点数出现 1 颗赔 1:1，2 颗 2:1，3 颗 3:1 · 大小 / 单双遇围骰全输'), BX + BW / 2, 446, 12, 'rgba(255,255,255,.65)')
    // 按钮
    const betting = !r, bx = 640, by = 540
    this.button('btn:clear', bx, by, 100, 52, t('清除'), betting && this.betTotal > 0, () => this.clearBets(), '#adb5bd')
    this.button('btn:rebet', bx + 110, by, 100, 52, t('重复'), betting && this.betTotal === 0 && Object.keys(this.lastBets).length > 0, () => this.rebet(), '#adb5bd')
    this.button('btn:roll', bx + 220, by, 200, 52, t('摇骰'), betting && this.betTotal > 0, () => this.start(), '#ffd33d', 'Space')
    if (betting) this.status = this.betTotal ? t('{n} 注 · 共 {total}', { n: Object.keys(this.bets).length, total: money(this.betTotal) }) : t('选筹码 → 点下注区（可多注）→ 摇骰')
    this.chipRack(betting)
  }

  protected keys(input: Input) {
    if ((input.justPressed('Space') || input.justPressed('Enter')) && !this.roll && this.betTotal > 0) this.start()
  }
}
