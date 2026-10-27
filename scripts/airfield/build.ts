// 机场套件模型打包（AIR.1）：threejsassets「Airfield」套件（Free Commercial License，Draco 压缩 GLB）
// → public/assets/airfield/airfield.glb（无 Draco）+ LICENSE-threejsassets.txt
//
// 用法：npm run airfield:build                     打包
//       node scripts/airfield/build.ts --inspect   只打印每个源模型的节点树 / 包围盒 / 三角数 / 顶点色调色板（面积占比），用来定下方 MODELS 配置
//
// data/assets-eval/ 是不可信下载目录：这里只按路径读取 GLB，不执行其中任何东西。
//
// ── --inspect 结论（2026-10-27，写进配置的依据）────────────────────────────────────────────
// · 22 个文件结构一致：1 节点 / 1 mesh / 1 primitive，属性 POSITION+NORMAL+COLOR_0(float VEC3)，共用材质 "lowpoly"，
//   无纹理、无 UV、无 emissive（emissiveFactor 全 0）、无动画。节点 translation = (≈0, −h/2, ≈0)，烘焙后包围盒以原点为中心
//   （与套件说明「底部中心在 y=0」不符），所以每个模型都要自己归原点。
// · 法线基本是逐面的（焊接 位置+色+法线 后顶点数≈原始），即硬边低多边形风格。
// · 夜间发光没有 emissive，只能按调色板认：#e2c66f（暖黄，塔台/机库/风向袋/飞机的灯）、#80aebe/#80adbe/#315867/#345c6c（玻璃）、
//   #87100b/#860f0b（顶部障碍灯、红色航行灯）、#14571b（绿色航行灯）、#11366f（滑行道蓝灯灯罩）、
//   #be5c0c+#d0d8de（跑道边灯：琥珀/白半罩）、标牌：等待线红底 #880f09/#780d07 + 白字 #cfd8de、背面黄字 #be5c0c；
//   位置标牌黄字 #be5c0c、黄底板 #ca790b/#be7a0b。都写进 glow 列表（逐通道容差 1/255）→ _GLOW=1。
// · Cessna：翼展 4.01 m（x）、长 3.80 m（z）、高 1.70 m，是缩小的风格化比例 → 按翼展缩放到 11 m（×2.743）。
//   机头朝 +Z（红色桨毂在 z=+1.67…1.90；+X 翼尖红灯、−X 翼尖绿灯，机头朝 +Z 时 −X 正是右翼 → 航行灯规则吻合），不用转。
//   螺旋桨不是独立节点，但位置焊接后是独立连通分量：桨毂（t192）+ 两片桨叶（各 t132，黑色带黄尖）+ 背板圆盘（t64）；
//   缩放后桨叶半径 1.45 m（风格化大桨），所以半径上限放宽到 1.6 m（原定 1.1 m 会漏掉桨叶）；机头两侧进气口（不跨桨轴、半径 <0.8 m）留在机身。
//   主轮在 x=±0.6、z≈0，前轮在 z≈1.37。漆面：白色机身（#dbdfe3 等）+ 深蓝腰线（#0c275e 一族，色相≈221°，含尾翼蓝条）
//   + 细红线（#80–89 0e–0f 09）。面积最大的饱和色族是深蓝 → _PAINT=1。
// · 塔台：3.43 × 10.60 × 3.43 m → 按高 30 m 缩放（×2.830，足迹 9.7 m，Airfield.ts TOWER.size=9）。玻璃舱在源坐标 y≈1.5…2.9。
// · 机库：8.04 × 5.11 × 7.27 m（x 宽、z 深），门朝 +Z（正面有门楣编号牌、红白防撞桩）。目标 HANGAR = 30 × 12 × 25：
//   宽度对齐 ×3.731 后为 30.0 × 19.1 × 27.1 m —— 高度比目标高 59%，按要求按宽度对齐并在汇报里说明。
// · 拖车 1.29 × 1.45 × 2.66 m：按长 3 m 修正（×1.128）。轮挡 / 铁丝网（4.17 m 一段，高 1.62 m）/ 杨树（高 4.68 m）/
//   风向袋（高 4.36 m）/ 标牌 / 灯具：保持原比例。
// · 地面砖块：4 × 4 m 模块，厚 0.18–0.37 m（下面有一层土色底座），只有顶点色、无 UV；原点放底面中心，extras.surfaceY 给出铺面高度。
// · clear-day-dome（5.2 m 的天空小球）不打包：游戏已有 Sky.js。
// · 体积：22 个模型原始约 30 万顶点 / 12.7 万三角，float 无压缩要 10 MB+。处理：焊接 → 重型模型按顶点色加权简化
//   （meshopt simplifyWithAttributes，杨树 / 机库 / 拖车 / 铁丝网等）→ EXT_meshopt_compression + KHR_mesh_quantization。
//   运行时要 GLTFLoader.setMeshoptDecoder（three 自带 meshopt_decoder.module.js，几 KB，不是 Draco）。
import { mkdirSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Document, Logger, NodeIO } from '@gltf-transform/core';
import { EXTMeshoptCompression, KHRMeshQuantization } from '@gltf-transform/extensions';
import { meshopt, weld } from '@gltf-transform/functions';
// 编码器来自 meshoptimizer 包（@types/three 的依赖，已在 node_modules 顶层）；简化器用 three 自带的同版本 wasm 模块
import { MeshoptEncoder } from 'meshoptimizer';
import { MeshoptSimplifier } from 'three/examples/jsm/libs/meshopt_simplifier.module.js';
import { type Baked, bake, dracoIO, merge, PROJECT_ROOT, THREEJSASSETS_LICENSE_HEAD } from '../lib/glb.ts';

