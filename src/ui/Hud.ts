const $ = (id: string) => document.getElementById(id)!

/** DOM 覆盖层：血条、金钱、通缉星、任务卡片、提示、全屏覆盖 */
export class Hud {
  private toastTimer = 0
  private hintEl = $('hint')
  private toastEl = $('toast')
  private overlay = $('overlay')

  update(dt: number, health: number, money: number, stars: number, flash: number, speedKmh: number | null,
    mission: { title: string; desc: string; timer: string } | null, debug: string) {
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
    } else m.style.display = 'none'
    this.toastTimer -= dt
    if (this.toastTimer <= 0) this.toastEl.classList.remove('show')
    $('debug').textContent = debug
  }

  aiming(on: boolean) {
    $('crosshair').classList.toggle('show', on)
    $('weapon').classList.toggle('show', on)
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
}
