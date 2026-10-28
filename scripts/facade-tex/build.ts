// 外墙细节贴图打包（P14.6）：ambientCG（CC0）照片扫描材质 → public/assets/facade/detail.webp
// 用法：npm run facade:build（Node 22 原生跑 .ts；需要系统 unzip 与 cwebp）
//
// 每种材质处理成「中性细节」一层（不带颜色，墙色仍由 FacadeShader 的 baseCol / 店屋粉彩决定）：
//   R = 亮度比 × 0.5（0.5 = 不变，0–2 倍）：高通（除以环绕模糊）保留颗粒/裂纹，低频斑块压到 LOWFREQ 次方，减轻平铺重复感
//   G、B = NormalGL 的 x、y
// 4 层纵向拼成 1024×4096，运行时切成 DataArrayTexture 的 4 层（src/world/FacadeDetail.ts）。层序与 FacadeShader 的层号一致。
// data/assets-eval/ 是不可信下载目录：zip 解压到各自空目录，只按路径读取 PNG，不执行其中任何东西。
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PNG } from 'pngjs';
import { PROJECT_ROOT } from '../lib/glb.ts';

const DL_DIR = resolve(PROJECT_ROOT, 'data/assets-eval/ambientcg');
const OUT_DIR = resolve(PROJECT_ROOT, 'public/assets/facade');
const OUT_WEBP = resolve(OUT_DIR, 'detail.webp');
const OUT_LICENSE = resolve(OUT_DIR, 'LICENSE-ambientcg.txt');
const TMP_PNG = resolve(DL_DIR, 'detail-strip.png');
const SIZE = 1024;
const SIZE_BUDGET = 2 * 1024 * 1024;
/** 低频亮度保留比例（0 = 完全去掉大斑块，1 = 原样） */
const LOWFREQ = 0.35;
/** 高通模糊半径（像素，环绕） */
const BLUR_R = 48;

/** 层序 = FacadeShader 层号：0 涂料抹灰 / 1 风化混凝土 / 2 店屋老抹灰 / 3 方砖 */
const LAYERS = ['PaintedPlaster017', 'Concrete012', 'Plaster007', 'Tiles038'];

const log = (msg: string): void => console.log(`[facade:build] ${msg}`);

function fetchLayer(id: string): string {
  const dir = resolve(DL_DIR, id);
  if (!existsSync(dir) || !readdirSync(dir).some((f) => f.endsWith('_Color.png'))) {
    mkdirSync(dir, { recursive: true });
    const zip = resolve(DL_DIR, `${id}_1K-PNG.zip`);
    if (!existsSync(zip)) {
      log(`下载 ${id}`);
      execFileSync('curl', ['-sfL', '-o', zip, `https://ambientcg.com/get?file=${id}_1K-PNG.zip`]);
    }
    execFileSync('unzip', ['-o', '-q', zip, '-d', dir]);
  }
  return dir;
}

function readPng(dir: string, suffix: string): PNG {
  const f = readdirSync(dir).find((n) => n.endsWith(suffix));
  if (!f) throw new Error(`${dir} 缺少 *${suffix}`);
  const png = PNG.sync.read(readFileSync(resolve(dir, f)));
  // 2:1 的材质（宽 1024 高 512，本身无缝）竖向平铺两遍成正方形，保持物理比例
  if (png.width === SIZE && png.height === SIZE / 2) {
    const sq = new PNG({ width: SIZE, height: SIZE });
    png.data.copy(sq.data, 0);
    png.data.copy(sq.data, png.data.length);
    return sq;
  }
  if (png.width !== SIZE || png.height !== SIZE) throw new Error(`${f} 尺寸 ${png.width}×${png.height}，应为 ${SIZE}² 或 ${SIZE}×${SIZE / 2}`);
  return png;
}

const toLin = (c: number): number => { const v = c / 255; return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };

/** 环绕盒式模糊（横竖各两遍 ≈ 高斯） */
function blurWrap(src: Float32Array, r: number): Float32Array {
  let a = src, b = new Float32Array(src.length);
  const w = 2 * r + 1;
  for (let pass = 0; pass < 4; pass++) {
    const horiz = pass % 2 === 0;
    for (let line = 0; line < SIZE; line++) {
      const at = (k: number): number => { const m = ((k % SIZE) + SIZE) % SIZE; return horiz ? line * SIZE + m : m * SIZE + line; };
      let sum = 0;
      for (let k = -r; k <= r; k++) sum += a[at(k)];
      for (let k = 0; k < SIZE; k++) {
        b[at(k)] = sum / w;
        sum += a[at(k + r + 1)] - a[at(k - r)];
      }
    }
    [a, b] = [b, a];
  }
  return a;
}

function processLayer(id: string, out: Buffer, layer: number): { mean: number } {
  const dir = fetchLayer(id);
  const col = readPng(dir, '_Color.png');
  const nrm = readPng(dir, '_NormalGL.png');
  const n = SIZE * SIZE;
  const lum = new Float32Array(n);
  let mean = 0;
  for (let i = 0; i < n; i++) {
    const p = i * 4;
    lum[i] = 0.2126 * toLin(col.data[p]) + 0.7152 * toLin(col.data[p + 1]) + 0.0722 * toLin(col.data[p + 2]);
    mean += lum[i];
  }
  mean /= n;
  const low = blurWrap(lum, BLUR_R);
  const base = layer * n * 4;
  for (let i = 0; i < n; i++) {
    const ratio = (lum[i] / Math.max(low[i], 1e-4)) * Math.pow(low[i] / mean, LOWFREQ);
    const p = base + i * 4;
    out[p] = Math.round(Math.min(2, Math.max(0, ratio)) * 0.5 * 255);
    out[p + 1] = nrm.data[i * 4];
    out[p + 2] = nrm.data[i * 4 + 1];
    out[p + 3] = 255;
  }
  return { mean };
}

function main(): void {
  mkdirSync(DL_DIR, { recursive: true });
  mkdirSync(OUT_DIR, { recursive: true });
  const strip = new PNG({ width: SIZE, height: SIZE * LAYERS.length });
  LAYERS.forEach((id, k) => {
    const { mean } = processLayer(id, strip.data, k);
    log(`层 ${k} ${id}：平均线性亮度 ${mean.toFixed(3)}`);
  });
  writeFileSync(TMP_PNG, PNG.sync.write(strip));
  execFileSync('cwebp', ['-quiet', '-q', '85', '-m', '6', '-exact', TMP_PNG, '-o', OUT_WEBP]);
  const size = statSync(OUT_WEBP).size;
  log(`→ ${OUT_WEBP}（${(size / 1024).toFixed(0)} KB）`);
  if (size > SIZE_BUDGET) throw new Error(`detail.webp 超出预算 ${SIZE_BUDGET / 1024} KB`);
  writeFileSync(OUT_LICENSE, [
    'ambientCG — CC0 1.0 Universal（https://docs.ambientcg.com/license/）',
    '公有领域，可商用、可再分发，无需署名。',
    '',
    '使用的材质（1K-PNG，经 scripts/facade-tex/build.ts 处理为亮度细节 + 法线，拼成 detail.webp）：',
    ...LAYERS.map((id, k) => `  层 ${k}：${id} — https://ambientcg.com/view?id=${id}`),
    '',
  ].join('\n'));
}

main();
