// 角色资产打包：把 Quaternius Ultimate Modular Men / Women（CC0）的独立 glTF 合并成
// 游戏可直接加载的单个 public/assets/characters/characters.glb + 目录 catalog.json。
// 用法：node scripts/char/build.ts（Node 22 原生跑 .ts）
//
// 产物结构：
//   - 一套 62 关节骨骼（取男包 Casual_2 的 skin），所有部件 skin 指向它；
//     女包骨骼关节名序相同但绑定姿态不同，顶点按「女绑定姿态 → 男绑定姿态」重蒙皮后再绑到同一骨骼；
//   - 每个部件一个 mesh，节点名 part:<slot>:<id>，extras { part, slot, gender, set }；
//   - 程序化鸭舌帽 part:hat:cap（材质 Hat）+ 安全帽 part:hat:helmet（取 Worker_Head 的 Worker_Yellow 部分，材质 Helmet）；
//   - 24 段动画去重（同名只留男包一份）；
//   - dedup / prune / resample / quantize（位置 14 bit、法线 8、权重 8），无 draco / meshopt。
// data/assets-eval/ 是不可信下载目录：这里只按路径读取 glTF / License，不执行其中任何东西。
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Document, NodeIO, PropertyType, VertexLayout, type Accessor, type Animation, type Material, type Mesh, type Node, type Primitive, type Scene, type Skin } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { dedup, mergeDocuments, prune, quantize, resample, unpartition } from '@gltf-transform/functions';
import { Matrix3, Matrix4, Vector3 } from 'three';
import {
  ATTRIBUTION,
  CLIP_ALIASES,
  PART_LABELS,
  PRESETS,
  ROLE_OVERRIDES,
  ROLE_RULES,
  SET_LABELS,
  type Gender,
  type Role,
  type Slot,
} from './catalog-rules.ts';

const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
/** 不可信下载目录：只以路径读取 */
const EVAL_DIR = resolve(PROJECT_ROOT, 'data/assets-eval');
const OUT_DIR = resolve(PROJECT_ROOT, 'public/assets/characters');
const OUT_GLB = resolve(OUT_DIR, 'characters.glb');
const OUT_CATALOG = resolve(OUT_DIR, 'catalog.json');
const OUT_LICENSE = resolve(OUT_DIR, 'LICENSE-quaternius.txt');
const SIZE_BUDGET = 4 * 1024 * 1024;

interface SourcePack {
  gender: Gender;
  name: string;
  dir: string;
  license: string;
  /** 作为骨骼来源的文件（只有男包需要） */
  baseFile?: string;
}
const PACKS: SourcePack[] = [
  {
    gender: 'm',
    name: 'Ultimate Modular Men',
    dir: resolve(EVAL_DIR, 'quaternius-ultimate-modular-men/glTF'),
    license: resolve(EVAL_DIR, 'quaternius-ultimate-modular-men/License.txt'),
    baseFile: 'Casual_2.gltf',
  },
  {
    gender: 'f',
    name: 'Ultimate Modular Women',
    dir: resolve(EVAL_DIR, 'quaternius-ultimate-modular-women/glTF'),
    license: resolve(EVAL_DIR, 'quaternius-ultimate-modular-women/License.txt'),
  },
];

const SLOTS: Slot[] = ['head', 'body', 'legs', 'feet', 'hat'];
/** 节点名里套装名的拼写修正（女包 Formal 的头部节点写成了 Formad_Head） */
const SET_TYPO: Record<string, string> = { formad: 'formal' };
const ARMATURE_NAME = 'CharacterArmature';

const log = (msg: string): void => console.log(`[char:build] ${msg}`);
const warn = (msg: string): void => console.warn(`[char:build] 警告：${msg}`);

interface PartRecord {
  id: string;
  slot: Slot;
  gender: Gender | 'any';
  set: string;
  label: string;
  node: Node;
  mesh: Mesh;
  /** 来源文件（仅记录） */
  source: string;
}

// ---------- 小工具 ----------

function linearToSrgbHex(rgb: number[]): string {
  const c = (v: number): string => {
    const s = v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(v, 1 / 2.4) - 0.055;
    return Math.round(Math.max(0, Math.min(1, s)) * 255)
      .toString(16)
      .padStart(2, '0');
  };
  return `#${c(rgb[0])}${c(rgb[1])}${c(rgb[2])}`;
}

function srgbHexToLinear(hex: string): [number, number, number, number] {
  const n = parseInt(hex.replace('#', ''), 16);
  const f = (v: number): number => {
    const s = v / 255;
    return s <= 0.04045 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  };
  return [f((n >> 16) & 255), f((n >> 8) & 255), f(n & 255), 1];
}

function materialKey(m: Material): string {
  return `${m.getName()}|${linearToSrgbHex(m.getBaseColorFactor())}`;
}

function maxAbsDiff(a: ArrayLike<number>, b: ArrayLike<number>): number {
  if (a.length !== b.length) return Infinity;
  let d = 0;
  for (let i = 0; i < a.length; i++) d = Math.max(d, Math.abs(a[i] - b[i]));
  return d;
}

