import * as THREE from 'three'
import { CHUNK_SIZE, type ChunkBuilding, type ChunkData } from './ChunkFormat'
import type { StaticBody, StaticWorld } from './Colliders'
import { buildingColor, hash01, oriented, shoelace } from './BuildingMesh'
import { FACADE_DIMS as D } from './FacadeShader'

/**
 * P14.2 建筑几何细节件（参考 Slop New York buildings.js 的 cornice / waterTowers / awnings）：
 * 外墙着色器（FacadeShader）之外的真实凸出几何，给轮廓与阴影带来尺度感。
 *
 * - 女儿墙 / 压顶：普通楼、HDB 沿屋顶各环向上 0.8–1.0 m、厚 0.2 m（外侧挑出 3 cm 压顶线）；玻璃塔为 0.5 m 金属压顶。
 * - 屋顶设备：HDB 电梯机房（按面积 1–5 个）+ 水箱（带基座）；普通楼/玻璃塔机电设备盒 + 八棱柱冷却塔（按面积，种子确定）。
 * - 檐口：店屋首层顶招牌梁处（FACADE_DIMS.shopBeam0–shopBase）外挑 0.25 m 线脚 + 屋檐两级外挑（0.14 / 0.38 m）；
 *   普通楼约半数在女儿墙底（= 着色器最后一层窗的顶，topY）做一道两级檐口。
 * - 店屋五脚基檐篷：临街立面（立面外法线方向 12 m 内先碰到人行道/车行道）在首层顶外挑檐篷板；
 *   墙到人行道的空地 ≥ 1.6 m 时外挑 ≤ 2 m 并在外缘立柱（位置 = 着色器拱廊柱的开间分界，柱有碰撞体），
 *   空地不够时改为无柱悬挑（最多伸进人行道 1 m，不会到车行道）。
 * - 空调外机：HDB 窗户面 / 普通楼（非首层）按着色器同一套开间/层高算法复算窗位，挂在窗台下方（不压窗）。
 * - 建筑前铺装带（apron）：每栋外环向外铺到人行道下 0.3 m（被人行道盖住，无缝）/ 车行道前 0.5 m / 相邻楼为止，
 *   10 m 内找到人行道就一直铺到人行道（退界空地整片铺），否则铺 1.5 m；y = 0.11（比人行道低 1 cm），共用人行道材质（StreetShaders.patchSidewalk 面类型 0 / 2）。
 *
 * "碰到什么"用每块 0.5 m 栅格（车行道 / 人行道三角网 + 楼足迹扫描线填充）沿法线步进查询；块外视为未知（停止）。
 * 只在玩家周围 3×3 块生成（每帧最多生成 1 块），3×3 内全部块合并成 2 个全局网格（细节 1 个投影网格 + 铺装 1 个），
 * 中心块变化或新块生成完时重新拼接（只做 TypedArray 拷贝）。fx=off 不生成、隐藏并撤销柱子碰撞体。
 */

export const DETAIL_RADIUS = 1
/** 调试：?detail=0 关闭细节件（对比开销用） */
const DETAIL_OFF = typeof location !== 'undefined' && new URLSearchParams(location.search).get('detail') === '0'
/** 铺装带顶面高度（人行道 0.12，地面 −0.12） */
const APRON_Y = 0.11
const GROUND_Y = -0.12
/** 铺装带：沿法线找人行道的最远距离 / 没找到时的默认宽度 */
const APRON_REACH = 10
const APRON_DEF = 1.5
/** 栅格分辨率（米）；栅格覆盖本块 + 四周 24 m（相邻已加载块的路面/人行道/楼也画进来，块边上的楼判定才准） */
const CELL = 0.5
const MARGIN = 24
const N = (CHUNK_SIZE + MARGIN * 2) / CELL
/** 相邻块楼号偏移（每块楼数 < 1000） */
const SLOT = 1000
const R_EMPTY = 0, R_ROAD = 1, R_WALK = 2, R_BLD = 3
/** 栅格查询：块外 */
const R_OUT = 0xffff

/** 店屋檐篷板（下沿 / 上沿高度）：盖住着色器的首层顶招牌梁 */
const CANOPY_Y0 = D.shopBase - 0.14
const CANOPY_Y1 = D.shopBase + 0.06
const COL_W = 0.32

const fract = (x: number) => x - Math.floor(x)
const clamp = (x: number, a: number, b: number) => (x < a ? a : x > b ? b : x)

// ---------------------------------------------------------------------------
// 几何累加
// ---------------------------------------------------------------------------

/** 顶点色 + 平面法线的三角累加器（细节网格） */
class Buf {
  pos: number[] = []
  nrm: number[] = []
  col: number[] = []
  idx: number[] = []
  /** 铺装带用：aKerb = (面类型, 沿边弧长) */
  kb: number[] | null = null
  tris = 0
  get verts() { return this.pos.length / 3 }

  /** 四边形 p0..p3（顺/逆序都行，按法线 n 自动定绕序），颜色 c；kb 时附 (type, s0, s1) */
  quad(p: number[], nx: number, ny: number, nz: number, r: number, g: number, b: number, type = 0, sa = 0, sb = 0) {
    const v = this.verts
    for (let k = 0; k < 12; k++) this.pos.push(p[k])
    for (let k = 0; k < 4; k++) { this.nrm.push(nx, ny, nz); this.col.push(r, g, b) }
    if (this.kb) this.kb.push(type, sa, type, sb, type, sb, type, sa)
    const ux = p[3] - p[0], uy = p[4] - p[1], uz = p[5] - p[2]
    const wx = p[6] - p[0], wy = p[7] - p[1], wz = p[8] - p[2]
    const cx = uy * wz - uz * wy, cy = uz * wx - ux * wz, cz = ux * wy - uy * wx
    if (cx * nx + cy * ny + cz * nz >= 0) this.idx.push(v, v + 1, v + 2, v, v + 2, v + 3)
    else this.idx.push(v, v + 2, v + 1, v, v + 3, v + 2)
    this.tris += 2
  }

  tri(p: number[], nx: number, ny: number, nz: number, r: number, g: number, b: number, type = 0) {
    const v = this.verts
    for (let k = 0; k < 9; k++) this.pos.push(p[k])
    for (let k = 0; k < 3; k++) { this.nrm.push(nx, ny, nz); this.col.push(r, g, b) }
    if (this.kb) this.kb.push(type, 0, type, 0, type, 0)
    const ux = p[3] - p[0], uy = p[4] - p[1], uz = p[5] - p[2]
    const wx = p[6] - p[0], wy = p[7] - p[1], wz = p[8] - p[2]
    const cx = uy * wz - uz * wy, cy = uz * wx - ux * wz, cz = ux * wy - uy * wx
    if (cx * nx + cy * ny + cz * nz >= 0) this.idx.push(v, v + 1, v + 2)
    else this.idx.push(v, v + 2, v + 1)
    this.tris++
  }

