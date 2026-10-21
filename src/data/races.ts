import { PITCH, HALF } from '../config'
import { clampTier } from './tiers'

/**
 * P10.C 街头赛车路线。
 * wps = 途经点：[x, z] 或 [x, z, hx, hz]（显式行驶方向）；运行时用 RoadGraph.nearestLane 吸附到带方向的路段，
 * 再按"边 → 边"最短路（不掉头）串起来、平滑重采样（src/activities/race/Route.ts）。
 * loop 路线第一个途经点 = 起终点线；sprint 从第一个点开到最后一个点。
 * sg 坐标：x 东、z 南（负 z = 北）。途经点由 public/world/sg/graph.json 的路名查得（离线脚本 scratchpad/p10c/route.py 验证连通）。
 */
export interface RaceRouteDef {
  id: string
  world: 'sg' | 'grid'
  name: string
  /** 一句话简介 + 途经道路 */
  desc: string
  loop: boolean
  laps: number
  wps: number[][]
  /** 街头赛报名费 / 固定奖金 */
  entry: number
  prize: number
  /** 难度星级 1–3 */
  stars: number
  /** 需要的等级（缺省 1） */
  minLevel?: number
  /** 需要的成长解锁 id（progression.ts，如 race_pro） */
  unlock?: string
  /** 三辆对手的车手水平（≈ 弯道/直道速度系数，1 = 满速线） */
  ai: [number, number, number]
  /** 白天合法赛道日（封路清空交通、无警察）；缺省不开 */
  legal?: { entry: number; prize: number }
}

/** 方格城节点 (i,j) 的世界坐标（可取小数：路段中点） */
const gp = (i: number, j: number) => [i * PITCH - HALF, j * PITCH - HALF]
/** 方格城一条腿 (i0,j0)→(i1,j1) 的中点 + 方向 */
const leg = (i0: number, j0: number, i1: number, j1: number, u = 0.5) => {
  const [ax, az] = gp(i0, j0), [bx, bz] = gp(i1, j1)
  const l = Math.hypot(bx - ax, bz - az) || 1
  return [ax + (bx - ax) * u, az + (bz - az) * u, (bx - ax) / l, (bz - az) / l]
}