/** 不可信下载目录：只以路径读取 */
const SRC_DIR = resolve(PROJECT_ROOT, 'data/assets-eval/threejsassets/airfield');
const OUT_DIR = resolve(PROJECT_ROOT, 'public/assets/airfield');
const OUT_GLB = resolve(OUT_DIR, 'airfield.glb');
const OUT_LICENSE = resolve(OUT_DIR, 'LICENSE-threejsassets.txt');
const SIZE_BUDGET = 1.5 * 1024 * 1024;
const URL_BASE = 'https://threejsassets.com/assets/';

const log = (msg: string): void => console.log(`[airfield:build] ${msg}`);

// ───────────────────────────── 配置 ─────────────────────────────

type Axis = 'x' | 'y' | 'z';
interface SplitCfg {
  /** 子节点 id（节点名 prop:<id>，extras.id=<id>） */
  id: string;
  /** 只在机头最前端这一段（输出单位 m）里找分量 */
  frontSlab: number;
  /** 分量最大半径上限（绕纵轴，m）；超过的不算螺旋桨 */
  maxRadius: number;
  /** 不跨过轴心的分量，半径要超过它才算桨叶（排除机头进气口之类的小件） */
  bladeMinRadius: number;
}
interface ModelCfg {
  id: string;
  file: string;
  /** 原点：base = 底部（y 最低归 0）+ 最底一层顶点的 xz 中心；gear = y 最低归 0 + 主轮（|x|>gearMinAbsX 的最底层顶点）xz 中心 */
  origin: 'base' | 'gear';
  /** 均匀缩放，使该轴尺寸 = size（m） */
  scaleTo?: { axis: Axis; size: number };
  /** 绕 Y 转多少（弧度）让正面朝 +Z；全部模型源文件都已是 +Z 前，留作开关 */
  yaw?: number;
  split?: SplitCfg;
  /** 夜间发光的顶点色（源文件 sRGB 十六进制，按 0–255 逐通道容差 1） */
  glowColors?: string[];
  /** 自动找漆面条纹色族 → _PAINT */
  paint?: boolean;
  /** 简化：目标三角形比例 ratio、相对误差上限 error（默认 0.002，0.005 时机库顶部会被削掉 0.2 m）；permissive 允许跨颜色接缝塌边（杨树叶团逐面随机绿色时才用） */
  simplify?: { ratio: number; error?: number; permissive?: boolean };
  /** 地面砖块：报告铺面高度 */
  tile?: boolean;
  kind: 'aircraft' | 'building' | 'vehicle' | 'prop' | 'sign' | 'light' | 'tile' | 'vegetation';
}

