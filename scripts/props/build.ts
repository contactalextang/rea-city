// 街道道具模型打包：把 threejsassets.com 免费模型（Free Commercial License，Draco 压缩 GLB）
// 解压、烘焙节点变换、原点归到树干底部，合成一个无压缩的 public/assets/props/props.glb。
// 用法：node scripts/props/build.ts（Node 22 原生跑 .ts）
//
// 运行时就不用带 Draco 解码器（~280 KB wasm）；解码借用 three 自带的 draco_decoder.js（纯 JS 版），在 vm 里加载。
// 产物：每个模型一个节点 + mesh，节点名 prop:<id>、extras.id = <id>（GLTFLoader 会删掉名字里的 ':'，运行时按 userData.id 取），
// 属性只留 POSITION / NORMAL / COLOR_0。
// data/assets-eval/ 是不可信下载目录：这里只按路径读取 GLB，不执行其中任何东西。
import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { Document, NodeIO, type Primitive } from '@gltf-transform/core';
import { KHRDracoMeshCompression } from '@gltf-transform/extensions';
import { Matrix4, Vector3 } from 'three';

const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
/** 不可信下载目录：只以路径读取 */
const EVAL_DIR = resolve(PROJECT_ROOT, 'data/assets-eval/threejsassets');
const OUT_DIR = resolve(PROJECT_ROOT, 'public/assets/props');
const OUT_GLB = resolve(OUT_DIR, 'props.glb');
const OUT_LICENSE = resolve(OUT_DIR, 'LICENSE-threejsassets.txt');
const SIZE_BUDGET = 256 * 1024;

interface Source { id: string; file: string; url: string }
const SOURCES: Source[] = [
  { id: 'shade-tree', file: 'shade-tree.glb', url: 'https://threejsassets.com/assets/shade-tree' },
  { id: 'metropolis-street-tree-01', file: 'metropolis-street-tree-01.glb', url: 'https://threejsassets.com/assets/metropolis-street-tree-01' },
];
const KEEP_ATTRS = new Set(['POSITION', 'NORMAL', 'COLOR_0']);

const log = (msg: string): void => console.log(`[props:build] ${msg}`);

/** three 的 draco_decoder.js 是 Emscripten 产物，挂全局 DracoDecoderModule；在独立 vm 上下文里求值取出 */
async function dracoDecoder(): Promise<unknown> {
  const src = readFileSync(resolve(PROJECT_ROOT, 'node_modules/three/examples/jsm/libs/draco/draco_decoder.js'), 'utf8');
  const ctx: Record<string, unknown> = { console };
  vm.createContext(ctx);
  vm.runInContext(`${src};this.DracoDecoderModule=DracoDecoderModule`, ctx);
  return (ctx.DracoDecoderModule as () => Promise<unknown>)();
}

interface Baked { pos: Float32Array; nrm: Float32Array; col: Float32Array; idx: Uint32Array | null }

/** 读一个源 GLB：所有 mesh 节点按世界矩阵烘焙到顶点，颜色统一成 float RGB */
function bake(doc: Document): Baked[] {
  const out: Baked[] = [];
  const m = new Matrix4(), nm = new Matrix4(), v = new Vector3();
  for (const node of doc.getRoot().listNodes()) {
    const mesh = node.getMesh();
    if (!mesh) continue;
    m.fromArray(node.getWorldMatrix());
    nm.copy(m).invert().transpose();
    for (const prim of mesh.listPrimitives()) out.push(bakePrim(prim, m, nm, v));
  }
  return out;
}

function bakePrim(prim: Primitive, m: Matrix4, nm: Matrix4, v: Vector3): Baked {
  const pa = prim.getAttribute('POSITION')!, na = prim.getAttribute('NORMAL'), ca = prim.getAttribute('COLOR_0');
  const n = pa.getCount();
  const pos = new Float32Array(n * 3), nrm = new Float32Array(n * 3), col = new Float32Array(n * 3);
  const el: number[] = [];
  for (let k = 0; k < n; k++) {
    v.fromArray(pa.getElement(k, el)).applyMatrix4(m);
    v.toArray(pos, k * 3);
    if (na) { v.fromArray(na.getElement(k, el)).transformDirection(nm); v.toArray(nrm, k * 3) }
    if (ca) { ca.getElement(k, el); col[k * 3] = el[0]; col[k * 3 + 1] = el[1]; col[k * 3 + 2] = el[2] }
    else col.fill(1, k * 3, k * 3 + 3);
  }
  const ia = prim.getIndices();
  return { pos, nrm, col, idx: ia ? Uint32Array.from(ia.getArray()!) : null };
}

