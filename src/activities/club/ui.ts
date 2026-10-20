import type { NpcDef } from '../../data/dates'

/** 夜店 / 恋爱活动共用的 DOM 小工具与样式（注入一次） */
const STYLE = `
.club-wrap { position: relative; z-index: 1; display: flex; gap: 22px; padding: 22px 26px; max-width: 980px; margin: 0 auto; flex-wrap: wrap; }
.club-side { flex: 0 0 220px; display: flex; flex-direction: column; align-items: center; gap: 8px; }
.club-side canvas { width: 200px; height: 240px; border-radius: 14px; box-shadow: 0 6px 24px rgba(0,0,0,.45); }
.club-side .nm { font-size: 20px; font-weight: 800; }
.club-side .meta { font-size: 12px; opacity: .75; text-align: center; line-height: 1.5; white-space: pre-line; }
.club-main { flex: 1 1 380px; min-width: 280px; display: flex; flex-direction: column; gap: 12px; }
.club-bar { height: 10px; border-radius: 6px; background: rgba(255,255,255,.12); overflow: hidden; width: 200px; }
.club-bar > i { display: block; height: 100%; background: linear-gradient(90deg,#ff5f8f,#ffb3c7); transition: width .4s; }
.club-say { background: rgba(255,255,255,.08); border: 1px solid rgba(255,255,255,.12); border-radius: 14px; padding: 14px 16px; font-size: 17px; line-height: 1.55; min-height: 52px; }
.club-say .who { font-size: 12px; opacity: .6; display: block; margin-bottom: 4px; }
.club-me { align-self: flex-end; background: rgba(80,160,255,.18); border: 1px solid rgba(120,180,255,.3); border-radius: 14px; padding: 10px 14px; font-size: 15px; max-width: 80%; }
.club-opts { display: flex; flex-direction: column; gap: 8px; }
.club-opts button, .club-row button { text-align: left; padding: 11px 14px; border-radius: 10px; border: 1px solid rgba(255,255,255,.18); background: rgba(20,26,50,.9); color: #fff; font-size: 15px; cursor: pointer; font-family: inherit; }
.club-opts button:hover:not(:disabled), .club-row button:hover:not(:disabled) { background: rgba(60,70,120,.95); border-color: rgba(255,255,255,.4); }
.club-opts button:disabled, .club-row button:disabled { opacity: .45; cursor: default; }
.club-opts button .n { float: right; opacity: .65; font-size: 12px; margin-left: 10px; }
.club-row { display: flex; flex-wrap: wrap; gap: 8px; }
.club-row button { flex: 1 1 140px; text-align: center; }
.club-note { font-size: 12px; opacity: .65; }
.club-delta { font-weight: 800; }
.club-delta.up { color: #7ee787; } .club-delta.down { color: #ff7b72; }
.club-result { position: absolute; inset: 0; z-index: 2; display: flex; align-items: center; justify-content: center; background: rgba(5,6,18,.72); }
.club-result .box { background: rgba(14,18,40,.96); border: 1px solid rgba(255,255,255,.18); border-radius: 18px; padding: 24px 28px; min-width: 320px; max-width: 520px; display: flex; flex-direction: column; gap: 10px; }
.club-result h3 { margin: 0; font-size: 26px; }
.club-result .grade { font-size: 64px; font-weight: 900; line-height: 1; color: #ffd33d; text-shadow: 0 0 18px rgba(255,211,61,.5); }
.club-list { display: grid; grid-template-columns: repeat(auto-fill, minmax(200px, 1fr)); gap: 10px; }
.club-list button { padding: 12px; border-radius: 12px; border: 1px solid rgba(255,255,255,.18); background: rgba(20,26,50,.9); color: #fff; cursor: pointer; text-align: left; font-family: inherit; font-size: 14px; line-height: 1.45; }
.club-list button:disabled { opacity: .45; cursor: default; }
.club-list button b { font-size: 15px; }
.club-list button.sel { border-color: #ff8fab; background: rgba(120,40,80,.6); }
#club-drunk { position: fixed; inset: 0; pointer-events: none; z-index: 4; opacity: 0; transition: opacity 1.2s; background: radial-gradient(ellipse at center, rgba(0,0,0,0) 45%, rgba(90,20,80,.35) 100%); }
@media (max-width: 640px) { .club-wrap { padding: 14px 16px; } .club-side { flex-basis: 100%; flex-direction: row; } .club-side canvas { width: 110px; height: 132px; } }
`
export function injectStyle() {
  if (document.getElementById('club-style')) return
  const st = document.createElement('style'); st.id = 'club-style'; st.textContent = STYLE; document.head.appendChild(st)
}

export function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls = '', text = ''): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag)
  if (cls) e.className = cls
  if (text) e.textContent = text
  return e
}
export function btn(label: string, onClick: () => void, opts: { note?: string; disabled?: boolean; id?: string } = {}) {
  const b = el('button')
  b.textContent = label
  if (opts.note) { const n = el('span', 'n', opts.note); b.appendChild(n) }
  if (opts.disabled) b.disabled = true
  if (opts.id) b.dataset.club = opts.id
  b.addEventListener('click', () => { if (!b.disabled) onClick() })
  return b
}

