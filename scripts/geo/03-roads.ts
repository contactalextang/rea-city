// 第 4 步（03）：从 data/geo/local/osm-lines.geojson 构建车行道有向路网图。
// 用法：node scripts/geo/03-roads.ts
// 输入：data/geo/local/osm-lines.geojson（本地米制 [x, z]）、osm-points.geojson（traffic_signals / crossing）
// 输出：data/geo/build/graph.json（类型见 lib/graph-types.ts）
//       data/geo/build/graph-stats.json（统计）
//       data/geo/build/debug/graph.svg（整片路网，按 kind 着色，路口 / 信号灯打点）
//
// 流程：筛选车行道 → 解析属性（kind / 车道 / 限速 / 单向）→ 坐标合并为节点 → 度 2 且属性相同的折点折进
// 折线 → 生成有向边（双向路两条互为 reverse）→ 合并 <1 m 的短边 → 最大强连通分量 → 信号灯 / 人行横道 → jr。
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { GEO_DIR, LOCAL_DIR, ensureDir, fileSize, fmtBytes, log, warn } from './lib/common.ts';
import { LOCAL_BBOX } from './lib/proj.ts';
import type { GraphData, GraphEdgeData, GraphNodeData, RoadKind } from './lib/graph-types.ts';

const BUILD_DIR = resolve(GEO_DIR, 'build');
const DEBUG_DIR = resolve(BUILD_DIR, 'debug');
const IN_LINES = resolve(LOCAL_DIR, 'osm-lines.geojson');
const IN_POINTS = resolve(LOCAL_DIR, 'osm-points.geojson');
const OUT_GRAPH = resolve(BUILD_DIR, 'graph.json');
const OUT_STATS = resolve(BUILD_DIR, 'graph-stats.json');
const OUT_SVG = resolve(DEBUG_DIR, 'graph.svg');

// ---------------------------------------------------------------------------
// 参数
// ---------------------------------------------------------------------------
const KEY_PRECISION = 100; // 节点合并精度：0.01 m
const MIN_PT_DIST = 0.3; // 折线中距离更近的重复点去掉
const MIN_EDGE_LEN = 1; // 短于此的边把两端节点合并
const SIGNAL_RADIUS = 25; // traffic_signals 归到路口的距离
const CROSSING_RADIUS = 6; // crossing 投影到边的最大距离
const SCC_KEEP_RATIO = 0.9; // 最大强连通分量占比低于此才裁剪
// 裁剪时是否连同"能到达最大分量 / 能从最大分量到达"的节点一起保留。
// 切片边界截断的单向路（AYE / ECP / MCE 地面段、匝道）只进不出或只出不进，不在 SCC 里但仍是主干道，
// 只裁真正孤立的小岛（经隧道 / 步行道才相连的停车场内道等）。设为 false 则严格只留最大 SCC。
const KEEP_WEAKLY_ATTACHED = true;

const KIND_OF: Record<string, RoadKind> = {
  motorway: 'expressway',
  motorway_link: 'expressway',
  trunk: 'trunk',
  trunk_link: 'trunk',
  primary: 'primary',
  primary_link: 'primary',
  secondary: 'secondary',
  secondary_link: 'secondary',
  tertiary: 'tertiary',
  tertiary_link: 'tertiary',
  residential: 'residential',
  unclassified: 'residential',
  living_street: 'residential',
  road: 'residential',
  service: 'service',
};
const KINDS: RoadKind[] = ['expressway', 'trunk', 'primary', 'secondary', 'tertiary', 'residential', 'service'];
/** 每方向默认车道数 */
const DEFAULT_LANES: Record<RoadKind, number> = { expressway: 3, trunk: 2, primary: 2, secondary: 2, tertiary: 1, residential: 1, service: 1 };
/** 默认限速 km/h */
const DEFAULT_SPEED: Record<RoadKind, number> = { expressway: 90, trunk: 70, primary: 60, secondary: 50, tertiary: 50, residential: 50, service: 30 };
const laneWidthOf = (k: RoadKind) => (k === 'service' ? 3.0 : 3.3);

// ---------------------------------------------------------------------------
// 类型
// ---------------------------------------------------------------------------
type Pos = [number, number];
interface Feature {
  type: 'Feature';
  properties: Record<string, unknown> | null;
  geometry: { type: string; coordinates: unknown } | null;
}

/** 一段 way 的驾驶属性（折点两侧属性不同就不能折进同一条边） */
interface WayAttrs {
  kind: RoadKind;
  lanesF: number;
  lanesB: number; // 单向为 0
  oneway: boolean;
  speed: number;
  laneW: number;
  name?: string;
  bridge: boolean;
}
/** 一条 way（或被切片裁剪后的一段）：坐标已按行驶方向（oneway=-1 已反转） */
interface Run {
  attrs: WayAttrs;
  pts: Pos[];
}
/** 节点信息（按坐标 key） */
interface NodeInfo {
  key: string;
  pos: Pos;
  junction: boolean;
}
/** 两节点之间的一段折线（run 在节点处切开） */
interface Piece {
  id: number;
  attrs: WayAttrs;
  pts: Pos[];
  startKey: string;
  endKey: string;
}
interface Chain {
  attrs: WayAttrs;
  pts: Pos[];
  startKey: string;
  endKey: string;
}

// ---------------------------------------------------------------------------
// 工具
// ---------------------------------------------------------------------------
const r2 = (v: number) => Math.round(v * 100) / 100;
const keyOf = (p: Pos) => `${Math.round(p[0] * KEY_PRECISION)},${Math.round(p[1] * KEY_PRECISION)}`;
const dist = (a: Pos, b: Pos) => Math.hypot(a[0] - b[0], a[1] - b[1]);
const polylineLength = (pts: Pos[]) => {
  let s = 0;
  for (let i = 1; i < pts.length; i++) s += dist(pts[i - 1], pts[i]);
  return s;
};
const bump = (m: Record<string, number>, k: string, n = 1) => {
  m[k] = (m[k] ?? 0) + n;
};