const LAMP = '#e2c66f';
const MODELS: ModelCfg[] = [
  {
    id: 'light-aircraft-cessna', file: 'light-aircraft-cessna.glb', kind: 'aircraft', origin: 'gear', scaleTo: { axis: 'x', size: 11 },
    split: { id: 'cessna-prop', frontSlab: 0.85, maxRadius: 1.6, bladeMinRadius: 0.8 },
    glowColors: ['#e2c56f', '#870f0b', '#14571b'], paint: true,
  },
  { id: 'control-tower', file: 'control-tower.glb', kind: 'building', origin: 'base', scaleTo: { axis: 'y', size: 30 }, glowColors: ['#80aebe', '#315867', '#345c6c', LAMP, '#87100b'] },
  { id: 'hangar', file: 'hangar.glb', kind: 'building', origin: 'base', scaleTo: { axis: 'x', size: 30 }, glowColors: ['#80adbe', LAMP], simplify: { ratio: 0.45 } },
  { id: 'windsock', file: 'windsock.glb', kind: 'prop', origin: 'base', glowColors: [LAMP, '#860f0b'], simplify: { ratio: 0.6 } },
  { id: 'pushback-tug', file: 'pushback-tug.glb', kind: 'vehicle', origin: 'base', scaleTo: { axis: 'z', size: 3 }, simplify: { ratio: 0.35 } },
  { id: 'wheel-chocks', file: 'wheel-chocks.glb', kind: 'prop', origin: 'base', simplify: { ratio: 0.5 } },
  { id: 'chain-link-fence', file: 'chain-link-fence.glb', kind: 'prop', origin: 'base', simplify: { ratio: 0.4 } },
  { id: 'windbreak-poplar', file: 'windbreak-poplar.glb', kind: 'vegetation', origin: 'base', simplify: { ratio: 0.15, error: 0.05, permissive: true } },
  { id: 'hold-short-sign', file: 'hold-short-sign.glb', kind: 'sign', origin: 'base', glowColors: ['#880f09', '#780d07', '#cfd8de', '#be5c0c'] },
  { id: 'taxiway-loc-sign', file: 'taxiway-loc-sign.glb', kind: 'sign', origin: 'base', glowColors: ['#be5c0c', '#ca790b', '#be7a0b'] },
  { id: 'runway-edge-light', file: 'runway-edge-light.glb', kind: 'light', origin: 'base', glowColors: ['#be5c0c', '#d0d8de'] },
  { id: 'taxiway-blue-light', file: 'taxiway-blue-light.glb', kind: 'light', origin: 'base', glowColors: ['#11366f'] },
  { id: 'road-runway', file: 'road-runway.glb', kind: 'tile', origin: 'base', tile: true },
  { id: 'road-runway-threshold', file: 'road-runway-threshold.glb', kind: 'tile', origin: 'base', tile: true },
  { id: 'road-taxiway-straight', file: 'road-taxiway-straight.glb', kind: 'tile', origin: 'base', tile: true },
  { id: 'road-taxiway-corner', file: 'road-taxiway-corner.glb', kind: 'tile', origin: 'base', tile: true },
  { id: 'road-taxiway-t', file: 'road-taxiway-t.glb', kind: 'tile', origin: 'base', tile: true },
  { id: 'road-taxiway-4way', file: 'road-taxiway-4way.glb', kind: 'tile', origin: 'base', tile: true },
  { id: 'road-apron-tile', file: 'road-apron-tile.glb', kind: 'tile', origin: 'base', tile: true },
  { id: 'tarmac-tile', file: 'tarmac-tile.glb', kind: 'tile', origin: 'base', tile: true },
  { id: 'airfield-grass-tile', file: 'airfield-grass-tile.glb', kind: 'tile', origin: 'base', tile: true },
];
/** 下载了但不打包的 */
const SKIPPED = [{ id: 'clear-day-dome', file: 'clear-day-dome.glb', why: '天空小球，游戏已有 Sky.js' }];

// ───────────────────────────── 工具 ─────────────────────────────

const AX: Record<Axis, number> = { x: 0, y: 1, z: 2 };
const byte = (c: number): number => Math.round(Math.min(1, Math.max(0, c)) * 255);
const hexOf = (col: Float32Array, i: number): string => '#' + [0, 1, 2].map((a) => byte(col[i * 3 + a]).toString(16).padStart(2, '0')).join('');
const parseHex = (h: string): number[] => [1, 3, 5].map((o) => parseInt(h.slice(o, o + 2), 16));
const f2 = (a: ArrayLike<number>): string => Array.from(a, (x) => x.toFixed(2)).join(' × ');

function bbox(pos: Float32Array): { lo: number[]; hi: number[]; size: number[] } {
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (let k = 0; k < pos.length; k += 3) for (let a = 0; a < 3; a++) { lo[a] = Math.min(lo[a], pos[k + a]); hi[a] = Math.max(hi[a], pos[k + a]) }
  return { lo, hi, size: hi.map((h, a) => h - lo[a]) };
}

function hsv(r: number, g: number, b: number): { h: number; s: number; v: number } {
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
  let h = 0;
  if (d > 0) h = mx === r ? ((g - b) / d + 6) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return { h: h * 60, s: mx ? d / mx : 0, v: mx };
}

function triArea(pos: Float32Array, i: number, j: number, k: number): number {
  const ax = pos[j * 3] - pos[i * 3], ay = pos[j * 3 + 1] - pos[i * 3 + 1], az = pos[j * 3 + 2] - pos[i * 3 + 2];
  const bx = pos[k * 3] - pos[i * 3], by = pos[k * 3 + 1] - pos[i * 3 + 1], bz = pos[k * 3 + 2] - pos[i * 3 + 2];
  return Math.hypot(ay * bz - az * by, az * bx - ax * bz, ax * by - ay * bx) / 2;
}

/** 带掩码的几何（_GLOW / _PAINT 为逐顶点 0/1） */
interface Geo extends Baked { idx: Uint32Array; glow: Uint8Array; paint: Uint8Array }

/** 按三角形子集抽出一份紧凑几何 */
function subset(g: Geo, tris: number[]): Geo {
  const remap = new Map<number, number>();
  const idx = new Uint32Array(tris.length * 3);
  tris.forEach((t, n) => { for (let c = 0; c < 3; c++) { const v = g.idx[t * 3 + c]; if (!remap.has(v)) remap.set(v, remap.size); idx[n * 3 + c] = remap.get(v)! } });
  const m = remap.size;
  const out: Geo = { pos: new Float32Array(m * 3), nrm: new Float32Array(m * 3), col: new Float32Array(m * 3), idx, glow: new Uint8Array(m), paint: new Uint8Array(m) };
  for (const [s, d] of remap) {
    for (let a = 0; a < 3; a++) { out.pos[d * 3 + a] = g.pos[s * 3 + a]; out.nrm[d * 3 + a] = g.nrm[s * 3 + a]; out.col[d * 3 + a] = g.col[s * 3 + a] }
    out.glow[d] = g.glow[s]; out.paint[d] = g.paint[s];
  }
  return out;
}