  /**
   * 有向盒子：中心 (cx, cz)，底 y0、高 h；u = (ux, uz) 为长轴（半长 hu），v = (−uz, ux)（半长 hv）。
   * 4 侧面 + 顶面（不画底），顶面颜色 ×top
   */
  box(cx: number, cz: number, y0: number, h: number, ux: number, uz: number, hu: number, hv: number, r: number, g: number, b: number, top = 1.08, sides = true) {
    const vx = -uz, vz = ux, y1 = y0 + h
    const c = (su: number, sv: number) => [cx + ux * hu * su + vx * hv * sv, cz + uz * hu * su + vz * hv * sv]
    const p00 = c(-1, -1), p10 = c(1, -1), p11 = c(1, 1), p01 = c(-1, 1)
    const side = (a: number[], bb: number[], nx: number, nz: number) =>
      this.quad([a[0], y0, a[1], bb[0], y0, bb[1], bb[0], y1, bb[1], a[0], y1, a[1]], nx, 0, nz, r, g, b)
    if (sides) {
      side(p00, p10, -vx, -vz); side(p10, p11, ux, uz); side(p11, p01, vx, vz); side(p01, p00, -ux, -uz)
    }
    this.quad([p00[0], y1, p00[1], p10[0], y1, p10[1], p11[0], y1, p11[1], p01[0], y1, p01[1]], 0, 1, 0, r * top, g * top, b * top)
  }

  /** 八棱柱（冷却塔）：侧面 + 顶面（深色风扇口） */
  prism(cx: number, cz: number, y0: number, h: number, rad: number, r: number, g: number, b: number) {
    const K = 8, y1 = y0 + h
    const pts: number[] = []
    for (let k = 0; k < K; k++) { const a = (k + 0.5) / K * Math.PI * 2; pts.push(cx + Math.cos(a) * rad, cz + Math.sin(a) * rad) }
    for (let k = 0; k < K; k++) {
      const k2 = (k + 1) % K
      const ax = pts[k * 2], az = pts[k * 2 + 1], bx = pts[k2 * 2], bz = pts[k2 * 2 + 1]
      const a = (k + 1) / K * Math.PI * 2
      this.quad([ax, y0, az, bx, y0, bz, bx, y1, bz, ax, y1, az], Math.cos(a), 0, Math.sin(a), r, g, b)
    }
    // 顶面：外圈 = 塔身色，内圈 = 风扇口（深）
    const ir = rad * 0.7
    for (let k = 0; k < K; k++) {
      const k2 = (k + 1) % K
      const ax = pts[k * 2], az = pts[k * 2 + 1], bx = pts[k2 * 2], bz = pts[k2 * 2 + 1]
      const ix = (x: number) => cx + (x - cx) * ir / rad, iz = (z: number) => cz + (z - cz) * ir / rad
      this.quad([ax, y1, az, bx, y1, bz, ix(bx), y1, iz(bz), ix(ax), y1, iz(az)], 0, 1, 0, r * 1.05, g * 1.05, b * 1.05)
      this.tri([cx, y1 - 0.25, cz, ix(ax), y1, iz(az), ix(bx), y1, iz(bz)], 0, 1, 0, 0.05, 0.05, 0.055)
    }
  }
}

// ---------------------------------------------------------------------------
// 栅格：车行道 / 人行道 / 楼足迹
// ---------------------------------------------------------------------------

/** 每块 608×608（0.5 m）栅格，生成时复用同一块内存 */
class Raster {
  readonly a = new Uint16Array(N * N)
  x0 = 0
  z0 = 0
  private xs: number[] = []
  reset(x0: number, z0: number) { this.a.fill(R_EMPTY); this.x0 = x0; this.z0 = z0 }

  /** 扫描线偶奇填充多边形（平铺 x,z），取格心判定 */
  fill(p: ArrayLike<number>, nv: number, value: number) {
    const X = (k: number) => p[k * 2], Z = (k: number) => p[k * 2 + 1]
    let zmin = Infinity, zmax = -Infinity, xmin = Infinity, xmax = -Infinity
    for (let k = 0; k < nv; k++) {
      const z = Z(k), x = X(k)
      if (z < zmin) zmin = z; if (z > zmax) zmax = z
      if (x < xmin) xmin = x; if (x > xmax) xmax = x
    }
    if (xmax < this.x0 || xmin > this.x0 + N * CELL) return
    const r0 = Math.max(0, Math.ceil((zmin - this.z0) / CELL - 0.5)), r1 = Math.min(N - 1, Math.floor((zmax - this.z0) / CELL - 0.5))
    const xs = this.xs
    for (let r = r0; r <= r1; r++) {
      const zc = this.z0 + (r + 0.5) * CELL
      xs.length = 0
      for (let k = 0; k < nv; k++) {
        const k2 = k + 1 === nv ? 0 : k + 1
        const za = Z(k), zb = Z(k2)
        if ((za <= zc) !== (zb <= zc)) { const xa = X(k), xb = X(k2); xs.push(xa + (zc - za) * (xb - xa) / (zb - za)) }
      }
      if (xs.length < 2) continue
      if (xs.length > 2) xs.sort((u, v) => u - v)
      else if (xs[0] > xs[1]) { const t = xs[0]; xs[0] = xs[1]; xs[1] = t }
      const row = r * N
      for (let q = 0; q + 1 < xs.length; q += 2) {
        const c0 = Math.max(0, Math.ceil((xs[q] - this.x0) / CELL - 0.5)), c1 = Math.min(N - 1, Math.floor((xs[q + 1] - this.x0) / CELL - 0.5))
        for (let c = c0; c <= c1; c++) this.a[row + c] = value
      }
    }
  }

  /** 三角网（专用快速路径：无闭包，每行求三条边交点的最小/最大 x） */
  tris(pos: Float32Array, idx: Uint32Array, value: number) {
    const x0 = this.x0, z0 = this.z0, W = N * CELL, a = this.a
    for (let t = 0; t + 2 < idx.length; t += 3) {
      const i0 = idx[t] * 2, i1 = idx[t + 1] * 2, i2 = idx[t + 2] * 2
      const ax = pos[i0], az = pos[i0 + 1], bx = pos[i1], bz = pos[i1 + 1], cx = pos[i2], cz = pos[i2 + 1]
      const xmin = Math.min(ax, bx, cx), xmax = Math.max(ax, bx, cx)
      if (xmax < x0 || xmin > x0 + W) continue
      const zmin = Math.min(az, bz, cz), zmax = Math.max(az, bz, cz)
      const r0 = Math.max(0, Math.ceil((zmin - z0) / CELL - 0.5)), r1 = Math.min(N - 1, Math.floor((zmax - z0) / CELL - 0.5))
      for (let r = r0; r <= r1; r++) {
        const zc = z0 + (r + 0.5) * CELL
        let lo = Infinity, hi = -Infinity
        if ((az <= zc) !== (bz <= zc)) { const x = ax + (zc - az) * (bx - ax) / (bz - az); if (x < lo) lo = x; if (x > hi) hi = x }
        if ((bz <= zc) !== (cz <= zc)) { const x = bx + (zc - bz) * (cx - bx) / (cz - bz); if (x < lo) lo = x; if (x > hi) hi = x }
        if ((cz <= zc) !== (az <= zc)) { const x = cx + (zc - cz) * (ax - cx) / (az - cz); if (x < lo) lo = x; if (x > hi) hi = x }
        if (hi < lo) continue
        const c0 = Math.max(0, Math.ceil((lo - x0) / CELL - 0.5)), c1 = Math.min(N - 1, Math.floor((hi - x0) / CELL - 0.5))
        const row = r * N
        for (let c = c0; c <= c1; c++) a[row + c] = value
      }
    }
  }