/** 取字符串里的第一个整数（"2"、"2;3"、"1.5" → 2、2、2） */
function parseIntTag(v: unknown): number | null {
  if (typeof v !== 'string') return null;
  const m = v.match(/-?\d+(\.\d+)?/);
  if (!m) return null;
  const n = Math.round(parseFloat(m[0]));
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** maxspeed → km/h；带 mph 的换算（新加坡没有，防御性处理） */
function parseSpeed(v: unknown, kind: RoadKind): number {
  if (typeof v === 'string') {
    const m = v.match(/(\d+(\.\d+)?)\s*(mph)?/i);
    if (m) {
      let s = parseFloat(m[1]);
      if (m[3]) s *= 1.609344;
      if (s > 0) return Math.round(s);
    }
  }
  return DEFAULT_SPEED[kind];
}

function attrsEqual(a: WayAttrs, b: WayAttrs): boolean {
  return (
    a.kind === b.kind &&
    a.lanesF === b.lanesF &&
    a.lanesB === b.lanesB &&
    a.oneway === b.oneway &&
    a.speed === b.speed &&
    a.laneW === b.laneW &&
    a.name === b.name &&
    a.bridge === b.bridge
  );
}

// ---------------------------------------------------------------------------
// 1. 读取 + 筛选车行道
// ---------------------------------------------------------------------------
interface ParseStats {
  waysByHighway: Record<string, number>;
  ignoredHighway: Record<string, number>;
  droppedTunnel: number;
  droppedLayer: number;
  runs: number;
}

function parseWays(features: Feature[], stats: ParseStats): Run[] {
  const runs: Run[] = [];
  for (const f of features) {
    const p = f.properties ?? {};
    const hw = typeof p.highway === 'string' ? p.highway : undefined;
    if (!hw || !f.geometry) continue;
    const kind = KIND_OF[hw];
    if (!kind) {
      bump(stats.ignoredHighway, hw);
      continue;
    }
    bump(stats.waysByHighway, hw);
    // 隧道 / 地下：丢弃（MCE、CTE 等）
    const tunnel = p.tunnel;
    if (tunnel === 'yes' || tunnel === 'building_passage') {
      stats.droppedTunnel++;
      continue;
    }
    const layer = parseFloat(String(p.layer ?? ''));
    if (Number.isFinite(layer) && layer <= -1) {
      stats.droppedLayer++;
      continue;
    }

    // 单向
    const ow = typeof p.oneway === 'string' ? p.oneway.trim().toLowerCase() : undefined;
    let oneway = ow === 'yes' || ow === '1' || ow === 'true' || ow === '-1';
    const reversed = ow === '-1';
    if (p.junction === 'roundabout') oneway = true;
    if (kind === 'expressway' && ow === undefined) oneway = true; // 高速及匝道默认单向
    if (ow === 'no') oneway = false;

    // 车道数：lanes:forward / lanes:backward 优先，其次 lanes，最后按 kind 默认
    const lt = parseIntTag(p.lanes);
    let lf = parseIntTag(p['lanes:forward']);
    let lb = parseIntTag(p['lanes:backward']);
    if (reversed) [lf, lb] = [lb, lf]; // 行驶方向与 way 方向相反
    const def = DEFAULT_LANES[kind];
    let lanesF: number;
    let lanesB: number;
    if (oneway) {
      lanesF = lf ?? lt ?? def;
      lanesB = 0;
    } else {
      lanesF = lf ?? (lt != null ? Math.max(1, lb != null ? lt - lb : Math.ceil(lt / 2)) : def);
      lanesB = lb ?? (lt != null ? Math.max(1, lf != null ? lt - lf : Math.ceil(lt / 2)) : def);
    }

    const bridgeTag = p.bridge;
    const bridge = typeof bridgeTag === 'string' && bridgeTag !== 'no';
    const attrs: WayAttrs = {
      kind,
      lanesF,
      lanesB,
      oneway,
      speed: parseSpeed(p.maxspeed, kind),
      laneW: laneWidthOf(kind),
      name: typeof p.name === 'string' && p.name.trim() ? p.name.trim() : undefined,
      bridge,
    };

    const g = f.geometry;
    const lines: Pos[][] =
      g.type === 'LineString' ? [g.coordinates as Pos[]] : g.type === 'MultiLineString' ? (g.coordinates as Pos[][]) : [];
    for (const line of lines) {
      if (line.length < 2) continue;
      const pts = line.map(([x, z]) => [x, z] as Pos);
      if (reversed) pts.reverse();
      runs.push({ attrs, pts });
      stats.runs++;
    }
  }
  return runs;
}

// ---------------------------------------------------------------------------
// 2. 去掉过近的重复点（只删不与其他 way 共享的点，以免断开连接）
// ---------------------------------------------------------------------------
function dedupeRuns(runs: Run[]): number {
  const shared: Record<string, number> = {};
  for (const r of runs) for (const p of r.pts) bump(shared, keyOf(p));
  let removed = 0;
  for (const r of runs) {
    const out: Pos[] = [r.pts[0]];
    for (let i = 1; i < r.pts.length; i++) {
      const p = r.pts[i];
      const last = out[out.length - 1];
      const isLast = i === r.pts.length - 1;
      if (dist(p, last) < MIN_PT_DIST) {
        if (isLast) {
          // 末点必须保留：如果前一个保留点不是首点且不共享，就用末点替换它
          if (out.length > 1 && shared[keyOf(last)] === 1) {
            out[out.length - 1] = p;
            removed++;
          } else out.push(p);
        } else if (shared[keyOf(p)] === 1) {
          removed++;
        } else out.push(p);
        continue;
      }
      out.push(p);
    }
    r.pts = out;
  }
  return removed;
}

// ---------------------------------------------------------------------------
// 3. 节点判定：坐标 key 相同即同一节点；按度与两侧属性决定是路口 / 属性变化点 / 折进折线
// ---------------------------------------------------------------------------
interface Incidence {
  run: number;
  idx: number;
  endpoint: boolean;
}

function classifyNodes(runs: Run[]): Map<string, NodeInfo> {
  const inc = new Map<string, Incidence[]>();
  for (let ri = 0; ri < runs.length; ri++) {
    const pts = runs[ri].pts;
    for (let i = 0; i < pts.length; i++) {
      const k = keyOf(pts[i]);
      let list = inc.get(k);
      if (!list) inc.set(k, (list = []));
      list.push({ run: ri, idx: i, endpoint: i === 0 || i === pts.length - 1 });
    }
  }
  const nodes = new Map<string, NodeInfo>();
  for (const [k, list] of inc) {
    const deg = list.reduce((s, x) => s + (x.endpoint ? 1 : 2), 0);
    const pos = runs[list[0].run].pts[list[0].idx];
    if (deg !== 2) {
      nodes.set(k, { key: k, pos, junction: true }); // 死路端点或 ≥3 向路口
      continue;
    }
    if (list.length === 1) continue; // 一条 way 的普通折点
    // 两条 way 的端点相接
    const [a, b] = list;
    if (a.run === b.run) {
      nodes.set(k, { key: k, pos, junction: true }); // 闭合环的闭合点
      continue;
    }
    const ra = runs[a.run];
    const rb = runs[b.run];
    const chainable =
      (a.idx === 0) !== (b.idx === 0) || // 首尾相接，方向一致
      (!ra.attrs.oneway && ra.attrs.lanesF === ra.attrs.lanesB); // 双向且对称，可翻转
    if (attrsEqual(ra.attrs, rb.attrs) && chainable) continue; // 折进折线
    nodes.set(k, { key: k, pos, junction: false }); // 属性变化点
  }
  return nodes;
}

// ---------------------------------------------------------------------------
// 4. 在节点处把 run 切成 piece，再把折点两侧的 piece 串成 chain
// ---------------------------------------------------------------------------
function splitRuns(runs: Run[], nodes: Map<string, NodeInfo>): Piece[] {
  const pieces: Piece[] = [];
  for (const r of runs) {
    let cur: Pos[] = [r.pts[0]];
    for (let i = 1; i < r.pts.length; i++) {
      const p = r.pts[i];
      cur.push(p);
      const isLast = i === r.pts.length - 1;
      if (isLast || nodes.has(keyOf(p))) {
        pieces.push({ id: pieces.length, attrs: r.attrs, pts: cur, startKey: keyOf(cur[0]), endKey: keyOf(p) });
        cur = [p];
      }
    }
  }
  return pieces;
}

function flipPiece(p: Piece): Piece {
  return { ...p, pts: [...p.pts].reverse(), startKey: p.endKey, endKey: p.startKey };
}

function buildChains(pieces: Piece[], nodes: Map<string, NodeInfo>): Chain[] {
  const atFold = new Map<string, Piece[]>(); // 折点 key → 相接的两个 piece
  for (const p of pieces) {
    for (const k of [p.startKey, p.endKey]) {
      if (nodes.has(k)) continue;
      let l = atFold.get(k);
      if (!l) atFold.set(k, (l = []));
      l.push(p);
    }
  }
  const promote = (k: string, pos: Pos) => {
    if (!nodes.has(k)) nodes.set(k, { key: k, pos, junction: false });
  };
  const consumed = new Set<number>();
  const chains: Chain[] = [];
  for (const start of pieces) {
    if (consumed.has(start.id)) continue;
    consumed.add(start.id);
    const seq: Piece[] = [start];
    // 向前延伸
    let cur = start;
    while (!nodes.has(cur.endKey)) {
      const next = (atFold.get(cur.endKey) ?? []).find((q) => q.id !== cur.id);
      if (!next || consumed.has(next.id)) {
        promote(cur.endKey, cur.pts[cur.pts.length - 1]); // 成环或异常：就地升为节点
        break;
      }
      consumed.add(next.id);
      const o = next.startKey === cur.endKey ? next : flipPiece(next);
      seq.push(o);
      cur = o;
    }
    // 向后延伸
    cur = start;
    while (!nodes.has(cur.startKey)) {
      const prev = (atFold.get(cur.startKey) ?? []).find((q) => q.id !== cur.id);
      if (!prev || consumed.has(prev.id)) {
        promote(cur.startKey, cur.pts[0]);
        break;
      }
      consumed.add(prev.id);
      const o = prev.endKey === cur.startKey ? prev : flipPiece(prev);
      seq.unshift(o);
      cur = o;
    }
    const pts: Pos[] = [];
    for (const p of seq) {
      for (let i = pts.length ? 1 : 0; i < p.pts.length; i++) pts.push(p.pts[i]);
    }
    chains.push({ attrs: start.attrs, pts, startKey: seq[0].startKey, endKey: seq[seq.length - 1].endKey });
  }
  return chains;
}

// ---------------------------------------------------------------------------
// 5. 短边合并 + 生成有向边
// ---------------------------------------------------------------------------
class UnionFind {
  parent = new Map<string, string>();
  find(k: string): string {
    let r = k;
    while (this.parent.has(r) && this.parent.get(r) !== r) r = this.parent.get(r)!;
    // 路径压缩
    let c = k;
    while (this.parent.has(c) && this.parent.get(c) !== r) {
      const n = this.parent.get(c)!;
      this.parent.set(c, r);
      c = n;
    }
    return r;
  }
  union(a: string, b: string): void {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra !== rb) this.parent.set(rb, ra);
  }
}

