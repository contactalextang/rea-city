import type { Game } from '../../core/Game'
import type { AppView, AppItem } from '../../core/Context'
import type { Poi } from '../../systems/Poi'
import type { PanelButton } from '../../ui/Panels'
import type { SgWorld } from '../../world/SgWorld'
import { spend, charge } from '../../systems/Wallet'
import { Aircraft } from '../../entities/Aircraft'
import { AIRPORT_POI, HANGAR_POI, STANDS, RUNWAY, TAKEOFF_09 } from '../../world/Airfield'
import { isUnlocked, unlockLevel } from '../../data/progression'
import { SHOP, shopItem } from '../../data/shop'
import { airspeed, heading } from '../../physics/ArcadeFlight'
import { FlightHud } from './FlightHud'
import { CrashFx } from './Crash'
import { FlightControl, type CrashReason } from './Flight'
import { OwnedFleet, type OwnedSave } from './Ownership'
import { FlightJobs, JOB_TITLE, JOB_DESC, type FlightJobsSave } from './FlightJobs'
import { RENT_PRICE, RENT_INSURANCE, FLIGHT_JOBS_PER_DAY } from './missions/params'
import { t } from '../../i18n'

/**
 * Phase AIR.4 驾驶接入插件（id 'aviation'，只在 sg 世界且机场接入时安装）：
 * 机库租机（$300）→ 停机位生成飞机 → 步行靠近按 F 登机 → 自由飞行 / 起降 → 地面停稳按 F 下机；
 * 撞楼 / 坠海 / 翼尖触地 / 重摔 → 爆炸特效 + WASTED（租机扣 $2,000 保险自付）。
 * 飞行逐步推进、碰撞、相机、视距、HUD 在 Flight.ts（FlightControl）；本文件管实体生命周期、租机、按键、存档与调试钩子。
 *
 * 给 AIR.5（经济 / 飞行工作）的接口：getAviation(game) → AviationApi（生成自有飞机、机队、当前驾驶的飞机、自动驾驶），
 * 事件 flightTakeoff / flightLanded / aircraftCrashed（见 core/Context.ts GameEvents）。
 */

export { RENT_PRICE, RENT_INSURANCE }
/** 下机后走远多少米回收租机 */
const RECYCLE_DIST = 200
/** 登机距离（m，步行，到机身中心；翼展 11 m，站在翼下即可） */
const BOARD_DIST = 7

interface RentalSave { day: number; x: number; z: number; yaw: number; stand: number; used: boolean }
interface AviationSave { v: 1; rental: RentalSave | null; crashes: number; flights: number; landings: number; own?: OwnedSave[]; jobs?: FlightJobsSave }

/** AIR.5 空域管制：低空（< CBD_LOW m）飞越 CBD 矩形记热度（relaxed / real 执法档） */
const CBD = { minX: -600, maxX: 900, minZ: -900, maxZ: 600 }
const CBD_LOW = 120
/** 掠过金沙（成就）：中心与半径、高度上限 */
const MBS_FLYBY = { x: 1520, z: -20, r: 400, maxY: 250 }
/** 下滑道指示：3.5°，接地点外 6 km 内、偏离中线 600 m 内、航向差 40° 内 */
const GLIDE = { deg: 3.5, range: 6000, cross: 600, hdg: 40 }

export interface AviationApi {
  /** 当前机队（租机 + 自有，已生成在场景里的） */
  readonly fleet: readonly Aircraft[]
  /** 正在驾驶的飞机（没有为 null） */
  readonly active: Aircraft | null
  /**
   * 生成一架飞机：stand 缺省自动找空闲停机位（STANDS 下标）；返回 null = 没有空位。
   * AIR.5：买飞机后 spawn({ id: 'plane_cessna', owner: 'own', paint }) 即可，登机 / 飞行 / 坠毁流程自动复用。
   */
  spawn(o: { id: string; owner: 'rent' | 'own'; paint?: number; stand?: number; at?: { x: number; z: number; yaw: number } }): Aircraft | null
  /** 移除一架飞机（正在驾驶时不会移除，返回 false） */
  remove(ac: Aircraft): boolean
  /** 空闲停机位下标（-1 = 没有） */
  freeStand(): number
  /** 自动驾驶（null 关闭），见 Autopilot.ts */
  autopilot: FlightControl['autopilot']
}
const apis = new WeakMap<Game, AviationApi>()
/** AIR.5 用：拿到航空插件的接口（插件未安装 → null，如方格城） */
export function getAviation(game: Game): AviationApi | null { return apis.get(game) ?? null }

