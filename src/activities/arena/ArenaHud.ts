/**
 * 竞技场 HUD（DOM 叠层，自带样式）：血量/护甲、弹药、金钱、回合计时与比分、存活头像、击杀信息栏（爆头图标）、
 * 雷达、准星（随散布扩张）、命中标记、Tab 计分板、购买菜单、暂停菜单、结算、观战、开镜遮罩、闪白、受击红边、进度条。
 * 所有可点元素拦截 mousedown，避免触发 Game 的 body 指针锁定。
 */
import { t } from '../../i18n'

const CSS = `
.ah{position:fixed;inset:0;pointer-events:none;font-family:"PingFang SC","Microsoft YaHei",system-ui,sans-serif;color:#fff;z-index:40;user-select:none;text-shadow:0 1px 2px rgba(0,0,0,.8)}
.ah *{box-sizing:border-box}
.ah .top{position:absolute;top:10px;left:50%;transform:translateX(-50%);display:flex;align-items:center;gap:10px}
.ah .sc{font:700 26px/1 system-ui;padding:6px 12px;border-radius:6px;background:rgba(0,0,0,.45);min-width:52px;text-align:center}
.ah .sc.t{color:#f0c060}.ah .sc.ct{color:#7fb2ff}
.ah .tm{font:700 24px/1 ui-monospace,Menlo,monospace;padding:7px 14px;background:rgba(0,0,0,.6);border-radius:6px;min-width:90px;text-align:center}
.ah .tm.red{color:#ff5a4a}
.ah .alive{display:flex;gap:3px}.ah .alive i{width:12px;height:22px;border-radius:2px;background:#888;display:block}
.ah .alive.t i.on{background:#e0a640}.ah .alive.ct i.on{background:#5b8fe0}.ah .alive i{opacity:.35}.ah .alive i.on{opacity:1}
.ah .radar{position:absolute;left:14px;top:14px;width:200px;height:200px;border-radius:50%;overflow:hidden;background:rgba(10,14,20,.55);border:2px solid rgba(255,255,255,.25)}
.ah .money{position:absolute;left:18px;top:222px;font:700 22px/1 system-ui;color:#8fe08f}
.ah .zone{position:absolute;left:18px;top:250px;font-size:13px;opacity:.85}
.ah .hp{position:absolute;left:18px;bottom:18px;display:flex;gap:18px;align-items:flex-end;background:rgba(0,0,0,.4);padding:8px 14px;border-radius:8px}
.ah .hp b{font:700 34px/1 system-ui}.ah .hp span{font-size:12px;opacity:.75;margin-left:4px}
.ah .hp .low{color:#ff5a4a}
.ah .ammo{position:absolute;right:18px;bottom:18px;text-align:right;background:rgba(0,0,0,.4);padding:8px 14px;border-radius:8px}
.ah .ammo b{font:700 34px/1 system-ui}.ah .ammo small{font-size:16px;opacity:.75}
.ah .ammo .wn{font-size:13px;opacity:.85}.ah .ammo .nd{font-size:12px;opacity:.7;margin-top:2px}
.ah .feed{position:absolute;right:14px;top:14px;display:flex;flex-direction:column;gap:4px;align-items:flex-end}
.ah .feed div{background:rgba(0,0,0,.55);padding:4px 10px;border-radius:4px;font-size:13px;white-space:nowrap}
.ah .feed div.me{border:1px solid #e04040}
.ah .feed .t{color:#f0c060}.ah .feed .ct{color:#7fb2ff}.ah .feed .w{opacity:.8;margin:0 6px}.ah .feed .hs{color:#ff6060;font-weight:700}
.ah .xh{position:absolute;left:50%;top:50%;width:0;height:0}
.ah .xh i{position:absolute;background:#7cff7c;box-shadow:0 0 1px #000}
.ah .hm{position:absolute;left:50%;top:50%;width:26px;height:26px;margin:-13px 0 0 -13px;opacity:0;transition:opacity .15s}
.ah .hm:before,.ah .hm:after{content:"";position:absolute;left:12px;top:0;width:2px;height:26px;background:#fff;transform:rotate(45deg)}
.ah .hm:after{transform:rotate(-45deg)}.ah .hm.head:before,.ah .hm.head:after{background:#ff4040}
.ah .center{position:absolute;left:50%;top:28%;transform:translateX(-50%);font:700 30px/1.3 system-ui;text-align:center;white-space:pre-line}
.ah .ahint{position:absolute;left:50%;bottom:110px;transform:translateX(-50%);font-size:15px;background:rgba(0,0,0,.45);padding:5px 12px;border-radius:5px;white-space:nowrap}
.ah .prog{position:absolute;left:50%;top:62%;transform:translateX(-50%);width:260px;text-align:center;font-size:14px}
.ah .prog .bar{height:8px;background:rgba(255,255,255,.2);border-radius:4px;margin-top:4px;overflow:hidden}.ah .prog .bar i{display:block;height:100%;background:#f0c060}
.ah .blind{position:absolute;inset:0;background:#fff;opacity:0}
.ah .dmg{position:absolute;inset:0;box-shadow:inset 0 0 120px rgba(255,0,0,.8);opacity:0}
.ah .scope{position:absolute;inset:0;background:radial-gradient(circle at 50% 50%,transparent 0,transparent 36vmin,#000 36.3vmin)}
.ah .scope:before{content:"";position:absolute;left:0;right:0;top:50%;height:1px;background:#000}.ah .scope:after{content:"";position:absolute;top:0;bottom:0;left:50%;width:1px;background:#000}
.ah .spec{position:absolute;left:50%;bottom:70px;transform:translateX(-50%);background:rgba(0,0,0,.55);padding:6px 16px;border-radius:6px;font-size:15px}
.ah .bomb{position:absolute;left:50%;top:56px;transform:translateX(-50%);font:700 14px/1 system-ui;color:#ff5a4a}
.ah .modal{position:absolute;inset:0;background:rgba(6,10,16,.72);display:none;align-items:center;justify-content:center;pointer-events:auto}
.ah .box{background:rgba(20,26,36,.96);border:1px solid rgba(255,255,255,.15);border-radius:10px;padding:18px 22px;min-width:360px;max-width:92vw;max-height:90vh;overflow:auto}
.ah .box h2{margin:0 0 10px;font-size:20px}.ah .box .sub{opacity:.7;font-size:13px;margin-bottom:10px}
.ah .buy{display:grid;grid-template-columns:repeat(5,minmax(130px,1fr));gap:10px}
.ah .buy .col h3{font-size:14px;margin:0 0 6px;opacity:.8}
.ah button{font:inherit;color:#fff;background:#2a3446;border:1px solid rgba(255,255,255,.15);border-radius:6px;padding:7px 10px;cursor:pointer;text-align:left;width:100%;margin-bottom:6px;pointer-events:auto}
.ah button:hover{background:#3a4862}.ah button:disabled{opacity:.35;cursor:default}
.ah button.own{border-color:#6fd16f}
.ah button .p{float:right;color:#8fe08f}
.ah table{border-collapse:collapse;width:100%;font-size:14px}
.ah td,.ah th{padding:4px 8px;text-align:right}.ah td:first-child,.ah th:first-child{text-align:left}
.ah tr.t td{color:#f0c060}.ah tr.ct td{color:#7fb2ff}.ah tr.dead td{opacity:.45}.ah tr.me td{font-weight:700;background:rgba(255,255,255,.06)}
.ah .sb{position:absolute;left:50%;top:12%;transform:translateX(-50%);background:rgba(14,18,26,.9);border-radius:10px;padding:14px 18px;min-width:560px}
.ah .bigbtn{display:inline-block;width:auto;padding:10px 22px;margin:8px 6px 0 0;text-align:center;background:#365a9a}
@media (max-width:700px){.ah .buy{grid-template-columns:repeat(2,1fr)}.ah .sb{min-width:90vw}.ah .radar{width:130px;height:130px}.ah .money{top:150px}.ah .zone{top:176px}}
`

