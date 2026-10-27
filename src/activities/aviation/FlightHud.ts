import { t } from '../../i18n'

/**
 * 飞行仪表 HUD（AIR.4，自己的 DOM，挂在 #hud 里随普通 HUD 一起隐藏）：
 * 左下仪表条（空速 kt、高度 m、升降速度、航向、油门、襟翼）+ 屏幕中部告警（失速 / PULL UP / 即将离开空域）+ 键位说明。
 * 触屏：仪表条改到顶部居中、横排，键位说明不显示。
 */
const CSS = /* i18n-ignore：CSS */ `
#flight-hud { position: absolute; inset: 0; pointer-events: none; display: none; }
#flight-hud.on { display: block; }
#flight-hud .fh-panel { position: absolute; left: 16px; bottom: 16px; background: rgba(6,12,24,.55); border: 1px solid rgba(255,255,255,.25); border-radius: 10px; padding: 8px 12px; font: 600 13px -apple-system, "PingFang SC", sans-serif; display: grid; grid-template-columns: auto auto; gap: 2px 12px; min-width: 190px; }
#flight-hud .fh-panel .k { opacity: .7; font-weight: 500; }
#flight-hud .fh-panel .v { text-align: right; font-variant-numeric: tabular-nums; font-size: 15px; }
#flight-hud .fh-thr { grid-column: 1 / 3; height: 5px; background: rgba(255,255,255,.18); border-radius: 3px; overflow: hidden; margin-top: 3px; }
#flight-hud .fh-thr > div { height: 100%; width: 0; background: #7ee787; }
#flight-hud .fh-keys { position: absolute; left: 16px; bottom: 176px; font-size: 11px; opacity: .7; max-width: 340px; line-height: 1.5; }
#flight-hud .fh-warn { position: absolute; left: 50%; top: 38%; transform: translateX(-50%); text-align: center; font: 800 26px -apple-system, "PingFang SC", sans-serif; letter-spacing: 2px; }
#flight-hud .fh-warn .red { color: #ff4d4d; animation: fhblink .5s steps(2) infinite; }
#flight-hud .fh-warn .amber { color: #ffb020; font-size: 18px; }
@keyframes fhblink { 50% { opacity: .25; } }
body.touch #flight-hud .fh-panel { left: 50%; bottom: auto; top: calc(56px + env(safe-area-inset-top)); transform: translateX(-50%); grid-template-columns: repeat(6, auto); gap: 0 10px; min-width: 0; padding: 4px 10px; font-size: 11px; }
body.touch #flight-hud .fh-panel .v { font-size: 13px; }
body.touch #flight-hud .fh-panel .k { display: none; }
body.touch #flight-hud .fh-thr { grid-column: 1 / 7; }
body.touch #flight-hud .fh-keys { display: none; }
body.touch #flight-hud .fh-warn { top: 30%; font-size: 20px; }
`

export interface FlightHudState {
  /** 空速 m/s */
  speed: number
  /** 高度 m（离海平面）与离地高度（含高楼） */
  alt: number
  agl: number
  vs: number
  /** 罗盘航向（度，北 0 顺时针） */
  hdg: number
  throttle: number
  flaps: number
  stalled: boolean
  pullUp: boolean
  /** 空域告警：'near' 即将离开，'out' 已离开（自动掉头中） */
  airspace: 'ok' | 'near' | 'out'
  onGround: boolean
  autopilot: boolean
}

export class FlightHud {
  private root = document.createElement('div')
  private vals: Record<string, HTMLElement> = {}
  private thr: HTMLDivElement
  private warn: HTMLDivElement
  private last = ''
  private lastWarn = ''
  private shown = false

  constructor(touch: boolean) {
    const style = document.createElement('style'); style.textContent = CSS; document.head.appendChild(style)
    this.root.id = 'flight-hud'
    const panel = document.createElement('div'); panel.className = 'fh-panel'
    const rows: [string, string][] = [['spd', t('空速')], ['alt', t('高度')], ['vs', t('升降')], ['hdg', t('航向')], ['thrv', t('油门')], ['flap', t('襟翼')]]
    for (const [id, label] of rows) {
      const k = document.createElement('span'); k.className = 'k'; k.textContent = label
      const v = document.createElement('span'); v.className = 'v'
      panel.append(k, v); this.vals[id] = v
    }
    const bar = document.createElement('div'); bar.className = 'fh-thr'
    this.thr = document.createElement('div'); bar.appendChild(this.thr); panel.appendChild(bar)
    const keys = document.createElement('div'); keys.className = 'fh-keys'
    keys.textContent = touch ? '' : t('W/S 俯仰 · A/D 横滚 · Q/E 方向舵 · Shift/Ctrl 油门 · Space 刹车 · V 视角 · F 下机（停稳后）')
    this.warn = document.createElement('div'); this.warn.className = 'fh-warn'
    this.root.append(panel, keys, this.warn)
    ;(document.getElementById('hud') ?? document.body).appendChild(this.root)
  }

  show(on: boolean) {
    if (on === this.shown) return
    this.shown = on
    this.root.classList.toggle('on', on)
    if (!on) { this.last = ''; this.lastWarn = ''; this.warn.innerHTML = '' }
  }

  update(s: FlightHudState) {
    if (!this.shown) return
    const kt = Math.round(s.speed * 1.94384)
    const vs = s.vs
    const vals = {
      spd: `${kt} kt`,
      alt: `${Math.round(s.alt)} m`,
      vs: `${vs >= 0 ? '+' : ''}${vs.toFixed(1)} m/s`,
      hdg: `${String(Math.round(((s.hdg % 360) + 360) % 360)).padStart(3, '0')}°`,
      thrv: `${Math.round(s.throttle * 100)}%`,
      flap: s.flaps > 0.5 ? t('放下') : s.flaps > 0.05 ? t('收放中') : t('收起'),
    }
    const key = Object.values(vals).join('|')
    if (key !== this.last) {
      this.last = key
      for (const [k, v] of Object.entries(vals)) this.vals[k].textContent = v
      this.thr.style.width = `${Math.round(s.throttle * 100)}%`
    }
    const w: string[] = []
    if (s.pullUp) w.push(`<div class="red">PULL UP</div>`)
    if (s.stalled) w.push(`<div class="red">${t('失速')}</div>`)
    if (s.airspace === 'near') w.push(`<div class="amber">${t('即将离开空域')}</div>`)
    else if (s.airspace === 'out') w.push(`<div class="amber">${t('已离开空域 · 自动掉头')}</div>`)
    if (s.autopilot) w.push(`<div class="amber">${t('自动驾驶')}</div>`)
    const wk = w.join('')
    if (wk !== this.lastWarn) { this.lastWarn = wk; this.warn.innerHTML = wk }
  }
}
