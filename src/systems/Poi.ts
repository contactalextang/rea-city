import type { RoadGraph } from '../world/RoadGraph'

/**
 * 兴趣点（POI）提供接口：世界实现（方格城合成 / 真实新加坡烘焙）只需产出 Poi[]，
 * Interactions / Minimap / Phone 都只依赖 PoiRegistry。
 */
export type PoiType = 'hawker' | 'mrt' | 'bus' | 'taxi' | 'home' | 'office' | 'site' | 'police' | 'hospital' | 'shop' | 'landmark'

export interface Poi {
  id: string
  type: PoiType
  name: string
  /** 标志物/建筑位置（世界坐标） */
  x: number
  z: number
  /** 交互门口：玩家站位与朝向（MRT 出站、昏倒回家都传送到这里） */
  door: { x: number; z: number; yaw: number }
  meta?: Record<string, unknown>
}

/** 各类型配色：世界标志、小地图图标、手机地图共用 */
export const POI_COLOR: Record<PoiType, number> = {
  hawker: 0xff8c2e, mrt: 0x2ecc71, bus: 0x27ae60, taxi: 0xf2c516, home: 0x3ea6ff, office: 0x9b7bff,
  site: 0xffb000, police: 0x4169e1, hospital: 0xff4b4b, shop: 0xff69b4, landmark: 0xffffff,
}
/** CSS 颜色串（小地图 / 手机地图用） */
export const poiCss = (t: PoiType) => '#' + POI_COLOR[t].toString(16).padStart(6, '0')
export const POI_LABEL: Record<PoiType, string> = {
  hawker: '小贩中心', mrt: '地铁站', bus: '巴士站', taxi: '的士站', home: '住家', office: '办公楼',
  site: '工地', police: '警署', hospital: '医院', shop: '商店', landmark: '地标',
}

export class PoiRegistry {
  all: Poi[] = []
  private map = new Map<string, Poi>()

  load(list: Poi[]) {
    this.all = list.slice()
    this.map.clear()
    for (const p of list) this.map.set(p.id, p)
  }
  byType(t: PoiType) { return this.all.filter((p) => p.type === t) }
  byId(id: string) { return this.map.get(id) ?? null }
  /** 以门口距离衡量的最近 POI；types 可限定类型 */
  nearest(x: number, z: number, maxDist: number, types?: PoiType[]): Poi | null {
    let best: Poi | null = null, bestD = maxDist
    for (const p of this.all) {
      if (types && !types.includes(p.type)) continue
      const d = Math.hypot(p.door.x - x, p.door.z - z)
      if (d < bestD) { bestD = d; best = p }
    }
    return best
  }
}

type Side = 'N' | 'S' | 'E' | 'W'

/**
 * 方格城合成 POI 集：按街区 (bi,bj) 与朝向在行驶侧人行道上取门口（graph.sidewalkPoint），
 * 标志物放在门口后方 1.6 m 的退距带里（避开树与路灯）。
 */
export function gridPois(graph: RoadGraph): Poi[] {
  const out: Poi[] = []
  const add = (id: string, type: PoiType, name: string, bi: number, bj: number, side: Side, t = 12, meta?: Record<string, unknown>) => {
    // 让人行道落在该街区一侧：S 边向东、N 边向西、E 边向北(-z)、W 边向南(+z)
    const [fi, fj, ti, tj] = side === 'S' ? [bi, bj + 1, bi + 1, bj + 1] : side === 'N' ? [bi + 1, bj, bi, bj] : side === 'E' ? [bi + 1, bj + 1, bi + 1, bj] : [bi, bj, bi, bj + 1]
    const from = graph.node(fi, fj), to = graph.node(ti, tj)
    const e = from.out.find((o) => o.to === to)
    if (!e) throw new Error(`gridPois: 缺少边 (${fi},${fj})→(${ti},${tj})`)
    const door = graph.sidewalkPoint(e, t, { x: 0, z: 0 })
    // 朝向：面向马路（离开建筑）
    const yaw = side === 'S' ? 0 : side === 'N' ? Math.PI : side === 'E' ? Math.PI / 2 : -Math.PI / 2
    const fx = Math.sin(yaw), fz = Math.cos(yaw)
    out.push({ id, type, name, x: door.x - fx * 1.6, z: door.z - fz * 1.6, door: { x: door.x, z: door.z, yaw }, meta })
  }
  // 四个象限各一个家
  add('home_gang', 'home', '牛车水组屋（黑帮）', 2, 2, 'N')
  add('home_gold', 'home', 'Marina One 公寓（金领）', 7, 2, 'N')
  add('home_white', 'home', 'Tiong Bahru 公寓（白领）', 2, 7, 'S')
  add('home_blue', 'home', 'Jalan Kukoh 组屋（蓝领）', 7, 7, 'S')
  // 小贩中心
  add('hawker_maxwell', 'hawker', 'Maxwell Food Centre', 4, 4, 'E')
  add('hawker_tiongbahru', 'hawker', 'Tiong Bahru Market', 3, 6, 'W')
  // 地铁站（真实站名）
  add('mrt_raffles', 'mrt', 'Raffles Place MRT', 6, 4, 'N')
  add('mrt_chinatown', 'mrt', 'Chinatown MRT', 3, 3, 'S')
  add('mrt_tiongbahru', 'mrt', 'Tiong Bahru MRT', 1, 6, 'W')
  // 办公楼
  add('office_guoco', 'office', 'Guoco Tower', 5, 4, 'E')
  add('office_oue', 'office', 'OUE Downtown', 6, 6, 'S')
  // 工地
  add('site_tanjong', 'site', 'Tanjong Pagar 工地', 8, 5, 'E')
  // 的士站
  add('taxi_chinatown', 'taxi', 'Chinatown Point 的士站', 4, 2, 'S')
  add('taxi_tanjong', 'taxi', 'Tanjong Pagar Plaza 的士站', 6, 8, 'N')
  // 警署：沿用原医院重生点（路口 (1,1) 东向路段 t=14 → 街区 (1,0) 南侧）
  add('police_cantonment', 'police', 'Cantonment Complex（警署）', 1, 0, 'S', 14)
  add('hospital_sgh', 'hospital', 'Singapore General Hospital', 0, 4, 'E')
  // 商店与地标
  add('shop_fairprice', 'shop', 'NTUC FairPrice', 5, 7, 'W')
  add('landmark_merlion', 'landmark', 'Merlion Park', 8, 1, 'N')
  return out
}
