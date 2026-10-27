/**
 * 竞技场地图布局（纯数据，无 three 依赖）：60×60 格、每格 2 m → 120×120 m。
 * “丹戎巴葛货柜码头 · 旧店屋街区”主题爆破图：北 CT 出生、南 T 出生；东北 A 包点（高台）、西北 B 包点（货柜区）；
 * 中路纵贯；A 大道（长廊）/ A 小道（短廊）/ B 洞（隧道）/ 下洞连接中路与 B。
 * 坐标：列 cx 0..59 → 世界 x = (cx - 30) * 2 + 1；行 cz 0..59（北 = 0）→ 世界 z = (cz - 30) * 2 + 1。
 */

import { t } from '../../i18n'

export const N = 60
export const CELL = 2
/** 实心建筑（店屋 / 仓库）——floor = WALL */
export const WALL = -1

/** 障碍物：c 木箱 1.1 m / C 双层木箱 2.2 m / k 货柜 2.6 m / K 双层货柜 5.2 m / w 水泥墩 1.0 m */
export type Obs = '' | 'c' | 'C' | 'k' | 'K' | 'w'
export const OBS_H: Record<Exclude<Obs, ''>, number> = { c: 1.1, C: 2.2, k: 2.6, K: 5.2, w: 1.0 }

export interface Layout {
  floor: number[][]   // [cz][cx] 地面高度（WALL = 实心）
  obs: Obs[][]
  /** 区域名（雷达 / 报点），按格 */
  zone: string[][]
}

export interface Pt { x: number; z: number }
export const cellX = (cx: number) => (cx - N / 2) * CELL + CELL / 2
export const cellZ = (cz: number) => (cz - N / 2) * CELL + CELL / 2
export const toCell = (w: number) => Math.floor(w / CELL + N / 2)
export const P = (cx: number, cz: number): Pt => ({ x: cellX(cx), z: cellZ(cz) })

export function buildLayout(): Layout {
  const floor: number[][] = [], obs: Obs[][] = [], zone: string[][] = []
  for (let z = 0; z < N; z++) { floor.push(new Array(N).fill(WALL)); obs.push(new Array(N).fill('')); zone.push(new Array(N).fill('')) }
  const carve = (x0: number, z0: number, x1: number, z1: number, name = '', h = 0) => {
    for (let z = z0; z <= z1; z++) for (let x = x0; x <= x1; x++) { floor[z][x] = h; if (name) zone[z][x] = name }
  }
  const fill = (x0: number, z0: number, x1: number, z1: number) => { for (let z = z0; z <= z1; z++) for (let x = x0; x <= x1; x++) { floor[z][x] = WALL; obs[z][x] = '' } }
  const put = (x0: number, z0: number, x1: number, z1: number, o: Obs) => { for (let z = z0; z <= z1; z++) for (let x = x0; x <= x1; x++) if (floor[z][x] !== WALL) obs[z][x] = o }

  // —— 区域（先铺地面，后放障碍） ——
  carve(20, 50, 39, 57, t('T 出生'))
  carve(23, 2, 36, 8, t('CT 出生'))
  // 中路 + 中门
  carve(28, 13, 31, 31, t('中路'))
  carve(31, 28, 34, 39, t('下中'))   // 中路错位：CT 中门看不到 T 出生
  carve(29, 9, 30, 12, t('中门'))
  carve(25, 40, 34, 47, t('上中'))
  carve(27, 48, 32, 49, t('上中'))
  // A 大道（长廊）：T 出生东口 → 货柜场 → 长廊 → A
  carve(40, 51, 45, 55, t('A 大道口'))
  carve(40, 46, 45, 50, t('货柜场'))
  carve(46, 14, 50, 55, t('A 大道'))
  fill(46, 38, 46, 39); fill(49, 38, 50, 39)   // 大道门（4 m 门洞）
  // A 包点：西段平地 + 高台（1.2 m）+ 南侧台阶，东侧低坑
  carve(40, 3, 54, 15, t('A 包点'))
  carve(42, 4, 51, 11, t('A 包点'), 1.2)
  carve(44, 12, 49, 12, t('A 包点'), 0.8)
  carve(44, 13, 49, 13, t('A 包点'), 0.4)
  carve(41, 5, 41, 10, t('A 包点'), 0.8)
  carve(40, 5, 40, 10, t('A 包点'), 0.4)
  carve(37, 4, 39, 8, 'CT→A')
  // A 小道：中路 → 东拐 → 北上 → A 西南角
  carve(32, 24, 37, 26, t('A 小道'))
  carve(36, 14, 39, 26, t('A 小道'))
  carve(36, 14, 41, 16, t('A 小道'))
  // B 包点
  carve(4, 3, 19, 15, t('B 包点'))
  carve(19, 4, 22, 7, 'CT→B')
  // B 洞：T 出生西口 → 洞 → 上洞 → B 门
  carve(12, 51, 19, 55, t('B 洞口'))
  carve(9, 30, 13, 55, t('B 洞'))
  carve(6, 22, 16, 29, t('上洞'))
  carve(9, 16, 12, 21, t('B 门'))
  fill(9, 18, 9, 19); fill(12, 18, 12, 19)
  // 下洞（中路 ↔ 上洞）
  carve(14, 35, 30, 37, t('下洞'))
  // B 窗（中路顶 ↔ B 包点）
  carve(20, 15, 27, 16, t('B 窗'))
  fill(23, 15, 24, 15)

  // —— 障碍 ——
  // T 出生
  put(22, 51, 24, 51, 'k'); put(35, 56, 37, 57, 'K'); put(31, 52, 31, 52, 'c'); put(26, 55, 26, 55, 'w')
  // CT 出生
  put(25, 4, 25, 4, 'c'); put(33, 3, 35, 3, 'k'); put(28, 7, 28, 7, 'w')
  // 中路：中箱 + 上中货柜 + 掩体
  put(29, 30, 30, 30, 'c'); put(28, 20, 28, 20, 'w'); put(31, 42, 31, 44, 'k'); put(26, 41, 26, 41, 'C'); put(33, 46, 33, 46, 'c')
  // 货柜场 + 大道
  put(41, 47, 41, 49, 'K'); put(44, 47, 44, 48, 'k'); put(43, 53, 43, 53, 'c')
  put(46, 28, 46, 30, 'k'); put(50, 20, 50, 22, 'k'); put(49, 44, 49, 44, 'c'); put(46, 33, 46, 33, 'c')
  // A 包点
  put(44, 6, 45, 6, 'c'); put(49, 8, 50, 9, 'C'); put(42, 9, 42, 9, 'c'); put(52, 13, 54, 13, 'k'); put(53, 4, 54, 5, 'C'); put(40, 13, 40, 13, 'c')
  // A 小道
  put(37, 20, 37, 20, 'c'); put(39, 25, 39, 26, 'k')
  // B 包点
  put(6, 5, 7, 6, 'C'); put(14, 8, 15, 8, 'c'); put(4, 12, 6, 12, 'k'); put(16, 3, 18, 3, 'K'); put(10, 13, 12, 13, 'w'); put(18, 11, 18, 12, 'c'); put(9, 9, 9, 9, 'c')
  // B 洞 / 上洞 / 下洞
  put(12, 40, 12, 40, 'c'); put(9, 33, 9, 33, 'c'); put(7, 24, 8, 25, 'k'); put(15, 27, 16, 28, 'C'); put(11, 25, 13, 26, 'K'); put(21, 36, 21, 36, 'c')
  return { floor, obs, zone }
}