/** 位置焊接后的三角形连通分量 */
function components(g: Geo): number[][] {
  const key = new Map<string, number>(), vid = new Int32Array(g.pos.length / 3);
  for (let k = 0; k < vid.length; k++) {
    const s = `${Math.round(g.pos[k * 3] * 1e4)},${Math.round(g.pos[k * 3 + 1] * 1e4)},${Math.round(g.pos[k * 3 + 2] * 1e4)}`;
    if (!key.has(s)) key.set(s, key.size);
    vid[k] = key.get(s)!;
  }
  const par = Array.from({ length: key.size }, (_, i) => i);
  const find = (x: number): number => { while (par[x] !== x) { par[x] = par[par[x]]; x = par[x] } return x };
  for (let t = 0; t < g.idx.length; t += 3) {
    const a = find(vid[g.idx[t]]);
    par[find(vid[g.idx[t + 1]])] = a; par[find(vid[g.idx[t + 2]])] = a;
  }
  const comp = new Map<number, number[]>();
  for (let t = 0; t < g.idx.length / 3; t++) { const r = find(vid[g.idx[t * 3]]); (comp.get(r) ?? comp.set(r, []).get(r)!).push(t) }
  return [...comp.values()];
}

/** 螺旋桨拆分：机头最前端一段里、跨过桨轴或半径够大的分量（坐标已是输出单位，机头朝 +Z） */
function splitProp(g: Geo, cfg: SplitCfg): { body: Geo; prop: Geo; hub: number[]; comps: string[] } | null {
  const comps = components(g).map((tris) => {
    const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
    for (const t of tris) for (let c = 0; c < 3; c++) { const v = g.idx[t * 3 + c]; for (let a = 0; a < 3; a++) { lo[a] = Math.min(lo[a], g.pos[v * 3 + a]); hi[a] = Math.max(hi[a], g.pos[v * 3 + a]) } }
    return { tris, lo, hi };
  });
  const zMax = Math.max(...comps.map((c) => c.hi[2]));
  const tip = comps.find((c) => c.hi[2] === zMax)!;
  const ax = (tip.lo[0] + tip.hi[0]) / 2, ay = (tip.lo[1] + tip.hi[1]) / 2;
  const picked = comps.filter((c) => {
    if (c.lo[2] < zMax - cfg.frontSlab) return false;
    const r = Math.max(...[c.lo[0] - ax, c.hi[0] - ax].flatMap((dx) => [c.lo[1] - ay, c.hi[1] - ay].map((dy) => Math.hypot(dx, dy))));
    if (r > cfg.maxRadius) return false;
    const crossesAxis = c.lo[0] <= ax && c.hi[0] >= ax && c.lo[1] <= ay && c.hi[1] >= ay;
    return crossesAxis || r >= cfg.bladeMinRadius;
  });
  if (!picked.length) return null;
  const propTris = new Set(picked.flatMap((c) => c.tris));
  const prop = subset(g, [...propTris]);
  const body = subset(g, Array.from({ length: g.idx.length / 3 }, (_, t) => t).filter((t) => !propTris.has(t)));
  const pb = bbox(prop.pos);
  const hub = [ax, ay, (pb.lo[2] + pb.hi[2]) / 2];
  for (let k = 0; k < prop.pos.length; k += 3) for (let a = 0; a < 3; a++) prop.pos[k + a] -= hub[a];
  return { body, prop, hub, comps: picked.map((c) => `t${c.tris.length}[r≤${Math.max(c.hi[0] - ax, ax - c.lo[0], c.hi[1] - ay, ay - c.lo[1]).toFixed(2)}]`) };
}