function fmtBytes(n: number): string {
  return `${(n / 1024 / 1024).toFixed(2)} MB (${n} B)`;
}

/** 解析部件节点名 <Set>_<Slot> → { set, slot }；不是四件套（Pistol / Backpack）返回 null */
function parsePartName(name: string): { set: string; slot: Slot } | null {
  const m = /^(.+?)_(Head|Body|Legs|Feet)$/.exec(name);
  if (!m) return null;
  let set = m[1].replace(/_/g, '').toLowerCase();
  set = SET_TYPO[set] ?? set;
  return { set, slot: m[2].toLowerCase() as Slot };
}

// ---------- 重蒙皮：把女包顶点从女绑定姿态搬到男绑定姿态 ----------

/**
 * v' = Σ w_k · (inv(IBM_dst[j_k]) · IBM_src[j_k]) · v
 * 即把源网格按「源绑定姿态 → 目标绑定姿态」做一次线性混合蒙皮，之后就能直接用目标骨骼的 IBM。
 * 法线用同一矩阵的旋转部分（两套 IBM 都没有缩放）。
 */
function reposeMesh(mesh: Mesh, srcIbm: ArrayLike<number>, dstIbm: ArrayLike<number>, jointCount: number): void {
  const deform: Matrix4[] = [];
  const deformRot: Matrix3[] = [];
  const tmpSrc = new Matrix4();
  const tmpDst = new Matrix4();
  for (let j = 0; j < jointCount; j++) {
    tmpSrc.fromArray(srcIbm as number[], j * 16);
    tmpDst.fromArray(dstIbm as number[], j * 16);
    const d = new Matrix4().copy(tmpDst).invert().multiply(tmpSrc);
    deform.push(d);
    deformRot.push(new Matrix3().setFromMatrix4(d));
  }
  const p = new Vector3();
  const acc = new Vector3();
  const n = new Vector3();
  const nAcc = new Vector3();
  const el = [0, 0, 0];
  const jl = [0, 0, 0, 0];
  const wl = [0, 0, 0, 0];
  const done = new Set<Accessor>();
  for (const prim of mesh.listPrimitives()) {
    const pos = prim.getAttribute('POSITION');
    const nor = prim.getAttribute('NORMAL');
    const joints = prim.getAttribute('JOINTS_0');
    const weights = prim.getAttribute('WEIGHTS_0');
    if (!pos || !joints || !weights) throw new Error(`部件 ${mesh.getName()} 缺少蒙皮属性`);
    if (done.has(pos)) continue;
    done.add(pos);
    const count = pos.getCount();
    const posOut = new Float32Array(count * 3);
    const norOut = nor ? new Float32Array(count * 3) : null;
    for (let i = 0; i < count; i++) {
      pos.getElement(i, el);
      joints.getElement(i, jl);
      weights.getElement(i, wl);
      acc.set(0, 0, 0);
      nAcc.set(0, 0, 0);
      let wsum = 0;
      for (let k = 0; k < 4; k++) {
        const w = wl[k];
        if (w <= 0) continue;
        wsum += w;
        p.set(el[0], el[1], el[2]).applyMatrix4(deform[jl[k]]);
        acc.addScaledVector(p, w);
      }
      if (wsum <= 0) {
        // 没有权重的顶点原样保留
        acc.set(el[0], el[1], el[2]);
      } else if (Math.abs(wsum - 1) > 1e-3) {
        acc.multiplyScalar(1 / wsum);
      }
      posOut[i * 3] = acc.x;
      posOut[i * 3 + 1] = acc.y;
      posOut[i * 3 + 2] = acc.z;
      if (nor && norOut) {
        const ne = [0, 0, 0];
        nor.getElement(i, ne);
        nAcc.set(0, 0, 0);
        for (let k = 0; k < 4; k++) {
          const w = wl[k];
          if (w <= 0) continue;
          n.set(ne[0], ne[1], ne[2]).applyMatrix3(deformRot[jl[k]]);
          nAcc.addScaledVector(n, w);
        }
        if (nAcc.lengthSq() < 1e-12) nAcc.set(ne[0], ne[1], ne[2]);
        nAcc.normalize();
        norOut[i * 3] = nAcc.x;
        norOut[i * 3 + 1] = nAcc.y;
        norOut[i * 3 + 2] = nAcc.z;
      }
    }
    // 直接改 accessor 数组：同一 accessor 只处理一次（上面的 done 集合），不影响其他 mesh
    pos.setArray(posOut);
    if (nor && norOut) nor.setArray(norOut);
  }
}

// ---------- 程序化帽子 ----------

interface Bounds {
  min: [number, number, number];
  max: [number, number, number];
}

function primBounds(prim: Primitive): Bounds {
  const pos = prim.getAttribute('POSITION');
  if (!pos) throw new Error('primitive 没有 POSITION');
  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  const el = [0, 0, 0];
  for (let i = 0; i < pos.getCount(); i++) {
    pos.getElement(i, el);
    for (let k = 0; k < 3; k++) {
      min[k] = Math.min(min[k], el[k]);
      max[k] = Math.max(max[k], el[k]);
    }
  }
  return { min, max };
}