  at(x: number, z: number): number {
    const c = Math.floor((x - this.x0) / CELL), r = Math.floor((z - this.z0) / CELL)
    if (c < 0 || r < 0 || c >= N || r >= N) return R_OUT
    return this.a[r * N + c]
  }

  /**
   * 从墙上 (x, z) 沿法线 (nx, nz) 步进 0.25 m 直到 maxD：返回首个"非空、非本楼"的格类型与距离；
   * 都没碰到返回 kind = R_EMPTY
   */
  march(x: number, z: number, nx: number, nz: number, maxD: number, self: number, out: { kind: number; d: number }) {
    for (let d = 0.25; d <= maxD + 1e-6; d += 0.25) {
      const v = this.at(x + nx * d, z + nz * d)
      if (v === R_EMPTY || v === R_BLD + self) continue
      out.kind = v >= R_BLD && v !== R_OUT ? R_BLD : v
      out.d = d
      return out
    }
    out.kind = R_EMPTY; out.d = maxD
    return out
  }
}

// ---------------------------------------------------------------------------
// 立面分段与窗格网格（与 BuildingMesh.appendBuilding / FacadeShader 一致）
// ---------------------------------------------------------------------------

interface Edge { x0: number; z0: number; x1: number; z1: number; ux: number; uz: number; nx: number; nz: number; len: number; s0: number }
interface Run { W: number; rs: number; closed: boolean; edges: Edge[] }

/** 外环立面分段：相邻边转角 < 30° 合并；rs = 立面随机（外环 runNo = 0，同 appendBuilding） */
function facadeRuns(b: ChunkBuilding, outer: Float32Array): Run[] {
  const ring = outer, n = ring.length >> 1
  const len: number[] = [], ux: number[] = [], uz: number[] = []
  for (let k = 0; k < n; k++) {
    const dx = ring[((k + 1) % n) * 2] - ring[k * 2], dz = ring[((k + 1) % n) * 2 + 1] - ring[k * 2 + 1]
    const l = Math.hypot(dx, dz)
    len.push(l); ux.push(l > 0 ? dx / l : 0); uz.push(l > 0 ? dz / l : 0)
  }
  const valid: number[] = []
  for (let k = 0; k < n; k++) if (len[k] >= 1e-3) valid.push(k)
  const m = valid.length
  if (!m) return []
  const corner = valid.map((k, i) => { const p = valid[(i - 1 + m) % m]; return ux[p] * ux[k] + uz[p] * uz[k] < 0.866 })
  const closed = !corner.some(Boolean)
  const start = closed ? 0 : corner.indexOf(true)
  const runs: Run[] = []
  for (let j = 0; j < m; j++) {
    const i = (start + j) % m, k = valid[i]
    if (j === 0 || corner[i]) runs.push({ W: 0, rs: hash01(b.id * 31 + runs.length, 13), closed, edges: [] })
    const r = runs[runs.length - 1]
    r.edges.push({
      x0: ring[k * 2], z0: ring[k * 2 + 1], x1: ring[((k + 1) % n) * 2], z1: ring[((k + 1) % n) * 2 + 1],
      ux: ux[k], uz: uz[k], nx: -uz[k], nz: ux[k], len: len[k], s0: r.W,
    })
    r.W += len[k]
  }
  return runs
}

interface Grid { corridor: boolean; ribbon: boolean; yBase: number; floorH: number; topY: number; pier: number; bays: number; bw: number }

/** FacadeShader facadeEval 的窗格网格（JS 复算） */
function facadeGrid(cls: number, seed: number, rs: number, W: number, H: number, closed: boolean): Grid {
  const isHdb = cls === 1, isShop = cls === 2, isGlass = cls === 3
  const corridor = isHdb && rs < D.corrP && W > D.corrMinW
  const ribbon = !isHdb && !isShop && !isGlass && fract(seed * 3.17) < D.ribbonP
  const floorT = isHdb ? D.floorHdb : isShop ? D.floorShop : isGlass ? D.floorGlass + 0.5 * seed : D.floorGeneric + 0.35 * seed
  const yBase = isShop ? D.shopBase : 0
  const parapet = isGlass ? D.parapetGlass : D.parapet
  const avail = H - yBase - parapet
  const nFloors = Math.max(Math.floor(avail / floorT + 0.5), 1)
  let floorH = avail / nFloors
  if (floorH < floorT * (nFloors < 1.5 ? 0.55 : 0.72) || floorH > floorT * 1.35) floorH = floorT
  const bayT = isHdb ? (corridor ? D.bayHdbCorr : D.bayHdb) : isShop ? D.bayShop : isGlass ? D.bayGlass : (ribbon ? D.bayRibbon : D.bayGeneric + 0.9 * fract(seed * 7.3))
  const pierT = isGlass ? D.pierGlass : isShop ? D.pierShop : D.pierOther
  const pier = closed ? 0 : Math.min(pierT, W * 0.2)
  const inner = W - 2 * pier
  const bays = Math.max(Math.floor(inner / bayT + 0.5), 1)
  return { corridor, ribbon, yBase, floorH, topY: H - parapet, pier, bays, bw: inner / bays }
}

/** 立面上 s 处所在的边（找不到返回 null）；离边端 < margin 的视为转折处，不放东西 */
function edgeAt(run: Run, s: number, margin: number): Edge | null {
  for (const e of run.edges) if (s >= e.s0 + margin && s <= e.s0 + e.len - margin) return e
  return null
}

// ---------------------------------------------------------------------------
// 环偏移 / 线脚带
// ---------------------------------------------------------------------------

/** 去重后的环（x, z 分开）+ 每边单位方向与外法线 */
interface Loop { x: number[]; z: number[]; ux: number[]; uz: number[]; nx: number[]; nz: number[]; len: number[] }

function makeLoop(r: Float32Array): Loop | null {
  const n = r.length >> 1
  const x: number[] = [], z: number[] = []
  for (let k = 0; k < n; k++) {
    const px = r[k * 2], pz = r[k * 2 + 1]
    if (x.length && Math.hypot(px - x[x.length - 1], pz - z[z.length - 1]) < 0.05) continue
    x.push(px); z.push(pz)
  }
  while (x.length > 2 && Math.hypot(x[0] - x[x.length - 1], z[0] - z[z.length - 1]) < 0.05) { x.pop(); z.pop() }
  const m = x.length
  if (m < 3) return null
  const L: Loop = { x, z, ux: [], uz: [], nx: [], nz: [], len: [] }
  for (let k = 0; k < m; k++) {
    const k2 = (k + 1) % m
    const dx = x[k2] - x[k], dz = z[k2] - z[k], l = Math.hypot(dx, dz)
    L.ux.push(dx / l); L.uz.push(dz / l); L.nx.push(-dz / l); L.nz.push(dx / l); L.len.push(l)
  }
  return L
}

