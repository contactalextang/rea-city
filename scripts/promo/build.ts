// 宣传素材合成（P16）：どこでもロケハン 导出的新加坡街景线稿 → README 头图 / OG 图 / itch 封面 / 标题画面背景
// 用法：npm run promo:build（Node 22 原生跑 .ts；需要系统 cwebp；playwright 无头 Chromium 做 canvas 合成）
//
// 源图（不入库，见 .gitignore）：
//   public/assets/promo/src/skyline_dusk.png、skyline_night.png（滨海湾远景）、chinatown.png、raffles.png
//   public/assets/story/*.png（剧情过场图）
// どこでもロケハン（https://tools.oyasumi-gamedev.com/rokehan/）条款：图可用于作品，但禁止再分发原始导出文件，
// 所以源图与合成结果都只随 dist 部署，不进 git。原图右下角的署名在裁切后可能丢失，合成时重新写上
// 「© OpenStreetMap contributors · © OpenMapTiles」。
//
// 输出 public/assets/promo/：banner.webp（1600×500）、og.png（1200×630）、cover.png（630×500）、title-bg.webp（1920×1080，≤ ~400KB）
// 另把 public/assets/story/*.png 转成同名 .webp（宽 1600，q80；webp 比 png 新则跳过）。
// 源图缺失只打印提示并跳过，不报错退出。
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { chromium } from 'playwright';
import { PROJECT_ROOT } from '../lib/glb.ts';

const PROMO_DIR = resolve(PROJECT_ROOT, 'public/assets/promo');
/** 源图目录；PROMO_SRC 环境变量可临时指向别处（调版式用） */
const SRC_DIR = process.env.PROMO_SRC ? resolve(process.env.PROMO_SRC) : resolve(PROMO_DIR, 'src');
const STORY_DIR = resolve(PROJECT_ROOT, 'public/assets/story');
/** 原图右下角署名：© OpenStreetMap contributors / © OpenMapTiles / 海拔：Terrain Tiles */
const ATTRIB = '© OpenStreetMap contributors · © OpenMapTiles · Terrain Tiles';
const SUB_ZH = '新加坡现实生活模拟';
const SUB_EN = 'A Singapore life sim';
const URL_TEXT = 'rea.alextang.dev';
/** 与 index.html 一致的系统字体栈（不引外链字体） */
const FONT = '"PingFang SC", "Helvetica Neue", Arial, sans-serif';
const TITLE_BG_BUDGET = 400 * 1024;

const log = (msg: string): void => console.log(`[promo:build] ${msg}`);

/** 一张输出图的版式（尺寸都是输出像素） */
interface Spec {
  out: string;
  /** 候选源图，按顺序取第一张存在的 */
  src: string[];
  w: number;
  h: number;
  /** 源图裁切焦点（0–1，cover 裁切时尽量让该点居中）与额外放大倍数 */
  fx: number;
  fy: number;
  zoom: number;
  /** 标题：中心 x、基线 y（0–1）、字号（px）；null = 不画字（纯背景） */
  title: null | { x: number; y: number; size: number };
  /** 副标题排法：一行（中 / 英）或两行 */
  subLines: 1 | 2;
  subSize: number;
  url: boolean;
  /** 署名字号 */
  attribSize: number;
  /** 顶部压暗程度（0–1），让天空更干净 */
  topShade: number;
  bottomShade: number;
  /** 源图模糊半径（px）：抹平网点，webp 才压得小（title-bg 用，反正会被压暗） */
  blur?: number;
}

const SPECS: Spec[] = [
  { out: 'banner.webp', src: ['skyline_dusk.png', 'skyline_night.png'], w: 1600, h: 500, fx: 0.5, fy: 0.25, zoom: 1, title: { x: 0.5, y: 0.42, size: 150 }, subLines: 1, subSize: 30, url: false, attribSize: 14, topShade: 0.15, bottomShade: 0.1 },
  { out: 'og.png', src: ['skyline_dusk.png', 'skyline_night.png'], w: 1200, h: 630, fx: 0.5, fy: 0.3, zoom: 1, title: { x: 0.5, y: 0.36, size: 168 }, subLines: 1, subSize: 34, url: true, attribSize: 14, topShade: 0.15, bottomShade: 0.15 },
  { out: 'cover.png', src: ['skyline_night.png', 'skyline_dusk.png'], w: 630, h: 500, fx: 0.5, fy: 0.4, zoom: 1, title: { x: 0.5, y: 0.34, size: 112 }, subLines: 2, subSize: 26, url: true, attribSize: 11, topShade: 0.15, bottomShade: 0.15 },
  { out: 'title-bg.webp', src: ['skyline_night.png', 'skyline_dusk.png'], w: 1920, h: 1080, fx: 0.5, fy: 0.33, zoom: 1, title: null, subLines: 1, subSize: 0, url: false, attribSize: 0, topShade: 0, bottomShade: 0, blur: 1.2 },
];

