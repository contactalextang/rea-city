// AI 试玩员 · 执行器：用原生键盘 / 鼠标点击驱动真实页面（对应论文的 human-interface 控制层）。
// 移动只按 WASD / Shift / Space，按 E / F / Tab 交互，面板和手机按钮用鼠标点 DOM；
// 读状态与寻路（路网只读）走 __game。确实没有原生路径时才用「辅助」（调时钟等），每次都记账进报告。
import type { Page } from 'playwright'
import { type Obs, type P2, type Subtask, type ButtonPick, dist } from './schemas.ts'

/* eslint-disable @typescript-eslint/no-explicit-any */
const TAU = Math.PI * 2
const wrap = (a: number) => { a = (a + Math.PI) % TAU; return a < 0 ? a + TAU - Math.PI : a - Math.PI }

/** 步行 8 方向组合键：相对相机朝向的角度（左正右负，同 yaw 约定：增大 = 左转） */
const WALK_DIRS: { ang: number; keys: string[] }[] = [
  { ang: 0, keys: ['KeyW'] }, { ang: Math.PI / 4, keys: ['KeyW', 'KeyA'] }, { ang: Math.PI / 2, keys: ['KeyA'] },
  { ang: (3 * Math.PI) / 4, keys: ['KeyS', 'KeyA'] }, { ang: Math.PI, keys: ['KeyS'] }, { ang: (-3 * Math.PI) / 4, keys: ['KeyS', 'KeyD'] },
  { ang: -Math.PI / 2, keys: ['KeyD'] }, { ang: -Math.PI / 4, keys: ['KeyW', 'KeyD'] },
]

export interface ExecStats { keyPresses: number; clicks: number; assists: string[]; stuck: number }

export class Executor {
  private held = new Set<string>()
  private route: P2[] = []
  private routeFor = ''
  private lastMoveAt = 0
  private lastPos: P2 | null = null
  private relatchAt = 0
  private unstickUntil = 0
  private unstickKeys: string[] = []
  private phase = 0
  /** 一次性动作（按 E / 点按钮 / 开工）上次执行时刻：每个控制周期都会调 tick，动作要防重入（开工按钮再点一次就是「下班」） */
  private actedAt = 0
  /** 驾驶：被前车挡住的起始时刻 / 绕行模式截止时刻 */
  private blockedSince = 0
  private passUntil = 0
  /** 本子任务内的卡住次数（脱困动作按它升级） */
  private stuckHere = 0
  /** 驾驶时最近一次的航向误差（脱困倒车时决定反打方向） */
  private lastErr = 0
  stats: ExecStats = { keyPresses: 0, clicks: 0, assists: [], stuck: 0 }
  /** 游戏一帧的毫秒数（无头渲染可能只有 20 fps）：松键 / 点按至少要跨过两帧游戏才看得到 */
  frameMs = 50

  constructor(private page: Page, private log: (msg: string) => void) {}

