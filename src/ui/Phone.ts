import type { JobsView } from '../systems/Jobs'
import type { AssetId } from '../data/jobs'
import { INVEST_AMOUNTS } from '../data/jobs'
import type { AppView } from '../core/Context'
import type { FxQuality } from '../core/Settings'

/** 手机抽屉（Tab）：状态、工作、地图、设置、存读档；游戏不暂停但屏蔽移动输入 */
export interface PhoneHost {
  setTimeSpeed(v: number): void
  setShadows(on: boolean): void
  setMusic(on: boolean): void
  setFx(q: FxQuality): void
  save(): void
  load(): void
  restart(): void
  drawMap(canvas: HTMLCanvasElement): void
  toast(s: string): void
  startJob(id: string): void
  stopJob(): void
  buy(asset: AssetId, amount: number): void
  sell(asset: AssetId): void
  /** 打开衣柜（换装）；false = 不可用 */
  wardrobe(): boolean
}
export interface PhoneStatus {
  timeText: string
  money: number
  roleTitle: string
  lawText: string
  hunger: number
  energy: number
  timeSpeed: number
  shadows: boolean
  music: boolean
  fx: FxQuality
  work: JobsView
  quest: { title: string; step: string } | null
}

const $ = (id: string) => document.getElementById(id)!
const fmt = (n: number) => n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })
/** 子页名：内置 work / map / settings，其余由 registerSub 注册（progress / shop / biz…） */
type Sub = string | null
/** 子页渲染回调：root 为子页内容容器；force = 刚打开（否则为定时刷新，可按签名跳过） */
export type SubRender = (root: HTMLElement, force: boolean) => void

const el = (tag: string, cls: string, text?: string) => { const d = document.createElement(tag); d.className = cls; if (text !== undefined) d.textContent = text; return d }

/** 把通用 AppView 渲染进 root（成长 / 商店 / 生意页共用；卡片样式沿用工作页 .job） */
export function renderAppView(root: HTMLElement, v: AppView) {
  root.innerHTML = ''
  for (const l of v.lines ?? []) root.appendChild(el('div', 'stat', l))
  for (const b of v.bars ?? []) {
    const bar = el('div', 'bar xp')
    const head = el('span', '', `${b.label} `); head.appendChild(el('b', '', b.text ?? `${Math.round(b.pct * 100)}%`)); bar.appendChild(head)
    const track = el('div', 'track'), fill = el('div', 'fill')
    fill.style.width = `${Math.max(0, Math.min(1, b.pct)) * 100}%`
    track.appendChild(fill); bar.appendChild(track); root.appendChild(bar)
  }
  if (v.empty) root.appendChild(el('div', 'empty', v.empty))
  for (const sec of v.sections ?? []) {
    root.appendChild(el('div', 'sect', sec.title))
    for (const it of sec.items) {
      const card = el('div', `job${it.tone === 'owned' ? ' active' : it.tone === 'locked' ? ' off' : ''}`)
      const head = el('div', 'jt'); head.appendChild(el('span', '', it.title))
      if (it.value) head.appendChild(el('span', 'jv', it.value))
      card.appendChild(head)
      if (it.desc) card.appendChild(el('div', 'jd', it.desc))
      if (it.status) card.appendChild(el('div', 'js', it.status))
      if (it.actions?.length) {
        const row = el('div', 'ja')
        for (const a of it.actions) {
          const btn = el('button', '', a.label) as HTMLButtonElement
          btn.disabled = !!a.disabled
          btn.addEventListener('click', () => a.onClick())
          row.appendChild(btn)
        }
        card.appendChild(row)
      }
      root.appendChild(card)
    }
  }
  if (v.log?.length) {
    root.appendChild(el('div', 'sect', '日志'))
    const box = el('div', 'log')
    for (const l of v.log) box.appendChild(el('div', '', l))
    root.appendChild(box)
  }
}

export class Phone {
  open = false
  private root = $('phone')
  private sub: Sub = null
  private mapCanvas = $('phone-map') as HTMLCanvasElement
  private status: PhoneStatus | null = null
  private workSig = ''
  /** 注册的子页：名字 → { 内容容器, 渲染回调 } */
  private subs = new Map<string, { box: HTMLElement; body: HTMLElement; render: SubRender }>()

