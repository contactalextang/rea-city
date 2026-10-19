/** 手机抽屉（Tab）：状态、地图、设置、存读档；游戏不暂停但屏蔽移动输入 */
export interface PhoneHost {
  setTimeSpeed(v: number): void
  setShadows(on: boolean): void
  save(): void
  load(): void
  restart(): void
  drawMap(canvas: HTMLCanvasElement): void
  toast(s: string): void
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
}

const $ = (id: string) => document.getElementById(id)!

export class Phone {
  open = false
  private root = $('phone')
  private sub: 'map' | 'settings' | null = null
  private mapCanvas = $('phone-map') as HTMLCanvasElement
  private status: PhoneStatus | null = null

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
  }

  private app(name: string) {
    switch (name) {
      case 'work': this.host.toast('工作 App 即将推出'); break
      case 'char': this.host.toast('角色定制即将推出'); break
      case 'map': this.showSub(this.sub === 'map' ? null : 'map'); break
      case 'settings': this.showSub(this.sub === 'settings' ? null : 'settings'); break
      case 'save': this.host.save(); break
      case 'load': this.host.load(); break
      case 'restart': if (confirm('清除存档并重新开始？')) this.host.restart(); break
    }
  }

  private showSub(s: 'map' | 'settings' | null) {
    this.sub = s
    $('phone-sub-map').classList.toggle('show', s === 'map')
    $('phone-sub-settings').classList.toggle('show', s === 'settings')
    if (s === 'map') this.host.drawMap(this.mapCanvas)
    if (s === 'settings') this.refreshSettings()
  }

  private refreshSettings() {
    const st = this.status; if (!st) return
    for (const b of this.root.querySelectorAll<HTMLButtonElement>('[data-speed]')) b.classList.toggle('on', Number(b.dataset.speed) === st.timeSpeed)
    for (const b of this.root.querySelectorAll<HTMLButtonElement>('[data-shadows]')) b.classList.toggle('on', (b.dataset.shadows === '1') === st.shadows)
  }

  /** 每秒几次刷新文字；地图子页打开时重画 */
  update(st: PhoneStatus) {
    this.status = st
    if (!this.open) return
    $('phone-time').textContent = st.timeText
    $('phone-money').textContent = `$${st.money.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
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
  }
}