/** 在页面里跑的合成函数（序列化后传进浏览器，不能引用外部变量） */
async function renderInPage(arg: { spec: Spec; srcUrl: string; font: string; attrib: string; subZh: string; subEn: string; url: string }): Promise<string> {
  const { spec, srcUrl, font, attrib, subZh, subEn, url } = arg;
  const img = new Image();
  img.src = srcUrl;
  await img.decode();
  const cv = document.createElement('canvas');
  cv.width = spec.w; cv.height = spec.h;
  const g = cv.getContext('2d')!;
  g.fillStyle = '#fff'; g.fillRect(0, 0, spec.w, spec.h);

  // cover 裁切 + 焦点
  const s = Math.max(spec.w / img.width, spec.h / img.height) * spec.zoom;
  const dw = img.width * s, dh = img.height * s;
  const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));
  const dx = clamp(spec.w / 2 - spec.fx * dw, spec.w - dw, 0);
  const dy = clamp(spec.h / 2 - spec.fy * dh, spec.h - dh, 0);
  g.imageSmoothingQuality = 'high';
  if (spec.blur) g.filter = `blur(${spec.blur}px)`;
  g.drawImage(img, dx, dy, dw, dh);
  g.filter = 'none';

  const W = spec.w, H = spec.h;
  if (spec.topShade > 0) {
    const gr = g.createLinearGradient(0, 0, 0, H * 0.6);
    gr.addColorStop(0, `rgba(255,255,255,${spec.topShade * 4})`);
    gr.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = gr; g.fillRect(0, 0, W, H * 0.6);
  }
  if (spec.bottomShade > 0) {
    const gr = g.createLinearGradient(0, H * 0.75, 0, H);
    gr.addColorStop(0, 'rgba(0,0,0,0)');
    gr.addColorStop(1, `rgba(0,0,0,${spec.bottomShade * 3})`);
    g.fillStyle = gr; g.fillRect(0, H * 0.75, W, H * 0.25);
  }

  if (spec.title) {
    const tx = spec.title.x * W, ty = spec.title.y * H, ts = spec.title.size;
    const text = 'REA CITY';
    g.font = `italic 900 ${ts}px ${font}`;
    const tw = g.measureText(text).width;

    // 漫画集中线：以标题为中心向外放射的黑色细楔形，中间留白、外缘淡出
    const fx = document.createElement('canvas'); fx.width = W; fx.height = H;
    const f = fx.getContext('2d')!;
    let seed = 7;
    const rnd = (): number => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
    const R = Math.hypot(W, H);
    f.fillStyle = '#000';
    for (let a = 0; a < Math.PI * 2; a += 0.018 + rnd() * 0.035) {
      const half = 0.002 + rnd() * 0.005;
      const r0 = tw * (0.42 + rnd() * 0.18);
      f.beginPath();
      f.moveTo(tx + Math.cos(a) * r0 * 1.0, ty - ts * 0.35 + Math.sin(a) * r0 * 0.45);
      f.lineTo(tx + Math.cos(a - half) * R, ty - ts * 0.35 + Math.sin(a - half) * R);
      f.lineTo(tx + Math.cos(a + half) * R, ty - ts * 0.35 + Math.sin(a + half) * R);
      f.closePath(); f.fill();
    }
    // 只保留标题周围一圈（椭圆渐隐），不糊住天际线
    f.globalCompositeOperation = 'destination-in';
    f.save();
    f.translate(tx, ty - ts * 0.35); f.scale(1, 0.5);
    const rg = f.createRadialGradient(0, 0, tw * 0.45, 0, 0, tw * 0.95);
    rg.addColorStop(0, 'rgba(0,0,0,0.9)'); rg.addColorStop(1, 'rgba(0,0,0,0)');
    f.fillStyle = rg; f.fillRect(-W * 2, -H * 4, W * 4, H * 8);
    f.restore();
    // 标题背后先铺一层白色椭圆，让字从线稿里「跳」出来
    g.save();
    g.translate(tx, ty - ts * 0.35); g.scale(1, 0.42);
    const wg = g.createRadialGradient(0, 0, 0, 0, 0, tw * 0.62);
    wg.addColorStop(0, 'rgba(255,255,255,0.92)'); wg.addColorStop(0.75, 'rgba(255,255,255,0.75)'); wg.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = wg; g.beginPath(); g.arc(0, 0, tw * 0.62, 0, Math.PI * 2); g.fill();
    g.restore();
    g.drawImage(fx, 0, 0);

    // 标题：右倾 + 硬投影 + 粗黑描边 + 白字（字内网点单独一层，只落在白色字面上）
    const setT = (c: CanvasRenderingContext2D): void => {
      c.translate(tx, ty);
      c.transform(1, 0, -0.12, 1, 0, 0);
      c.rotate(-0.035);
      c.font = `900 ${ts}px ${font}`;
      c.textAlign = 'center'; c.textBaseline = 'alphabetic';
      c.lineJoin = 'round';
    };
    g.save();
    setT(g);
    const off = ts * 0.06;
    g.fillStyle = '#000'; g.strokeStyle = '#000';
    g.lineWidth = ts * 0.16; g.strokeText(text, off, off); g.fillText(text, off, off);
    g.lineWidth = ts * 0.13; g.strokeText(text, 0, 0);
    g.lineWidth = ts * 0.05; g.strokeStyle = '#fff'; g.strokeText(text, 0, 0);
    g.restore();
    const lay = document.createElement('canvas'); lay.width = W; lay.height = H;
    const l = lay.getContext('2d')!;
    l.save();
    setT(l);
    l.fillStyle = '#fff'; l.fillText(text, 0, 0);
    // 漫画网点阴影：字的下半部，越靠基线点越大
    l.globalCompositeOperation = 'source-atop';
    const dot = Math.max(3, ts * 0.04);
    l.fillStyle = '#000';
    for (let y = -ts * 0.4, row = 0; y < ts * 0.1; y += dot, row++) {
      const k = (y + ts * 0.4) / (ts * 0.4);
      const r = dot * 0.36 * Math.min(1, k);
      if (r < 0.5) continue;
      for (let x = -tw / 2 - ts; x < tw / 2 + ts; x += dot) {
        l.beginPath(); l.arc(x + (row & 1 ? dot / 2 : 0), y, r, 0, Math.PI * 2); l.fill();
      }
    }
    l.restore();
    g.drawImage(lay, 0, 0);

    // 副标题：黑底白字的漫画旁白框
    const subFont = (px: number): string => `700 ${px}px ${font}`;
    const lines = spec.subLines === 1 ? [`${subZh} / ${subEn}`] : [subZh, subEn];
    const ss = spec.subSize;
    g.font = subFont(ss);
    const lw = Math.max(...lines.map((l) => g.measureText(l).width));
    const padX = ss * 0.7, padY = ss * 0.4, lh = ss * 1.35;
    const bw = lw + padX * 2, bh = lh * lines.length + padY * 2 - (lh - ss * 1.1);
    const bx = tx - bw / 2, by = ty + ts * 0.22;
    g.save();
    g.translate(tx, by + bh / 2); g.rotate(-0.02); g.translate(-tx, -(by + bh / 2));
    g.fillStyle = '#fff'; g.fillRect(bx - 4, by - 4, bw + 8, bh + 8);
    g.fillStyle = '#000'; g.fillRect(bx, by, bw, bh);
    g.fillStyle = '#fff'; g.textAlign = 'center'; g.textBaseline = 'top';
    lines.forEach((l, i) => g.fillText(l, tx, by + padY + i * lh));
    g.restore();
  }

  // 角落：网址（左下）+ 署名（右下），白底黑字小标签保证可读
  const tag = (text: string, px: number, weight: number, right: boolean): void => {
    g.font = `${weight} ${px}px ${font}`;
    const m = g.measureText(text).width;
    const pad = px * 0.45, mg = px * 0.9;
    const bw = m + pad * 2, bh = px * 1.5;
    const x = right ? W - mg - bw : mg, y = H - mg - bh;
    g.fillStyle = 'rgba(255,255,255,0.88)'; g.fillRect(x, y, bw, bh);
    g.fillStyle = '#000'; g.textBaseline = 'middle'; g.textAlign = 'left';
    g.fillText(text, x + pad, y + bh / 2 + 1);
  };
  if (spec.attribSize > 0) tag(attrib, spec.attribSize, 500, true);
  if (spec.url) tag(url, Math.round(spec.attribSize * 1.6), 800, false);

  return cv.toDataURL('image/png');
}