export const RACE_ROUTES: RaceRouteDef[] = [
  // ---------- sg ----------
  {
    id: 'sg_marina_gp', world: 'sg', name: '滨海湾街道赛道',
    desc: '仿 F1 Marina Bay Street Circuit：摩天轮下 Raffles Ave 起跑 → Stamford Rd → North Bridge Rd（政府大厦 / Padang）→ South Bridge Rd 过河 → CBD → Marina Blvd → Bayfront Ave（金沙前）→ Temasek Ave → Raffles Blvd → Republic Blvd 弯回到发车区。',
    loop: true, laps: 2,
    wps: [[1690, -776], [1300, -799], [870, -1051], [300, -500], [1000, 285], [1290, 230], [1440, 0], [1585, -330], [1598, -880], [1700, -975], [1830, -925]],
    entry: 300, prize: 1500, stars: 2, ai: [0.86, 0.92, 0.97],
    legal: { entry: 150, prize: 600 },
  },
  {
    id: 'sg_marina_pro', world: 'sg', name: '滨海湾大奖赛（高级）',
    desc: '同一条滨海湾街道赛道，对手是职业车手（更快的车、更狠的弯道），奖金翻几倍。',
    loop: true, laps: 2,
    wps: [[1690, -776], [1300, -799], [870, -1051], [300, -500], [1000, 285], [1290, 230], [1440, 0], [1585, -330], [1598, -880], [1700, -975], [1830, -925]],
    entry: 1200, prize: 8000, stars: 3, unlock: 'race_pro', ai: [0.95, 1.0, 1.05],
    legal: { entry: 600, prize: 3000 },
  },
  {
    id: 'sg_shenton_sprint', world: 'sg', name: '申顿道—滨海林荫道冲刺',
    desc: '乌节路不在地图切片内，改走 CBD 长直主路：Anson Rd → Robinson Rd → Finlayson Green → Marina Blvd 一路冲到滨海南。点到点。',
    loop: false, laps: 1,
    wps: [[-250, 1040], [200, 480], [500, 50], [1000, 285], [1500, 605], [1990, 921]],
    entry: 200, prize: 900, stars: 1, ai: [0.84, 0.9, 0.95],
    legal: { entry: 100, prize: 400 },
  },
  {
    id: 'sg_ecp_sprint', world: 'sg', name: '东海岸公园大道冲刺',
    desc: 'Sheares Ave 高架桥北上，接 East Coast Parkway 快速路往东海岸方向全油门。点到点。',
    loop: false, laps: 1,
    wps: [[1225, 650], [1450, 300], [1640, -150], [1664, -500], [2300, -1335]],
    entry: 250, prize: 1100, stars: 2, minLevel: 2, ai: [0.86, 0.92, 0.98],
    legal: { entry: 120, prize: 500 },
  },
  {
    id: 'sg_chinatown_night', world: 'sg', name: '牛车水夜跑',
    desc: '窄街多弯：South Bridge Rd → Neil Rd → Kreta Ayer Rd → Eu Tong Sen St → Temple St，3 圈。',
    loop: true, laps: 3,
    wps: [[-200, 170], [-350, 262], [-490, 150], [-480, -50], [-260, -45]],
    entry: 200, prize: 1000, stars: 3, minLevel: 2, ai: [0.85, 0.91, 0.97],
  },
  // ---------- 方格城（?world=grid） ----------
  {
    id: 'grid_loop', world: 'grid', name: '方格城环线',
    desc: '东区—北区—西区七个直角弯的街区环线，2 圈。',
    loop: true, laps: 2,
    wps: [leg(9, 3, 9, 8, 0.15), leg(9, 3, 9, 8), leg(9, 8, 5, 8), leg(5, 8, 5, 6), leg(5, 6, 2, 6), leg(2, 6, 2, 1), leg(2, 1, 9, 1), leg(9, 1, 9, 3)],
    entry: 150, prize: 700, stars: 1, ai: [0.84, 0.9, 0.96],
    legal: { entry: 80, prize: 300 },
  },
  {
    id: 'grid_sprint', world: 'grid', name: '方格城外环冲刺',
    desc: '沿城市外环跑大半圈到对角，点到点。',
    loop: false, laps: 1,
    wps: [leg(9, 4, 9, 0, 0.05), leg(9, 4, 9, 0), leg(9, 0, 0, 0), leg(0, 0, 0, 10), leg(0, 10, 10, 10, 0.9)],
    entry: 120, prize: 550, stars: 1, ai: [0.84, 0.9, 0.96],
    legal: { entry: 60, prize: 250 },
  },
]

/**
 * sg 路网里被建筑足迹压住的边（graph.json 边 id；离线扫描 chunk 建筑多边形，中心线 ≥2 个 3 m 采样点落在楼内）。
 * 例：Collyer Quay 北段 1808 / 1822 穿过一栋楼（玩家开车也过不去），Raffles Blvd 东段与 Suntec 之间断开。
 * 赛道寻路跳过这些边；graph.json 重新烘焙后需重跑 scratchpad/p10c/scan.ts 更新。
 */
export const SG_BLOCKED_EDGES: ReadonlySet<number> = new Set([
  218, 336, 337, 339, 340, 341, 344, 345, 442, 496, 502, 656, 657, 810, 1091, 1108, 1109, 1224, 1275, 1294,
  1295, 1322, 1535, 1536, 1561, 1562, 1713, 1808, 1822, 2105, 2238, 2435, 2576, 2585, 2586, 2591, 2592, 2743,
  2773, 2796, 2906, 2907, 3241, 4103, 4141, 4158, 4169, 4178, 4279, 4280, 4281, 4282, 4285, 4332, 4356, 4357,
  4358, 4359, 4539, 4616, 4617, 4618, 4934, 4935, 4952, 5000, 5001, 5027, 5049, 5106, 5123, 5124, 5125, 5126,
  5127, 5128, 5129, 5130, 5134, 5212, 5233, 5234, 5241, 5271, 5272, 5317, 5321, 5338, 5347, 5348, 5349, 5350,
  5351, 5352, 5353, 5356, 5357, 5378, 5379, 5380, 5383, 5388, 5389, 5390, 5391, 5394, 5395, 5423, 5424, 5456,
  5459, 5460, 5461, 5462, 5465, 5466, 5475, 5476, 5492, 5493, 5494, 5495, 5496, 5499, 5501, 5579, 5589, 5595,
  5614, 5615, 5633, 5634, 5655, 5669, 5683, 5710, 5717, 5718, 5727
])

