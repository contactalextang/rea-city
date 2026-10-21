/**
 * 程序化生成胶片 LUT（33³ .cube，输入/输出都是 sRGB 显示域，作用在 AgX 色调映射之后）。
 * 不使用任何外部 LUT 素材：曲线、色相偏移全部在下面用数学定义。
 *   day.cube   —— 「Kodak 2383 风格」印片：轻 S 曲线、黑位略抬、暖高光、青暗部、高光轻微去饱和、红色加深
 *   night.cube —— 「青橙霓虹」：更强 S 曲线、暗部压青、高光偏橙、肤色/橙与青色相饱和加强、蓝向青偏
 * 运行：npm run lut:build（输出到 public/assets/lut/）
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

type RGB = [number, number, number]
const N = 33
const OUT = join(dirname(fileURLToPath(import.meta.url)), '../../public/assets/lut')

const clamp01 = (x: number) => Math.min(1, Math.max(0, x))
const luma = (c: RGB) => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]
const smooth = (a: number, b: number, x: number) => { const t = clamp01((x - a) / (b - a)); return t * t * (3 - 2 * t) }

/** S 曲线：以 pivot 为中心的有理 sigmoid 与原值按 k 混合；lift 抬黑位、roll 压白位（印片的黑/白点） */
function sCurve(x: number, k: number, pivot: number, lift: number, roll: number) {
  const g = 1.6
  const s = x < pivot
    ? pivot * Math.pow(x / pivot, g)
    : 1 - (1 - pivot) * Math.pow((1 - x) / (1 - pivot), g)
  const y = x + k * (s - x)
  return lift + y * (1 - lift - roll)
}

/** RGB ↔ HSV（色相 0–1） */
function rgb2hsv([r, g, b]: RGB): RGB {
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn
  let h = 0
  if (d > 1e-6) {
    if (mx === r) h = ((g - b) / d) % 6
    else if (mx === g) h = (b - r) / d + 2
    else h = (r - g) / d + 4
    h /= 6; if (h < 0) h += 1
  }
  return [h, mx > 0 ? d / mx : 0, mx]
}
function hsv2rgb([h, s, v]: RGB): RGB {
  const f = (n: number) => { const k = (n + h * 6) % 6; return v - v * s * Math.max(0, Math.min(k, 4 - k, 1)) }
  return [f(5), f(3), f(1)]
}
/** 色相距离（环形，0–0.5） */
const hueDist = (a: number, b: number) => { const d = Math.abs(a - b) % 1; return Math.min(d, 1 - d) }
/** 以 center 为中心、宽 w 的色相权重（余弦窗） */
const hueW = (h: number, center: number, w: number) => { const d = hueDist(h, center); return d >= w ? 0 : 0.5 + 0.5 * Math.cos(Math.PI * d / w) }

interface Look {
  curve: number; pivot: number; lift: number; roll: number
  /** 暗部 / 亮部加色（加在保持亮度的偏移上） */
  shadow: RGB; highlight: RGB
  /** 全局饱和、高光去饱和量 */
  sat: number; hiDesat: number
  /** 色相调整：[中心色相, 窗宽, 色相偏移, 饱和倍率] */
  hues: [number, number, number, number][]
}

function grade(c: RGB, L: Look): RGB {
  // 1) 色相/饱和（在曲线前做，曲线再定反差）
  let [h, s, v] = rgb2hsv(c)
  let sm = L.sat
  for (const [hc, w, dh, ds] of L.hues) {
    const k = hueW(h, hc, w)
    h = (h + dh * k + 1) % 1
    sm *= 1 + (ds - 1) * k
  }
  s = clamp01(s * sm)
  let o = hsv2rgb([h, s, v])
  // 2) 逐通道 S 曲线（印片的通道耦合简化为同一曲线）
  o = o.map((x) => sCurve(clamp01(x), L.curve, L.pivot, L.lift, L.roll)) as RGB
  // 3) 分离色调：按亮度权重加色（暗部 (1-l)²、亮部 l²），之后把亮度拉回原值，只改色相
  const l0 = luma(o)
  const ws = (1 - l0) * (1 - l0) * smooth(0.0, 0.08, l0), wh = l0 * l0
  o = o.map((x, i) => x + L.shadow[i] * ws + L.highlight[i] * wh) as RGB
  const l1 = luma(o)
  if (l1 > 1e-5) o = o.map((x) => x * (l0 / l1)) as RGB
  // 4) 高光去饱和（胶片肩部）
  const hd = L.hiDesat * smooth(0.6, 1.0, l0)
  o = o.map((x) => x + (l0 - x) * hd) as RGB
  return o.map(clamp01) as RGB
}

const DAY: Look = {
  curve: 0.32, pivot: 0.42, lift: 0.012, roll: 0.01,
  shadow: [-0.035, 0.006, 0.03], highlight: [0.035, 0.008, -0.04],
  sat: 1.0, hiDesat: 0.18,
  hues: [
    [0.0, 0.07, 0.0, 1.08],      // 红：加深
    [0.30, 0.10, -0.02, 0.9],    // 绿：偏黄、略降饱和（2383 的绿偏橄榄）
    [0.58, 0.08, -0.015, 0.95],  // 天蓝：略偏青
  ],
}
const NIGHT: Look = {
  curve: 0.42, pivot: 0.38, lift: 0.006, roll: 0.012,
  shadow: [-0.05, 0.012, 0.05], highlight: [0.06, 0.008, -0.055],
  sat: 1.04, hiDesat: 0.1,
  hues: [
    [0.07, 0.07, 0.0, 1.14],     // 橙 / 肤色：加强
    [0.5, 0.08, 0.0, 1.12],      // 青：加强
    [0.64, 0.1, -0.04, 1.0],     // 蓝 → 青
    [0.3, 0.1, 0.03, 0.85],      // 绿 → 偏青、降饱和（避免荧光绿）
    [0.85, 0.08, 0.0, 1.06],     // 品红霓虹：略加强
  ],
}

function cube(title: string, L: Look) {
  const lines = [`TITLE "${title}"`, `# REA City 程序化生成（scripts/lut/build.ts），sRGB 显示域`, `LUT_3D_SIZE ${N}`, 'DOMAIN_MIN 0.0 0.0 0.0', 'DOMAIN_MAX 1.0 1.0 1.0']
  // .cube 顺序：R 变化最快，其次 G，最后 B
  for (let b = 0; b < N; b++) for (let g = 0; g < N; g++) for (let r = 0; r < N; r++) {
    const o = grade([r / (N - 1), g / (N - 1), b / (N - 1)], L)
    lines.push(o.map((x) => x.toFixed(4)).join(' '))
  }
  return lines.join('\n') + '\n'
}

mkdirSync(OUT, { recursive: true })
for (const [name, title, look] of [['day', 'REA Print 2383-style', DAY], ['night', 'REA Teal-Orange Neon', NIGHT]] as const) {
  const text = cube(title, look)
  writeFileSync(join(OUT, `${name}.cube`), text)
  console.log(`${name}.cube  ${(text.length / 1024).toFixed(0)} KB`)
}