function unionBounds(list: Bounds[]): Bounds {
  const out: Bounds = { min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] };
  for (const b of list)
    for (let k = 0; k < 3; k++) {
      out.min[k] = Math.min(out.min[k], b.min[k]);
      out.max[k] = Math.max(out.max[k], b.max[k]);
    }
  return out;
}

/** 三角面累加器：全部顶点 100% 绑定到一个关节，平面着色（每个面独立顶点） */
class TriBuilder {
  positions: number[] = [];
  normals: number[] = [];
  faces = 0;
  /** facing：期望法线朝向；若按 a,b,c 缠绕算出的法线与之相反就翻转缠绕 */
  addTri(a: Vector3, b: Vector3, c: Vector3, facing?: Vector3): void {
    const n = new Vector3().subVectors(b, a).cross(new Vector3().subVectors(c, a));
    if (n.lengthSq() < 1e-14) return;
    n.normalize();
    if (facing && n.dot(facing) < 0) {
      [b, c] = [c, b];
      n.negate();
    }
    for (const v of [a, b, c]) {
      this.positions.push(v.x, v.y, v.z);
      this.normals.push(n.x, n.y, n.z);
    }
    this.faces++;
  }
  addQuad(a: Vector3, b: Vector3, c: Vector3, d: Vector3, facing?: Vector3): void {
    this.addTri(a, b, c, facing);
    this.addTri(a, c, d, facing);
  }
  toPrimitive(doc: Document, jointIndex: number, material: Material): Primitive {
    const count = this.positions.length / 3;
    const joints = new Uint8Array(count * 4);
    const weights = new Float32Array(count * 4);
    for (let i = 0; i < count; i++) {
      joints[i * 4] = jointIndex;
      weights[i * 4] = 1;
    }
    const indices = new Uint16Array(count);
    for (let i = 0; i < count; i++) indices[i] = i;
    const buffer = doc.getRoot().listBuffers()[0];
    const mk = (name: string, type: 'VEC3' | 'VEC4' | 'SCALAR', arr: Float32Array | Uint8Array | Uint16Array): Accessor =>
      doc.createAccessor(name).setType(type).setArray(arr).setBuffer(buffer);
    return doc
      .createPrimitive()
      .setAttribute('POSITION', mk('hat_pos', 'VEC3', new Float32Array(this.positions)))
      .setAttribute('NORMAL', mk('hat_nor', 'VEC3', new Float32Array(this.normals)))
      .setAttribute('JOINTS_0', mk('hat_joints', 'VEC4', joints))
      .setAttribute('WEIGHTS_0', mk('hat_weights', 'VEC4', weights))
      .setIndices(mk('hat_idx', 'SCALAR', indices))
      .setMaterial(material);
  }
}

/**
 * 鸭舌帽：帽身 = 12 边 2 环 + 顶点扇的扁球冠，帽檐 = 向前伸出的扁楔形盒。
 * 位置按 Casual_Head（含头发）的顶点范围决定：帽身底环略低于发顶，帽檐朝脸的方向（+Z）。
 */
function buildCap(doc: Document, head: Bounds, hair: Bounds, forward: 1 | -1, headJoint: number, material: Material): Mesh {
  const cx = (head.min[0] + head.max[0]) / 2;
  const cz = (hair.min[2] + hair.max[2]) / 2 + forward * 0.01;
  const halfW = (hair.max[0] - hair.min[0]) / 2;
  const halfD = (hair.max[2] - hair.min[2]) / 2;
  const R = Math.max(halfW, halfD * 0.85) * 1.14; // 帽身底环半径
  const baseY = hair.max[1] - 0.075; // 底环高度：发顶下 7.5 cm
  const H = R * 0.95; // 帽身高度（扁一点）
  const SEG = 12;
  const b = new TriBuilder();
  const ring = (t: number): Vector3[] => {
    // t∈[0,1]：0 底环，1 顶点。半径按椭圆剖面
    const r = R * Math.sqrt(Math.max(0, 1 - t * t));
    const y = baseY + H * t;
    const out: Vector3[] = [];
    for (let i = 0; i < SEG; i++) {
      const a = (i / SEG) * Math.PI * 2;
      out.push(new Vector3(cx + r * Math.cos(a), y, cz + r * Math.sin(a)));
    }
    return out;
  };
  const r0 = ring(0);
  const r1 = ring(0.55);
  const r2 = ring(0.85);
  const apex = new Vector3(cx, baseY + H, cz);
  const outward = (v: Vector3): Vector3 => new Vector3(v.x - cx, 0.35, v.z - cz); // 帽身法线朝外偏上
  for (let i = 0; i < SEG; i++) {
    const j = (i + 1) % SEG;
    b.addQuad(r0[i], r0[j], r1[j], r1[i], outward(r0[i]));
    b.addQuad(r1[i], r1[j], r2[j], r2[i], outward(r1[i]));
    b.addTri(r2[i], r2[j], apex, outward(r2[i]));
  }
  // 帽檐：从帽身前侧伸出，略向下倾斜的扁楔形盒（上下面各 2 tris + 三条侧边 6 tris）
  const brimLen = R * 0.75;
  const z0 = cz + forward * R * 0.55;
  const z1 = cz + forward * (R + brimLen);
  const wBack = R * 0.95;
  const wTip = R * 0.6;
  const thick = 0.012;
  const yTip = baseY - 0.17 * (R + brimLen - R * 0.55); // 檐尖下降
  const top = [
    new Vector3(cx - wBack, baseY, z0),
    new Vector3(cx + wBack, baseY, z0),
    new Vector3(cx + wTip, yTip, z1),
    new Vector3(cx - wTip, yTip, z1),
  ];
  const bot = top.map((v) => new Vector3(v.x, v.y - thick, v.z));
  const up = new Vector3(0, 1, 0);
  const down = new Vector3(0, -1, 0);
  b.addQuad(top[0], top[1], top[2], top[3], up);
  b.addQuad(bot[0], bot[1], bot[2], bot[3], down);
  for (let i = 1; i < 4; i++) {
    const j = (i + 1) % 4;
    const mid = new Vector3().addVectors(top[i], top[j]).multiplyScalar(0.5);
    b.addQuad(top[i], top[j], bot[j], bot[i], new Vector3(mid.x - cx, 0, mid.z - cz));
  }
  const prim = b.toPrimitive(doc, headJoint, material);
  log(`鸭舌帽：${b.faces} tris，R=${R.toFixed(3)} 底环 y=${baseY.toFixed(3)} 顶 y=${(baseY + H).toFixed(3)} 前方=${forward > 0 ? '+Z' : '-Z'}`);
  return doc.createMesh('part:hat:cap').addPrimitive(prim);
}

