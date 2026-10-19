// 第 2 步：把 data/geo/*.geojson 与 data/geo/lta/*.geojson 投影到本地米制坐标（[x, z]，单位米，
// 原点见 lib/proj.ts），真正裁剪到 bbox 的本地矩形，输出到 data/geo/local/。
// 用法：node scripts/geo/02-project.ts
// 输出命名：osm-lines / osm-polygons / osm-points / ura-landuse / hawker / lta-<name>.geojson，
// 外加 _stats.json（与终端打印相同的统计）。
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import polygonClipping from 'polygon-clipping';
import { GEO_DIR, LOCAL_DIR, LTA_OUT_DIR, ensureDir, fileSize, fmtBytes, log, warn } from './lib/common.ts';
import { BBOX, LOCAL_BBOX, ORIGIN, proj } from './lib/proj.ts';

type Pos = [number, number];
type Ring = Pos[];
type Poly = Ring[];
type Geometry =
  | { type: 'Point'; coordinates: Pos }
  | { type: 'MultiPoint'; coordinates: Pos[] }
  | { type: 'LineString'; coordinates: Pos[] }
  | { type: 'MultiLineString'; coordinates: Pos[][] }
  | { type: 'Polygon'; coordinates: Poly }
  | { type: 'MultiPolygon'; coordinates: Poly[] }
  | { type: 'GeometryCollection'; geometries: Geometry[] };
interface Feature {
  type: 'Feature';
  id?: string | number;
  properties: Record<string, unknown> | null;
  geometry: Geometry | null;
}
interface FeatureCollection {
  type: 'FeatureCollection';
  features: Feature[];
}

const { minX, maxX, minZ, maxZ } = LOCAL_BBOX;
const RECT: Poly = [
  [
    [minX, minZ],
    [maxX, minZ],
    [maxX, maxZ],
    [minX, maxZ],
    [minX, minZ],
  ],
];
const PRECISION = 100; // 厘米

const r2 = (v: number) => Math.round(v * PRECISION) / PRECISION;
const toLocal = (p: number[]): Pos => {
  const [x, z] = proj(p[0], p[1]);
  return [x, z];
};
const inside = ([x, z]: Pos) => x >= minX && x <= maxX && z >= minZ && z <= maxZ;
const roundPos = ([x, z]: Pos): Pos => [r2(x), r2(z)];

// ---------------------------------------------------------------------------
// 裁剪
// ---------------------------------------------------------------------------

/** Liang–Barsky 线段裁剪；返回裁后线段或 null */
function clipSegment(a: Pos, b: Pos): [Pos, Pos] | null {
  const dx = b[0] - a[0];
  const dz = b[1] - a[1];
  let t0 = 0;
  let t1 = 1;
  const edges: [number, number][] = [
    [-dx, a[0] - minX],
    [dx, maxX - a[0]],
    [-dz, a[1] - minZ],
    [dz, maxZ - a[1]],
  ];
  for (const [p, q] of edges) {
    if (p === 0) {
      if (q < 0) return null;
      continue;
    }
    const t = q / p;
    if (p < 0) {
      if (t > t1) return null;
      if (t > t0) t0 = t;
    } else {
      if (t < t0) return null;
      if (t < t1) t1 = t;
    }
  }
  return [
    [a[0] + t0 * dx, a[1] + t0 * dz],
    [a[0] + t1 * dx, a[1] + t1 * dz],
  ];
}

/** 折线裁剪：可能被切成多段 */
function clipLine(line: Pos[]): Pos[][] {
  const runs: Pos[][] = [];
  let cur: Pos[] = [];
  for (let i = 0; i + 1 < line.length; i++) {
    const seg = clipSegment(line[i], line[i + 1]);
    if (!seg) {
      if (cur.length > 1) runs.push(cur);
      cur = [];
      continue;
    }
    const [s, e] = seg;
    const last = cur[cur.length - 1];
    if (!last || last[0] !== s[0] || last[1] !== s[1]) {
      if (cur.length > 1) runs.push(cur);
      cur = [s];
    }
    cur.push(e);
  }
  if (cur.length > 1) runs.push(cur);
  return runs;
}

