// 第 8 步：由路网图生成路面 / 人行道三角网格与地面标线，按 256 m 块输出。
// 用法：node scripts/geo/08-roadmesh.ts
// 输入：data/geo/build/graph.json（GraphData，见 lib/graph-types.ts）
// 输出：data/geo/build/roadmesh.json   { grid, chunks: [{ i, j, roadPos, roadIdx, walkPos, walkIdx, marks }], stats }
//       data/geo/build/roadmesh-stats.json
//
// 做法：
//   - 互为 reverse 的两条边只处理一次（取 id 小的那条），总宽 = (lanesA + lanesB) × laneW；单向 = lanes × laneW。
//   - 每条边沿折线生成带状多边形（斜接，过锐时截角；短段急弯回折时退回"每段矩形 + 折点圆盘"），
//     两端节点处加半径 jr 的 16 边圆帽。
//   - 人行道：带宽 + 2 × SIDEWALK_W 的带状 / 圆帽并集，再减去路面；expressway / trunk 不生成。
//   - 为避免整体并集过慢，按 256 m 块分别并集：收集包围盒与块（外扩 8 m）相交的多边形做并集，再用块边界裁剪。
//     相邻块共享裁剪边，互不重叠。
//   - earcut 三角化（含孔）。
//   - 标线：车道虚线（每 6 m 一段 3 m，车道分界线含双向中线）、斑马线（边的 crossings 处，横跨整路）、
//     停止线（信号灯节点每条入边距节点 jr 处，宽 = 本方向车道总宽）；路缘（type 3）留空。
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { GEO_DIR, ensureDir, fileSize, fmtBytes, log, warn } from './lib/common.ts';
import { LOCAL_BBOX } from './lib/proj.ts';
import type { GraphData, GraphEdgeData, RoadKind } from './lib/graph-types.ts';
import {
  areaMP,
  circlePolygon,
  clipFailures,
  dedupePolyline,
  differenceMP,
  intersectMP,
  rectPolygon,
  ringBBox,
  stripPolygons,
  triangulateMP,
  unionRings,
  type BBox,
  type Pair,
  type Ring,
  type TriMesh,
} from './lib/mesh.ts';
import { CHUNK_SIZE } from '../../src/world/ChunkFormat.ts';

// ---------------------------------------------------------------------------
// 参数（与 src/config.ts 保持一致；脚本不引 src/config 以免拖入运行时依赖）
// ---------------------------------------------------------------------------

/** 人行道宽（米） */
const SIDEWALK_W = 2;
/** 行驶方向：-1 靠左（新加坡） */
const DRIVE_SIDE = -1;
/** 不生成人行道的道路类型 */
const NO_SIDEWALK: ReadonlySet<RoadKind> = new Set<RoadKind>(['expressway', 'trunk']);
/** 块外扩边距（米） */
const BLOCK_MARGIN = 8;
/** 车道虚线：周期 / 段长 / 宽 */
const DASH_PERIOD = 6;
const DASH_LEN = 3;
const DASH_W = 0.15;
/** 斑马线沿路长度 */
const ZEBRA_LEN = 2.4;
/** 停止线沿路长度 */
const STOP_LEN = 0.4;

const BUILD_DIR = resolve(GEO_DIR, 'build');
const OUT_FILE = resolve(BUILD_DIR, 'roadmesh.json');
const STATS_FILE = resolve(BUILD_DIR, 'roadmesh-stats.json');

// ---------------------------------------------------------------------------
// 类型
// ---------------------------------------------------------------------------

export interface MeshMark {
  type: 0 | 1 | 2 | 3;
  x: number;
  z: number;
  yaw: number;
  len: number;
  w: number;
}

export interface MeshChunk {
  i: number;
  j: number;
  roadPos: number[];
  roadIdx: number[];
  walkPos: number[];
  walkIdx: number[];
  marks: MeshMark[];
}

export interface RoadMeshFile {
  grid: { cols: number; rows: number; minX: number; minZ: number; size: number };
  chunks: MeshChunk[];
  stats: Record<string, unknown>;
}

interface Poly {
  ring: Ring;
  bb: BBox;
}

const r2 = (v: number) => Math.round(v * 100) / 100;
const r3 = (v: number) => Math.round(v * 1000) / 1000;
/** yaw 约定与 06-props 一致：0 朝 +z，yaw = atan2(dx, dz) */
const yawOf = (dx: number, dz: number) => Math.atan2(dx, dz);

// ---------------------------------------------------------------------------
// 折线弧长采样
// ---------------------------------------------------------------------------

interface Polyline {
  pts: Pair[];
  cum: number[];
  length: number;
}