/** 包点范围（格，含边界） */
export const SITES = {
  A: { x0: 40, z0: 3, x1: 54, z1: 13, center: P(47, 8) },
  B: { x0: 4, z0: 3, x1: 18, z1: 14, center: P(11, 9) },
}
export type SiteId = keyof typeof SITES

/** 出生点 */
export const SPAWNS = {
  T: [P(28, 54), P(30, 55), P(32, 54), P(26, 53), P(34, 53), P(24, 56), P(36, 54), P(29, 52), P(33, 56), P(22, 54)],
  CT: [P(29, 5), P(31, 5), P(27, 6), P(33, 6), P(30, 3), P(26, 3), P(32, 7), P(24, 6), P(35, 5), P(29, 7)],
}
/** 购买区（出生区域格范围） */
export const BUY_ZONES = { T: { x0: 20, z0: 50, x1: 39, z1: 57 }, CT: { x0: 23, z0: 2, x1: 36, z1: 8 } }

/** T 进攻路线（路点序列，最后一段由 bot 自己走到包点的下包点） */
export const ROUTES: Record<SiteId, { name: string; pts: Pt[]; stage: Pt }[]> = {
  A: [
    { name: 'A 大道', pts: [P(42, 53), P(48, 45), P(48, 37), P(48, 24), P(48, 16)], stage: P(48, 44) },   // i18n-ignore 路线名仅调试 bot 状态用
    { name: 'A 小道', pts: [P(32, 44), P(32, 34), P(30, 28), P(31, 25), P(35, 25), P(38, 18), P(40, 15)], stage: P(32, 34) },   // i18n-ignore 路线名仅调试 bot 状态用
  ],
  B: [
    { name: 'B 洞', pts: [P(16, 53), P(11, 48), P(11, 36), P(10, 28), P(10, 21), P(10, 16)], stage: P(11, 33) },   // i18n-ignore 路线名仅调试 bot 状态用
    { name: '下洞', pts: [P(32, 44), P(32, 36), P(20, 36), P(13, 33), P(9, 28), P(10, 19)], stage: P(17, 36) },   // i18n-ignore 路线名仅调试 bot 状态用
  ],
}
/** 下包点（包点内若干可选点） */
export const PLANT_SPOTS: Record<SiteId, Pt[]> = {
  A: [P(46, 8), P(47, 10), P(48, 6), P(43, 7)],
  B: [P(11, 9), P(13, 7), P(8, 10), P(12, 11)],
}
/** CT 守点：位置 + 看向（预瞄口） */
export const HOLDS: Record<'A' | 'B' | 'mid', { at: Pt; look: Pt }[]> = {
  A: [{ at: P(51, 6), look: P(48, 16) }, { at: P(43, 5), look: P(40, 15) }, { at: P(47, 4), look: P(48, 18) }],
  B: [{ at: P(7, 4), look: P(10, 17) }, { at: P(17, 6), look: P(22, 15) }, { at: P(14, 4), look: P(10, 16) }],
  mid: [{ at: P(29, 10), look: P(30, 26) }, { at: P(30, 12), look: P(29, 30) }],
}
/** T 下包后的守包点（对着回防口） */
export const POSTPLANT: Record<SiteId, { at: Pt; look: Pt }[]> = {
  A: [{ at: P(48, 14), look: P(39, 6) }, { at: P(53, 10), look: P(43, 5) }, { at: P(38, 17), look: P(42, 8) }],
  B: [{ at: P(11, 20), look: P(11, 9) }, { at: P(5, 10), look: P(20, 5) }, { at: P(16, 12), look: P(20, 6) }],
}
