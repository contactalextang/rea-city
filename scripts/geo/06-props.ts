// 第 6 步：街道小品（props）。从 LTA 灯柱 / 红绿灯 / 巴士站 / 德士站 / ERP 龙门架 / 地铁出口 /
// 有盖走廊 / 天桥，以及公园与住宅路两侧的树，生成带朝向的点位 → data/geo/build/props.json。
// 依赖 05-landuse 的 landuse.json（parks 多边形用于种树）。
// P14.4：再沿 graph.json 的人行道（路缘外 2 m 带）撒街道小件——路口行人护栏 / 垃圾桶 / 消防栓 / 护柱 / 花槽，
// 避开路口圆帽、斑马线、车行道、建筑足迹与已有道具（依赖 03-roads 的 graph.json、04-buildings 的 buildings.json）。
// 用法：node scripts/geo/06-props.ts
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { GEO_DIR, LOCAL_DIR, ensureDir, fileSize, fmtBytes, log, warn } from './lib/common.ts';
import { pointInPolygon } from './lib/raster.ts';
import { PolyGrid, RoadBands, type Poly } from './lib/clearance.ts';
import type { Ring } from './lib/geom.ts';
import type { GraphData } from './lib/graph-types.ts';

type PropType = 'lamp' | 'signal' | 'busstop' | 'taxistand' | 'gantry' | 'mrtexit' | 'linkway' | 'bridge' | 'tree' | 'railing' | 'bin' | 'hydrant' | 'bollard' | 'planter';
interface Prop {
  type: PropType;
  x: number;
  z: number;
  /** 弧度，0 朝 +z，逆时针（从 +z 转向 +x）为正：yaw = atan2(dx, dz) */
  yaw: number;
  /** gantry 跨度 / linkway、bridge 主轴长度 / railing 护栏长度（m） */
  len?: number;
  name?: string;
}

type Pos = [number, number];
type Poly = Pos[][];
interface Feature {
  properties: Record<string, unknown> | null;
  geometry: { type: string; coordinates: unknown } | null;
}

/** 车行道 highway 取值 */
const CARRIAGEWAY = new Set(['motorway', 'motorway_link', 'trunk', 'trunk_link', 'primary', 'primary_link', 'secondary', 'secondary_link', 'tertiary', 'tertiary_link', 'residential', 'unclassified', 'living_street', 'service', 'road']);
/** 没有 lanes 标签时按道路等级估计车道数 */
const DEFAULT_LANES: Record<string, number> = { motorway: 3, trunk: 3, primary: 3, secondary: 2, tertiary: 2, residential: 2, unclassified: 2, living_street: 1, service: 1, road: 2 };
const LANE_W = 3.3;
/** 点位找最近车行道的搜索半径（m） */
const ROAD_SNAP = 25;
const TREE_CAP = 6000;
const PARK_M2_PER_TREE = 150;
const ROAD_TREE_STEP = 25;
/** 地铁出口：3×3 m 盒的半对角、离路缘净空、最大推移距离（m）。车行道口径用 graph.json（与运行时 RoadClearance 一致） */
const MRT_R = 2.1;
const MRT_MARGIN = 0.8;
const MRT_MAX_PUSH = 12; // 8 m 会丢掉 City Hall C / Raffles Place J / Esplanade B（需 8.5–11 m）
/** 新加坡靠左行驶：边的行驶侧人行道在左（与运行时 config.DRIVE_SIDE 一致） */
const DRIVE_SIDE = -1;
/** 街道小件：距路缘（车行道边）的横向距离 (m)。人行道 2 m 宽、行人走中线（路缘外 1 m），小件都贴路缘一侧放 */
const SF_OFF = { railing: 0.3, bin: 0.45, hydrant: 0.4, bollard: 0.35, planter: 0.4 } as const;
/** 撒点间距 (m)：垃圾桶 / 消防栓 / 花槽按边弧长等距（带确定性抖动） */
const BIN_STEP = 95;
const HYDRANT_STEP = 140;
const PLANTER_STEP = 90;
/** 护栏：路口一侧最长 12 m（2 m 一节），离路口圆帽 1 m 起 */
const RAIL_MAX = 12;
const RAIL_MIN = 4;
/** 斑马线全长（与 08-roadmesh ZEBRA_LEN 一致） */
const ZEBRA_LEN = 2.4;
/** 米制 → 弧度 yaw（0 朝 +z） */
const yawOf = (dx: number, dz: number) => Math.atan2(dx, dz);

