import type { Game } from '../../core/Game'
import type { Ctx } from '../../core/Context'
import type { Vehicle } from '../../entities/Vehicle'
import { releaseToken } from '../../entities/TrafficAI'
import { lineClear } from '../../entities/PoliceAI'
import { Marker, TARGET_COLOR } from '../../world/Marker'
import { earn } from '../../systems/Wallet'
import { RIVALS, PRIZE_POOL_SHARE, PRIZE_FIXED_SHARE, betOdds, type RaceRouteDef } from '../../data/races'
import { pointAt, project, vmaxAt, type BuiltRoute } from './Route'
import { makeRacer, driveAI, resetOnRoute, type Racer } from './RaceAI'

export type RaceMode = 'street' | 'legal'
export interface RaceOptions { mode: RaceMode; rent: boolean; bet: number }
export type Phase = 'grid' | 'countdown' | 'race' | 'done'

/** 比赛结果（结算面板 / 存档 / 调试） */
export interface RaceResult {
  route: string; mode: RaceMode; place: number; prize: number; betWon: number
  time: number; aborted: boolean; reason?: string
  standings: { name: string; place: number; time: number | null; progress: number }[]
}

const GRID_T = 2, COUNT_T = 3
/** 离开赛车多少秒判弃赛 */
export const OUT_OF_CAR_LIMIT = 15
/** 完赛后 AI 继续跑完的最长时间 */
const COOLDOWN_T = 150
const SPOT_DIST = 60
/** 比赛车（AI 与玩家参赛车）的伤害倍率（Vehicle.damageMul） */
export const RACE_DAMAGE_MUL = 0.3
const P = { x: 0, z: 0, dx: 0, dz: 0, hw: 0 }
const fmt = (t: number) => { const m = Math.floor(t / 60), s = t - m * 60; return `${m}:${s.toFixed(1).padStart(4, '0')}` }
export const fmtTime = fmt

/** 走廊哈希：赛道点所在 16 m 格（含邻格）→ 点索引（交通清场判定用） */
function corridor(route: BuiltRoute) {
  const C = 16, map = new Map<number, number[]>()
  const key = (cx: number, cz: number) => (cx + 4096) * 8192 + (cz + 4096)
  route.pts.forEach((p, i) => {
    const cx = Math.floor(p.x / C), cz = Math.floor(p.z / C)
    for (let a = -1; a <= 1; a++) for (let b = -1; b <= 1; b++) {
      const k = key(cx + a, cz + b); let l = map.get(k); if (!l) { l = []; map.set(k, l) }
      l.push(i)
    }
  })
  return (x: number, z: number, r: number) => {
    const l = map.get(key(Math.floor(x / C), Math.floor(z / C))); if (!l) return false
    for (const i of l) { const p = route.pts[i]; if (Math.hypot(p.x - x, p.z - z) < r + p.hw) return true }
    return false
  }
}

/**
 * 一场比赛：起跑格 → 倒计时 3-2-1-GO（锁车）→ 检查点链 → 玩家完赛结算（AI 继续跑完，冷却后回收）。
 * 玩家离开赛车 15 s / 被捕 / 倒下 / 手动退出 → 弃赛（place 0）。
 */
export class RaceSession {
  phase: Phase = 'grid'
  phaseT = 0
  /** GO 之后的比赛用时 */
  raceT = 0
  racers: Racer[] = []
  player: Racer
  rental: Vehicle | null = null
  patrol: Vehicle | null = null
  outT = 0
  spotted = false
  finishedPlace = 0
  result: RaceResult | null = null
  ticketsAtStart: number
  readonly entry: number
  readonly prizeBase: number
  readonly odds: number
  private marker = new Marker(TARGET_COLOR)
  private preview = new Marker(0xffa8f0)
  private cullTimer = 0
  private inCorridor: (x: number, z: number, r: number) => boolean
  private slots: { s: number; lat: number }[] = []
  private aiCars: Vehicle[] = []
  private trafficCulled = 0
  private lastToastN = -1