/** 斜接偏移：顶点 k 沿两侧边外法线角平分方向移 d（尖角限长 2.5 倍） */
function offsetLoop(L: Loop, d: number): number[] {
  const m = L.x.length, out: number[] = []
  for (let k = 0; k < m; k++) {
    const p = (k - 1 + m) % m
    let mx = L.nx[p] + L.nx[k], mz = L.nz[p] + L.nz[k]
    const ml = Math.hypot(mx, mz)
    if (ml < 1e-3) { mx = L.nx[k]; mz = L.nz[k] } else { mx /= ml; mz /= ml }
    const c = Math.max(mx * L.nx[k] + mz * L.nz[k], 0.4)
    out.push(L.x[k] + mx * d / c, L.z[k] + mz * d / c)
  }
  return out
}

/**
 * 沿环一圈的线脚 / 女儿墙带：dIn→dOut（相对墙线，外为正），y0→y1。
 * faces：o 外立面、t 顶面、b 底面（挑檐下沿，投影关键）、i 内立面（女儿墙朝屋顶一侧，从 iy0 起）；
 * mask[k] = 0 的边跳过（与相邻楼共用的界墙）
 */
function band(buf: Buf, L: Loop, dIn: number, dOut: number, y0: number, y1: number, faces: string, r: number, g: number, b: number, iy0 = y0, mask: Uint8Array | null = null) {
  const I = offsetLoop(L, dIn), O = offsetLoop(L, dOut), m = L.x.length
  for (let k = 0; k < m; k++) {
    if (mask && !mask[k]) continue
    const k2 = (k + 1) % m
    const ax = O[k * 2], az = O[k * 2 + 1], bx = O[k2 * 2], bz = O[k2 * 2 + 1]
    const cx = I[k * 2], cz = I[k * 2 + 1], dx = I[k2 * 2], dz = I[k2 * 2 + 1]
    const nx = L.nx[k], nz = L.nz[k]
    if (faces.includes('o')) buf.quad([ax, y0, az, bx, y0, bz, bx, y1, bz, ax, y1, az], nx, 0, nz, r, g, b)
    if (faces.includes('t')) buf.quad([cx, y1, cz, ax, y1, az, bx, y1, bz, dx, y1, dz], 0, 1, 0, r * 1.06, g * 1.06, b * 1.06)
    if (faces.includes('b')) buf.quad([cx, y0, cz, ax, y0, az, bx, y0, bz, dx, y0, dz], 0, -1, 0, r * 0.8, g * 0.8, b * 0.8)
    if (faces.includes('i')) buf.quad([cx, iy0, cz, dx, iy0, dz, dx, y1, dz, cx, y1, cz], -nx, 0, -nz, r * 0.92, g * 0.92, b * 0.92)
  }
}

// ---------------------------------------------------------------------------
// 每块生成
// ---------------------------------------------------------------------------

interface Src { c: ChunkData; skip: Uint8Array; x0: number; z0: number; i: number; j: number }
interface Arrays { pos: Float32Array; nrm: Float32Array; col: Float32Array | null; kb: Float32Array | null; idx: Uint32Array }
interface Gen { det: Arrays; apron: Arrays; bodies: StaticBody[]; tris: number; ms: number }

function toArrays(b: Buf): Arrays {
  return {
    pos: new Float32Array(b.pos), nrm: new Float32Array(b.nrm),
    col: b.kb ? null : new Float32Array(b.col), kb: b.kb ? new Float32Array(b.kb) : null,
    idx: new Uint32Array(b.idx),
  }
}

const tmpCol = new THREE.Color()
/** 调试计数（__detail() 里可见）：檐篷边 / 柱 / 店屋边临街判定失败（0–1 个采样命中）/ 空调外机 */
const COUNT = { canopy: 0, cols: 0, notStreet: 0, ac: 0 }
const tmpHit = { kind: 0, d: 0 }

/** 点在环内（偶奇） */
function inLoop(L: Loop, x: number, z: number): boolean {
  let inside = false
  const m = L.x.length
  for (let i = 0, j = m - 1; i < m; j = i++) {
    const zi = L.z[i], zj = L.z[j]
    if ((zi > z) !== (zj > z) && x < ((L.x[j] - L.x[i]) * (z - zi)) / (zj - zi) + L.x[i]) inside = !inside
  }
  return inside
}
function distToLoop(L: Loop, x: number, z: number): number {
  let best = Infinity
  const m = L.x.length
  for (let k = 0; k < m; k++) {
    const ax = L.x[k], az = L.z[k], t = clamp((x - ax) * L.ux[k] + (z - az) * L.uz[k], 0, L.len[k])
    const d = Math.hypot(ax + L.ux[k] * t - x, az + L.uz[k] * t - z)
    if (d < best) best = d
  }
  return best
}

export class BuildingDetail {
  readonly group = new THREE.Group()
  readonly material: THREE.MeshStandardMaterial
  private mesh: THREE.Mesh
  private apronMesh: THREE.Mesh
  private src = new Map<string, Src>()
  private gens = new Map<string, Gen>()
  /** 当前合并进全局网格的块（同时持有柱子碰撞体） */
  private merged: string[] = []
  private wantKeys: string[] = []
  private center = ''
  private on = true
  private dirty = false
  private raster: Raster | null = null
  /** 统计：生成块数、累计生成耗时、最近一次拼接耗时 */
  private genCount = 0
  private genMsSum = 0
  private genMsMax = 0
  private mergeMs = 0
  /** 距上次拼接的帧数（生成中途也会每 30 帧拼一次，让细节逐步出现） */
  private sinceMerge = 0