interface BuiltGraph {
  nodes: GraphNodeData[];
  edges: GraphEdgeData[];
  mergedShort: number;
  droppedShort: number;
}

function buildEdges(chains: Chain[], nodeInfo: Map<string, NodeInfo>): BuiltGraph {
  // 把 <1 m 的 chain 两端节点合并
  const uf = new UnionFind();
  let mergedShort = 0;
  for (const c of chains) {
    if (polylineLength(c.pts) < MIN_EDGE_LEN && c.startKey !== c.endKey) {
      uf.union(c.startKey, c.endKey);
      mergedShort++;
    }
  }
  const nodeIdOf = new Map<string, number>();
  const nodes: GraphNodeData[] = [];
  const getNode = (key: string): number => {
    const rep = uf.find(key);
    let id = nodeIdOf.get(rep);
    if (id === undefined) {
      const info = nodeInfo.get(rep)!;
      id = nodes.length;
      nodeIdOf.set(rep, id);
      nodes.push({ id, x: r2(info.pos[0]), z: r2(info.pos[1]), junction: info.junction, signal: false, jr: 4 });
    }
    // 合并进来的节点若是路口，代表节点也算路口
    if (nodeInfo.get(key)?.junction) nodes[id].junction = true;
    return id;
  };

  const edges: GraphEdgeData[] = [];
  let droppedShort = 0;
  for (const c of chains) {
    const from = getNode(c.startKey);
    const to = getNode(c.endKey);
    const pts = c.pts.map(([x, z]) => [r2(x), r2(z)] as Pos);
    // 首尾对齐到（可能被合并过的）节点坐标
    pts[0] = [nodes[from].x, nodes[from].z];
    pts[pts.length - 1] = [nodes[to].x, nodes[to].z];
    // 对齐后再去一次重复点（不动首尾）
    const clean: Pos[] = [pts[0]];
    for (let i = 1; i < pts.length - 1; i++) if (dist(pts[i], clean[clean.length - 1]) >= MIN_PT_DIST) clean.push(pts[i]);
    if (dist(pts[pts.length - 1], clean[clean.length - 1]) < MIN_PT_DIST && clean.length > 1) clean.pop();
    clean.push(pts[pts.length - 1]);
    if (polylineLength(clean) < MIN_EDGE_LEN) {
      droppedShort++;
      continue;
    }
    const flat = clean.flat();
    const a = c.attrs;
    const base = { laneW: a.laneW, kind: a.kind, speedLimit: a.speed, crossings: [] as number[] };
    const fwd: GraphEdgeData = { id: edges.length, from, to, pts: flat, lanes: a.lanesF, ...base, oneway: a.oneway, reverse: null };
    if (a.name) fwd.name = a.name;
    if (a.bridge) fwd.bridge = true;
    edges.push(fwd);
    if (!a.oneway) {
      const rev: GraphEdgeData = {
        id: edges.length,
        from: to,
        to: from,
        pts: [...clean].reverse().flat(),
        lanes: a.lanesB,
        ...base,
        crossings: [],
        oneway: false,
        reverse: fwd.id,
      };
      if (a.name) rev.name = a.name;
      if (a.bridge) rev.bridge = true;
      fwd.reverse = rev.id;
      edges.push(rev);
    }
  }
  return { nodes, edges, mergedShort, droppedShort };
}