  constructor(private game: Game, readonly route: BuiltRoute, readonly opts: RaceOptions, readonly car: Vehicle, aiCars: Vehicle[], rental: Vehicle | null) {
    const def = route.def
    this.entry = opts.mode === 'legal' ? def.legal?.entry ?? def.entry : def.entry
    this.prizeBase = opts.mode === 'legal' ? def.legal?.prize ?? def.prize : def.prize
    this.odds = betOdds(def)
    this.rental = rental
    this.aiCars = aiCars
    this.inCorridor = corridor(route)
    this.ticketsAtStart = game.law.fines
    this.preview.group.scale.setScalar(0.55)
    game.scene.add(this.marker.group, this.preview.group)

    // 起跑格：两排两列（loop 在起终点线后，sprint 在起点后）；最强 AI 杆位，玩家前排右
    const L = route.length
    const rows = route.loop ? [-7, -15] : [14, 6]
    pointAt(route, rows[0], P)
    const lat = Math.min(2.4, Math.max(1.3, P.hw))
    this.slots = [{ s: rows[0], lat: -lat }, { s: rows[0], lat }, { s: rows[1], lat: -lat }, { s: rows[1], lat }]
    this.player = makeRacer('你', '', true, 1)
    this.player.v = car
    const order = [2, 1, 0]   // AI 难度索引 → 槽位 0 / 2 / 3
    const aiSlots = [0, 2, 3]
    const racersAI = order.map((ri, k) => {
      const rv = RIVALS[ri]
      const r = makeRacer(rv.name, rv.tag, false, def.ai[ri])
      r.v = aiCars[ri]
      r.prefOffset = this.slots[aiSlots[k]].lat * 0.4
      return { r, slot: aiSlots[k] }
    })
    this.racers = [this.player, ...racersAI.map((x) => x.r)]
    const all: [Racer, number][] = [[this.player, 1], ...racersAI.map((x) => [x.r, x.slot] as [Racer, number])]
    for (const [r, si] of all) {
      const sl = this.slots[si]
      r.s = route.loop ? ((sl.s % L) + L) % L : sl.s
      r.lap = route.loop && sl.s < 0 ? -1 : 0
      r.progress = sl.s
      r.idx = project(route, ...this.slotXZ(si), -1).idx
      r.offset = sl.lat
    }
    this.placeAll()
    // 赛车加固：比赛期间玩家这辆车也按 0.3 倍吃伤害（与 AI 赛车一致），结束时还原
    this.prevDamageMul = car.damageMul
    car.damageMul = RACE_DAMAGE_MUL
    game.law.trafficExempt = true
    // 街头赛：非黑帮身份在路线中段放一辆巡逻警车（被它近距离看到 → 1 星通缉）
    if (opts.mode === 'street' && game.ctx.role.id !== 'gang') this.placePatrol()
    game.hud.toast(`${def.name} · ${opts.mode === 'legal' ? '合法赛道日（封路）' : '街头赛'} · 就位`, 2)
  }

  get ctx(): Ctx { return this.game.ctx }
  get def(): RaceRouteDef { return this.route.def }
  /** 检查点总数（所有圈） */
  get totalCps() { return this.route.cps.length * this.def.laps }
  get raceLength() { return this.route.loop ? this.route.length * this.def.laps : this.route.length }
  /** 全局检查点序号 → 总路程 */
  cpProgress(k: number) {
    const M = this.route.cps.length
    return this.route.loop ? Math.floor(k / M) * this.route.length + this.route.cps[k % M] : this.route.cps[k]
  }
  cpLocal(k: number) { return this.route.cps[k % this.route.cps.length] }