  // ---------- 底层输入 ----------
  private async setKeys(want: string[]) {
    const w = new Set(want)
    for (const k of [...this.held]) if (!w.has(k)) { await this.page.keyboard.up(k); this.held.delete(k) }
    for (const k of w) if (!this.held.has(k)) { await this.page.keyboard.down(k); this.held.add(k); this.stats.keyPresses++ }
  }
  async release() { await this.setKeys([]) }
  /** 单击一个键（按住约 90 ms，保证游戏至少有一帧看到边沿） */
  async tap(code: string) {
    await this.page.keyboard.down(code); this.stats.keyPresses++
    await this.page.waitForTimeout(Math.max(90, this.frameMs * 2.5))
    await this.page.keyboard.up(code)
  }
  /** 点第一个可见可用的匹配元素；点不到（淡出中 / 被遮挡）返回 false，不抛异常 */
  private async click(sel: string, hasText?: RegExp): Promise<boolean> {
    const loc = hasText ? this.page.locator(sel, { hasText }) : this.page.locator(sel)
    try {
      const n = await loc.count()
      for (let i = 0; i < n; i++) {
        const b = loc.nth(i)
        if (!(await b.isVisible()) || !(await b.isEnabled())) continue
        await b.click({ timeout: 2000 }); this.stats.clicks++
        return true
      }
    } catch (e) { this.log(`  点击失败 ${sel}：${(e as Error).message.split('\n')[0]}`) }
    return false
  }
  /** 关面板：Esc（游戏原生支持） */
  async closePanel() {
    if (await this.page.evaluate(() => (window as any).__game.state === 'panel')) await this.tap('Escape')
  }
  /** 距上次一次性动作超过 ms 才放行，并记下这次 */
  private gate(ms: number) {
    if (Date.now() - this.actedAt < ms) return false
    this.actedAt = Date.now(); return true
  }
  private assist(what: string) { this.stats.assists.push(what); this.log(`  [辅助] ${what}`) }

  /** 换子任务时清掉执行器内部状态（路线 / 卡住计时） */
  begin(o: Obs) {
    this.route = []; this.routeFor = ''; this.phase = 0; this.actedAt = 0; this.stuckHere = 0; this.blockedSince = 0; this.passUntil = 0
    this.lastPos = o.car ? { x: o.car.x, z: o.car.z } : { x: o.x, z: o.z }
    this.lastMoveAt = Date.now(); this.unstickUntil = 0
  }

  // ---------- 一个控制周期 ----------
  async tick(s: Subtask, o: Obs): Promise<void> {
    if (o.fps > 1) this.frameMs = Math.min(250, 1000 / o.fps)
    switch (s.kind) {
      case 'travel': return s.mode === 'walk' ? this.walk(s.to, o) : this.drive(s.to, o, s.radius, s.exact, s.offset)
      case 'interact': return this.interact(s.pick, o)
      case 'mrt': return this.mrt(s.to, o)
      case 'phoneJob': return this.phoneJob(s.job, s.title, o, s.stop)
      case 'phoneInvest': return this.phoneInvest(s.amount, o)
      case 'board': await this.setKeys(['Space']); if (this.gate(1500)) await this.tap('KeyF'); return
      case 'exitCar': await this.setKeys([]); if (this.gate(1500)) await this.tap('KeyF'); return
      case 'stop': return this.setKeys((o.car?.speed ?? 0) > 0.6 ? ['Space'] : [])
      case 'waitNeeds': return this.waitFast(o)
      case 'waitHour': return this.waitHour(s.hour, o)
    }
  }

  /** 当前路线剩余长度（从 here 沿路点累加）；没有路线时 0 */
  routeRemaining(here: P2): number {
    let s = 0, p = here
    for (const q of this.route) { s += dist(p, q); p = q }
    return s
  }

