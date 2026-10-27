import type { ActivityApi, ActivityPointer } from '../../ui/Activity'
import type { Input } from '../../core/Input'
import type { Ctx } from '../../core/Context'
import type { CasinoGameId, HallDef } from '../../data/casino'
import { RANK_TXT, SUIT_TXT, type Card } from './rules'
import type { CasinoSfx } from './sfx'
import { t } from '../../i18n'

/** 赌桌 UI 依赖的宿主（Casino 插件实现）：押注扣钱、结算记账 / 统计 / 事件 */
export interface CasinoHost {
  readonly hall: HallDef
  readonly ctx: Ctx
  readonly sfx: CasinoSfx
  /** 扣下注（spend gamble:游戏）；钱不够返回 false */
  stake(game: CasinoGameId, amount: number): boolean
  /** 一局结算：stake = 本局押上总额，ret = 返还总额（earn），记统计、发 gambled 事件、连输提示 */
  settle(game: CasinoGameId, stake: number, ret: number, api: ActivityApi): void
}

export interface Region { id: string; x: number; y: number; w: number; h: number; enabled: boolean; onClick: () => void }

/** 设计稿尺寸：按比例缩放居中到活动内容区 */
export const VW = 1120, VH = 640

const CHIP_COLORS: [number, string, string][] = [
  [50000, '#1b1b1b', '#ffd700'], [25000, '#0b6e4f', '#ffd700'], [10000, '#7b2cbf', '#ffd700'], [5000, '#c77dff', '#3c096c'],
  [2500, '#ff8fab', '#590d22'], [1000, '#f9c74f', '#6a4c00'], [500, '#6f2dbd', '#fff'], [100, '#111', '#fff'],
  [50, '#f77f00', '#fff'], [25, '#2a9d8f', '#fff'], [10, '#1d4ed8', '#fff'], [0, '#e5e5e5', '#333'],
]
const chipColor = (v: number) => CHIP_COLORS.find(([d]) => v >= d)!
export const money = (n: number) => `$${(Math.round(n * 100) / 100).toLocaleString()}`
const short = (v: number) => (v >= 1000 ? `${v / 1000}K` : `${v}`)

/**
 * 赌桌基类：设计稿坐标系 + 点击区域 + 筹码架 + 下注区。子类实现 tick / draw / busy / forceFinish。
 * 每帧：布局缩放 → tick → 画 → 处理点击（最上层的区域优先）。
 */
export abstract class Table {
  protected g!: CanvasRenderingContext2D
  protected t = 0
  protected regions: Region[] = []
  protected s = 1
  protected ox = 0
  protected oy = 0
  /** 当前选中的筹码面额 */
  chip: number
  /** 尚未确认的下注（key → 金额） */
  bets: Record<string, number> = {}
  protected lastBets: Record<string, number> = {}
  /** 桌面中央大字结果 */
  protected banner: { text: string; color: string; t: number } | null = null
  /** 底部状态行 */
  protected status = ''
  /** 底部状态行位置的临时提示（替代顶部 api.toast，避免压住下注区说明文字） */
  private noticeText = ''
  private noticeUntil = 0
  private hoverId = ''
  /** 本帧之前排队的点击（自己监听 pointerdown，同一帧多次点击也不丢） */
  private clicks: { x: number; y: number }[] = []
  /** 结果横幅中心（设计稿坐标），各桌按布局调整 */
  protected bannerAt = { x: VW / 2, y: 303 }

  abstract readonly game: CasinoGameId
  constructor(protected host: CasinoHost, protected api: ActivityApi) {
    this.chip = host.hall.chips[0]
  }
  get hall() { return this.host.hall }
  get sfx() { return this.host.sfx }
  get cash() { return this.host.ctx.player.money }
  get betTotal() { return Object.values(this.bets).reduce((a, b) => a + b, 0) }