export interface FeedEntry { killer: string; ks: string; victim: string; vs: string; weapon: string; hs: boolean; me: boolean }
export interface ScoreRow { name: string; side: string; k: number; d: number; a: number; hs: number; mvp: number; money: number; alive: boolean; me: boolean; score: number }
export interface BuyItem { id: string; name: string; price: number; owned: boolean; disabled: boolean }
export interface RadarDot { x: number; z: number; kind: 'me' | 'mate' | 'enemy' | 'bomb' | 'dead'; yaw?: number }

export class ArenaHud {
  readonly root: HTMLDivElement
  private style: HTMLStyleElement
  private q = <T extends HTMLElement = HTMLElement>(sel: string) => this.root.querySelector(sel) as T
  private cache = new Map<string, string>()
  private feedEl: HTMLElement
  private radarCv: HTMLCanvasElement
  private radarG: CanvasRenderingContext2D
  private xh: HTMLElement[]
  private centerT = 0
  private hmT = 0
  private dmgA = 0
  buyOpen = false
  pauseOpen = false
  endOpen = false

  constructor() {
    this.style = document.createElement('style'); this.style.textContent = CSS; document.head.appendChild(this.style)
    const r = document.createElement('div'); r.className = 'ah'
    r.innerHTML = `
      <div class="blind"></div><div class="dmg"></div><div class="scope" style="display:none"></div>
      <div class="top"><div class="alive t"></div><div class="sc t">0</div><div class="tm">1:55</div><div class="sc ct">0</div><div class="alive ct"></div></div>
      <div class="bomb" style="display:none">${t('● C4 已安放')}</div>
      <canvas class="radar" width="200" height="200"></canvas>
      <div class="money">$800</div><div class="zone"></div>
      <div class="hp"><div><b class="hpv">100</b><span>${t('生命')}</span></div><div><b class="arv">0</b><span class="arl">${t('护甲')}</span></div></div>
      <div class="ammo"><div class="wn"></div><b class="mag">0</b><small class="res"> / 0</small><div class="nd"></div></div>
      <div class="feed"></div>
      <div class="xh"><i></i><i></i><i></i><i></i></div><div class="hm"></div>
      <div class="center"></div><div class="ahint" style="display:none"></div>
      <div class="prog" style="display:none"><div class="pl"></div><div class="bar"><i></i></div></div>
      <div class="spec" style="display:none"></div>
      <div class="sb" style="display:none"><table></table></div>
      <div class="modal buym"><div class="box"><h2>${t('购买')}</h2><div class="sub"></div><div class="buy"></div><button class="bigbtn closeb">${t('关闭（B / Esc）')}</button></div></div>
      <div class="modal pausem"><div class="box"><h2>${t('暂停')}</h2><div class="sub">${t('比赛已暂停。点击“继续”重新锁定鼠标。')}</div><button class="bigbtn resume">${t('继续')}</button><button class="bigbtn quit" style="background:#8a3030">${t('投降退出')}</button></div></div>
      <div class="modal endm"><div class="box"><h2 class="et"></h2><div class="sub es"></div><table class="etab"></table><div class="ebody" style="margin-top:10px"></div><button class="bigbtn exitb">${t('返回城市')}</button></div></div>`
    for (const m of r.querySelectorAll('.modal')) m.addEventListener('mousedown', (e) => e.stopPropagation())
    document.body.appendChild(r)
    this.root = r
    this.feedEl = this.q('.feed')
    this.radarCv = this.q<HTMLCanvasElement>('.radar')
    this.radarG = this.radarCv.getContext('2d')!
    this.xh = [...this.root.querySelectorAll<HTMLElement>('.xh i')]
    for (const cls of ['t', 'ct']) this.q(`.alive.${cls}`).innerHTML = '<i></i>'.repeat(5)
  }