function bboxOf(coords: unknown): [number, number, number, number] {
  let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity;
  const walk = (c: unknown): void => {
    if (typeof (c as Pos)[0] === 'number') {
      const [x, z] = c as Pos;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (z < z0) z0 = z;
      if (z > z1) z1 = z;
    } else for (const s of c as unknown[]) walk(s);
  };
  walk(coords);
  return [x0, z0, x1, z1];
}

const fullyInside = (c: unknown) => {
  const [x0, z0, x1, z1] = bboxOf(c);
  return x0 >= minX && x1 <= maxX && z0 >= minZ && z1 <= maxZ;
};
const disjoint = (c: unknown) => {
  const [x0, z0, x1, z1] = bboxOf(c);
  return x1 < minX || x0 > maxX || z1 < minZ || z0 > maxZ;
};

function clipPolygons(polys: Poly[]): Poly[] {
  if (fullyInside(polys)) return polys;
  if (disjoint(polys)) return [];
  try {
    return polygonClipping.intersection(polys as polygonClipping.MultiPolygon, [RECT] as polygonClipping.MultiPolygon) as Poly[];
  } catch {
    return polys; // 几何无效时退回不裁
  }
}

/** 投影 + 裁剪。返回 null 表示整个要素落在 bbox 外 */
function projectGeometry(g: Geometry): Geometry | null {
  switch (g.type) {
    case 'Point': {
      const p = toLocal(g.coordinates);
      return inside(p) ? { type: 'Point', coordinates: roundPos(p) } : null;
    }
    case 'MultiPoint': {
      const pts = g.coordinates.map(toLocal).filter(inside).map(roundPos);
      if (pts.length === 0) return null;
      return pts.length === 1 ? { type: 'Point', coordinates: pts[0] } : { type: 'MultiPoint', coordinates: pts };
    }
    case 'LineString':
    case 'MultiLineString': {
      const lines = g.type === 'LineString' ? [g.coordinates] : g.coordinates;
      const runs = lines.flatMap((l) => clipLine(l.map(toLocal))).map((l) => l.map(roundPos));
      if (runs.length === 0) return null;
      return runs.length === 1 ? { type: 'LineString', coordinates: runs[0] } : { type: 'MultiLineString', coordinates: runs };
    }
    case 'Polygon':
    case 'MultiPolygon': {
      const polys = (g.type === 'Polygon' ? [g.coordinates] : g.coordinates).map((poly) => poly.map((ring) => ring.map(toLocal)));
      const clipped = clipPolygons(polys)
        .map((poly) => poly.map((ring) => ring.map(roundPos)).filter((ring) => ring.length >= 4))
        .filter((poly) => poly.length > 0);
      if (clipped.length === 0) return null;
      return clipped.length === 1 ? { type: 'Polygon', coordinates: clipped[0] } : { type: 'MultiPolygon', coordinates: clipped };
    }
    case 'GeometryCollection': {
      const parts = g.geometries.map(projectGeometry).filter((x): x is Geometry => !!x);
      return parts.length ? { type: 'GeometryCollection', geometries: parts } : null;
    }
  }
}

// ---------------------------------------------------------------------------
// 统计
// ---------------------------------------------------------------------------
interface FileStats {
  input: number;
  output: number;
  bytes: number;
  geometry: Record<string, number>;
  highway?: Record<string, number>;
  building?: { total: number; withLevels: number; withHeight: number; withLevelsOrHeight: number };
}

const bump = (m: Record<string, number>, k: string) => {
  m[k] = (m[k] ?? 0) + 1;
};
const sortedCounts = (m: Record<string, number>) => Object.fromEntries(Object.entries(m).sort((a, b) => b[1] - a[1]));

