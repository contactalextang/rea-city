import type { GraphData } from './RoadGraph'
import { polyBody, type StaticBody, type StaticWorld } from './Colliders'
import type { Poi } from '../systems/Poi'
import { t } from '../i18n'

/**
 * Phase AIR：滨海南机场（虚构填海岛）布局与数据，只在 sg 世界生效。
 * 城市南边界外的海面上（z > 1382），由 Marina Coastal Drive 的两个断头点接一条堤道上岛。
 * 本文件只放布局常量与纯数据/判定函数（路网补丁、POI、碰撞体、地表类型、空域）；网格见 AirfieldMesh.ts。
 * 坐标：x 东、z 南、单位 m；yaw 约定同车辆（前向 = (sin yaw, cos yaw)，yaw 0 = 朝南 +z）。
 */

export interface Rect { minX: number; maxX: number; minZ: number; maxZ: number }

/** 填海岛（矩形，四角由网格做倒角） */
export const ISLAND: Rect = { minX: 820, maxX: 2180, minZ: 1700, maxZ: 2120 }
/** 跑道 09/27：中线 z、两端 x、宽 */
export const RUNWAY = { z: 1980, x0: 900, x1: 2100, width: 45 }
/** 平行滑行道 */
export const TAXIWAY = { z: 1900, x0: 950, x1: 2050, width: 18 }
/** 联络道（滑行道 ↔ 跑道）中线 x */
export const CONNECTORS = [960, 1500, 2040]
/** 停机坪（机库门前，接到滑行道北缘） */
export const APRON: Rect = { minX: 1350, maxX: 1800, minZ: 1830, maxZ: TAXIWAY.z - TAXIWAY.width / 2 }
/** 陆侧环路中线 z、两端 x（双向各 1 车道） */
export const LANDSIDE_ROAD = { z: 1714, x0: 1300, x1: 1800 }
/** 航站楼（玻璃盒） */
export const TERMINAL: Rect & { h: number } = { minX: 1410, maxX: 1490, minZ: 1726, maxZ: 1756, h: 14 }
/** 陆侧停车场 */
export const PARKING: Rect = { minX: 1600, maxX: 1700, minZ: 1724, maxZ: 1762 }
/** 塔台（套件模型，缩放到约 30 m 高） */
export const TOWER = { x: 1760, z: 1790, size: 9, h: 30 }
/** 机库：门朝南（+z）开向停机坪；x 为中心 */
export const HANGAR = { w: 30, d: 25, h: 12, minZ: 1805 }
export const HANGAR_XS = [1395, 1445, 1495, 1545]
export const hangarRect = (i: number): Rect => ({ minX: HANGAR_XS[i] - HANGAR.w / 2, maxX: HANGAR_XS[i] + HANGAR.w / 2, minZ: HANGAR.minZ, maxZ: HANGAR.minZ + HANGAR.d })
/** 停机位：各机库门前，机头朝南对着滑行道 */
export const STANDS = HANGAR_XS.map((x) => ({ x, z: 1852, yaw: 0 }))
/** 跑道起飞点（09 号，西端入口内 60 m，朝东） */
export const TAKEOFF_09 = { x: RUNWAY.x0 + 60, z: RUNWAY.z, yaw: Math.PI / 2 }

/** 城市南边界 z（与 manifest bbox.maxZ 一致）；堤道从这里起 */
export const CITY_EDGE_Z = 1382.17
/** 城市南墙在堤道处的开口 */
export const WALL_GAP = { x0: 1515, x1: 1560 }
/** 堤道桥面（多边形，顺时针）：城市边界处与 3 车道的 MCD 同宽，30 m 内收成双向各 2 车道 */
export const CAUSEWAY_DECK = new Float32Array([
  1515, CITY_EDGE_Z, 1560, CITY_EDGE_Z, 1553, 1410, 1553, ISLAND.minZ + 2, 1523, ISLAND.minZ + 2, 1523, 1410,
])
/** 允许飞行的空域；飞出前 HUD 提示并自动掉头 */
export const AIRSPACE: Rect = { minX: -4200, maxX: 4600, minZ: -3000, maxZ: 3600 }
/** 小地图 / 手机大地图的覆盖范围（城市底图 + 机场岛） */
export const AIRFIELD_MAP_RECT: Rect = { minX: ISLAND.minX - 20, maxX: ISLAND.maxX + 20, minZ: CITY_EDGE_Z, maxZ: ISLAND.maxZ + 20 }