/** 按顶点色加权简化（meshopt simplifyWithAttributes），再展开成逐面顶点 + 平面法线（与源文件的硬边风格一致） */
function simplifyGeo(g: Geo, opt: NonNullable<ModelCfg['simplify']>): Geo {
  // 先按 位置+颜色+掩码 焊接（忽略法线），否则逐面法线会让每条边都成为接缝、简化不动
  const key = new Map<string, number>(), remap = new Uint32Array(g.pos.length / 3);
  for (let k = 0; k < remap.length; k++) {
    const s = `${g.pos[k * 3]},${g.pos[k * 3 + 1]},${g.pos[k * 3 + 2]},${hexOf(g.col, k)},${g.glow[k]},${g.paint[k]}`;
    if (!key.has(s)) key.set(s, key.size);
    remap[k] = key.get(s)!;
  }
  const n = key.size, pos = new Float32Array(n * 3), attr = new Float32Array(n * 3);
  const glow = new Uint8Array(n), paint = new Uint8Array(n), col = new Float32Array(n * 3);
  for (let k = 0; k < remap.length; k++) {
    const d = remap[k];
    for (let a = 0; a < 3; a++) { pos[d * 3 + a] = g.pos[k * 3 + a]; col[d * 3 + a] = g.col[k * 3 + a]; attr[d * 3 + a] = g.col[k * 3 + a] }
    glow[d] = g.glow[k]; paint[d] = g.paint[k];
  }
  const idx = Uint32Array.from(g.idx, (v) => remap[v]);
  const target = Math.floor((idx.length / 3) * opt.ratio) * 3;
  const [dst] = MeshoptSimplifier.simplifyWithAttributes(idx, pos, 3, attr, 3, [1, 1, 1], null, target, opt.error ?? 0.002, opt.permissive ? ['Permissive', 'Prune'] : []);
  // 展开 + 平面法线
  const m = dst.length;
  const out: Geo = { pos: new Float32Array(m * 3), nrm: new Float32Array(m * 3), col: new Float32Array(m * 3), idx: new Uint32Array(m), glow: new Uint8Array(m), paint: new Uint8Array(m) };
  for (let t = 0; t < m; t += 3) {
    const [i, j, k] = [dst[t], dst[t + 1], dst[t + 2]];
    const ux = pos[j * 3] - pos[i * 3], uy = pos[j * 3 + 1] - pos[i * 3 + 1], uz = pos[j * 3 + 2] - pos[i * 3 + 2];
    const wx = pos[k * 3] - pos[i * 3], wy = pos[k * 3 + 1] - pos[i * 3 + 1], wz = pos[k * 3 + 2] - pos[i * 3 + 2];
    let nx = uy * wz - uz * wy, ny = uz * wx - ux * wz, nz = ux * wy - uy * wx;
    const L = Math.hypot(nx, ny, nz) || 1; nx /= L; ny /= L; nz /= L;
    for (let c = 0; c < 3; c++) {
      const s = dst[t + c], d = t + c;
      for (let a = 0; a < 3; a++) { out.pos[d * 3 + a] = pos[s * 3 + a]; out.col[d * 3 + a] = col[s * 3 + a] }
      out.nrm[d * 3] = nx; out.nrm[d * 3 + 1] = ny; out.nrm[d * 3 + 2] = nz;
      out.glow[d] = glow[s]; out.paint[d] = paint[s]; out.idx[d] = d;
    }
  }
  return out;
}

/** 漆面条纹：饱和色（s>0.6）按 15° 色相分桶累计面积，最大桶所在色族 → paint=1；同时给出机身主色（低饱和高亮度面积最大） */
function markPaint(g: Geo): { stripe: string; body: string; hue: number } {
  const bins = new Map<number, number>(), whites = new Map<string, number>(), stripeHex = new Map<string, number>();
  const hsvAt = (v: number) => hsv(g.col[v * 3], g.col[v * 3 + 1], g.col[v * 3 + 2]);
  for (let t = 0; t < g.idx.length; t += 3) {
    const v = g.idx[t];
    if (g.glow[v]) continue;
    const A = triArea(g.pos, v, g.idx[t + 1], g.idx[t + 2]), c = hsvAt(v);
    if (c.s > 0.6 && c.v > 0.15) { const b = Math.floor(c.h / 15); bins.set(b, (bins.get(b) ?? 0) + A) }
    else if (c.s < 0.1 && c.v > 0.75) whites.set(hexOf(g.col, v), (whites.get(hexOf(g.col, v)) ?? 0) + A);
  }
  const bin = [...bins].sort((a, b) => b[1] - a[1])[0][0];
  const lo = bin * 15 - 7.5, hi = bin * 15 + 22.5;
  for (let v = 0; v < g.paint.length; v++) {
    const c = hsvAt(v);
    if (!g.glow[v] && c.s > 0.6 && c.v > 0.15 && c.h >= lo && c.h < hi) g.paint[v] = 1;
  }
  for (let t = 0; t < g.idx.length; t += 3) {
    const v = g.idx[t];
    if (g.paint[v]) stripeHex.set(hexOf(g.col, v), (stripeHex.get(hexOf(g.col, v)) ?? 0) + triArea(g.pos, v, g.idx[t + 1], g.idx[t + 2]));
  }
  const top = (m: Map<string, number>) => [...m].sort((a, b) => b[1] - a[1])[0][0];
  return { stripe: top(stripeHex), body: top(whites), hue: Math.round(bin * 15 + 7.5) };
}

/** 地面砖块：朝上（ny>0.95）的三角按 1 cm 高度分桶，取面积最大的一档 = 铺面高度（输出坐标） */
function surfaceY(g: Geo): number {
  const bins = new Map<number, number>();
  for (let t = 0; t < g.idx.length; t += 3) {
    const [i, j, k] = [g.idx[t], g.idx[t + 1], g.idx[t + 2]];
    if (g.nrm[i * 3 + 1] < 0.95) continue;
    const y = Math.round(((g.pos[i * 3 + 1] + g.pos[j * 3 + 1] + g.pos[k * 3 + 1]) / 3) * 100);
    bins.set(y, (bins.get(y) ?? 0) + triArea(g.pos, i, j, k));
  }
  const ys = [...bins].sort((a, b) => b[1] - a[1]);
  // 底座顶面（土色）也朝上且面积满格；取面积前两档里更高的那档
  return Math.max(...ys.slice(0, 2).map(([y]) => y)) / 100;
}