/** 合并若干 primitive，原点移到树干底部：y 最低点归 0，xz 取最低 0.5 m 内顶点的包围盒中心 */
function normalize(parts: Baked[]): Baked & { size: number[] } {
  const total = parts.reduce((s, p) => s + p.pos.length / 3, 0);
  const pos = new Float32Array(total * 3), nrm = new Float32Array(total * 3), col = new Float32Array(total * 3);
  const idx: number[] = [];
  let base = 0;
  for (const p of parts) {
    const n = p.pos.length / 3;
    pos.set(p.pos, base * 3); nrm.set(p.nrm, base * 3); col.set(p.col, base * 3);
    if (p.idx) for (const i of p.idx) idx.push(i + base);
    else for (let k = 0; k < n; k++) idx.push(k + base);
    base += n;
  }
  let minY = Infinity;
  for (let k = 1; k < pos.length; k += 3) minY = Math.min(minY, pos[k]);
  let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
  for (let k = 0; k < pos.length; k += 3) {
    if (pos[k + 1] > minY + 0.5) continue;
    x0 = Math.min(x0, pos[k]); x1 = Math.max(x1, pos[k]); z0 = Math.min(z0, pos[k + 2]); z1 = Math.max(z1, pos[k + 2]);
  }
  const cx = (x0 + x1) / 2, cz = (z0 + z1) / 2;
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (let k = 0; k < pos.length; k += 3) {
    pos[k] -= cx; pos[k + 1] -= minY; pos[k + 2] -= cz;
    for (let a = 0; a < 3; a++) { lo[a] = Math.min(lo[a], pos[k + a]); hi[a] = Math.max(hi[a], pos[k + a]) }
  }
  return { pos, nrm, col, idx: Uint32Array.from(idx), size: hi.map((h, a) => +(h - lo[a]).toFixed(2)) };
}

async function main(): Promise<void> {
  const io = new NodeIO()
    .registerExtensions([KHRDracoMeshCompression])
    .registerDependencies({ 'draco3d.decoder': await dracoDecoder() });
  const out = new Document();
  const buf = out.createBuffer();
  const scene = out.createScene('props');
  const mat = out.createMaterial('lowpoly').setRoughnessFactor(0.92).setMetallicFactor(0.02);
  for (const s of SOURCES) {
    const src = await io.read(resolve(EVAL_DIR, s.file));
    for (const prim of src.getRoot().listMeshes().flatMap((mm) => mm.listPrimitives())) {
      for (const sem of prim.listSemantics()) if (!KEEP_ATTRS.has(sem)) log(`${s.id}：丢弃属性 ${sem}`);
    }
    const g = normalize(bake(src));
    const prim = out.createPrimitive()
      .setAttribute('POSITION', out.createAccessor().setType('VEC3').setArray(g.pos).setBuffer(buf))
      .setAttribute('NORMAL', out.createAccessor().setType('VEC3').setArray(g.nrm).setBuffer(buf))
      .setAttribute('COLOR_0', out.createAccessor().setType('VEC3').setArray(g.col).setBuffer(buf))
      .setIndices(out.createAccessor().setType('SCALAR').setArray(g.pos.length / 3 > 65535 ? g.idx! : Uint16Array.from(g.idx!)).setBuffer(buf))
      .setMaterial(mat);
    const mesh = out.createMesh(s.id).addPrimitive(prim);
    scene.addChild(out.createNode(`prop:${s.id}`).setMesh(mesh).setExtras({ id: s.id, source: s.url, size: g.size }));
    log(`${s.id}：${g.pos.length / 3} 顶点 / ${g.idx!.length / 3} 三角，尺寸 ${g.size.join(' × ')} m`);
  }
  mkdirSync(OUT_DIR, { recursive: true });
  await new NodeIO().write(OUT_GLB, out);
  const bytes = statSync(OUT_GLB).size;
  if (bytes > SIZE_BUDGET) throw new Error(`props.glb ${bytes} B 超出预算 ${SIZE_BUDGET} B`);
  writeFileSync(OUT_LICENSE, [
    'threejsassets.com — Free Commercial License（https://threejsassets.com/license#free-asset-license）',
    '要点（摘自 https://threejsassets.com/pricing）：可用于商业 / 游戏 / 网站等项目与发布的产品，无需署名；',
    '不得转售、镜像、重新打包或单独再分发模型文件本身。',
    '',
    '使用的模型（经 scripts/props/build.ts 解压合并为 props.glb）：',
    ...SOURCES.map((s) => `- ${s.id}：${s.url}`),
    '',
  ].join('\n'));
  log(`写出：${OUT_GLB}（${(bytes / 1024).toFixed(1)} KB）\n              ${OUT_LICENSE}`);
}

await main();
