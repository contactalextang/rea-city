import type { Game } from '../../core/Game'
import type { Poi } from '../../systems/Poi'
import type { PanelButton } from '../../ui/Panels'
import type { SgWorld } from '../../world/SgWorld'
import { spend, charge } from '../../systems/Wallet'
import { Aircraft } from '../../entities/Aircraft'
import { HANGAR_POI, STANDS } from '../../world/Airfield'
import { FlightHud } from './FlightHud'
import { CrashFx } from './Crash'
import { FlightControl, type CrashReason } from './Flight'
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

export const RENT_PRICE = 300
export const RENT_INSURANCE = 2000
/** 下机后走远多少米回收租机 */
const RECYCLE_DIST = 200
/** 登机距离（m，步行，到机身中心；翼展 11 m，站在翼下即可） */
const BOARD_DIST = 7

interface RentalSave { day: number; x: number; z: number; yaw: number; stand: number; used: boolean }
interface AviationSave { v: 1; rental: RentalSave | null; crashes: number; flights: number; landings: number }

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
    onTakeoff: () => { flights++ },
    onLanded: () => { landings++ },
    onDropped: (ac, airborne) => { if (airborne || ac.wrecked) remove(ac) },
  })

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

  const rent = (): true | string => {
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
    } else game.hud.toast(t('飞机坠毁'), 4)
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

  const poiButtons = (poi: Poi): PanelButton[] => {
    if (poi.id !== HANGAR_POI) return []
    if (rental) {
      const n = rentInfo ? rentInfo.stand + 1 : 1
      return [{ label: t('你的租机在 {n} 号停机位', { n }), note: t('今天内有效'), disabled: true, onClick: () => {} }]
    }
    const poor = game.player.money < RENT_PRICE
    return [{
      label: t('租一架 Cessna（${n}）', { n: RENT_PRICE }), note: poor ? t('钱不够') : t('当天有效 · 坠毁自付 ${n}', { n: RENT_INSURANCE.toLocaleString() }), disabled: poor,
      onClick: () => { const r = rent(); if (r !== true) game.hud.toast(r, 2.5); else game.closePanel() },
    }]
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
    navTarget() {
      // 刚租到还没登过机：导航到停机位
      if (!rental || !rentInfo || rentInfo.used || fc.active) return null
      const pl = game.player
      if (Math.hypot(rental.x - pl.worldX, rental.z - pl.worldZ) < 8) return null
      return { x: rental.x, z: rental.z }
    },
    onBustOrDeath() { dropActive() },
    poiButtons,
    serialize(): AviationSave {
      let r: RentalSave | null = null
      if (rental && rentInfo) {
        // 空中 / 驾驶中存档：租机回到原停机位；地面停着：存实际位置
        const parked = fc.active !== rental && rental.body.onGround
        r = parked ? { ...rentInfo, x: rental.x, z: rental.z, yaw: rental.yaw } : { ...rentInfo, x: STANDS[rentInfo.stand].x, z: STANDS[rentInfo.stand].z, yaw: STANDS[rentInfo.stand].yaw }
      }
      return { v: 1, rental: r, crashes: crashCount, flights, landings }
    },
    restore(s) {
      dropActive()
      for (const a of [...fleet]) if (a.owner === 'rent') remove(a)
      rental = null; rentInfo = null
      const d = (s ?? null) as Partial<AviationSave> | null
      crashCount = d?.crashes ?? 0; flights = d?.flights ?? 0; landings = d?.landings ?? 0
      const r = d?.rental
      if (r && r.day === game.clock.day) {
        const ac = spawn({ id: 'rental', owner: 'rent', at: { x: r.x, z: r.z, yaw: r.yaw } })
        if (ac) { rental = ac; rentInfo = { ...r } }
      }
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
    }),
  })
}