  private slotXZ(i: number): [number, number] {
    const sl = this.slots[i]
    pointAt(this.route, sl.s, P)
    return [P.x - P.dz * sl.lat, P.z + P.dx * sl.lat]
  }
  /** 起跑格锁车：每帧把四辆车按回格子、速度清零 */
  private placeAll() {
    const all: [Racer, number][] = [[this.player, 1], [this.racers[1], 0], [this.racers[2], 2], [this.racers[3], 3]]
    for (const [r, si] of all) {
      const v = r.v; if (!v) continue
      if (r.isPlayer && this.ctx.player.vehicle !== v) continue
      const [x, z] = this.slotXZ(si)
      pointAt(this.route, this.slots[si].s, P)
      v.x = x; v.z = z; v.yaw = Math.atan2(P.dx, P.dz); v.vx = v.vz = 0
      v.controls.throttle = 0; v.controls.handbrake = true
    }
  }

  private placePatrol() {
    const M = this.route.cps.length
    const k = Math.max(2, Math.floor(M * (0.35 + Math.random() * 0.3)))
    pointAt(this.route, this.route.cps[k] - 20, P)
    const g = this.game
    // 自己的一辆警车（不进 Spawner 警车池，免得离玩家远时被回收）：停在赛道右缘，不开警灯
    const lat = P.hw + 2.2   // 停在路缘外侧，少挡赛车线
    const v = g.spawner.spawnOwned(g.ctx, 'race_patrol', P.x - P.dz * lat, P.z + P.dx * lat, Math.atan2(P.dx, P.dz), { kind: 'police', color: 0xf4f4f4, model: 'sedan' })
    v.driver = 'none'; v.controls.handbrake = true
    this.patrol = v
  }

  /** 每帧（世界运行时） */
  update(dt: number) {
    const ctx = this.ctx
    this.phaseT += dt
    if (this.phase === 'grid' || this.phase === 'countdown') {
      this.placeAll()
      if (this.phase === 'grid' && this.phaseT >= GRID_T) { this.phase = 'countdown'; this.phaseT = 0 }
      if (this.phase === 'countdown') {
        const n = Math.ceil(COUNT_T - this.phaseT)
        if (n !== this.lastToastN && n > 0) { this.lastToastN = n; this.game.hud.toast(String(n), 0.9) }
        if (this.phaseT >= COUNT_T) {
          this.phase = 'race'; this.phaseT = 0; this.raceT = 0
          this.game.hud.toast('GO!', 1.2)
          for (const r of this.racers) { if (r.v) r.v.controls.handbrake = false; r.winT = 0; r.winP = r.progress }
        }
      }
      this.updateMarkers()
      this.cullTraffic(dt)
      return
    }
    this.raceT += dt
    this.cullTraffic(dt)
    // ---- 玩家 ----
    if (this.phase === 'race') this.updatePlayer(dt)
    // ---- AI ----
    for (const r of this.racers) {
      if (r.isPlayer || r.dnf) continue
      const v = r.v!
      if (!v.active || v.wrecked || v.driver === 'player') { r.dnf = true; continue }
      this.track(r, ctx, dt)
      // 赛车加固：未报废时缓慢回血（2/s），长距离比赛里蹭墙 / 互撞不会累计到报废
      if (v.health < 100) v.health = Math.min(100, v.health + 2 * dt)
      if (!r.finished && this.raceT >= (r.trace.length) * 5) r.trace.push([+this.raceT.toFixed(1), Math.round(r.progress)])
      driveAI(r, this.route, ctx, dt, this.raceT, this.player.progress, this.racers)
    }
    this.checkPolice()
    this.updateMarkers()
    if (this.phase === 'done') {
      const allDone = this.racers.every((r) => r.isPlayer || r.finished || r.dnf)
      if (allDone || this.phaseT > COOLDOWN_T) this.dispose()
    }
  }