  // ---------- 寻路：沿路网走，能直线看见的路点就抄近路 ----------
  private async ensureRoute(from: P2, to: P2, lane: boolean) {
    const key = `${to.x.toFixed(1)},${to.z.toFixed(1)},${lane}`
    if (this.routeFor === key && this.route.length) return
    this.routeFor = key
    this.route = await this.page.evaluate(({ from, to, lane }) => {
      const G = (window as any).__game, g = G.graph
      const out: { x: number; z: number }[] = []
      const tmp = { x: 0, z: 0 }
      // 驾驶终点：目标最近车道边 fl；路线开到 fl 的起点节点，再沿 fl 开到投影点（取最近节点会开过头、停在门口 8 m 外）
      const fl = g.nearestLane(to.x, to.z, 0, 0)
      const tn = lane ? fl.edge.from : g.nearestNode(to.x, to.z)
      const push = (x: number, z: number) => { if (!G.inside(x, z)) out.push({ x, z }) }
      if (lane) {
        // 驾驶：有向路网（遵守单行），走到重复的边就停（目标不可达时 nextTowards 会随机绕圈）
        const st = g.nearestLane(from.x, from.z, 0, 0)
        let e = st.edge, t0 = st.t
        const seen = new Set<number>()
        for (let i = 0; i < 600 && e && !seen.has(e.id); i++) {
          // 到了终点车道边且投影点还在前方：只开到投影点
          const last = e === fl.edge && t0 <= fl.t
          if (!last) seen.add(e.id)
          const end = last ? fl.t : e.length
          for (let tt = Math.max(t0 + 4, 0); tt < end; tt += 8) { g.lanePoint(e, tt, tmp); out.push({ x: tmp.x, z: tmp.z }) }
          if (last) break
          // 下一个节点就是终点边的起点：直接接上终点边
          e = e.to === tn ? fl.edge : g.nextTowards(e, tn); t0 = 0
        }
      } else {
        // 步行：无向 Dijkstra（人不管单行道），路点取路段折线上偏到人行道一侧的点，落在楼里的丢掉
        // 路段可能很长（几百米）：起点 / 终点都落在「所在路段」上，从该路段两端出发 / 到达，代价按沿路段的弧长算
        void tn
        const N = g.nodes.length, d = new Float64Array(N).fill(Infinity), via: any[] = new Array(N).fill(null), done = new Uint8Array(N)
        const adj: any[][] = Array.from({ length: N }, () => [])
        for (const e of g.edges) { adj[e.from.id].push({ e, to: e.to.id, rev: false }); adj[e.to.id].push({ e, to: e.from.id, rev: true }) }
        const sl = g.nearestLane(from.x, from.z, 0, 0), tl = g.nearestLane(to.x, to.z, 0, 0)
        /** 沿路段 e 从弧长 a 走到 b，每 8 m 一个人行道点 */
        const along = (e: any, a: number, b: number) => {
          const n = Math.max(1, Math.ceil(Math.abs(b - a) / 8))
          for (let k = 1; k <= n; k++) { g.sidewalkPoint(e, a + (b - a) * (k / n), tmp); push(tmp.x, tmp.z) }
        }
        if (sl.edge === tl.edge || sl.edge === tl.edge.reverse) {
          along(sl.edge, sl.t, sl.edge === tl.edge ? tl.t : sl.edge.length - tl.t)
        } else {
          d[sl.edge.from.id] = sl.t; d[sl.edge.to.id] = Math.min(d[sl.edge.to.id], sl.edge.length - sl.t)
          const startNode = new Map<number, number>([[sl.edge.from.id, 0], [sl.edge.to.id, sl.edge.length]])
          for (let it = 0; it < N; it++) {
            let u = -1, best = Infinity
            for (let i = 0; i < N; i++) if (!done[i] && d[i] < best) { best = d[i]; u = i }
            if (u < 0) break
            done[u] = 1
            if (done[tl.edge.from.id] && done[tl.edge.to.id]) break
            for (const a of adj[u]) { const nd = d[u] + a.e.length; if (nd < d[a.to]) { d[a.to] = nd; via[a.to] = { from: u, e: a.e, rev: a.rev } } }
          }
          // 终点从目标路段哪一端进更近
          const endFrom = d[tl.edge.from.id] + tl.t, endTo = d[tl.edge.to.id] + (tl.edge.length - tl.t)
          const endNode = endFrom <= endTo ? tl.edge.from.id : tl.edge.to.id
          const legs: any[] = []
          let v = endNode
          for (; via[v]; v = via[v].from) legs.unshift(via[v])
          along(sl.edge, sl.t, startNode.get(v) ?? 0)
          for (const l of legs) along(l.e, l.rev ? l.e.length : 0, l.rev ? 0 : l.e.length)
          along(tl.edge, endNode === tl.edge.from.id ? 0 : tl.edge.length, tl.t)
        }
      }
      if (lane) {
        // 驾驶终点投影到最近车道上（目标常在人行道 / 门口，直奔过去会冲上人行道撞楼）
        g.lanePoint(fl.edge, fl.t, tmp)
        out.push({ x: tmp.x, z: tmp.z })
      } else out.push({ x: to.x, z: to.z })
      return out
    }, { from, to, lane })
  }