function polylineOf(pts: number[]): Polyline {
  const p = dedupePolyline(pts);
  const cum = [0];
  for (let k = 1; k < p.length; k++) cum.push(cum[k - 1] + Math.hypot(p[k][0] - p[k - 1][0], p[k][1] - p[k - 1][1]));
  return { pts: p, cum, length: cum[cum.length - 1] ?? 0 };
}

/** 弧长 s 处的点与单位方向（夹到 [0, L]） */
function sampleAt(pl: Polyline, s: number, out: { x: number; z: number; dx: number; dz: number }): void {
  const n = pl.pts.length;
  if (n < 2) {
    out.x = pl.pts[0]?.[0] ?? 0;
    out.z = pl.pts[0]?.[1] ?? 0;
    out.dx = 0;
    out.dz = 1;
    return;
  }
  const ss = Math.max(0, Math.min(pl.length, s));
  let k = 1;
  while (k < n - 1 && pl.cum[k] < ss) k++;
  const a = pl.pts[k - 1], b = pl.pts[k];
  const segLen = pl.cum[k] - pl.cum[k - 1] || 1;
  const t = (ss - pl.cum[k - 1]) / segLen;
  out.x = a[0] + (b[0] - a[0]) * t;
  out.z = a[1] + (b[1] - a[1]) * t;
  out.dx = (b[0] - a[0]) / segLen;
  out.dz = (b[1] - a[1]) / segLen;
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

function main(): void {
  const t0 = performance.now();
  const graphPath = resolve(BUILD_DIR, 'graph.json');
  if (fileSize(graphPath) <= 0) {
    warn(`缺少 ${graphPath}，先跑 npm run geo:roads`);
    process.exit(1);
  }
  const graph = JSON.parse(readFileSync(graphPath, 'utf8')) as GraphData;
  const nodes = graph.nodes;
  const edges = graph.edges;
  const edgeById = new Map<number, GraphEdgeData>();
  for (const e of edges) edgeById.set(e.id, e);
  const nodeById = new Map<number, (typeof nodes)[number]>();
  for (const n of nodes) nodeById.set(n.id, n);
  log(`graph: ${nodes.length} 节点, ${edges.length} 边`);

  // 网格
  const minX = LOCAL_BBOX.minX, minZ = LOCAL_BBOX.minZ;
  const cols = Math.ceil((LOCAL_BBOX.maxX - minX) / CHUNK_SIZE);
  const rows = Math.ceil((LOCAL_BBOX.maxZ - minZ) / CHUNK_SIZE);
  log(`grid: ${cols} × ${rows} 块，块边 ${CHUNK_SIZE} m，原点 (${r2(minX)}, ${r2(minZ)})`);

  // 按块分桶
  const roadBuckets: Poly[][] = Array.from({ length: cols * rows }, () => []);
  const walkBuckets: Poly[][] = Array.from({ length: cols * rows }, () => []);
  const markBuckets: MeshMark[][] = Array.from({ length: cols * rows }, () => []);
  const bucketOf = (x: number, z: number): number => {
    const i = Math.max(0, Math.min(cols - 1, Math.floor((x - minX) / CHUNK_SIZE)));
    const j = Math.max(0, Math.min(rows - 1, Math.floor((z - minZ) / CHUNK_SIZE)));
    return j * cols + i;
  };
  const addPoly = (buckets: Poly[][], ring: Ring): void => {
    const bb = ringBBox(ring);
    const poly: Poly = { ring, bb };
    const i0 = Math.max(0, Math.floor((bb.minX - BLOCK_MARGIN - minX) / CHUNK_SIZE));
    const i1 = Math.min(cols - 1, Math.floor((bb.maxX + BLOCK_MARGIN - minX) / CHUNK_SIZE));
    const j0 = Math.max(0, Math.floor((bb.minZ - BLOCK_MARGIN - minZ) / CHUNK_SIZE));
    const j1 = Math.min(rows - 1, Math.floor((bb.maxZ + BLOCK_MARGIN - minZ) / CHUNK_SIZE));
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) buckets[j * cols + i].push(poly);
  };
  const addMark = (m: MeshMark): void => {
    markBuckets[bucketOf(m.x, m.z)].push(m);
  };

  // 节点处是否需要人行道圆帽（有任一非 expressway/trunk 的边）
  const nodeWalk = new Uint8Array(nodes.length);
  // 每个节点的入边（用于停止线）
  const incoming = new Map<number, GraphEdgeData[]>();
  for (const e of edges) {
    if (!NO_SIDEWALK.has(e.kind)) {
      nodeWalk[e.from] = 1;
      nodeWalk[e.to] = 1;
    }
    let arr = incoming.get(e.to);
    if (!arr) incoming.set(e.to, (arr = []));
    arr.push(e);
  }

  const stats = {
    pairs: 0,
    oneway: 0,
    foldedFallback: 0,
    stripPolys: 0,
    walkPolys: 0,
    marks: { lanedash: 0, zebra: 0, stopline: 0, kerb: 0 },
  };

  // 1) 带状多边形 + 标线
  const smp = { x: 0, z: 0, dx: 0, dz: 1 };
  for (const e of edges) {
    const rev = e.reverse != null ? edgeById.get(e.reverse) : undefined;
    if (rev && rev.id < e.id) continue; // 成对的边只处理 id 小的
    const totalLanes = e.lanes + (rev ? rev.lanes : 0);
    const W = totalLanes * e.laneW;
    if (rev) stats.pairs++;
    else stats.oneway++;
    const pl = polylineOf(e.pts);
    if (pl.pts.length < 2) continue;

    const road = stripPolygons(pl.pts, W / 2);
    if (road.length > 1) stats.foldedFallback++;
    stats.stripPolys += road.length;
    for (const r of road) addPoly(roadBuckets, r);
    if (!NO_SIDEWALK.has(e.kind)) {
      const walk = stripPolygons(pl.pts, W / 2 + SIDEWALK_W);
      stats.walkPolys += walk.length;
      for (const r of walk) addPoly(walkBuckets, r);
    }

    // 车道虚线：车道分界线在 -W/2 + i·laneW（沿右法线）；避开两端 jr 与斑马线附近
    const jrFrom = nodeById.get(e.from)?.jr ?? 4;
    const jrTo = nodeById.get(e.to)?.jr ?? 4;
    const s0 = jrFrom, s1 = pl.length - jrTo;
    if (totalLanes >= 2 && s1 - s0 >= DASH_LEN) {
      for (let s = s0; s + DASH_LEN <= s1; s += DASH_PERIOD) {
        const mid = s + DASH_LEN / 2;
        let nearCrossing = false;
        for (const c of e.crossings) if (Math.abs(mid - c) < ZEBRA_LEN / 2 + DASH_LEN / 2 + 0.5) nearCrossing = true;
        if (nearCrossing) continue;
        sampleAt(pl, mid, smp);
        const rx = -smp.dz, rz = smp.dx;
        const yaw = r3(yawOf(smp.dx, smp.dz));
        for (let i = 1; i < totalLanes; i++) {
          const o = -W / 2 + i * e.laneW;
          addMark({ type: 0, x: r2(smp.x + rx * o), z: r2(smp.z + rz * o), yaw, len: DASH_LEN, w: DASH_W });
          stats.marks.lanedash++;
        }
      }
    }
    // 斑马线（双向边的 crossings 互为镜像，只用本边的）
    for (const c of e.crossings) {
      sampleAt(pl, c, smp);
      addMark({ type: 1, x: r2(smp.x), z: r2(smp.z), yaw: r3(yawOf(smp.dx, smp.dz)), len: ZEBRA_LEN, w: r2(W) });
      stats.marks.zebra++;
    }
  }

  // 2) 停止线：信号灯节点的每条入边，距节点 jr 处，宽 = 本方向车道总宽，偏到行驶侧
  for (const n of nodes) {
    if (!n.signal) continue;
    for (const e of incoming.get(n.id) ?? []) {
      const rev = e.reverse != null ? edgeById.get(e.reverse) : undefined;
      const W = (e.lanes + (rev ? rev.lanes : 0)) * e.laneW;
      const wIn = e.lanes * e.laneW;
      const pl = polylineOf(e.pts);
      if (pl.length <= n.jr + 1) continue;
      sampleAt(pl, pl.length - n.jr, smp);
      const rx = -smp.dz, rz = smp.dx;
      const o = DRIVE_SIDE * (W / 2 - wIn / 2);
      addMark({ type: 2, x: r2(smp.x + rx * o), z: r2(smp.z + rz * o), yaw: r3(yawOf(smp.dx, smp.dz)), len: STOP_LEN, w: r2(wIn) });
      stats.marks.stopline++;
    }
  }

  // 3) 节点圆帽
  // 圆帽按节点 id 错开一个相位，避免顶点恰好落在水平/垂直路边上（减少 polygon-clipping 的退化情形）
  for (const n of nodes) {
    const phase = ((n.id * 0.618033) % 1) * (Math.PI / 8);
    addPoly(roadBuckets, circlePolygon(n.x, n.z, n.jr, 16, phase));
    if (nodeWalk[n.id]) addPoly(walkBuckets, circlePolygon(n.x, n.z, n.jr + SIDEWALK_W, 16, phase));
  }
  const t1 = performance.now();
  log(`带状多边形: 路面 ${stats.stripPolys}（回退 ${stats.foldedFallback} 条边）, 人行道 ${stats.walkPolys}, 节点圆帽 ${nodes.length}  (${((t1 - t0) / 1000).toFixed(1)} s)`);

  // 4) 逐块并集 / 裁剪 / 三角化
  const chunks: MeshChunk[] = [];
  let roadArea = 0, walkArea = 0, roadTris = 0, walkTris = 0;
  const triPerChunk: number[] = [];
  let slowest = { i: -1, j: -1, ms: 0 };
  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < cols; i++) {
      const b = j * cols + i;
      const rp = roadBuckets[b], wp = walkBuckets[b];
      const marks = markBuckets[b];
      if (rp.length === 0 && wp.length === 0 && marks.length === 0) continue;
      const tb0 = performance.now();
      const x0 = minX + i * CHUNK_SIZE, z0 = minZ + j * CHUNK_SIZE;
      const rect = [[rectPolygon(x0, z0, x0 + CHUNK_SIZE, z0 + CHUNK_SIZE)]];
      const roadU = unionRings(rp.map((p) => p.ring));
      const roadClip = intersectMP(roadU, rect);
      const walkU = unionRings(wp.map((p) => p.ring));
      const walkClip = intersectMP(differenceMP(walkU, roadU), rect);
      const roadMesh: TriMesh = { pos: [], idx: [] };
      const walkMesh: TriMesh = { pos: [], idx: [] };
      const rt = triangulateMP(roadClip, roadMesh);
      const wt = triangulateMP(walkClip, walkMesh);
      roadTris += rt;
      walkTris += wt;
      roadArea += areaMP(roadClip);
      walkArea += areaMP(walkClip);
      triPerChunk.push(rt + wt);
      chunks.push({
        i,
        j,
        roadPos: roadMesh.pos.map(r2),
        roadIdx: roadMesh.idx,
        walkPos: walkMesh.pos.map(r2),
        walkIdx: walkMesh.idx,
        marks,
      });
      const ms = performance.now() - tb0;
      if (ms > slowest.ms) slowest = { i, j, ms };
    }
  }
  const t2 = performance.now();

  // 5) 统计 + 输出
  triPerChunk.sort((a, b) => a - b);
  const pct = (q: number) => triPerChunk[Math.min(triPerChunk.length - 1, Math.floor(q * triPerChunk.length))] ?? 0;
  const fullStats = {
    generated: new Date().toISOString(),
    grid: { cols, rows, minX: r2(minX), minZ: r2(minZ), size: CHUNK_SIZE },
    ...stats,
    chunks: chunks.length,
    roadAreaM2: Math.round(roadArea),
    walkAreaM2: Math.round(walkArea),
    roadTris,
    walkTris,
    trisPerChunk: { min: triPerChunk[0] ?? 0, p50: pct(0.5), p90: pct(0.9), max: triPerChunk[triPerChunk.length - 1] ?? 0 },
    clipFailures: { ...clipFailures },
    slowestChunk: { i: slowest.i, j: slowest.j, ms: Math.round(slowest.ms) },
    timeMs: { strips: Math.round(t1 - t0), chunks: Math.round(t2 - t1), total: Math.round(performance.now() - t0) },
  };
  ensureDir(BUILD_DIR);
  const out: RoadMeshFile = { grid: fullStats.grid, chunks, stats: fullStats };
  writeFileSync(OUT_FILE, JSON.stringify(out));
  writeFileSync(STATS_FILE, JSON.stringify(fullStats, null, 2));

  log(`路面面积 ${(roadArea / 1e4).toFixed(1)} ha，人行道 ${(walkArea / 1e4).toFixed(1)} ha`);
  log(`三角: 路面 ${roadTris}，人行道 ${walkTris}；每块 min/p50/p90/max = ${fullStats.trisPerChunk.min}/${fullStats.trisPerChunk.p50}/${fullStats.trisPerChunk.p90}/${fullStats.trisPerChunk.max}`);
  log(`标线: ${JSON.stringify(stats.marks)}`);
  if (clipFailures.retried || clipFailures.dropped) warn(`polygon-clipping 失败重试 ${clipFailures.retried} 次，丢弃 ${clipFailures.dropped} 个多边形 ${JSON.stringify(clipFailures.byOp)}`);
  log(`最慢块 (${slowest.i}, ${slowest.j}) ${Math.round(slowest.ms)} ms；分块并集总耗时 ${((t2 - t1) / 1000).toFixed(1)} s，总耗时 ${((performance.now() - t0) / 1000).toFixed(1)} s`);
  log(`写出 ${OUT_FILE} (${fmtBytes(fileSize(OUT_FILE))})，${chunks.length} 块`);
}

main();
