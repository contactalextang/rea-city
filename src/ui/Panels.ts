/** 交互面板（DOM）：标题 + 文字行 + 按钮列表；样式见 index.html `.panel` */
export interface PanelButton {
  label: string
  /** 右侧附注（价格/说明） */
  note?: string
  disabled?: boolean
  onClick: () => void
}
export interface PanelSpec {
  title: string
  subtitle?: string
  lines?: string[]
  buttons: PanelButton[]
}

export class Panels {
  private root = document.getElementById('panel')!
  private titleEl = document.getElementById('panel-title')!
  private subEl = document.getElementById('panel-sub')!
  private linesEl = document.getElementById('panel-lines')!
  private btnsEl = document.getElementById('panel-buttons')!
  private spec: PanelSpec | null = null
  /** 由 Game 注入：关闭按钮 / Esc */
  onClose: () => void = () => {}

  constructor() {
    // 面板内的点击不触发指针锁定
    this.root.addEventListener('mousedown', (e) => e.stopPropagation())
    document.getElementById('panel-close')!.addEventListener('click', () => this.onClose())
  }

  get open() { return this.spec !== null }
  /** 测试钩子：当前按钮文字 */
  get labels() { return this.spec?.buttons.map((b) => b.label) ?? [] }

  show(spec: PanelSpec) {
    this.spec = spec
    this.titleEl.textContent = spec.title
    this.subEl.textContent = spec.subtitle ?? ''
    this.subEl.style.display = spec.subtitle ? '' : 'none'
    this.linesEl.innerHTML = ''
    for (const l of spec.lines ?? []) { const d = document.createElement('div'); d.textContent = l; this.linesEl.appendChild(d) }
    this.btnsEl.innerHTML = ''
    spec.buttons.forEach((b, i) => {
      const el = document.createElement('button')
      el.className = 'pbtn'
      el.dataset.index = String(i)
      el.disabled = !!b.disabled
      const lab = document.createElement('span'); lab.textContent = b.label
      el.appendChild(lab)
      if (b.note) { const n = document.createElement('span'); n.className = 'note'; n.textContent = b.note; el.appendChild(n) }
      el.addEventListener('click', () => { if (!b.disabled) b.onClick() })
      this.btnsEl.appendChild(el)
    })
    this.root.classList.add('show')
  }

  hide() { this.spec = null; this.root.classList.remove('show') }

  /** 测试钩子：点击第 n 个按钮 */
  choose(index: number) {
    const b = this.spec?.buttons[index]
    if (!b || b.disabled) return false
    b.onClick(); return true
  }
}