  /** 从当前位置看，路线上最远的一个「直线可达」路点（中间没有楼）；用来抄近路 */
  private async lookahead(from: P2, maxAhead: number): Promise<number> {
    const cand = this.route.slice(0, maxAhead)
    // 只看 40 m 内（contains 只认已加载区块，远处一律「空」）；按人身宽检查一条 ±0.7 m 的走廊，不是一根线
    return this.page.evaluate(({ from, cand }) => {
      const g = (window as any).__game
      let best = 0
      for (let i = 0; i < cand.length; i++) {
        const p = cand[i], d = Math.hypot(p.x - from.x, p.z - from.z)
        if (d > 40) break
        const n = Math.ceil(d / 1.0), ux = (p.x - from.x) / (d || 1), uz = (p.z - from.z) / (d || 1)
        let clear = true
        for (let k = 1; k <= n && clear; k++) {
          const f = k / n, cx = from.x + (p.x - from.x) * f, cz = from.z + (p.z - from.z) * f
          for (const o of [0, 0.7, -0.7]) if (g.inside(cx - uz * o, cz + ux * o)) { clear = false; break }
        }
        if (clear) best = i
      }
      return best
    }, { from, cand })
  }

  private async walk(to: P2, o: Obs) {
    if (o.state !== 'play') { await this.release(); return }
    const here = { x: o.x, z: o.z }
    if (this.unstickUntil > Date.now()) { await this.setKeys(this.unstickKeys); return }
    await this.ensureRoute(here, to, false)
    // 已经走过的路点丢掉
    while (this.route.length > 1 && dist(here, this.route[0]) < 2.5) this.route.shift()
    const k = await this.lookahead(here, 8)
    if (k > 0) this.route.splice(0, k)
    const wp = this.route[0] ?? to
    const want = Math.atan2(wp.x - here.x, wp.z - here.z)
    const rel = wrap(want - o.camYaw)
    let bi = 0, bd = Infinity
    for (let i = 0; i < WALK_DIRS.length; i++) { const d = Math.abs(wrap(rel - WALK_DIRS[i].ang)); if (d < bd) { bd = d; bi = i } }
    const keys = [...WALK_DIRS[bi].keys]
    if (dist(here, to) > 6) keys.push('ShiftLeft')
    // 同一组合键会一直沿按下那刻的相机朝向走：偏差大时松开一帧重新锁定（相机此时已跟上人物朝向）
    if (this.sameKeys(keys) && bd > 0.2 && Date.now() - this.relatchAt > 400) {
      await this.release(); await this.page.waitForTimeout(this.frameMs * 2.5); this.relatchAt = Date.now()
    }
    await this.setKeys(keys)
    await this.checkStuck(here, o, false)
  }

  private sameKeys(keys: string[]) { return keys.length === this.held.size && keys.every((k) => this.held.has(k)) }