  constructor(private host: PhoneHost) {
    this.root.addEventListener('mousedown', (e) => e.stopPropagation())
    // Tab 不让浏览器移动焦点
    window.addEventListener('keydown', (e) => { if (e.code === 'Tab') e.preventDefault() })
    for (const b of this.root.querySelectorAll<HTMLButtonElement>('.apps button')) {
      b.addEventListener('click', () => this.app(b.dataset.app!))
    }
    for (const b of this.root.querySelectorAll<HTMLButtonElement>('[data-speed]')) {
      b.addEventListener('click', () => { host.setTimeSpeed(Number(b.dataset.speed)); this.refreshSettings() })
    }
    for (const b of this.root.querySelectorAll<HTMLButtonElement>('[data-shadows]')) {
      b.addEventListener('click', () => { host.setShadows(b.dataset.shadows === '1'); this.refreshSettings() })
    }
    for (const b of this.root.querySelectorAll<HTMLButtonElement>('[data-music]')) {
      b.addEventListener('click', () => { host.setMusic(b.dataset.music === '1'); if (this.status) this.status.music = b.dataset.music === '1'; this.refreshSettings() })
    }
    for (const b of this.root.querySelectorAll<HTMLButtonElement>('[data-fx]')) {
      b.addEventListener('click', () => { const q = b.dataset.fx as FxQuality; host.setFx(q); if (this.status) this.status.fx = q; this.refreshSettings() })
    }
    // 内置子页也走注册表
    this.registerSub('work', '', (_r, force) => this.refreshWork(force), $('phone-sub-work'))
    this.registerSub('map', '', () => this.host.drawMap(this.mapCanvas), $('phone-sub-map'))
    this.registerSub('settings', '', () => this.refreshSettings(), $('phone-sub-settings'))
  }

  /**
   * 注册子页：点 `data-app=name` 的应用按钮开关它；render 在打开时（force）和每次 update 时调用。
   * box 缺省时自动在「Tab 关闭手机」提示前建一个 `.sub` 容器（标题 title）。
   */
  registerSub(name: string, title: string, render: SubRender, box?: HTMLElement) {
    let body: HTMLElement
    if (!box) {
      box = el('div', 'sub work'); box.id = `phone-sub-${name}`
      box.appendChild(el('h3', '', title))
      body = el('div', 'app'); body.id = `phone-${name}`; box.appendChild(body)
      this.root.insertBefore(box, this.root.querySelector('.tip'))
    } else body = box
    this.subs.set(name, { box, body, render })
  }
  /** 注册一个按 AppView 渲染的子页；内容签名不变就不重建 DOM（避免点击时按钮被替换） */
  registerView(name: string, title: string, view: () => AppView) {
    let sig = ''
    this.registerSub(name, title, (root, force) => {
      const v = view()
      const s = JSON.stringify(v)
      if (!force && s === sig) return
      sig = s
      renderAppView(root, v)
    })
  }

  toggle() { this.set(!this.open) }
  set(open: boolean) {
    this.open = open
    this.root.classList.toggle('show', open)
    if (open && document.pointerLockElement) document.exitPointerLock()
    if (open && this.sub) this.renderSub(this.sub, true)
  }
  get subPage() { return this.sub }

  private app(name: string) {
    switch (name) {
      case 'work': this.showSub(this.sub === 'work' ? null : 'work'); break
      case 'char': if (!this.host.wardrobe()) this.host.toast('方块角色模式（?chars=box）不支持换装'); break
      case 'map': this.showSub(this.sub === 'map' ? null : 'map'); break
      case 'settings': this.showSub(this.sub === 'settings' ? null : 'settings'); break
      case 'save': this.host.save(); break
      case 'load': this.host.load(); break
      case 'restart': if (confirm('清除存档并重新开始？')) this.host.restart(); break
      default: if (this.subs.has(name)) this.showSub(this.sub === name ? null : name)
    }
  }

  showSub(s: Sub) {
    if (s && !this.subs.has(s)) s = null
    this.sub = s
    for (const [n, e] of this.subs) e.box.classList.toggle('show', n === s)
    for (const b of this.root.querySelectorAll<HTMLButtonElement>('.apps button')) b.classList.toggle('on', b.dataset.app === s)
    if (s) this.renderSub(s, true)
  }
  private renderSub(name: string, force: boolean) { const e = this.subs.get(name); if (e) e.render(e.body, force) }