function toWebp(png: string, out: string, q: number, extra: string[] = []): void {
  execFileSync('cwebp', ['-quiet', '-q', String(q), '-m', '6', ...extra, png, '-o', out]);
}

async function buildPromo(): Promise<void> {
  if (!existsSync(SRC_DIR)) { log(`缺少源图目录 ${SRC_DIR}，跳过宣传图（先用どこでもロケハン导出，见本文件头注释）`); return; }
  const jobs = SPECS.map((spec) => ({ spec, file: spec.src.find((f) => existsSync(resolve(SRC_DIR, f))) }));
  for (const j of jobs) if (!j.file) log(`跳过 ${j.spec.out}：源图 ${j.spec.src.join(' / ')} 都不存在`);
  const todo = jobs.filter((j) => j.file);
  if (!todo.length) return;

  const browser = await chromium.launch({ args: ['--use-gl=angle', '--enable-unsafe-swiftshader'] });
  try {
    const page = await browser.newPage();
    // 源图经伪域名路由给页面，保证同源、canvas 不被污染
    await page.route('https://promo.local/**', async (route) => {
      const name = decodeURIComponent(new URL(route.request().url()).pathname.slice(1));
      if (name === 'index.html') return route.fulfill({ contentType: 'text/html', body: '<!doctype html><meta charset="utf-8"><body></body>' });
      const p = resolve(SRC_DIR, name);
      if (!p.startsWith(SRC_DIR) || !existsSync(p)) return route.fulfill({ status: 404 });
      return route.fulfill({ path: p, contentType: 'image/png' });
    });
    await page.goto('https://promo.local/index.html');
    const tmp = resolve(tmpdir(), `rea-promo-${process.pid}.png`);
    for (const { spec, file } of todo) {
      const dataUrl = await page.evaluate(renderInPage, {
        spec, srcUrl: `https://promo.local/${encodeURIComponent(file!)}`, font: FONT, attrib: ATTRIB, subZh: SUB_ZH, subEn: SUB_EN, url: URL_TEXT,
      });
      const buf = Buffer.from(dataUrl.slice(dataUrl.indexOf(',') + 1), 'base64');
      const out = resolve(PROMO_DIR, spec.out);
      if (spec.out.endsWith('.png')) {
        writeFileSync(out, buf);
      } else {
        writeFileSync(tmp, buf);
        if (spec.out === 'title-bg.webp') {
          // 控制体积：从 q70 往下降，直到 ≤ 预算
          for (const q of [70, 62, 55, 48, 40]) {
            toWebp(tmp, out, q, ['-sharp_yuv']);
            if (statSync(out).size <= TITLE_BG_BUDGET) break;
          }
        } else {
          toWebp(tmp, out, 82);
        }
        unlinkSync(tmp);
      }
      log(`${spec.out} ← ${file}（${spec.w}×${spec.h}，${(statSync(out).size / 1024).toFixed(0)} KB）`);
    }
  } finally {
    await browser.close();
  }
}

function buildStory(): void {
  if (!existsSync(STORY_DIR)) { log(`缺少 ${STORY_DIR}，跳过剧情图`); return; }
  const pngs = readdirSync(STORY_DIR).filter((f) => f.toLowerCase().endsWith('.png'));
  if (!pngs.length) { log('public/assets/story/ 下没有 png，跳过剧情图'); return; }
  let n = 0;
  for (const f of pngs) {
    const src = resolve(STORY_DIR, f);
    const out = resolve(STORY_DIR, f.replace(/\.png$/i, '.webp'));
    if (existsSync(out) && statSync(out).mtimeMs >= statSync(src).mtimeMs) continue;
    toWebp(src, out, 80, ['-resize', '1600', '0']);
    n++;
    log(`story/${f} → ${f.replace(/\.png$/i, '.webp')}（${(statSync(out).size / 1024).toFixed(0)} KB）`);
  }
  log(`剧情图：转换 ${n} 张，跳过 ${pngs.length - n} 张（已是最新）`);
}

mkdirSync(PROMO_DIR, { recursive: true });
await buildPromo();
buildStory();
