import type { Game } from '../../core/Game'
import type { AppView, AppItem } from '../../core/Context'
import type { Vehicle } from '../../entities/Vehicle'
import type { PanelButton, PanelSpec } from '../../ui/Panels'
import type { Poi } from '../../systems/Poi'
import { spend } from '../../systems/Wallet'
import { circleBody } from '../../physics/Collision'
import type { AABB } from '../../world/Colliders'
import { venueOf, venueById } from '../../data/venues'
import { isUnlocked, unlockLevel } from '../../data/progression'
import { routesFor, routeById, RACE_RENT, RACE_BETS, RIVALS, PRIZE_POOL_SHARE, PRIZE_FIXED_SHARE, betOdds, type RaceRouteDef } from '../../data/races'
import { buildRoute, type BuiltRoute } from './Route'
import { RaceSession, fmtTime, type RaceMode, type RaceResult } from './Race'

interface RaceSave { best: Record<string, number>; wins: number; races: number; podiums: number; log: string[] }
const emptySave = (): RaceSave => ({ best: {}, wins: 0, races: 0, podiums: 0, log: [] })
const VENUE = 'race_marina_bay'
/** 白天合法赛道日开放时间 */
const LEGAL_HOURS: [number, number] = [8, 18]
const usd = (n: number) => `$${Math.round(n).toLocaleString()}`

/**
 * P10.C 街头赛车插件：滨海湾维修区报名（夜间 20–04 街头赛；白天 08–18 合法赛道日），
 * 3 辆 AI 对手、检查点链、名次奖金 + 押冠军，非黑帮街头赛被巡警看到 → 1 星。
 */