// ---------------------------------------------------------------------------
// 读数据
// ---------------------------------------------------------------------------
function loadFeatures(name: string): Feature[] {
  const path = resolve(LOCAL_DIR, `${name}.geojson`);
  if (fileSize(path) <= 0) {
    warn(`${name}.geojson missing, skipped`);
    return [];
  }
  return (JSON.parse(readFileSync(path, 'utf8')) as { features: Feature[] }).features;
}
function polygonsOf(f: Feature): Poly[] {
  const g = f.geometry;
  if (!g) return [];
  if (g.type === 'Polygon') return [g.coordinates as Poly];
  if (g.type === 'MultiPolygon') return g.coordinates as Poly[];
  return [];
}
function linesOf(f: Feature): Pos[][] {
  const g = f.geometry;
  if (!g) return [];
  if (g.type === 'LineString') return [g.coordinates as Pos[]];
  if (g.type === 'MultiLineString') return g.coordinates as Pos[][];
  return [];
}
function pointsOf(f: Feature): Pos[] {
  const g = f.geometry;
  if (!g) return [];
  if (g.type === 'Point') return [g.coordinates as Pos];
  if (g.type === 'MultiPoint') return g.coordinates as Pos[];
  return [];
}

// ---------------------------------------------------------------------------
// 车行道线段网格索引（最近线段查询）
// ---------------------------------------------------------------------------
interface Seg {
  ax: number;
  az: number;
  bx: number;
  bz: number;
  highway: string;
  lanes: number;
}
interface Hit {
  seg: Seg;
  dist: number;
  fx: number;
  fz: number;
  /** 单位方向向量（沿线段 a→b） */
  dx: number;
  dz: number;
}

class SegIndex {
  private cell = 50;
  private grid = new Map<string, Seg[]>();
  private key(cx: number, cz: number) {
    return `${cx},${cz}`;
  }
  add(seg: Seg): void {
    const c = this.cell;
    const x0 = Math.floor(Math.min(seg.ax, seg.bx) / c), x1 = Math.floor(Math.max(seg.ax, seg.bx) / c);
    const z0 = Math.floor(Math.min(seg.az, seg.bz) / c), z1 = Math.floor(Math.max(seg.az, seg.bz) / c);
    for (let cx = x0; cx <= x1; cx++)
      for (let cz = z0; cz <= z1; cz++) {
        const k = this.key(cx, cz);
        let arr = this.grid.get(k);
        if (!arr) this.grid.set(k, (arr = []));
        arr.push(seg);
      }
  }
  nearest(x: number, z: number, maxDist: number): Hit | null {
    const c = this.cell;
    const r = Math.ceil(maxDist / c);
    const cx0 = Math.floor(x / c), cz0 = Math.floor(z / c);
    let best: Hit | null = null;
    for (let cx = cx0 - r; cx <= cx0 + r; cx++)
      for (let cz = cz0 - r; cz <= cz0 + r; cz++) {
        const arr = this.grid.get(this.key(cx, cz));
        if (!arr) continue;
        for (const s of arr) {
          const vx = s.bx - s.ax, vz = s.bz - s.az;
          const l2 = vx * vx + vz * vz;
          if (l2 === 0) continue;
          let t = ((x - s.ax) * vx + (z - s.az) * vz) / l2;
          t = Math.max(0, Math.min(1, t));
          const fx = s.ax + t * vx, fz = s.az + t * vz;
          const d = Math.hypot(x - fx, z - fz);
          if (d <= maxDist && (!best || d < best.dist)) {
            const l = Math.sqrt(l2);
            best = { seg: s, dist: d, fx, fz, dx: vx / l, dz: vz / l };
          }
        }
      }
    return best;
  }
}

function lanesOf(p: Record<string, unknown>, highway: string): number {
  const n = Number(p.lanes);
  if (Number.isFinite(n) && n > 0) return n;
  return DEFAULT_LANES[highway] ?? 2;
}

function buildRoadIndex(lines: Feature[]): { index: SegIndex; roads: { highway: string; lanes: number; coords: Pos[] }[] } {
  const index = new SegIndex();
  const roads: { highway: string; lanes: number; coords: Pos[] }[] = [];
  for (const f of lines) {
    const p = f.properties ?? {};
    const highway = String(p.highway ?? '');
    if (!CARRIAGEWAY.has(highway)) continue;
    const lanes = lanesOf(p, highway);
    for (const coords of linesOf(f)) {
      roads.push({ highway, lanes, coords });
      for (let i = 0; i + 1 < coords.length; i++) index.add({ ax: coords[i][0], az: coords[i][1], bx: coords[i + 1][0], bz: coords[i + 1][1], highway, lanes });
    }
  }
  return { index, roads };
}

// ---------------------------------------------------------------------------
// 几何：最小外接矩形主轴（凸包 + 旋转卡壳）
// ---------------------------------------------------------------------------
function convexHull(pts: Pos[]): Pos[] {
  const p = [...pts].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  if (p.length < 3) return p;
  const cross = (o: Pos, a: Pos, b: Pos) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower: Pos[] = [];
  for (const q of p) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], q) <= 0) lower.pop();
    lower.push(q);
  }
  const upper: Pos[] = [];
  for (let i = p.length - 1; i >= 0; i--) {
    const q = p[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], q) <= 0) upper.pop();
    upper.push(q);
  }
  upper.pop();
  lower.pop();
  return lower.concat(upper);
}