// ---------------------------------------------------------------------------
// 6. 最大强连通分量（Tarjan，迭代版）
// ---------------------------------------------------------------------------
function stronglyConnectedComponents(n: number, edges: GraphEdgeData[]): number[] {
  const adj: number[][] = Array.from({ length: n }, () => []);
  for (const e of edges) adj[e.from].push(e.to);
  const index = new Int32Array(n).fill(-1);
  const low = new Int32Array(n);
  const onStack = new Uint8Array(n);
  const comp = new Int32Array(n).fill(-1);
  const stack: number[] = [];
  let counter = 0;
  let compCount = 0;
  for (let s = 0; s < n; s++) {
    if (index[s] !== -1) continue;
    const work: [number, number][] = [[s, 0]];
    index[s] = low[s] = counter++;
    stack.push(s);
    onStack[s] = 1;
    while (work.length) {
      const top = work[work.length - 1];
      const [v, i] = top;
      if (i < adj[v].length) {
        top[1] = i + 1;
        const w = adj[v][i];
        if (index[w] === -1) {
          index[w] = low[w] = counter++;
          stack.push(w);
          onStack[w] = 1;
          work.push([w, 0]);
        } else if (onStack[w]) low[v] = Math.min(low[v], index[w]);
      } else {
        work.pop();
        if (work.length) {
          const u = work[work.length - 1][0];
          low[u] = Math.min(low[u], low[v]);
        }
        if (low[v] === index[v]) {
          let w: number;
          do {
            w = stack.pop()!;
            onStack[w] = 0;
            comp[w] = compCount;
          } while (w !== v);
          compCount++;
        }
      }
    }
  }
  return Array.from(comp);
}

interface SccResult {
  largestRatio: number;
  largestSize: number;
  componentCount: number;
  pruned: boolean;
  /** 裁剪策略：'largest-scc' 严格只留最大分量；'scc+attached' 另保留能到达 / 被到达的死路 */
  mode: 'none' | 'largest-scc' | 'scc+attached';
  /** 保留下来但不在最大 SCC 里的节点数（死路 / 入口段） */
  keptAttachedNodes: number;
  droppedNodes: number;
  droppedEdges: number;
}

