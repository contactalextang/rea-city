import type { FlightBody } from '../../../physics/ArcadeFlight'
import type { AutopilotTarget } from '../Autopilot'
import type { MissionVisuals } from './Visuals'
import type { FlightJobKind } from './params'

/**
 * 飞行工作任务基类（AIR.5b）：每帧拿到飞机状态推进目标；目标全部完成（done）后由 FlightJobs 接管「回跑道落地停稳 → 结算」。
 * 子类只管本工作的目标、评分、HUD 文案、导航点与调试自动驾驶（autofly）。
 */
export interface FlyState {
  b: FlightBody
  /** 空中（离地） */
  airborne: boolean
  /** 空速 m/s */
  speed: number
  dt: number
  /** 游戏时间（秒，game.time） */
  time: number
}

export interface MissionHost {
  /** 高度图（天际线 + 地标），r > 0 取半径内最大值 */
  hf(x: number, z: number, r?: number): number
  toast(s: string, sec?: number): void
  visuals: MissionVisuals
  /** 随机数（测试可固定种子） */
  rand(): number
}

export interface NavPoint { x: number; z: number; y?: number }

export abstract class FlightMission {
  abstract readonly kind: FlightJobKind
  /** 目标全部完成 → 回跑道 */
  done = false
  /** 接单时刻（game.time），时间奖励用 */
  startedAt = 0
  constructor(protected host: MissionHost) {}

  /** 每步推进（只在驾驶本单飞机时调用） */
  abstract update(s: FlyState): void
  /** 当前目标点（小地图 / 光柱）；done 后为 null（由 FlightJobs 指向跑道） */
  abstract target(): NavPoint | null
  /** 剩余目标折线（小地图航线） */
  abstract path(): NavPoint[]
  /** HUD 任务卡描述 */
  abstract desc(s: FlyState | null): string
  /** 目标进度「a/b」 */
  abstract progress(): string
  /** 落地前的报酬（未乘落地倍率）与明细 */
  abstract payout(time: number): { amount: number; detail: string }
  /** Space（空中）：拍照 / 投放；返回 true = 已处理 */
  action?(s: FlyState): boolean
  /** 任务卡副行（操作提示） */
  hint?(): string
  /** 调试自动驾驶：飞向当前目标的指令（done 后由 FlightJobs 接管降落） */
  abstract auto(s: FlyState): AutopilotTarget
  /** 调试自动驾驶：此刻是否该自动按 Space */
  autoAction?(s: FlyState): boolean
  /** 调试：任务细节 */
  abstract debug(): unknown
  /** 清理本单 3D 对象 */
  dispose() { this.host.visuals.clear() }
}

// ---------- 共用几何 ----------
export const DEG = Math.PI / 180
export const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v)
export const wrapAngle = (a: number) => Math.atan2(Math.sin(a), Math.cos(a))
export const hdist = (ax: number, az: number, bx: number, bz: number) => Math.hypot(bx - ax, bz - az)
/** 从 (x,z) 指向 (tx,tz) 的方位（车辆 yaw 约定） */
export const bearing = (x: number, z: number, tx: number, tz: number) => Math.atan2(tx - x, tz - z)
export const fmtM = (m: number) => (m >= 1000 ? `${(m / 1000).toFixed(1)} km` : `${Math.round(m)} m`)
export const fmtT = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`

/**
 * 调试自动驾驶的安全巡航高度：从 (x,z) 到 (tx,tz) 直线上高度图最大值 + margin（至少 want）。
 * 每 40 m 采样一次、半径 r（默认 30 m；自动驾驶转弯会偏离直线，调用方可放宽）。
 */
export function safeAlt(host: MissionHost, x: number, z: number, tx: number, tz: number, want: number, margin = 60, r = 30) {
  const L = hdist(x, z, tx, tz), n = Math.max(1, Math.ceil(L / 40))
  let top = 0
  for (let i = 0; i <= n; i++) top = Math.max(top, host.hf(x + (tx - x) * i / n, z + (tz - z) * i / n, r))
  return Math.max(want, top + margin)
}

/** 从数组里随机挑 k 个、保持原顺序 */
export function pickOrdered<T>(arr: readonly T[], k: number, rand: () => number): T[] {
  const idx = arr.map((_, i) => i)
  while (idx.length > k) idx.splice(Math.floor(rand() * idx.length), 1)
  return idx.map((i) => arr[i])
}
