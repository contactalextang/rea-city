// 第 9 步：把流水线产物打包成运行时加载的世界切块目录 public/world/sg/。
// 用法：node scripts/geo/09-chunks.ts
// 输入（data/geo/build/）：
//   graph.json      GraphData（必需）
//   buildings.json  BuildingRec[]（必需）
//   roadmesh.json   08-roadmesh 的分块路面 / 人行道三角网 + 标线（必需）
//   props.json      { props: [{ type, x, z, yaw, len?, name? }] }（缺则 WARN 跳过）
//   pois.json       { pois: Poi[] }（缺则 WARN 跳过）
//   landuse.json + ground.png  05-landuse 的土地用途（缺则 WARN 跳过，小地图底色退回纯色）
// 输出（public/world/sg/）：
//   c_<i>_<j>.bin   每块：路面 / 人行道网格、建筑（按质心归块，世界坐标）、道具（按位置）、标线、名称表；编码见 src/world/ChunkFormat.ts
//   skyline.bin     h > 40 m 的建筑挤出盒（非索引三角，每顶点 cls），远景天际线用
//   graph.json / pois.json / landuse.json / ground.png  原样复制
//   minimap.png     1 px/m 小地图：landuse 底色 + 水体 + 人行道 + 路面 + 建筑按 cls 填色
//   manifest.json   清单（网格、块列表、文件名、署名）
import { copyFileSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import earcut from 'earcut';
import { PNG } from 'pngjs';
import { GEO_DIR, PROJECT_ROOT, ensureDir, fileSize, fmtBytes, log, warn } from './lib/common.ts';
import { LOCAL_BBOX, ORIGIN } from './lib/proj.ts';
import { Raster, hexToRgb, type PixRing, type RGB } from './lib/raster.ts';
import type { GraphData } from './lib/graph-types.ts';
import type { BuildingRec } from './04-buildings.ts';
import type { RoadMeshFile, MeshChunk } from './08-roadmesh.ts';
import {
  CHUNK_SIZE,
  buildingClsFromName,
  propTypeFromName,
  decodeChunk,
  encodeChunk,
  encodeSkyline,
  type BuildingCls,
  type ChunkBuilding,
  type ChunkData,
  type ChunkMark,
  type ChunkProp,
  type Manifest,
  type ManifestChunk,
} from '../../src/world/ChunkFormat.ts';

const BUILD_DIR = resolve(GEO_DIR, 'build');
const OUT_DIR = resolve(PROJECT_ROOT, 'public/world/sg');
/** 进天际线的最低建筑高度（米） */
const SKYLINE_MIN_H = 40;
/** 小地图颜色 */
const MINIMAP = {
  road: '#5c5c63',
  walk: '#8a8a86',
  water: '#3a6ea5',
  fallbackGround: '#6f6f6a',
  cls: ['#9d9d98', '#c9b8a0', '#c78f6d', '#7f94b8', '#e0c060'] as const, // generic / hdb / shophouse / glass / landmark
};
const ATTRIBUTION = [
  '© OpenStreetMap contributors (ODbL)',
  'Contains information from LTA DataMall / URA / HDB / NEA accessed 2026-10, Singapore Open Data Licence v1.0',
];

interface PropRec {
  type: string;
  x: number;
  z: number;
  yaw: number;
  len?: number;
  name?: string;
}
interface LanduseFile {
  parks: { ring: number[] }[];
  water: { ring: number[] }[];
  pxPerM: number;
  width: number;
  height: number;
}

function readJson<T>(path: string): T | null {
  if (fileSize(path) <= 0) return null;
  return JSON.parse(readFileSync(path, 'utf8')) as T;
}

/** 扁平环 [x0, z0, ...] 的质心（面积加权；退化时取顶点平均） */
function centroidFlat(ring: ArrayLike<number>): [number, number] {
  const n = ring.length >> 1;
  let a = 0, cx = 0, cz = 0;
  for (let k = 0; k < n; k++) {
    const x0 = ring[k * 2], z0 = ring[k * 2 + 1];
    const x1 = ring[((k + 1) % n) * 2], z1 = ring[((k + 1) % n) * 2 + 1];
    const cross = x0 * z1 - x1 * z0;
    a += cross;
    cx += (x0 + x1) * cross;
    cz += (z0 + z1) * cross;
  }
  if (Math.abs(a) < 1e-9) {
    let sx = 0, sz = 0;
    for (let k = 0; k < n; k++) {
      sx += ring[k * 2];
      sz += ring[k * 2 + 1];
    }
    return [sx / n, sz / n];
  }
  return [cx / (3 * a), cz / (3 * a)];
}

function main(): void {
  const t0 = performance.now();
  ensureDir(OUT_DIR);

  // ---------------- 读入 ----------------
  const graph = readJson<GraphData>(resolve(BUILD_DIR, 'graph.json'));
  const buildings = readJson<BuildingRec[]>(resolve(BUILD_DIR, 'buildings.json'));
  const roadmesh = readJson<RoadMeshFile>(resolve(BUILD_DIR, 'roadmesh.json'));
  if (!graph || !buildings || !roadmesh) {
    warn('缺少 graph.json / buildings.json / roadmesh.json，先跑 geo:roads、geo:buildings、geo:roadmesh');
    process.exit(1);
  }
  const propsFile = readJson<{ props: PropRec[] }>(resolve(BUILD_DIR, 'props.json'));
  if (!propsFile) warn('props.json 不存在，跳过道具（跑完 geo:props 后重跑本步）');
  const poisPath = resolve(BUILD_DIR, 'pois.json');
  const hasPois = fileSize(poisPath) > 0;
  if (!hasPois) warn('pois.json 不存在，跳过 POI（跑完 geo:pois 后重跑本步）');
  const landuse = readJson<LanduseFile>(resolve(BUILD_DIR, 'landuse.json'));
  const groundPath = resolve(BUILD_DIR, 'ground.png');
  const hasGround = fileSize(groundPath) > 0;
  if (!landuse || !hasGround) warn('landuse.json / ground.png 不存在，跳过土地用途（小地图底色用纯色）');

  // ---------------- 网格 ----------------
  const minX = LOCAL_BBOX.minX, minZ = LOCAL_BBOX.minZ;
  const cols = Math.ceil((LOCAL_BBOX.maxX - minX) / CHUNK_SIZE);
  const rows = Math.ceil((LOCAL_BBOX.maxZ - minZ) / CHUNK_SIZE);
  if (roadmesh.grid.cols !== cols || roadmesh.grid.rows !== rows || Math.abs(roadmesh.grid.minX - minX) > 0.01 || Math.abs(roadmesh.grid.minZ - minZ) > 0.01) {
    warn(`roadmesh.json 的网格 (${roadmesh.grid.cols}×${roadmesh.grid.rows}) 与当前 (${cols}×${rows}) 不一致，请重跑 geo:roadmesh`);
    process.exit(1);
  }
  const idxOf = (x: number, z: number): number => {
    const i = Math.max(0, Math.min(cols - 1, Math.floor((x - minX) / CHUNK_SIZE)));
    const j = Math.max(0, Math.min(rows - 1, Math.floor((z - minZ) / CHUNK_SIZE)));
    return j * cols + i;
  };
  log(`grid: ${cols} × ${rows} 块，原点 (${minX.toFixed(2)}, ${minZ.toFixed(2)})`);

  const chunks: ChunkData[] = [];
  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < cols; i++) {
      chunks.push({
        i,
        j,
        roadPos: new Float32Array(0),
        roadIdx: new Uint32Array(0),
        walkPos: new Float32Array(0),
        walkIdx: new Uint32Array(0),
        buildings: [],
        props: [],
        marks: [],
        names: [],
      });
    }
  }

  // ---------------- 路面 / 人行道 / 标线 ----------------
  const meshByIdx = new Map<number, MeshChunk>();
  let roadTris = 0, walkTris = 0, markCount = 0;
  for (const mc of roadmesh.chunks) {
    const idx = mc.j * cols + mc.i;
    meshByIdx.set(idx, mc);
    const c = chunks[idx];
    c.roadPos = Float32Array.from(mc.roadPos);
    c.roadIdx = Uint32Array.from(mc.roadIdx);
    c.walkPos = Float32Array.from(mc.walkPos);
    c.walkIdx = Uint32Array.from(mc.walkIdx);
    c.marks = mc.marks.map((m): ChunkMark => ({ type: m.type, x: m.x, z: m.z, yaw: m.yaw, len: m.len, w: m.w }));
    roadTris += mc.roadIdx.length / 3;
    walkTris += mc.walkIdx.length / 3;
    markCount += mc.marks.length;
  }

  // ---------------- 建筑（按质心归块） ----------------
  const clsCount: Record<string, number> = {};
  let namedBuildings = 0;
  let blkNames = 0;
  for (const b of buildings) {
    if (b.ring.length < 6) continue;
    const [cx, cz] = centroidFlat(b.ring);
    const c = chunks[idxOf(cx, cz)];
    const cls = buildingClsFromName(b.cls);
    let nameIdx = -1;
    if (b.name) {
      nameIdx = c.names.indexOf(b.name);
      if (nameIdx < 0) {
        nameIdx = c.names.length;
        c.names.push(b.name);
      }
      namedBuildings++;
    }
    const cb: ChunkBuilding = {
      id: b.id,
      h: b.h,
      cls,
      ring: Float32Array.from(b.ring),
      holes: (b.holes ?? []).filter((h) => h.length >= 6).map((h) => Float32Array.from(h)),
      nameIdx,
    };
    c.buildings.push(cb);
    clsCount[b.cls] = (clsCount[b.cls] ?? 0) + 1;
    // 组屋楼号：以 `blk:<建筑 id>=<楼号>` 追加进名称表（不占 nameIdx，旧解码器照常读出、建筑名语义不变），
    // 运行时 Signage 据此在山墙画大号楼号
    if (cls === 1 && b.blk) {
      c.names.push(`blk:${b.id}=${b.blk}`);
      blkNames++;
    }
  }

  // ---------------- 道具（按位置归块） ----------------
  let propCount = 0;
  const propSkipped: Record<string, number> = {};
  if (propsFile) {
    for (const p of propsFile.props) {
      const type = propTypeFromName(p.type);
      if (type === -1) {
        propSkipped[p.type] = (propSkipped[p.type] ?? 0) + 1;
        continue;
      }
      const cp: ChunkProp = { type, x: p.x, z: p.z, yaw: p.yaw, len: p.len ?? 0 };
      chunks[idxOf(p.x, p.z)].props.push(cp);
      propCount++;
    }
    if (Object.keys(propSkipped).length) warn(`未知道具类型被跳过: ${JSON.stringify(propSkipped)}`);
  }

  // ---------------- 写块文件 + 回读校验 ----------------
  const manifestChunks: ManifestChunk[] = [];
  let totalChunkBytes = 0, maxChunkBytes = 0, maxChunk = '';
  for (const c of chunks) {
    const buf = encodeChunk(c);
    const file = `c_${c.i}_${c.j}.bin`;
    writeFileSync(resolve(OUT_DIR, file), Buffer.from(buf));
    // 回读校验：解码后计数一致
    const back = decodeChunk(buf);
    if (
      back.i !== c.i || back.j !== c.j ||
      back.roadIdx.length !== c.roadIdx.length || back.walkIdx.length !== c.walkIdx.length ||
      back.buildings.length !== c.buildings.length || back.props.length !== c.props.length ||
      back.marks.length !== c.marks.length || back.names.length !== c.names.length
    ) {
      throw new Error(`块 ${file} 回读不一致`);
    }
    totalChunkBytes += buf.byteLength;
    if (buf.byteLength > maxChunkBytes) {
      maxChunkBytes = buf.byteLength;
      maxChunk = file;
    }
    manifestChunks.push({ i: c.i, j: c.j, file, bytes: buf.byteLength, buildings: c.buildings.length, props: c.props.length });
  }
  log(`块文件: ${chunks.length} 个，共 ${fmtBytes(totalChunkBytes)}，最大 ${maxChunk} ${fmtBytes(maxChunkBytes)}`);

  // ---------------- 天际线 ----------------
  const skyPos: number[] = [];
  const skyCls: number[] = [];
  let skyBuildings = 0;
  const pushTri = (ax: number, ay: number, az: number, bx: number, by: number, bz: number, cx: number, cy: number, cz: number, cls: BuildingCls) => {
    skyPos.push(ax, ay, az, bx, by, bz, cx, cy, cz);
    skyCls.push(cls, cls, cls);
  };
  for (const b of buildings) {
    if (b.h <= SKYLINE_MIN_H || b.ring.length < 6) continue;
    skyBuildings++;
    const cls = buildingClsFromName(b.cls);
    const h = b.h;
    const rings = [b.ring, ...(b.holes ?? []).filter((r) => r.length >= 6)];
    // 侧面：外环逆时针（俯视，z 向南），孔顺时针；每条边两个三角，法线朝外（由 Three.js 侧按 CCW 判断）
    for (const ring of rings) {
      const n = ring.length >> 1;
      for (let k = 0; k < n; k++) {
        const x0 = ring[k * 2], z0 = ring[k * 2 + 1];
        const x1 = ring[((k + 1) % n) * 2], z1 = ring[((k + 1) % n) * 2 + 1];
        // 俯视逆时针（鞋带 < 0）的外环，从外侧看：底 0→1，顶 1→0
        pushTri(x0, 0, z0, x1, 0, z1, x1, h, z1, cls);
        pushTri(x0, 0, z0, x1, h, z1, x0, h, z0, cls);
      }
    }
    // 顶面：earcut（含孔）。法线要朝 +y：三角 (a, b, c) 的 (b−a)×(c−a) 的 y 分量 = dz1·dx2 − dx1·dz2，
    // 为负则交换 b、c。不依赖 earcut 的输出方向。
    const flat: number[] = [];
    const holes: number[] = [];
    for (let r = 0; r < rings.length; r++) {
      if (r > 0) holes.push(flat.length / 2);
      for (const v of rings[r]) flat.push(v);
    }
    const tri = earcut(flat, holes.length ? holes : undefined, 2);
    for (let k = 0; k < tri.length; k += 3) {
      const a = tri[k] * 2;
      let bb = tri[k + 1] * 2, cc = tri[k + 2] * 2;
      const ny = (flat[bb + 1] - flat[a + 1]) * (flat[cc] - flat[a]) - (flat[bb] - flat[a]) * (flat[cc + 1] - flat[a + 1]);
      if (ny < 0) {
        const t = bb;
        bb = cc;
        cc = t;
      }
      pushTri(flat[a], h, flat[a + 1], flat[bb], h, flat[bb + 1], flat[cc], h, flat[cc + 1], cls);
    }
  }
  const skyBuf = encodeSkyline({ pos: Float32Array.from(skyPos), cls: Uint8Array.from(skyCls) });
  writeFileSync(resolve(OUT_DIR, 'skyline.bin'), Buffer.from(skyBuf));
  log(`skyline.bin: ${skyBuildings} 栋 (h > ${SKYLINE_MIN_H} m)，${skyCls.length / 3} 三角，${fmtBytes(skyBuf.byteLength)}`);

  // ---------------- 复制文件 ----------------
  copyFileSync(resolve(BUILD_DIR, 'graph.json'), resolve(OUT_DIR, 'graph.json'));
  if (hasPois) copyFileSync(poisPath, resolve(OUT_DIR, 'pois.json'));
  else writeFileSync(resolve(OUT_DIR, 'pois.json'), JSON.stringify({ pois: [] }));
  if (landuse) copyFileSync(resolve(BUILD_DIR, 'landuse.json'), resolve(OUT_DIR, 'landuse.json'));
  else writeFileSync(resolve(OUT_DIR, 'landuse.json'), JSON.stringify({ parks: [], water: [] }));
  if (hasGround) copyFileSync(groundPath, resolve(OUT_DIR, 'ground.png'));

  // ---------------- 小地图 ----------------
  const tm0 = performance.now();
  const W = Math.ceil(LOCAL_BBOX.maxX - minX);
  const H = Math.ceil(LOCAL_BBOX.maxZ - minZ);
  const map = new Raster(W, H, hexToRgb(MINIMAP.fallbackGround));
  if (hasGround) {
    // 底色：ground.png（0.5 px/m）放大到 1 px/m
    const g = PNG.sync.read(readFileSync(groundPath));
    const sx = g.width / W, sy = g.height / H;
    for (let y = 0; y < H; y++) {
      const gy = Math.min(g.height - 1, Math.floor(y * sy));
      for (let x = 0; x < W; x++) {
        const gx = Math.min(g.width - 1, Math.floor(x * sx));
        const o = (gy * g.width + gx) * 4;
        map.set(x, y, [g.data[o], g.data[o + 1], g.data[o + 2]]);
      }
    }
  }
  const toPix = (ring: ArrayLike<number>): PixRing => {
    const out: PixRing = [];
    for (let k = 0; k + 1 < ring.length; k += 2) out.push([ring[k] - minX, ring[k + 1] - minZ]);
    return out;
  };
  if (landuse) {
    const water = hexToRgb(MINIMAP.water);
    for (const w of landuse.water) map.fillPolygon([toPix(w.ring)], water);
  }
  // 人行道、路面：按三角逐个填充（相邻三角共享边，扫描线半开区间不会留缝）
  const fillTris = (pos: number[], idx: number[], rgb: RGB) => {
    for (let k = 0; k < idx.length; k += 3) {
      const a = idx[k] * 2, b = idx[k + 1] * 2, c = idx[k + 2] * 2;
      map.fillPolygon([[[pos[a] - minX, pos[a + 1] - minZ], [pos[b] - minX, pos[b + 1] - minZ], [pos[c] - minX, pos[c + 1] - minZ]]], rgb);
    }
  };
  const walkRgb = hexToRgb(MINIMAP.walk);
  const roadRgb = hexToRgb(MINIMAP.road);
  for (const mc of meshByIdx.values()) fillTris(mc.walkPos, mc.walkIdx, walkRgb);
  for (const mc of meshByIdx.values()) fillTris(mc.roadPos, mc.roadIdx, roadRgb);
  const clsRgb = MINIMAP.cls.map(hexToRgb);
  for (const b of buildings) {
    if (b.ring.length < 6) continue;
    const rings: PixRing[] = [toPix(b.ring), ...(b.holes ?? []).map(toPix)];
    map.fillPolygon(rings, clsRgb[buildingClsFromName(b.cls)]);
  }
  const minimapPng = map.toPNG();
  writeFileSync(resolve(OUT_DIR, 'minimap.png'), minimapPng);
  log(`minimap.png: ${W} × ${H}，${fmtBytes(minimapPng.length)}（${((performance.now() - tm0) / 1000).toFixed(1)} s）`);

  // ---------------- manifest ----------------
  const manifest: Manifest = {
    version: 1,
    origin: { lon: ORIGIN.lon, lat: ORIGIN.lat },
    bbox: { minX: LOCAL_BBOX.minX, maxX: LOCAL_BBOX.maxX, minZ: LOCAL_BBOX.minZ, maxZ: LOCAL_BBOX.maxZ },
    chunkSize: 256,
    grid: { cols, rows, minX, minZ },
    chunks: manifestChunks,
    files: { graph: 'graph.json', pois: 'pois.json', skyline: 'skyline.bin', ground: 'ground.png', minimap: 'minimap.png', landuse: 'landuse.json' },
    attribution: ATTRIBUTION,
  };
  writeFileSync(resolve(OUT_DIR, 'manifest.json'), JSON.stringify(manifest));

  // ---------------- 汇总 ----------------
  const sizeOf = (f: string) => Math.max(0, fileSize(resolve(OUT_DIR, f)));
  const dataBytes = totalChunkBytes + skyBuf.byteLength + sizeOf('graph.json') + sizeOf('pois.json') + sizeOf('landuse.json') + sizeOf('manifest.json');
  const pngBytes = sizeOf('ground.png') + sizeOf('minimap.png');
  log(`建筑 ${buildings.length}（有名 ${namedBuildings}，组屋楼号 ${blkNames}）${JSON.stringify(clsCount)}；道具 ${propCount}；标线 ${markCount}；三角 路面 ${roadTris} + 人行道 ${walkTris}`);
  log(`总大小（不含 png）${fmtBytes(dataBytes)}${dataBytes > 15 * 1024 * 1024 ? '  超过 15 MB 目标！' : ''}；png ${fmtBytes(pngBytes)}；输出目录 ${OUT_DIR}`);
  log(`耗时 ${((performance.now() - t0) / 1000).toFixed(1)} s`);
  const summary = {
    generated: new Date().toISOString(),
    grid: manifest.grid,
    chunks: chunks.length,
    chunkBytes: totalChunkBytes,
    maxChunk: { file: maxChunk, bytes: maxChunkBytes },
    skyline: { buildings: skyBuildings, tris: skyCls.length / 3, bytes: skyBuf.byteLength },
    buildings: buildings.length,
    namedBuildings,
    blkNames,
    byCls: clsCount,
    props: propCount,
    propSkipped,
    marks: markCount,
    roadTris,
    walkTris,
    dataBytes,
    pngBytes,
    inputs: { props: !!propsFile, pois: hasPois, landuse: !!landuse && hasGround },
  };
  writeFileSync(resolve(BUILD_DIR, 'chunks-stats.json'), JSON.stringify(summary, null, 2));
}

main();