  mount() {
    const cv = this.api.canvas()
    this.g = cv.getContext('2d')!
    cv.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return
      const r = cv.getBoundingClientRect()
      this.clicks.push({ x: e.clientX - r.left, y: e.clientY - r.top })
    })
  }

  /** 一局进行中（已扣钱未结算）：Esc 拦截、关闭时 forceFinish */
  abstract get inRound(): boolean
  /** 关闭活动时立即结算进行中的一局 */
  abstract forceFinish(): void
  protected abstract tick(dt: number): void
  protected abstract draw(): void
  /** 键盘快捷键（可选） */
  protected keys(_input: Input) {}

  frame(dt: number, input: Input, ptr: ActivityPointer) {
    // 优先用自己排队的点击；没有监听到（例如合成事件）时退回宿主的 pointer.clicked
    const clicks = this.clicks.length ? this.clicks.splice(0) : ptr.clicked ? [{ x: ptr.x, y: ptr.y }] : []
    this.t += dt
    const W = this.api.width, H = this.api.height
    this.s = Math.min(W / VW, H / VH)
    this.ox = (W - VW * this.s) / 2; this.oy = (H - VH * this.s) / 2
    const cv = this.g.canvas, dpr = cv.width / Math.max(1, W)
    this.g.setTransform(dpr, 0, 0, dpr, 0, 0)
    this.g.fillStyle = '#05140d'; this.g.fillRect(0, 0, W, H)
    this.g.setTransform(dpr * this.s, 0, 0, dpr * this.s, dpr * this.ox, dpr * this.oy)
    this.tick(dt)
    this.regions = []
    const px = (ptr.x - this.ox) / this.s, py = (ptr.y - this.oy) / this.s
    // 悬停高亮用上一帧算出的 hoverId
    this.felt()
    this.draw()
    this.drawBanner(dt)
    this.drawFooter()
    this.hoverId = ''
    for (let i = this.regions.length - 1; i >= 0; i--) {
      const r = this.regions[i]
      if (px >= r.x && px <= r.x + r.w && py >= r.y && py <= r.y + r.h) { this.hoverId = r.id; break }
    }
    for (const c of clicks) {
      const cx = (c.x - this.ox) / this.s, cy = (c.y - this.oy) / this.s
      for (let i = this.regions.length - 1; i >= 0; i--) {
        const r = this.regions[i]
        if (cx >= r.x && cx <= r.x + r.w && cy >= r.y && cy <= r.y + r.h) { if (r.enabled) r.onClick(); break }
      }
    }
    this.keys(input)
    this.api.canvas().style.cursor = this.regions.some((r) => r.id === this.hoverId && r.enabled) ? 'pointer' : 'default'
  }

  /** 调试：区域换算成 canvas CSS 坐标 */
  regionList() {
    return this.regions.map((r) => ({ id: r.id, enabled: r.enabled, x: this.ox + r.x * this.s, y: this.oy + r.y * this.s, w: r.w * this.s, h: r.h * this.s }))
  }
  /** 调试：按 id 点击（与鼠标点击同一路径） */
  clickRegion(id: string) { const r = this.regions.find((x) => x.id === id); if (r?.enabled) { r.onClick(); return true } return false }

  protected region(id: string, x: number, y: number, w: number, h: number, enabled: boolean, onClick: () => void) {
    this.regions.push({ id, x, y, w, h, enabled, onClick })
  }
  protected hovered(id: string) { return this.hoverId === id }

  // ---------- 桌面 ----------
  protected felt() {
    const g = this.g
    const grd = g.createRadialGradient(VW / 2, VH * 0.42, 60, VW / 2, VH * 0.45, VW * 0.7)
    grd.addColorStop(0, '#13744a'); grd.addColorStop(1, '#073d26')
    g.fillStyle = grd; this.rr(0, 0, VW, VH, 24); g.fill()
    g.strokeStyle = '#5c3b1e'; g.lineWidth = 14; this.rr(7, 7, VW - 14, VH - 14, 22); g.stroke()
    g.strokeStyle = 'rgba(255,215,0,.35)'; g.lineWidth = 1.5; this.rr(16, 16, VW - 32, VH - 32, 18); g.stroke()
  }
  protected rr(x: number, y: number, w: number, h: number, r: number) {
    const g = this.g; g.beginPath(); g.roundRect(x, y, w, h, r)
  }
  protected text(s: string, x: number, y: number, size = 16, color = '#fff', align: CanvasTextAlign = 'center', weight = 600) {
    const g = this.g; g.font = `${weight} ${size}px system-ui, -apple-system, "PingFang SC", sans-serif`
    g.fillStyle = color; g.textAlign = align; g.textBaseline = 'middle'; g.fillText(s, x, y)
  }

  /** 画按钮并登记点击区域 */
  protected button(id: string, x: number, y: number, w: number, h: number, label: string, enabled: boolean, onClick: () => void, color = '#d4a017', key?: string) {
    const g = this.g, hov = enabled && this.hovered(id)
    g.fillStyle = enabled ? (hov ? lighten(color) : color) : 'rgba(80,80,80,.55)'
    this.rr(x, y, w, h, 10); g.fill()
    g.strokeStyle = enabled ? 'rgba(255,255,255,.55)' : 'rgba(255,255,255,.15)'; g.lineWidth = 1.5; g.stroke()
    this.text(label, x + w / 2, y + h / 2 + (key ? -5 : 0), 17, enabled ? '#111' : '#999', 'center', 800)
    if (key) this.text(key, x + w / 2, y + h - 9, 10, enabled ? 'rgba(0,0,0,.6)' : '#777', 'center', 500)
    this.region(id, x, y, w, h, enabled, () => { this.sfx.click(); onClick() })
  }

  // ---------- 筹码 ----------
  drawChip(x: number, y: number, v: number, r = 20, label = true) {
    const g = this.g, [, c, fg] = chipColor(v)
    g.save()
    g.fillStyle = 'rgba(0,0,0,.35)'; g.beginPath(); g.ellipse(x + 1.5, y + 2.5, r, r, 0, 0, Math.PI * 2); g.fill()
    g.fillStyle = c; g.beginPath(); g.arc(x, y, r, 0, Math.PI * 2); g.fill()
    g.strokeStyle = fg; g.lineWidth = r * 0.22; g.setLineDash([r * 0.42, r * 0.36])
    g.beginPath(); g.arc(x, y, r * 0.86, 0, Math.PI * 2); g.stroke()
    g.setLineDash([]); g.lineWidth = 1; g.strokeStyle = 'rgba(255,255,255,.5)'
    g.beginPath(); g.arc(x, y, r * 0.62, 0, Math.PI * 2); g.stroke()
    g.restore()
    if (label) this.text(short(v), x, y + 0.5, r * 0.62, fg, 'center', 800)
  }
  /** 把金额拆成筹码叠起来画（最多 8 枚） */
  drawStack(x: number, y: number, amount: number, r = 16) {
    if (amount <= 0) return
    const denoms = [50000, 25000, 10000, 5000, 2500, 1000, 500, 100, 50, 25, 10, 5, 1]
    const chips: number[] = []
    let rest = amount
    for (const d of denoms) while (rest >= d && chips.length < 8) { chips.push(d); rest -= d }
    if (!chips.length) chips.push(1)
    chips.reverse().forEach((v, i) => this.drawChip(x, y - i * 4, v, r, i === chips.length - 1))
    this.text(money(amount), x, y + r + 10, 12, '#fff', 'center', 700)
  }

  /** 底部：筹码架 + 现金 / 下注 / 限额 */
  protected chipRack(enabled: boolean, y = VH - 58) {
    const chips = this.hall.chips, gap = 58, x0 = 40
    this.text(t('筹码'), x0, y - 30, 12, 'rgba(255,255,255,.7)', 'left')
    chips.forEach((v, i) => {
      const x = x0 + 24 + i * gap, sel = v === this.chip
      if (sel) { this.g.fillStyle = 'rgba(255,215,0,.35)'; this.g.beginPath(); this.g.arc(x, y, 27, 0, Math.PI * 2); this.g.fill() }
      this.drawChip(x, y - (sel ? 3 : 0), v, 22)
      this.region(`chip:${v}`, x - 24, y - 24, 48, 48, enabled, () => { this.chip = v; this.sfx.chip() })
    })
  }
  protected drawFooter() {
    const y = VH - 22
    this.text(t('现金 {n}', { n: money(this.cash) }), VW - 40, 40, 18, '#7ee787', 'right', 800)
    this.text(t('{hall} · 限额 {min}–{max}', { hall: this.hall.name, min: money(this.hall.min), max: money(this.hall.max) }), VW - 40, 64, 13, 'rgba(255,255,255,.75)', 'right', 500)
    if (this.noticeText && this.t < this.noticeUntil) {
      // 提示：黄色粗体 + 深色底条，占用状态行（各桌布局都给状态行留了空）
      const g = this.g
      g.save(); g.font = `800 16px -apple-system, "PingFang SC", Arial, sans-serif`
      const w = g.measureText(this.noticeText).width + 28
      g.fillStyle = 'rgba(0,0,0,.6)'; this.rr(VW / 2 - w / 2, y - 14, w, 28, 14); g.fill()
      g.restore()
      this.text(this.noticeText, VW / 2, y, 16, '#ffd33d', 'center', 800)
    } else if (this.status) this.text(this.status, VW / 2, y, 14, 'rgba(255,255,255,.85)', 'center', 500)
  }

  /** 桌内提示（显示在底部状态行，sec 秒后恢复状态行） */
  notice(text: string, sec = 1.5) { this.noticeText = text; this.noticeUntil = this.t + sec }

  /** 往下注区加一枚当前筹码（限额、现金检查） */
  protected place(key: string, maxTotal = this.hall.max) {
    const amt = this.chip
    if (this.betTotal + amt > maxTotal) { this.notice(t('超过本厅上限 {n}', { n: money(maxTotal) }), 1.4); return }
    if (this.betTotal + amt > this.cash) { this.notice(t('现金不足'), 1.4); return }
    this.bets[key] = (this.bets[key] ?? 0) + amt
    this.sfx.chip()
  }
  protected clearBets() { this.bets = {} }
  protected rebet() {
    const tot = Object.values(this.lastBets).reduce((a, b) => a + b, 0)
    if (!tot) return
    if (tot > this.cash) { this.notice(t('现金不足，无法重复上局'), 1.4); return }
    if (tot > this.hall.max) return
    this.bets = { ...this.lastBets }; this.sfx.chip()
  }
  /** 确认下注：最低限额 + 扣钱；成功返回总额 */
  protected commitBets(): number {
    const tot = this.betTotal
    if (tot <= 0) { this.notice(t('请先点筹码再点下注区'), 1.6); return 0 }
    if (tot < this.hall.min) { this.notice(t('本厅最低 {n}', { n: money(this.hall.min) }), 1.6); return 0 }
    if (!this.host.stake(this.game, tot)) { this.notice(t('现金不足'), 1.4); return 0 }
    this.lastBets = { ...this.bets }
    return tot
  }

  /** 一局结束：结算 + 横幅 + 音效 */
  protected finishRound(stake: number, ret: number, label?: string) {
    this.host.settle(this.game, stake, ret, this.api)
    const net = ret - stake
    const text = label ?? (net > 0 ? t('赢 {n}', { n: money(net) }) : net < 0 ? t('输 {n}', { n: money(-net) }) : t('和局 · 退回本金'))
    this.banner = { text, color: net > 0 ? '#ffd33d' : net < 0 ? '#ff6b6b' : '#e5e5e5', t: 2.6 }
    if (net > 0) this.sfx.win(net >= stake * 5); else if (net < 0) this.sfx.lose(); else this.sfx.push()
  }
  protected drawBanner(dt: number) {
    const b = this.banner; if (!b) return
    b.t -= dt; if (b.t <= 0) { this.banner = null; return }
    const a = Math.min(1, b.t / 0.4), g = this.g
    g.save(); g.globalAlpha = a
    const { x, y } = this.bannerAt
    g.font = `900 30px system-ui, -apple-system, "PingFang SC", sans-serif`
    const w = Math.max(300, g.measureText(b.text).width + 60)
    g.fillStyle = 'rgba(0,0,0,.62)'; this.rr(x - w / 2, y - 32, w, 64, 16); g.fill()
    g.strokeStyle = b.color; g.lineWidth = 2; g.stroke()
    this.text(b.text, x, y, 30, b.color, 'center', 900)
    g.restore()
  }

  // ---------- 扑克牌 ----------
  drawCard(x: number, y: number, c: Card | null, w = 64, h = 90, flipK = 1) {
    const g = this.g
    g.save()
    g.translate(x + w / 2, y + h / 2); g.scale(Math.max(0.02, Math.abs(flipK)), 1); g.translate(-w / 2, -h / 2)
    g.fillStyle = 'rgba(0,0,0,.35)'; this.rr(3, 4, w, h, 7); g.fill()
    if (!c || flipK < 0) {
      g.fillStyle = '#8b1e2d'; this.rr(0, 0, w, h, 7); g.fill()
      g.save(); this.rr(6, 6, w - 12, h - 12, 4); g.clip()
      g.strokeStyle = 'rgba(255,215,0,.45)'; g.lineWidth = 1
      for (let i = -h; i < w + h; i += 8) { g.beginPath(); g.moveTo(i, 0); g.lineTo(i + h, h); g.moveTo(i + h, 0); g.lineTo(i, h); g.stroke() }
      g.restore()
      g.strokeStyle = '#fff'; g.lineWidth = 3; this.rr(4, 4, w - 8, h - 8, 5); g.stroke()
    } else {
      g.fillStyle = '#fdfdfb'; this.rr(0, 0, w, h, 7); g.fill()
      g.strokeStyle = '#bbb'; g.lineWidth = 1; g.stroke()
      const red = c.s === 1 || c.s === 2, col = red ? '#c1121f' : '#111'
      const sz = w / 64
      this.text(RANK_TXT[c.r], 13 * sz, 13 * sz, 17 * sz, col, 'center', 800)
      this.text(SUIT_TXT[c.s], 13 * sz, 30 * sz, 14 * sz, col, 'center', 600)
      this.text(SUIT_TXT[c.s], w / 2, h / 2 + 6 * sz, 34 * sz, col, 'center', 600)
      g.save(); g.translate(w, h); g.rotate(Math.PI)
      this.text(RANK_TXT[c.r], 13 * sz, 13 * sz, 17 * sz, col, 'center', 800)
      g.restore()
    }
    g.restore()
  }
}