// ───────────────────────────── 处理一个模型 ─────────────────────────────

interface Built {
  cfg: ModelCfg;
  body: Geo;
  child?: { id: string; geo: Geo; hub: number[]; comps: string[] };
  extras: Record<string, unknown>;
  srcSize: number[];
  srcTris: number;
}

function process1(raw: Baked & { idx: Uint32Array }, cfg: ModelCfg): Built {
  const n = raw.pos.length / 3;
  const g: Geo = { ...raw, glow: new Uint8Array(n), paint: new Uint8Array(n) };
  const src = bbox(g.pos);
  // 发光掩码（按源颜色）
  if (cfg.glowColors) {
    const want = cfg.glowColors.map(parseHex);
    for (let v = 0; v < n; v++) {
      const c = [byte(g.col[v * 3]), byte(g.col[v * 3 + 1]), byte(g.col[v * 3 + 2])];
      if (want.some((w) => Math.abs(w[0] - c[0]) <= 1 && Math.abs(w[1] - c[1]) <= 1 && Math.abs(w[2] - c[2]) <= 1)) g.glow[v] = 1;
    }
  }
  // 原点（源坐标）
  const slab = Math.min(0.5, src.size[1] * 0.1);
  let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
  const gearMinAbsX = src.size[0] * 0.1;
  for (let v = 0; v < n; v++) {
    if (g.pos[v * 3 + 1] > src.lo[1] + slab) continue;
    if (cfg.origin === 'gear' && Math.abs(g.pos[v * 3]) < gearMinAbsX) continue; // 只看主轮，排除前轮
    x0 = Math.min(x0, g.pos[v * 3]); x1 = Math.max(x1, g.pos[v * 3]); z0 = Math.min(z0, g.pos[v * 3 + 2]); z1 = Math.max(z1, g.pos[v * 3 + 2]);
  }
  const origin = [cfg.origin === 'gear' ? (src.lo[0] + src.hi[0]) / 2 : (x0 + x1) / 2, src.lo[1], (z0 + z1) / 2];
  const s = cfg.scaleTo ? cfg.scaleTo.size / src.size[AX[cfg.scaleTo.axis]] : 1;
  const yaw = cfg.yaw ?? 0, cy = Math.cos(yaw), sy = Math.sin(yaw);
  for (let v = 0; v < n; v++) {
    const x = (g.pos[v * 3] - origin[0]) * s, y = (g.pos[v * 3 + 1] - origin[1]) * s, z = (g.pos[v * 3 + 2] - origin[2]) * s;
    g.pos[v * 3] = x * cy + z * sy; g.pos[v * 3 + 1] = y; g.pos[v * 3 + 2] = -x * sy + z * cy;
    const nx = g.nrm[v * 3], nz = g.nrm[v * 3 + 2];
    g.nrm[v * 3] = nx * cy + nz * sy; g.nrm[v * 3 + 2] = -nx * sy + nz * cy;
  }
  const extras: Record<string, unknown> = {
    kind: cfg.kind, srcSize: src.size.map((x) => +x.toFixed(3)), scale: +s.toFixed(4),
    origin: cfg.origin, srcOrigin: origin.map((x) => +x.toFixed(3)),
  };
  let body = g;
  let child: Built['child'];
  if (cfg.paint) extras.paint = markPaint(g);
  if (cfg.split) {
    const r = splitProp(g, cfg.split);
    if (r) { body = r.body; child = { id: cfg.split.id, geo: r.prop, hub: r.hub, comps: r.comps } }
    else log(`${cfg.id}：螺旋桨拆分失败，按整体输出（运行时用程序化桨盘）`);
  }
  if (cfg.simplify) body = simplifyGeo(body, cfg.simplify);
  if (cfg.tile) extras.surfaceY = surfaceY(body);
  return { cfg, body, child, extras, srcSize: src.size, srcTris: raw.idx.length / 3 };
}

// ───────────────────────────── 写出 ─────────────────────────────

function addMesh(doc: Document, name: string, geo: Geo): ReturnType<Document['createMesh']> {
  const buf = doc.getRoot().listBuffers()[0];
  const mat = doc.getRoot().listMaterials()[0];
  const prim = doc.createPrimitive()
    .setAttribute('POSITION', doc.createAccessor().setType('VEC3').setArray(geo.pos).setBuffer(buf))
    .setAttribute('NORMAL', doc.createAccessor().setType('VEC3').setArray(geo.nrm).setBuffer(buf))
    .setAttribute('COLOR_0', doc.createAccessor().setType('VEC3').setArray(geo.col).setBuffer(buf))
    .setIndices(doc.createAccessor().setType('SCALAR').setArray(geo.idx).setBuffer(buf))
    .setMaterial(mat);
  // 自定义属性必须以下划线开头；float 0/1（运行时 GLTFLoader 映射为 geometry.attributes._glow / _paint）
  if (geo.glow.some((x) => x)) prim.setAttribute('_GLOW', doc.createAccessor().setType('SCALAR').setArray(Float32Array.from(geo.glow)).setBuffer(buf));
  if (geo.paint.some((x) => x)) prim.setAttribute('_PAINT', doc.createAccessor().setType('SCALAR').setArray(Float32Array.from(geo.paint)).setBuffer(buf));
  return doc.createMesh(name).addPrimitive(prim);
}