// ---- 路网补丁 ----

/** MCD 南端断头点（按坐标找，不依赖节点 id） */
const MCD_SOUTH_END = { x: 1551.4, z: CITY_EDGE_Z }   // 南行单行边终点
const MCD_NORTH_START = { x: 1524.01, z: CITY_EDGE_Z } // 北行单行边起点

/**
 * 在 new RoadGraph(graph) 之前调用：追加堤道两条单行边（各 2 车道）与岛上陆侧路（双向各 1 车道），
 * 寻路 / 交通 / 行人 / 场馆门口吸附 / 叫车路程自动可用。找不到断头点（数据变了）时不改并返回 false。
 */
export function patchAirfieldGraph(g: GraphData): boolean {
  const near = (p: { x: number; z: number }) => g.nodes.find((n) => Math.hypot(n.x - p.x, n.z - p.z) < 0.5)
  const south = near(MCD_SOUTH_END), north = near(MCD_NORTH_START)
  if (!south || !north) { console.warn('[airfield] 找不到 Marina Coastal Drive 南端断头点，机场不接入路网'); return false }
  let nid = g.nodes.reduce((m, n) => Math.max(m, n.id), 0) + 1
  let eid = g.edges.reduce((m, e) => Math.max(m, e.id), 0) + 1
  const z = LANDSIDE_ROAD.z
  const node = (x: number, nz: number, junction: boolean) => { const n = { id: nid++, x, z: nz, junction, signal: false, jr: junction ? 6 : 4 }; g.nodes.push(n); return n }
  const J = node(1538, z, true), W = node(LANDSIDE_ROAD.x0, z, false), E = node(LANDSIDE_ROAD.x1, z, false)
  const base = { laneW: 3.3, kind: 'tertiary' as const, speedLimit: 60, crossings: [] as number[] }
  // 堤道：南行 MCD → 岛，北行 岛 → MCD（单行，2 车道）
  g.edges.push({ id: eid++, from: south.id, to: J.id, pts: [south.x, south.z, 1547.5, 1395, 1546, 1420, 1546, 1690, 1542, 1708, J.x, J.z], lanes: 2, oneway: true, reverse: null, ...base })
  g.edges.push({ id: eid++, from: J.id, to: north.id, pts: [J.x, J.z, 1534, 1708, 1530, 1690, 1530, 1420, 1528.5, 1395, north.x, north.z], lanes: 2, oneway: true, reverse: null, ...base })
  // 陆侧路：J ↔ W（航站楼一侧）、J ↔ E（停车场 / 塔台一侧），双向各 1 车道
  const two = (a: typeof J, b: typeof J) => {
    const id1 = eid++, id2 = eid++
    g.edges.push({ id: id1, from: a.id, to: b.id, pts: [a.x, a.z, b.x, b.z], lanes: 1, oneway: false, reverse: id2, ...base, speedLimit: 40 })
    g.edges.push({ id: id2, from: b.id, to: a.id, pts: [b.x, b.z, a.x, a.z], lanes: 1, oneway: false, reverse: id1, ...base, speedLimit: 40 })
  }
  two(J, W); two(J, E)
  return true
}

// ---- POI ----

/** 机场 POI id（航站楼 = 场馆入口，叫车目的地） */
export const AIRPORT_POI = 'airport_marina_south'
export const HANGAR_POI = 'airport_hangar'
export const CARGO_POI = 'airport_cargo'
export const TOWER_POI = 'airport_tower'