  constructor(private world: StaticWorld, walkMat: THREE.Material) {
    this.group.name = 'bldDetail'
    this.material = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.84, metalness: 0 })
    this.material.name = 'bldDetail'
    this.mesh = new THREE.Mesh(new THREE.BufferGeometry(), this.material)
    this.mesh.name = 'bldDetail'
    this.mesh.castShadow = true; this.mesh.receiveShadow = true
    this.apronMesh = new THREE.Mesh(new THREE.BufferGeometry(), walkMat)
    this.apronMesh.name = 'bldApron'
    this.apronMesh.receiveShadow = true
    this.apronMesh.userData.castShadow = false
    this.mesh.visible = this.apronMesh.visible = false
    this.group.add(this.mesh, this.apronMesh)
    if (typeof window !== 'undefined') {
      const w = window as unknown as { __detail: unknown; __detailVis: unknown }
      w.__detail = () => this.stats
      /** 调试：临时隐藏/显示细节件（A/B 量 draw call） */
      w.__detailVis = (v: boolean) => { this.group.visible = v }
    }
  }

  /** 区块建好时登记（只存引用，真正生成在 update 里按距离排队） */
  addChunk(key: string, c: ChunkData, skip: Uint8Array, x0: number, z0: number) {
    this.src.set(key, { c, skip, x0, z0, i: c.i, j: c.j })
    this.gens.delete(key)
    if (this.wantKeys.includes(key)) this.dirty = true
  }

  removeChunk(key: string) {
    this.src.delete(key)
    if (this.gens.delete(key) && this.merged.includes(key)) this.dirty = true
  }

  /** 每帧：(ci, cj) 玩家所在块；on = fx 不为 off；busy = 本帧已建过区块（不再生成，错开耗时） */
  update(ci: number, cj: number, on: boolean, busy = false) {
    const center = `${ci}_${cj}`
    on = on && !DETAIL_OFF
    if (on !== this.on) { this.on = on; this.dirty = true }
    if (center !== this.center) {
      this.center = center
      const list: { key: string; d: number }[] = []
      for (let j = cj - DETAIL_RADIUS; j <= cj + DETAIL_RADIUS; j++) for (let i = ci - DETAIL_RADIUS; i <= ci + DETAIL_RADIUS; i++) {
        list.push({ key: `${i}_${j}`, d: (i - ci) * (i - ci) + (j - cj) * (j - cj) })
      }
      list.sort((a, b) => a.d - b.d)
      this.wantKeys = list.map((l) => l.key)
      // 离开 3×3 的生成结果丢掉（回来时重算，换内存）
      for (const k of [...this.gens.keys()]) if (!this.wantKeys.includes(k)) this.gens.delete(k)
      this.dirty = true
    }
    let pending = false
    if (this.on && busy) pending = this.wantKeys.some((k) => this.src.has(k) && !this.gens.has(k))
    else if (this.on) {
      // 每帧最多生成 1 块（本帧 ChunkManager 已建块时不生成，错开尖峰）（离中心近的优先）
      let did = false
      for (const k of this.wantKeys) {
        const s = this.src.get(k)
        if (!s || this.gens.has(k)) continue
        if (did) { pending = true; break }
        this.gens.set(k, this.generate(s))
        this.dirty = true
        did = true
      }
    }
    this.sinceMerge++
    // 拼接有 ~10 ms 拷贝开销：等本轮 3×3 都生成完再拼（最多等 30 帧）
    if (this.dirty && (!pending || this.sinceMerge > 30)) { this.dirty = false; this.sinceMerge = 0; this.rebuild() }
  }

  get stats() {
    return {
      chunks: this.merged.length,
      tris: (this.mesh.geometry.index?.count ?? 0) / 3,
      apronTris: (this.apronMesh.geometry.index?.count ?? 0) / 3,
      genMsAvg: this.genCount ? +(this.genMsSum / this.genCount).toFixed(2) : 0,
      genMsMax: +this.genMsMax.toFixed(2),
      mergeMs: +this.mergeMs.toFixed(2),
      generated: this.genCount,
      ...COUNT,

    }
  }

  /** 把 3×3 内已生成的块拼成两个全局网格；同步柱子碰撞体 */
  private rebuild() {
    const t0 = performance.now()
    const keys = this.on ? this.wantKeys.filter((k) => this.gens.has(k)) : []
    for (const k of this.merged) if (!keys.includes(k)) this.world.removeChunk('detail:' + k)
    for (const k of keys) if (!this.merged.includes(k)) this.world.addChunk('detail:' + k, this.gens.get(k)!.bodies)
    this.merged = keys
    const gs = keys.map((k) => this.gens.get(k)!)
    this.mesh.geometry.dispose()
    this.apronMesh.geometry.dispose()
    // 包围球按块范围给（省掉逐顶点 computeBoundingSphere）：xz 取合并块的外包框，y 0–300 m
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity
    for (const k of keys) {
      const sr = this.src.get(k)
      if (!sr) continue
      minX = Math.min(minX, sr.x0); maxX = Math.max(maxX, sr.x0 + CHUNK_SIZE)
      minZ = Math.min(minZ, sr.z0); maxZ = Math.max(maxZ, sr.z0 + CHUNK_SIZE)
    }
    const sphere = keys.length
      ? new THREE.Sphere(new THREE.Vector3((minX + maxX) / 2, 150, (minZ + maxZ) / 2), Math.hypot(maxX - minX, 300, maxZ - minZ) / 2 + 10)
      : new THREE.Sphere()
    this.mesh.geometry = concat(gs.map((g) => g.det), 'color', sphere)
    this.apronMesh.geometry = concat(gs.map((g) => g.apron), 'aKerb', sphere)
    this.mesh.visible = this.apronMesh.visible = keys.length > 0
    this.mergeMs = performance.now() - t0
  }

  private generate(s: Src): Gen {
    const t0 = performance.now()
    const det = new Buf(), apron = new Buf()
    apron.kb = []
    const bodies: StaticBody[] = []
    const ras = this.raster ?? (this.raster = new Raster())
    ras.reset(s.x0 - MARGIN, s.z0 - MARGIN)
    const { c } = s
    // 栅格：楼 → 人行道 → 车行道（后者覆盖前者）；本块楼号 = 下标，相邻块 = SLOT·槽位 + 下标
    const near: ChunkData[] = [c]
    for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) {
      if (!di && !dj) continue
      const n = this.src.get(`${s.i + di}_${s.j + dj}`)
      if (n) near.push(n.c)
    }
    near.forEach((nc, slot) => nc.buildings.forEach((b, bi) => { if (b.ring.length >= 6) ras.fill(b.ring, b.ring.length >> 1, R_BLD + slot * SLOT + bi) }))
    for (const nc of near) ras.tris(nc.walkPos, nc.walkIdx, R_WALK)
    for (const nc of near) ras.tris(nc.roadPos, nc.roadIdx, R_ROAD)
    c.buildings.forEach((b, bi) => {
      if (b.ring.length < 6 || s.skip[bi]) return
      appendDetail(det, apron, bodies, b, bi, ras)
    })
    const out = { det: toArrays(det), apron: toArrays(apron), bodies, tris: det.tris + apron.tris, ms: 0 }
    const ms = out.ms = performance.now() - t0
    this.genCount++; this.genMsSum += ms; this.genMsMax = Math.max(this.genMsMax, ms)
    return out
  }

  dispose() {
    for (const k of this.merged) this.world.removeChunk('detail:' + k)
    this.merged = []
    this.src.clear(); this.gens.clear()
    this.mesh.geometry.dispose(); this.apronMesh.geometry.dispose()
    this.material.dispose()
    this.group.removeFromParent()
  }
}

/** 多块数组拼接成一个 BufferGeometry（attr = 'color' 细节 / 'aKerb' 铺装） */
function concat(list: Arrays[], attr: 'color' | 'aKerb', sphere: THREE.Sphere): THREE.BufferGeometry {
  let nv = 0, ni = 0
  for (const a of list) { nv += a.pos.length / 3; ni += a.idx.length }
  const pos = new Float32Array(nv * 3), nrm = new Float32Array(nv * 3)
  const ex = new Float32Array(nv * (attr === 'color' ? 3 : 2))
  const idx = new Uint32Array(ni)
  let ov = 0, oi = 0
  for (const a of list) {
    pos.set(a.pos, ov * 3); nrm.set(a.nrm, ov * 3)
    if (attr === 'color') ex.set(a.col!, ov * 3); else ex.set(a.kb!, ov * 2)
    for (let k = 0; k < a.idx.length; k++) idx[oi + k] = a.idx[k] + ov
    ov += a.pos.length / 3; oi += a.idx.length
  }
  const g = new THREE.BufferGeometry()
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3))
  g.setAttribute('normal', new THREE.BufferAttribute(nrm, 3))
  g.setAttribute(attr, new THREE.BufferAttribute(ex, attr === 'color' ? 3 : 2))
  g.setIndex(new THREE.BufferAttribute(idx, 1))
  g.boundingSphere = sphere.clone()
  return g
}