const triCount = (g: Geo): number => g.idx.length / 3;
const glowShare = (g: Geo): string => {
  let a = 0, A = 0;
  for (let t = 0; t < g.idx.length; t += 3) { const x = triArea(g.pos, g.idx[t], g.idx[t + 1], g.idx[t + 2]); A += x; if (g.glow[g.idx[t]]) a += x }
  return `${((a / A) * 100).toFixed(1)}%`;
};

async function build(): Promise<void> {
  const io = await dracoIO();
  await MeshoptSimplifier.ready;
  await MeshoptEncoder.ready;
  const doc = new Document();
  doc.createBuffer();
  doc.createMaterial('lowpoly').setRoughnessFactor(0.85).setMetallicFactor(0.05);
  const scene = doc.createScene('airfield');
  doc.getRoot().setDefaultScene(scene);
  const built: Built[] = [];
  for (const cfg of MODELS) {
    const b = process1(merge(bake(await io.read(resolve(SRC_DIR, cfg.file)))), cfg);
    built.push(b);
    const size = bbox(b.body.pos).size;
    const node = doc.createNode(`air:${cfg.id}`).setMesh(addMesh(doc, cfg.id, b.body))
      .setExtras({ id: cfg.id, source: URL_BASE + cfg.id, size: size.map((x) => +x.toFixed(2)), ...b.extras });
    if (b.child) {
      const cs = bbox(b.child.geo.pos).size;
      node.addChild(doc.createNode(`prop:${b.child.id}`).setMesh(addMesh(doc, b.child.id, b.child.geo))
        .setTranslation(b.child.hub.map((x) => +x.toFixed(4)) as [number, number, number])
        // pivot 冗余记一份：quantize 会把量化修正乘进无子节点的 mesh 节点矩阵，运行时以 extras.pivot 为准
        .setExtras({ id: b.child.id, part: 'propeller', parent: cfg.id, axis: [0, 0, 1], pivot: b.child.hub.map((x) => +x.toFixed(4)), size: cs.map((x) => +x.toFixed(2)) }));
    }
    scene.addChild(node);
  }
  // 焊接 → meshopt 压缩（内含 reorder + KHR_mesh_quantization 量化）
  doc.setLogger(new Logger(Logger.Verbosity.WARN));
  await doc.transform(weld(), meshopt({ encoder: MeshoptEncoder, level: 'high' }));
  mkdirSync(OUT_DIR, { recursive: true });
  // 逐模型字节：单独写一份只含该模型的文档测大小（近似，含 glb 头）
  const io2 = new NodeIO().registerExtensions([EXTMeshoptCompression, KHRMeshQuantization]).registerDependencies({ 'meshopt.encoder': MeshoptEncoder });
  await io2.write(OUT_GLB, doc);
  const bytes = statSync(OUT_GLB).size;
  log('id                       源尺寸(m)              缩放    输出尺寸(m)            源三角→输出三角   发光面积  ≈字节');
  for (const b of built) {
    const per = await measure(io2, b);
    const out = bbox(b.body.pos).size;
    log(`${b.cfg.id.padEnd(24)} ${f2(b.srcSize).padEnd(22)} ×${(b.extras.scale as number).toFixed(3)}  ${f2(out).padEnd(22)} ${String(b.srcTris).padStart(6)}→${String(triCount(b.body) + (b.child ? triCount(b.child.geo) : 0)).padEnd(6)}    ${b.cfg.glowColors ? glowShare(b.body).padStart(6) : '     -'}   ${(per / 1024).toFixed(1)} KB`);
    if (b.child) log(`   └ prop:${b.child.id} 桨毂(相对机身原点) [${b.child.hub.map((x) => x.toFixed(3)).join(', ')}] 尺寸 ${f2(bbox(b.child.geo.pos).size)}  ${triCount(b.child.geo)} 三角  分量 ${b.child.comps.join(' ')}`);
    if (b.extras.paint) log(`   └ _PAINT 条纹色族 色相≈${(b.extras.paint as { hue: number }).hue}° 代表色 ${(b.extras.paint as { stripe: string }).stripe}，机身主色 ${(b.extras.paint as { body: string }).body}`);
    if (b.extras.surfaceY !== undefined) log(`   └ 铺面高度 surfaceY = ${b.extras.surfaceY} m（底面 y=0）`);
  }
  for (const s of SKIPPED) log(`跳过 ${s.id}：${s.why}`);
  if (bytes > SIZE_BUDGET) throw new Error(`airfield.glb ${bytes} B 超出预算 ${SIZE_BUDGET} B`);
  writeFileSync(OUT_LICENSE, [
    ...THREEJSASSETS_LICENSE_HEAD,
    '本目录的 airfield.glb 是解压、重新烘焙、简化、量化压缩后的派生产物，仅供本游戏运行时加载；',
    '仓库若公开，应排除 public/assets/airfield/（许可证禁止再分发原文件）。',
    '',
    '使用的模型（threejsassets「Airfield」套件，经 scripts/airfield/build.ts 打包为 airfield.glb）：',
    ...MODELS.map((m) => `- ${m.id}：${URL_BASE}${m.id}`),
    '',
    '下载但未打包：',
    ...SKIPPED.map((m) => `- ${m.id}：${URL_BASE}${m.id}（${m.why}）`),
    '',
  ].join('\n'));
  log(`写出：${OUT_GLB}（${(bytes / 1024).toFixed(1)} KB / 预算 ${(SIZE_BUDGET / 1024).toFixed(0)} KB）\n                 ${OUT_LICENSE}`);
}