export function installRace(game: Game) {
  let save = emptySave()
  let session: RaceSession | null = null
  let lastCar: Vehicle | null = null
  const routeCache = new Map<string, BuiltRoute | string>()
  /** 报名面板里选择的押注档位 */
  let betIdx = 0
  const aiCars: Vehicle[] = []
  let rentalRef: Vehicle | null = null
  /** 调试：上一场比赛回收时的最终状态 */
  let lastFinal: unknown = null
  const worldKind = () => game.source.kind as 'sg' | 'grid'
  /** 调试：收到的 raceDone 事件 */
  const events: unknown[] = []
  game.events.on('raceDone', (e) => { events.push({ ...e }); if (events.length > 20) events.shift() })
  /** 调试：AI 赛车撞墙记录 */
  const crashes: { ai: number; x: number; z: number; imp: number; t: number; speed: number }[] = []
  game.events.on('vehicleHitStatic', ({ v, impulse }) => {
    const i = aiCars.indexOf(v)
    if (i >= 0 && session && impulse > 3) { crashes.push({ ai: i, x: Math.round(v.x), z: Math.round(v.z), imp: +impulse.toFixed(1), t: +session.raceT.toFixed(1), speed: +v.absSpeed.toFixed(1) }); if (crashes.length > 200) crashes.shift() }
  })

  const getRoute = (def: RaceRouteDef): BuiltRoute | string => {
    let r = routeCache.get(def.id)
    if (!r) { r = buildRoute(game.ctx.graph, def); routeCache.set(def.id, r) }
    return r
  }
  const lockReason = (def: RaceRouteDef): string | null => {
    const lv = game.progress.level, role = game.ctx.role.id
    if (def.unlock && !isUnlocked(role, lv, def.unlock)) return `需要 Lv${unlockLevel(role, def.unlock)}`
    if (def.minLevel && lv < def.minLevel) return `需要 Lv${def.minLevel}`
    return null
  }
  const legalOpen = () => { const h = game.ctx.clock.hour; return h >= LEGAL_HOURS[0] && h < LEGAL_HOURS[1] }
  const prizeFor = (def: RaceRouteDef, mode: RaceMode, place: number) => {
    const entry = mode === 'legal' ? def.legal!.entry : def.entry, base = mode === 'legal' ? def.legal!.prize : def.prize
    return Math.round(entry * 4 * PRIZE_POOL_SHARE[place - 1] + base * PRIZE_FIXED_SHARE[place - 1])
  }

  /** 可以拿来比赛的自有车：正坐着的车，或刚开过来停在 80 m 内的那辆（不能是巴士 / 报废车 / 比赛 AI 车） */
  const ownCar = (): Vehicle | null => {
    const pl = game.ctx.player
    const c = pl.vehicle ?? lastCar
    if (!c || !c.active || c.wrecked || c.kind === 'bus' || aiCars.includes(c)) return null
    if (c.driver !== 'player' && c.driver !== 'none') return null
    if (Math.hypot(c.x - pl.worldX, c.z - pl.worldZ) > 80) return null
    return c
  }

  const aiCar = (i: number, at: { x: number; z: number }): Vehicle => {
    const rv = RIVALS[i]
    const v = game.spawner.spawnOwned(game.ctx, `race_ai_${i}`, at.x, at.z, 0, { kind: 'luxury', color: rv.color, model: 'sports' })
    v.tune = { accel: 1, maxFwd: 1 }
    if (!aiCars[i]) {
      // 比赛车加固：Game 对"被玩家撞"的车按 3.5× 结算伤害，AI 赛车蹭一下就报废；这几辆自己的车伤害按 0.3 倍吃
      const base = v.damage.bind(v)
      v.damage = (amount: number) => base(amount * 0.3)
    }
    aiCars[i] = v
    return v
  }

  /** 开赛；返回 true 或失败原因 */
  const start = (id: string, o: { rent?: boolean; mode?: RaceMode; bet?: number } = {}): true | string => {
    const ctx = game.ctx
    if (session) return '已经在比赛中'
    const def = routeById(id)
    if (!def || def.world !== worldKind()) return '没有这条路线'
    const mode: RaceMode = o.mode ?? 'street'
    if (mode === 'legal' && !def.legal) return '这条路线没有合法赛道日'
    const lock = lockReason(def); if (lock) return lock
    const route = getRoute(def)
    if (typeof route === 'string') return `路线不可用：${route}`
    const entry = mode === 'legal' ? def.legal!.entry : def.entry
    const bet = mode === 'legal' ? 0 : Math.max(0, o.bet ?? 0)
    const rent = !!o.rent
    let car = rent ? null : ownCar()
    if (!rent && !car) return '需要一辆车：开车过来，或租一辆跑车'
    const cost = entry + (rent ? RACE_RENT : 0) + bet
    if (ctx.player.money < cost) return `钱不够（需要 ${usd(cost)}）`
    spend(ctx, entry, 'race:entry')
    if (rent) spend(ctx, RACE_RENT, 'race:rent')
    if (bet > 0) spend(ctx, bet, 'race:bet')
    const pl = ctx.player
    let rental: Vehicle | null = null
    if (game.state === 'panel') game.closePanel()
    if (rent) {
      if (pl.vehicle) pl.exit(ctx.world)
      rental = game.spawner.spawnOwned(ctx, 'race_rental', pl.x, pl.z, 0, { kind: 'luxury', color: 0xe8e8ea, model: 'sports' })
      rental.tune = { accel: 1.05, maxFwd: 1 }
      rentalRef = rental
      car = rental
    }
    const p0 = route.pts[0]
    const ais = [0, 1, 2].map((i) => aiCar(i, p0))
    for (const v of ais) { v.driver = 'none'; v.health = 100; v.wrecked = false }
    if (pl.vehicle !== car) { if (pl.vehicle) pl.exit(ctx.world); pl.enter(car!) }
    car!.controls.handbrake = true
    session = new RaceSession(game, route, { mode, rent, bet }, car!, ais, rental)
    session.onEnd = (r) => onEnd(def, r)
    session.onDispose = () => { lastFinal = session?.debugState() ?? null; session = null }
    game.cam.snap(car!.yaw)
    return true
  }

  const onEnd = (def: RaceRouteDef, r: RaceResult) => {
    save.races++
    if (!r.aborted) {
      if (r.place === 1) save.wins++
      if (r.place <= 3) save.podiums++
      const prev = save.best[def.id]
      if (prev === undefined || r.time < prev) save.best[def.id] = +r.time.toFixed(2)
    }
    const line = r.aborted ? `${def.name}：弃赛（${r.reason}）` : `${def.name}：第 ${r.place} 名 · ${fmtTime(r.time)} · 奖金 ${usd(r.prize)}${r.betWon ? ` · 赢注 ${usd(r.betWon)}` : ''}`
    save.log.unshift(`第${game.ctx.clock.day}天 ${game.ctx.clock.hhmm} ${line}`)
    save.log.length = Math.min(save.log.length, 12)
    if (!r.aborted) showResult(def, r)
  }

  const showResult = (def: RaceRouteDef, r: RaceResult) => {
    const title = r.place === 1 ? '冠军！' : `第 ${r.place} 名`
    const lines = [
      `${def.name} · ${r.mode === 'legal' ? '合法赛道日' : '街头赛'} · 用时 ${fmtTime(r.time)}${save.best[def.id] === +r.time.toFixed(2) ? '（新纪录）' : ''}`,
      `奖金 ${usd(r.prize)}${r.betWon ? ` · 押冠军赢得 ${usd(r.betWon)}` : ''}`,
      ...r.standings.map((s) => `${s.place}. ${s.name}  ${s.time !== null ? fmtTime(s.time) : `跑到 ${(s.progress / 1000).toFixed(2)} km`}`),
    ]
    showPanel({ title, subtitle: '比赛结算', lines, buttons: [{ label: '好的', onClick: () => game.closePanel() }] })
  }

  /** 在 play / panel 状态弹面板（暂停世界）；关闭走 game.closePanel */
  const showPanel = (spec: PanelSpec) => {
    if (game.state === 'play') {
      game.state = 'panel'
      game.phone.set(false)
      if (document.pointerLockElement) document.exitPointerLock()
    }
    if (game.state === 'panel') game.panels.show(spec)
  }

  /** 报名面板：路线详情 + 自有车 / 租车 + 押注 */
  const setupPanel = (poi: Poi, def: RaceRouteDef, mode: RaceMode) => {
    const route = getRoute(def)
    const len = typeof route === 'string' ? '—' : `${((route.length * (route.loop ? def.laps : 1)) / 1000).toFixed(1)} km`
    const entry = mode === 'legal' ? def.legal!.entry : def.entry
    const bet = mode === 'legal' ? 0 : RACE_BETS[betIdx]
    const odds = betOdds(def)
    const car = ownCar()
    const best = save.best[def.id]
    const lines = [
      def.desc,
      `${def.loop ? `环形 ${def.laps} 圈` : '点到点'} · 全程 ${len} · 难度 ${'★'.repeat(def.stars)}${'☆'.repeat(3 - def.stars)} · 对手：${RIVALS.map((rv, i) => `${rv.name}（${rv.tag} ${Math.round(def.ai[i] * 100)}）`).join(' / ')}`,
      `报名费 ${usd(entry)} · 奖金 冠军 ${usd(prizeFor(def, mode, 1))} / 亚军 ${usd(prizeFor(def, mode, 2))} / 季军 ${usd(prizeFor(def, mode, 3))}${best !== undefined ? ` · 你的纪录 ${fmtTime(best)}` : ''}`,
      mode === 'legal' ? '合法赛道日：封路清空交通，没有警察。' : `街头赛违法：${game.ctx.role.id === 'gang' ? '黑帮照常会被追' : '被巡警看到会通缉 1 星'}。比赛期间不开超速 / 闯灯罚单。`,
      car ? `参赛车辆：你的车（${car.model === 'sports' ? '跑车' : car.kind === 'taxi' ? '的士' : '轿车'} · 车况 ${Math.round(car.health)}%）` : '附近没有你的车：可以租一辆跑车。',
      `现金 ${usd(game.ctx.player.money)}`,
    ]
    const go = (rent: boolean) => {
      const r = start(def.id, { rent, mode, bet })
      if (r !== true) { game.hud.toast(r, 3); if (game.state === 'panel') setupPanel(poi, def, mode) }
    }
    const buttons: PanelButton[] = [
      { label: '用自己的车参赛', note: usd(entry + bet), disabled: !car, onClick: () => go(false) },
      { label: '租跑车参赛', note: `${usd(entry + bet)} + 租车 ${usd(RACE_RENT)}`, onClick: () => go(true) },
    ]
    if (mode === 'street') buttons.push({ label: `押自己夺冠：${bet ? usd(bet) : '不下注'}`, note: `赔率 ${odds}×（点按切换）`, onClick: () => { betIdx = (betIdx + 1) % RACE_BETS.length; setupPanel(poi, def, mode) } })
    buttons.push({ label: '返回', onClick: () => game.interactions.open(poi) })
    game.panels.show({ title: def.name, subtitle: mode === 'legal' ? '合法赛道日 · 报名' : '街头赛 · 报名', lines, buttons })
  }

  const poiButtons = (poi: Poi): PanelButton[] => {
    if (venueOf(poi)?.id !== VENUE) return []
    if (session) return [{ label: '比赛进行中', disabled: true, anyHour: true, onClick: () => {} }]
    const defs = routesFor(worldKind())
    const btn = (def: RaceRouteDef, mode: RaceMode): PanelButton => {
      const lock = lockReason(def)
      const route = getRoute(def)
      const len = typeof route === 'string' ? '' : `${((route.length * (route.loop ? def.laps : 1)) / 1000).toFixed(1)} km · `
      const entry = mode === 'legal' ? def.legal!.entry : def.entry
      return {
        label: `${mode === 'legal' ? '赛道日 · ' : ''}${def.name}`,
        note: lock ?? `${len}${def.loop ? `${def.laps} 圈` : '冲刺'} · 报名 ${usd(entry)} · 冠军 ${usd(prizeFor(def, mode, 1))}`,
        disabled: !!lock || typeof route === 'string', anyHour: mode === 'legal',
        onClick: () => setupPanel(poi, def, mode),
      }
    }
    const out: PanelButton[] = defs.map((d) => btn(d, 'street'))
    if (legalOpen()) for (const d of defs) if (d.legal) out.push(btn(d, 'legal'))
    return out
  }

  const view = (): AppView => {
    const defs = routesFor(worldKind())
    const items: AppItem[] = defs.map((d) => {
      const lock = lockReason(d)
      const route = getRoute(d)
      const best = save.best[d.id]
      return {
        title: d.name,
        desc: `${d.loop ? `${d.laps} 圈` : '冲刺'}${typeof route === 'string' ? '' : ` · ${((route.length * (d.loop ? d.laps : 1)) / 1000).toFixed(1)} km`} · ${'★'.repeat(d.stars)} · 报名 ${usd(d.entry)}`,
        value: best !== undefined ? fmtTime(best) : '—',
        status: lock ?? (d.legal ? '夜间街头赛 20–04 · 白天赛道日 08–18' : '夜间街头赛 20–04'),
        tone: lock ? 'locked' : best !== undefined ? 'owned' : undefined,
      }
    })
    const lines = [
      `${venueById(VENUE)?.name ?? '滨海湾赛道'} 报名`,
      `出赛 ${save.races} · 冠军 ${save.wins} · 领奖台 ${save.podiums}`,
    ]
    if (session) lines.unshift(`比赛中：${session.def.name} · ${session.hudCard().desc}`)
    return { lines, sections: [{ title: '路线与纪录（右侧为最快用时）', items }], log: save.log }
  }

  game.addPlugin({
    id: 'race',
    update(dt) {
      const pv = game.ctx.player.vehicle
      if (pv && !aiCars.includes(pv)) lastCar = pv
      session?.update(dt)
    },
    serialize: () => ({ ...save, best: { ...save.best }, log: [...save.log] }),
    restore(s) {
      const d = (s ?? {}) as Partial<RaceSave>
      save = { best: { ...(d.best ?? {}) }, wins: d.wins ?? 0, races: d.races ?? 0, podiums: d.podiums ?? 0, log: [...(d.log ?? [])] }
      if (session) session.abort('读档')
    },
    poiButtons,
    app: { name: 'race', title: '赛车', view },
    hudCard: () => session?.hudCard() ?? null,
    navTarget: () => session?.target ?? null,
    onBustOrDeath: () => { if (session) session.abort(game.state === 'busted' ? '被捕' : '倒下') },
    debug: () => ({
      routes: () => routesFor(worldKind()).map((d) => {
        const r = getRoute(d)
        return typeof r === 'string' ? { id: d.id, name: d.name, error: r } : { id: d.id, name: d.name, loop: d.loop, laps: d.laps, length: Math.round(r.length), cps: r.cps.length, edges: r.edges, pts: r.pts.length, start: { x: r.pts[0].x, z: r.pts[0].z }, lock: lockReason(d), legal: !!d.legal }
      }),
      /** 调试路线几何：抽样点 [x,z,vmax] */
      path: (id: string, every = 10) => { const d = routeById(id); const r = d && getRoute(d); return r && typeof r !== 'string' ? r.pts.filter((_, i) => i % every === 0).map((p) => [Math.round(p.x), Math.round(p.z), Math.round(p.vmax)]) : null },
      /** 调试：赛车线（中心 / ±半宽）上压到静态碰撞体的点（只查已加载区块），返回 [s, x, z, 偏移] */
      blocked: (id: string, x0?: number, z0?: number, rad = 400) => {
        const d = routeById(id); const r = d && getRoute(d); if (!r || typeof r === 'string') return null
        const out: number[][] = [], tmp: AABB[] = []
        for (const p of r.pts) {
          if (x0 !== undefined && Math.hypot(p.x - x0, p.z - (z0 ?? 0)) > rad) continue
          for (const f of [0, -1, 1]) {
            const x = p.x - p.dz * p.hw * f, z = p.z + p.dx * p.hw * f
            if (game.world.query(x, z, 1.1, tmp).some((b) => circleBody(x, z, 1.1, b) !== null)) { out.push([Math.round(p.s), Math.round(x), Math.round(z), f]); break }
          }
        }
        return out
      },
      bodies: (x: number, z: number, r = 6) => game.world.query(x, z, r, []).map((b) => ({ minX: b.minX, maxX: b.maxX, minZ: b.minZ, maxZ: b.maxZ, h: (b as { h?: number }).h, kind: Object.keys(b).join(',') })),
      start: (id: string, o?: { rent?: boolean; mode?: RaceMode; bet?: number }) => start(id, o),
      state: () => session?.debugState() ?? null,
      warp: (n: number) => session?.warp(n) ?? false,
      spectate: (i: number, back?: number) => session?.spectate(i, back) ?? false,
      abort: () => { if (!session) return false; session.abort('手动退出'); return true },
      get active() { return !!session },
      get events() { return events },
      get final() { return lastFinal },
      get crashes() { return crashes },
      get law() { return { stars: game.law.stars, fines: game.law.fines, exempt: game.law.trafficExempt } },
      get rental() { return rentalRef ? { active: rentalRef.active, driver: rentalRef.driver } : null },
      get save() { return save },
      get aiCars() { return aiCars.map((v) => ({ active: v.active, x: v.x, z: v.z })) },
    }),
  })
}