/** 租一辆比赛用跑车 */
export const RACE_RENT = 200
/** 下注档位（押自己夺冠） */
export const RACE_BETS = [0, 100, 500, 2000]
/** 名次奖金：报名费池（4 人 × 报名费）× 系数 + 固定奖金 × 系数 */
export const PRIZE_POOL_SHARE = [0.6, 0.3, 0.1, 0]
export const PRIZE_FIXED_SHARE = [1, 0.4, 0.15, 0]
/** 对手名单（按难度从低到高） */
export const RIVALS = [
  { name: '阿杰', tag: '新手', color: 0xff7a00 },
  { name: 'Marcus', tag: '老手', color: 0x1f6fff },
  { name: '"Ghost" 林', tag: '车神', color: 0x23c552 },
]
export const routesFor = (world: 'sg' | 'grid') => RACE_ROUTES.filter((r) => r.world === world)
export const routeById = (id: string) => RACE_ROUTES.find((r) => r.id === id) ?? null
/**
 * 对手级别（src/data/tiers.ts，T1–T10）：叠加在路线 ai 上的车手水平 + 橡皮筋。T5 = 原来的手感。
 * 高级别不把水平推过 skillCap（再快会冲出弯道限速线撞墙），而是“只追不让”：落后追得更猛、领先不收油。
 */
export interface RaceTier {
  /** 车手水平加成（叠到路线 ai 上） */
  skillAdd: number
  skillCap: number
  /** 落后玩家 > 60 m 时最多提速 */
  rbUp: number
  /** 领先玩家 > leadStart 后最低收油到（1 = 不收油），每 downRate 米降 1 */
  rbDown: number
  leadStart: number
  downRate: number
}
const rt = (skillAdd: number, rbUp: number, rbDown: number, leadStart: number, downRate: number): RaceTier => ({ skillAdd, skillCap: 1.08, rbUp, rbDown, leadStart, downRate })
export const RACE_TIERS: RaceTier[] = [
  rt(-0.16, 0, 0.75, 40, 1000),
  rt(-0.12, 0.03, 0.78, 50, 1100),
  rt(-0.08, 0.06, 0.82, 60, 1300),
  rt(-0.04, 0.08, 0.85, 80, 1600),
  rt(0, 0.1, 0.88, 100, 2000),
  rt(0.02, 0.12, 0.9, 120, 2000),
  rt(0.03, 0.13, 0.93, 150, 2500),
  rt(0.04, 0.15, 0.96, 200, 3000),
  rt(0.05, 0.16, 0.98, 300, 4000),
  rt(0.06, 0.18, 1, 300, 4000),
]
export const raceTier = (t: number) => RACE_TIERS[clampTier(t) - 1]
/** 某级别下三名对手的实际车手水平 */
export const effectiveAi = (r: RaceRouteDef, t: number): [number, number, number] => {
  const k = raceTier(t)
  return r.ai.map((a) => Math.round(Math.min(k.skillCap, a + k.skillAdd) * 1000) / 1000) as [number, number, number]
}
/** 押冠军赔率（含本金）：按对手平均水平（下限 1.2×） */
export const betOdds = (r: RaceRouteDef, t = 5) => Math.max(1.2, Math.round((1 + 10 * (effectiveAi(r, t).reduce((a, b) => a + b, 0) / 3 - 0.7)) * 10) / 10)