// ---------------------------------------------------------------------------
// 单栋
// ---------------------------------------------------------------------------

function appendDetail(det: Buf, apron: Buf, bodies: StaticBody[], b: ChunkBuilding, bi: number, ras: Raster) {
  const H = Math.max(2.5, b.h)
  const cls = b.cls
  const outer = oriented(b.ring, true)
  const L = makeLoop(outer)
  if (!L) return
  appendApron(apron, L, bi, ras)
  if (cls === 4) return
  const base = buildingColor(cls, tmpCol, b.id)
  const br = base.r, bg = base.g, bb = base.b
  const seed = hash01(b.id, 11)
  const area = Math.abs(shoelace(outer)) / 2
  const holes = b.holes.filter((r) => r.length >= 6).map((r) => makeLoop(oriented(r, false))).filter((l): l is Loop => !!l)

  // —— 女儿墙 / 压顶 ——
  if (cls === 0 || cls === 1) {
    const ph = cls === 1 ? 1.0 : 0.75 + 0.25 * hash01(b.id, 21)
    // 压顶色：着色器 coping = mix(墙色, 0.8 灰, 0.3)
    const cr = br * 0.7 + 0.18, cg = bg * 0.7 + 0.18, cb = bb * 0.7 + 0.18
    for (const lp of [L, ...holes]) {
      band(det, lp, -0.2, 0.01, H - 0.05, H + ph - 0.1, 'oi', br * 0.97, bg * 0.97, bb * 0.97, H)
      band(det, lp, -0.24, 0.04, H + ph - 0.1, H + ph, 'otb', cr, cg, cb)
    }
  } else if (cls === 3) {
    for (const lp of [L, ...holes]) band(det, lp, -0.15, 0.05, H - 0.2, H + 0.5, 'oti', 0.36, 0.38, 0.42, H)
  }

  // —— 檐口（只做在临空的边上；与相邻楼共用的界墙跳过，否则连排店屋屋面上会出现横线） ——
  const runs = facadeRuns(b, outer)
  const open = openMask(L, bi, ras)
  if (cls === 2) {
    // 屋檐两级外挑 + 首层顶线脚（招牌梁处）
    band(det, L, 0, 0.14, H - 0.36, H - 0.22, 'ob', br * 1.05, bg * 1.05, bb * 1.05, H, open)
    band(det, L, 0, 0.38, H - 0.22, H, 'obt', br * 0.9, bg * 0.9, bb * 0.9, H, open)
    if (H > D.shopBase + 1.5) band(det, L, 0, 0.25, D.shopBeam0 + 0.02, D.shopBase - 0.02, 'ob', br * 0.95, bg * 0.95, bb * 0.95, 0, open)
  } else if (cls === 0 && H < 70 && hash01(b.id, 22) < 0.55) {
    const g = facadeGrid(cls, seed, 0, 10, H, false)
    const yc = g.topY
    band(det, L, 0, 0.1, yc - 0.28, yc - 0.1, 'ob', br, bg, bb, 0, open)
    band(det, L, 0, 0.3, yc - 0.1, yc + 0.12, 'obt', br * 1.08, bg * 1.08, bb * 1.08, 0, open)
  }

  // —— 店屋五脚基檐篷 + 柱 ——
  if (cls === 2) appendCanopies(det, bodies, b, runs, H, bi, ras, br, bg, bb)

  // —— 空调外机 ——
  if (cls === 0 || cls === 1) appendAC(det, b, runs, H, seed)

  // —— 屋顶设备 ——
  if ((cls === 0 || cls === 1 || cls === 3) && area > 80) appendRoof(det, b, L, H, area, br, bg, bb)
}

/** 每条边是否临空：边上 3 点外移 0.6 m，≥ 2 点落在别的楼足迹里 = 界墙 */
function openMask(L: Loop, bi: number, ras: Raster): Uint8Array {
  const m = L.x.length, out = new Uint8Array(m)
  for (let k = 0; k < m; k++) {
    let hits = 0
    for (const f of [0.25, 0.5, 0.75]) {
      const t = L.len[k] * f
      const v = ras.at(L.x[k] + L.ux[k] * t + L.nx[k] * 0.6, L.z[k] + L.uz[k] * t + L.nz[k] * 0.6)
      if (v >= R_BLD && v !== R_OUT && v !== R_BLD + bi) hits++
    }
    out[k] = hits >= 2 ? 0 : 1
  }
  return out
}

