import type { Ctx } from '../core/Context'
import type { Input } from '../core/Input'

/**
 * 活动宿主（P10）：全屏 DOM 容器 + 可选 Canvas，承载赌桌 / 舞蹈 / 约会等小游戏。
 * Game.openActivity(spec) 打开 → state = 'activity'：世界暂停（不跑物理/AI，时钟默认不走），HUD 隐藏，
 * 每个渲染帧调用一次 spec.update(dt, input, pointer)（input.justPressed 在这一帧有效）；Esc 默认关闭
 * （spec.onEscape 返回 true 可拦截）；关闭后恢复 'play'（returnToPanel 时重开来源 POI 面板）。
 *
 * 用法：
 *   game.openActivity({
 *     title: '21 点', subtitle: '滨海湾金沙', returnToPanel: true,
 *     mount(root, api) { const cv = api.canvas(); … root.appendChild(按钮) … },
 *     update(dt, input, ptr) { if (input.justPressed('Space')) …; if (ptr.clicked) … },
 *     onClose() { … },
 *   })
 */
export interface ActivityPointer {
  /** 相对 canvas（没建 canvas 时相对内容区）的 CSS 像素坐标 */
  x: number
  y: number
  /** 左键按住 */
  down: boolean
  /** 本帧刚按下左键（update 之后清除） */
  clicked: boolean
  /** 本帧滚轮累计 deltaY */
  wheel: number
}

export interface ActivityApi {
  /** 关闭活动（可在 mount/update/按钮回调里调用） */
  close(): void
  /** 活动内的提示条（世界 HUD 在活动期间隐藏） */
  toast(text: string, sec?: number): void
  /** 共享上下文：ctx.player.money、ctx.clock、ctx.needs、ctx.events… */
  readonly ctx: Ctx
  /** 内容容器（标题栏下方，flex 1） */
  readonly root: HTMLElement
  /**
   * 取得（首次调用时创建）铺满内容区的 Canvas；自动按 devicePixelRatio 设置后备尺寸，
   * 2D 上下文已 scale(dpr)，按 CSS 像素绘制即可。width/height = 当前 CSS 尺寸。
   */
  canvas(): HTMLCanvasElement
  readonly width: number
  readonly height: number
  /** 改标题 / 副标题 */
  setTitle(title: string, subtitle?: string): void
  /** 活动内跳过游戏时间（例：一局约 10 分钟 → skipTime(1/6)）；需求按跳过的小时衰减 */
  skipTime(hours: number): void
  readonly pointer: ActivityPointer
}

export interface ActivitySpec {
  /** 调试/测试用标识 */
  id?: string
  title: string
  subtitle?: string
  mount(root: HTMLElement, api: ActivityApi): void
  /** 每渲染帧一次（世界暂停期间）；dt 为真实秒 */
  update?(dt: number, input: Input, pointer: ActivityPointer): void
  onClose?(): void
  /** Esc：返回 true = 活动自己处理（不关闭） */
  onEscape?(): boolean
  /** 是否显示右上角 ×（默认 true） */
  closable?: boolean
  /** 时钟在活动期间继续走（默认 false = 暂停，活动用 api.skipTime 自己推进） */
  clockRuns?: boolean
  /** 不透明背景（true = 不再渲染背后的 3D 世界，省 GPU；默认 false 半透明盖在冻结的世界上） */
  opaque?: boolean
  /** 关闭后重开打开它的 POI 面板（从场馆面板按钮进入时常用） */
  returnToPanel?: boolean
}

const STYLE = `
.activity { position: fixed; inset: 0; z-index: 30; display: none; flex-direction: column; background: rgba(5,8,20,.86); color: #fff; font-family: inherit; user-select: none; }
.activity.show { display: flex; }
.activity.opaque { background: #070a16; }
.activity .act-head { display: flex; align-items: baseline; gap: 12px; padding: 14px 64px 10px 20px; border-bottom: 1px solid rgba(255,255,255,.12); background: rgba(8,12,26,.94); }
.activity .act-head h2 { margin: 0; font-size: 20px; letter-spacing: 1px; }
.activity .act-head .act-sub { font-size: 12px; opacity: .7; }
.activity .act-head .act-money { margin-left: auto; font-size: 18px; font-weight: 700; color: #7ee787; }
.activity .xbtn { position: absolute; right: 14px; top: 12px; }
.activity .act-body { position: relative; flex: 1; min-height: 0; overflow: auto; }
.activity .act-body > canvas.act-canvas { position: absolute; inset: 0; width: 100%; height: 100%; display: block; }
.activity .act-toast { position: absolute; left: 50%; top: 18%; transform: translateX(-50%); font-size: 24px; font-weight: 800; color: #ffd33d; text-shadow: 0 1px 3px #000; opacity: 0; transition: opacity .25s; pointer-events: none; text-align: center; white-space: pre-line; }
.activity .act-toast.show { opacity: 1; }
.activity .pbtn { width: auto; }
@media (max-width: 600px) { .activity .act-head { padding: 12px 56px 8px 16px; } }
`

/** 全屏活动容器（DOM 由构造时注入 body；同一时间只开一个活动） */
export class Activity {
  private el: HTMLDivElement
  private titleEl: HTMLElement
  private subEl: HTMLElement
  private moneyEl: HTMLElement
  private body: HTMLDivElement
  private toastEl: HTMLDivElement
  private xbtn: HTMLButtonElement
  private toastT = 0
  private cv: HTMLCanvasElement | null = null
  private spec: ActivitySpec | null = null
  private moneyText = ''
  readonly pointer: ActivityPointer = { x: 0, y: 0, down: false, clicked: false, wheel: 0 }
  /** Game 注入：关闭后回调（恢复 state） */
  onClosed: (spec: ActivitySpec) => void = () => {}