  /** 2.5 s 位移不到 1 m 算卡住：脱困动作逐级升级（步行：横移跳 → 后退 → 另一侧横移跳 → 斜后退；驾驶：倒车左右交替） */
  private async checkStuck(here: P2, o: Obs, car: boolean) {
    const now = Date.now()
    if (!this.lastPos || dist(here, this.lastPos) > 1) { this.lastPos = here; this.lastMoveAt = now; return }
    if (now - this.lastMoveAt < 2500) return
    this.stats.stuck++
    const n = this.stuckHere++
    this.lastMoveAt = now
    const WALK = [['KeyA', 'Space'], ['KeyS'], ['KeyD', 'Space'], ['KeyS', 'KeyA'], ['KeyS', 'KeyD']]
    // 倒车时方向盘反打车头才转向目标：要左转（err > 0）就倒车按 D；每第三次直倒，先离开墙面
    this.unstickKeys = car ? (n % 3 === 2 ? ['KeyS'] : ['KeyS', this.lastErr > 0 ? 'KeyD' : 'KeyA']) : WALK[n % WALK.length]
    this.unstickUntil = now + (car ? 1800 + 400 * Math.min(n, 4) : n % 2 ? 1000 : 700)
    this.route = []; this.routeFor = ''
    this.log(`  卡住 #${n + 1}（${here.x.toFixed(0)},${here.z.toFixed(0)}）→ ${this.unstickKeys.join('+')} · 状态 ${o.state}`)
  }

