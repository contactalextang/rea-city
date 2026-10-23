import { minimapNav, fmtDist } from './Minimap'

const $ = (id: string) => document.getElementById(id)!

/** 紧凑金额：$850 / $12.3k / $1.25M */
export function compactUsd(n: number) {
  const a = Math.abs(n), sign = n < 0 ? '-' : ''
  if (a >= 1e6) return `${sign}$${(a / 1e6).toFixed(a >= 1e7 ? 1 : 2).replace(/\.?0+$/, '')}M`
  if (a >= 1e3) return `${sign}$${(a / 1e3).toFixed(a >= 1e5 ? 0 : 1).replace(/\.0$/, '')}k`
  return `${sign}$${Math.round(a)}`
}

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
  private navHtml = ''
  private levelText = ''
  private xpPct = -1
  private nwText = ''
  private achEl = $('ach')
  private achTimer = 0
  private achQueue: string[] = []

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
      $('mission-desc').textContent = this.keys(mission.desc)
      $('mission-timer').textContent = mission.timer
      const sub = $('mission-sub'); sub.textContent = this.keys(mission.sub ?? ''); sub.style.display = mission.sub ? '' : 'none'
      this.nav()
    } else m.style.display = 'none'
    this.toastTimer -= dt
    if (this.toastTimer <= 0) this.toastEl.classList.remove('show')
    // 成就横幅：单独一条，排队逐个显示，不和普通 toast 互相覆盖
    this.achTimer -= dt
    if (this.achTimer <= 0) {
      const next = this.achQueue.shift()
      if (next) { this.achEl.textContent = next; this.achEl.classList.add('show'); this.achTimer = 3.5 }
      else this.achEl.classList.remove('show')
    }
    $('debug').textContent = debug
  }

  /** 任务卡片的方位箭头 + 距离（相对相机朝向；数据来自本帧 Minimap.draw 算出的 minimapNav），无目标隐藏 */
  private nav() {
    const t = minimapNav.target
    let html = ''
    if (t && t.dist < 6) html = '就在这里'
    else if (t) {
      const deg = Math.round(t.angle * 180 / Math.PI / 5) * 5
      html = `<span class="arr" style="transform:rotate(${deg}deg)">↑</span>${fmtDist(t.dist, ' ')}`
    }
    if (html === this.navHtml) return
    this.navHtml = html
    const el = $('mission-nav'); el.innerHTML = html; el.style.display = html ? '' : 'none'
  }

  /** 左上角血条下的等级：`Lv3 打手` + XP 条（pct 0–1） */
  level(text: string, pct: number) {
    if (text !== this.levelText) { this.levelText = text; $('level-text').textContent = text }
    const p = Math.round(pct * 200) / 2
    if (p !== this.xpPct) { this.xpPct = p; ($('xp-fill') as HTMLElement).style.width = `${p}%` }
  }

  /** 等级条旁的净资产（紧凑写法：净资产 $12.3k） */
  netWorth(n: number) {
    const t = `净资产 ${compactUsd(n)}`
    if (t !== this.nwText) { this.nwText = t; $('networth').textContent = t }
  }

  private moodText = ''
  /** 左上角心情：`心情 72 · 平静`；低于 30 红色（XP/工资 ×0.85），高于 75 绿色（×1.1） */
  mood(v: number, mul: number) {
    const r = Math.round(v)
    const t = `心情 ${r}${mul < 1 ? ' · 低落 XP/工资 ×0.85' : mul > 1 ? ' · 愉快 XP/工资 ×1.1' : ''}`
    if (t === this.moodText) return
    this.moodText = t
    const el = $('mood'); el.textContent = t
    el.className = `mood${mul < 1 ? ' low' : mul > 1 ? ' high' : ''}`
  }

  /**
   * 提示转发（Game 注入）：活动打开时 HUD 隐藏，toast / 成就横幅改由活动自己的提示条显示；
   * 返回 true = 已转发（HUD 不再显示）。
   */
  sink: ((text: string, seconds: number) => boolean) | null = null

  /** 成就横幅（排队显示；活动期间转发到活动提示条） */
  achievement(text: string) { if (this.sink?.(text, 3)) return; this.achQueue.push(text) }

  /** 取走当前还在显示的 toast（打开活动时转交给活动提示条）；没有则 null */
  takeToast(): { text: string; seconds: number } | null {
    if (this.toastTimer <= 0 || !this.toastEl.classList.contains('show')) return null
    const r = { text: this.toastEl.textContent ?? '', seconds: Math.max(1, this.toastTimer) }
    this.toastTimer = 0; this.toastEl.classList.remove('show')
    return r.text ? r : null
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

  /** 触屏模式：开局说明换成触屏操作，提示里的按键名换成按钮名 */
  private touch = false
  touchHelp() {
    this.touch = true
    $('ov-keys').innerHTML = [
      ['左侧拖动', '移动 / 驾驶（推到底奔跑）'], ['右侧拖动', '转动视角'], ['上车 / 下车', '靠近车辆后点'],
      ['交互', '进入地点（绿框亮起时）'], ['跳 / 手刹', '跳跃 / 手刹漂移'], ['手机', '状态 / 工作 / 地图 / 设置 / 存档'],
      ['任务', '任务提示'], ['全屏', '切换全屏（iPhone 请“添加到主屏幕”）'],
    ].map(([k, v]) => `<span><kbd>${k}</kbd></span><span>${v}</span>`).join('')
    const tip = document.querySelector('#phone .tip'); if (tip) tip.textContent = '点右上 × 关闭手机'
    $('weapon').textContent = '手枪 · 按住「开火」射击'
  }

  /** 触屏模式：文案里的按键名换成屏幕按钮名 */
  private keys(text: string) {
    if (!this.touch) return text
    return text
      .replace(/按 ?F ?(上车|下车)?/g, (_, w) => w === '下车' ? '点「下车」' : '点「上车」')
      .replace(/按 ?E ?/g, '点「交互」').replace(/按 ?M ?/g, '点「任务」')
      .replace(/(^|[^A-Za-z])F (?=上车|上客|下车)/g, '$1「上车」').replace(/(^|[^A-Za-z])E (?=进入|与)/g, '$1「交互」')
      .replace(/Tab ?(?=手机|关闭|开工|→)/g, '')
  }

  hint(text: string | null) {
    if (text) text = this.keys(text)
    if (text) { this.hintEl.textContent = text; this.hintEl.classList.add('show') } else this.hintEl.classList.remove('show')
  }

  toast(text: string, seconds = 2.5) {
    if (this.sink?.(text, seconds)) return
    this.toastEl.textContent = this.keys(text)
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