  /** AI 进度：局部投影 + 跨线计圈 + 检查点计时 + 完赛 */
  private track(r: Racer, ctx: Ctx, dt: number) {
    const v = r.v!, route = this.route, L = route.length
    let pr = project(route, v.x, v.z, r.idx, 6, 30)
    if (pr.dist > 25) pr = project(route, v.x, v.z, r.idx, 60, 120)
    if (route.loop) {
      if (pr.s < L * 0.25 && r.s > L * 0.75) r.lap++
      else if (pr.s > L * 0.75 && r.s < L * 0.25) r.lap--
    }
    r.s = pr.s; r.idx = pr.idx
    r.progress = r.lap * L + pr.s
    // 偏离赛道 > 2 s：复位
    if (pr.dist > 14 + (route.pts[pr.idx]?.hw ?? 3) && !r.finished) {
      r.offT += dt
      if (r.offT > 2) { r.offRouteResets++; resetOnRoute(r, route, ctx, this.racers, 0); r.offT = 0 }
    } else r.offT = 0
    while (r.nextCp < this.totalCps && r.progress >= this.cpProgress(r.nextCp)) { r.cpTimes.push(this.raceT); r.nextCp++ }
    if (!r.finished && r.progress >= this.raceLength) { r.finished = true; r.finishTime = this.raceT }
  }

  private updatePlayer(dt: number) {
    const ctx = this.ctx, pl = ctx.player, me = this.player
    const inCar = pl.vehicle === me.v && !!me.v && !me.v.wrecked
    if (!inCar) {
      this.outT += dt
      if (this.outT >= OUT_OF_CAR_LIMIT) { this.abort('离开赛车超过 15 秒'); return }
    } else this.outT = 0
    const v = me.v!
    // 赛车加固（与 AI 相同）：未报废时缓慢回血
    if (inCar && v.health < 100) v.health = Math.min(100, v.health + 2 * dt)
    const route = this.route, L = route.length
    let pr = project(route, v.x, v.z, me.idx, 40, 60)
    if (pr.dist > 30) pr = project(route, v.x, v.z, -1)
    me.idx = pr.idx; me.s = pr.s
    // 检查点：离检查点中心 < 半宽 + 9 m
    const k = me.nextCp
    pointAt(route, this.cpLocal(k), P)
    if (inCar && Math.hypot(v.x - P.x, v.z - P.z) < P.hw + 9) {
      me.cpTimes.push(this.raceT); me.nextCp++
      if (me.nextCp >= this.totalCps) { this.finish(); return }
      if (route.loop && me.nextCp % route.cps.length === 0) {
        const lap = me.nextCp / route.cps.length
        this.game.hud.toast(`第 ${lap + 1}/${this.def.laps} 圈${lap + 1 === this.def.laps ? ' · 最后一圈！' : ''}`, 1.6)
      }
    }
    // 进度 = 下一检查点进度 − 剩余距离（只能逐个过检查点，错过要回头）
    const cpS = this.cpLocal(me.nextCp), nextProg = this.cpProgress(me.nextCp)
    let remain = route.loop ? (((cpS - pr.s) % L) + L) % L : cpS - pr.s
    const spacing = route.cps.length > 1 ? route.cps[1] - route.cps[0] : 120
    this.missed = route.loop ? remain > L - 60 : remain < -10
    if (this.missed) remain = spacing
    me.progress = nextProg - Math.min(remain, spacing * 1.6)
  }
  missed = false

  /** 排名：完赛按用时，其余按进度 */
  standings(): Racer[] {
    return [...this.racers].sort((a, b) => {
      if (a.finished !== b.finished) return a.finished ? -1 : 1
      if (a.finished && b.finished) return a.finishTime - b.finishTime
      if (a.dnf !== b.dnf) return a.dnf ? 1 : -1
      return b.progress - a.progress
    })
  }
  get place() { return this.standings().indexOf(this.player) + 1 }
  /** 与前车差距（秒）；第一名为 null */
  gapAhead(): number | null {
    const st = this.standings(), i = st.indexOf(this.player)
    if (i <= 0) return null
    const a = st[i - 1], me = this.player
    const k = me.cpTimes.length - 1
    if (k >= 0 && a.cpTimes.length > k) return Math.max(0, me.cpTimes[k] - a.cpTimes[k])
    const sp = Math.max(20, Math.abs(me.v?.speed ?? 0))
    return Math.max(0, (a.progress - me.progress) / sp)
  }