/** NPC 立绘：主题色渐变背景 + 剪影（肤色头、发型、上衣色身体） */
export function drawPortrait(cv: HTMLCanvasElement, npc: NpcDef, mood = 0) {
  const W = 200, H = 240, dpr = Math.min(2, window.devicePixelRatio || 1)
  cv.width = W * dpr; cv.height = H * dpr
  const g = cv.getContext('2d'); if (!g) return
  g.setTransform(dpr, 0, 0, dpr, 0, 0)
  const bg = g.createLinearGradient(0, 0, 0, H)
  bg.addColorStop(0, npc.theme); bg.addColorStop(1, '#0b0e1e')
  g.fillStyle = bg; g.fillRect(0, 0, W, H)
  // 光斑
  for (let i = 0; i < 6; i++) {
    g.fillStyle = `rgba(255,255,255,${0.04 + (i % 3) * 0.02})`
    g.beginPath(); g.arc((i * 53) % W, 30 + ((i * 71) % 120), 14 + (i % 4) * 8, 0, Math.PI * 2); g.fill()
  }
  const L = npc.look, f = npc.gender === 'f'
  // 身体
  // 身体：男宽肩、女窄肩
  const sh = f ? 48 : 64
  g.fillStyle = L.top
  g.beginPath(); g.moveTo(100 - sh, H); g.quadraticCurveTo(100 - sh + 4, 166, 100, 160); g.quadraticCurveTo(100 + sh - 4, 166, 100 + sh, H); g.closePath(); g.fill()
  // 西装 / 衬衫领口与领带
  if (L.body.endsWith('suit_body') || L.body === 'm_casual_body') {
    g.fillStyle = '#ffffff'; g.beginPath(); g.moveTo(88, 162); g.lineTo(100, 190); g.lineTo(112, 162); g.closePath(); g.fill()
    if (L.body.endsWith('suit_body')) { g.fillStyle = '#8b1e2d'; g.fillRect(97, 166, 6, 30) }
  }
  // 反光条（工装 / 消防）
  if (L.body.endsWith('worker_body') && !f) { g.fillStyle = '#f5c400'; g.fillRect(100 - sh + 12, 205, sh * 2 - 24, 7) }
  // 脖子
  g.fillStyle = L.skin; g.fillRect(90, 138, 20, 26)
  // 长发（后）
  if (f && npc.id !== 'nurul') { g.fillStyle = L.hair; g.beginPath(); g.ellipse(100, 120, 44, 56, 0, 0, Math.PI * 2); g.fill() }
  // 头巾
  if (npc.id === 'nurul') { g.fillStyle = L.hair; g.beginPath(); g.ellipse(100, 112, 46, 54, 0, 0, Math.PI * 2); g.fill(); g.fillRect(56, 112, 88, 54) }
  // 脸
  g.fillStyle = L.skin; g.beginPath(); g.ellipse(100, 108, 32, 38, 0, 0, Math.PI * 2); g.fill()
  // 刘海 / 短发
  if (npc.id !== 'nurul') {
    g.fillStyle = L.hair; g.beginPath(); g.ellipse(100, 82, f ? 36 : 34, f ? 20 : 16, 0, Math.PI, 0); g.fill()
    if (!f) g.fillRect(66, 80, 68, 8)
  }
  if (L.hat) { g.fillStyle = L.hatColor ?? L.top; g.beginPath(); g.ellipse(100, 74, 36, 16, 0, Math.PI, 0); g.fill(); g.fillRect(96, 70, 48, 6) }
  // 眼睛与笑
  g.fillStyle = '#1b1b1b'
  g.beginPath(); g.arc(88, 108, 3, 0, Math.PI * 2); g.arc(112, 108, 3, 0, Math.PI * 2); g.fill()
  g.strokeStyle = '#7a3b2e'; g.lineWidth = 2.2
  g.beginPath()
  const smile = Math.max(-1, Math.min(1, mood))
  g.moveTo(90, 126); g.quadraticCurveTo(100, 126 + smile * 8, 110, 126)
  if (f) { g.strokeStyle = '#c0395a'; g.lineWidth = 3 }
  g.stroke()
  // 女：睫毛 + 耳环；男：眉毛更粗
  g.strokeStyle = '#1b1b1b'; g.lineWidth = f ? 1.5 : 3
  g.beginPath()
  if (f) { g.moveTo(84, 104); g.lineTo(82, 101); g.moveTo(116, 104); g.lineTo(118, 101) }
  else { g.moveTo(82, 99); g.lineTo(94, 98); g.moveTo(106, 98); g.lineTo(118, 99) }
  g.stroke()
  if (f && npc.id !== 'nurul') { g.fillStyle = '#ffd36b'; g.beginPath(); g.arc(68, 118, 3, 0, Math.PI * 2); g.arc(132, 118, 3, 0, Math.PI * 2); g.fill() }
  if (smile > 0.4) { g.fillStyle = 'rgba(255,110,140,.35)'; g.beginPath(); g.arc(80, 120, 6, 0, Math.PI * 2); g.arc(120, 120, 6, 0, Math.PI * 2); g.fill() }
}

export const fmt$ = (n: number) => `$${Math.round(n).toLocaleString()}`