/** 建筑前铺装带（外环逐段按栅格量深度） */
function appendApron(apron: Buf, L: Loop, bi: number, ras: Raster) {
  const m = L.x.length
  const PIECE = 2.5, INSET = 0.05
  const depthAt = (x: number, z: number, nx: number, nz: number): number => {
    // 10 m 内碰到人行道：一直铺到人行道下（组屋/办公楼前的退界空地整片铺装）；其它情况最多 4 m
    const h = ras.march(x, z, nx, nz, APRON_REACH, bi, tmpHit)
    if (h.kind === R_WALK) return h.d + 0.3
    if (h.kind === R_ROAD) return h.d <= 4.5 ? h.d - 0.5 : APRON_DEF
    if (h.kind === R_OUT) return Math.min(h.d - 0.25, APRON_DEF)
    if (h.kind === R_BLD) return h.d <= 4 ? h.d : APRON_DEF
    return APRON_DEF
  }
  // 每边起止点的深度（给转角填充用）
  const firstD: number[] = new Array(m), lastD: number[] = new Array(m)
  for (let k = 0; k < m; k++) {
    const ux = L.ux[k], uz = L.uz[k], nx = L.nx[k], nz = L.nz[k], len = L.len[k]
    const np = Math.max(1, Math.ceil(len / PIECE))
    const ds: number[] = []
    for (let p = 0; p < np; p++) {
      const tm = len * (p + 0.5) / np
      const d = depthAt(L.x[k] + ux * tm, L.z[k] + uz * tm, nx, nz)
      ds.push(d < 0.2 ? 0 : d)
    }
    firstD[k] = ds[0]; lastD[k] = ds[np - 1]
    // 深度相同（差 < 5 cm）的相邻段合并成一块
    for (let p = 0; p < np;) {
      let q = p + 1
      while (q < np && Math.abs(ds[q] - ds[p]) < 0.05) q++
      const d = ds[p], t0 = len * p / np, t1 = len * q / np
      const ax = L.x[k] + ux * t0 - nx * INSET, az = L.z[k] + uz * t0 - nz * INSET
      const bx = L.x[k] + ux * t1 - nx * INSET, bz = L.z[k] + uz * t1 - nz * INSET
      if (d > 0) {
        const D2 = d + INSET
        const cx = ax + nx * D2, cz = az + nz * D2, ex = bx + nx * D2, ez = bz + nz * D2
        apron.quad([ax, APRON_Y, az, bx, APRON_Y, bz, ex, APRON_Y, ez, cx, APRON_Y, cz], 0, 1, 0, 1, 1, 1, 0)
        const sa = cx * ux + cz * uz
        apron.quad([cx, GROUND_Y, cz, ex, GROUND_Y, ez, ex, APRON_Y, ez, cx, APRON_Y, cz], nx, 0, nz, 1, 1, 1, 2, sa, sa + (t1 - t0))
      }
      // 与下一组深度不同：台阶侧面
      if (q < np) {
        const d2 = ds[q]
        const lo = Math.min(d, d2) + INSET, hi = Math.max(d, d2) + INSET
        const sgn = d2 > d ? -1 : 1
        apron.quad([bx + nx * lo, GROUND_Y, bz + nz * lo, bx + nx * hi, GROUND_Y, bz + nz * hi, bx + nx * hi, APRON_Y, bz + nz * hi, bx + nx * lo, APRON_Y, bz + nz * lo],
          ux * sgn, 0, uz * sgn, 1, 1, 1, 2, lo, hi)
      }
      p = q
    }
  }
  // 凸角：扇形补角（顶点 → 前一边末段外缘 → 平分线点 → 本边首段外缘）
  for (let k = 0; k < m; k++) {
    const p = (k - 1 + m) % m
    if (L.ux[k] * L.nx[p] + L.uz[k] * L.nz[p] > -1e-3) continue   // 非凸角
    const d1 = lastD[p], d2 = firstD[k]
    if (d1 <= 0 || d2 <= 0) continue
    const vx = L.x[k], vz = L.z[k]
    let mx = L.nx[p] + L.nx[k], mz = L.nz[p] + L.nz[k]
    const ml = Math.hypot(mx, mz) || 1
    mx /= ml; mz /= ml
    const dm = Math.min(d1, d2)
    const p1x = vx + L.nx[p] * d1, p1z = vz + L.nz[p] * d1
    const pmx = vx + mx * dm, pmz = vz + mz * dm
    const p2x = vx + L.nx[k] * d2, p2z = vz + L.nz[k] * d2
    apron.tri([vx, APRON_Y, vz, p1x, APRON_Y, p1z, pmx, APRON_Y, pmz], 0, 1, 0, 1, 1, 1, 0)
    apron.tri([vx, APRON_Y, vz, pmx, APRON_Y, pmz, p2x, APRON_Y, p2z], 0, 1, 0, 1, 1, 1, 0)
    for (const [ax, az, bx2, bz2] of [[p1x, p1z, pmx, pmz], [pmx, pmz, p2x, p2z]]) {
      let nx = -(bz2 - az), nz = bx2 - ax
      const nl = Math.hypot(nx, nz)
      if (nl < 1e-3) continue
      nx /= nl; nz /= nl
      if (nx * ((ax + bx2) / 2 - vx) + nz * ((az + bz2) / 2 - vz) < 0) { nx = -nx; nz = -nz }
      apron.quad([ax, GROUND_Y, az, bx2, GROUND_Y, bz2, bx2, APRON_Y, bz2, ax, APRON_Y, az], nx, 0, nz, 1, 1, 1, 2, 0, nl)
    }
  }
}

/** 店屋临街立面：首层顶檐篷板 + 外缘柱（开间分界，与着色器拱廊柱对齐） */
function appendCanopies(det: Buf, bodies: StaticBody[], b: ChunkBuilding, runs: Run[], H: number, bi: number, ras: Raster, br: number, bg: number, bb: number) {
  if (H < D.shopBase + 1.5) return
  const seed = hash01(b.id, 11)
  // 檐篷顶面色：深灰绿 / 赤陶 / 灰白（按楼）
  const tops = [[0.16, 0.2, 0.18], [0.42, 0.2, 0.12], [0.5, 0.5, 0.48]]
  const tc = tops[Math.floor(hash01(b.id, 23) * tops.length)]
  // 檐口板前沿：偏奶白的抹灰（着色器每开间换粉彩色，几何没法逐开间对色，取中性）
  const fr = br * 0.35 + 0.42, fg = bg * 0.35 + 0.41, fb = bb * 0.35 + 0.38
  for (const run of runs) {
    if (run.W < 2.5) continue
    const g = facadeGrid(2, seed, run.rs, run.W, H, run.closed)
    for (const e of run.edges) {
      if (e.len < 2) continue
      // 临街判定：边上 3 个采样点沿外法线 12 m 内先碰到人行道/车行道
      let hits = 0, gap = Infinity, road = false
      for (const f of [0.2, 0.5, 0.8]) {
        const h = ras.march(e.x0 + e.ux * e.len * f, e.z0 + e.uz * e.len * f, e.nx, e.nz, 12, bi, tmpHit)
        if (h.kind !== R_WALK && h.kind !== R_ROAD) continue
        hits++
        gap = Math.min(gap, h.d - 0.25)
        if (h.kind === R_ROAD) road = true
      }
      if (hits < 2) { COUNT.notStreet++; continue }
      let depth: number, cols: boolean
      if (road) { depth = Math.min(1.5, gap - 0.4); cols = false }            // 直接临车行道：短悬挑，不立柱
      else if (gap >= 1.6) { depth = Math.min(2.0, gap - 0.1); cols = true }   // 墙与人行道间有空地：外挑 + 柱
      else { depth = Math.min(1.6, gap + 1.0); cols = false }                 // 空地不够：无柱悬挑，最多伸进人行道 1 m
      if (depth < 0.8) continue
      COUNT.canopy++
      const x0 = e.x0, z0 = e.z0, x1 = e.x1, z1 = e.z1, nx = e.nx, nz = e.nz
      const ox = nx * depth, oz = nz * depth
      // 檐篷板：顶 / 底 / 前沿 / 两端
      det.quad([x0, CANOPY_Y1, z0, x1, CANOPY_Y1, z1, x1 + ox, CANOPY_Y1 - 0.05, z1 + oz, x0 + ox, CANOPY_Y1 - 0.05, z0 + oz], 0, 1, 0, tc[0], tc[1], tc[2])
      det.quad([x0, CANOPY_Y0, z0, x1, CANOPY_Y0, z1, x1 + ox, CANOPY_Y0, z1 + oz, x0 + ox, CANOPY_Y0, z0 + oz], 0, -1, 0, 0.3, 0.29, 0.28)
      det.quad([x0 + ox, CANOPY_Y0, z0 + oz, x1 + ox, CANOPY_Y0, z1 + oz, x1 + ox, CANOPY_Y1 - 0.05, z1 + oz, x0 + ox, CANOPY_Y1 - 0.05, z0 + oz], nx, 0, nz, fr, fg, fb)
      det.quad([x0, CANOPY_Y0, z0, x0 + ox, CANOPY_Y0, z0 + oz, x0 + ox, CANOPY_Y1 - 0.05, z0 + oz, x0, CANOPY_Y1, z0], -e.ux, 0, -e.uz, fr * 0.92, fg * 0.92, fb * 0.92)
      det.quad([x1, CANOPY_Y0, z1, x1 + ox, CANOPY_Y0, z1 + oz, x1 + ox, CANOPY_Y1 - 0.05, z1 + oz, x1, CANOPY_Y1, z1], e.ux, 0, e.uz, fr * 0.92, fg * 0.92, fb * 0.92)
      if (!cols) continue
      // 柱：开间分界 s = pier + k·bw（与 FacadeShader 拱廊柱同位），落在本边内（离两端 ≥ 0.2 m）。
      // 连排店屋：立面起点紧贴别的楼（界墙）时不立 k = 0 的柱——邻楼末端那根柱就在旁边，避免 0.7 m 内两根柱
      const cd = depth - 0.22
      const party = (() => {
        const v = ras.at(e.x0 - e.ux * 0.6 - nx * 0.6, e.z0 - e.uz * 0.6 - nz * 0.6)
        return v >= R_BLD && v !== R_OUT && v !== R_BLD + bi
      })()
      for (let k = e.s0 === 0 && party ? 1 : 0; k <= g.bays; k++) {
        const s = g.pier + k * g.bw
        if (s < e.s0 + 0.2 || s > e.s0 + e.len - 0.2) continue
        const t = s - e.s0
        const cx = x0 + e.ux * t + nx * cd, cz = z0 + e.uz * t + nz * cd
        const hw = COL_W / 2
        det.box(cx, cz, APRON_Y - 0.02, CANOPY_Y0 - APRON_Y + 0.02, e.ux, e.uz, hw, hw, br * 1.02, bg * 1.02, bb * 1.02, 1, true)
        const ex = hw * (Math.abs(e.ux) + Math.abs(e.uz))
        COUNT.cols++
        bodies.push({ minX: cx - ex, maxX: cx + ex, minZ: cz - ex, maxZ: cz + ex, h: CANOPY_Y0 })
      }
    }
  }
}