  private text(sel: string, v: string) { if (this.cache.get(sel) === v) return; this.cache.set(sel, v); this.q(sel).textContent = v }
  private disp(sel: string, on: boolean) { const k = sel + '#d'; const v = on ? '1' : '0'; if (this.cache.get(k) === v) return; this.cache.set(k, v); this.q(sel).style.display = on ? '' : 'none' }

  setTop(tScore: number, ctScore: number, timer: string, red: boolean, tAlive: number, ctAlive: number, tTotal: number, ctTotal: number) {
    this.text('.sc.t', String(tScore)); this.text('.sc.ct', String(ctScore)); this.text('.tm', timer)
    const k = `${red}`; if (this.cache.get('tmr') !== k) { this.cache.set('tmr', k); this.q('.tm').classList.toggle('red', red) }
    const ak = `${tAlive}/${ctAlive}/${tTotal}/${ctTotal}`
    if (this.cache.get('alive') !== ak) {
      this.cache.set('alive', ak)
      const fill = (cls: string, n: number, tot: number) => { const el = this.q(`.alive.${cls}`); el.innerHTML = Array.from({ length: tot }, (_, i) => `<i class="${i < n ? 'on' : ''}"></i>`).join('') }
      fill('t', tAlive, tTotal); fill('ct', ctAlive, ctTotal)
    }
  }
  setVitals(hp: number, armor: number, helmet: boolean, money: number, zone: string) {
    this.text('.hpv', String(Math.max(0, Math.ceil(hp)))); this.text('.arv', String(Math.ceil(armor))); this.text('.arl', helmet ? t('护甲+头盔') : t('护甲'))
    const low = hp <= 25 ? '1' : '0'; if (this.cache.get('low') !== low) { this.cache.set('low', low); this.q('.hpv').classList.toggle('low', hp <= 25) }
    this.text('.money', '$' + money); this.text('.zone', zone)
  }
  setAmmo(name: string, mag: string, res: string, nades: string) { this.text('.wn', name); this.text('.mag', mag); this.text('.res', res); this.text('.nd', nades) }
  setVisibleCore(on: boolean) { for (const s of ['.hp', '.ammo', '.xh']) this.disp(s, on) }
  /** 准星：gap 为像素 */
  crosshair(gap: number, show: boolean) {
    const g = Math.round(gap)
    const k = show ? String(g) : 'off'
    if (this.cache.get('xh') === k) return
    this.cache.set('xh', k)
    const L = 8, W = 2
    const set = (el: HTMLElement, x: number, y: number, w: number, h: number) => { el.style.cssText = `left:${x}px;top:${y}px;width:${w}px;height:${h}px;display:${show ? 'block' : 'none'}` }
    set(this.xh[0], -W / 2, -g - L, W, L); set(this.xh[1], -W / 2, g, W, L); set(this.xh[2], -g - L, -W / 2, L, W); set(this.xh[3], g, -W / 2, L, W)
  }
  hitmarker(head: boolean) { const el = this.q('.hm'); el.classList.toggle('head', head); el.style.opacity = '1'; this.hmT = 0.18 }
  damageFlash(a: number) { this.dmgA = Math.min(1, this.dmgA + a) }
  blind(a: number) { const v = Math.max(0, Math.min(1, a)).toFixed(2); if (this.cache.get('blind') !== v) { this.cache.set('blind', v); this.q('.blind').style.opacity = v } }
  scope(on: boolean) { this.disp('.scope', on) }
  center(msg: string, sec = 2.5) { this.q('.center').textContent = msg; this.centerT = sec }
  hint(msg: string | null) { this.disp('.ahint', !!msg); if (msg) this.text('.ahint', msg) }
  progress(label: string | null, f = 0) {
    this.disp('.prog', label !== null)
    if (label !== null) { this.text('.pl', label); (this.q('.prog .bar i')).style.width = `${Math.round(f * 100)}%` }
  }
  spectate(name: string | null) { this.disp('.spec', !!name); if (name) this.text('.spec', t('观战：{name}（左键切换）', { name })) }
  bomb(text: string | null) { this.disp('.bomb', !!text); if (text) this.text('.bomb', text) }
  feed(e: FeedEntry) {
    const d = document.createElement('div')
    if (e.me) d.className = 'me'
    d.innerHTML = `<span class="${e.ks}"></span><span class="w"></span>${e.hs ? '<span class="hs">⌖</span> ' : ''}<span class="${e.vs}"></span>`
    const sp = d.querySelectorAll('span')
    sp[0].textContent = e.killer; sp[1].textContent = `[${e.weapon}]`; sp[sp.length - 1].textContent = e.victim
    this.feedEl.prepend(d)
    while (this.feedEl.children.length > 6) this.feedEl.lastChild?.remove()
    setTimeout(() => d.remove(), 7000)
  }
  clearFeed() { this.feedEl.innerHTML = '' }

