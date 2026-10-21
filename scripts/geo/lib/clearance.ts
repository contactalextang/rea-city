// 建筑 / 道具与车行道的净空几何（03 / 04 / 06 / check-clearance 共用）。
// 车行道口径与 08-roadmesh、src/world/RoadClearance.ts 一致：互为 reverse 的边取一条带，
// 半宽 = (lanesA + lanesB) × laneW / 2（单向 = lanes × laneW / 2），节点加半径 jr 的圆帽。
import type { GraphData, RoadKind } from './graph-types.ts';
import { circlePolygon, stripPolygons, type Pair, type Ring as MRing } from './mesh.ts';
import { pointInPolygon, type Pos, type Ring } from './geom.ts';

// ---------------------------------------------------------------------------
// 建筑标签过滤：哪些 OSM 建筑不该从地面拉伸成实心体
// ---------------------------------------------------------------------------

/** 从 other_tags（hstore 文本）取一个键的值 */
export function otherTag(p: Record<string, unknown>, key: string): string | undefined {
  const raw = typeof p.other_tags === 'string' ? p.other_tags : '';
  if (!raw) return undefined;
  const m = new RegExp(`"${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"=>"([^"]*)"`).exec(raw);
  return m ? m[1] : undefined;
}

/** 普通字段优先，其次 other_tags */
export function tagOf(p: Record<string, unknown>, key: string): string | undefined {
  const v = p[key];
  if (typeof v === 'string' && v.trim()) return v.trim();
  return otherTag(p, key);
}

const num = (v: string | undefined): number | null => {
  if (!v) return null;
  const m = /-?\d+(?:\.\d+)?/.exec(v);
  return m ? Number(m[0]) : null;
};

/**
 * 建筑跳过原因（null = 正常地面建筑）：
 * 顶棚 / 天桥 / 车棚、man_made=bridge、地下（layer<0 / location=underground）、室内（indoor=*）、
 * 悬空（min_height>0 / building:min_level>0）。
 */
export function buildingSkipReason(p: Record<string, unknown>): string | null {
  const b = tagOf(p, 'building');
  if (b === 'roof' || b === 'bridge' || b === 'carport') return `building=${b}`;
  if (tagOf(p, 'man_made') === 'bridge') return 'man_made=bridge';
  const layer = num(tagOf(p, 'layer'));
  if (layer !== null && layer < 0) return 'layer<0';
  if (tagOf(p, 'location') === 'underground') return 'location=underground';
  const indoor = tagOf(p, 'indoor');
  if (indoor && indoor !== 'no') return 'indoor';
  const minH = num(tagOf(p, 'min_height'));
  if (minH !== null && minH > 0) return 'min_height>0';
  const minL = num(tagOf(p, 'building:min_level'));
  if (minL !== null && minL > 0) return 'building:min_level>0';
  return null;
}

// ---------------------------------------------------------------------------
// 距离工具
// ---------------------------------------------------------------------------

export function pointSegDist(px: number, pz: number, ax: number, az: number, bx: number, bz: number): number {
  const dx = bx - ax, dz = bz - az;
  const L2 = dx * dx + dz * dz;
  let t = L2 > 0 ? ((px - ax) * dx + (pz - az) * dz) / L2 : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  return Math.hypot(px - (ax + t * dx), pz - (az + t * dz));
}

function segsCross(ax: number, az: number, bx: number, bz: number, cx: number, cz: number, dx: number, dz: number): boolean {
  const o = (px: number, pz: number, qx: number, qz: number, rx: number, rz: number) => (qx - px) * (rz - pz) - (qz - pz) * (rx - px);
  const d1 = o(cx, cz, dx, dz, ax, az), d2 = o(cx, cz, dx, dz, bx, bz);
  const d3 = o(ax, az, bx, bz, cx, cz), d4 = o(ax, az, bx, bz, dx, dz);
  return ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0));
}

function segSegDist(ax: number, az: number, bx: number, bz: number, cx: number, cz: number, dx: number, dz: number): number {
  if (segsCross(ax, az, bx, bz, cx, cz, dx, dz)) return 0;
  return Math.min(
    pointSegDist(ax, az, cx, cz, dx, dz),
    pointSegDist(bx, bz, cx, cz, dx, dz),
    pointSegDist(cx, cz, ax, az, bx, bz),
    pointSegDist(dx, dz, ax, az, bx, bz),
  );
}

/** 带孔多边形 */
export interface Poly {
  outer: Ring;
  holes: Ring[];
}

function inPoly(x: number, z: number, p: Poly): boolean {
  return pointInPolygon([x, z], p.outer, p.holes);
}

