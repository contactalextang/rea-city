import type { Input } from '../core/Input'

/**
 * 触屏操作层（仅 input.touch 时创建）：左半屏浮动摇杆、右半屏拖动转视角、右下动作键、顶部小按钮。
 * 按钮复用键码写进 Input（setVirtual），Game / Player 原有的 justPressed / down 判断不用改。
 * 非游玩状态（面板 / 手机 / 活动 / 叫车 / 建角色）整层隐藏，并松开所有虚拟键。
 */
/** 以“添加到主屏幕”的网页 App 方式运行（已无浏览器地址栏，等同全屏） */
export function isStandalone(): boolean {
  return (navigator as Navigator & { standalone?: boolean }).standalone === true || matchMedia('(display-mode: standalone), (display-mode: fullscreen)').matches
}

export interface TouchHost {
  /** 必须在触摸事件回调里同步调用（浏览器要求用户手势） */
  fullscreen(): void
  /** 开火键按住：强制瞄准，子弹朝相机方向 */
  aim(on: boolean): void
}
export interface TouchState {
  show: boolean
  inVehicle: boolean
  canInteract: boolean
  hasGun: boolean
}

const CSS = `
#touch { position: fixed; inset: 0; z-index: 5; touch-action: none; user-select: none; -webkit-user-select: none; -webkit-touch-callout: none; }
#touch.off { display: none; }
#touch .stick { position: absolute; width: 120px; height: 120px; margin: -60px 0 0 -60px; border-radius: 50%; background: rgba(255,255,255,.10); border: 2px solid rgba(255,255,255,.35); pointer-events: none; }
#touch .stick.idle { opacity: .45; }
#touch .knob { position: absolute; left: 50%; top: 50%; width: 52px; height: 52px; margin: -26px 0 0 -26px; border-radius: 50%; background: rgba(255,255,255,.55); }
#touch .tb { position: absolute; display: flex; align-items: center; justify-content: center; border-radius: 50%; background: rgba(10,14,30,.55); border: 2px solid rgba(255,255,255,.4); color: #fff; font: 600 14px -apple-system, "PingFang SC", sans-serif; text-shadow: 0 1px 2px #000; touch-action: none; }
#touch .tb.on { background: rgba(255,211,61,.55); border-color: #ffd33d; }
#touch .tb.hl { border-color: #7ee787; box-shadow: 0 0 12px rgba(126,231,135,.8); }
#touch .tb.hide { display: none; }
#touch .act { width: 62px; height: 62px; }
#touch .top { top: calc(8px + env(safe-area-inset-top)); width: 44px; height: 44px; border-radius: 12px; font-size: 13px; }
/* 竖屏：顶部按钮改成小地图下方竖排，避开左上 HUD */
@media (max-aspect-ratio: 1/1) {
  #touch .top { left: auto !important; right: calc(12px + env(safe-area-inset-right)); }
  #touch .top[data-id="phone"] { top: calc(222px + env(safe-area-inset-top)); }
  #touch .top[data-id="quest"] { top: calc(272px + env(safe-area-inset-top)); }
  #touch .top[data-id="full"] { top: calc(322px + env(safe-area-inset-top)); }
}
`

const R = 55        // 摇杆有效半径（px）
const DEAD = 0.15   // 死区
const LOOK_K = 1.6  // 触屏拖动 → 鼠标位移系数

export class TouchControls {
  private root = document.createElement('div')
  private stick = document.createElement('div')
  private knob = document.createElement('div')
  private stickId: number | null = null
  private stickX0 = 0
  private stickY0 = 0
  private lookId: number | null = null
  private lookX = 0
  private lookY = 0
  private btns: Record<string, HTMLDivElement> = {}
  /** 按下中的按钮：pointerId → 键码 */
  private held = new Map<number, string>()
  private shown = false

  constructor(private input: Input, private host: TouchHost) {
    const style = document.createElement('style'); style.textContent = CSS; document.head.appendChild(style)
    this.root.id = 'touch'; this.root.className = 'off'
    this.stick.className = 'stick idle'; this.knob.className = 'knob'
    this.stick.appendChild(this.knob); this.root.appendChild(this.stick)
    this.placeIdleStick()

    // 右下动作键（right / bottom 均为 px，加安全区）
    const act: [string, string, string, number, number][] = [
      ['fire', '开火', 'ControlLeft', 18, 168],
      ['f', '上车', 'KeyF', 92, 96],
      ['jump', '跳', 'Space', 18, 22],
      ['e', '交互', 'KeyE', 92, 22],
      ['horn', '喇叭', 'KeyH', 166, 22],
      ['run', '跑', 'ShiftLeft', 18, 96],
    ]
    for (const [id, label, code, right, bottom] of act) {
      const b = this.button(id, label, code, 'act')
      b.style.right = `calc(${right}px + env(safe-area-inset-right))`; b.style.bottom = `calc(${bottom}px + env(safe-area-inset-bottom))`
    }
    // 顶部小按钮（居中一排）
    const top: [string, string, string | null, number][] = [['phone', '手机', 'Tab', -76], ['quest', '任务', 'KeyM', -24], ['full', '全屏', null, 28]]
    for (const [id, label, code, dx] of top) {
      if (id === 'full' && isStandalone()) continue
      const b = this.button(id, label, code, 'top')
      b.style.left = `calc(50% + ${dx}px)`
    }

    this.root.addEventListener('pointerdown', (e) => this.down(e))
    this.root.addEventListener('pointermove', (e) => this.move(e))
    this.root.addEventListener('pointerup', (e) => this.up(e))
    this.root.addEventListener('pointercancel', (e) => this.up(e))
    this.root.addEventListener('contextmenu', (e) => e.preventDefault())
    window.addEventListener('resize', () => { if (this.stickId === null) this.placeIdleStick() })
    document.body.appendChild(this.root)
  }