  /** 雷达：以玩家为中心旋转（上 = 玩家朝向） */
  radar(map: HTMLCanvasElement, cx: number, cz: number, yaw: number, dots: RadarDot[]) {
    const g = this.radarG, S = 200, scale = 1.6   // 像素 / 米
    g.clearRect(0, 0, S, S)
    g.save()
    g.translate(S / 2, S / 2)
    g.rotate(yaw)
    // 地图底图：每格 4 px = 2 m → 2 px/m
    const k = scale / 2
    g.globalAlpha = 0.9
    g.drawImage(map, (-cx - 60) * k * 2, (-cz - 60) * k * 2, map.width * k, map.height * k)
    g.globalAlpha = 1
    for (const d of dots) {
      const x = (d.x - cx) * scale, y = (d.z - cz) * scale
      if (d.kind === 'bomb') { g.fillStyle = '#ff3b30'; g.fillRect(x - 4, y - 3, 8, 6); continue }
      if (d.kind === 'dead') { g.strokeStyle = '#ccc'; g.lineWidth = 1.5; g.beginPath(); g.moveTo(x - 3, y - 3); g.lineTo(x + 3, y + 3); g.moveTo(x + 3, y - 3); g.lineTo(x - 3, y + 3); g.stroke(); continue }
      g.fillStyle = d.kind === 'me' ? '#ffffff' : d.kind === 'mate' ? '#5bd1ff' : '#ff4040'
      g.beginPath(); g.arc(x, y, d.kind === 'me' ? 4.5 : 4, 0, Math.PI * 2); g.fill()
      if (d.yaw !== undefined) {
        g.strokeStyle = g.fillStyle as string; g.lineWidth = 2
        g.beginPath(); g.moveTo(x, y); g.lineTo(x - Math.sin(d.yaw) * 9, y - Math.cos(d.yaw) * 9); g.stroke()
      }
    }
    g.restore()
  }

