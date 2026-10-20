import type { ActivityApi, ActivitySpec } from '../../ui/Activity'
import { ClubTrack, BEAT, BAR, SONG_BARS, SONG_LEN, sectionOf } from './ClubMusic'
import { el, btn, injectStyle } from './ui'

/**
 * 节奏舞蹈小游戏：四方向箭头下落，←↓↑→ 或 A S W D（也可点击轨道）。
 * 谱面严格落在 124 BPM 的 8 分音符网格上（与 ClubTrack 底鼓同一时钟）；
 * 判定窗：Perfect ±60 ms、Good ±130 ms，超过即 Miss（断连击）。
 */
export const PERFECT_WIN = 0.06
export const GOOD_WIN = 0.13
const TRAVEL = 1.45
const LANE_KEYS: Record<string, number> = { ArrowLeft: 0, KeyA: 0, ArrowDown: 1, KeyS: 1, ArrowUp: 2, KeyW: 2, ArrowRight: 3, KeyD: 3 }
const LANE_COL = ['#ff4fa3', '#38d9ff', '#7cff6b', '#ffcf3d']
const ARROW_ROT = [-Math.PI / 2, Math.PI, 0, Math.PI / 2]   // 箭头默认朝上

export interface Note { t: number; lane: number; hit: 'perfect' | 'good' | 'miss' | null; dt?: number }
export interface DanceResult { perfect: number; good: number; miss: number; total: number; maxCombo: number; score: number; pct: number; grade: 'S' | 'A' | 'B' | 'C' | 'D' }

function rng(seed: number) {
  let a = seed >>> 0
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296 }
}

/** 生成谱面：每个音符都落在 8 分音符网格（BEAT/2 的整数倍） */
export function makeChart(seed = 1): Note[] {
  const r = rng(seed), out: Note[] = []
  let last = -1, rep = 0
  for (let bar = 2; bar < SONG_BARS; bar++) {
    const sec = sectionOf(bar)
    let slots: number[]
    if (sec === 'verse') slots = [0, 2, 4, 6]
    else if (sec === 'build') slots = bar < 14 ? [0, 2, 4, 6, 7] : [0, 2, 3, 4, 6, 7]
    else if (sec === 'drop') { slots = [0, 1, 2, 3, 4, 5, 6, 7]; for (let k = 0; k < 2; k++) slots.splice(1 + Math.floor(r() * (slots.length - 1)), 1) }
    else if (sec === 'break') slots = [0, 4]
    else slots = bar === SONG_BARS - 1 ? [0] : [0, 2, 4, 6]
    for (const s of slots) {
      let lane = Math.floor(r() * 4)
      if (lane === last && ++rep >= 2) { lane = (lane + 1 + Math.floor(r() * 3)) % 4; rep = 0 } else if (lane !== last) rep = 0
      last = lane
      out.push({ t: bar * BAR + s * (BEAT / 2), lane, hit: null })
    }
  }
  return out
}

export function scoreOf(notes: Note[], maxCombo: number): DanceResult {
  let perfect = 0, good = 0, miss = 0
  for (const n of notes) { if (n.hit === 'perfect') perfect++; else if (n.hit === 'good') good++; else miss++ }
  const total = notes.length
  const pct = total ? (perfect + good * 0.5) / total : 0
  const score = perfect * 300 + good * 120 + maxCombo * 10
  const grade = pct >= 0.9 ? 'S' : pct >= 0.75 ? 'A' : pct >= 0.55 ? 'B' : pct >= 0.35 ? 'C' : 'D'
  return { perfect, good, miss, total, maxCombo, score, pct, grade }
}

/** 由目标准确率直接合成一局结果（调试 dance(score) 用） */
export function fakeResult(pct: number): DanceResult {
  const notes = makeChart(1)
  const p = Math.max(0, Math.min(1, pct))
  notes.forEach((n, i) => { const f = (i * 0.618) % 1; n.hit = f < p ? 'perfect' : 'miss' })
  return scoreOf(notes, Math.round(notes.length * p * 0.6))
}

/** 当前进行中的舞蹈（测试钩子读谱面 / 时钟） */
export let liveDance: { chart: Note[]; now(): number; kicks: number[]; combo(): number; audible: boolean; press(lane: number, songT?: number): string | null } | null = null

export interface DanceHost {
  /** 静音城市背景音乐（返回恢复函数） */
  muteWorldMusic(): () => void
  /** 一曲结束（含 Esc 提前结束）；返回结果面板的附加按钮 */
  onFinish(res: DanceResult, api: ActivityApi): { lines: string[]; buttons: { label: string; onClick: () => void; id?: string }[] }
}