  private finish() {
    const me = this.player
    me.finished = true; me.finishTime = this.raceT
    const place = this.place
    this.finishedPlace = place
    const ctx = this.ctx
    const pool = this.entry * 4
    const prize = Math.round(pool * PRIZE_POOL_SHARE[place - 1] + this.prizeBase * PRIZE_FIXED_SHARE[place - 1])
    if (prize > 0) earn(ctx, prize, 'race:prize')
    let betWon = 0
    if (this.opts.bet > 0 && place === 1) { betWon = Math.round(this.opts.bet * this.odds); earn(ctx, betWon, 'race:bet') }
    this.result = this.makeResult(place, prize, betWon, false)
    this.phase = 'done'; this.phaseT = 0
    this.marker.set(null); this.preview.set(null)
    ctx.events.emit('raceDone', { route: this.def.id, place, prize })
    this.game.law.trafficExempt = false
    this.onEnd?.(this.result)
  }

  private makeResult(place: number, prize: number, betWon: number, aborted: boolean, reason?: string): RaceResult {
    const st = this.standings()
    return {
      route: this.def.id, mode: this.opts.mode, place, prize, betWon, time: this.raceT, aborted, reason,
      standings: st.map((r, i) => ({ name: r.isPlayer ? '你' : `${r.name}（${r.tag}）`, place: r.isPlayer && aborted ? 0 : i + 1, time: r.finished ? +r.finishTime.toFixed(2) : null, progress: Math.round(r.progress) })),
    }
  }

  /** 结算 / 弃赛回调（插件：存档、结果面板） */
  onEnd: ((r: RaceResult) => void) | null = null
  /** 完全结束（回收车辆后）回调 */
  onDispose: (() => void) | null = null

  abort(reason: string) {
    if (this.phase === 'done' && this.result) { this.dispose(); return }
    this.result = this.makeResult(0, 0, 0, true, reason)
    this.ctx.events.emit('raceDone', { route: this.def.id, place: 0, prize: 0 })
    this.game.law.trafficExempt = false
    this.game.hud.toast(`比赛放弃：${reason}`, 3)
    this.onEnd?.(this.result)
    this.dispose()
  }

  disposed = false
  private prevDamageMul = 1
  /** 回收 AI / 租车 / 巡逻车 / 标记 */
  dispose() {
    if (this.disposed) return
    this.disposed = true
    const g = this.game, pl = g.ctx.player
    for (const v of this.aiCars) if (v.driver !== 'player') v.deactivate()
    if (this.rental) {
      if (pl.vehicle === this.rental) pl.exit(g.world)
      this.rental.deactivate()
      g.hud.toast('租来的跑车已归还', 2)
    }
    if (this.patrol && this.patrol.driver !== 'police') this.patrol.deactivate()
    this.car.damageMul = this.prevDamageMul
    g.scene.remove(this.marker.group, this.preview.group)
    g.law.trafficExempt = false
    this.onDispose?.()
  }

  /** 交通清场：合法赛道日清掉赛道走廊里的全部交通车；街头赛只清玩家 90 m 外的（AI 少被堵，玩家身边照常有车流） */
  private cullTraffic(dt: number) {
    this.cullTimer -= dt
    if (this.cullTimer > 0) return
    this.cullTimer = 0.4
    const ctx = this.ctx, px = ctx.player.worldX, pz = ctx.player.worldZ
    const legal = this.opts.mode === 'legal'
    for (const v of this.game.spawner.traffic) {
      if (!v.active || v.driver !== 'traffic') continue
      if (!legal && Math.hypot(v.x - px, v.z - pz) < 90) continue
      if (this.inCorridor(v.x, v.z, legal ? 6 : 3)) { releaseToken(v); v.deactivate(); this.trafficCulled++ }
    }
  }