  scoreboard(open: boolean, rows: ScoreRow[], title: string) {
    this.disp('.sb', open)
    if (!open) return
    const tab = this.q('.sb table')
    const head = `<tr><th>${title}</th><th>K</th><th>D</th><th>A</th><th>${t('爆头')}</th><th>MVP</th><th>${t('得分')}</th><th>${t('金钱')}</th></tr>`
    const body = rows.map((r) => `<tr class="${r.side.toLowerCase()} ${r.alive ? '' : 'dead'} ${r.me ? 'me' : ''}"><td></td><td>${r.k}</td><td>${r.d}</td><td>${r.a}</td><td>${r.hs}</td><td>${r.mvp ? '★' + r.mvp : ''}</td><td>${r.score}</td><td>$${r.money}</td></tr>`).join('')
    const html = head + body
    if (this.cache.get('sbh') !== html + rows.map((r) => r.name).join()) {
      this.cache.set('sbh', html + rows.map((r) => r.name).join())
      tab.innerHTML = html
      const tds = tab.querySelectorAll('tr td:first-child')
      rows.forEach((r, i) => { tds[i].textContent = r.name })
    }
  }

  showBuy(open: boolean, groups?: { title: string; items: BuyItem[] }[], money = 0, left = '', onBuy?: (id: string) => void, onClose?: () => void) {
    this.buyOpen = open
    const m = this.q('.buym'); m.style.display = open ? 'flex' : 'none'
    if (!open || !groups) return
    this.q('.buym .sub').textContent = `$${money} · ${left} · ${t('数字键：组号 + 序号（如 3 1 = 第 3 组第 1 个）')}`
    const wrap = this.q('.buym .buy')
    wrap.innerHTML = ''
    groups.forEach((g, gi) => {
      const col = document.createElement('div'); col.className = 'col'
      const h = document.createElement('h3'); h.textContent = `${gi + 1}. ${g.title}`; col.appendChild(h)
      g.items.forEach((it, ii) => {
        const b = document.createElement('button')
        b.disabled = it.disabled
        if (it.owned) b.classList.add('own')
        b.innerHTML = `<span class="p"></span>`
        b.prepend(document.createTextNode(`${ii + 1} ${it.name}`))
        ;(b.querySelector('.p') as HTMLElement).textContent = it.owned ? t('已有') : `$${it.price}`
        b.addEventListener('click', () => onBuy?.(it.id))
        col.appendChild(b)
      })
      wrap.appendChild(col)
    })
    ;(this.q('.buym .closeb') as HTMLButtonElement).onclick = () => onClose?.()
  }
  showPause(open: boolean, onResume?: () => void, onQuit?: () => void) {
    this.pauseOpen = open
    this.q('.pausem').style.display = open ? 'flex' : 'none'
    if (open) { (this.q('.pausem .resume') as HTMLButtonElement).onclick = () => onResume?.(); (this.q('.pausem .quit') as HTMLButtonElement).onclick = () => onQuit?.() }
  }
  showEnd(title: string, sub: string, rows: ScoreRow[], body: string[], onExit: () => void) {
    this.endOpen = true
    this.q('.endm').style.display = 'flex'
    this.q('.endm .et').textContent = title
    this.q('.endm .es').textContent = sub
    const tab = this.q('.endm .etab')
    tab.innerHTML = `<tr><th>${t('选手')}</th><th>K</th><th>D</th><th>A</th><th>${t('爆头')}</th><th>MVP</th><th>${t('得分')}</th></tr>` + rows.map((r) => `<tr class="${r.side.toLowerCase()} ${r.me ? 'me' : ''}"><td></td><td>${r.k}</td><td>${r.d}</td><td>${r.a}</td><td>${r.hs}</td><td>${r.mvp ? '★' + r.mvp : ''}</td><td>${r.score}</td></tr>`).join('')
    tab.querySelectorAll('tr td:first-child').forEach((td, i) => { td.textContent = rows[i].name })
    const b = this.q('.endm .ebody'); b.innerHTML = ''
    for (const line of body) { const d = document.createElement('div'); d.textContent = line; b.appendChild(d) }
    ;(this.q('.endm .exitb') as HTMLButtonElement).onclick = () => onExit()
  }

  update(dt: number) {
    if (this.centerT > 0) { this.centerT -= dt; if (this.centerT <= 0) this.q('.center').textContent = '' }
    if (this.hmT > 0) { this.hmT -= dt; if (this.hmT <= 0) this.q('.hm').style.opacity = '0' }
    if (this.dmgA > 0.001) { this.dmgA = Math.max(0, this.dmgA - dt * 1.8); this.q('.dmg').style.opacity = this.dmgA.toFixed(2) }
  }
  dispose() { this.root.remove(); this.style.remove() }
}