/** 返回最小面积外接矩形：中心、主轴（长边）方向单位向量、长边长度、短边长度 */
function minAreaRect(pts: Pos[]): { cx: number; cz: number; ux: number; uz: number; len: number; wid: number } {
  const hull = convexHull(pts);
  let best: { area: number; cx: number; cz: number; ux: number; uz: number; len: number; wid: number } | null = null;
  const n = hull.length;
  const tryAxis = (ux: number, uz: number) => {
    // 投影到 (u, v)，v 为 u 逆时针旋转 90°
    const vx = -uz, vz = ux;
    let u0 = Infinity, u1 = -Infinity, v0 = Infinity, v1 = -Infinity;
    for (const [x, z] of hull) {
      const u = x * ux + z * uz, v = x * vx + z * vz;
      if (u < u0) u0 = u;
      if (u > u1) u1 = u;
      if (v < v0) v0 = v;
      if (v > v1) v1 = v;
    }
    const lu = u1 - u0, lv = v1 - v0;
    const area = lu * lv;
    if (best && area >= best.area) return;
    const cu = (u0 + u1) / 2, cv = (v0 + v1) / 2;
    const cx = cu * ux + cv * vx, cz = cu * uz + cv * vz;
    best = lu >= lv ? { area, cx, cz, ux, uz, len: lu, wid: lv } : { area, cx, cz, ux: vx, uz: vz, len: lv, wid: lu };
  };
  if (n < 2) {
    const [x, z] = hull[0] ?? [0, 0];
    return { cx: x, cz: z, ux: 0, uz: 1, len: 0, wid: 0 };
  }
  for (let i = 0; i < n; i++) {
    const a = hull[i], b = hull[(i + 1) % n];
    const dx = b[0] - a[0], dz = b[1] - a[1];
    const l = Math.hypot(dx, dz);
    if (l === 0) continue;
    tryAxis(dx / l, dz / l);
  }
  if (!best) tryAxis(1, 0);
  return best!;
}

function ringArea(ring: Pos[]): number {
  let a = 0;
  for (let i = 0, n = ring.length; i < n; i++) a += ring[i][0] * ring[(i + 1) % n][1] - ring[(i + 1) % n][0] * ring[i][1];
  return Math.abs(a) / 2;
}
function ringBBox(ring: Pos[]): [number, number, number, number] {
  let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity;
  for (const [x, z] of ring) {
    if (x < x0) x0 = x;
    if (x > x1) x1 = x;
    if (z < z0) z0 = z;
    if (z > z1) z1 = z;
  }
  return [x0, z0, x1, z1];
}

/** mulberry32 确定性 PRNG */
function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------------------------------------------------------------------------
// URA 地块网格索引（判断某点是否在住宅 / 公园地块内）
// ---------------------------------------------------------------------------
class PolyIndex {
  private cell = 100;
  private grid = new Map<string, { bbox: [number, number, number, number]; poly: Poly }[]>();
  add(poly: Poly): void {
    const bbox = ringBBox(poly[0]);
    const c = this.cell;
    for (let cx = Math.floor(bbox[0] / c); cx <= Math.floor(bbox[2] / c); cx++)
      for (let cz = Math.floor(bbox[1] / c); cz <= Math.floor(bbox[3] / c); cz++) {
        const k = `${cx},${cz}`;
        let arr = this.grid.get(k);
        if (!arr) this.grid.set(k, (arr = []));
        arr.push({ bbox, poly });
      }
  }
  contains(x: number, z: number): boolean {
    const arr = this.grid.get(`${Math.floor(x / this.cell)},${Math.floor(z / this.cell)}`);
    if (!arr) return false;
    for (const { bbox, poly } of arr) {
      if (x < bbox[0] || x > bbox[2] || z < bbox[1] || z > bbox[3]) continue;
      if (pointInPolygon(x, z, poly)) return true;
    }
    return false;
  }
}

// ---------------------------------------------------------------------------
// P14.4 街道小件：沿 graph.json 每条边的行驶侧人行道撒点
// ---------------------------------------------------------------------------
interface BuildingRec {
  ring: number[];
  holes?: number[][];
}
const toRing = (flat: number[]): Ring => {
  const r: Ring = [];
  for (let k = 0; k + 1 < flat.length; k += 2) r.push([flat[k], flat[k + 1]] as Pos);
  return r;
};
function loadBuildingGrid(buildDir: string): PolyGrid | null {
  const path = resolve(buildDir, 'buildings.json');
  if (fileSize(path) <= 0) {
    warn('buildings.json missing — street furniture not checked against footprints');
    return null;
  }
  const grid = new PolyGrid();
  for (const b of JSON.parse(readFileSync(path, 'utf8')) as BuildingRec[]) grid.add({ outer: toRing(b.ring), holes: (b.holes ?? []).map(toRing) } as Poly);
  return grid;
}