/** 线段到带孔多边形（面）的距离；相交 / 落在内部为 0 */
export function segPolyDist(ax: number, az: number, bx: number, bz: number, p: Poly): number {
  if (inPoly(ax, az, p) || inPoly(bx, bz, p)) return 0;
  let best = Infinity;
  for (const ring of [p.outer, ...p.holes]) {
    const n = ring.length;
    for (let i = 0, j = n - 1; i < n; j = i++) {
      const d = segSegDist(ax, az, bx, bz, ring[j][0], ring[j][1], ring[i][0], ring[i][1]);
      if (d < best) best = d;
      if (best === 0) return 0;
    }
  }
  return best;
}

/** 点到带孔多边形（面）的距离；内部为 0 */
export function pointPolyDist(x: number, z: number, p: Poly): number {
  if (inPoly(x, z, p)) return 0;
  let best = Infinity;
  for (const ring of [p.outer, ...p.holes]) {
    const n = ring.length;
    for (let i = 0, j = n - 1; i < n; j = i++) {
      const d = pointSegDist(x, z, ring[j][0], ring[j][1], ring[i][0], ring[i][1]);
      if (d < best) best = d;
    }
  }
  return best;
}

// ---------------------------------------------------------------------------
// 车行道带索引
// ---------------------------------------------------------------------------

export interface Band {
  /** 代表边 id（成对取 id 小的） */
  edge: number;
  kind: RoadKind;
  half: number;
  pts: Pair[];
  minX: number;
  minZ: number;
  maxX: number;
  maxZ: number;
}
interface Seg {
  ax: number;
  az: number;
  bx: number;
  bz: number;
  half: number;
  band: number;
}
interface Cap {
  x: number;
  z: number;
  r: number;
  node: number;
}

const CELL = 32;
const ckey = (cx: number, cz: number) => (cx + 8192) * 16384 + (cz + 8192);

export class RoadBands {
  bands: Band[] = [];
  segs: Seg[] = [];
  caps: Cap[] = [];
  private segCells = new Map<number, number[]>();
  private capCells = new Map<number, number[]>();
  private bandCells = new Map<number, number[]>();