export function installAviation(game: Game) {
  const sg = game.source as unknown as SgWorld
  const hud = new FlightHud(game.input.touch)
  const fx = new CrashFx(game.scene)
  const fleet: Aircraft[] = []
  let rental: (Aircraft & { rent?: RentalSave }) | null = null
  let rentInfo: RentalSave | null = null
  let crashCount = 0
  let flights = 0
  let landings = 0
  const fc = new FlightControl(game, sg, hud, fx, {
    onCrash: (ac, reason) => onCrash(ac, reason),
    onTakeoff: () => { flights++; flyby = false },
    onLanded: () => { landings++ },
    onDropped: (ac, airborne) => { if (airborne || ac.wrecked) remove(ac) },
    params: (ac) => owned.params.get(ac),
  })
  /** 本次飞行已触发过掠过金沙 */
  let flyby = false

  const hangarDoor = () => {
    const p = game.pois.byId(HANGAR_POI)
    return p ? { x: p.door.x, z: p.door.z, yaw: p.door.yaw } : { x: STANDS[0].x, z: STANDS[0].z - 20, yaw: 0 }
  }

  const freeStand = (): number => {
    for (let i = 0; i < STANDS.length; i++) {
      const s = STANDS[i]
      if (fleet.some((a) => Math.hypot(a.x - s.x, a.z - s.z) < 12)) continue
      if (game.vehicles.some((v) => v.active && Math.hypot(v.x - s.x, v.z - s.z) < 7)) continue
      return i
    }
    return -1
  }

  const spawn: AviationApi['spawn'] = (o) => {
    let at = o.at
    if (!at) {
      const i = o.stand ?? freeStand()
      if (i < 0 || i >= STANDS.length) return null
      at = STANDS[i]
    }
    const ac = new Aircraft(at.x, at.z, at.yaw, o.paint ?? (o.owner === 'rent' ? 0xc8322d : 0x1f5fbf))
    ac.id = o.id; ac.owner = o.owner
    // 存档落点：地面停稳 → 机门外；空中 → 机库门口
    ac.spotProvider = (a) => (a.body.onGround && a.speed < 3 && !a.wrecked ? fc.exitSpot(a) : hangarDoor())
    game.scene.add(ac.group)
    fleet.push(ac)
    return ac
  }

  const remove = (ac: Aircraft): boolean => {
    if (fc.active === ac) return false
    const i = fleet.indexOf(ac)
    if (i >= 0) fleet.splice(i, 1)
    ac.dispose()
    if (ac === rental) { rental = null; rentInfo = null }
    return true
  }

  const rentLock = (): string | null => isUnlocked(game.ctx.role.id, game.progress.level, 'air_rent') ? null : t('Lv{n} 解锁租机', { n: unlockLevel(game.ctx.role.id, 'air_rent') })
  const rent = (): true | string => {
    const lock = rentLock(); if (lock) return lock
    if (rental) return t('你已经租了一架飞机')
    if (game.player.piloting) return t('先降落并下飞机')
    const i = freeStand()
    if (i < 0) return t('停机位都满了，稍后再来')
    if (!spend(game.ctx, RENT_PRICE, 'plane_rent')) return t('钱不够（需要 ${n}）', { n: RENT_PRICE })
    const ac = spawn({ id: 'rental', owner: 'rent', stand: i })!
    rental = ac
    rentInfo = { day: game.clock.day, x: ac.x, z: ac.z, yaw: ac.yaw, stand: i, used: false }
    game.hud.toast(t('租到一架 Cessna 172 · {n} 号停机位', { n: i + 1 }), 3)
    game.saveGame(false)
    return true
  }

  function onCrash(ac: Aircraft, reason: CrashReason) {
    crashCount++
    const i = fleet.indexOf(ac)
    if (i >= 0) fleet.splice(i, 1)
    if (ac.owner === 'rent') {
      charge(game.ctx, RENT_INSURANCE, 'plane_insurance')
      game.hud.toast(t('飞机坠毁 · 租机保险自付 ${n}', { n: RENT_INSURANCE.toLocaleString() }), 4)
    } else {
      owned.onCrash(ac)
      game.hud.toast(t('飞机坠毁 · 「{name}」报废，到机库维修（{n}）', { name: shopItem(ac.id)?.name ?? ac.id, n: `$${owned.repairCost(ac.id).toLocaleString()}` }), 4)
    }
    if (ac === rental) { rental = null; rentInfo = null }
    void reason
  }

  /** 最近的可登机飞机（步行、6 m 内、未坠毁） */
  const boardable = (): Aircraft | null => {
    const pl = game.player
    if (!pl.onFoot) return null
    let best: Aircraft | null = null, bd = BOARD_DIST
    for (const a of fleet) {
      if (a.wrecked) continue
      const d = Math.hypot(a.x - pl.x, a.z - pl.z)
      if (d < bd) { bd = d; best = a }
    }
    return best
  }

  const board = (ac: Aircraft) => {
    fc.board(ac)
    if (ac === rental && rentInfo) rentInfo.used = true
  }

  /** 回收：租机下机后走远 200 m，或过了租用当天（不在驾驶时） */
  const recycle = () => {
    if (!rental || !rentInfo || fc.active === rental) return
    const pl = game.player
    const far = Math.hypot(rental.x - pl.worldX, rental.z - pl.worldZ) > RECYCLE_DIST
    if ((rentInfo.used && far) || game.clock.day > rentInfo.day) {
      remove(rental)
      if (!far) game.hud.toast(t('租机已到期归还'), 2.5)
    }
  }

  /** 强制下机：空中被打断 / 坠毁残骸 → 移除飞机；地面的留在原地 */
  const dropActive = () => {
    const r = fc.forceLeave()
    if (r && (r.airborne || r.ac.wrecked)) remove(r.ac)
  }

  const refreshPanel = () => { const c = game.interactions.current; if (c && game.panels.open) game.interactions.open(c) }
  /** 飞行工作按钮（机库 / 航站楼） */
  const jobButtons = (): PanelButton[] => {
    if (jobs.mission) return [{ label: t('放弃飞行工作：{title}', { title: JOB_TITLE[jobs.kind] }), note: t('进行中 · 不结算'), onClick: () => { jobs.cancel(); refreshPanel() } }]
    const lock = jobs.lockReason()
    return [{
      label: t('接单：{title}', { title: JOB_TITLE[jobs.kind] }), note: lock ?? `${JOB_DESC[jobs.kind]} · ${t('今天 {a}/{b}', { a: jobs.s.day === game.clock.day ? jobs.s.today : 0, b: FLIGHT_JOBS_PER_DAY })}`, disabled: !!lock,
      onClick: () => { const r = jobs.start(); if (r !== true) game.hud.toast(r, 3) },
    }]
  }
  const ownButtons = (): PanelButton[] => {
    const out: PanelButton[] = []
    for (const e of owned.list) {
      const it = shopItem(e.id); if (!it) continue
      if (e.wrecked) {
        const cost = owned.repairCost(e.id), poor = game.player.money < cost
        out.push({ label: t('维修：{name}（${n}）', { name: it.name, n: cost.toLocaleString() }), note: poor ? t('钱不够') : t('买价 × 5% · 修好停回停机位'), disabled: poor, onClick: () => { const r = owned.repair(e.id); if (r !== true) game.hud.toast(r, 2.5); else refreshPanel() } })
        continue
      }
      const ac = owned.planes.get(e.id)
      if (ac && fc.active === ac) continue
      const st = owned.standOf(ac ?? null)
      out.push({ label: t('取我的飞机：{name}', { name: it.name }), note: st >= 0 ? t('就在 {n} 号停机位，走过去按 F 登机', { n: st + 1 }) : t('停在机场外 · 让地勤拖回停机位'), onClick: () => { const r = owned.fetch(e.id); if (r !== true) game.hud.toast(r, 2.5); else game.closePanel() } })
    }
    return out
  }
  const poiButtons = (poi: Poi): PanelButton[] => {
    if (poi.id === AIRPORT_POI) return jobButtons()
    if (poi.id !== HANGAR_POI) return []
    const out: PanelButton[] = [...jobButtons(), ...ownButtons()]
    if (rental) {
      const n = rentInfo ? rentInfo.stand + 1 : 1
      out.push({ label: t('你的租机在 {n} 号停机位', { n }), note: t('今天内有效'), disabled: true, onClick: () => {} })
      return out
    }
    const lock = rentLock()
    const poor = game.player.money < RENT_PRICE
    out.push({
      label: t('租一架 Cessna（${n}）', { n: RENT_PRICE }), note: lock ?? (poor ? t('钱不够') : t('当天有效 · 坠毁自付 ${n}', { n: RENT_INSURANCE.toLocaleString() })), disabled: poor || !!lock,
      onClick: () => { const r = rent(); if (r !== true) game.hud.toast(r, 2.5); else game.closePanel() },
    })
    return out
  }

  // ---------- AIR.5：自有飞机 / 飞行工作 ----------
  const owned = new OwnedFleet(game, { spawn: (o) => spawn(o), remove: (a) => remove(a), freeStand: () => freeStand(), active: () => fc.active })
  game.assets.aircraftHost = { info: (id) => owned.info(id) }
  game.events.on('purchased', ({ kind, id }) => { if (kind === 'aircraft') owned.onPurchased(id) })
  const jobs = new FlightJobs({
    game,
    active: () => fc.active,
    autopilot: (a) => { fc.autopilot(a) },
    hf: (x, z, r = 0) => fc.heightAt(x, z, r),
    acquire: () => {
      if (fc.active) return fc.active
      const own = owned.available()
      if (own) return own
      if (rental) return rental
      const r = rent()
      return r === true && rental ? rental : r === true ? t('没租到飞机') : r
    },
    payMul: (ac) => (ac.owner === 'own' ? shopItem(ac.id)?.aircraft?.payMul ?? 1 : 1),
  })

  /** 航电：下滑道指示 + T 键定高定向（买了 upg_avionics 才有） */
  let altHold = false
  const avionics = () => {
    const ac = fc.active
    if (!ac || ac.wrecked || !game.assets.owns('upg_avionics')) { hud.setInfo(null); altHold = false; return }
    const b = ac.body
    if (game.state === 'play' && !game.phone.open && game.input.justPressed('KeyT') && !b.onGround) {
      altHold = !altHold
      fc.autopilot(altHold ? { hdg: heading(b), alt: b.y, spd: airspeed(b) } : null)
      game.hud.toast(altHold ? t('定高定向：{h} m', { h: Math.round(b.y) }) : t('定高已解除'), 1.5)
    }
    if (altHold && !fc.debugState(0).autopilot) altHold = false
    const parts: string[] = []
    if (altHold) parts.push(t('定高 ON（T 解除）'))
    else if (!b.onGround) parts.push(t('T 定高'))
    // 下滑道：两条进近方向挑航向对得上的那条
    for (const L of [{ x: RUNWAY.x0 + 100, hdg: Math.PI / 2 }, { x: RUNWAY.x1 - 100, hdg: -Math.PI / 2 }]) {
      if (b.onGround) break
      const fx = Math.sin(L.hdg)
      const along = (L.x - b.x) * fx
      const cross = b.z - RUNWAY.z
      const dh = Math.abs(Math.atan2(Math.sin(heading(b) - L.hdg), Math.cos(heading(b) - L.hdg))) * 180 / Math.PI
      if (along < 0 || along > GLIDE.range || Math.abs(cross) > GLIDE.cross || dh > GLIDE.hdg) continue
      const ideal = along * Math.tan(GLIDE.deg * Math.PI / 180)
      const dy = b.y - ideal
      const rw = L.hdg > 0 ? '09' : '27'
      parts.push(Math.abs(dy) < 12 ? t('{rw} 下滑道 ◆ 在道上', { rw }) : dy > 0 ? t('{rw} 下滑道 ▼ 偏高 {n} m', { rw, n: Math.round(dy) }) : t('{rw} 下滑道 ▲ 偏低 {n} m', { rw, n: Math.round(-dy) }))
      parts.push(Math.abs(cross) < 15 ? t('中线 ◆') : cross > 0 ? t('中线 偏南 {n} m', { n: Math.round(cross) }) : t('中线 偏北 {n} m', { n: Math.round(-cross) }))
      break
    }
    hud.setInfo(parts.length ? parts.join(' · ') : null)
  }

  /** 空域管制 + 掠过金沙 */
  const airWatch = () => {
    const ac = fc.active
    if (!ac || ac.wrecked || ac.body.onGround) return
    const b = ac.body
    if (b.y < CBD_LOW && b.x > CBD.minX && b.x < CBD.maxX && b.z > CBD.minZ && b.z < CBD.maxZ) game.law.airspace('cbd', 0.4, game.ctx)
    if (!flyby && b.y < MBS_FLYBY.maxY && Math.hypot(b.x - MBS_FLYBY.x, b.z - MBS_FLYBY.z) < MBS_FLYBY.r) {
      flyby = true
      game.events.emit('flightFlyby', { landmark: 'mbs' })
    }
  }
  game.events.on('flightLanded', ({ surface, x, z }) => {
    if (surface !== 'land') return
    const lane = game.ctx.graph.nearestLane(x, z)
    if (lane && lane.dist < 6) game.law.airspace('road', 0.5, game.ctx)
  })

  /** 手机「飞行」页 */
  const usd = (n: number) => `$${Math.round(n).toLocaleString('en-US')}`
  const view = (): AppView => {
    const st = game.progress.stats
    const lock = jobs.lockReason()
    const hangar = game.pois.byId(HANGAR_POI)
    const dist = hangar ? Math.hypot(hangar.door.x - game.player.worldX, hangar.door.z - game.player.worldZ) : 0
    const jobItem: AppItem = {
      title: JOB_TITLE[jobs.kind], desc: JOB_DESC[jobs.kind],
      value: t('今天 {a}/{b}', { a: jobs.s.day === game.clock.day ? jobs.s.today : 0, b: FLIGHT_JOBS_PER_DAY }),
      status: jobs.mission ? t('进行中：{d}', { d: jobs.hudCard()?.desc ?? '' }) : lock ?? undefined,
      tone: lock && !jobs.mission ? 'locked' : undefined,
      actions: jobs.mission ? [{ label: t('放弃'), onClick: () => jobs.cancel() }] : [{ label: t('接单'), disabled: !!lock, onClick: () => { const r = jobs.start(); if (r !== true) game.hud.toast(r, 3); else game.phone.set(false) } }],
    }
    const planes: AppItem[] = owned.list.map((e) => {
      const it = shopItem(e.id)
      const info = owned.info(e.id)
      return { title: it?.name ?? e.id, desc: it?.desc, status: info?.status, tone: e.wrecked ? undefined : 'owned' as const }
    })
    if (!planes.length) {
      const first = SHOP.find((x) => x.kind === 'aircraft' && (!x.roles.length || x.roles.includes(game.ctx.role.id)))
      planes.push({ title: t('还没有自己的飞机'), desc: first ? t('手机「商店」买「{name}」（{p}，Lv{lv}），停在机库随取随飞。', { name: first.name, p: usd(first.price), lv: unlockLevel(game.ctx.role.id, first.id) }) : undefined })
    }
    const rentLk = rentLock()
    const rentItem: AppItem = rental
      ? { title: t('租机'), desc: t('你的租机在 {n} 号停机位（今天内有效）', { n: (rentInfo?.stand ?? 0) + 1 }), tone: 'owned' }
      : { title: t('租机'), desc: t('机库租一架 Cessna：{p}/天 · 坠毁自付 {i}', { p: usd(RENT_PRICE), i: usd(RENT_INSURANCE) }), status: rentLk ?? t('到机库门口租，或直接接单（自动租一架）'), tone: rentLk ? 'locked' : undefined }
    /** 航站楼 / 机库一行：导航 + Taxi / Grab 叫车直达门口 */
    const airRow = (poiId: string, fallback: string, desc: string, navLabel: string): AppItem => {
      const ride = game.poiRideActions(poiId)
      return { title: game.pois.byId(poiId)?.name ?? fallback, desc, status: ride?.reason ?? undefined, actions: [{ label: navLabel, onClick: () => game.navTo(poiId) }, ...(ride?.actions ?? [])] }
    }
    return {
      lines: [
        t('滨海南机场 · 机库距你 {d}', { d: dist >= 1000 ? `${(dist / 1000).toFixed(1)} km` : `${Math.round(dist)} m` }),
        t('起飞 {f} · 落地 {l} · 空中航程 {km} km · 飞行工作 {n} 单', { f: st.flights, l: st.landings, km: st.flightKm.toFixed(1), n: st.airJobs }),
      ],
      sections: [
        { title: t('机场'), items: [airRow(AIRPORT_POI, t('航站楼'), t('24 小时开放'), t('导航到航站楼')), airRow(HANGAR_POI, t('机库'), t('租机 / 取机 / 维修 / 接单'), t('导航到机库'))] },
        { title: t('飞行工作'), items: [jobItem] },
        { title: t('我的飞机'), items: planes },
        { title: t('租机'), items: [rentItem] },
      ],
      log: jobs.s.log,
    }
  }

  const api: AviationApi = {
    get fleet() { return fleet },
    get active() { return fc.active },
    spawn, remove, freeStand,
    autopilot: (a) => fc.autopilot(a),
  }
  apis.set(game, api)

  game.addPlugin({
    id: 'aviation',
    update(dt) {
      fc.update(dt)
      const night = game.dayNight.lights
      for (const a of fleet) a.setNight(night)
      recycle()
      jobs.update(dt)
      avionics()
      airWatch()
    },
    keyF() {
      const pl = game.player
      if (pl.piloting && fc.active) {
        if (fc.active.wrecked) return true
        const r = fc.leave()
        if (r !== true) game.hud.toast(r, 2)
        return true
      }
      const ac = boardable()
      if (ac) { board(ac); return true }
      return false
    },
    driveCamera: (dt) => fc.driveCamera(dt),
    controlMode: () => (fc.active ? 'fly' : null),
    audioMount: () => fc.audioMount(),
    hint() {
      const pl = game.player
      if (fc.active) return fc.hint()
      if (boardable()) return game.input.touch ? t('点「上车」登机') : t('按 F 登机')
      void pl
      return null
    },
    hudCard: () => jobs.hudCard(),
    navPath: () => jobs.navPath(),
    app: { name: 'flight', title: t('飞行'), view },
    navTarget() {
      const jt = jobs.navTarget()
      if (jt) return jt
      // 刚租到还没登过机：导航到停机位
      if (!rental || !rentInfo || rentInfo.used || fc.active) return null
      const pl = game.player
      if (Math.hypot(rental.x - pl.worldX, rental.z - pl.worldZ) < 8) return null
      return { x: rental.x, z: rental.z }
    },
    onBustOrDeath() { if (jobs.mission) jobs.fail(game.state === 'busted' ? t('被捕') : t('倒下')); dropActive() },
    poiButtons,
    serialize(): AviationSave {
      let r: RentalSave | null = null
      if (rental && rentInfo) {
        // 空中 / 驾驶中存档：租机回到原停机位；地面停着：存实际位置
        const parked = fc.active !== rental && rental.body.onGround
        r = parked ? { ...rentInfo, x: rental.x, z: rental.z, yaw: rental.yaw } : { ...rentInfo, x: STANDS[rentInfo.stand].x, z: STANDS[rentInfo.stand].z, yaw: STANDS[rentInfo.stand].yaw }
      }
      return { v: 1, rental: r, crashes: crashCount, flights, landings, own: owned.serialize(), jobs: jobs.serialize() }
    },
    restore(s) {
      jobs.restore()
      dropActive()
      for (const a of [...fleet]) remove(a)
      rental = null; rentInfo = null
      const d = (s ?? null) as Partial<AviationSave> | null
      crashCount = d?.crashes ?? 0; flights = d?.flights ?? 0; landings = d?.landings ?? 0
      const r = d?.rental
      if (r && r.day === game.clock.day) {
        const ac = spawn({ id: 'rental', owner: 'rent', at: { x: r.x, z: r.z, yaw: r.yaw } })
        if (ac) { rental = ac; rentInfo = { ...r } }
      }
      owned.restore(d?.own)
      jobs.restore(d?.jobs)
    },
    debug: () => ({
      /** 租机（扣 $300）；返回 true 或原因 */
      rent: () => rent(),
      /** 直接登上租机（不在旁边时先把玩家放到机门外） */
      board: () => {
        const ac = rental ?? fleet[0]
        if (!ac) return false
        if (game.player.inVehicle) game.player.exit(game.world)
        if (!fc.active) { const s = fc.exitSpot(ac); game.player.place(s.x, s.z, s.yaw); board(ac) }
        return true
      },
      leave: () => fc.leave(),
      /** 当前可登机的飞机 id（步行 7 m 内） */
      get boardable() { const a = boardable(); return a ? a.id : null },
      get playerXZ() { return { x: game.player.x, z: game.player.z, onFoot: game.player.onFoot, mount: !!game.player.mount } },
      /** 把当前驾驶的飞机放到 (x,y,z)，空速 spd m/s、航向 hdg（rad，车辆 yaw 约定）、俯仰 pitchDeg；没在驾驶时先租（免费）并登机 */
      place: (x: number, y: number, z: number, spd = 0, hdg = 0, pitchDeg = 0) => {
        if (!fc.active) {
          let ac: Aircraft | null = rental ?? fleet[0] ?? null
          if (!ac) { ac = spawn({ id: 'rental', owner: 'rent', at: { x, z, yaw: hdg } }); if (ac) { rental = ac; rentInfo = { day: game.clock.day, x, z, yaw: hdg, stand: 0, used: true } } }
          if (!ac) return false
          if (game.player.inVehicle) game.player.exit(game.world)
          const ac2: Aircraft = ac
          board(ac2)
        }
        fc.place(x, y, z, spd, hdg, pitchDeg)
        return true
      },
      autopilot: (a: Parameters<FlightControl['autopilot']>[0]) => fc.autopilot(a),
      /** 视角 'chase' | 'cockpit' */
      view: (v?: 'chase' | 'cockpit') => { if (v) fc.view = v; return fc.view },
      get state() { return fc.debugState(crashCount) },
      get crashCount() { return crashCount },
      get flights() { return flights },
      get landings() { return landings },
      get rental() { return rental ? { x: rental.x, z: rental.z, info: rentInfo } : null },
      get fleet() { return fleet.map((a) => ({ id: a.id, owner: a.owner, x: +a.x.toFixed(1), y: +a.y.toFixed(1), z: +a.z.toFixed(1) })) },
      /** 高度图采样（m） */
      hf: (x: number, z: number, r = 0) => fc.heightAt(x, z, r),
      get fx() { return fx.last },
      api,
      // ---- AIR.5 ----
      /** 可接的飞行工作（本身份一种） */
      get jobs() { return [{ kind: jobs.kind, job: jobs.jobId, title: JOB_TITLE[jobs.kind], lock: jobs.lockReason(), today: jobs.s.day === game.clock.day ? jobs.s.today : 0, perDay: FLIGHT_JOBS_PER_DAY }] },
      /** 接单（kind 只能是本身份那种） */
      start: (kind?: string) => (kind && kind !== jobs.kind ? t('没有这种飞行工作') : jobs.start()),
      get mission() { return jobs.debugState() },
      forceComplete: () => jobs.forceComplete(),
      cancel: () => { jobs.cancel(); return true },
      /** 任务感知自动驾驶：飞向目标、自动拍照 / 投放、完成后自动进近降落 */
      autofly: (on = true) => { jobs.autofly = on; if (!on) fc.autopilot(null); return on },
      /** 空中按 Space（拍照 / 投放） */
      action: () => { const ac = fc.active; const m = jobs.mission; if (!ac || !m?.action) return false; return m.action({ b: ac.body, airborne: !ac.body.onGround, speed: airspeed(ac.body), dt: 0, time: game.time }) },
      get own() { return owned.debug() },
      repair: (id: string) => owned.repair(id),
      fetch: (id: string) => owned.fetch(id),
      /** 登上自有飞机（不在旁边时先把玩家放到机门外） */
      boardOwn: (id?: string) => {
        const ac = id ? owned.planes.get(id) : owned.available()
        if (!ac) return false
        if (game.player.inVehicle) game.player.exit(game.world)
        if (!fc.active) { const sp = fc.exitSpot(ac); game.player.place(sp.x, sp.z, sp.yaw); board(ac) }
        return true
      },
      /** 调试：把正在驾驶的飞机摆到 09 号跑道头（朝东、静止） */
      lineUp: () => { if (!fc.active) return false; fc.place(TAKEOFF_09.x, 0, TAKEOFF_09.z, 0, TAKEOFF_09.yaw, 0); return true },
      get avionics() { return { owned: game.assets.owns('upg_avionics'), altHold } },
      get law() { return { stars: game.law.stars, heat: +game.law.pursuitLevel.toFixed(2), airspace: game.law.airspaceCount } },
    }),
  })
}
