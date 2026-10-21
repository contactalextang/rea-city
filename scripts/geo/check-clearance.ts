// 净空检查：基于流水线最终产物（data/geo/build/graph.json + buildings.json + props.json）统计
//   1) 侵入非 service 车行道 > 1 m 的建筑数（目标 0）
//   2) 侵入车行道（含 service，与运行时 RoadClearance 同口径）的地铁出口数（目标 0）
//   3) 中心线落在建筑内的车行道边数（≥ 2 m 或 > 60% 落在建筑内）
// 用法：node scripts/geo/check-clearance.ts [--list] [--strict]
//   --list    打印前 20 个违规明细
//   --strict  指标 1 / 2 非 0 时退出码 1
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { GEO_DIR, log } from './lib/common.ts';
import type { GraphData } from './lib/graph-types.ts';
import type { Pos, Ring } from './lib/geom.ts';
import { PolyGrid, RoadBands, type Poly } from './lib/clearance.ts';

const BUILD_DIR = resolve(GEO_DIR, 'build');
const BUILDING_TOL = 1; // m
/** 地铁出口外形半对角（3×3 m 盒） */
const MRT_R = 2.1;
const EDGE_INSIDE_M = 2;
const EDGE_INSIDE_RATIO = 0.6;

interface BuildingRec {
  id: number;
  ring: number[];
  holes?: number[][];
  name?: string;
}
interface PropRec {
  type: string;
  x: number;
  z: number;
  name?: string;
}

const toRing = (flat: number[]): Ring => {
  const r: Ring = [];
  for (let k = 0; k + 1 < flat.length; k += 2) r.push([flat[k], flat[k + 1]] as Pos);
  return r;
};

function main(): void {
  const args = new Set(process.argv.slice(2));
  const graph = JSON.parse(readFileSync(resolve(BUILD_DIR, 'graph.json'), 'utf8')) as GraphData;
  const buildings = JSON.parse(readFileSync(resolve(BUILD_DIR, 'buildings.json'), 'utf8')) as BuildingRec[];
  const props = (JSON.parse(readFileSync(resolve(BUILD_DIR, 'props.json'), 'utf8')) as { props: PropRec[] }).props;

  const major = new RoadBands(graph, false);
  const all = new RoadBands(graph, true);

  // 1) 建筑侵入非 service 车行道
  const badB: { id: number; name?: string; depth: number }[] = [];
  const grid = new PolyGrid();
  for (const b of buildings) {
    const p: Poly = { outer: toRing(b.ring), holes: (b.holes ?? []).map(toRing) };
    grid.add(p);
    const d = major.polyDepth(p);
    if (d > BUILDING_TOL) badB.push({ id: b.id, name: b.name, depth: d });
  }
  badB.sort((a, b) => b.depth - a.depth);

  // 2) 地铁出口侵入车行道
  const exits = props.filter((p) => p.type === 'mrtexit');
  const badM: { name?: string; x: number; z: number; depth: number }[] = [];
  for (const e of exits) {
    const h = all.pointDepth(e.x, e.z, MRT_R);
    if (h.depth > 0.01) badM.push({ name: e.name, x: e.x, z: e.z, depth: h.depth });
  }
  badM.sort((a, b) => b.depth - a.depth);
  const exitsInBuilding = exits.filter((e) => grid.contains(e.x, e.z)).length;

  // 3) 中心线落在建筑内的车行道边（成对只算一条）
  const inEdges = { service: 0, major: 0 };
  const inList: { id: number; kind: string; name?: string; inside: number; ratio: number }[] = [];
  for (const e of graph.edges) {
    if (e.reverse !== null && e.reverse < e.id) continue;
    const { inside, total } = grid.insideLength(e.pts);
    if (inside >= EDGE_INSIDE_M || (total > 0 && inside / total > EDGE_INSIDE_RATIO)) {
      if (e.kind === 'service') inEdges.service++;
      else inEdges.major++;
      inList.push({ id: e.id, kind: e.kind, name: e.name, inside, ratio: total ? inside / total : 0 });
    }
  }
  inList.sort((a, b) => b.inside - a.inside);

  log(`graph: ${graph.nodes.length} nodes / ${graph.edges.length} edges; buildings ${buildings.length}; mrt exits ${exits.length}`);
  log(`[1] 侵入非 service 车行道 > ${BUILDING_TOL} m 的建筑: ${badB.length}`);
  log(`[2] 侵入车行道（半对角 ${MRT_R} m）的地铁出口: ${badM.length}`);
  log(`    （参考）地铁出口中心落在建筑内: ${exitsInBuilding}`);
  log(`[3] 中心线落在建筑内（≥ ${EDGE_INSIDE_M} m 或 > ${EDGE_INSIDE_RATIO * 100}%）的车行道边: 非 service ${inEdges.major}, service ${inEdges.service}`);
  if (args.has('--list')) {
    for (const b of badB.slice(0, 20)) log(`  bldg ${b.id} ${b.name ?? ''} depth ${b.depth.toFixed(2)} m`);
    for (const m of badM.slice(0, 20)) log(`  mrt ${m.name ?? ''} (${m.x}, ${m.z}) depth ${m.depth.toFixed(2)} m`);
    for (const e of inList.slice(0, 20)) log(`  edge ${e.id} ${e.kind} ${e.name ?? ''} inside ${e.inside.toFixed(1)} m (${(e.ratio * 100).toFixed(0)}%)`);
  }
  if (args.has('--strict') && (badB.length || badM.length)) process.exit(1);
}

main();
