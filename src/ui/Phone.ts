import type { JobsView } from '../systems/Jobs'
import type { AssetId } from '../data/jobs'
import { INVEST_AMOUNTS } from '../data/jobs'

/** 手机抽屉（Tab）：状态、工作、地图、设置、存读档；游戏不暂停但屏蔽移动输入 */
export interface PhoneHost {
  setTimeSpeed(v: number): void
  setShadows(on: boolean): void
  save(): void
  load(): void
  restart(): void
  drawMap(canvas: HTMLCanvasElement): void
  toast(s: string): void
  startJob(id: string): void
  stopJob(): void
  buy(asset: AssetId, amount: number): void
  sell(asset: AssetId): void
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
  work: JobsView
  quest: { title: string; step: string } | null
}

const $ = (id: string) => document.getElementById(id)!
const fmt = (n: number) => n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })
type Sub = 'work' | 'map' | 'settings' | null

export class Phone {
  open = false
  private root = $('phone')
  private sub: Sub = null
  private mapCanvas = $('phone-map') as HTMLCanvasElement
  private status: PhoneStatus | null = null
  private workSig = ''

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
  }

  toggle() { this.set(!this.open) }
  set(open: boolean) {
    this.open = open
    this.root.classList.toggle('show', open)
    if (open && document.pointerLockElement) document.exitPointerLock()
    if (open && this.sub === 'map') this.host.drawMap(this.mapCanvas)
    if (open && this.sub === 'work') this.refreshWork(true)
  }
  get subPage() { return this.sub }

  private app(name: string) {
    switch (name) {
      case 'work': this.showSub(this.sub === 'work' ? null : 'work'); break
      case 'char': this.host.toast('角色定制即将推出'); break
      case 'map': this.showSub(this.sub === 'map' ? null : 'map'); break
      case 'settings': this.showSub(this.sub === 'settings' ? null : 'settings'); break
      case 'save': this.host.save(); break
      case 'load': this.host.load(); break
      case 'restart': if (confirm('清除存档并重新开始？')) this.host.restart(); break
    }
  }

  showSub(s: Sub) {
    this.sub = s
    $('phone-sub-work').classList.toggle('show', s === 'work')
    $('phone-sub-map').classList.toggle('show', s === 'map')
    $('phone-sub-settings').classList.toggle('show', s === 'settings')
    if (s === 'map') this.host.drawMap(this.mapCanvas)
    if (s === 'settings') this.refreshSettings()
    if (s === 'work') this.refreshWork(true)
  }

  private refreshSettings() {
    const st = this.status; if (!st) return
    for (const b of this.root.querySelectorAll<HTMLButtonElement>('[data-speed]')) b.classList.toggle('on', Number(b.dataset.speed) === st.timeSpeed)
    for (const b of this.root.querySelectorAll<HTMLButtonElement>('[data-shadows]')) b.classList.toggle('on', (b.dataset.shadows === '1') === st.shadows)
  }

  /** 工作页：内容签名不变就不重建 DOM，避免点击时按钮被替换 */
  private refreshWork(force = false) {
    const st = this.status; if (!st) return
    const w = st.work
    const sig = JSON.stringify([w, st.quest, Math.floor(st.money)])
    if (!force && sig === this.workSig) return
    this.workSig = sig
    const root = $('phone-work'); root.innerHTML = ''
    const el = (tag: string, cls: string, text?: string) => { const d = document.createElement(tag); d.className = cls; if (text !== undefined) d.textContent = text; return d }
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
    if (this.sub === 'map') this.host.drawMap(this.mapCanvas)
    if (this.sub === 'settings') this.refreshSettings()
    if (this.sub === 'work') this.refreshWork()
  }
}