  // ---------- 驾驶：纯追踪，A/D 方向（bang-bang + 死区），W/Space 控速 ----------
  private async drive(to: P2, o: Obs, radius: number, exact = false, offset = 1.8) {
    const c = o.car
    if (!c || o.state !== 'play') { await this.release(); return }
    const here = { x: c.x, z: c.z }
    if (this.unstickUntil > Date.now()) {
      // 脱困倒车：车尾 6 m 内有行人就先停（倒车撞人照样出警）
      const behind = await this.page.evaluate(({ x, z, yaw }) => {
        const fx = Math.sin(yaw), fz = Math.cos(yaw)
        return (window as any).__game.peds.some((p: any) => { const dx = p.x - x, dz = p.z - z, f = dx * fx + dz * fz; return f < -1 && f > -7 && Math.abs(dx * fz - dz * fx) < 2.2 })
      }, { x: c.x, z: c.z, yaw: c.yaw })
      await this.setKeys(behind && this.unstickKeys.includes('KeyS') ? ['Space'] : this.unstickKeys)
      return
    }
    if (exact) {
      // 靠边：瞄准目标往车道方向偏 offset m 的点（上客 1.8 m 车身贴着乘客；送客取车道点本身），不走路网
      const key = `exact:${to.x.toFixed(1)},${to.z.toFixed(1)},${offset}`
      if (this.routeFor !== key) {
        this.routeFor = key
        const lp = await this.page.evaluate(({ x, z }) => { const G = (window as any).__game, n = G.graph.nearestLane(x, z, 0, 0), p = { x: 0, z: 0 }; G.graph.lanePoint(n.edge, n.t, p); return p }, to)
        const d = Math.hypot(lp.x - to.x, lp.z - to.z) || 1, k = Math.min(offset, d) / d
        this.route = [{ x: to.x + (lp.x - to.x) * k, z: to.z + (lp.z - to.z) * k }]
      }
    } else await this.ensureRoute(here, to, true)
    // 追踪点：前方 5–9 m（看太远转弯会切角撞路边的雨棚 / 有盖走廊）
    const look = Math.max(5, Math.min(9, 3.5 + c.speed * 0.6))
    while (this.route.length > 1 && dist(here, this.route[0]) < look) this.route.shift()
    let wp = this.route[0] ?? to
    const passing = this.passUntil > Date.now()
    // 绕行：追踪点往右偏 3.5 m（靠左行驶，从右侧超车）
    if (passing) wp = { x: wp.x - Math.cos(c.yaw) * 3.5, z: wp.z + Math.sin(c.yaw) * 3.5 }
    const want = Math.atan2(wp.x - here.x, wp.z - here.z)
    const err = wrap(want - c.yaw)
    this.lastErr = err
    const end = this.route[this.route.length - 1] ?? to
    const dEnd = Math.min(dist(here, to), dist(here, end))
    let vMax = Math.abs(err) > 0.6 ? 3 : Math.abs(err) > 0.25 ? 5 : 8
    // 刚脱困：5 s 内慢开，别再全速顶回同一处
    if (Date.now() - this.unstickUntil < 5000) vMax = Math.min(vMax, 3)
    if (dEnd < 40) vMax = Math.min(vMax, Math.max(2, dEnd / 5))
    if (dEnd < radius || dist(here, end) < 2) vMax = 0
    // 前车：车头方向 16 m 内、横向 2.2 m 内有车 → 按距离限速，6 m 内停
    // 红绿灯：所在车道边通向信号路口时，算到停止线（边长 − 路口半径）的距离和相位
    // 行人：车头 14 m 内、横向 2.4 m 内（绕行时看宽到 4.5 m）有人 → 同样按距离限速（撞人直接出警被捕）
    const { ahead, ped, stopD, phase, blocker } = await this.page.evaluate(({ x, z, yaw, wide }) => {
      const G = (window as any).__game, fx = Math.sin(yaw), fz = Math.cos(yaw)
      let m = Infinity, ped = Infinity, blocker = ''
      // 对方车身沿纵轴取 5 个点（公交 12 m 长、路口横穿的车，只看中心点会漏）
      for (const v of G.cars) {
        if (v.driver === 'player') continue
        const h = v.kind === 'bus' ? 6 : 2.3, vx = Math.sin(v.yaw), vz = Math.cos(v.yaw)
        for (let k = -1; k <= 1; k += 0.5) {
          const dx = v.x + vx * h * k - x, dz = v.z + vz * h * k - z, f = dx * fx + dz * fz, l = Math.abs(dx * fz - dz * fx)
          if (f > 1 && f < 16 && l < 2.2 && f < m) { m = f; blocker = `${v.kind}/${v.driver} v=${v.speed} stuck=${v.stuck}${v.wrecked ? ' 报废' : ''}${v.dbg ? ' ' + v.dbg : ''}` }
        }
      }
      for (const p of G.peds) {
        if (p.state === 'hail') continue   // 招手乘客不会被车撞倒（游戏里 hail 豁免碰撞），靠边上客时别把自己挡住
        const dx = p.x - x, dz = p.z - z, f = dx * fx + dz * fz, l = Math.abs(dx * fz - dz * fx)
        if (f > 0.5 && f < 14 && l < (wide ? 4.5 : 2.4)) ped = Math.min(ped, f)
      }
      const ln = G.graph.nearestLane(x, z, fx, fz), e = ln.edge
      if (ln.dist > 8 || !e.to.signal) return { ahead: m, ped, stopD: Infinity, phase: 'green', blocker }
      return { ahead: m, ped, stopD: e.length - e.to.jr - ln.t, phase: G.signals.phaseFor(e.id) as string, blocker }
    }, { x: c.x, z: c.z, yaw: c.yaw, wide: passing })
    // 行人在前：4 m 内停，否则按距离限速（行人让开后自然恢复）；不算堵死
    if (ped < 14) vMax = Math.min(vMax, Math.max(0, (ped - 4) / 2.5))
    // 红灯 / 来不及刹住之外的黄灯：停止线前 2 m 停下；已越线（stopD < 0）或黄灯刹不住就通过
    const brakeD = c.speed * c.speed / 6 + 1
    const mustStop = stopD > -0.5 && stopD < 40 && (phase === 'red' || (phase === 'amber' && stopD > brakeD))
    if (mustStop) {
      vMax = Math.min(vMax, Math.max(0, (stopD - 2) / 2.5))
      if (stopD < 4 && c.speed < 1.5) vMax = 0
    }
    // 前方路口红 / 黄灯且停止线不远：前车多半在排队等灯，跟着等，不绕行（绕到队伍旁边会闯红灯、蹭车）
    const queued = phase !== 'green' && stopD > -0.5 && stopD < 150
    if (passing && !mustStop) vMax = Math.min(vMax, 4)
    else if (ahead < 16) {
      vMax = Math.min(vMax, Math.max(0, (ahead - 6) / 2))
      // 停在前车后面超过 12 s（堵死 / 停着的车）→ 绕行 4 s；正常排队跟车不绕（绕行是擦碰报废的主因）
      if (c.speed < 0.5) {
        if (!this.blockedSince) this.blockedSince = Date.now()
        else if (queued) this.blockedSince = Date.now()
        else if (Date.now() - this.blockedSince > 12000) {
          this.passUntil = Date.now() + 4000; this.blockedSince = 0
          this.log(`  前车挡路 12 s（${ahead.toFixed(1)} m · ${blocker}）→ 从右侧绕行`)
        }
      } else this.blockedSince = 0
    } else this.blockedSince = 0
    // 等红灯时前车不动是正常的，不算堵死
    if (mustStop) { this.blockedSince = 0; this.passUntil = 0 }
    const keys: string[] = []
    if (c.speed < vMax - 0.5) keys.push('KeyW')
    else if (c.speed > vMax + 1) keys.push('Space')
    await this.setKeys(keys)
    // 比例转向：本周期内按住 A/D 的时间占比 ∝ 航向误差（键盘只有开关，靠占空比做出「半打方向」）
    const duty = Math.min(1, Math.abs(err) / 0.35)
    if (duty > 0.12 && c.speed > 0.3) {
      const k = err > 0 ? 'KeyA' : 'KeyD'
      await this.page.keyboard.down(k); this.stats.keyPresses++
      await this.page.waitForTimeout(Math.max(this.frameMs, duty * 90))
      if (duty < 1) await this.page.keyboard.up(k)
      else this.held.add(k)
    }
    if (vMax > 0 && !mustStop && ped >= 14 && (ahead >= 16 || passing)) await this.checkStuck(here, o, true)
    else { this.lastPos = here; this.lastMoveAt = Date.now() }
  }