  /** includeService=false 时只取非 service 边，圆帽只加在连着非 service 边的节点上 */
  constructor(g: GraphData, includeService: boolean) {
    const nodeUsed = new Uint8Array(g.nodes.length);
    for (const e of g.edges) {
      if (e.reverse !== null && e.reverse < e.id) continue;
      if (!includeService && e.kind === 'service') continue;
      const half = ((e.lanes + (e.reverse !== null ? g.edges[e.reverse].lanes : 0)) * e.laneW) / 2;
      const pts: Pair[] = [];
      for (let k = 0; k + 1 < e.pts.length; k += 2) pts.push([e.pts[k], e.pts[k + 1]]);
      let minX = Infinity, minZ = Infinity, maxX = -Infinity, maxZ = -Infinity;
      for (const [x, z] of pts) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (z < minZ) minZ = z;
        if (z > maxZ) maxZ = z;
      }
      const bi = this.bands.length;
      this.bands.push({ edge: e.id, kind: e.kind, half, pts, minX: minX - half, minZ: minZ - half, maxX: maxX + half, maxZ: maxZ + half });
      this.insert(this.bandCells, bi, minX - half, minZ - half, maxX + half, maxZ + half);
      for (let k = 0; k + 1 < pts.length; k++) {
        const [ax, az] = pts[k], [bx, bz] = pts[k + 1];
        const si = this.segs.length;
        this.segs.push({ ax, az, bx, bz, half, band: bi });
        this.insert(this.segCells, si, Math.min(ax, bx) - half, Math.min(az, bz) - half, Math.max(ax, bx) + half, Math.max(az, bz) + half);
      }
      nodeUsed[e.from] = nodeUsed[e.to] = 1;
    }
    for (const n of g.nodes) {
      if (!nodeUsed[n.id]) continue;
      const ci = this.caps.length;
      this.caps.push({ x: n.x, z: n.z, r: n.jr, node: n.id });
      this.insert(this.capCells, ci, n.x - n.jr, n.z - n.jr, n.x + n.jr, n.z + n.jr);
    }
  }

  private insert(map: Map<number, number[]>, i: number, x0: number, z0: number, x1: number, z1: number) {
    for (let cx = Math.floor(x0 / CELL); cx <= Math.floor(x1 / CELL); cx++)
      for (let cz = Math.floor(z0 / CELL); cz <= Math.floor(z1 / CELL); cz++) {
        const k = ckey(cx, cz);
        let l = map.get(k);
        if (!l) map.set(k, (l = []));
        l.push(i);
      }
  }

  private gather(map: Map<number, number[]>, x0: number, z0: number, x1: number, z1: number): Set<number> {
    const out = new Set<number>();
    for (let cx = Math.floor(x0 / CELL); cx <= Math.floor(x1 / CELL); cx++)
      for (let cz = Math.floor(z0 / CELL); cz <= Math.floor(z1 / CELL); cz++) for (const i of map.get(ckey(cx, cz)) ?? []) out.add(i);
    return out;
  }

  /** 多边形侵入车行道的最大深度（m，≤0 不侵入）：带 = 半宽 − 中心线到多边形的距离；圆帽 = jr − 圆心到多边形距离 */
  polyDepth(p: Poly): number {
    return this.polyDepthInfo(p).depth;
  }

  /** 同 polyDepth，另返回 through：是否有车行道中心线（或路口圆心）穿过 / 落在多边形内 */
  polyDepthInfo(p: Poly): { depth: number; through: boolean } {
    let minX = Infinity, minZ = Infinity, maxX = -Infinity, maxZ = -Infinity;
    for (const [x, z] of p.outer) {
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (z < minZ) minZ = z;
      if (z > maxZ) maxZ = z;
    }
    let depth = -Infinity;
    let through = false;
    for (const si of this.gather(this.segCells, minX, minZ, maxX, maxZ)) {
      const s = this.segs[si];
      if (Math.min(s.ax, s.bx) - s.half > maxX || Math.max(s.ax, s.bx) + s.half < minX) continue;
      if (Math.min(s.az, s.bz) - s.half > maxZ || Math.max(s.az, s.bz) + s.half < minZ) continue;
      const dist = segPolyDist(s.ax, s.az, s.bx, s.bz, p);
      if (dist === 0) through = true;
      const d = s.half - dist;
      if (d > depth) depth = d;
    }
    for (const ci of this.gather(this.capCells, minX, minZ, maxX, maxZ)) {
      const c = this.caps[ci];
      if (c.x - c.r > maxX || c.x + c.r < minX || c.z - c.r > maxZ || c.z + c.r < minZ) continue;
      const dist = pointPolyDist(c.x, c.z, p);
      if (dist === 0) through = true;
      const d = c.r - dist;
      if (d > depth) depth = d;
    }
    return { depth, through };
  }

  /** 与包围盒相交的车行道多边形（带 + 16 边圆帽），供 polygon-clipping 求并 */
  ringsNear(minX: number, minZ: number, maxX: number, maxZ: number): MRing[] {
    const rings: MRing[] = [];
    for (const bi of this.gather(this.bandCells, minX, minZ, maxX, maxZ)) {
      const b = this.bands[bi];
      if (b.minX > maxX || b.maxX < minX || b.minZ > maxZ || b.maxZ < minZ) continue;
      // 只取包围盒附近的那几段，避免长边整条参与布尔运算
      let k0 = -1, k1 = -1;
      for (let k = 0; k + 1 < b.pts.length; k++) {
        const [ax, az] = b.pts[k], [bx, bz] = b.pts[k + 1];
        const h = b.half + 1;
        if (Math.min(ax, bx) - h > maxX || Math.max(ax, bx) + h < minX || Math.min(az, bz) - h > maxZ || Math.max(az, bz) + h < minZ) continue;
        if (k0 < 0) k0 = k;
        k1 = k + 1;
      }
      if (k0 < 0) continue;
      // 前后各多带一段，保证斜接角完整
      const s = Math.max(0, k0 - 1), e = Math.min(b.pts.length - 1, k1 + 1);
      rings.push(...stripPolygons(b.pts.slice(s, e + 1), b.half));
    }
    for (const ci of this.gather(this.capCells, minX, minZ, maxX, maxZ)) {
      const c = this.caps[ci];
      if (c.x - c.r > maxX || c.x + c.r < minX || c.z - c.r > maxZ || c.z + c.r < minZ) continue;
      // 外接 16 边形（半径 r / cos(π/16)），保证覆盖整个圆
      rings.push(circlePolygon(c.x, c.z, c.r / Math.cos(Math.PI / 16), 16, ((c.node * 0.618033) % 1) * (Math.PI / 8)));
    }
    return rings;
  }

  /** 半径 r 的圆侵入车行道最深的要素：depth > 0 表示侵入；(nx, nz) 外推方向（0,0 = 落在圆心附近无方向） */
  pointDepth(x: number, z: number, r: number): { depth: number; nx: number; nz: number } {
    const h = { depth: 0, nx: 0, nz: 0 };
    for (const si of this.gather(this.segCells, x - r, z - r, x + r, z + r)) {
      const s = this.segs[si];
      const dx = s.bx - s.ax, dz = s.bz - s.az, L2 = dx * dx + dz * dz;
      if (L2 < 1e-8) continue;
      const u = ((x - s.ax) * dx + (z - s.az) * dz) / L2;
      if (u < 0 || u > 1) continue; // 端点交给圆帽 / 相邻段
      const qx = s.ax + dx * u, qz = s.az + dz * u;
      let ex = x - qx, ez = z - qz;
      const d = Math.hypot(ex, ez);
      const depth = s.half + r - d;
      if (depth <= h.depth) continue;
      if (d < 1e-4) {
        const L = Math.sqrt(L2);
        ex = -dz / L;
        ez = dx / L;
      } else {
        ex /= d;
        ez /= d;
      }
      h.depth = depth;
      h.nx = ex;
      h.nz = ez;
    }
    for (const ci of this.gather(this.capCells, x - r, z - r, x + r, z + r)) {
      const c = this.caps[ci];
      const ex = x - c.x, ez = z - c.z;
      const d = Math.hypot(ex, ez);
      const depth = c.r + r - d;
      if (depth <= h.depth) continue;
      if (d < 0.5) {
        h.depth = depth;
        h.nx = 0;
        h.nz = 0;
        continue;
      }
      h.depth = depth;
      h.nx = ex / d;
      h.nz = ez / d;
    }
    return h;
  }

  /** 把半径 r 的圆推出车行道（再留 margin）；与 RoadClearance.fit 同算法 */
  fit(x: number, z: number, r: number, margin: number, maxPush: number): { ok: boolean; x: number; z: number; moved: boolean; dist: number } {
    let px = x, pz = z, moved = false;
    for (let it = 0; it < 8; it++) {
      const h = this.pointDepth(px, pz, r + margin);
      if (h.depth <= 1e-3) return { ok: true, x: px, z: pz, moved, dist: Math.hypot(px - x, pz - z) };
      if (h.nx === 0 && h.nz === 0) return { ok: false, x, z, moved: true, dist: 0 };
      moved = true;
      px += h.nx * (h.depth + 0.01);
      pz += h.nz * (h.depth + 0.01);
      if (Math.hypot(px - x, pz - z) > maxPush) return { ok: false, x, z, moved, dist: 0 };
    }
    const ok = this.pointDepth(px, pz, r + margin).depth <= 1e-3;
    return ok ? { ok, x: px, z: pz, moved, dist: Math.hypot(px - x, pz - z) } : { ok, x, z, moved, dist: 0 };
  }
}

