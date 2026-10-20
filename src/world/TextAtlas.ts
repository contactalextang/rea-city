import * as THREE from 'three'

/**
 * 文字图集：一张 2048×2048 的 CanvasTexture，切成 16×36 个 128×56 像素的"单元"。
 * - num  槽 = 1 个单元（128×56，宽高比 2.29）：组屋楼号；
 * - wide 槽 = 同一行相邻 2 个单元（256×56，宽高比 4.57，与 1.6×0.35 m 路名牌一致）：其余所有招牌。
 * 槽按字符串 key 去重并引用计数；引用归零的槽不立即擦除，进入闲置队列（LRU），
 * 再次请求同一 key 时直接复用，分配不到空间时才按最久未用逐个回收。
 * 绘制只改 canvas，flush() 时一次性 needsUpdate 上传（区块中心变化时才会发生）。
 */
export type SlotKind = 'wide' | 'num'
export type Painter = (ctx: CanvasRenderingContext2D, w: number, h: number) => void

export const ATLAS_SIZE = 2048
export const UNIT_W = 128
export const UNIT_H = 56
const COLS = ATLAS_SIZE / UNIT_W            // 16
const ROWS = Math.floor(ATLAS_SIZE / UNIT_H) // 36
/** uv 内缩（像素）：防止线性过滤串到相邻槽 */
const INSET = 1.5

export interface AtlasSlot {
  key: string
  kind: SlotKind
  unit: number
  refs: number
  /** (u0, v0, du, dv)，可直接写进实例属性 */
  rect: [number, number, number, number]
}

export class TextAtlas {
  readonly canvas: HTMLCanvasElement
  readonly ctx: CanvasRenderingContext2D
  readonly texture: THREE.CanvasTexture
  private used = new Uint8Array(COLS * ROWS)
  private slots = new Map<string, AtlasSlot>()
  /** 引用归零的槽（Map 插入顺序即 LRU 顺序） */
  private idle = new Map<string, AtlasSlot>()
  private dirty = false
  /** 因图集满而放弃的请求次数 */
  dropped = 0
  /** 累计上传次数（调试） */
  uploads = 0

  constructor() {
    this.canvas = document.createElement('canvas')
    this.canvas.width = this.canvas.height = ATLAS_SIZE
    this.ctx = this.canvas.getContext('2d')!
    this.texture = new THREE.CanvasTexture(this.canvas)
    this.texture.colorSpace = THREE.SRGBColorSpace
    this.texture.anisotropy = 8
    this.texture.minFilter = THREE.LinearMipmapLinearFilter
    this.texture.magFilter = THREE.LinearFilter
  }

  /** 取得（必要时绘制）key 对应的槽；图集满返回 null */
  acquire(key: string, kind: SlotKind, paint: Painter): AtlasSlot | null {
    let s = this.slots.get(key)
    if (s) {
      if (s.refs === 0) this.idle.delete(key)
      s.refs++
      return s
    }
    let unit = this.alloc(kind)
    while (unit < 0 && this.idle.size) {
      const [k, old] = this.idle.entries().next().value as [string, AtlasSlot]
      this.idle.delete(k)
      this.free(old)
      unit = this.alloc(kind)
    }
    if (unit < 0) { this.dropped++; return null }
    const col = unit % COLS, row = Math.floor(unit / COLS)
    const w = kind === 'wide' ? UNIT_W * 2 : UNIT_W, h = UNIT_H
    const px = col * UNIT_W, py = row * UNIT_H
    const c = this.ctx
    c.save()
    c.clearRect(px, py, w, h)
    c.beginPath(); c.rect(px, py, w, h); c.clip()
    c.translate(px, py)
    paint(c, w, h)
    c.restore()
    this.dirty = true
    // CanvasTexture 默认 flipY：canvas 顶行对应 v = 1
    const S = ATLAS_SIZE
    s = {
      key, kind, unit, refs: 1,
      rect: [(px + INSET) / S, 1 - (py + h - INSET) / S, (w - INSET * 2) / S, (h - INSET * 2) / S],
    }
    this.slots.set(key, s)
    return s
  }

  /** 已分配槽的 uv 矩形 */
  rectOf(key: string): readonly number[] | null { return this.slots.get(key)?.rect ?? null }

  release(key: string) {
    const s = this.slots.get(key)
    if (!s || s.refs <= 0) return
    if (--s.refs === 0) this.idle.set(key, s)
  }

  private alloc(kind: SlotKind): number {
    const u = this.used
    if (kind === 'wide') {
      for (let k = 0; k < u.length; k += 2) if (!u[k] && !u[k + 1]) { u[k] = u[k + 1] = 1; return k }
      return -1
    }
    // num：优先填伙伴已被占用的半格，减少碎片
    let fallback = -1
    for (let k = 0; k < u.length; k++) {
      if (u[k]) continue
      if (u[k ^ 1]) { u[k] = 1; return k }
      if (fallback < 0) fallback = k
    }
    if (fallback >= 0) u[fallback] = 1
    return fallback
  }

  private free(s: AtlasSlot) {
    this.slots.delete(s.key)
    this.used[s.unit] = 0
    if (s.kind === 'wide') this.used[s.unit + 1] = 0
  }

  /** 有新绘制时上传一次 */
  flush() {
    if (!this.dirty) return
    this.dirty = false
    this.texture.needsUpdate = true
    this.uploads++
  }

  get stats() {
    let units = 0
    for (const v of this.used) units += v
    let live = 0
    for (const s of this.slots.values()) if (s.refs > 0) live++
    return { slots: this.slots.size, live, idle: this.idle.size, unitsUsed: units, unitsTotal: this.used.length, dropped: this.dropped, uploads: this.uploads }
  }

  dispose() {
    this.texture.dispose()
    this.slots.clear(); this.idle.clear(); this.used.fill(0)
  }
}

// ---------------------------------------------------------------------------
// 绘制辅助
// ---------------------------------------------------------------------------

export const FONT_LATIN = 'Arial, "Helvetica Neue", Helvetica, sans-serif'
export const FONT_CJK = '"PingFang SC", "Hiragino Sans GB", "Noto Sans CJK SC", "Microsoft YaHei", sans-serif'

/** 在 (x, y) 居中写一行字，字号从 size 往下缩到宽度 ≤ maxW */
export function fitText(c: CanvasRenderingContext2D, text: string, x: number, y: number, maxW: number, size: number, weight = 'bold', family = FONT_LATIN, align: CanvasTextAlign = 'center') {
  let s = size
  c.font = `${weight} ${s}px ${family}`
  const w = c.measureText(text).width
  if (w > maxW) { s = Math.max(8, Math.floor(s * maxW / w)); c.font = `${weight} ${s}px ${family}` }
  c.textAlign = align
  c.textBaseline = 'middle'
  c.fillText(text, x, y)
}

/** 圆角矩形路径 */
export function roundRect(c: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  c.beginPath()
  c.moveTo(x + r, y); c.lineTo(x + w - r, y); c.quadraticCurveTo(x + w, y, x + w, y + r)
  c.lineTo(x + w, y + h - r); c.quadraticCurveTo(x + w, y + h, x + w - r, y + h)
  c.lineTo(x + r, y + h); c.quadraticCurveTo(x, y + h, x, y + h - r)
  c.lineTo(x, y + r); c.quadraticCurveTo(x, y, x + r, y)
  c.closePath()
}
