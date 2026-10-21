import type { RoadEdge, RoadNode } from '../world/RoadGraph'
import { taxiFare, isTaxiPeak } from './Jobs'

/**
 * P11.B 叫车（手机 Taxi / Grab，付费黑屏直达）：纯逻辑，便于单测（scripts/test/ride-sim.ts）。
 * - 路程：路网最短路（RoadGraph.routeDist），不可达 / 离路太远回退直线 × 1.3
 * - Taxi：打表价 taxiFare(dist, 0, isTaxiPeak(h), 0)，等车 3–6 分钟
 * - Grab：起价 + 每公里 + 每分钟 + 平台费，高峰 surge ×1.3–1.8（按小时确定），雨天再 ×1.2；等车 2–4 分钟
 * - 车程：距离 ÷ 30 km/h（早晚高峰 22 km/h）+ 等车
 */
export type RideKind = 'taxi' | 'grab'

export const RIDE = {
  /** 平峰 / 高峰平均车速（km/h，含红绿灯） */
  speedKmh: 30, rushSpeedKmh: 22,
  /** 早晚高峰（影响车速与 Grab surge） */
  rush: [[7, 9.5], [17.5, 20]] as [number, number][],
  grab: {
    base: 3, perKm: 0.7, perMin: 0.2, platform: 0.9, min: 6,
    /** 按小时的 surge 表（[起, 止, 倍率]，止不含）；不在表内 = 1 */
    surge: [[7, 8, 1.6], [8, 9.5, 1.4], [17.5, 19.5, 1.8], [19.5, 21, 1.5], [22, 24, 1.3], [0, 1, 1.3]] as [number, number, number][],
    rainMul: 1.2,
  },
  /** 直线回退系数（路网不可达） */
  detour: 1.3,
  /** 目的地太近不接单（m） */
  minDist: 150,
} as const

export interface RideQuote {
  kind: RideKind
  /** 路程（m） */
  distM: number
  /** 总耗时（分钟，含等车） */
  minutes: number
  /** 车费（$，两位小数） */
  fare: number
  /** 等车（分钟） */
  waitMin: number
  /** Grab 动态加价倍率（Taxi 恒为 1） */
  surge: number
}

const round2 = (n: number) => Math.round(n * 100) / 100
const hour24 = (h: number) => ((h % 24) + 24) % 24
const inRanges = (h: number, rs: readonly (readonly [number, number])[]) => rs.some(([a, b]) => h >= a && h < b)

export function isRushHour(hour: number) { return inRanges(hour24(hour), RIDE.rush) }

/** Grab 动态加价：按小时查表（确定性），雨天 ×1.2 */
export function grabSurge(hour: number, rain = false) {
  const h = hour24(hour)
  const hit = RIDE.grab.surge.find(([a, b]) => h >= a && h < b)
  return round2((hit ? hit[2] : 1) * (rain ? RIDE.grab.rainMul : 1))
}

/** 等车分钟：Taxi 3–6，Grab 2–4（高峰 / 深夜 / 雨天更久） */
export function waitMinutes(kind: RideKind, hour: number, rain = false) {
  const h = hour24(hour)
  const night = h < 6
  if (kind === 'taxi') return Math.min(6, (isRushHour(h) ? 5 : night ? 5 : 3) + (rain ? 1 : 0))
  return Math.min(4, (isRushHour(h) ? 3 : 2) + (rain ? 1 : 0))
}

/** 报价：distM = 路程（m），hour = 当前游戏小时，rain = 下雨 */
export function quote(kind: RideKind, distM: number, hour: number, rain = false): RideQuote {
  const d = Math.max(0, distM)
  const waitMin = waitMinutes(kind, hour, rain)
  const speed = isRushHour(hour) ? RIDE.rushSpeedKmh : RIDE.speedKmh
  const driveMin = (d / 1000 / speed) * 60
  const minutes = Math.max(1, Math.round(driveMin + waitMin))
  if (kind === 'taxi') return { kind, distM: d, minutes, fare: taxiFare(d, 0, isTaxiPeak(hour24(hour)), 0), waitMin, surge: 1 }
  const G = RIDE.grab
  const surge = grabSurge(hour, rain)
  const raw = (G.base + (d / 1000) * G.perKm + driveMin * G.perMin) * surge + G.platform
  return { kind, distM: d, minutes, fare: round2(Math.max(G.min, raw)), waitMin, surge }
}

/** RoadGraph 的最小接口（单测可以传假图） */
export interface RouteGraph {
  nearestLane(x: number, z: number): { edge: RoadEdge; t: number; dist: number }
  nearestNode(x: number, z: number): RoadNode
  routeDist(e: RoadEdge, t: number, target: RoadNode): number
}
interface Pt { x: number; z: number }

/** 路网路程：起点上路 + 最短路 + 终点节点到门口；不可达 / 离谱（> 直线 4 倍）回退直线 × 1.3 */
export function routeDistance(g: RouteGraph | null, from: Pt, to: Pt): number {
  const straight = Math.hypot(to.x - from.x, to.z - from.z)
  const fallback = straight * RIDE.detour
  if (!g) return fallback
  const lane = g.nearestLane(from.x, from.z)
  if (!lane || !(lane.dist < 80)) return fallback
  const node = g.nearestNode(to.x, to.z)
  const tail = Math.hypot(node.x - to.x, node.z - to.z)
  if (tail > 150) return fallback
  const d = lane.dist + g.routeDist(lane.edge, lane.t, node) + tail
  if (!Number.isFinite(d) || d > straight * 4 + 200) return fallback
  return Math.max(straight, d)
}

/** 叫车前的状态（Game 填） */
export interface RideState {
  /** Game.state（只有 'play' 能叫车） */
  state: string
  chase: boolean
  stars: number
  /** 进行中的主动工作标题（的士 / 外卖 / 偷车…），无则 null */
  job: string | null
  /** 到目的地的路程（m），可选：太近不接单 */
  distM?: number
}
/** 返回 null = 可以叫车，否则拒绝原因 */
export function canRide(s: RideState): string | null {
  if (s.chase || s.stars > 0) return '被通缉中，司机不敢接单'
  if (s.state !== 'play') return '现在不能叫车'
  if (s.job) return `正在进行「${s.job}」，先收工`
  if (s.distM !== undefined && s.distM < RIDE.minDist) return '目的地就在附近，走过去吧'
  return null
}

export const RIDE_LABEL: Record<RideKind, string> = { taxi: 'Taxi', grab: 'Grab' }
