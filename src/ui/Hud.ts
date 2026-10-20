const $ = (id: string) => document.getElementById(id)!

/** DOM 覆盖层：血条、金钱、通缉星、任务卡片、提示、全屏覆盖 */
export class Hud {
  private toastTimer = 0
  private hintEl = $('hint')
  private toastEl = $('toast')
  private overlay = $('overlay')
  private clockEl = $('clock')
  private clockText = ''
  private lawText = ''
  private gun = true
  private vignetteOn = false

  update(dt: number, health: number, money: number, stars: number, flash: number, speedKmh: number | null,
    mission: { title: string; desc: string; timer: string; sub?: string } | null, debug: string) {
    ;($('health') as HTMLElement).style.width = `${Math.max(0, health)}%`
    $('money').textContent = `$${money.toLocaleString()}`
    $('stars').innerHTML = Array.from({ length: 5 }, (_, i) => `<span class="${i < stars ? 'on' : 'off'}">★</span>`).join('')
    ;($('stars') as HTMLElement).style.transform = flash > 0 ? `scale(${1 + flash * 0.25})` : ''
    ;($('stars') as HTMLElement).style.transformOrigin = 'right center'
    $('speed').textContent = speedKmh === null ? '' : `${Math.round(Math.abs(speedKmh))} km/h`
    const m = $('mission')
    if (mission) {
      m.style.display = ''
      $('mission-title').textContent = mission.title
      $('mission-desc').textContent = mission.desc
      $('mission-timer').textContent = mission.timer
      const sub = $('mission-sub'); sub.textContent = mission.sub ?? ''; sub.style.display = mission.sub ? '' : 'none'
    } else m.style.display = 'none'
    this.toastTimer -= dt
    if (this.toastTimer <= 0) this.toastEl.classList.remove('show')
    $('debug').textContent = debug
  }

  /** 左上角时钟/天气：如 `第1天 07:30 · 晴` */
  clock(text: string) {
    if (text === this.clockText) return
    this.clockText = text; this.clockEl.textContent = text
  }

  /** 右上角星级下方的执法信息：如 `扣分 4/24 · 罚款 $350`，空串隐藏 */
  law(text: string) {
    if (text === this.lawText) return
    this.lawText = text
    const el = $('law'); el.textContent = text; el.style.display = text ? '' : 'none'
  }

  /** 低饥饿/低精力暗角 */
  vignette(on: boolean) {
    if (on === this.vignetteOn) return
    this.vignetteOn = on
    $('vignette').classList.toggle('show', on)
  }

  /** 身份无枪时不显示武器栏与准星 */
  setGun(on: boolean) { this.gun = on }

  aiming(on: boolean) {
    $('crosshair').classList.toggle('show', on && this.gun)
    $('weapon').classList.toggle('show', on && this.gun)
  }

  hint(text: string | null) {
    if (text) { this.hintEl.textContent = text; this.hintEl.classList.add('show') } else this.hintEl.classList.remove('show')
  }

  toast(text: string, seconds = 2.5) {
    this.toastEl.textContent = text
    this.toastEl.classList.add('show')
    this.toastTimer = seconds
  }

  showOverlay(title: string, sub: string, cls: '' | 'red' | 'gold', showKeys: boolean, go: string) {
    const t = $('ov-title'); t.textContent = title; t.className = cls
    $('ov-sub').textContent = sub
    $('ov-keys').style.display = showKeys ? '' : 'none'
    $('ov-go').textContent = go
    $('ov-go').style.display = go ? '' : 'none'
    this.overlay.classList.remove('hidden')
  }
  hideOverlay() { this.overlay.classList.add('hidden') }
  /** 覆盖层底部署名（数据来源）；空串隐藏 */
  attribution(text: string) { const el = $('ov-attrib'); el.textContent = text; el.style.display = text ? '' : 'none' }
}
