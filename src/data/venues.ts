import type { Poi, Side } from '../systems/Poi'
import type { RoadGraph } from '../world/RoadGraph'

/**
 * P10 娱乐场馆：赌场 / 夜店 / 街头赛车 / 射击俱乐部。
 * 一份表两种落点：sg 真实城市按 anchor 吸附到最近车道旁的人行道（运行时，不改离线流水线），
 * 方格城 gridPois() 按 grid 槽位（街区 + 朝向）合成。POI id = 场馆 id，poi.meta.venue = 场馆 id。
 *
 * 后续子系统（P10.B 赌场 / C 赛车 / D 射击 / E 夜店）用法：
 *   const v = venueOf(poi)            // 不是场馆返回 null
 *   if (v?.type === 'casino' && venueOpen(v, ctx.clock.hour)) …
 *   interactions.addProvider((poi) => venueOf(poi)?.id === 'casino_mbs' ? [{ label: '21 点', onClick: … }] : [])
 */
export type VenueType = 'casino' | 'club' | 'race' | 'arena'

export interface VenueDef {
  id: string
  type: VenueType
  name: string
  /** 一句话简介（面板文字） */
  desc: string
  /** 营业时间 [开, 关)（小时，关 < 开 表示跨午夜）；null = 24 小时 */
  hours: [number, number] | null
  /** sg 世界：锚点（建筑/标志物附近）；门口从这里吸附到最近车道旁的人行道，POI 标志点在门口后方 6 m */
  sg: { x: number; z: number }
  /** 方格城槽位：街区 (bi,bj) 的哪一侧，沿边弧长 t */
  grid: { bi: number; bj: number; side: Side; t?: number }
}

export const VENUES: VenueDef[] = [
  {
    id: 'casino_mbs', type: 'casino', name: '滨海湾金沙赌场 Marina Bay Sands Casino',
    desc: '24 小时营业。21 点、轮盘、骰宝、百家乐、老虎机。',
    hours: null,
    // 金沙 landmark 门口 (1326.46, 155.75) 附近；吸附时会自动避开 landmark 自己的门口
    sg: { x: 1326.46, z: 155.75 },
    grid: { bi: 7, bj: 1, side: 'S' },
  },
  {
    id: 'club_clarke_quay', type: 'club', name: '克拉码头夜店 Clarke Quay',
    desc: '河畔酒吧街。点酒、跳舞、认识新朋友。',
    hours: [21, 4],
    sg: { x: 57.7, z: -695.6 },
    grid: { bi: 3, bj: 1, side: 'E' },
  },
  {
    id: 'race_marina_bay', type: 'race', name: '滨海湾赛道 Marina Bay Street Circuit（摩天轮旁维修区）',
    desc: '夜间街头赛在这里集合报名。',
    hours: [20, 4],
    sg: { x: 1859.7, z: -759.0 },
    grid: { bi: 8, bj: 3, side: 'E' },
  },
  {
    id: 'arena_tanjong_pagar', type: 'arena', name: '丹戎巴葛射击俱乐部',
    desc: '24 小时营业。5v5 爆破 / 1v1 单挑 / 死斗。',
    hours: null,
    // Guoco Tower (-90,604) 与 Capital Tower (126.75,535.5) 之间
    sg: { x: 20, z: 570 },
    grid: { bi: 5, bj: 5, side: 'W' },
  },
]

const byId = new Map(VENUES.map((v) => [v.id, v]))
export const venueById = (id: string) => byId.get(id) ?? null
/** POI → 场馆定义（非场馆 POI 返回 null） */
export function venueOf(poi: Poi | null | undefined): VenueDef | null {
  if (!poi) return null
  const id = typeof poi.meta?.venue === 'string' ? poi.meta.venue : poi.id
  return byId.get(id) ?? null
}
/** 当前小时是否营业 */
export function venueOpen(v: VenueDef, hour: number): boolean {
  if (!v.hours) return true
  const [a, b] = v.hours, h = ((hour % 24) + 24) % 24
  return a < b ? h >= a && h < b : h >= a || h < b
}
const hh = (h: number) => `${String(Math.floor(h)).padStart(2, '0')}:${String(Math.round((h % 1) * 60)).padStart(2, '0')}`
/** 营业时间文字：`24 小时营业` / `营业 21:00–04:00` */
export function hoursText(v: VenueDef) { return v.hours ? `营业 ${hh(v.hours[0])}–${hh(v.hours[1])}` : '24 小时营业' }

/**
 * sg 世界：把场馆门口吸附到 anchor 最近车道所在边的行驶侧人行道上，朝向马路。
 * 与已有 POI 门口（及其他场馆）距离 < 9 m 时沿边挪动（交互距离 3.5 m，避免 E 打开别的地点）；
 * blocked(x,z) 为真（落在建筑里）也挪动。
 */
export function sgVenuePois(graph: RoadGraph, existing: readonly Poi[], blocked?: (x: number, z: number) => boolean): Poi[] {
  const out: Poi[] = []
  const tmp = { x: 0, z: 0 }, ln = { x: 0, z: 0 }
  const clash = (x: number, z: number) =>
    [...existing, ...out].some((p) => Math.hypot(p.door.x - x, p.door.z - z) < 9) || !!blocked?.(x, z)
  for (const v of VENUES) {
    const lane = graph.nearestLane(v.sg.x, v.sg.z)
    const e = lane.edge
    const lo = Math.min(4, e.length / 2), hi = Math.max(lo, e.length - 4)
    let best: { x: number; z: number; t: number } | null = null
    // 先在原位，之后 ±6 m、±12 m … 交替搜索，直到不冲突
    for (let k = 0; k <= 16 && !best; k++) {
      const off = k === 0 ? 0 : Math.ceil(k / 2) * 6 * (k % 2 ? 1 : -1)
      const t = Math.max(lo, Math.min(hi, lane.t + off))
      graph.sidewalkPoint(e, t, tmp)
      if (!clash(tmp.x, tmp.z)) best = { x: tmp.x, z: tmp.z, t }
    }
    if (!best) { graph.sidewalkPoint(e, lane.t, tmp); best = { x: tmp.x, z: tmp.z, t: lane.t } }
    graph.lanePoint(e, best.t, ln)
    const yaw = Math.atan2(ln.x - best.x, ln.z - best.z)   // 面向马路
    const r2 = (n: number) => Math.round(n * 100) / 100
    // 标志点放在门口后方 6 m（建筑一侧），小地图图标贴着门口而不是远处的建筑中心
    const bx = best.x - Math.sin(yaw) * 6, bz = best.z - Math.cos(yaw) * 6
    out.push({ id: v.id, type: v.type, name: v.name, x: r2(bx), z: r2(bz), door: { x: r2(best.x), z: r2(best.z), yaw: Math.round(yaw * 1000) / 1000 }, meta: { venue: v.id } })
  }
  return out
}