/** 若最大 SCC 占比不足则只保留它；返回重新编号后的图 */
function pruneToLargestScc(g: BuiltGraph): { nodes: GraphNodeData[]; edges: GraphEdgeData[]; scc: SccResult } {
  const comp = stronglyConnectedComponents(g.nodes.length, g.edges);
  const sizes: Record<number, number> = {};
  for (const c of comp) sizes[c] = (sizes[c] ?? 0) + 1;
  let best = -1;
  let bestSize = 0;
  for (const [c, s] of Object.entries(sizes)) if (s > bestSize) (best = Number(c)), (bestSize = s);
  const ratio = g.nodes.length ? bestSize / g.nodes.length : 0;
  const scc: SccResult = {
    largestRatio: ratio,
    largestSize: bestSize,
    componentCount: Object.keys(sizes).length,
    pruned: false,
    mode: 'none',
    keptAttachedNodes: 0,
    droppedNodes: 0,
    droppedEdges: 0,
  };
  if (ratio >= SCC_KEEP_RATIO) return { nodes: g.nodes, edges: g.edges, scc };

  scc.pruned = true;
  const keep = new Uint8Array(g.nodes.length);
  for (let i = 0; i < comp.length; i++) if (comp[i] === best) keep[i] = 1;
  if (KEEP_WEAKLY_ATTACHED) {
    // 从最大 SCC 沿出边正向 BFS、沿入边反向 BFS，把能到达 / 被到达的节点都留下
    const out: number[][] = Array.from({ length: g.nodes.length }, () => []);
    const inn: number[][] = Array.from({ length: g.nodes.length }, () => []);
    for (const e of g.edges) (out[e.from].push(e.to), inn[e.to].push(e.from));
    for (const adj of [out, inn]) {
      const queue: number[] = [];
      for (let i = 0; i < keep.length; i++) if (comp[i] === best) queue.push(i);
      while (queue.length) {
        const v = queue.pop()!;
        for (const w of adj[v]) {
          if (keep[w]) continue;
          keep[w] = 1;
          queue.push(w);
        }
      }
    }
    scc.mode = 'scc+attached';
  } else scc.mode = 'largest-scc';
  const keepNode = (id: number) => keep[id] === 1;
  const nodeMap = new Map<number, number>();
  const nodes: GraphNodeData[] = [];
  for (const n of g.nodes) {
    if (!keepNode(n.id)) continue;
    nodeMap.set(n.id, nodes.length);
    nodes.push({ ...n, id: nodes.length });
  }
  const edgeMap = new Map<number, number>();
  const kept = g.edges.filter((e) => keepNode(e.from) && keepNode(e.to));
  kept.forEach((e, i) => edgeMap.set(e.id, i));
  const edges = kept.map((e, i) => ({
    ...e,
    id: i,
    from: nodeMap.get(e.from)!,
    to: nodeMap.get(e.to)!,
    reverse: e.reverse === null ? null : (edgeMap.get(e.reverse) ?? null),
  }));
  scc.keptAttachedNodes = nodes.length - bestSize;
  scc.droppedNodes = g.nodes.length - nodes.length;
  scc.droppedEdges = g.edges.length - edges.length;
  return { nodes, edges, scc };
}

// ---------------------------------------------------------------------------
// 7. 信号灯 / 人行横道 / 路口半径
// ---------------------------------------------------------------------------
function loadPoints(): { signals: Pos[]; crossings: Pos[] } {
  const signals: Pos[] = [];
  const crossings: Pos[] = [];
  if (fileSize(IN_POINTS) <= 0) {
    warn(`missing ${IN_POINTS}; no signals / crossings`);
    return { signals, crossings };
  }
  const fc = JSON.parse(readFileSync(IN_POINTS, 'utf8')) as { features: Feature[] };
  for (const f of fc.features) {
    const hw = f.properties?.highway;
    if (typeof hw !== 'string' || f.geometry?.type !== 'Point') continue;
    const tags = hw.split(';').map((s) => s.trim());
    const p = f.geometry.coordinates as Pos;
    if (tags.includes('traffic_signals')) signals.push([p[0], p[1]]);
    if (tags.includes('crossing')) crossings.push([p[0], p[1]]);
  }
  return { signals, crossings };
}

/** 简单均匀网格，加速最近节点 / 最近边查询 */
class Grid<T> {
  cell: number;
  map = new Map<string, T[]>();
  constructor(cell: number) {
    this.cell = cell;
  }
  k(x: number, z: number) {
    return `${Math.floor(x / this.cell)},${Math.floor(z / this.cell)}`;
  }
  insertBox(x0: number, z0: number, x1: number, z1: number, item: T) {
    const cx0 = Math.floor(x0 / this.cell), cx1 = Math.floor(x1 / this.cell);
    const cz0 = Math.floor(z0 / this.cell), cz1 = Math.floor(z1 / this.cell);
    for (let cx = cx0; cx <= cx1; cx++)
      for (let cz = cz0; cz <= cz1; cz++) {
        const key = `${cx},${cz}`;
        let l = this.map.get(key);
        if (!l) this.map.set(key, (l = []));
        l.push(item);
      }
  }
  query(x: number, z: number, r: number): Set<T> {
    const out = new Set<T>();
    const cx0 = Math.floor((x - r) / this.cell), cx1 = Math.floor((x + r) / this.cell);
    const cz0 = Math.floor((z - r) / this.cell), cz1 = Math.floor((z + r) / this.cell);
    for (let cx = cx0; cx <= cx1; cx++)
      for (let cz = cz0; cz <= cz1; cz++) for (const it of this.map.get(`${cx},${cz}`) ?? []) out.add(it);
    return out;
  }
}

function attachSignals(nodes: GraphNodeData[], signals: Pos[]): { matched: number; unmatched: number } {
  const grid = new Grid<GraphNodeData>(50);
  for (const n of nodes) if (n.junction) grid.insertBox(n.x, n.z, n.x, n.z, n);
  let matched = 0;
  let unmatched = 0;
  for (const s of signals) {
    let best: GraphNodeData | null = null;
    let bestD = SIGNAL_RADIUS;
    for (const n of grid.query(s[0], s[1], SIGNAL_RADIUS)) {
      const d = Math.hypot(n.x - s[0], n.z - s[1]);
      if (d <= bestD) (bestD = d), (best = n);
    }
    if (best) {
      best.signal = true;
      matched++;
    } else unmatched++;
  }
  return { matched, unmatched };
}

