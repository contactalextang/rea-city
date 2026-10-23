// 键盘状态采样：held 持续按下，justPressed 本帧刚按下
export class Input {
  private held = new Set<string>()
  private pressed = new Set<string>()
  anyKeyPressed = false
  mouseDX = 0
  mouseDY = 0
  clicked = false
  private mouseHeld = new Set<number>()
  /** 本帧刚按下 / 刚松开的鼠标键（指针锁定时才记，与 mouseDown 一致） */
  private mouseDownEdge = new Set<number>()
  private mouseUpEdge = new Set<number>()
  /** 滚轮 deltaY 累计（takeWheel 取走；endFrame 清零，避免城市里滚的量带进竞技场） */
  private wheel = 0
  private lockTarget: HTMLElement | null = null
  /** 触屏模式：粗指针设备或 URL ?touch=1（桌面测试用）；由 TouchControls 写入下面的虚拟输入 */
  readonly touch = matchMedia('(pointer: coarse)').matches || new URLSearchParams(location.search).get('touch') === '1'
  /** 虚拟摇杆（-1..1）：stickX 右正、stickY 前正 */
  stickX = 0
  stickY = 0
  /** 触屏正在拖动视角（步行方向实时跟随相机，等同桌面锁定鼠标） */
  lookActive = false

  constructor() {
    document.addEventListener('mousemove', (e) => {
      if (!this.locked) return
      this.mouseDX += e.movementX
      this.mouseDY += e.movementY
    })
    document.addEventListener('pointerlockchange', () => { if (!this.locked) { this.mouseDX = 0; this.mouseDY = 0; for (const b of this.mouseHeld) this.mouseUpEdge.add(b); this.mouseHeld.clear() } })
    window.addEventListener('keydown', (e) => {
      if (e.repeat) return
      this.held.add(e.code)
      this.pressed.add(e.code)
      this.anyKeyPressed = true
      if (['Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.code)) e.preventDefault()
    })
    window.addEventListener('keyup', (e) => this.held.delete(e.code))
    window.addEventListener('wheel', (e) => { this.wheel += e.deltaY }, { passive: true })
    window.addEventListener('blur', () => { this.held.clear(); this.stickX = 0; this.stickY = 0; this.lookActive = false })
  }

  get locked() { return this.lockTarget !== null && document.pointerLockElement === this.lockTarget }

  /** 在指定元素上点击即请求指针锁定 */
  bindPointerLock(el: HTMLElement) {
    this.lockTarget = el
    el.addEventListener('mouseup', (e) => { if (this.mouseHeld.delete(e.button)) this.mouseUpEdge.add(e.button) })
    el.addEventListener('contextmenu', (e) => e.preventDefault())
    el.addEventListener('mousedown', (e) => {
      this.clicked = true
      if (this.locked) { this.mouseHeld.add(e.button); this.mouseDownEdge.add(e.button) }
      if (!this.locked) {
        try { (el.requestPointerLock?.() as unknown as Promise<void> | undefined)?.catch?.(() => {}) } catch { /* 不支持指针锁定的环境 */ }
      }
    })
  }

  /** 取走本帧累计的鼠标位移 */
  takeMouse() { const r = { dx: this.mouseDX, dy: this.mouseDY }; this.mouseDX = 0; this.mouseDY = 0; return r }

  mouseDown(button = 0) { return this.mouseHeld.has(button) }
  /** 本帧刚按下（指针锁定时）；同一帧按下又松开也算 */
  mousePressed(button = 0) { return this.mouseDownEdge.has(button) }
  /** 本帧刚松开（按下时处于指针锁定） */
  mouseReleased(button = 0) { return this.mouseUpEdge.has(button) }
  /** 取走累计的滚轮 deltaY（向下滚为正） */
  takeWheel() { const w = this.wheel; this.wheel = 0; return w }
  down(code: string) { return this.held.has(code) }
  justPressed(code: string) { return this.pressed.has(code) }
  axis(neg: string, pos: string) { return (this.down(pos) ? 1 : 0) - (this.down(neg) ? 1 : 0) }
  /** 移动轴：WASD + 方向键 + 虚拟摇杆，各自 clamp 到 [-1, 1] */
  moveAxis() {
    const c = (v: number) => Math.max(-1, Math.min(1, v))
    return {
      fwd: c(this.axis('KeyS', 'KeyW') + this.axis('ArrowDown', 'ArrowUp') + this.stickY),
      side: c(this.axis('KeyA', 'KeyD') + this.axis('ArrowLeft', 'ArrowRight') + this.stickX),
    }
  }

  /** 触屏按钮：按下 / 松开一个虚拟键（复用键码，justPressed / down 照常生效） */
  setVirtual(code: string, on: boolean) {
    if (on) { if (!this.held.has(code)) { this.held.add(code); this.pressed.add(code); this.anyKeyPressed = true } }
    else this.held.delete(code)
  }
  /** 触屏拖动视角：直接累计到鼠标位移（无需指针锁定） */
  addLook(dx: number, dy: number) { this.mouseDX += dx; this.mouseDY += dy }

  /** 每帧渲染结束后调用，清除边沿状态 */
  endFrame() { this.pressed.clear(); this.anyKeyPressed = false; this.clicked = false; this.mouseDownEdge.clear(); this.mouseUpEdge.clear(); this.wheel = 0 }
}