  /** 街头赛被警察看到：非黑帮 1 星（一场一次）；被巡逻车看到时它也开始追 */
  private checkPolice() {
    if (this.opts.mode !== 'street' || this.spotted || this.phase !== 'race') return
    const ctx = this.ctx
    if (ctx.role.id === 'gang') return
    const px = ctx.player.worldX, pz = ctx.player.worldZ
    for (const v of ctx.vehicles) {
      if (!v.active || v.wrecked || (v.driver !== 'police' && v !== this.patrol)) continue
      if (Math.hypot(v.x - px, v.z - pz) > SPOT_DIST || !lineClear(ctx, v.x, v.z, px, pz)) continue
      this.spotted = true
      this.game.law.addCrime(1, ctx.time)
      this.game.hud.toast('被巡警发现非法飙车！通缉 1 星', 3)
      if (v === this.patrol) this.game.policeAI.start(v, ctx.graph.nearestLane(v.x, v.z, Math.sin(v.yaw), Math.cos(v.yaw)).edge, 1)
      break
    }
  }

  private updateMarkers() {
    if (this.phase === 'done') { this.marker.set(null); this.preview.set(null); return }
    const k = this.player.nextCp
    pointAt(this.route, this.cpLocal(k), P)
    this.marker.set({ x: P.x, z: P.z })
    if (k + 1 < this.totalCps) { pointAt(this.route, this.cpLocal(k + 1), P); this.preview.set({ x: P.x, z: P.z }) } else this.preview.set(null)
    this.marker.sync(this.ctx.time); this.preview.sync(this.ctx.time)
  }

  /** 当前目标点（小地图） */
  get target() { return this.phase === 'done' ? null : this.marker.point }
  private pathCache: { x: number; z: number }[] | null = null
  /** 小地图赛道线：路线点每 5 个取 1（环线首尾相接）；结束后不画 */
  get navPath() {
    if (this.phase === 'done') return null
    if (!this.pathCache) {
      const pts = this.route.pts
      const out = pts.filter((_, i) => i % 5 === 0).map((p) => ({ x: p.x, z: p.z }))
      const last = pts[pts.length - 1]
      if (last) out.push({ x: last.x, z: last.z })
      if (this.route.loop && pts[0]) out.push({ x: pts[0].x, z: pts[0].z })
      this.pathCache = out
    }
    return this.pathCache
  }

  hudCard() {
    const def = this.def, me = this.player
    const title = `${this.opts.mode === 'legal' ? '赛道日' : '街头赛'} · ${def.name}`
    if (this.phase === 'grid') return { title, desc: '起跑格就位，油门已锁', timer: 'READY' }
    if (this.phase === 'countdown') return { title, desc: '倒计时，准备起步', timer: String(Math.max(1, Math.ceil(COUNT_T - this.phaseT))) }
    if (this.phase === 'done' && this.result) {
      const r = this.result
      return { title, desc: `完赛 第 ${r.place} 名 · 奖金 $${r.prize.toLocaleString()}${r.betWon ? ` · 赢注 $${r.betWon.toLocaleString()}` : ''}`, timer: fmt(r.time) }
    }
    const M = this.route.cps.length
    const lap = Math.min(def.laps, Math.floor(me.nextCp / M) + 1)
    const gap = this.gapAhead()
    const parts = [
      this.route.loop ? `圈 ${lap}/${def.laps}` : '',
      `检查点 ${Math.min(me.nextCp + 1, this.totalCps)}/${this.totalCps}`,
      `第 ${this.place}/${this.racers.length} 名`,
      gap === null ? '领跑' : `前车 +${gap.toFixed(1)} s`,
    ].filter(Boolean)
    let sub: string | undefined
    if (this.outT > 0) sub = `回到赛车！${Math.ceil(OUT_OF_CAR_LIMIT - this.outT)} s 后判弃赛`
    else if (this.missed) sub = '错过检查点！掉头回到品红光柱'
    else if (this.spotted) sub = '被警察盯上了'
    return { title, desc: parts.join(' · '), timer: fmt(this.raceT), sub }
  }