/** 安全帽：复制 Worker_Head 的 Worker_Yellow 部分，围绕帽底中心略放大以盖住其他头型的头发 */
function buildHelmet(doc: Document, src: Primitive, material: Material, scale: number): Mesh {
  const b = primBounds(src);
  const pivot = new Vector3((b.min[0] + b.max[0]) / 2, b.min[1], (b.min[2] + b.max[2]) / 2);
  const srcPos = src.getAttribute('POSITION')!;
  const count = srcPos.getCount();
  const out = new Float32Array(count * 3);
  const el = [0, 0, 0];
  const v = new Vector3();
  for (let i = 0; i < count; i++) {
    srcPos.getElement(i, el);
    v.set(el[0], el[1], el[2]).sub(pivot).multiplyScalar(scale).add(pivot);
    out[i * 3] = v.x;
    out[i * 3 + 1] = v.y;
    out[i * 3 + 2] = v.z;
  }
  const buffer = doc.getRoot().listBuffers()[0];
  const prim = doc
    .createPrimitive()
    .setAttribute('POSITION', doc.createAccessor('helmet_pos').setType('VEC3').setArray(out).setBuffer(buffer))
    .setAttribute('NORMAL', src.getAttribute('NORMAL'))
    .setAttribute('JOINTS_0', src.getAttribute('JOINTS_0'))
    .setAttribute('WEIGHTS_0', src.getAttribute('WEIGHTS_0'))
    .setIndices(src.getIndices())
    .setMaterial(material);
  return doc.createMesh('part:hat:helmet').addPrimitive(prim);
}

// ---------- 主流程 ----------

