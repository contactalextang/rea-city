// 全局参数：城市尺寸、车道、NPC 上限、物理手感
export const GRID = 10            // 每边街区数
export const BLOCK = 40           // 街区边长 (m)
export const ROAD = 16            // 道路总宽 (m)：3 人行道 + 10 车行道 + 3 人行道
export const SIDEWALK = 3
export const PITCH = BLOCK + ROAD // 相邻路口间距
export const HALF = (GRID * PITCH) / 2
export const LANE_OFFSET = 2.5    // 车道中心距道路中线
export const SIDEWALK_OFFSET = 6.5
export const CITY_MIN = -HALF - ROAD / 2
export const CITY_MAX = HALF + ROAD / 2

export const MAX_PEDS = 60
export const MAX_TRAFFIC = 20
export const MAX_POLICE = 6
export const SPAWN_MIN = 85
export const SPAWN_MAX = 170
export const DESPAWN_DIST = 205

export const FIXED_DT = 1 / 60

export const VEHICLE_PARAMS = {
  civil:   { accel: 9,  brake: 20, maxFwd: 30, maxRev: 8, drag: 0.10, rolling: 1.2, maxSteer: 3.0, grip: 0.80, gripDrift: 0.955 },
  police:  { accel: 11, brake: 22, maxFwd: 34, maxRev: 9, drag: 0.09, rolling: 1.2, maxSteer: 3.0, grip: 0.82, gripDrift: 0.955 },
  mission: { accel: 10, brake: 20, maxFwd: 32, maxRev: 8, drag: 0.10, rolling: 1.2, maxSteer: 3.0, grip: 0.80, gripDrift: 0.955 },
}
export type VehicleKind = keyof typeof VEHICLE_PARAMS

export const CAR_LEN = 4.6
export const CAR_WID = 2.1
export const CAR_CIRCLE_OFF = 1.2   // 前后两个圆心距车中心
export const CAR_CIRCLE_R = 1.1
export const PED_R = 0.4

export const rand = (a: number, b: number) => a + Math.random() * (b - a)
export const randInt = (a: number, b: number) => Math.floor(rand(a, b + 1))
export const pick = <T>(arr: readonly T[]): T => arr[Math.floor(Math.random() * arr.length)]
export const clamp = (v: number, a: number, b: number) => (v < a ? a : v > b ? b : v)
export const lerp = (a: number, b: number, t: number) => a + (b - a) * t
export const wrapAngle = (a: number) => {
  while (a > Math.PI) a -= Math.PI * 2
  while (a < -Math.PI) a += Math.PI * 2
  return a
}
export const dampAngle = (cur: number, target: number, rate: number, dt: number) =>
  cur + wrapAngle(target - cur) * (1 - Math.exp(-rate * dt))
export const damp = (cur: number, target: number, rate: number, dt: number) =>
  cur + (target - cur) * (1 - Math.exp(-rate * dt))