  // ---------- 门口按 E + 点面板按钮 ----------
  private async interact(pick: ButtonPick[], o: Obs) {
    await this.release()
    if (o.state === 'play') { if (this.gate(2500)) { await this.tap('KeyE'); await this.page.waitForTimeout(250) } return }
    if (o.state !== 'panel') return
    this.actedAt = Date.now()
    for (const p of pick) {
      const ok = await this.page.evaluate(({ label, note }) => {
        const bs = [...document.querySelectorAll<HTMLButtonElement>('button.pbtn')]
        const lr = label ? new RegExp(label) : null, nr = note ? new RegExp(note) : null
        const b = bs.find((x) => !x.disabled && (!lr || lr.test(x.firstElementChild?.textContent ?? '')) && (!nr || nr.test(x.querySelector('.note')?.textContent ?? '')))
        if (!b) return -1
        return Number(b.dataset.index)
      }, p)
      if (ok >= 0) {
        if (!(await this.click(`button.pbtn[data-index="${ok}"]`))) return
        this.log(`  点面板按钮 #${ok}`)
        await this.page.waitForTimeout(300)
        // 吃饭等按钮点完面板不关：Esc 回到游戏
        await this.closePanel()
        return
      }
    }
    // 没有可点的按钮：记下来并离开，交给 harness 判失败 / 重规划
    const labels = o.panel.labels.join(' | ')
    this.log(`  面板里没有匹配按钮：${labels}`)
    await this.closePanel()
  }

  private async mrt(toId: string, o: Obs) {
    await this.release()
    if (o.state === 'play') { if (this.gate(2500)) { await this.tap('KeyE'); await this.page.waitForTimeout(250) } return }
    if (o.state !== 'panel') return
    this.actedAt = Date.now()
    const name = await this.page.evaluate((id) => (window as any).__game.pois.list().find((p: any) => p.id === id)?.name ?? '', toId)
    const esc = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    if (!(await this.click('button.pbtn', new RegExp(`→ ${esc}`)))) { this.log(`  地铁面板里没有「${name}」`); await this.closePanel() }
    await this.page.waitForTimeout(300)
  }