// ---------------------------------------------------------------------------
// 建筑面索引：中心线有多少落在建筑内
// ---------------------------------------------------------------------------

export class PolyGrid {
  polys: (Poly & { minX: number; minZ: number; maxX: number; maxZ: number })[] = [];
  private cells = new Map<number, number[]>();
  private cell: number;
  constructor(cell = 64) {
    this.cell = cell;
  }
  add(p: Poly): void {
    let minX = Infinity, minZ = Infinity, maxX = -Infinity, maxZ = -Infinity;
    for (const [x, z] of p.outer) {
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (z < minZ) minZ = z;
      if (z > maxZ) maxZ = z;
    }
    const i = this.polys.length;
    this.polys.push({ ...p, minX, minZ, maxX, maxZ });
    for (let cx = Math.floor(minX / this.cell); cx <= Math.floor(maxX / this.cell); cx++)
      for (let cz = Math.floor(minZ / this.cell); cz <= Math.floor(maxZ / this.cell); cz++) {
        const k = ckey(cx, cz);
        let l = this.cells.get(k);
        if (!l) this.cells.set(k, (l = []));
        l.push(i);
      }
  }
  contains(x: number, z: number): boolean {
    for (const i of this.cells.get(ckey(Math.floor(x / this.cell), Math.floor(z / this.cell))) ?? []) {
      const p = this.polys[i];
      if (x < p.minX || x > p.maxX || z < p.minZ || z > p.maxZ) continue;
      if (inPoly(x, z, p)) return true;
    }
    return false;
  }
  /** 折线 [x0,z0,x1,z1,...] 落在任一多边形内的长度与总长（按 step 采样，取段中点） */
  insideLength(flat: ArrayLike<number>, step = 1): { inside: number; total: number } {
    let inside = 0, total = 0;
    for (let k = 2; k + 1 < flat.length; k += 2) {
      const ax = flat[k - 2], az = flat[k - 1], bx = flat[k], bz = flat[k + 1];
      const L = Math.hypot(bx - ax, bz - az);
      if (L === 0) continue;
      const n = Math.max(1, Math.ceil(L / step));
      for (let i = 0; i < n; i++) {
        const t = (i + 0.5) / n;
        if (this.contains(ax + (bx - ax) * t, az + (bz - az) * t)) inside += L / n;
      }
      total += L;
    }
    return { inside, total };
  }
}

/** GeoJSON Polygon / MultiPolygon → [外环, ...孔][] */
export function polygonsOfGeometry(g: { type: string; coordinates: unknown } | null): Pos[][][] {
  if (!g) return [];
  if (g.type === 'Polygon') return [g.coordinates as Pos[][]];
  if (g.type === 'MultiPolygon') return g.coordinates as Pos[][][];
  return [];
}