/** 机场 4 个 POI（门口坐标直接给出，不走车道吸附；类型都是 'airport'，每个可挂一个产业） */
export function airfieldPois(): Poi[] {
  const tc = (TERMINAL.minX + TERMINAL.maxX) / 2
  const h0 = HANGAR_XS[0], h3 = HANGAR_XS[3]
  const hz = HANGAR.minZ + HANGAR.d + 3
  return [
    // 航站楼北门，面向陆侧路（yaw π = 朝北）
    { id: AIRPORT_POI, type: 'airport', name: t('滨海南机场 Marina South Airfield'), x: tc, z: TERMINAL.minZ + 4, door: { x: tc, z: TERMINAL.minZ - 1.5, yaw: Math.PI } },
    // 1 号机库门前（取机 / 租机 / 维修），面向停机坪
    { id: HANGAR_POI, type: 'airport', name: t('机库 · 飞行俱乐部'), x: h0, z: HANGAR.minZ + HANGAR.d - 4, door: { x: h0 + 9, z: hz, yaw: 0 } },
    // 4 号机库：货运
    { id: CARGO_POI, type: 'airport', name: t('机场货运站'), x: h3, z: HANGAR.minZ + HANGAR.d - 4, door: { x: h3 + 9, z: hz, yaw: 0 } },
    // 塔台门口（西侧）
    { id: TOWER_POI, type: 'airport', name: t('机场塔台'), x: TOWER.x, z: TOWER.z, door: { x: TOWER.x - TOWER.size / 2 - 1.5, z: TOWER.z, yaw: -Math.PI / 2 } },
  ]
}

// ---- 碰撞体 ----

const rectPoly = (r: Rect) => new Float32Array([r.minX, r.minZ, r.maxX, r.minZ, r.maxX, r.maxZ, r.minX, r.maxZ])
/** 边界体：挡人与车，飞机碰撞时跳过 */
const bound = (r: Rect, h: number): StaticBody => ({ ...r, h, tag: 'bound' })

/** 机场常驻碰撞体（固定 key 'airfield'）：航站楼、机库、塔台；堤道护栏、岛边缘为边界体 */
export function addAirfieldColliders(world: StaticWorld) {
  const bodies: StaticBody[] = [polyBody(rectPoly(TERMINAL), TERMINAL.h)]
  for (let i = 0; i < HANGAR_XS.length; i++) bodies.push(polyBody(rectPoly(hangarRect(i)), HANGAR.h))
  const s = TOWER.size / 2
  bodies.push(polyBody(rectPoly({ minX: TOWER.x - s, maxX: TOWER.x + s, minZ: TOWER.z - s, maxZ: TOWER.z + s }), TOWER.h))
  // 堤道护栏：沿桥面多边形东西两条外边（收窄段 + 直段）
  const d = CAUSEWAY_DECK, T = 0.6, H = 1.1
  for (const [a, b] of [[1, 2], [2, 3], [4, 5], [5, 0]] as const) {
    const x0 = d[a * 2], z0 = d[a * 2 + 1], x1 = d[b * 2], z1 = d[b * 2 + 1]
    const L = Math.hypot(x1 - x0, z1 - z0), nx = -(z1 - z0) / L * T, nz = (x1 - x0) / L * T
    const b2 = polyBody(new Float32Array([x0 - nx, z0 - nz, x1 - nx, z1 - nz, x1 + nx, z1 + nz, x0 + nx, z0 + nz]), H)
    b2.tag = 'bound'; bodies.push(b2)
  }
  // 岛边缘（北边在堤道处留口）
  const I = ISLAND, W = 2
  bodies.push(bound({ minX: I.minX - W, maxX: 1523, minZ: I.minZ - W, maxZ: I.minZ }, 2))
  bodies.push(bound({ minX: 1553, maxX: I.maxX + W, minZ: I.minZ - W, maxZ: I.minZ }, 2))
  bodies.push(bound({ minX: I.minX - W, maxX: I.maxX + W, minZ: I.maxZ, maxZ: I.maxZ + W }, 2))
  bodies.push(bound({ minX: I.minX - W, maxX: I.minX, minZ: I.minZ, maxZ: I.maxZ }, 2))
  bodies.push(bound({ minX: I.maxX, maxX: I.maxX + W, minZ: I.minZ, maxZ: I.maxZ }, 2))
  world.addChunk('airfield', bodies)
}