  // ---------- 手机 ----------
  /** 打开手机某个子页（应用按钮是开关：已在该页时不再点） */
  private async openPhoneApp(app: string, _o?: Obs) {
    const ph = () => this.page.evaluate(() => { const p = (window as any).__game.phone; return { open: !!p.open, sub: p.sub ?? null } })
    if (!(await ph()).open) { await this.tap('Tab'); await this.page.waitForTimeout(200) }
    if ((await ph()).sub !== app) { await this.click(`.phone .apps button[data-app="${app}"]`); await this.page.waitForTimeout(200) }
  }
  private async closePhone() {
    if (await this.page.evaluate(() => (window as any).__game.phone.open)) await this.tap('Tab')
  }
  private async phoneJob(job: string, title: string, o: Obs, stop = false) {
    await this.release()
    if (stop ? o.job.active !== job : o.job.active === job) return
    if (o.inVehicle && o.car && o.car.speed > 0.5) { await this.setKeys(['Space']); return }
    if (!this.gate(3000)) return
    await this.openPhoneApp('work', o)
    // 工作页会随状态整页重绘：每次现找卡片，不在 DOM 上做标记
    const card = this.page.locator('#phone-work .job').filter({ has: this.page.locator('.jt span', { hasText: new RegExp(`^${title}$`) }) }).first()
    const btn = card.locator('.jt button')
    if (!(await btn.count())) { this.log(`  工作页里没有「${title}」`); await this.closePhone(); return }
    if (!stop && !(await btn.isEnabled())) { this.log(`  不能开工「${title}」：${await card.locator('.js').textContent().catch(() => '按钮不可用')}`); await this.closePhone(); return }
    await btn.click({ timeout: 2000 }); this.stats.clicks++
    await this.page.waitForTimeout(200)
    await this.closePhone()
  }
  private async phoneInvest(amount: number, o: Obs) {
    await this.release()
    if (!this.gate(4000)) return
    await this.openPhoneApp('work', o)
    if (!(await this.click(`#phone-work button[data-buy$=":${amount}"]`))) this.log(`  工作页里没有「买 $${amount}」按钮`)
    await this.page.waitForTimeout(200)
    await this.closePhone()
  }

  // ---------- 等待：手机设置里开 4× 时间流速（原生）；还要等太久就跳时钟（辅助） ----------
  private async waitFast(o: Obs) {
    await this.release()
    if (this.phase === 0) {
      this.phase = 1
      await this.openPhoneApp('settings', o)
      await this.click('.phone button[data-speed="4"]')
      await this.closePhone()
      // 4× 时每游戏小时 45 s；精力 4/小时。要等超过约 2 分钟就直接跳
      const hours = Math.max(0, (o.energy - 70) / 4) + 0.3
      if (hours * 45 > 120) {
        this.assist(`时钟快进 ${hours.toFixed(1)} 小时（等精力降到 70）`)
        await this.page.evaluate((h) => (window as any).__game.clock.skip(h), hours)
      }
    }
    await this.page.waitForTimeout(500)
  }
  private async waitHour(hour: number, o: Obs) {
    await this.release()
    if (this.phase === 0) {
      this.phase = 1
      const h = (hour - o.hour + 24) % 24
      this.assist(`时钟快进 ${h.toFixed(1)} 小时（等到 ${hour} 点）`)
      await this.page.evaluate((h) => (window as any).__game.clock.skip(h), h)
    }
    await this.page.waitForTimeout(300)
  }
  /** 子任务结束后恢复 1× 时间流速 */
  async restoreSpeed() {
    const sp = await this.page.evaluate(() => (window as any).__game.clock.speed)
    if (sp === 1) return
    await this.openPhoneApp('settings')
    await this.click('.phone button[data-speed="1"]')
    await this.closePhone()
  }
}
