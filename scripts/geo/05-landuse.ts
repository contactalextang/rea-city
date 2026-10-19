// 第 5 步：土地用途栅格。读取 data/geo/local/ura-landuse.geojson（URA 2019 LU_DESC）与
// osm-polygons.geojson（水体 / 公园 / 草地），按色表栅格化为 2 m/px 的 ground.png，
// 并输出 landuse.json（色表、原点、尺寸、公园 / 水体多边形供运行时种树与铺水面）。
// 用法：node scripts/geo/05-landuse.ts
// 输出：data/geo/build/ground.png、data/geo/build/landuse.json、data/geo/build/debug/ground-preview.png
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { GEO_DIR, LOCAL_DIR, ensureDir, fileSize, fmtBytes, log, warn } from './lib/common.ts';
import { LOCAL_BBOX } from './lib/proj.ts';
import { Raster, hexToRgb, type PixRing, type RGB } from './lib/raster.ts';

// ---------------------------------------------------------------------------
// 色表（导出到 landuse.json 的 palette）
// ---------------------------------------------------------------------------
export const PALETTE = {
  water: '#3a6ea5', // 水体（河、滨海湾蓄水池）
  park: '#4f7a3a', // 公园 / 开放空间 / 绿地
  residential: '#8c8a84', // 住宅
  commercial: '#7a7f8a', // 商业 / 商务 / 酒店 / 白色地段
  transport: '#5a5a60', // 道路 / 交通设施保留地
  industrial: '#6e6a62', // 工业 / 公用事业
  institution: '#8a8572', // 教育 / 机构 / 宗教 / 医疗
  sea: '#2f5d8a', // 海滩 / 海（URA 未划定的区域，本切片里即海面）
  default: '#6f6f6a', // 其他 / 保留地
} as const;
type LandClass = keyof typeof PALETTE;

/** URA LU_DESC → 用途类别（未列出的用途落到 default 并在结尾汇报） */
const LU_CLASS: Record<string, LandClass> = {
  WATERBODY: 'water',
  PARK: 'park',
  'OPEN SPACE': 'park',
  'SPORTS & RECREATION': 'park',
  'BEACH AREA': 'park',
  RESIDENTIAL: 'residential',
  'RESIDENTIAL WITH COMMERCIAL AT 1ST STOREY': 'residential',
  'COMMERCIAL & RESIDENTIAL': 'residential',
  'RESIDENTIAL / INSTITUTION': 'residential',
  COMMERCIAL: 'commercial',
  HOTEL: 'commercial',
  WHITE: 'commercial',
  'BUSINESS PARK': 'commercial',
  'BUSINESS PARK - WHITE': 'commercial',
  'COMMERCIAL / INSTITUTION': 'commercial',
  ROAD: 'transport',
  'TRANSPORT FACILITIES': 'transport',
  'MASS RAPID TRANSIT': 'transport',
  'LIGHT RAPID TRANSIT': 'transport',
  'PORT / AIRPORT': 'transport',
  'BUSINESS 1': 'industrial',
  'BUSINESS 2': 'industrial',
  'BUSINESS 1 - WHITE': 'industrial',
  'BUSINESS 2 - WHITE': 'industrial',
  UTILITY: 'industrial',
  'CIVIC & COMMUNITY INSTITUTION': 'institution',
  'EDUCATIONAL INSTITUTION': 'institution',
  'HEALTH & MEDICAL CARE': 'institution',
  'PLACE OF WORSHIP': 'institution',
  'RESERVE SITE': 'default',
  'SPECIAL USE': 'default',
  CEMETERY: 'park',
  AGRICULTURE: 'park',
};

/** 栅格分辨率：0.5 px/m = 2 m/px */
const PX_PER_M = 0.5;

// ---------------------------------------------------------------------------
// GeoJSON 类型（与 02-project 一致，本地米制 [x, z]）
// ---------------------------------------------------------------------------
type Pos = [number, number];
type Poly = Pos[][];
interface Feature {
  properties: Record<string, unknown> | null;
  geometry: { type: string; coordinates: unknown } | null;
}

function loadFeatures(name: string): Feature[] {
  const path = resolve(LOCAL_DIR, `${name}.geojson`);
  if (fileSize(path) <= 0) {
    warn(`${name}.geojson missing — run 02-project first`);
    return [];
  }
  return (JSON.parse(readFileSync(path, 'utf8')) as { features: Feature[] }).features;
}

/** 把 Polygon / MultiPolygon 展开成多边形数组（每个 = 环数组） */
function polygonsOf(f: Feature): Poly[] {
  const g = f.geometry;
  if (!g) return [];
  if (g.type === 'Polygon') return [g.coordinates as Poly];
  if (g.type === 'MultiPolygon') return g.coordinates as Poly[];
  return [];
}