/** 点到线段的最近距离与弧长参数 */
function projectToSegment(p: Pos, a: Pos, b: Pos): { d: number; t: number } {
  const dx = b[0] - a[0];
  const dz = b[1] - a[1];
  const len2 = dx * dx + dz * dz;
  let t = len2 > 0 ? ((p[0] - a[0]) * dx + (p[1] - a[1]) * dz) / len2 : 0;
  t = Math.max(0, Math.min(1, t));
  const qx = a[0] + t * dx;
  const qz = a[1] + t * dz;
  return { d: Math.hypot(p[0] - qx, p[1] - qz), t: t * Math.sqrt(len2) };
}

function attachCrossings(edges: GraphEdgeData[], crossings: Pos[]): { matched: number; unmatched: number } {
  // 只索引每对双向边中的一条（反向边共享几何）
  const grid = new Grid<GraphEdgeData>(50);
  for (const e of edges) {
    if (e.reverse !== null && e.reverse < e.id) continue;
    let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity;
    for (let i = 0; i < e.pts.length; i += 2) {
      x0 = Math.min(x0, e.pts[i]); x1 = Math.max(x1, e.pts[i]);
      z0 = Math.min(z0, e.pts[i + 1]); z1 = Math.max(z1, e.pts[i + 1]);
    }
    grid.insertBox(x0 - CROSSING_RADIUS, z0 - CROSSING_RADIUS, x1 + CROSSING_RADIUS, z1 + CROSSING_RADIUS, e);
  }
  const lengthOf = (e: GraphEdgeData) => {
    let s = 0;
    for (let i = 2; i < e.pts.length; i += 2) s += Math.hypot(e.pts[i] - e.pts[i - 2], e.pts[i + 1] - e.pts[i - 1]);
    return s;
  };
  let matched = 0;
  let unmatched = 0;
  for (const c of crossings) {
    let best: GraphEdgeData | null = null;
    let bestD = CROSSING_RADIUS;
    let bestT = 0;
    for (const e of grid.query(c[0], c[1], 0)) {
      let acc = 0;
      for (let i = 2; i < e.pts.length; i += 2) {
        const a: Pos = [e.pts[i - 2], e.pts[i - 1]];
        const b: Pos = [e.pts[i], e.pts[i + 1]];
        const { d, t } = projectToSegment(c, a, b);
        if (d <= bestD) (bestD = d), (best = e), (bestT = acc + t);
        acc += dist(a, b);
      }
    }
    if (!best) {
      unmatched++;
      continue;
    }
    matched++;
    const L = lengthOf(best);
    best.crossings.push(r2(Math.min(L, bestT)));
    if (best.reverse !== null) edges[best.reverse].crossings.push(r2(Math.max(0, L - bestT)));
  }
  for (const e of edges) e.crossings.sort((a, b) => a - b);
  return { matched, unmatched };
}

function computeJunctionRadius(nodes: GraphNodeData[], edges: GraphEdgeData[]): void {
  const half = new Float64Array(nodes.length);
  for (const e of edges) {
    let width = e.lanes * e.laneW;
    if (e.reverse !== null) width += edges[e.reverse].lanes * e.laneW;
    const h = width / 2;
    if (h > half[e.from]) half[e.from] = h;
    if (h > half[e.to]) half[e.to] = h;
  }
  for (const n of nodes) n.jr = r2(Math.max(4, half[n.id] + 1));
}

// ---------------------------------------------------------------------------
// 8. 调试 SVG
// ---------------------------------------------------------------------------
const SVG_STYLE: Record<RoadKind, { color: string; width: number }> = {
  expressway: { color: '#c0392b', width: 7 },
  trunk: { color: '#e67e22', width: 6 },
  primary: { color: '#d4a017', width: 5 },
  secondary: { color: '#27ae60', width: 4 },
  tertiary: { color: '#2980b9', width: 3 },
  residential: { color: '#7f8c8d', width: 2 },
  service: { color: '#c7ccd1', width: 1.2 },
};