/** 已占位的圆（4 m 网格）：已有道具 + 新撒的小件互相避让 */
class Occupancy {
  private cells = new Map<number, number[]>();
  private key(cx: number, cz: number) {
    return (cx + 8192) * 16384 + (cz + 8192);
  }
  add(x: number, z: number, r: number) {
    const k = this.key(Math.floor(x / 4), Math.floor(z / 4));
    let l = this.cells.get(k);
    if (!l) this.cells.set(k, (l = []));
    l.push(x, z, r);
  }
  /** 半径 r 的圆与已占位圆的间隙 < gap 即冲突（查 ±2 格 = 8 m：占位圆 ≤ 4 m、查询 r + gap ≤ 4 m） */
  hit(x: number, z: number, r: number, gap: number): boolean {
    const cx = Math.floor(x / 4), cz = Math.floor(z / 4);
    for (let i = cx - 2; i <= cx + 2; i++)
      for (let j = cz - 2; j <= cz + 2; j++) {
        const l = this.cells.get(this.key(i, j));
        if (!l) continue;
        for (let k = 0; k < l.length; k += 3) if (Math.hypot(l[k] - x, l[k + 1] - z) < l[k + 2] + r + gap) return true;
      }
    return false;
  }
}

/** 折线弧长 t 处的点与单位方向 */
function polyAt(pts: number[], cum: number[], t: number): { x: number; z: number; dx: number; dz: number } {
  const n = pts.length >> 1;
  let k = 0;
  while (k < n - 2 && cum[k + 1] < t) k++;
  const ax = pts[k * 2], az = pts[k * 2 + 1], bx = pts[k * 2 + 2], bz = pts[k * 2 + 3];
  const L = cum[k + 1] - cum[k];
  const u = L > 1e-6 ? Math.max(0, Math.min(1, (t - cum[k]) / L)) : 0;
  const dx = L > 1e-6 ? (bx - ax) / L : 1, dz = L > 1e-6 ? (bz - az) / L : 0;
  return { x: ax + (bx - ax) * u, z: az + (bz - az) * u, dx, dz };
}

