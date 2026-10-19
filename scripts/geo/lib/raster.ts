// 简易 RGB 栅格：扫描线多边形填充（偶奇规则，支持带洞环）+ PNG 编码（pngjs）+ 缩略。
// 不引第三方栅格库；像素坐标系：x 向右（东），y 向下（南），与本地米制 [x, z] 同向。
import { PNG } from 'pngjs';

export type RGB = [number, number, number];
/** 像素坐标下的环：[[px, py], ...]（已由调用方把米制坐标换算到像素） */
export type PixRing = [number, number][];

export function hexToRgb(hex: string): RGB {
  const h = hex.replace('#', '');
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}

export class Raster {
  readonly width: number;
  readonly height: number;
  readonly data: Uint8Array;

  constructor(width: number, height: number, fill: RGB = [0, 0, 0]) {
    this.width = width;
    this.height = height;
    this.data = new Uint8Array(width * height * 3);
    for (let i = 0; i < width * height; i++) {
      this.data[i * 3] = fill[0];
      this.data[i * 3 + 1] = fill[1];
      this.data[i * 3 + 2] = fill[2];
    }
  }

  set(px: number, py: number, rgb: RGB): void {
    if (px < 0 || py < 0 || px >= this.width || py >= this.height) return;
    const i = (py * this.width + px) * 3;
    this.data[i] = rgb[0];
    this.data[i + 1] = rgb[1];
    this.data[i + 2] = rgb[2];
  }

  get(px: number, py: number): RGB {
    const i = (py * this.width + px) * 3;
    return [this.data[i], this.data[i + 1], this.data[i + 2]];
  }

  /** 水平线段填充 [x0, x1]（含端点），自动裁到栅格范围 */
  hspan(py: number, x0: number, x1: number, rgb: RGB): void {
    if (py < 0 || py >= this.height) return;
    const a = Math.max(0, x0);
    const b = Math.min(this.width - 1, x1);
    if (a > b) return;
    let i = (py * this.width + a) * 3;
    for (let x = a; x <= b; x++) {
      this.data[i++] = rgb[0];
      this.data[i++] = rgb[1];
      this.data[i++] = rgb[2];
    }
  }

  /**
   * 扫描线填充一个多边形（第一个环为外环，其余为洞；偶奇规则，所以洞自然被挖空）。
   * 采样点取像素中心 (px+0.5, py+0.5)。
   */
  fillPolygon(rings: PixRing[], rgb: RGB): void {
    scanlineFill(rings, this.height, (py, x0, x1) => this.hspan(py, x0, x1, rgb));
  }

  /** k 倍缩小（块平均） */
  downscale(k: number): Raster {
    const w = Math.max(1, Math.floor(this.width / k));
    const h = Math.max(1, Math.floor(this.height / k));
    const out = new Raster(w, h);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        let r = 0, g = 0, b = 0, n = 0;
        for (let dy = 0; dy < k; dy++) {
          const sy = y * k + dy;
          if (sy >= this.height) break;
          let i = (sy * this.width + x * k) * 3;
          for (let dx = 0; dx < k; dx++) {
            if (x * k + dx >= this.width) break;
            r += this.data[i++];
            g += this.data[i++];
            b += this.data[i++];
            n++;
          }
        }
        out.set(x, y, [Math.round(r / n), Math.round(g / n), Math.round(b / n)]);
      }
    }
    return out;
  }

  /** 编码为 PNG（RGB，无 alpha） */
  toPNG(): Buffer {
    const png = new PNG({ width: this.width, height: this.height, colorType: 2 });
    const src = this.data;
    const dst = png.data;
    for (let i = 0, j = 0; i < src.length; i += 3, j += 4) {
      dst[j] = src[i];
      dst[j + 1] = src[i + 1];
      dst[j + 2] = src[i + 2];
      dst[j + 3] = 255;
    }
    return PNG.sync.write(png, { colorType: 2 });
  }
}

/**
 * 偶奇规则扫描线：对每一行 py（采样 y = py + 0.5），收集所有环边与该行的交点 x，
 * 排序后成对填充；像素中心落在 [xa, xb] 内的像素才算在多边形内。
 */
export function scanlineFill(rings: PixRing[], height: number, span: (py: number, x0: number, x1: number) => void): void {
  // 收集边并求整体 y 范围
  const edges: [number, number, number, number][] = [];
  let yMin = Infinity, yMax = -Infinity;
  for (const ring of rings) {
    const n = ring.length;
    if (n < 3) continue;
    for (let i = 0; i < n; i++) {
      const a = ring[i];
      const b = ring[(i + 1) % n];
      if (a[1] === b[1]) continue; // 水平边不产生交点
      edges.push([a[0], a[1], b[0], b[1]]);
      if (a[1] < yMin) yMin = a[1];
      if (a[1] > yMax) yMax = a[1];
      if (b[1] < yMin) yMin = b[1];
      if (b[1] > yMax) yMax = b[1];
    }
  }
  if (edges.length === 0) return;
  const py0 = Math.max(0, Math.floor(yMin));
  const py1 = Math.min(height - 1, Math.ceil(yMax));
  // 按 y 下限排序 + 活动边表，避免每行扫全部边
  edges.sort((e, f) => Math.min(e[1], e[3]) - Math.min(f[1], f[3]));
  let next = 0;
  const active: [number, number, number, number][] = [];
  const xs: number[] = [];
  for (let py = py0; py <= py1; py++) {
    const yc = py + 0.5;
    while (next < edges.length && Math.min(edges[next][1], edges[next][3]) <= yc) active.push(edges[next++]);
    xs.length = 0;
    for (let i = active.length - 1; i >= 0; i--) {
      const [x1, y1, x2, y2] = active[i];
      const lo = Math.min(y1, y2);
      const hi = Math.max(y1, y2);
      if (hi <= yc) {
        active[i] = active[active.length - 1];
        active.pop();
        continue;
      }
      if (lo > yc) continue; // 还没到（活动表里按下限入表，可能略早）
      // 半开区间 [lo, hi)：上端点算、下端点不算，顶点处不会重复计数
      xs.push(x1 + ((yc - y1) * (x2 - x1)) / (y2 - y1));
    }
    if (xs.length < 2) continue;
    xs.sort((a, b) => a - b);
    for (let i = 0; i + 1 < xs.length; i += 2) {
      const a = Math.ceil(xs[i] - 0.5);
      const b = Math.floor(xs[i + 1] - 0.5);
      if (a <= b) span(py, a, b);
    }
  }
}

/** 点是否在多边形内（偶奇规则；rings[0] 外环，其余洞），输入与点同一坐标系 */
export function pointInPolygon(x: number, y: number, rings: PixRing[]): boolean {
  let inside = false;
  for (const ring of rings) {
    const n = ring.length;
    for (let i = 0, j = n - 1; i < n; j = i++) {
      const [xi, yi] = ring[i];
      const [xj, yj] = ring[j];
      if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
    }
  }
  return inside;
}