/** 鞋带公式求外环面积（m²，绝对值） */
function ringArea(ring: Pos[]): number {
  let a = 0;
  for (let i = 0, n = ring.length; i < n; i++) {
    const [x1, z1] = ring[i];
    const [x2, z2] = ring[(i + 1) % n];
    a += x1 * z2 - x2 * z1;
  }
  return Math.abs(a) / 2;
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------
function main(): void {
  const { minX, maxX, minZ, maxZ } = LOCAL_BBOX;
  const width = Math.round((maxX - minX) * PX_PER_M);
  const height = Math.round((maxZ - minZ) * PX_PER_M);
  const buildDir = resolve(GEO_DIR, 'build');
  const debugDir = resolve(buildDir, 'debug');
  ensureDir(debugDir);

  const rgb: Record<LandClass, RGB> = Object.fromEntries(Object.entries(PALETTE).map(([k, v]) => [k, hexToRgb(v)])) as Record<LandClass, RGB>;
  const toPix = (ring: Pos[]): PixRing => ring.map(([x, z]) => [(x - minX) * PX_PER_M, (z - minZ) * PX_PER_M]);

  // 背景：URA 没有划定用途的区域在本切片内就是海面（滨海湾以南、吉宝港）
  const raster = new Raster(width, height, rgb.sea);
  log(`raster ${width}×${height} px @ ${1 / PX_PER_M} m/px, origin (${minX.toFixed(1)}, ${minZ.toFixed(1)})`);

  // 1) URA 地块：先画非水体 / 非公园，再画公园，最后画水体，保证绿与水在重叠处优先
  const ura = loadFeatures('ura-landuse');
  const classCount: Record<string, number> = {};
  const unknownLu: Record<string, number> = {};
  const parks: { ring: number[] }[] = [];
  const water: { ring: number[] }[] = [];
  const byClass: Record<LandClass, Poly[]> = { water: [], park: [], residential: [], commercial: [], transport: [], industrial: [], institution: [], sea: [], default: [] };
  for (const f of ura) {
    const lu = String(f.properties?.LU_DESC ?? '').trim().toUpperCase();
    let cls = LU_CLASS[lu];
    if (!cls) {
      unknownLu[lu] = (unknownLu[lu] ?? 0) + 1;
      cls = 'default';
    }
    classCount[cls] = (classCount[cls] ?? 0) + 1;
    for (const poly of polygonsOf(f)) {
      byClass[cls].push(poly);
      if (cls === 'park') parks.push({ ring: poly[0].flat() });
      if (cls === 'water') water.push({ ring: poly[0].flat() });
    }
  }
  const drawOrder: LandClass[] = ['default', 'transport', 'industrial', 'institution', 'commercial', 'residential', 'park', 'water'];
  for (const cls of drawOrder) for (const poly of byClass[cls]) raster.fillPolygon(poly.map(toPix), rgb[cls]);
  log(`URA plots: ${ura.length}  by class: ${Object.entries(classCount).map(([k, v]) => `${k}=${v}`).join(' ')}`);
  if (Object.keys(unknownLu).length) warn(`unmapped LU_DESC (drawn as default): ${Object.entries(unknownLu).map(([k, v]) => `${k || '(empty)'}×${v}`).join(', ')}`);

  // 2) OSM 叠加：natural=water → 水；leisure=park/garden、landuse=grass/meadow/forest、natural=wood/grassland → 绿地
  const osm = loadFeatures('osm-polygons');
  let osmWater = 0, osmGreen = 0;
  const greens: Poly[] = [];
  const waters: Poly[] = [];
  for (const f of osm) {
    const p = f.properties ?? {};
    const isWater = p.natural === 'water';
    const isGreen =
      p.leisure === 'park' ||
      p.leisure === 'garden' ||
      p.landuse === 'grass' ||
      p.landuse === 'meadow' ||
      p.landuse === 'forest' ||
      p.landuse === 'recreation_ground' ||
      p.natural === 'wood' ||
      p.natural === 'grassland';
    if (!isWater && !isGreen) continue;
    for (const poly of polygonsOf(f)) {
      if (isWater) {
        waters.push(poly);
        water.push({ ring: poly[0].flat() });
        osmWater++;
      } else {
        greens.push(poly);
        // 只有真正的公园才进 parks（草地 / 树林不种树，避免路边草坪被塞满树）
        if (p.leisure === 'park' && ringArea(poly[0]) >= 400) parks.push({ ring: poly[0].flat() });
        osmGreen++;
      }
    }
  }
  for (const poly of greens) raster.fillPolygon(poly.map(toPix), rgb.park);
  for (const poly of waters) raster.fillPolygon(poly.map(toPix), rgb.water);
  log(`OSM overlay: water=${osmWater} green=${osmGreen}`);

  // 3) 输出
  const pngPath = resolve(buildDir, 'ground.png');
  writeFileSync(pngPath, raster.toPNG());
  const previewPath = resolve(debugDir, 'ground-preview.png');
  writeFileSync(previewPath, raster.downscale(4).toPNG());

  const r2 = (v: number) => Math.round(v * 100) / 100;
  const landuse = {
    palette: PALETTE,
    origin: { minX: r2(minX), minZ: r2(minZ) },
    pxPerM: PX_PER_M,
    width,
    height,
    parks: parks.map((p) => ({ ring: p.ring.map(r2) })),
    water: water.map((p) => ({ ring: p.ring.map(r2) })),
  };
  const jsonPath = resolve(buildDir, 'landuse.json');
  writeFileSync(jsonPath, JSON.stringify(landuse));

  const parkArea = parks.reduce((s, p) => s + ringArea(pairs(p.ring)), 0);
  const waterArea = water.reduce((s, p) => s + ringArea(pairs(p.ring)), 0);
  log(`parks=${parks.length} (${(parkArea / 1e4).toFixed(1)} ha)  water=${water.length} (${(waterArea / 1e4).toFixed(1)} ha)`);
  log(`wrote ${pngPath} (${width}×${height}, ${fmtBytes(fileSize(pngPath))})`);
  log(`wrote ${jsonPath} (${fmtBytes(fileSize(jsonPath))})`);
  log(`wrote ${previewPath} (${Math.floor(width / 4)}×${Math.floor(height / 4)})`);
}

function pairs(flat: number[]): Pos[] {
  const out: Pos[] = [];
  for (let i = 0; i + 1 < flat.length; i += 2) out.push([flat[i], flat[i + 1]]);
  return out;
}

main();