function writeSvg(g: GraphData): void {
  const { minX, maxX, minZ, maxZ } = LOCAL_BBOX;
  const W = maxX - minX;
  const H = maxZ - minZ;
  const f1 = (v: number) => v.toFixed(1);
  const parts: string[] = [];
  parts.push(`<?xml version="1.0" encoding="UTF-8"?>`);
  parts.push(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${f1(minX)} ${f1(minZ)} ${f1(W)} ${f1(H)}" width="${Math.round(W)}" height="${Math.round(H)}">`,
  );
  parts.push(`<rect x="${f1(minX)}" y="${f1(minZ)}" width="${f1(W)}" height="${f1(H)}" fill="#fafafa"/>`);
  // 边：由细到粗（service 先画，expressway 最后画在上层）
  for (const kind of [...KINDS].reverse()) {
    const st = SVG_STYLE[kind];
    parts.push(`<g stroke="${st.color}" stroke-width="${st.width}" fill="none" stroke-linecap="round" stroke-linejoin="round">`);
    for (const e of g.edges) {
      if (e.kind !== kind) continue;
      if (e.reverse !== null && e.reverse < e.id) continue; // 双向只画一次
      const pts: string[] = [];
      for (let i = 0; i < e.pts.length; i += 2) pts.push(`${f1(e.pts[i])},${f1(e.pts[i + 1])}`);
      const title = `${e.id} ${e.name ?? ''} ${kind} ${e.oneway ? '单向' : '双向'} ${e.lanes}${e.reverse !== null ? '+' + g.edges[e.reverse].lanes : ''}车道 ${e.speedLimit}km/h`;
      parts.push(`<polyline points="${pts.join(' ')}"${e.oneway ? ' stroke-dasharray="12 4"' : ''}><title>${escapeXml(title)}</title></polyline>`);
    }
    parts.push('</g>');
  }
  // 人行横道：小黑点
  parts.push('<g fill="#222">');
  for (const e of g.edges) {
    if (e.reverse !== null && e.reverse < e.id) continue;
    for (const t of e.crossings) {
      const p = pointAt(e.pts, t);
      parts.push(`<circle cx="${f1(p[0])}" cy="${f1(p[1])}" r="1.2"/>`);
    }
  }
  parts.push('</g>');
  // 节点：属性变化点浅蓝、路口深色、信号灯红
  parts.push('<g fill="#5dade2">');
  for (const n of g.nodes) if (!n.junction) parts.push(`<circle cx="${f1(n.x)}" cy="${f1(n.z)}" r="1"/>`);
  parts.push('</g><g fill="#1b2631">');
  for (const n of g.nodes) if (n.junction && !n.signal) parts.push(`<circle cx="${f1(n.x)}" cy="${f1(n.z)}" r="1.6"><title>${n.id} jr=${n.jr}</title></circle>`);
  parts.push('</g><g fill="#ff0000" stroke="#fff" stroke-width="0.6">');
  for (const n of g.nodes) if (n.signal) parts.push(`<circle cx="${f1(n.x)}" cy="${f1(n.z)}" r="3.5"><title>${n.id} signal jr=${n.jr}</title></circle>`);
  parts.push('</g>');
  // 主干道路名标签（primary 及以上，只标最长的一条边）
  const labelled = new Map<string, GraphEdgeData>();
  for (const e of g.edges) {
    if (!e.name || (e.kind !== 'expressway' && e.kind !== 'trunk' && e.kind !== 'primary')) continue;
    const prev = labelled.get(e.name);
    if (!prev || e.pts.length > prev.pts.length) labelled.set(e.name, e);
  }
  parts.push('<g font-family="Helvetica, Arial, sans-serif" font-size="11" fill="#333" text-anchor="middle">');
  for (const [name, e] of labelled) {
    const mid = pointAt(e.pts, edgeLength(e.pts) / 2);
    parts.push(`<text x="${f1(mid[0])}" y="${f1(mid[1] - 4)}">${escapeXml(name)}</text>`);
  }
  parts.push('</g>');
  // 图例
  parts.push(`<g transform="translate(${f1(minX + 12)} ${f1(minZ + 12)})" font-family="Helvetica, Arial, sans-serif" font-size="12">`);
  parts.push(`<rect x="0" y="0" width="150" height="${KINDS.length * 16 + 40}" fill="#fff" fill-opacity="0.9" stroke="#999"/>`);
  KINDS.forEach((k, i) => {
    const st = SVG_STYLE[k];
    parts.push(`<line x1="8" y1="${14 + i * 16}" x2="40" y2="${14 + i * 16}" stroke="${st.color}" stroke-width="${st.width}"/>`);
    parts.push(`<text x="48" y="${18 + i * 16}" fill="#333">${k}</text>`);
  });
  const y0 = KINDS.length * 16 + 18;
  parts.push(`<circle cx="14" cy="${y0}" r="3.5" fill="#f00"/><text x="24" y="${y0 + 4}" fill="#333">signal</text>`);
  parts.push(`<text x="70" y="${y0 + 4}" fill="#333">虚线 = 单向</text>`);
  parts.push('</g>');
  parts.push('</svg>');
  writeFileSync(OUT_SVG, parts.join('\n'));
}

function escapeXml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
function edgeLength(flat: number[]): number {
  let s = 0;
  for (let i = 2; i < flat.length; i += 2) s += Math.hypot(flat[i] - flat[i - 2], flat[i + 1] - flat[i - 1]);
  return s;
}
/** 沿折线弧长 t 处的点 */
function pointAt(flat: number[], t: number): Pos {
  let acc = 0;
  for (let i = 2; i < flat.length; i += 2) {
    const seg = Math.hypot(flat[i] - flat[i - 2], flat[i + 1] - flat[i - 1]);
    if (acc + seg >= t && seg > 0) {
      const u = (t - acc) / seg;
      return [flat[i - 2] + u * (flat[i] - flat[i - 2]), flat[i - 1] + u * (flat[i + 1] - flat[i - 1])];
    }
    acc += seg;
  }
  return [flat[flat.length - 2], flat[flat.length - 1]];
}