async function main(): Promise<void> {
  // 顶点属性按 SEPARATE 布局写出：默认的 INTERLEAVED 会让 three.js 生成 InterleavedBufferAttribute，
  // 与共享 accessor 的普通 BufferAttribute 混在一起时 mergeGeometries 会报 gpuType 不一致
  const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).setVertexLayout(VertexLayout.SEPARATE);
  mkdirSync(OUT_DIR, { recursive: true });

  // 1. 收集源文件：男包 base 文件放最前
  const sources: { pack: SourcePack; file: string }[] = [];
  for (const pack of PACKS) {
    if (!existsSync(pack.dir)) throw new Error(`找不到目录 ${pack.dir}`);
    const files = readdirSync(pack.dir)
      .filter((f) => f.endsWith('.gltf') || f.endsWith('.glb'))
      .sort();
    if (pack.baseFile) {
      if (!files.includes(pack.baseFile)) throw new Error(`骨骼来源文件 ${pack.baseFile} 不存在`);
      files.splice(files.indexOf(pack.baseFile), 1);
      files.unshift(pack.baseFile);
    }
    for (const f of files) sources.push({ pack, file: resolve(pack.dir, f) });
  }
  log(`源文件 ${sources.length} 个（男 ${sources.filter((s) => s.pack.gender === 'm').length} / 女 ${sources.filter((s) => s.pack.gender === 'f').length}）`);

  let out: Document | null = null;
  let baseSkin: Skin | null = null;
  let baseArmature: Node | null = null;
  let baseJointNames: string[] = [];
  let baseIbm: ArrayLike<number> = [];
  const parts: PartRecord[] = [];
  const keptAnimations = new Map<string, string>(); // 名称 → 来源文件
  const skipped: string[] = [];

  // 2. 逐文件合并
  for (const { pack, file } of sources) {
    const doc = await io.read(file);
    const root = doc.getRoot();
    const skins = root.listSkins();
    if (skins.length !== 1) throw new Error(`${basename(file)}：期望 1 个 skin，实际 ${skins.length}`);
    const skin = skins[0];
    const jointNames = skin.listJoints().map((j) => j.getName());
    const ibmAcc = skin.getInverseBindMatrices();
    if (!ibmAcc) throw new Error(`${basename(file)}：skin 没有 inverseBindMatrices`);
    const ibm = ibmAcc.getArray()!;
    const isBase = out === null;
    if (isBase) {
      baseJointNames = jointNames;
      baseIbm = Float32Array.from(ibm);
      log(`骨骼来源 ${basename(file)}：${jointNames.length} 关节`);
    } else if (jointNames.join('|') !== baseJointNames.join('|')) {
      throw new Error(`${basename(file)} 的关节名序与骨骼来源不一致：\n${jointNames.join(',')}\nvs\n${baseJointNames.join(',')}`);
    }
    const ibmDiff = maxAbsDiff(ibm, baseIbm);
    const needsRepose = ibmDiff > 1e-5;

    // 2a. 在源文档里先把部件节点 / mesh 改名（合并后才能按唯一名找到）
    const partNodes: { node: Node; id: string; slot: Slot; set: string }[] = [];
    const armature = root.listNodes().find((n) => n.getName() === ARMATURE_NAME);
    if (!armature) throw new Error(`${basename(file)}：没有 ${ARMATURE_NAME} 节点`);
    for (const node of root.listNodes()) {
      const mesh = node.getMesh();
      if (!mesh) continue;
      const parsed = parsePartName(node.getName());
      if (!parsed) {
        skipped.push(`${basename(file)}:${node.getName()}`);
        continue;
      }
      if (node.getSkin() !== skin) throw new Error(`${basename(file)}:${node.getName()} 没有绑到 skin`);
      const id = `${pack.gender}_${parsed.set}_${parsed.slot}`;
      if (parts.some((p) => p.id === id) || partNodes.some((p) => p.id === id)) throw new Error(`部件 id 重复：${id}`);
      const name = `part:${parsed.slot}:${id}`;
      node.setName(name);
      mesh.setName(name);
      node.setExtras({ part: id, slot: parsed.slot, gender: pack.gender, set: parsed.set });
      partNodes.push({ node, id, slot: parsed.slot, set: parsed.set });
    }

    // 2b. 合并进输出文档
    let targetNodes: Node[];
    if (isBase) {
      out = doc;
      baseSkin = skin;
      baseArmature = armature;
      targetNodes = partNodes.map((p) => p.node);
      for (const anim of root.listAnimations()) keptAnimations.set(anim.getName(), basename(file));
      // 去掉非部件 mesh 节点（Pistol 等）
      for (const node of root.listNodes()) {
        if (node.getMesh() && !partNodes.some((p) => p.node === node)) node.dispose();
      }
    } else {
      const target = out!;
      const map = mergeDocuments(target, doc);
      const mergedScene = map.get(root.listScenes()[0]) as Scene | undefined;
      const mergedSkin = map.get(skin) as Skin;
      targetNodes = partNodes.map((p) => map.get(p.node) as Node);
      const moved = new Set(targetNodes);
      for (let i = 0; i < partNodes.length; i++) {
        const tn = targetNodes[i];
        const mesh = tn.getMesh()!;
        if (needsRepose) reposeMesh(mesh, mergedSkin.getInverseBindMatrices()!.getArray()!, baseIbm, baseJointNames.length);
        tn.setSkin(baseSkin!);
        baseArmature!.addChild(tn);
      }
      // 动画：同名只留第一份；新名字的通道按关节名重定向到 base 骨骼
      const baseJoints = baseSkin!.listJoints();
      for (const anim of root.listAnimations()) {
        const tAnim = map.get(anim) as Animation | undefined;
        if (!tAnim) continue;
        if (keptAnimations.has(tAnim.getName())) {
          // Animation.dispose() 不会连带释放 channel / sampler，不手动释放的话它们引用的 accessor 会留在文件里
          for (const ch of tAnim.listChannels()) ch.dispose();
          for (const sp of tAnim.listSamplers()) sp.dispose();
          tAnim.dispose();
          continue;
        }
        for (const ch of tAnim.listChannels()) {
          const tgt = ch.getTargetNode();
          const name = tgt?.getName() ?? '';
          const j = baseJoints.find((b) => b.getName() === name);
          if (!j) {
            warn(`${basename(file)} 动画 ${tAnim.getName()} 通道目标 ${name} 在 base 骨骼里不存在，已丢弃该通道`);
            ch.dispose();
            continue;
          }
          ch.setTargetNode(j);
        }
        keptAnimations.set(tAnim.getName(), basename(file));
        log(`新增动画 ${tAnim.getName()}（来自 ${basename(file)}）`);
      }
      // 清理合并进来的场景 / 骨架 / skin
      const disposeTree = (n: Node): void => {
        for (const c of n.listChildren()) disposeTree(c);
        if (!moved.has(n)) n.dispose();
      };
      if (mergedScene) {
        for (const c of mergedScene.listChildren()) disposeTree(c);
        mergedScene.dispose();
      }
      mergedSkin.dispose();
    }

    for (let i = 0; i < partNodes.length; i++) {
      const p = partNodes[i];
      const tn = targetNodes[i];
      parts.push({
        id: p.id,
        slot: p.slot,
        gender: pack.gender,
        set: p.set,
        label: PART_LABELS[p.id] ?? `${SET_LABELS[p.set] ?? p.set} ${p.slot}`,
        node: tn,
        mesh: tn.getMesh()!,
        source: `${pack.name}/${basename(file)}`,
      });
    }
    log(`${pack.gender} ${basename(file)}：${partNodes.length} 件${needsRepose ? `（绑定姿态与 base 差 ${ibmDiff.toFixed(3)}，已重蒙皮到 base 绑定姿态）` : ''}`);
  }
  if (!out || !baseSkin || !baseArmature) throw new Error('没有任何源文件');
  if (skipped.length) log(`跳过非四件套 mesh：${skipped.join(', ')}`);

  // 3. 帽子
  const headJoint = baseJointNames.indexOf('Head');
  if (headJoint < 0) throw new Error('骨骼里没有 Head 关节');
  const refHead = parts.find((p) => p.id === 'm_casual_head') ?? parts.find((p) => p.slot === 'head' && p.gender === 'm');
  if (!refHead) throw new Error('没有男性头部部件可做帽子参考');
  const byMat = (mesh: Mesh, name: string): Primitive | undefined => mesh.listPrimitives().find((pr) => pr.getMaterial()?.getName() === name);
  const skinPrim = byMat(refHead.mesh, 'Skin');
  const eyePrim = byMat(refHead.mesh, 'Eye');
  const hairPrim = byMat(refHead.mesh, 'Hair');
  if (!skinPrim || !eyePrim) throw new Error(`${refHead.id} 缺少 Skin / Eye 材质，无法定位帽子`);
  const skinB = primBounds(skinPrim);
  const eyeB = primBounds(eyePrim);
  const hairB = hairPrim ? unionBounds([primBounds(hairPrim), skinB]) : skinB;
  const forward: 1 | -1 = (eyeB.min[2] + eyeB.max[2]) / 2 > (skinB.min[2] + skinB.max[2]) / 2 ? 1 : -1;
  log(`参考头 ${refHead.id}：皮肤顶 y=${skinB.max[1].toFixed(3)} 发顶 y=${hairB.max[1].toFixed(3)} 宽 ${(hairB.max[0] - hairB.min[0]).toFixed(3)} 深 ${(hairB.max[2] - hairB.min[2]).toFixed(3)}`);
  const hatMat = out.createMaterial('Hat').setBaseColorFactor(srgbHexToLinear('#c0392b')).setMetallicFactor(0).setRoughnessFactor(0.8);
  const capMesh = buildCap(out, skinB, hairB, forward, headJoint, hatMat);
  const capNode = out.createNode('part:hat:cap').setMesh(capMesh).setSkin(baseSkin).setExtras({ part: 'cap', slot: 'hat', gender: 'any', set: 'procedural' });
  baseArmature.addChild(capNode);
  parts.push({ id: 'cap', slot: 'hat', gender: 'any', set: 'procedural', label: PART_LABELS.cap ?? '鸭舌帽', node: capNode, mesh: capMesh, source: 'procedural' });

  const workerHead = parts.find((p) => p.id === 'm_worker_head');
  const helmetSrc = workerHead ? byMat(workerHead.mesh, 'Worker_Yellow') : undefined;
  if (helmetSrc) {
    const helmetMat = out.createMaterial('Helmet').setBaseColorFactor(helmetSrc.getMaterial()!.getBaseColorFactor()).setMetallicFactor(0).setRoughnessFactor(0.6);
    const helmetMesh = buildHelmet(out, helmetSrc, helmetMat, 1.06);
    const helmetNode = out.createNode('part:hat:helmet').setMesh(helmetMesh).setSkin(baseSkin).setExtras({ part: 'helmet', slot: 'hat', gender: 'any', set: 'worker' });
    baseArmature.addChild(helmetNode);
    parts.push({ id: 'helmet', slot: 'hat', gender: 'any', set: 'worker', label: PART_LABELS.helmet ?? '安全帽', node: helmetNode, mesh: helmetMesh, source: 'Ultimate Modular Men/Worker.gltf (Worker_Head.Worker_Yellow)' });
    log(`安全帽：取自 m_worker_head 的 Worker_Yellow（${(helmetSrc.getIndices()?.getCount() ?? 0) / 3} tris），放大 1.06`);
  } else {
    warn('没有 m_worker_head / Worker_Yellow，跳过安全帽');
  }

  // 4. 材质去重：同名同色合并（不同名同色不合并，运行时按材质名换色）
  const matByKey = new Map<string, Material>();
  let matDup = 0;
  for (const mesh of out.getRoot().listMeshes()) {
    for (const prim of mesh.listPrimitives()) {
      const m = prim.getMaterial();
      if (!m) continue;
      if (m.getBaseColorTexture()) warn(`材质 ${m.getName()} 带贴图，运行时换色可能不生效`);
      const key = materialKey(m);
      const keep = matByKey.get(key);
      if (!keep) matByKey.set(key, m);
      else if (keep !== m) {
        prim.setMaterial(keep);
        matDup++;
      }
    }
  }
  for (const m of out.getRoot().listMaterials()) if (m.listParents().every((p) => p.propertyType === PropertyType.ROOT)) m.dispose();
  log(`材质：${out.getRoot().listMaterials().length} 个（合并掉 ${matDup} 个引用）`);
  // 检查同名不同色（运行时按名换色时要注意）
  const nameColors = new Map<string, Set<string>>();
  for (const m of out.getRoot().listMaterials()) {
    const s = nameColors.get(m.getName()) ?? new Set();
    s.add(linearToSrgbHex(m.getBaseColorFactor()));
    nameColors.set(m.getName(), s);
  }
  for (const [name, colors] of nameColors) if (colors.size > 1) log(`提示：材质名 ${name} 有 ${colors.size} 种颜色（${[...colors].join(' ')}），按名换色时以 catalog 的 part.materials 为准`);

  // 5. 优化：dedup（不含材质）→ prune → resample → quantize → 合并 quantize 复制出的 skin → prune
  await out.transform(
    dedup({ propertyTypes: [PropertyType.ACCESSOR, PropertyType.MESH] }),
    prune({ keepAttributes: false, keepLeaves: false }),
    resample(),
    quantize({
      quantizationVolume: 'scene',
      quantizePosition: 14,
      quantizeNormal: 8,
      quantizeWeight: 8,
      quantizeTexcoord: 12,
      quantizeColor: 8,
      quantizeGeneric: 12,
      cleanup: false, // 它内置的 dedup 会把不同名同色的材质合并，这里关掉自己收尾
    }),
    dedup({ propertyTypes: [PropertyType.ACCESSOR, PropertyType.SKIN] }),
  );
  // quantize 会给每个蒙皮节点克隆一份带修正矩阵的 skin；volume=scene 下矩阵全相同，这里合回一个
  {
    const skins = out.getRoot().listSkins();
    const groups: { skin: Skin; ibm: ArrayLike<number> }[] = [];
    let merged = 0;
    for (const node of out.getRoot().listNodes()) {
      const s = node.getSkin();
      if (!s) continue;
      const ibm = s.getInverseBindMatrices()!.getArray()!;
      const g = groups.find((x) => x.skin.listJoints().length === s.listJoints().length && maxAbsDiff(x.ibm, ibm) < 1e-6);
      if (!g) groups.push({ skin: s, ibm });
      else if (g.skin !== s) {
        node.setSkin(g.skin);
        merged++;
      }
    }
    for (const s of skins) if (s.listParents().every((p) => p.propertyType === PropertyType.ROOT)) s.dispose();
    const left = out.getRoot().listSkins();
    if (left.length !== 1) throw new Error(`quantize 后 skin 无法合并为一套：剩余 ${left.length} 个`);
    left[0].setName('CharacterSkeleton');
    baseSkin = left[0];
    log(`skin 合并：${merged} 个节点重新指向同一套骨骼`);
  }
  await out.transform(prune({ keepAttributes: false, keepLeaves: false }), unpartition());
  out.getRoot().listScenes()[0].setName('Characters');
  out.getRoot().getAsset().generator = 'rea scripts/char/build.ts (gltf-transform)';

  // 6. 写 glb
  await io.write(OUT_GLB, out);
  const size = statSync(OUT_GLB).size;

  // 7. 目录 catalog.json
  const finalJoints = baseSkin.listJoints().map((j) => j.getName());
  if (finalJoints.join('|') !== baseJointNames.join('|')) throw new Error('优化后关节名序变了');
  const sanitize = (s: string): string => s.replace(/\s/g, '_').replace(/[\[\]\.:\/]/g, '');
  const animNames = out.getRoot().listAnimations().map((a) => a.getName());
  const clips: Record<string, string> = {};
  for (const [alias, raw] of Object.entries(CLIP_ALIASES)) {
    if (!animNames.includes(raw)) {
      warn(`动画别名 ${alias} → ${raw} 不存在，已跳过`);
      continue;
    }
    clips[alias] = raw;
  }
  const catalogParts = parts.map((p) => {
    const mats: { name: string; role: Role; default: string }[] = [];
    for (const prim of p.mesh.listPrimitives()) {
      const m = prim.getMaterial();
      if (!m || mats.some((x) => x.name === m.getName())) continue;
      const override = ROLE_OVERRIDES[p.id]?.[m.getName()];
      const rule = ROLE_RULES[p.slot]?.[m.getName()];
      const role: Role = override ?? rule ?? 'fixed';
      if (!override && !rule) warn(`部件 ${p.id} 材质 ${m.getName()} 没有角色规则，标为 fixed`);
      mats.push({ name: m.getName(), role, default: linearToSrgbHex(m.getBaseColorFactor()) });
    }
    const tris = p.mesh.listPrimitives().reduce((s, pr) => s + (pr.getIndices()?.getCount() ?? pr.getAttribute('POSITION')!.getCount()) / 3, 0);
    return {
      id: p.id,
      slot: p.slot,
      gender: p.gender,
      set: p.set,
      label: p.label,
      node: p.node.getName(),
      nodeThree: sanitize(p.node.getName()),
      tris,
      source: p.source,
      materials: mats,
    };
  });
  // 预设校验：部件存在且 slot 正确
  const partIds = new Map(catalogParts.map((p) => [p.id, p]));
  for (const preset of PRESETS) {
    for (const [slot, id] of Object.entries(preset.parts)) {
      if (!id) continue;
      const p = partIds.get(id);
      if (!p) throw new Error(`预设 ${preset.id} 引用不存在的部件 ${id}`);
      if (p.slot !== slot) throw new Error(`预设 ${preset.id}：${id} 的 slot 是 ${p.slot}，放在了 ${slot}`);
      if (p.gender !== 'any' && p.gender !== preset.body) warn(`预设 ${preset.id}：${id} 性别 ${p.gender} 与 body ${preset.body} 不一致`);
    }
  }
  const catalog = {
    version: 1,
    file: 'characters.glb',
    generatedAt: new Date().toISOString(),
    attribution: { ...ATTRIBUTION, licenseFile: 'LICENSE-quaternius.txt' },
    notes: [
      '节点名 part:<slot>:<id>；three.js GLTFLoader 会去掉名字里的 ":" 和 "."（见 nodeThree），原名在 object.userData.name，extras 在 object.userData.{part,slot,gender,set}。',
      '关节名含 "."（如 Shoulder.L），three.js 里变成 ShoulderL（见 skeleton.jointsThree）。',
      '所有部件共用同一个 skin；位置 / 法线 / 权重已按 KHR_mesh_quantization 量化，量化修正已并入 skin 的 inverseBindMatrices，运行时直接 mergeGeometries + bind(skeleton) 即可。',
      '女包部件已重蒙皮到男包绑定姿态，只需男包的 24 段动画。',
      '材质按名换色时以 part.materials 的 name/role 为准（同名材质在男女包里可能颜色/语义不同，例如女包 Brown 是眼睛）。',
    ],
    skeleton: {
      joints: finalJoints,
      jointsThree: finalJoints.map(sanitize),
      head: 'Head',
      hips: 'Hips',
      armature: ARMATURE_NAME,
    },
    slots: SLOTS,
    parts: catalogParts,
    clips,
    clipsRaw: animNames,
    presets: PRESETS,
  };
  writeFileSync(OUT_CATALOG, JSON.stringify(catalog, null, 2) + '\n');

  // 8. 许可证
  const licenseText = PACKS.map((p) => `===== ${p.name} (${basename(dirname(p.license))}/License.txt) =====\n${readFileSync(p.license, 'utf8').trim()}\n`).join('\n');
  writeFileSync(OUT_LICENSE, `Quaternius Ultimate Modular Men / Women — CC0 1.0 Universal\n原文如下（两个包的 License.txt）：\n\n${licenseText}`);

  // 9. 回读校验 + 汇总
  const check = await io.read(OUT_GLB);
  const cr = check.getRoot();
  const counts: Record<string, number> = {};
  for (const p of catalogParts) counts[`${p.slot}/${p.gender}`] = (counts[`${p.slot}/${p.gender}`] ?? 0) + 1;
  const totalTris = catalogParts.reduce((s, p) => s + p.tris, 0);
  log('---- 结果 ----');
  log(`characters.glb：${fmtBytes(size)}${size > SIZE_BUDGET ? '（超过 4 MB 预算！）' : ''}`);
  log(`mesh ${cr.listMeshes().length} / material ${cr.listMaterials().length} / animation ${cr.listAnimations().length} / skin ${cr.listSkins().length}（${cr.listSkins()[0]?.listJoints().length} 关节）/ node ${cr.listNodes().length} / buffer ${cr.listBuffers().length}`);
  log(`部件 ${catalogParts.length} 件，共 ${totalTris} tris：${Object.entries(counts).sort().map(([k, v]) => `${k}=${v}`).join(' ')}`);
  log(`动画：${animNames.join(', ')}`);
  log(`扩展：${cr.listExtensionsUsed().map((e) => e.extensionName).join(', ') || '无'}`);
  log(`预设 ${PRESETS.length} 个：${PRESETS.map((p) => p.id).join(', ')}`);
  log(`写出：${OUT_GLB}\n              ${OUT_CATALOG}\n              ${OUT_LICENSE}`);
  if (size > SIZE_BUDGET) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