function lighten(hex: string) {
  const n = parseInt(hex.slice(1), 16)
  const r = Math.min(255, (n >> 16) + 30), gg = Math.min(255, ((n >> 8) & 255) + 30), b = Math.min(255, (n & 255) + 30)
  return `rgb(${r},${gg},${b})`
}

/**
 * 发牌动画：牌第一次登记时排队（相邻 0.22 s），从牌鞋位置滑到目标位置并翻面。
 * at(card) 返回 0–1 进度（<0 = 还没轮到，不画）。
 */
export class DealQueue {
  private start = new Map<Card, number>()
  private last = -1
  constructor(private gap = 0.22, readonly dur = 0.32) {}
  reg(c: Card, now: number, flipLater = false) {
    if (this.start.has(c)) return
    const s = Math.max(now, this.last + this.gap)
    this.start.set(c, s); this.last = s
    void flipLater
  }
  at(c: Card, now: number) { const s = this.start.get(c); return s === undefined ? -1 : (now - s) / this.dur }
  busy(now: number) { return now < this.last + this.dur + 0.05 }
  /** 新的一张是否在本帧刚开始飞（用于音效） */
  justStarted(now: number, dt: number) { for (const s of this.start.values()) if (s <= now && s > now - dt) return true; return false }
  reset() { this.start.clear(); this.last = -1 }
}