// ---------------------------------------------------------------------------
// 9. 自检：输出前断言数据结构一致
// ---------------------------------------------------------------------------
function verify(g: GraphData): void {
  const assert = (cond: boolean, msg: string) => {
    if (!cond) throw new Error(`graph verify failed: ${msg}`);
  };
  g.nodes.forEach((n, i) => assert(n.id === i, `node id ${n.id} != ${i}`));
  g.edges.forEach((e, i) => {
    assert(e.id === i, `edge id ${e.id} != ${i}`);
    assert(e.from >= 0 && e.from < g.nodes.length, `edge ${i} from`);
    assert(e.to >= 0 && e.to < g.nodes.length, `edge ${i} to`);
    assert(e.pts.length >= 4 && e.pts.length % 2 === 0, `edge ${i} pts`);
    const a = g.nodes[e.from];
    const b = g.nodes[e.to];
    assert(e.pts[0] === a.x && e.pts[1] === a.z, `edge ${i} first pt != from node`);
    assert(e.pts[e.pts.length - 2] === b.x && e.pts[e.pts.length - 1] === b.z, `edge ${i} last pt != to node`);
    assert(edgeLength(e.pts) >= MIN_EDGE_LEN, `edge ${i} length < ${MIN_EDGE_LEN}`);
    assert(e.lanes >= 1, `edge ${i} lanes`);
    if (e.reverse === null) assert(e.oneway, `edge ${i} no reverse but not oneway`);
    else {
      const r = g.edges[e.reverse];
      assert(!!r && r.reverse === e.id, `edge ${i} reverse not symmetric`);
      assert(r.from === e.to && r.to === e.from, `edge ${i} reverse endpoints`);
      assert(!e.oneway && !r.oneway, `edge ${i} reverse but oneway`);
    }
  });
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------
function main(): void {
  if (fileSize(IN_LINES) <= 0) {
    console.error(`missing ${IN_LINES}; run npm run geo:project first`);
    process.exit(1);
  }
  ensureDir(DEBUG_DIR);
  const fc = JSON.parse(readFileSync(IN_LINES, 'utf8')) as { features: Feature[] };
  const parseStats: ParseStats = { waysByHighway: {}, ignoredHighway: {}, droppedTunnel: 0, droppedLayer: 0, runs: 0 };
  const runs = parseWays(fc.features, parseStats);
  const removedPts = dedupeRuns(runs);
  log(`ways: ${fc.features.length} features → ${parseStats.runs} drivable runs (dropped tunnel ${parseStats.droppedTunnel}, layer≤-1 ${parseStats.droppedLayer}); removed ${removedPts} near-duplicate points`);

  const nodeInfo = classifyNodes(runs);
  const pieces = splitRuns(runs, nodeInfo);
  const chains = buildChains(pieces, nodeInfo);
  log(`nodes classified: ${nodeInfo.size}, pieces ${pieces.length} → chains ${chains.length}`);

  const built = buildEdges(chains, nodeInfo);
  log(`edges built: ${built.edges.length} (nodes ${built.nodes.length}; short edges merged ${built.mergedShort}, dropped ${built.droppedShort})`);

  const { nodes, edges, scc } = pruneToLargestScc(built);
  log(
    `largest SCC: ${scc.largestSize}/${built.nodes.length} = ${(scc.largestRatio * 100).toFixed(1)}% in ${scc.componentCount} components` +
      (scc.pruned ? `; ${scc.mode}: kept ${scc.keptAttachedNodes} attached nodes, pruned ${scc.droppedNodes} nodes / ${scc.droppedEdges} edges` : ''),
  );

  const { signals, crossings } = loadPoints();
  const sig = attachSignals(nodes, signals);
  const cro = attachCrossings(edges, crossings);
  computeJunctionRadius(nodes, edges);
  log(`signals: ${sig.matched}/${signals.length} matched to junctions; crossings: ${cro.matched}/${crossings.length} projected onto edges`);

  const graph: GraphData = { nodes, edges };
  verify(graph);
  writeFileSync(OUT_GRAPH, JSON.stringify(graph));
  writeSvg(graph);

  // 统计
  const inDeg = new Int32Array(nodes.length);
  const outDeg = new Int32Array(nodes.length);
  for (const e of edges) (outDeg[e.from]++, inDeg[e.to]++);
  let deadEnds = 0; // 只进不出或只出不进：切片边界截断的单向路等
  let culDeSacs = 0; // 双向断头路（可掉头）
  for (const n of nodes) {
    if (inDeg[n.id] === 0 || outDeg[n.id] === 0) deadEnds++;
    else if (inDeg[n.id] === 1 && outDeg[n.id] === 1 && edges.find((e) => e.from === n.id)?.reverse !== null) {
      const out = edges.find((e) => e.from === n.id)!;
      if (edges[out.reverse!].from === out.to && inDeg[n.id] === 1) culDeSacs++;
    }
  }
  const byKind: Record<string, { edges: number; lengthM: number }> = {};
  for (const k of KINDS) byKind[k] = { edges: 0, lengthM: 0 };
  let totalLen = 0;
  let crossingCount = 0;
  for (const e of edges) {
    const L = edgeLength(e.pts);
    byKind[e.kind].edges++;
    byKind[e.kind].lengthM += L;
    totalLen += L;
    crossingCount += e.crossings.length;
  }
  for (const k of KINDS) byKind[k].lengthM = Math.round(byKind[k].lengthM);
  const stats = {
    generated: new Date().toISOString(),
    input: {
      lineFeatures: fc.features.length,
      drivableWays: parseStats.waysByHighway,
      ignoredHighway: parseStats.ignoredHighway,
      droppedTunnel: parseStats.droppedTunnel,
      droppedLayerBelowZero: parseStats.droppedLayer,
      runs: parseStats.runs,
      removedNearDuplicatePoints: removedPts,
      signalPoints: signals.length,
      crossingPoints: crossings.length,
    },
    nodes: nodes.length,
    junctions: nodes.filter((n) => n.junction).length,
    attributeChangeNodes: nodes.filter((n) => !n.junction).length,
    signalNodes: nodes.filter((n) => n.signal).length,
    signalsUnmatched: sig.unmatched,
    edges: edges.length,
    onewayEdges: edges.filter((e) => e.oneway).length,
    bridgeEdges: edges.filter((e) => e.bridge).length,
    totalLengthM: Math.round(totalLen),
    byKind,
    crossings: crossingCount,
    crossingsUnmatched: cro.unmatched,
    shortEdgesMerged: built.mergedShort,
    shortEdgesDropped: built.droppedShort,
    scc,
    deadEnds,
    culDeSacs,
    graphJsonBytes: fileSize(OUT_GRAPH),
    svgBytes: fileSize(OUT_SVG),
  };
  writeFileSync(OUT_STATS, JSON.stringify(stats, null, 2));
  log(`\nnodes ${nodes.length} (junction ${stats.junctions}, signal ${stats.signalNodes})  edges ${edges.length} (oneway ${stats.onewayEdges})  total ${(totalLen / 1000).toFixed(1)} km`);
  for (const k of KINDS) log(`  ${k.padEnd(12)} ${String(byKind[k].edges).padStart(5)} edges  ${(byKind[k].lengthM / 1000).toFixed(2).padStart(7)} km`);
  log(`crossings ${crossingCount}  dead ends ${deadEnds}  cul-de-sacs ${culDeSacs}`);
  log(`wrote ${OUT_GRAPH} (${fmtBytes(stats.graphJsonBytes)}), ${OUT_SVG} (${fmtBytes(stats.svgBytes)}), ${OUT_STATS}`);
}

main();