// ---- 地表类型 / 空域 ----

export type Surface = 'runway' | 'paved' | 'land' | 'water'

const inRect = (r: Rect, x: number, z: number, pad = 0) => x >= r.minX - pad && x <= r.maxX + pad && z >= r.minZ - pad && z <= r.maxZ + pad

function inPoly(x: number, z: number, p: ArrayLike<number>): boolean {
  let inside = false
  for (let i = 0, n = p.length >> 1, j = n - 1; i < n; j = i++) {
    const xi = p[i * 2], zi = p[i * 2 + 1], xj = p[j * 2], zj = p[j * 2 + 1]
    if ((zi > z) !== (zj > z) && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside
  }
  return inside
}

export const onIsland = (x: number, z: number) => inRect(ISLAND, x, z)
export const onCauseway = (x: number, z: number) => z >= CITY_EDGE_Z - 1 && z <= ISLAND.minZ + 2 && inPoly(x, z, CAUSEWAY_DECK)
export const onRunway = (x: number, z: number) => x >= RUNWAY.x0 && x <= RUNWAY.x1 && Math.abs(z - RUNWAY.z) <= RUNWAY.width / 2
/** 机场铺装面（跑道 / 滑行道 / 联络道 / 停机坪）：飞机滑行与停放 */
export function onAirfieldPavement(x: number, z: number): boolean {
  if (onRunway(x, z)) return true
  if (x >= TAXIWAY.x0 - TAXIWAY.width / 2 && x <= TAXIWAY.x1 + TAXIWAY.width / 2 && Math.abs(z - TAXIWAY.z) <= TAXIWAY.width / 2) return true
  for (const cx of CONNECTORS) if (Math.abs(x - cx) <= TAXIWAY.width / 2 && z >= TAXIWAY.z && z <= RUNWAY.z) return true
  return inRect(APRON, x, z) || (x >= APRON.minX && x <= APRON.maxX && z >= HANGAR.minZ + HANGAR.d && z <= APRON.maxZ)
}
export const inAirspace = (x: number, z: number) => inRect(AIRSPACE, x, z)

/**
 * 地表分类（飞机接地判定用）：机场跑道 / 铺装 / 岛与堤道 / 城市陆地 / 水面。
 * city：城市范围与 landuse 水面多边形（滨海湾、新加坡河、外海）；范围外除岛与堤道外都是海。
 */
export class AirfieldSurface {
  private water: { ring: number[]; minX: number; maxX: number; minZ: number; maxZ: number }[]
  constructor(private city: Rect, water: { ring: number[] }[] | null) {
    this.water = (water ?? []).map((w) => {
      let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity
      for (let i = 0; i < w.ring.length; i += 2) {
        minX = Math.min(minX, w.ring[i]); maxX = Math.max(maxX, w.ring[i])
        minZ = Math.min(minZ, w.ring[i + 1]); maxZ = Math.max(maxZ, w.ring[i + 1])
      }
      return { ring: w.ring, minX, maxX, minZ, maxZ }
    })
  }
  at(x: number, z: number): Surface {
    if (onRunway(x, z)) return 'runway'
    if (onIsland(x, z)) return onAirfieldPavement(x, z) ? 'paved' : 'land'
    if (onCauseway(x, z)) return 'paved'
    if (!inRect(this.city, x, z)) return 'water'
    for (const w of this.water) if (inRect(w, x, z) && inPoly(x, z, w.ring)) return 'water'
    return 'land'
  }
}
