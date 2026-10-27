// 构建脚本共用的 GLB 工具：Draco 解码器、读取 IO、节点世界矩阵烘焙。
// 由 scripts/props/build.ts 与 scripts/airfield/build.ts 共用；只在 node 构建期使用，不进运行时 bundle。
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { type Document, NodeIO, type Primitive } from '@gltf-transform/core';
import { KHRDracoMeshCompression } from '@gltf-transform/extensions';
import { Matrix4, Vector3 } from 'three';

export const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

/** three 的 draco_decoder.js 是 Emscripten 产物，挂全局 DracoDecoderModule；在独立 vm 上下文里求值取出 */
export async function dracoDecoder(): Promise<unknown> {
  const src = readFileSync(resolve(PROJECT_ROOT, 'node_modules/three/examples/jsm/libs/draco/draco_decoder.js'), 'utf8');
  const ctx: Record<string, unknown> = { console };
  vm.createContext(ctx);
  vm.runInContext(`${src};this.DracoDecoderModule=DracoDecoderModule`, ctx);
  return (ctx.DracoDecoderModule as () => Promise<unknown>)();
}

/** 能读 Draco 压缩 GLB 的 NodeIO */
export async function dracoIO(): Promise<NodeIO> {
  return new NodeIO()
    .registerExtensions([KHRDracoMeshCompression])
    .registerDependencies({ 'draco3d.decoder': await dracoDecoder() });
}

export interface Baked { pos: Float32Array; nrm: Float32Array; col: Float32Array; idx: Uint32Array | null }

/** 读一个源 GLB：所有 mesh 节点按世界矩阵烘焙到顶点，颜色统一成 float RGB */
export function bake(doc: Document): Baked[] {
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

export function bakePrim(prim: Primitive, m: Matrix4, nm: Matrix4, v: Vector3): Baked {
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

/** 把若干 Baked 拼成一份（索引补偏移；无索引的按顺序生成） */
export function merge(parts: Baked[]): Baked & { idx: Uint32Array } {
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
  return { pos, nrm, col, idx: Uint32Array.from(idx) };
}

/** threejsassets Free Commercial License 的通用说明行 */
export const THREEJSASSETS_LICENSE_HEAD = [
  'threejsassets.com — Free Commercial License（https://threejsassets.com/license#free-asset-license）',
  '要点（摘自 https://threejsassets.com/pricing）：可用于商业 / 游戏 / 网站等项目与发布的产品，无需署名；',
  '不得转售、镜像、重新打包或单独再分发模型文件本身。',
];