/** 单模型压缩后的字节数（单独成文档写进内存） */
async function measure(io2: NodeIO, b: Built): Promise<number> {
  const d = new Document().setLogger(new Logger(Logger.Verbosity.WARN));
  d.createBuffer();
  d.createMaterial('lowpoly');
  const sc = d.createScene();
  sc.addChild(d.createNode(b.cfg.id).setMesh(addMesh(d, b.cfg.id, b.body)));
  if (b.child) sc.addChild(d.createNode(b.child.id).setMesh(addMesh(d, b.child.id, b.child.geo)));
  await d.transform(weld(), meshopt({ encoder: MeshoptEncoder, level: 'high' }));
  return (await io2.writeBinary(d)).byteLength;
}

// ───────────────────────────── --inspect ─────────────────────────────

async function inspect(): Promise<void> {
  const io = await dracoIO();
  for (const f of readdirSync(SRC_DIR).filter((f) => f.endsWith('.glb')).sort()) {
    const doc = await io.read(resolve(SRC_DIR, f));
    const root = doc.getRoot();
    console.log(`== ${f}  材质 ${root.listMaterials().map((m) => `${m.getName()}(emissive ${m.getEmissiveFactor().join(',')})`).join(' ')}  纹理 ${root.listTextures().length}  动画 ${root.listAnimations().length}`);
    for (const node of root.listNodes()) {
      const mesh = node.getMesh();
      console.log(`   节点 "${node.getName()}" 父 ${node.getParentNode()?.getName() ?? '-'}  T[${node.getTranslation().map((x) => x.toFixed(2))}] R[${node.getRotation().map((x) => x.toFixed(2))}] S[${node.getScale().map((x) => x.toFixed(2))}]` +
        (mesh ? `  mesh: ${mesh.listPrimitives().map((p) => `${p.listSemantics().join('+')} v${p.getAttribute('POSITION')!.getCount()}`).join(' | ')}` : ''));
    }
    const g = merge(bake(doc));
    const b = bbox(g.pos);
    const area = new Map<string, { a: number; n: number; lo: number[]; hi: number[] }>();
    let total = 0;
    for (let t = 0; t < g.idx.length; t += 3) {
      const [i, j, k] = [g.idx[t], g.idx[t + 1], g.idx[t + 2]];
      const A = triArea(g.pos, i, j, k), c = hexOf(g.col, i);
      const e = area.get(c) ?? { a: 0, n: 0, lo: [Infinity, Infinity, Infinity], hi: [-Infinity, -Infinity, -Infinity] };
      e.a += A; e.n++; total += A;
      for (const v of [i, j, k]) for (let q = 0; q < 3; q++) { e.lo[q] = Math.min(e.lo[q], g.pos[v * 3 + q]); e.hi[q] = Math.max(e.hi[q], g.pos[v * 3 + q]) }
      area.set(c, e);
    }
    console.log(`   烘焙后 v${g.pos.length / 3} t${g.idx.length / 3}  包围盒 [${b.lo.map((x) => x.toFixed(2))}]→[${b.hi.map((x) => x.toFixed(2))}]  尺寸 ${f2(b.size)} m  调色板 ${area.size} 色`);
    const fmt = ([c, e]: [string, { a: number; n: number; lo: number[]; hi: number[] }]) => {
      const [r, gg, bb] = parseHex(c).map((x) => x / 255), h = hsv(r, gg, bb);
      return `     ${c} ${((e.a / total) * 100).toFixed(1).padStart(5)}%  t${String(e.n).padEnd(5)} h${h.h.toFixed(0).padStart(3)} s${h.s.toFixed(2)} v${h.v.toFixed(2)}  [${e.lo.map((x) => x.toFixed(2))}]→[${e.hi.map((x) => x.toFixed(2))}]`;
    };
    const sorted = [...area].sort((a, b) => b[1].a - a[1].a);
    console.log('   面积前 8：'); for (const e of sorted.slice(0, 8)) console.log(fmt(e));
    const sat = sorted.filter(([c]) => { const [r, gg, bb] = parseHex(c).map((x) => x / 255), h = hsv(r, gg, bb); return (h.s > 0.45 && h.v > 0.15) || h.v > 0.8 }).slice(0, 8);
    if (sat.length) { console.log('   高饱和 / 高亮色（发光、漆面候选）：'); for (const e of sat) console.log(fmt(e)) }
  }
}

if (process.argv.includes('--inspect')) await inspect();
else await build();