  private button(id: string, label: string, code: string | null, cls: string) {
    const b = document.createElement('div')
    b.className = `tb ${cls}`; b.textContent = label; b.dataset.code = code ?? ''; b.dataset.id = id
    this.btns[id] = b; this.root.appendChild(b)
    return b
  }

  private placeIdleStick() {
    this.stick.style.left = `${Math.max(90, window.innerWidth * 0.14)}px`
    this.stick.style.top = `${window.innerHeight - 100}px`
    this.knob.style.transform = ''
  }

  private down(e: PointerEvent) {
    e.preventDefault()   // 阻止合成 mousedown（否则会去请求指针锁定 / 记点击）
    try { this.root.setPointerCapture(e.pointerId) } catch { /* 合成事件无活动指针 */ }
    const b = (e.target as HTMLElement).closest<HTMLDivElement>('.tb')
    if (b) {
      if (b.dataset.id === 'full') { this.host.fullscreen(); return }
      const code = b.dataset.code!
      this.held.set(e.pointerId, code)
      this.input.setVirtual(code, true)
      if (code === 'ControlLeft') this.host.aim(true)
      b.classList.add('on')
      return
    }
    if (e.clientX < window.innerWidth * 0.45 && this.stickId === null) {
      // 浮动摇杆：以按下点为中心
      this.stickId = e.pointerId; this.stickX0 = e.clientX; this.stickY0 = e.clientY
      this.stick.style.left = `${e.clientX}px`; this.stick.style.top = `${e.clientY}px`
      this.stick.classList.remove('idle')
      return
    }
    if (this.lookId === null) {
      this.lookId = e.pointerId; this.lookX = e.clientX; this.lookY = e.clientY
      this.input.lookActive = true
    }
  }

  private move(e: PointerEvent) {
    if (e.pointerId === this.stickId) {
      let dx = (e.clientX - this.stickX0) / R, dy = (e.clientY - this.stickY0) / R
      const len = Math.hypot(dx, dy)
      if (len > 1) { dx /= len; dy /= len }
      this.knob.style.transform = `translate(${dx * R}px, ${dy * R}px)`
      // 去死区后重映射到 0..1，方向不变（dx, dy 此时长度为 min(1, len)）
      const m = Math.min(1, len)
      const k = m < DEAD ? 0 : (m - DEAD) / (1 - DEAD) / m
      this.input.stickX = dx * k
      this.input.stickY = -dy * k
      // 推到底自动奔跑（另有“跑”键按住时不覆盖）
      if (![...this.held.values()].includes('ShiftLeft')) this.input.setVirtual('ShiftLeft', len > 0.92)
    } else if (e.pointerId === this.lookId) {
      this.input.addLook((e.clientX - this.lookX) * LOOK_K, (e.clientY - this.lookY) * LOOK_K)
      this.lookX = e.clientX; this.lookY = e.clientY
    }
  }

  private up(e: PointerEvent) {
    const code = this.held.get(e.pointerId)
    if (code !== undefined) {
      this.held.delete(e.pointerId)
      if (![...this.held.values()].includes(code)) {
        this.input.setVirtual(code, false)
        if (code === 'ControlLeft') this.host.aim(false)
        for (const b of Object.values(this.btns)) if (b.dataset.code === code) b.classList.remove('on')
      }
    }
    if (e.pointerId === this.stickId) this.releaseStick()
    if (e.pointerId === this.lookId) { this.lookId = null; this.input.lookActive = false }
  }

  private releaseStick() {
    this.stickId = null
    this.input.stickX = 0; this.input.stickY = 0
    if (![...this.held.values()].includes('ShiftLeft')) this.input.setVirtual('ShiftLeft', false)
    this.stick.classList.add('idle')
    this.placeIdleStick()
  }

  /** 松开所有虚拟键与摇杆（隐藏时调用，防卡键） */
  private releaseAll() {
    for (const code of new Set(this.held.values())) { this.input.setVirtual(code, false); if (code === 'ControlLeft') this.host.aim(false) }
    this.held.clear()
    for (const b of Object.values(this.btns)) b.classList.remove('on')
    this.releaseStick()
    this.lookId = null; this.input.lookActive = false
  }

  /** 每帧由 Game 调用 */
  update(s: TouchState) {
    if (s.show !== this.shown) {
      this.shown = s.show
      this.root.classList.toggle('off', !s.show)
      if (!s.show) this.releaseAll()
    }
    if (!s.show) return
    const b = this.btns
    b.fire.classList.toggle('hide', !s.hasGun || s.inVehicle)
    b.horn.classList.toggle('hide', !s.inVehicle)
    b.run.classList.toggle('hide', s.inVehicle)
    b.f.textContent = s.inVehicle ? '下车' : '上车'
    b.jump.textContent = s.inVehicle ? '手刹' : '跳'
    b.e.classList.toggle('hl', s.canInteract)
  }
}
