// 第 7 步：兴趣点（POI）。小贩中心 / 地铁站 / 巴士站 / 德士站 / 四个身份的家 / CBD 办公楼 /
// 工地 / 警署 / 医院 / 地标，每个 POI 附带"门口"（最近车行道靠左侧人行道位置 + 朝向）。
// 用法：node scripts/geo/07-pois.ts → data/geo/build/pois.json
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { GEO_DIR, LOCAL_DIR, ensureDir, fileSize, fmtBytes, log, warn } from './lib/common.ts';
import { proj } from './lib/proj.ts';

type PoiType = 'hawker' | 'mrt' | 'bus' | 'taxi' | 'home' | 'office' | 'site' | 'police' | 'hospital' | 'shop' | 'landmark';
interface Door {
  x: number;
  z: number;
  /** 弧度，0 朝 +z：yaw = atan2(dx, dz)，朝向道路行进方向 */
  yaw: number;
}
interface Poi {
  id: string;
  type: PoiType;
  name: string;
  x: number;
  z: number;
  door: Door;
  meta?: Record<string, unknown>;
}

type Pos = [number, number];
type Poly = Pos[][];
interface Feature {
  properties: Record<string, unknown> | null;
  geometry: { type: string; coordinates: unknown } | null;
}

const CARRIAGEWAY = new Set(['motorway', 'motorway_link', 'trunk', 'trunk_link', 'primary', 'primary_link', 'secondary', 'secondary_link', 'tertiary', 'tertiary_link', 'residential', 'unclassified', 'living_street', 'service', 'road']);
const DEFAULT_LANES: Record<string, number> = { motorway: 3, trunk: 3, primary: 3, secondary: 2, tertiary: 2, residential: 2, unclassified: 2, living_street: 1, service: 1, road: 2 };
const LANE_W = 3.3;
/** 门口：找最近车行道的最大搜索半径（m） */
const DOOR_SNAP = 300;
const yawOf = (dx: number, dz: number) => Math.atan2(dx, dz);
const r2 = (v: number) => Math.round(v * 100) / 100;
const r3 = (v: number) => Math.round(v * 1000) / 1000;