  constructor(private getCtx: () => Ctx) {
    if (!document.getElementById('activity-style')) {
      const st = document.createElement('style'); st.id = 'activity-style'; st.textContent = STYLE; document.head.appendChild(st)
    }
    this.el = document.createElement('div'); this.el.className = 'activity'; this.el.id = 'activity'
    const head = document.createElement('div'); head.className = 'act-head'
    this.titleEl = document.createElement('h2')
    this.subEl = document.createElement('span'); this.subEl.className = 'act-sub'
    this.moneyEl = document.createElement('span'); this.moneyEl.className = 'act-money'
    head.append(this.titleEl, this.subEl, this.moneyEl)
    this.xbtn = document.createElement('button'); this.xbtn.className = 'xbtn'; this.xbtn.textContent = '×'; this.xbtn.title = '关闭 (Esc)'
    this.xbtn.addEventListener('click', () => this.close())
    this.body = document.createElement('div'); this.body.className = 'act-body'
    this.toastEl = document.createElement('div'); this.toastEl.className = 'act-toast'
    this.el.append(head, this.xbtn, this.body, this.toastEl)
    // 活动内点击不触发指针锁定（Input 绑在 body 上）
    this.el.addEventListener('mousedown', (e) => e.stopPropagation())
    this.body.addEventListener('pointerdown', (e) => { this.trackPointer(e); if (e.button === 0) { this.pointer.down = true; this.pointer.clicked = true } })
    window.addEventListener('pointerup', (e) => { if (e.button === 0) this.pointer.down = false })
    this.body.addEventListener('pointermove', (e) => this.trackPointer(e))
    this.body.addEventListener('wheel', (e) => { this.pointer.wheel += e.deltaY }, { passive: true })
    window.addEventListener('resize', () => this.fitCanvas())
    document.body.appendChild(this.el)
  }

  get isOpen() { return this.spec !== null }
  get current() { return this.spec }
  get opaque() { return !!this.spec?.opaque }
  get clockRuns() { return !!this.spec?.clockRuns }
  /** 活动提示条正在显示 */
  get toastShowing() { return this.toastT > 0 }

  private trackPointer(e: PointerEvent) {
    const r = (this.cv ?? this.body).getBoundingClientRect()
    this.pointer.x = e.clientX - r.left; this.pointer.y = e.clientY - r.top
  }

  private fitCanvas() {
    const cv = this.cv; if (!cv) return
    const dpr = Math.min(window.devicePixelRatio || 1, 2)
    const w = Math.max(1, this.body.clientWidth), h = Math.max(1, this.body.clientHeight)
    if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(h * dpr)) {
      cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr)
      cv.getContext('2d')?.setTransform(dpr, 0, 0, dpr, 0, 0)
    }
  }

  /** 由 Game.openActivity 调用（状态检查在 Game 里） */
  open(spec: ActivitySpec) {
    if (this.spec) this.close()
    this.spec = spec
    this.body.innerHTML = ''
    this.cv = null
    this.toastEl.classList.remove('show'); this.toastT = 0
    Object.assign(this.pointer, { down: false, clicked: false, wheel: 0 })
    this.el.classList.toggle('opaque', !!spec.opaque)
    this.xbtn.style.display = spec.closable === false ? 'none' : ''
    this.setTitle(spec.title, spec.subtitle)
    this.moneyText = ''
    this.el.classList.add('show')
    const self = this
    const api: ActivityApi = {
      close: () => { if (this.spec === spec) this.close() },
      toast: (t, sec) => this.toast(t, sec),
      get ctx() { return self.getCtx() },
      root: this.body,
      canvas: () => {
        if (!this.cv) {
          const cv = document.createElement('canvas'); cv.className = 'act-canvas'
          this.body.prepend(cv); this.cv = cv; this.fitCanvas()
        }
        return this.cv
      },
      get width() { return self.body.clientWidth },
      get height() { return self.body.clientHeight },
      setTitle: (t, s) => this.setTitle(t, s),
      skipTime: (h) => { if (h > 0) self.getCtx().clock.skip(h) },
      pointer: this.pointer,
    }
    try { spec.mount(this.body, api) } catch (e) { console.error('[REA] 活动 mount 失败：', e); this.close() }
  }

  close() {
    const spec = this.spec; if (!spec) return
    this.spec = null
    this.el.classList.remove('show')
    try { spec.onClose?.() } catch (e) { console.error('[REA] 活动 onClose 出错：', e) }
    this.body.innerHTML = ''
    this.cv = null
    this.onClosed(spec)
  }

  setTitle(title: string, subtitle?: string) {
    this.titleEl.textContent = title
    this.subEl.textContent = subtitle ?? ''
  }

  toast(text: string, sec = 2) { this.toastEl.textContent = text; this.toastEl.classList.add('show'); this.toastT = sec }

  /** Game 每渲染帧调用；返回 false 表示本帧已关闭 */
  update(dt: number, input: Input): boolean {
    const spec = this.spec; if (!spec) return false
    if (input.justPressed('Escape') && !(spec.onEscape?.() ?? false)) { this.close(); return false }
    this.fitCanvas()
    try { spec.update?.(dt, input, this.pointer) } catch (e) { console.error('[REA] 活动 update 出错：', e); this.close(); return false }
    this.pointer.clicked = false; this.pointer.wheel = 0
    if (this.toastT > 0) { this.toastT -= dt; if (this.toastT <= 0) this.toastEl.classList.remove('show') }
    const m = `$${this.getCtx().player.money.toLocaleString()}`
    if (m !== this.moneyText) { this.moneyText = m; this.moneyEl.textContent = m }
    return this.spec === spec
  }
}