function streetFurniture(g: GraphData, bands: RoadBands, buildings: PolyGrid | null, existing: Prop[]): { props: Prop[]; stats: Record<string, number> } {
  const r2 = (v: number) => Math.round(v * 100) / 100;
  const r3 = (v: number) => Math.round(v * 1000) / 1000;
  // occ：全部占位（小件之间、小件与杆/树互相避让）；big：只含大件（巴士站 / 地铁口 / 的士站 / 走廊 / 天桥），
  // 护栏只避大件——现实里护栏本来就绕着灯杆、信号灯杆走（杆在路缘外 0.5 m，护栏 0.3 m，视觉上不穿插）
  const occ = new Occupancy();
  const big = new Occupancy();
  const both = (x: number, z: number, r: number) => {
    occ.add(x, z, r);
    big.add(x, z, r);
  };
  // 已有道具的占位半径（巴士站 / 地铁口 / 有盖走廊 / 天桥按外形近似）
  for (const p of existing) {
    switch (p.type) {
      case 'busstop': both(p.x, p.z, 4); break;
      case 'mrtexit': both(p.x, p.z, 3.2); break;
      case 'taxistand': both(p.x, p.z, 1.5); break;
      case 'lamp': case 'signal': occ.add(p.x, p.z, 0.4); break;
      case 'tree': occ.add(p.x, p.z, 0.8); break;
      case 'linkway': case 'bridge': {
        // 沿主轴每 2 m 一个圆（天桥两端再外延 10 m 给楼梯）
        const len = (p.len ?? 6) + (p.type === 'bridge' ? 20 : 0);
        const ux = Math.sin(p.yaw), uz = Math.cos(p.yaw);
        for (let s = -len / 2; s <= len / 2; s += 2) both(p.x + ux * s, p.z + uz * s, p.type === 'bridge' ? 2.5 : 1.6);
        break;
      }
      default: break;
    }
  }
  const rand = prng(1404);
  const out: Prop[] = [];
  const stats: Record<string, number> = { railing: 0, railM: 0, bin: 0, hydrant: 0, bollard: 0, planter: 0, rejected: 0 };
  /** 点可放：不侵入车行道（含 service 与路口圆帽）、不在建筑内 */
  const clearAt = (x: number, z: number, r: number) => bands.pointDepth(x, z, r + 0.05).depth <= 1e-3 && !(buildings?.contains(x, z) ?? false);
  const NO_WALK = new Set(['expressway', 'trunk']);
  const BUSY = new Set(['primary', 'secondary', 'tertiary']);
  for (const e of g.edges) {
    if (NO_WALK.has(e.kind) || e.bridge) continue;
    const rev = e.reverse !== null ? g.edges[e.reverse] : null;
    const half = ((e.lanes + (rev ? rev.lanes : 0)) * e.laneW) / 2;
    const pts = e.pts;
    const cum = [0];
    for (let k = 2; k + 1 < pts.length; k += 2) cum.push(cum[cum.length - 1] + Math.hypot(pts[k] - pts[k - 2], pts[k + 1] - pts[k - 1]));
    const L = cum[cum.length - 1];
    const nFrom = g.nodes[e.from], nTo = g.nodes[e.to];
    const t0 = nFrom.jr + 1, t1 = L - nTo.jr - 1;
    if (t1 - t0 < 4) continue;
    // 双向路每个方向只管自己的行驶侧；单向路两侧都管
    const sides = rev ? [DRIVE_SIDE] : [DRIVE_SIDE, -DRIVE_SIDE];
    const nearCrossing = (a: number, b: number) => e.crossings.some((c) => c > a - ZEBRA_LEN / 2 - 1.5 && c < b + ZEBRA_LEN / 2 + 1.5);
    for (const side of sides) {
      const at = (t: number, d: number) => {
        const q = polyAt(pts, cum, t);
        const off = side * (half + d);
        return { x: q.x - q.dz * off, z: q.z + q.dx * off, yaw: yawOf(q.dx, q.dz) };
      };
      const place = (type: keyof typeof SF_OFF, t: number, r: number, gap: number, len = 0): boolean => {
        const d = SF_OFF[type];
        const c = at(t, d);
        // 长件（花槽）：两端也要可放
        const ends = len > 0 ? [at(t - len / 2, d), at(t + len / 2, d)] : [];
        if (!clearAt(c.x, c.z, r) || ends.some((p) => !clearAt(p.x, p.z, r)) || occ.hit(c.x, c.z, r + len / 2, gap) || nearCrossing(t - len / 2, t + len / 2)) {
          stats.rejected++;
          return false;
        }
        occ.add(c.x, c.z, r + len / 2);
        out.push({ type, x: r2(c.x), z: r2(c.z), yaw: r3(c.yaw) });
        stats[type]++;
        return true;
      };
      // 1) 路口行人护栏：信号灯路口的较繁忙道路，两端各一段（离路口圆帽 1 m 起，2 m 一节），整段逐米可放才放，否则缩短
      if (BUSY.has(e.kind)) {
        for (const end of [0, 1]) {
          if (!(end ? nTo : nFrom).signal) continue;
          // 路口口部常有斑马线：护栏从斑马线外侧开始
          let s0 = t0, s1 = t1;
          for (const c of e.crossings) {
            if (!end && c >= t0 - ZEBRA_LEN && c < t0 + 16) s0 = Math.max(s0, c + ZEBRA_LEN / 2 + 1.6);
            if (end && c <= t1 + ZEBRA_LEN && c > t1 - 16) s1 = Math.min(s1, c - ZEBRA_LEN / 2 - 1.6);
          }
          for (let len = Math.min(RAIL_MAX, Math.floor((s1 - s0) / 4) * 2); len >= RAIL_MIN; len -= 4) {
            const a = end ? s1 - len : s0, b = a + len;
            if (nearCrossing(a, b)) continue;
            let ok = true;
            for (let s = a; s <= b + 1e-6 && ok; s += 1) {
              const p = at(s, SF_OFF.railing);
              ok = clearAt(p.x, p.z, 0.1) && !big.hit(p.x, p.z, 0.1, 0.3);
            }
            if (!ok) continue;
            for (let s = a; s <= b + 1e-6; s += 2) {
              const p = at(s, SF_OFF.railing);
              both(p.x, p.z, 0.3);
            }
            const pa = at(a, SF_OFF.railing), pb = at(b, SF_OFF.railing);
            out.push({ type: 'railing', x: r2((pa.x + pb.x) / 2), z: r2((pa.z + pb.z) / 2), yaw: r3(yawOf(pb.x - pa.x, pb.z - pa.z)), len: r2(Math.hypot(pb.x - pa.x, pb.z - pa.z)) });
            stats.railing++;
            stats.railM += len;
            break;
          }
        }
      }
      // 2) 护柱：较繁忙道路的斑马线两侧各一根（行人过街口防车冲上人行道）
      for (const c of BUSY.has(e.kind) ? e.crossings : []) {
        if (c < t0 || c > t1) continue;
        for (const dir of [-1, 1]) {
          for (const k of [0]) {
            const p = at(c + dir * (ZEBRA_LEN / 2 + 0.6 + k * 1.3), SF_OFF.bollard);
            if (!clearAt(p.x, p.z, 0.12) || occ.hit(p.x, p.z, 0.12, 0.3)) {
              stats.rejected++;
              continue;
            }
            occ.add(p.x, p.z, 0.15);
            out.push({ type: 'bollard', x: r2(p.x), z: r2(p.z), yaw: r3(p.yaw) });
            stats.bollard++;
          }
        }
      }
      // 3) 垃圾桶 / 消防栓 / 花槽：等距 + 抖动（service 路不放）
      if (e.kind === 'service') continue;
      const span = t1 - t0;
      const scatter = (type: keyof typeof SF_OFF, step: number, r: number, gap: number, len = 0) => {
        let t = t0 + step * (0.3 + 0.7 * rand());
        while (t < t1) {
          // 放不下就往前挪 3 m 再试一次
          if (!place(type, t, r, gap, len) && t + 3 < t1) place(type, t + 3, r, gap, len);
          t += step * (0.8 + 0.4 * rand());
        }
      };
      if (span > 20) scatter('bin', BIN_STEP, 0.3, 2);
      if (span > 30) scatter('hydrant', HYDRANT_STEP, 0.2, 2);
      if (BUSY.has(e.kind) && span > 12) scatter('planter', PLANTER_STEP, 0.3, 1.5, 1.6);
    }
  }
  return { props: out, stats };
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------
function main(): void {
  const buildDir = resolve(GEO_DIR, 'build');
  ensureDir(buildDir);
  const r2 = (v: number) => Math.round(v * 100) / 100;
  const r3 = (v: number) => Math.round(v * 1000) / 1000;

  const { index: roads, roads: roadList } = buildRoadIndex(loadFeatures('osm-lines'));
  const props: Prop[] = [];
  const stats: Record<string, number> = {};
  const noRoad: Record<string, number> = {};
  const bump = (k: string) => (stats[k] = (stats[k] ?? 0) + 1);

  /** 点要素：yaw 取最近车行道方向 */
  const addPoints = (type: PropType, file: string, nameOf?: (p: Record<string, unknown>) => string | undefined) => {
    for (const f of loadFeatures(file)) {
      const p = f.properties ?? {};
      for (const [x, z] of pointsOf(f)) {
        const hit = roads.nearest(x, z, ROAD_SNAP);
        if (!hit) noRoad[type] = (noRoad[type] ?? 0) + 1;
        const prop: Prop = { type, x: r2(x), z: r2(z), yaw: hit ? r3(yawOf(hit.dx, hit.dz)) : 0 };
        const name = nameOf?.(p);
        if (name) prop.name = name;
        props.push(prop);
      }
    }
  };
  addPoints('lamp', 'lta-lamp-post');
  addPoints('signal', 'lta-traffic-light');
  addPoints('busstop', 'lta-bus-stop', (p) => (p.LOC_DESC ? String(p.LOC_DESC) : undefined));
  addPoints('taxistand', 'lta-taxi-stand', (p) => (p.LOC_DESC ? String(p.LOC_DESC) : undefined));
  // 地铁出口：LTA 坐标常落在车道里（City Hall Exit C 侵入 7.7 m）→ 按路网车道带 + 路口圆帽推到路缘外，推不出则丢弃
  const graphPath = resolve(buildDir, 'graph.json');
  const bands = fileSize(graphPath) > 0 ? new RoadBands(JSON.parse(readFileSync(graphPath, 'utf8')) as GraphData, true) : null;
  if (!bands) warn('graph.json missing — run 03-roads first; MRT exits not pushed off carriageway');
  const mrt = { total: 0, moved: 0, ringSearch: 0, dropped: 0, maxPush: 0, droppedNames: [] as string[] };
  const mrtStart = props.length;
  addPoints('mrtexit', 'lta-train-station-exit', (p) => [p.stn_name, p.exit_code].filter(Boolean).join(' '));
  if (bands) {
    const kept: Prop[] = [];
    for (const q of props.splice(mrtStart)) {
      mrt.total++;
      let f = bands.fit(q.x, q.z, MRT_R, MRT_MARGIN, MRT_MAX_PUSH);
      if (!f.ok) {
        // 两条路之间来回顶：环形搜索最近的净空点（0.5 m 步长、24 方向）
        search: for (let d = 0.5; d <= MRT_MAX_PUSH; d += 0.5) {
          for (let k = 0; k < 24; k++) {
            const a = (k / 24) * Math.PI * 2;
            const x = q.x + Math.cos(a) * d, z = q.z + Math.sin(a) * d;
            if (bands.pointDepth(x, z, MRT_R + MRT_MARGIN).depth <= 1e-3) {
              f = { ok: true, x, z, moved: true, dist: d };
              mrt.ringSearch++;
              break search;
            }
          }
        }
      }
      if (!f.ok) {
        mrt.dropped++;
        if (q.name) mrt.droppedNames.push(q.name);
        continue;
      }
      if (f.moved) {
        mrt.moved++;
        mrt.maxPush = Math.max(mrt.maxPush, f.dist);
        q.x = r2(f.x);
        q.z = r2(f.z);
        const hit = roads.nearest(q.x, q.z, ROAD_SNAP);
        if (hit) q.yaw = r3(yawOf(hit.dx, hit.dz));
      }
      kept.push(q);
    }
    props.push(...kept);
    log(`mrt exits: ${mrt.total}, pushed off carriageway ${mrt.moved} (max ${mrt.maxPush.toFixed(2)} m; ring search ${mrt.ringSearch}), dropped ${mrt.dropped}${mrt.droppedNames.length ? ' [' + mrt.droppedNames.join(' | ') + ']' : ''}`);
  }

  // ERP 龙门架：LTA 给的是跨路的线（实际跨度）。线有效时直接用线的中点 / 方向 / 长度；
  // 退化为点时按规格用最近道路方向 + 90°、len = 车道数 × 3.3（无 lanes 取 10）。
  let gantryFromLine = 0;
  for (const f of loadFeatures('lta-erp-gantry')) {
    const p = f.properties ?? {};
    const geoms = linesOf(f);
    const pts = geoms.length ? geoms : pointsOf(f).map((q) => [q]);
    for (const coords of pts) {
      const a = coords[0], b = coords[coords.length - 1];
      const span = Math.hypot(b[0] - a[0], b[1] - a[1]);
      const cx = (a[0] + b[0]) / 2, cz = (a[1] + b[1]) / 2;
      let yaw: number, len: number;
      if (span >= 3) {
        yaw = yawOf(b[0] - a[0], b[1] - a[1]);
        len = span;
        gantryFromLine++;
      } else {
        const hit = roads.nearest(cx, cz, ROAD_SNAP);
        if (hit) {
          yaw = yawOf(hit.dx, hit.dz) + Math.PI / 2;
          len = hit.seg.lanes * LANE_W;
        } else {
          yaw = 0;
          len = 10;
          noRoad.gantry = (noRoad.gantry ?? 0) + 1;
        }
      }
      const prop: Prop = { type: 'gantry', x: r2(cx), z: r2(cz), yaw: r3(yaw), len: r2(len) };
      if (p.GNTRY_NUM) prop.name = `ERP ${p.GNTRY_NUM}`;
      props.push(prop);
    }
  }

  // 有盖走廊 / 天桥：面 → 最小外接矩形主轴
  const addRects = (type: PropType, file: string, nameOf?: (p: Record<string, unknown>) => string | undefined) => {
    for (const f of loadFeatures(file)) {
      const p = f.properties ?? {};
      for (const poly of polygonsOf(f)) {
        const rect = minAreaRect(poly[0]);
        const prop: Prop = { type, x: r2(rect.cx), z: r2(rect.cz), yaw: r3(yawOf(rect.ux, rect.uz)), len: r2(rect.len) };
        const name = nameOf?.(p);
        if (name) prop.name = name;
        props.push(prop);
      }
    }
  };
  addRects('linkway', 'lta-covered-linkway');
  addRects('bridge', 'lta-pedestrian-overhead-bridge', (p) => (p.BRDG_NUM ? `Bridge ${p.BRDG_NUM}` : undefined));

  // 树：公园内随机 + 住宅 / 三级路两侧
  const landusePath = resolve(buildDir, 'landuse.json');
  const parkTrees: Prop[] = [];
  const roadTrees: Prop[] = [];
  const rand = prng(1);
  if (fileSize(landusePath) <= 0) {
    warn('landuse.json missing — run 05-landuse first; park trees skipped');
  } else {
    const landuse = JSON.parse(readFileSync(landusePath, 'utf8')) as { parks: { ring: number[] }[] };
    for (const { ring } of landuse.parks) {
      const pts: Pos[] = [];
      for (let i = 0; i + 1 < ring.length; i += 2) pts.push([ring[i], ring[i + 1]]);
      const area = ringArea(pts);
      const n = Math.floor(area / PARK_M2_PER_TREE);
      if (n === 0) continue;
      const [x0, z0, x1, z1] = ringBBox(pts);
      let placed = 0, tries = 0;
      while (placed < n && tries < n * 20) {
        tries++;
        const x = x0 + rand() * (x1 - x0), z = z0 + rand() * (z1 - z0);
        if (!pointInPolygon(x, z, [pts])) continue;
        parkTrees.push({ type: 'tree', x: r2(x), z: r2(z), yaw: r3(rand() * Math.PI * 2) });
        placed++;
      }
    }
  }
  // URA 住宅 / 公园地块索引，路边树只种在这些地块内
  const plots = new PolyIndex();
  const RES_OR_PARK = new Set(['RESIDENTIAL', 'RESIDENTIAL WITH COMMERCIAL AT 1ST STOREY', 'COMMERCIAL & RESIDENTIAL', 'PARK', 'OPEN SPACE']);
  for (const f of loadFeatures('ura-landuse')) {
    if (!RES_OR_PARK.has(String(f.properties?.LU_DESC ?? '').toUpperCase())) continue;
    for (const poly of polygonsOf(f)) plots.add(poly);
  }
  for (const road of roadList) {
    if (road.highway !== 'residential' && road.highway !== 'tertiary') continue;
    const off = (road.lanes * LANE_W) / 2 + 3;
    let carry = ROAD_TREE_STEP / 2; // 下一棵树离当前段起点的距离
    const c = road.coords;
    for (let i = 0; i + 1 < c.length; i++) {
      const dx = c[i + 1][0] - c[i][0], dz = c[i + 1][1] - c[i][1];
      const l = Math.hypot(dx, dz);
      if (l === 0) continue;
      const ux = dx / l, uz = dz / l;
      // 道路左右法向（x 东 z 南：左 = (dz, -dx)，右 = (-dz, dx)）
      const yaw = yawOf(ux, uz);
      for (let s = carry; s <= l; s += ROAD_TREE_STEP) {
        const px = c[i][0] + ux * s, pz = c[i][1] + uz * s;
        for (const sign of [1, -1]) {
          const x = px + sign * uz * off, z = pz - sign * ux * off;
          if (plots.contains(x, z)) roadTrees.push({ type: 'tree', x: r2(x), z: r2(z), yaw: r3(yaw) });
        }
      }
      carry = ((carry - l) % ROAD_TREE_STEP + ROAD_TREE_STEP) % ROAD_TREE_STEP;
    }
  }
  const treeTotal = parkTrees.length + roadTrees.length;
  let trees = parkTrees.concat(roadTrees);
  if (treeTotal > TREE_CAP) {
    // 超限时保留全部路边树，公园树等间隔确定性抽稀到剩余额度
    const budget = Math.max(0, TREE_CAP - roadTrees.length);
    const keepRatio = budget / parkTrees.length;
    const thinned = parkTrees.filter((_, i) => Math.floor(i * keepRatio) !== Math.floor((i - 1) * keepRatio));
    trees = roadTrees.concat(thinned).slice(0, TREE_CAP);
  }
  props.push(...trees);

  // 去重：同类型 1 m 内合并（保留先出现的）
  const seen = new Set<string>();
  const deduped: Prop[] = [];
  let dupes = 0;
  for (const p of props) {
    const k = `${p.type}:${Math.round(p.x)}:${Math.round(p.z)}`;
    if (seen.has(k)) {
      dupes++;
      continue;
    }
    seen.add(k);
    deduped.push(p);
    bump(p.type);
  }

  // P14.4 街道小件（在去重后追加：已有道具都已定位，用来避让）
  const sf = bands && fileSize(graphPath) > 0
    ? streetFurniture(JSON.parse(readFileSync(graphPath, 'utf8')) as GraphData, bands, loadBuildingGrid(buildDir), deduped)
    : null;
  if (!sf) warn('graph.json missing — street furniture skipped');
  else {
    for (const p of sf.props) {
      deduped.push(p);
      bump(p.type);
    }
    log(`street furniture: ${sf.props.length} ${JSON.stringify(sf.stats)}`);
  }

  const out = {
    props: deduped,
    stats: {
      total: deduped.length,
      byType: stats,
      duplicatesRemoved: dupes,
      noRoadWithin25m: noRoad,
      gantryFromLine,
      mrtExitClearance: { ...mrt, maxPush: r2(mrt.maxPush) },
      trees: { park: parkTrees.length, road: roadTrees.length, beforeCap: treeTotal, cap: TREE_CAP },
      streetFurniture: sf?.stats ?? null,
    },
  };
  const outPath = resolve(buildDir, 'props.json');
  writeFileSync(outPath, JSON.stringify(out));
  log(`props by type: ${Object.entries(stats).map(([k, v]) => `${k}=${v}`).join(' ')}`);
  log(`trees: park=${parkTrees.length} road=${roadTrees.length} (before cap ${treeTotal}, cap ${TREE_CAP})`);
  log(`no road within ${ROAD_SNAP} m (yaw=0): ${JSON.stringify(noRoad)}; gantries from LTA span line: ${gantryFromLine}; duplicates removed: ${dupes}`);
  log(`wrote ${outPath} (${deduped.length} props, ${fmtBytes(fileSize(outPath))})`);
}

main();