  /** 调试：玩家传送到第 n 个检查点（全局序号）前 3 m */
  warp(n: number) {
    const pl = this.ctx.player, v = this.player.v
    if (!v || pl.vehicle !== v || this.phase !== 'race') return false
    const k = Math.max(0, Math.min(this.totalCps - 1, n))
    // 找一个 5 m 内没有别的车的落点（检查点前 3 / 9 m，横向错开），免得传送到 AI 车身上被撞报废
    let px = 0, pz = 0
    search: for (const back of [3, 9, 15, 25, 40]) {
      pointAt(this.route, this.cpLocal(k) - back, P)
      for (const f of [0, -0.6, 0.6, -1, 1]) {
        px = P.x - P.dz * P.hw * f; pz = P.z + P.dx * P.hw * f
        // 落点 6 m 内无车，且身后 35 m 同一条线上没有追上来的车
        const clear = !this.ctx.vehicles.some((o) => {
          if (o === v || !o.active) return false
          const dx = o.x - px, dz = o.z - pz
          if (Math.hypot(dx, dz) < 6) return true
          const f = dx * P.dx + dz * P.dz, l = Math.abs(dx * -P.dz + dz * P.dx)
          return f < 0 && f > -35 && l < 3.2
        })
        if (clear) break search
      }
    }
    v.x = px; v.z = pz; v.yaw = Math.atan2(P.dx, P.dz)
    const sp = Math.min(6, vmaxAt(this.route, this.cpLocal(k)) * 0.5); v.vx = P.dx * sp; v.vz = P.dz * sp
    this.player.idx = project(this.route, v.x, v.z, -1).idx
    this.game.cam.snap(v.yaw)
    return true
  }

  /** 调试：把玩家车摆到第 i 个 AI 身后 back m（同速），用于观察 AI 在玩家附近（静态碰撞体已加载）时的表现 */
  spectate(i: number, back = 30) {
    const r = this.racers.filter((x) => !x.isPlayer)[i], v = this.player.v
    if (!r || !v || this.ctx.player.vehicle !== v) return false
    pointAt(this.route, r.s - back, P)
    v.x = P.x; v.z = P.z; v.yaw = Math.atan2(P.dx, P.dz)
    const sp = Math.max(0, r.v!.speed); v.vx = P.dx * sp; v.vz = P.dz * sp
    this.player.idx = project(this.route, v.x, v.z, -1).idx
    return true
  }

  debugState() {
    const st = this.standings()
    return {
      route: this.def.id, mode: this.opts.mode, phase: this.phase, raceT: +this.raceT.toFixed(2), laps: this.def.laps,
      length: Math.round(this.route.length), cps: this.totalCps, place: this.place, nextCp: this.player.nextCp,
      gap: this.gapAhead(), missed: this.missed, outT: +this.outT.toFixed(1), spotted: this.spotted, trafficCulled: this.trafficCulled,
      exempt: this.game.law.trafficExempt, finesSinceStart: this.game.law.fines - this.ticketsAtStart,
      player: { progress: Math.round(this.player.progress), finished: this.player.finished, time: this.player.finished ? +this.player.finishTime.toFixed(2) : null },
      ai: this.racers.filter((r) => !r.isPlayer).map((r) => ({
        name: r.name, skill: r.skill, progress: Math.round(r.progress), lap: r.lap, finished: r.finished, finishTime: r.finished ? +r.finishTime.toFixed(2) : null, dnf: r.dnf,
        speed: +(r.v?.speed ?? 0).toFixed(1), dbg: r.dbg, stuck: r.stuckEvents, offReset: r.offRouteResets, rubber: +r.rubber.toFixed(3), health: Math.round(r.v?.health ?? 0), trace: r.trace,
      })),
      order: st.map((r) => r.name),
      result: this.result,
    }
  }
}

