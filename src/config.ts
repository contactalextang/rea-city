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

// 通用路网参数（真实路网 / OSM 切片用；方格城仍沿用上面的 GRID/ROAD 系列常量）
export const SCALE = 1             // 世界单位 / 米
export const DRIVE_SIDE = -1       // 行驶方向：-1 靠左（新加坡），+1 靠右
export const LANE_W = 3.3          // 标准车道宽 (m)
export const SIDEWALK_W = 2        // 人行道宽 (m)
export const GAME_HOUR_SEC = 180   // 游戏内 1 小时 = 现实 180 秒

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
  taxi:    { accel: 9,  brake: 20, maxFwd: 30, maxRev: 8, drag: 0.10, rolling: 1.2, maxSteer: 3.0, grip: 0.80, gripDrift: 0.955 },
  /** 金领豪车：低矮跑车，加速与极速更高 */
  luxury:  { accel: 15, brake: 26, maxFwd: 42, maxRev: 9, drag: 0.08, rolling: 1.1, maxSteer: 3.1, grip: 0.85, gripDrift: 0.955 },
  /** SBS/SMRT 单层巴士：笨重、转向慢 */
  bus:     { accel: 5,  brake: 14, maxFwd: 22, maxRev: 5, drag: 0.10, rolling: 1.5, maxSteer: 2.2, grip: 0.86, gripDrift: 0.97 },
}
/** 的士涂装：Comfort 蓝 / CityCab 黄 / Strides 青柠 / TransCab 红 */
export const TAXI_COLORS = [0x1f5fbf, 0xf2c516, 0x9acd32, 0xc0392b] as const
/** LTA 巴士绿 */
export const BUS_COLOR = 0x4caf50
export type VehicleKind = keyof typeof VEHICLE_PARAMS

export const CAR_LEN = 4.6
export const CAR_WID = 2.1
export const CAR_CIRCLE_OFF = 1.2   // 前后两个圆心距车中心
export const CAR_CIRCLE_R = 1.1
/** 巴士：12 m × 2.5 m × 3.2 m；碰撞用 4 个圆（前、后、中前、中后，前两个与轿车圆序号兼容） */
export const BUS_LEN = 12
export const BUS_WID = 2.5
export const BUS_HEIGHT = 3.2
export const BUS_CIRCLE_OFFS = [4.5, -4.5, 1.5, -1.5] as const
export const BUS_CIRCLE_R = 1.3
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