// ---------------------------------------------------------------------------
// 读数据与几何
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
function ringArea(ring: Pos[]): number {
  let a = 0;
  for (let i = 0, n = ring.length; i < n; i++) a += ring[i][0] * ring[(i + 1) % n][1] - ring[(i + 1) % n][0] * ring[i][1];
  return a / 2;
}
/** 面积加权质心（外环）；退化时取顶点平均 */
function ringCentroid(ring: Pos[]): Pos {
  const a = ringArea(ring);
  if (Math.abs(a) < 1e-6) {
    let x = 0, z = 0;
    for (const p of ring) {
      x += p[0];
      z += p[1];
    }
    return [x / ring.length, z / ring.length];
  }
  let cx = 0, cz = 0;
  for (let i = 0, n = ring.length; i < n; i++) {
    const [x1, z1] = ring[i], [x2, z2] = ring[(i + 1) % n];
    const w = x1 * z2 - x2 * z1;
    cx += (x1 + x2) * w;
    cz += (z1 + z2) * w;
  }
  return [cx / (6 * a), cz / (6 * a)];
}
/** 要素代表点：点取自身，面取最大外环质心 */
function featurePoint(f: Feature): Pos | null {
  const g = f.geometry;
  if (!g) return null;
  if (g.type === 'Point') return g.coordinates as Pos;
  const polys = polygonsOf(f);
  if (polys.length) {
    let best = polys[0][0], bestA = -1;
    for (const poly of polys) {
      const a = Math.abs(ringArea(poly[0]));
      if (a > bestA) {
        bestA = a;
        best = poly[0];
      }
    }
    return ringCentroid(best);
  }
  const lines = linesOf(f);
  if (lines.length) return lines[0][Math.floor(lines[0].length / 2)];
  return null;
}
function featureArea(f: Feature): number {
  return polygonsOf(f).reduce((s, poly) => s + Math.abs(ringArea(poly[0])), 0);
}
const dist = (a: Pos, b: Pos) => Math.hypot(a[0] - b[0], a[1] - b[1]);
/** other_tags（hstore 文本）里取某个 key */
function tag(p: Record<string, unknown>, key: string): string | undefined {
  const direct = p[key];
  if (direct != null && direct !== '') return String(direct);
  const m = String(p.other_tags ?? '').match(new RegExp(`"${key.replace(/[:.]/g, '\\$&')}"=>"((?:[^"\\\\]|\\\\.)*)"`));
  return m ? m[1].replace(/\\"/g, '"') : undefined;
}
const nameOf = (f: Feature) => String(f.properties?.name ?? '').trim();
/** 建筑高度估计（m）：height 优先，其次 levels×3.5 */
function heightOf(p: Record<string, unknown>): number {
  const h = parseFloat(String(p.height ?? ''));
  if (Number.isFinite(h) && h > 0) return h;
  const lv = parseFloat(String(p['building:levels'] ?? ''));
  if (Number.isFinite(lv) && lv > 0) return lv * 3.5;
  return 0;
}

// ---------------------------------------------------------------------------
// 车行道索引（与 06-props 相同的网格最近线段查询，外加 oneway）
// ---------------------------------------------------------------------------
interface Seg {
  ax: number;
  az: number;
  bx: number;
  bz: number;
  highway: string;
  lanes: number;
  /** 1 = 沿数字化方向单行；-1 = 反向单行；0 = 双向 */
  oneway: number;
  name?: string;
}
interface Hit {
  seg: Seg;
  dist: number;
  fx: number;
  fz: number;
  dx: number;
  dz: number;
}
class SegIndex {
  private cell = 50;
  private grid = new Map<string, Seg[]>();
  add(seg: Seg): void {
    const c = this.cell;
    for (let cx = Math.floor(Math.min(seg.ax, seg.bx) / c); cx <= Math.floor(Math.max(seg.ax, seg.bx) / c); cx++)
      for (let cz = Math.floor(Math.min(seg.az, seg.bz) / c); cz <= Math.floor(Math.max(seg.az, seg.bz) / c); cz++) {
        const k = `${cx},${cz}`;
        let arr = this.grid.get(k);
        if (!arr) this.grid.set(k, (arr = []));
        arr.push(seg);
      }
  }
  /** 由近及远逐环扩大搜索，直到 maxDist */
  nearest(x: number, z: number, maxDist: number, accept: (s: Seg) => boolean = () => true): Hit | null {
    const c = this.cell;
    const cx0 = Math.floor(x / c), cz0 = Math.floor(z / c);
    let best: Hit | null = null;
    const rMax = Math.ceil(maxDist / c);
    for (let r = 0; r <= rMax; r++) {
      // 找到的最近点若已比下一环最小可能距离近，就停止
      if (best && best.dist < (r - 1) * c) break;
      for (let cx = cx0 - r; cx <= cx0 + r; cx++)
        for (let cz = cz0 - r; cz <= cz0 + r; cz++) {
          if (Math.max(Math.abs(cx - cx0), Math.abs(cz - cz0)) !== r) continue;
          const arr = this.grid.get(`${cx},${cz}`);
          if (!arr) continue;
          for (const s of arr) {
            if (!accept(s)) continue;
            const vx = s.bx - s.ax, vz = s.bz - s.az;
            const l2 = vx * vx + vz * vz;
            if (l2 === 0) continue;
            const t = Math.max(0, Math.min(1, ((x - s.ax) * vx + (z - s.az) * vz) / l2));
            const fx = s.ax + t * vx, fz = s.az + t * vz;
            const d = Math.hypot(x - fx, z - fz);
            if (d <= maxDist && (!best || d < best.dist)) {
              const l = Math.sqrt(l2);
              best = { seg: s, dist: d, fx, fz, dx: vx / l, dz: vz / l };
            }
          }
        }
    }
    return best;
  }
}
function buildRoadIndex(lines: Feature[]): SegIndex {
  const index = new SegIndex();
  for (const f of lines) {
    const p = f.properties ?? {};
    const highway = String(p.highway ?? '');
    if (!CARRIAGEWAY.has(highway)) continue;
    const n = Number(p.lanes);
    const lanes = Number.isFinite(n) && n > 0 ? n : (DEFAULT_LANES[highway] ?? 2);
    const ow = tag(p, 'oneway') ?? (tag(p, 'junction') === 'roundabout' ? 'yes' : '');
    const oneway = ow === 'yes' || ow === '1' || ow === 'true' ? 1 : ow === '-1' ? -1 : 0;
    const name = p.name ? String(p.name) : undefined;
    for (const coords of linesOf(f))
      for (let i = 0; i + 1 < coords.length; i++) index.add({ ax: coords[i][0], az: coords[i][1], bx: coords[i + 1][0], bz: coords[i + 1][1], highway, lanes, oneway, name });
  }
  return index;
}

/**
 * 门口：从 POI 中心找最近车行道，取垂足；新加坡靠左行驶，所以站在"POI 这一侧"的车流方向
 * 就是让 POI 位于行进方向左手边的方向（单行道则固定为其通行方向）。门口 = 垂足沿该方向的
 * 左侧偏移 (lanes×3.3/2 + 2) m；yaw 朝向道路行进方向。
 * x 东 z 南：方向 (dx, dz) 的左手边法向 = (dz, −dx)。
 */
function doorFor(roads: SegIndex, x: number, z: number): { door: Door; road?: string; dist?: number } {
  // 先找 150 m 内的公共道路（排除 service：那多是穿过建筑的停车场 / 后巷通道），没有再退回含 service 的最近道路
  const hit = roads.nearest(x, z, 150, (s) => s.highway !== 'service') ?? roads.nearest(x, z, DOOR_SNAP);
  if (!hit) return { door: { x: r2(x), z: r2(z), yaw: 0 } };
  let dx = hit.dx, dz = hit.dz;
  if (hit.seg.oneway === -1) {
    dx = -dx;
    dz = -dz;
  } else if (hit.seg.oneway === 0) {
    // 双向：选让 POI 在左侧的方向
    const lx = dz, lz = -dx;
    const side = (x - hit.fx) * lx + (z - hit.fz) * lz;
    if (side < 0) {
      dx = -dx;
      dz = -dz;
    }
  }
  const off = (hit.seg.lanes * LANE_W) / 2 + 2;
  const lx = dz, lz = -dx;
  return { door: { x: r2(hit.fx + lx * off), z: r2(hit.fz + lz * off), yaw: r3(yawOf(dx, dz)) }, road: hit.seg.name, dist: r2(hit.dist) };
}

// ---------------------------------------------------------------------------
// LTA 地铁站线路代码 → 站名（LTA 面只带 STN_NAM 代码；优先用 150 m 内出口的 stn_name）
// ---------------------------------------------------------------------------
const STN_CODE_NAME: Record<string, string> = {
  NS25: 'City Hall', EW13: 'City Hall', NS26: 'Raffles Place', EW14: 'Raffles Place', NS27: 'Marina Bay', CE2: 'Marina Bay', TE20: 'Marina Bay',
  NS28: 'Marina South Pier', EW15: 'Tanjong Pagar', EW16: 'Outram Park', NE3: 'Outram Park', TE17: 'Outram Park', EW17: 'Tiong Bahru',
  NE4: 'Chinatown', DT19: 'Chinatown', NE5: 'Clarke Quay', DT15: 'Promenade', CC4: 'Promenade', CC3: 'Esplanade', DT16: 'Bayfront', CE1: 'Bayfront',
  DT17: 'Downtown', DT18: 'Telok Ayer', DT20: 'Fort Canning', TE15: 'Great World', TE16: 'Havelock', TE18: 'Maxwell', TE19: 'Shenton Way',
  TE21: 'Marina South', TE22: 'Gardens by the Bay', CC30: 'Keppel', CC31: 'Cantonment', CC32: 'Prince Edward Road',
};
const LINE_CODE_NAME: Record<string, string> = { NS: 'North South Line', EW: 'East West Line', NE: 'North East Line', CC: 'Circle Line', CE: 'Circle Line', DT: 'Downtown Line', TE: 'Thomson-East Coast Line' };
const titleCase = (s: string) => s.toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase());

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------
function main(): void {
  const buildDir = resolve(GEO_DIR, 'build');
  ensureDir(buildDir);
  const osmPolys = loadFeatures('osm-polygons');
  const osmPoints = loadFeatures('osm-points');
  const roads = buildRoadIndex(loadFeatures('osm-lines'));
  const buildings = osmPolys.filter((f) => f.properties?.building);
  /** 办公楼候选：建筑 + building:part（塔楼常以 part 建模，高度在 part 上） */
  const towers = osmPolys.filter((f) => f.properties?.building || tag(f.properties ?? {}, 'building:part'));

  const pois: Poi[] = [];
  const unmatched: string[] = [];
  const matched: Record<string, string> = {};
  const usedIds = new Set<string>();
  const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '') || 'x';
  const uniqueId = (base: string) => {
    let id = base, n = 2;
    while (usedIds.has(id)) id = `${base}_${n++}`;
    usedIds.add(id);
    return id;
  };
  const add = (type: PoiType, name: string, [x, z]: Pos, meta?: Record<string, unknown>, id?: string): Poi => {
    const d = doorFor(roads, x, z);
    const poi: Poi = { id: uniqueId(id ?? `${type}_${slug(name)}`), type, name, x: r2(x), z: r2(z), door: d.door };
    const m = { ...(meta ?? {}) };
    if (d.road) m.doorRoad = d.road;
    if (Object.keys(m).length) poi.meta = m;
    pois.push(poi);
    return poi;
  };
  /** 去重：同类型 r 米内已有则跳过 */
  const nearExisting = (type: PoiType, p: Pos, r: number) => pois.find((q) => q.type === type && dist([q.x, q.z], p) <= r);

  // 1) hawker：NEA ∪ OSM amenity=food_court ∪ 名称匹配的建筑，50 m 去重
  for (const f of loadFeatures('hawker')) {
    const p = f.properties ?? {};
    const pt = featurePoint(f);
    if (!pt) continue;
    add('hawker', String(p.NAME ?? 'Hawker Centre'), pt, { source: 'nea', stalls: p.NUMBER_OF_COOKED_FOOD_STALLS ?? undefined, address: p.ADDRESS_MYENV ?? undefined });
  }
  const neaCount = pois.length;
  let hawkerOsm = 0, hawkerName = 0;
  for (const f of [...osmPolys, ...osmPoints]) {
    if (f.properties?.amenity !== 'food_court') continue;
    const pt = featurePoint(f);
    if (!pt || nearExisting('hawker', pt, 50)) continue;
    add('hawker', nameOf(f) || 'Food Court', pt, { source: 'osm:food_court' });
    hawkerOsm++;
  }
  for (const f of buildings) {
    const name = nameOf(f);
    if (!/Food Centre|Hawker|Market/i.test(name)) continue;
    const pt = featurePoint(f);
    if (!pt || nearExisting('hawker', pt, 50)) continue;
    add('hawker', name, pt, { source: 'osm:name' });
    hawkerName++;
  }

  // 2) mrt：OSM railway=station（点或面）∪ LTA train-station 面，100 m 去重并合并线路
  const exits = loadFeatures('lta-train-station-exit').map((f) => ({ pt: featurePoint(f)!, name: String(f.properties?.stn_name ?? ''), code: String(f.properties?.exit_code ?? '') })).filter((e) => e.pt);
  const mrtLines = new Map<string, Set<string>>();
  const mrtCodes = new Map<string, Set<string>>();
  const addMrt = (name: string, pt: Pos, lines: string[], codes: string[], source: string) => {
    // 100 m 内视为同站；换乘站各线的 LTA 面质心可相距 100–300 m，同名且 400 m 内也合并
    const existing = nearExisting('mrt', pt, 100) ?? pois.find((q) => q.type === 'mrt' && q.name.toLowerCase() === name.toLowerCase() && dist([q.x, q.z], pt) <= 400);
    const target = existing ?? add('mrt', name, pt, { source });
    if (!mrtLines.has(target.id)) mrtLines.set(target.id, new Set());
    if (!mrtCodes.has(target.id)) mrtCodes.set(target.id, new Set());
    for (const l of lines) if (l) mrtLines.get(target.id)!.add(l);
    for (const c of codes) if (c) mrtCodes.get(target.id)!.add(c);
    return target;
  };
  for (const f of [...osmPoints, ...osmPolys]) {
    const p = f.properties ?? {};
    if (p.railway !== 'station') continue;
    const pt = featurePoint(f);
    if (!pt) continue;
    const lines = [tag(p, 'network'), tag(p, 'line')].filter((s): s is string => !!s && !/^Mass Rapid Transit$/i.test(s));
    const colour = tag(p, 'colour') ?? tag(p, 'ref:colour');
    const ref = tag(p, 'ref');
    const poi = addMrt(nameOf(f) || 'MRT Station', pt, lines, ref ? ref.split(/[;,\s]+/) : [], 'osm');
    if (colour) poi.meta = { ...(poi.meta ?? {}), colour };
  }
  const osmMrt = pois.filter((p) => p.type === 'mrt').length;
  for (const f of loadFeatures('lta-train-station')) {
    const p = f.properties ?? {};
    const pt = featurePoint(f);
    if (!pt) continue;
    const codes = String(p.STN_NAM ?? '').split('/').map((s) => s.trim()).filter(Boolean);
    // 站名：150 m 内 LTA 出口里出现最多的 stn_name；没有就查代码表
    const votes = new Map<string, number>();
    for (const e of exits) if (dist(e.pt, pt) <= 150) votes.set(e.name, (votes.get(e.name) ?? 0) + 1);
    let name = [...votes.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
    name = name ? titleCase(name.replace(/\s*MRT STATION$/i, '')) : codes.map((c) => STN_CODE_NAME[c]).find(Boolean);
    if (!name) {
      unmatched.push(`mrt: LTA station ${p.STN_NAM} (no exit nearby, code unknown)`);
      name = `MRT ${p.STN_NAM}`;
    }
    const lines = codes.map((c) => LINE_CODE_NAME[c.replace(/\d+$/, '')]).filter((s): s is string => !!s);
    addMrt(name, pt, lines, codes, 'lta');
  }
  for (const poi of pois) {
    if (poi.type !== 'mrt') continue;
    const ex = exits.filter((e) => dist(e.pt, [poi.x, poi.z]) <= 150).map((e) => ({ x: r2(e.pt[0]), z: r2(e.pt[1]), code: e.code }));
    poi.meta = { ...(poi.meta ?? {}), lines: [...(mrtLines.get(poi.id) ?? [])], codes: [...(mrtCodes.get(poi.id) ?? [])], exits: ex };
  }

  // 3) bus / taxi：LTA 全部
  for (const f of loadFeatures('lta-bus-stop')) {
    const p = f.properties ?? {};
    const pt = featurePoint(f);
    if (!pt) continue;
    add('bus', String(p.LOC_DESC ?? `Bus Stop ${p.BUS_STOP_N ?? ''}`).trim(), pt, { code: p.BUS_STOP_N ?? undefined }, `bus_${p.BUS_STOP_N ?? slug(String(p.LOC_DESC ?? ''))}`);
  }
  for (const f of loadFeatures('lta-taxi-stand')) {
    const p = f.properties ?? {};
    const pt = featurePoint(f);
    if (!pt) continue;
    add('taxi', String(p.LOC_DESC ?? 'Taxi Stand').trim(), pt, { lots: p.NO_LOTS ?? undefined, locNum: p.LOC_NUM ?? undefined }, `taxi_${p.LOC_NUM ?? slug(String(p.LOC_DESC ?? ''))}`);
  }

  // 4) home：手工目标经纬度 + 街道 / 名称偏好，取最近建筑质心
  const RESIDENTIAL_B = new Set(['yes', 'residential', 'apartments', 'house', 'terrace', 'dormitory']);
  const homes: { id: string; label: string; lonlat: [number, number]; street?: RegExp; name?: RegExp; minLevels?: number }[] = [
    { id: 'home_gang', label: '黑帮：牛车水 Pagoda St / Temple St 店屋', lonlat: [103.8443, 1.2836], street: /^(Pagoda|Temple) Street$/i },
    { id: 'home_gold', label: '金领：The Sail @ Marina Bay / Marina One Residences', lonlat: [103.8533, 1.2808], name: /^The Sail|Marina One Residences/i },
    { id: 'home_white', label: '白领：中峇鲁 Moh Guan Terrace 组屋', lonlat: [103.8304, 1.2835], street: /Moh Guan Terrace/i },
    { id: 'home_blue', label: '蓝领：红山 Bukit Merah View / Jalan Bukit Merah 组屋', lonlat: [103.8285, 1.28], street: /Bukit Merah View|Jalan Bukit Merah/i, minLevels: 8 },
  ];
  for (const h of homes) {
    const target = proj(h.lonlat[0], h.lonlat[1]);
    const prefer = buildings.filter((f) => {
      const p = f.properties ?? {};
      if (h.street && !h.street.test(String(p['addr:street'] ?? ''))) return false;
      if (h.name && !h.name.test(nameOf(f))) return false;
      if (!RESIDENTIAL_B.has(String(p.building))) return false;
      if (h.minLevels && !(parseFloat(String(p['building:levels'] ?? '0')) >= h.minLevels)) return false;
      return true;
    });
    const pool = prefer.length ? prefer : buildings;
    let best: Feature | null = null, bestD = Infinity;
    for (const f of pool) {
      const pt = featurePoint(f);
      if (!pt) continue;
      const d = dist(pt, target);
      if (d < bestD) {
        bestD = d;
        best = f;
      }
    }
    if (!best) {
      unmatched.push(`${h.id}: no building found`);
      continue;
    }
    const p = best.properties ?? {};
    const addr = [p['addr:housenumber'], p['addr:street']].filter(Boolean).join(' ');
    const name = nameOf(best) || addr || h.label;
    add('home', name, featurePoint(best)!, { label: h.label, address: addr || undefined, levels: p['building:levels'] ?? undefined, preferred: prefer.length > 0, distToTarget: r2(bestD) }, h.id);
    matched[h.id] = `${name}${addr && name !== addr ? ` (${addr})` : ''} d=${bestD.toFixed(0)}m${prefer.length ? '' : ' [fallback: nearest any building]'}`;
  }

  // 5) office：按名称找，同名多栋取最高；找不到取目标点附近最高楼
  const offices: { key: string; re: RegExp; lonlat: [number, number] }[] = [
    { key: 'UOB Plaza', re: /^UOB Plaza/i, lonlat: [103.8503, 1.2855] },
    { key: 'Republic Plaza', re: /^Republic Plaza/i, lonlat: [103.8507, 1.2834] },
    { key: 'Capital Tower', re: /^Capital Tower$/i, lonlat: [103.8477, 1.2777] },
    { key: 'One Raffles Place', re: /^One Raffles Place/i, lonlat: [103.8508, 1.2847] },
    { key: 'Guoco Tower', re: /^Guoco Tower/i, lonlat: [103.8457, 1.2771] },
  ];
  for (const o of offices) {
    let cands = towers.filter((f) => o.re.test(nameOf(f)));
    let fallback = false;
    if (!cands.length) {
      const target = proj(o.lonlat[0], o.lonlat[1]);
      cands = towers.filter((f) => {
        const pt = featurePoint(f);
        return pt && dist(pt, target) <= 150;
      });
      fallback = true;
    }
    if (!cands.length) {
      unmatched.push(`office: ${o.key}`);
      continue;
    }
    const best = cands.reduce((a, b) => (heightOf(b.properties ?? {}) > heightOf(a.properties ?? {}) ? b : a));
    const p = best.properties ?? {};
    const name = nameOf(best) || o.key;
    add('office', name, featurePoint(best)!, { key: o.key, height: heightOf(p) || undefined, levels: p['building:levels'] ?? undefined, fallback: fallback || undefined }, `office_${slug(o.key)}`);
    matched[`office:${o.key}`] = `${name} h≈${heightOf(p).toFixed(0)}m${fallback ? ' [fallback: tallest within 150 m]' : ''}`;
  }

  // 6) site：landuse=construction 面积最大的两处（相距 ≥ 300 m）；没有就取 Keppel / 丹戎巴葛一带空地
  const sites = osmPolys.filter((f) => f.properties?.landuse === 'construction').sort((a, b) => featureArea(b) - featureArea(a));
  const chosen: Feature[] = [];
  for (const f of sites) {
    const pt = featurePoint(f)!;
    if (chosen.some((c) => dist(featurePoint(c)!, pt) < 300)) continue;
    chosen.push(f);
    if (chosen.length === 2) break;
  }
  chosen.forEach((f, i) => add('site', nameOf(f) || `Construction Site ${i + 1}`, featurePoint(f)!, { area: r2(featureArea(f)) }, `site_${i + 1}`));
  if (chosen.length < 2) {
    const synth: [string, [number, number]][] = [
      ['Keppel Site', [103.8405, 1.2715]],
      ['Tanjong Pagar Site', [103.8445, 1.2740]],
    ];
    for (let i = chosen.length; i < 2; i++) {
      const [name, ll] = synth[i];
      add('site', name, proj(ll[0], ll[1]), { synthetic: true }, `site_${i + 1}`);
      unmatched.push(`site: only ${chosen.length} construction polygons, synthesised ${name}`);
    }
  }

  // 7) police / hospital
  const police = osmPolys.find((f) => /Police Cantonment Complex/i.test(nameOf(f))) ?? [...osmPolys, ...osmPoints].find((f) => f.properties?.amenity === 'police' && /Cantonment/i.test(nameOf(f)));
  if (police) {
    add('police', nameOf(police), featurePoint(police)!, undefined, 'police_cantonment');
    matched.police = nameOf(police);
  } else unmatched.push('police: Police Cantonment Complex');
  const outram = proj(103.8382, 1.2795);
  const hospitals = [...osmPolys, ...osmPoints].filter((f) => f.properties?.amenity === 'hospital');
  const sgh = hospitals.filter((f) => /Singapore General Hospital/i.test(nameOf(f))).sort((a, b) => featureArea(b) - featureArea(a))[0] ?? hospitals.sort((a, b) => dist(featurePoint(a)!, outram) - dist(featurePoint(b)!, outram))[0];
  if (sgh) {
    add('hospital', nameOf(sgh) || 'Hospital', featurePoint(sgh)!, undefined, 'hospital_sgh');
    matched.hospital = nameOf(sgh);
  } else unmatched.push('hospital: Singapore General Hospital');

  // 8) landmark：按名称（优先级列表）在面 + 点里找
  const landmarks: { key: string; res: RegExp[] }[] = [
    { key: 'Merlion', res: [/^Merlion$/i, /^Merlion Fountain$/i, /^Merlion Park$/i, /Merlion/i] },
    { key: 'Marina Bay Sands', res: [/^Marina Bay Sands$/i, /^Marina Bay Sands Tower 2$/i, /^Marina Bay Sands Tower/i, /^The Shoppes at Marina Bay Sands$/i] },
    { key: 'Esplanade', res: [/^Esplanade - Theatres on the Bay$/i, /^Esplanade Theatres on the Bay$/i, /^Esplanade Concert Hall$/i, /^Esplanade Theatre$/i, /^Esplanade$/i] },
    { key: 'Gardens by the Bay', res: [/^Gardens by the Bay$/i, /^Gardens by the Bay/i] },
    { key: 'Singapore Flyer', res: [/^Singapore Flyer$/i, /^Singapore Flyer/i] },
    { key: 'Lau Pa Sat', res: [/^Lau Pa Sat$/i, /Lau Pa Sat/i, /Telok Ayer Market/i] },
    { key: 'Buddha Tooth Relic Temple', res: [/^Buddha Tooth Relic Temple/i, /Buddha Tooth/i] },
    { key: 'Sri Mariamman Temple', res: [/^Sri Mariamman Temple$/i, /^Sri Mariamman/i] },
  ];
  for (const lm of landmarks) {
    let best: Feature | null = null;
    for (const re of lm.res) {
      // 同名多个时取面积最大（面）；点只在没有面时用
      const cands = [...osmPolys.filter((f) => re.test(nameOf(f))), ...osmPoints.filter((f) => re.test(nameOf(f)))];
      if (!cands.length) continue;
      best = cands.reduce((a, b) => (featureArea(b) > featureArea(a) ? b : a));
      break;
    }
    if (!best) {
      unmatched.push(`landmark: ${lm.key}`);
      continue;
    }
    add('landmark', lm.key, featurePoint(best)!, { osmName: nameOf(best) }, `landmark_${slug(lm.key)}`);
    matched[`landmark:${lm.key}`] = nameOf(best);
  }

  // 输出
  const byType: Record<string, number> = {};
  for (const p of pois) byType[p.type] = (byType[p.type] ?? 0) + 1;
  const noDoorRoad = pois.filter((p) => !p.meta?.doorRoad && p.door.yaw === 0 && p.door.x === p.x && p.door.z === p.z).length;
  const out = { pois, stats: { total: pois.length, byType, hawker: { nea: neaCount, osmFoodCourt: hawkerOsm, nameMatch: hawkerName }, mrt: { fromOsm: osmMrt }, noRoadForDoor: noDoorRoad, matched, unmatched } };
  const outPath = resolve(buildDir, 'pois.json');
  writeFileSync(outPath, JSON.stringify(out));
  log(`pois by type: ${Object.entries(byType).map(([k, v]) => `${k}=${v}`).join(' ')}`);
  log(`hawker: nea=${neaCount} +osm food_court=${hawkerOsm} +name=${hawkerName}; mrt from osm=${osmMrt}; POIs without road for door: ${noDoorRoad}`);
  for (const [k, v] of Object.entries(matched)) log(`  ${k.padEnd(32)} → ${v}`);
  for (const p of pois) if (p.type === 'home' || p.type === 'office' || p.type === 'police' || p.type === 'hospital' || p.type === 'site') log(`  ${p.id.padEnd(28)} (${p.x}, ${p.z}) door (${p.door.x}, ${p.door.z}) yaw=${p.door.yaw} via ${p.meta?.doorRoad ?? '?'}`);
  if (unmatched.length) warn(`unmatched: ${unmatched.join('; ')}`);
  log(`wrote ${outPath} (${pois.length} pois, ${fmtBytes(fileSize(outPath))})`);
}

main();