/** 空调外机：窗台下方，按着色器窗格位置 */
function appendAC(det: Buf, b: ChunkBuilding, runs: Run[], H: number, seed: number) {
  const cls = b.cls
  let count = 0
  const MAX = 140
  runs.forEach((run, ri) => {
    if (run.W < 2.5 || count >= MAX) return
    const g = facadeGrid(cls, seed, run.rs, run.W, H, run.closed)
    if (g.corridor) return
    const p = cls === 1 ? 0.2 : g.ribbon ? 0.08 : 0.12
    for (let f = cls === 1 ? 0 : 1; ; f++) {
      const fy = g.yBase + f * g.floorH
      if (fy + g.floorH > g.topY + 0.02) break
      for (let i = 0; i < g.bays; i++) {
        const hh = hash01(b.id * 977 + ri * 131071 + i * 613 + f * 37, 21)
        if (hh >= p) continue
        // 窗中线 ± 小偏移；外机 0.76 × 0.5 × 0.3 m，下沿离楼板 0.2 m（窗台 0.9 m 以下）
        const s = g.pier + (i + 0.5) * g.bw + (hash01(b.id + i * 7 + f * 13, 22) - 0.5) * Math.max(0, g.bw - 1.0) * 0.6
        const e = edgeAt(run, s, 0.5)
        if (!e) continue
        const t = s - e.s0
        const cx = e.x0 + e.ux * t + e.nx * 0.16, cz = e.z0 + e.uz * t + e.nz * 0.16
        const shade = 0.62 + 0.12 * hh / p
        det.box(cx, cz, fy + 0.2, 0.5, e.ux, e.uz, 0.38, 0.15, shade, shade, shade * 0.97, 1.05)
        COUNT.ac++
        if (++count >= MAX) return
      }
    }
  })
}

/** 屋顶设备：HDB 电梯机房 + 水箱；普通楼/玻璃塔机电盒 + 冷却塔 */
function appendRoof(det: Buf, b: ChunkBuilding, L: Loop, H: number, area: number, br: number, bg: number, bb: number) {
  // 主轴：最长边
  let best = 0, ux = 1, uz = 0
  for (let k = 0; k < L.x.length; k++) if (L.len[k] > best) { best = L.len[k]; ux = L.ux[k]; uz = L.uz[k] }
  const vx = -uz, vz = ux
  // 包围盒（主轴坐标）
  let u0 = Infinity, u1 = -Infinity, v0 = Infinity, v1 = -Infinity
  for (let k = 0; k < L.x.length; k++) {
    const u = L.x[k] * ux + L.z[k] * uz, v = L.x[k] * vx + L.z[k] * vz
    u0 = Math.min(u0, u); u1 = Math.max(u1, u); v0 = Math.min(v0, v); v1 = Math.max(v1, v)
  }
  const placed: number[] = []
  let salt = 40
  /** 随机找一个离墙 ≥ r + 1.2 m、不与已放物件重叠的点 */
  const spot = (r: number): [number, number] | null => {
    for (let tries = 0; tries < 14; tries++) {
      const u = u0 + (u1 - u0) * hash01(b.id, salt++), v = v0 + (v1 - v0) * hash01(b.id, salt++)
      const x = ux * u + vx * v, z = uz * u + vz * v
      if (!inLoop(L, x, z) || distToLoop(L, x, z) < r + 1.2) continue
      let ok = true
      for (let q = 0; q < placed.length; q += 3) if (Math.hypot(placed[q] - x, placed[q + 1] - z) < placed[q + 2] + r + 0.6) { ok = false; break }
      if (!ok) continue
      placed.push(x, z, r)
      return [x, z]
    }
    return null
  }
  const rnd = () => hash01(b.id, salt++)
  if (b.cls === 1) {
    // 电梯机房：沿长轴分布（每 ~300 m² 一个，1–5 个），墙色
    const n = clamp(Math.round(area / 300), 1, 5)
    for (let q = 0; q < n; q++) {
      const hu = 1.6 + 0.5 * rnd(), hv = 1.5 + 0.4 * rnd()
      const p = spot(Math.hypot(hu, hv)); if (!p) continue
      det.box(p[0], p[1], H - 0.05, 3.0 + 0.6 * rnd(), ux, uz, hu, hv, br * 0.96, bg * 0.96, bb * 0.96, 0.85)
    }
    // 水箱：基座 + 箱体
    const p = spot(3.0)
    if (p) {
      det.box(p[0], p[1], H - 0.05, 0.65, ux, uz, 2.6, 1.7, 0.42, 0.42, 0.42, 1)
      det.box(p[0], p[1], H + 0.6, 2.4, ux, uz, 2.4, 1.5, 0.66, 0.7, 0.72, 1.05)
    }
    return
  }
  // 机电设备盒（灰）
  const nBox = Math.min(5, 1 + Math.floor(area / 450))
  for (let q = 0; q < nBox; q++) {
    const hu = 1.0 + 1.3 * rnd(), hv = 0.9 + 0.9 * rnd()
    const p = spot(Math.hypot(hu, hv)); if (!p) continue
    const s = 0.42 + 0.16 * rnd()
    det.box(p[0], p[1], H - 0.05, 1.4 + 1.3 * rnd(), ux, uz, hu, hv, s, s * 1.01, s * 1.03, 1.08)
  }
  // 冷却塔（八棱柱）
  if (area > 350) {
    const nT = area > 1500 ? 2 : 1
    for (let q = 0; q < nT; q++) {
      const r = 1.5 + 0.7 * rnd()
      const p = spot(r); if (!p) continue
      det.box(p[0], p[1], H - 0.05, 0.5, ux, uz, r + 0.2, r + 0.2, 0.35, 0.35, 0.36, 1)
      det.prism(p[0], p[1], H + 0.45, 2.0 + 0.9 * rnd(), r, 0.6, 0.62, 0.64)
    }
  }
}