export function danceSpec(host: DanceHost, seed: number): ActivitySpec {
  const chart = makeChart(seed)
  const track = new ClubTrack()
  let api: ActivityApi
  let combo = 0, maxCombo = 0
  let finished = false
  let judgeText = '', judgeT = 0, judgeCol = '#fff'
  const flash = [0, 0, 0, 0]
  let unmute: (() => void) | null = null
  let cursor = 0   // 第一个还没判定的音符下标（Miss 扫描用）

  const judge = (lane: number, t: number): string | null => {
    if (finished) return null
    flash[lane] = 1
    let best: Note | null = null, bd = Infinity
    for (let i = cursor; i < chart.length; i++) {
      const n = chart[i]
      if (n.t - t > GOOD_WIN) break
      if (n.hit || n.lane !== lane) continue
      const d = Math.abs(n.t - t)
      if (d <= GOOD_WIN && d < bd) { best = n; bd = d }
    }
    if (!best) return null
    best.dt = t - best.t
    best.hit = bd <= PERFECT_WIN ? 'perfect' : 'good'
    combo++; maxCombo = Math.max(maxCombo, combo)
    judgeText = best.hit === 'perfect' ? 'PERFECT' : 'GOOD'; judgeCol = best.hit === 'perfect' ? '#ffd33d' : '#7ee787'; judgeT = 0.5
    return best.hit
  }
  const onKey = (e: KeyboardEvent) => {
    const lane = LANE_KEYS[e.code]
    if (lane === undefined) return
    e.preventDefault()
    if (e.repeat) return
    judge(lane, track.at(e.timeStamp || performance.now()))
  }

  const finish = () => {
    if (finished) return
    finished = true
    for (const n of chart) if (!n.hit) n.hit = 'miss'
    track.stop()
    unmute?.(); unmute = null
    const res = scoreOf(chart, maxCombo)
    const extra = host.onFinish(res, api)
    const ov = el('div', 'club-result'), box = el('div', 'box')
    box.append(el('h3', '', '一曲终了'), el('div', 'grade', res.grade))
    box.append(el('div', '', `准确率 ${(res.pct * 100).toFixed(1)}% · 得分 ${res.score.toLocaleString()} · 最大连击 ${res.maxCombo}`))
    box.append(el('div', 'club-note', `Perfect ${res.perfect} · Good ${res.good} · Miss ${res.miss}（共 ${res.total}）`))
    for (const l of extra.lines) box.append(el('div', '', l))
    const row = el('div', 'club-row')
    for (const b of extra.buttons) row.append(btn(b.label, b.onClick, { id: b.id }))
    row.append(btn('离开舞池', () => api.close(), { id: 'dance-close' }))
    box.append(row); ov.append(box); api.root.append(ov)
  }

  return {
    id: 'club_dance', title: '舞池', subtitle: '←↓↑→ / WASD · 跟着底鼓踩点', opaque: true, returnToPanel: true,
    mount(root, a) {
      api = a
      injectStyle()
      a.canvas()
      unmute = host.muteWorldMusic()
      window.addEventListener('keydown', onKey, true)
      track.start(1.2)
      liveDance = { chart, now: () => track.now(), kicks: track.kicks, combo: () => combo, audible: track.audible, press: (lane, songT) => judge(lane, songT ?? track.now()) }
      void root
    },
    onEscape() { if (!finished) { finish(); return true } return false },
    onClose() {
      window.removeEventListener('keydown', onKey, true)
      if (!finished) { finished = true; track.stop(); unmute?.() }
      liveDance = null
    },
    update(dt, _input, ptr) {
      track.update()
      const t = track.now()
      const W = api.width, H = api.height
      const laneW = Math.min(96, (W - 40) / 4), x0 = W / 2 - laneW * 2, judgeY = H - 120, topY = 40
      if (ptr.clicked && !finished && ptr.x >= x0 && ptr.x < x0 + laneW * 4) judge(Math.floor((ptr.x - x0) / laneW), t)
      // Miss 扫描
      while (cursor < chart.length && (chart[cursor].hit || chart[cursor].t < t - GOOD_WIN)) {
        const n = chart[cursor]
        if (!n.hit) { n.hit = 'miss'; combo = 0; judgeText = 'MISS'; judgeCol = '#ff7b72'; judgeT = 0.5 }
        cursor++
      }
      if (!finished && t > SONG_LEN + 0.4) finish()
      // ---- 绘制 ----
      const g = api.canvas().getContext('2d')!
      const beatPh = t > 0 ? (t % BEAT) / BEAT : 1
      const pulse = Math.pow(1 - beatPh, 3)
      const bar = Math.floor(Math.max(0, t) / BAR), sec = sectionOf(bar)
      const hot = sec === 'drop' ? 1 : sec === 'build' ? 0.6 : 0.35
      g.fillStyle = '#070816'; g.fillRect(0, 0, W, H)
      // 舞池灯光
      for (let i = 0; i < 5; i++) {
        const a = t * 0.6 + i * 1.3, cx = W / 2 + Math.sin(a) * W * 0.42, cy = H * 0.35 + Math.cos(a * 0.7) * H * 0.25
        const rg = g.createRadialGradient(cx, cy, 0, cx, cy, 260)
        rg.addColorStop(0, LANE_COL[i % 4] + Math.round((0.12 + pulse * 0.35 * hot) * 255).toString(16).padStart(2, '0'))
        rg.addColorStop(1, 'rgba(0,0,0,0)')
        g.fillStyle = rg; g.fillRect(0, 0, W, H)
      }
      // 地板格
      g.globalAlpha = 0.25 + pulse * 0.3 * hot
      for (let gx = 0; gx < 12; gx++) for (let gy = 0; gy < 3; gy++) {
        if ((gx + gy + bar) % 3) continue
        g.fillStyle = LANE_COL[(gx + gy) % 4]; g.fillRect((gx / 12) * W, H - 60 + gy * 20, W / 12 - 2, 18)
      }
      g.globalAlpha = 1
      // 轨道
      for (let l = 0; l < 4; l++) {
        const x = x0 + l * laneW
        g.fillStyle = `rgba(255,255,255,${0.05 + flash[l] * 0.18})`; g.fillRect(x + 3, topY, laneW - 6, judgeY - topY + 40)
        flash[l] = Math.max(0, flash[l] - dt * 5)
      }
      // 节拍线
      g.strokeStyle = 'rgba(255,255,255,.12)'; g.lineWidth = 1
      const firstBeat = Math.ceil(t / BEAT)
      for (let b = firstBeat; b * BEAT < t + TRAVEL; b++) {
        const y = judgeY - ((b * BEAT - t) / TRAVEL) * (judgeY - topY)
        g.globalAlpha = b % 4 === 0 ? 0.6 : 0.25
        g.beginPath(); g.moveTo(x0, y); g.lineTo(x0 + laneW * 4, y); g.stroke()
      }
      g.globalAlpha = 1
      // 判定线 + 接收器
      g.fillStyle = `rgba(255,255,255,${0.35 + pulse * 0.4})`; g.fillRect(x0, judgeY - 2, laneW * 4, 4)
      for (let l = 0; l < 4; l++) arrow(g, x0 + l * laneW + laneW / 2, judgeY, laneW * 0.36, l, 'rgba(255,255,255,.25)', 1 + flash[l] * 0.15, true)
      // 音符
      for (let i = cursor > 4 ? cursor - 4 : 0; i < chart.length; i++) {
        const n = chart[i]
        if (n.t > t + TRAVEL) break
        if (n.hit === 'perfect' || n.hit === 'good') continue
        const y = judgeY - ((n.t - t) / TRAVEL) * (judgeY - topY)
        if (y > H) continue
        arrow(g, x0 + n.lane * laneW + laneW / 2, y, laneW * 0.34, n.lane, n.hit === 'miss' ? 'rgba(120,120,120,.5)' : LANE_COL[n.lane], 1, false)
      }
      // HUD 文字
      g.textAlign = 'center'; g.fillStyle = '#fff'
      if (t < 0 || bar < 2) { g.font = '800 34px system-ui, sans-serif'; g.fillText(t < 0 ? '准备' : `${2 * 4 - Math.floor(t / BEAT)}`, W / 2, H * 0.4) }
      if (judgeT > 0) { judgeT -= dt; g.globalAlpha = Math.min(1, judgeT * 3); g.fillStyle = judgeCol; g.font = '900 36px system-ui, sans-serif'; g.fillText(judgeText, W / 2, judgeY - 150); g.globalAlpha = 1 }
      if (combo >= 3) { g.fillStyle = '#fff'; g.font = '800 22px system-ui, sans-serif'; g.fillText(`${combo} COMBO`, W / 2, judgeY - 110) }
      const done = chart.filter((n) => n.hit === 'perfect' || n.hit === 'good').length
      g.textAlign = 'left'; g.font = '700 16px system-ui, sans-serif'; g.fillStyle = '#fff'
      g.fillText(`命中 ${done}/${chart.length}`, 20, 30)
      g.fillText(`${sec === 'drop' ? '高潮！' : sec === 'build' ? '渐强…' : ''}`, 20, 54)
      // 进度条
      g.fillStyle = 'rgba(255,255,255,.15)'; g.fillRect(20, H - 12, W - 40, 4)
      g.fillStyle = '#ff8fab'; g.fillRect(20, H - 12, (W - 40) * Math.max(0, Math.min(1, t / SONG_LEN)), 4)
    },
  }
}

function arrow(g: CanvasRenderingContext2D, x: number, y: number, r: number, lane: number, col: string, s: number, hollow: boolean) {
  g.save(); g.translate(x, y); g.rotate(ARROW_ROT[lane]); g.scale(s, s)
  g.beginPath()
  g.moveTo(0, -r); g.lineTo(r, 0); g.lineTo(r * 0.42, 0); g.lineTo(r * 0.42, r); g.lineTo(-r * 0.42, r); g.lineTo(-r * 0.42, 0); g.lineTo(-r, 0); g.closePath()
  if (hollow) { g.strokeStyle = col; g.lineWidth = 3; g.stroke() } else { g.fillStyle = col; g.shadowColor = col; g.shadowBlur = 14; g.fill() }
  g.restore()
}