function processFile(inPath: string, outName: string): FileStats | null {
  if (fileSize(inPath) <= 0) {
    warn(`${basename(inPath)}: missing, skipped`);
    return null;
  }
  const fc = JSON.parse(readFileSync(inPath, 'utf8')) as FeatureCollection;
  const out: Feature[] = [];
  const stats: FileStats = { input: fc.features.length, output: 0, bytes: 0, geometry: {} };
  const isLines = outName === 'osm-lines';
  const isPolys = outName === 'osm-polygons';
  if (isLines) stats.highway = {};
  if (isPolys) stats.building = { total: 0, withLevels: 0, withHeight: 0, withLevelsOrHeight: 0 };

  for (const f of fc.features) {
    if (!f.geometry) continue;
    const g = projectGeometry(f.geometry);
    if (!g) continue;
    const props = f.properties ?? {};
    const feat: Feature = { type: 'Feature', properties: props, geometry: g };
    if (f.id !== undefined) feat.id = f.id;
    out.push(feat);
    bump(stats.geometry, g.type);
    if (isLines && props.highway) bump(stats.highway!, String(props.highway));
    if (isPolys && props.building) {
      const b = stats.building!;
      b.total++;
      const lv = !!props['building:levels'];
      const h = !!props.height;
      if (lv) b.withLevels++;
      if (h) b.withHeight++;
      if (lv || h) b.withLevelsOrHeight++;
    }
  }

  const outPath = resolve(LOCAL_DIR, `${outName}.geojson`);
  const header = {
    type: 'FeatureCollection',
    crs: {
      type: 'local-metric',
      properties: { origin: ORIGIN, bbox: BBOX, localBbox: LOCAL_BBOX, axes: 'x east (+), z south (+); unit metres' },
    },
    features: out,
  };
  writeFileSync(outPath, JSON.stringify(header));
  stats.output = out.length;
  stats.bytes = fileSize(outPath);
  return stats;
}

function main(): void {
  ensureDir(LOCAL_DIR);
  log(`origin lon=${ORIGIN.lon} lat=${ORIGIN.lat}; local bbox x∈[${minX.toFixed(1)}, ${maxX.toFixed(1)}] z∈[${minZ.toFixed(1)}, ${maxZ.toFixed(1)}] (m)\n`);

  const jobs: [string, string][] = [
    ['osm-lines', resolve(GEO_DIR, 'osm-lines.geojson')],
    ['osm-polygons', resolve(GEO_DIR, 'osm-polygons.geojson')],
    ['osm-points', resolve(GEO_DIR, 'osm-points.geojson')],
    ['ura-landuse', resolve(GEO_DIR, 'ura-landuse.geojson')],
    ['hawker', resolve(GEO_DIR, 'hawker.geojson')],
  ];
  let ltaFiles: string[] = [];
  try {
    ltaFiles = readdirSync(LTA_OUT_DIR).filter((f) => f.endsWith('.geojson')).sort();
  } catch {
    warn('data/geo/lta/ missing — run 01-extract first');
  }
  for (const f of ltaFiles) jobs.push([`lta-${basename(f, '.geojson')}`, resolve(LTA_OUT_DIR, f)]);

  const all: Record<string, FileStats> = {};
  for (const [name, path] of jobs) {
    const s = processFile(path, name);
    if (!s) continue;
    all[name] = s;
    const geom = Object.entries(s.geometry)
      .map(([k, v]) => `${k}=${v}`)
      .join(' ');
    log(`${name.padEnd(32)} ${String(s.input).padStart(6)} -> ${String(s.output).padStart(6)} features  ${fmtBytes(s.bytes).padStart(9)}  {${geom}}`);
  }

  const lines = all['osm-lines'];
  if (lines?.highway) {
    log('\nosm-lines highway types:');
    for (const [k, v] of Object.entries(sortedCounts(lines.highway))) log(`  ${k.padEnd(24)} ${v}`);
    log(`  ${'(total with highway)'.padEnd(24)} ${Object.values(lines.highway).reduce((a, b) => a + b, 0)}`);
  }
  const polys = all['osm-polygons'];
  if (polys?.building) {
    const b = polys.building;
    log(`\nosm-polygons buildings: ${b.total}  with building:levels=${b.withLevels}  with height=${b.withHeight}  with either=${b.withLevelsOrHeight}`);
  }
  if (lines) lines.highway = sortedCounts(lines.highway ?? {});
  writeFileSync(resolve(LOCAL_DIR, '_stats.json'), JSON.stringify({ origin: ORIGIN, bbox: BBOX, localBbox: LOCAL_BBOX, files: all }, null, 2));
  log(`\nwrote ${Object.keys(all).length} files + _stats.json to ${LOCAL_DIR}`);
}

main();