  private refreshSettings() {
    const st = this.status; if (!st) return
    for (const b of this.root.querySelectorAll<HTMLButtonElement>('[data-speed]')) b.classList.toggle('on', Number(b.dataset.speed) === st.timeSpeed)
    for (const b of this.root.querySelectorAll<HTMLButtonElement>('[data-shadows]')) b.classList.toggle('on', (b.dataset.shadows === '1') === st.shadows)
    for (const b of this.root.querySelectorAll<HTMLButtonElement>('[data-music]')) b.classList.toggle('on', (b.dataset.music === '1') === st.music)
    for (const b of this.root.querySelectorAll<HTMLButtonElement>('[data-fx]')) b.classList.toggle('on', b.dataset.fx === st.fx)
  }

  /** 工作页：内容签名不变就不重建 DOM，避免点击时按钮被替换 */
  private refreshWork(force = false) {
    const st = this.status; if (!st) return
    const w = st.work
    const sig = JSON.stringify([w, st.quest, Math.floor(st.money)])
    if (!force && sig === this.workSig) return
    this.workSig = sig
    const root = $('phone-work'); root.innerHTML = ''
    const stat = el('div', 'stat')
    stat.textContent = `今日收入 $${fmt(w.todayIncome)}` + (w.taxiTrips ? ` · 的士 ${w.taxiTrips} 单 · 评分 ${w.taxiRating!.toFixed(1)}` : '')
    root.appendChild(stat)
    if (st.quest) root.appendChild(el('div', 'quest', `任务「${st.quest.title}」：${st.quest.step}`))
    for (const j of w.jobs) {
      const card = el('div', `job${j.active ? ' active' : ''}${j.reason ? ' off' : ''}`)
      const head = el('div', 'jt'); head.appendChild(el('span', '', j.title))
      if (!j.passive) {
        const btn = el('button', j.active ? 'stop' : '', j.active ? '下班' : '开始') as HTMLButtonElement
        if (j.reason && !j.active) btn.disabled = true
        btn.addEventListener('click', () => { if (j.active) this.host.stopJob(); else this.host.startJob(j.id) })
        head.appendChild(btn)
      }
      card.appendChild(head)
      card.appendChild(el('div', 'jd', j.desc))
      const line = j.active ? '进行中' : j.reason ?? j.status
      if (line) card.appendChild(el('div', 'js', line))
      root.appendChild(card)
    }
    if (w.invest) {
      const box = el('div', 'invest')
      box.appendChild(el('div', 'stat', `投资持仓 $${fmt(w.invest.total)} · 现金 $${fmt(st.money)} · 每天 07:00 结算`))
      for (const a of w.invest.assets) {
        const row = el('div', 'asset')
        const an = el('div', 'an')
        const name = el('span', '', `${a.name} · ${a.desc}`)
        const val = el('b', '', `$${fmt(a.value)}`)
        if (a.change) { const c = el('span', `chg${a.change < 0 ? ' neg' : ''}`, `${a.change > 0 ? '+' : ''}${fmt(a.change)}`); val.appendChild(c) }
        an.appendChild(name); an.appendChild(val); row.appendChild(an)
        for (const amt of INVEST_AMOUNTS) {
          const b = el('button', '', `买 $${amt}`) as HTMLButtonElement
          b.dataset.buy = `${a.id}:${amt}`
          b.disabled = st.money < amt
          b.addEventListener('click', () => this.host.buy(a.id, amt))
          row.appendChild(b)
        }
        const sell = el('button', '', '全部卖出') as HTMLButtonElement
        sell.dataset.sell = a.id
        sell.disabled = a.value <= 0
        sell.addEventListener('click', () => this.host.sell(a.id))
        row.appendChild(sell)
        box.appendChild(row)
      }
      root.appendChild(box)
    }
  }

  /** 每秒几次刷新文字；地图子页打开时重画 */
  update(st: PhoneStatus) {
    this.status = st
    if (!this.open) return
    $('phone-time').textContent = st.timeText
    $('phone-money').textContent = `$${fmt(st.money)}`
    $('phone-role').textContent = `身份：${st.roleTitle}`
    $('phone-law').textContent = st.lawText || '无违规记录'
    const bar = (id: string, v: number) => {
      const el = $(id)
      el.querySelector('b')!.textContent = `${Math.round(v)}`
      ;(el.querySelector('.fill') as HTMLElement).style.width = `${Math.max(0, Math.min(100, v))}%`
      el.classList.toggle('low', v < 20)
    }
    bar('phone-hunger', st.hunger); bar('phone-energy', st.energy)
    if (this.sub) this.renderSub(this.sub, false)
  }
}
