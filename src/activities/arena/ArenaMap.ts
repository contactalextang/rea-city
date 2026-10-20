import * as THREE from 'three'
import { buildLayout, N, CELL, WALL, OBS_H, cellX, cellZ, toCell, SITES, type Layout, type Obs, type Pt } from './layout'

/** 轴对齐碰撞盒 */
export interface Box { minX: number; minY: number; minZ: number; maxX: number; maxY: number; maxZ: number; kind: 'wall' | 'floor' | Exclude<Obs, ''> }
export interface RayHit { t: number; nx: number; ny: number; nz: number; box: number }

/** 物理体（脚底原点） */
export interface Body { x: number; y: number; z: number; vx: number; vy: number; vz: number; onGround: boolean; h: number; r: number }

export const STEP = 0.45
export const GRAVITY = 20.8
const EPS = 1e-4

// ———————————————————— 程序化贴图 ————————————————————
function canvasTex(size: number, draw: (g: CanvasRenderingContext2D, s: number) => void, srgb = true): THREE.CanvasTexture {
  const c = document.createElement('canvas'); c.width = c.height = size
  const g = c.getContext('2d')!
  draw(g, size)
  const t = new THREE.CanvasTexture(c)
  t.wrapS = t.wrapT = THREE.RepeatWrapping
  t.anisotropy = 4
  if (srgb) t.colorSpace = THREE.SRGBColorSpace
  return t
}
let seed = 9137
const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647 }
const hash = (a: number, b: number) => { let h = (a * 374761393 + b * 668265263) | 0; h = (h ^ (h >>> 13)) * 1274126177; return ((h ^ (h >>> 16)) >>> 0) / 4294967295 }

function noise(g: CanvasRenderingContext2D, s: number, n: number, a: number, light = false) {
  for (let i = 0; i < n; i++) {
    const v = light ? 255 : 0
    g.fillStyle = `rgba(${v},${v},${v},${rnd() * a})`
    const w = 1 + rnd() * 3
    g.fillRect(rnd() * s, rnd() * s, w, w)
  }
}
function makeTextures() {
  seed = 9137
  // 地砖（铺路石，每格 2 m 一张 → 4×4 块）
  const paving = canvasTex(256, (g, s) => {
    g.fillStyle = '#c9bfae'; g.fillRect(0, 0, s, s)
    const n = 4, w = s / n
    for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) {
      const k = 0.88 + rnd() * 0.18
      g.fillStyle = `rgb(${201 * k | 0},${191 * k | 0},${174 * k | 0})`
      g.fillRect(i * w + 2, j * w + 2, w - 4, w - 4)
    }
    noise(g, s, 2500, 0.12); noise(g, s, 800, 0.08, true)
    g.strokeStyle = 'rgba(60,50,40,0.35)'; g.lineWidth = 2
    for (let i = 0; i <= n; i++) { g.beginPath(); g.moveTo(i * w, 0); g.lineTo(i * w, s); g.stroke(); g.beginPath(); g.moveTo(0, i * w); g.lineTo(s, i * w); g.stroke() }
  })
  // 灰泥墙（店屋外墙，顶点色给色相）
  const plaster = canvasTex(256, (g, s) => {
    g.fillStyle = '#e8e8e8'; g.fillRect(0, 0, s, s)
    noise(g, s, 6000, 0.07); noise(g, s, 2000, 0.06, true)
    // 雨痕
    for (let i = 0; i < 18; i++) { const x = rnd() * s; const grd = g.createLinearGradient(0, 0, 0, s); grd.addColorStop(0, 'rgba(0,0,0,0.0)'); grd.addColorStop(1, 'rgba(0,0,0,0.08)'); g.fillStyle = grd; g.fillRect(x, 0, 2 + rnd() * 6, s) }
  })
  // 货柜瓦楞
  const corrugated = canvasTex(256, (g, s) => {
    g.fillStyle = '#d8d8d8'; g.fillRect(0, 0, s, s)
    for (let x = 0; x < s; x += 16) {
      const grd = g.createLinearGradient(x, 0, x + 16, 0)
      grd.addColorStop(0, '#9a9a9a'); grd.addColorStop(0.3, '#f0f0f0'); grd.addColorStop(0.7, '#c8c8c8'); grd.addColorStop(1, '#8a8a8a')
      g.fillStyle = grd; g.fillRect(x, 0, 16, s)
    }
    noise(g, s, 3000, 0.1)
    g.fillStyle = 'rgba(110,60,30,0.18)'
    for (let i = 0; i < 40; i++) g.fillRect(rnd() * s, rnd() * s, 3 + rnd() * 10, 2 + rnd() * 18)
  })
  // 木箱
  const wood = canvasTex(256, (g, s) => {
    g.fillStyle = '#b08a58'; g.fillRect(0, 0, s, s)
    const pw = s / 6
    for (let i = 0; i < 6; i++) {
      const k = 0.85 + rnd() * 0.25
      g.fillStyle = `rgb(${176 * k | 0},${138 * k | 0},${88 * k | 0})`; g.fillRect(0, i * pw + 1, s, pw - 2)
      for (let j = 0; j < 30; j++) { g.fillStyle = `rgba(80,50,20,${rnd() * 0.25})`; g.fillRect(0, i * pw + rnd() * pw, s, 1) }
    }
    g.strokeStyle = '#6b4a2a'; g.lineWidth = 14; g.strokeRect(7, 7, s - 14, s - 14)
    g.lineWidth = 12; g.beginPath(); g.moveTo(10, 10); g.lineTo(s - 10, s - 10); g.stroke()
    noise(g, s, 1500, 0.12)
  })
  return { paving, plaster, corrugated, wood }
}

function siteDecal(letter: string): THREE.CanvasTexture {
  return canvasTex(256, (g, s) => {
    g.clearRect(0, 0, s, s)
    g.strokeStyle = 'rgba(200,40,30,0.85)'; g.lineWidth = 10
    g.beginPath(); g.arc(s / 2, s / 2, s * 0.42, 0, Math.PI * 2); g.stroke()
    g.fillStyle = 'rgba(200,40,30,0.85)'; g.font = `bold ${s * 0.55}px sans-serif`; g.textAlign = 'center'; g.textBaseline = 'middle'
    g.fillText(letter, s / 2, s / 2 + s * 0.03)
  })
}

// ———————————————————— 几何累积器 ————————————————————
class GeoBuilder {
  pos: number[] = []; nor: number[] = []; uv: number[] = []; col: number[] = []; idx: number[] = []
  quad(p: number[][], n: number[], uvs: number[][], cols: number[][]) {
    const b = this.pos.length / 3
    for (let i = 0; i < 4; i++) { this.pos.push(...p[i]); this.nor.push(...n); this.uv.push(...uvs[i]); this.col.push(...cols[i]) }
    this.idx.push(b, b + 1, b + 2, b, b + 2, b + 3)
  }
  build(): THREE.BufferGeometry {
    const g = new THREE.BufferGeometry()
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3))
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.nor, 3))
    g.setAttribute('uv', new THREE.Float32BufferAttribute(this.uv, 2))
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.col, 3))
    g.setIndex(this.pos.length / 3 > 65535 ? new THREE.Uint32BufferAttribute(this.idx, 1) : new THREE.Uint16BufferAttribute(this.idx, 1))
    g.computeBoundingSphere(); g.computeBoundingBox()
    return g
  }
}

/**
 * 盒子：侧面分两段（贴地 0–aoH 的接地 AO 渐变），顶面整色；uv 为世界坐标 / texScale。
 * skipBottom：底面不画。sides 位掩码：1 -x，2 +x，4 -z，8 +z，16 顶。
 */
function addBox(gb: GeoBuilder, x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, c: THREE.Color, texScale: number, ao = 0.55, aoH = 1.0, sides = 31) {
  const r = c.r, g = c.g, b = c.b
  const dark = [r * ao, g * ao, b * ao], lite = [r, g, b]
  const ym = Math.min(y1, y0 + aoH)
  const s = 1 / texScale
  const side = (ax: 'x' | 'z', fixed: number, a0: number, a1: number, n: number[]) => {
    // 两段：y0→ym（暗→亮），ym→y1（亮）
    const seg = (ya: number, yb: number, ca: number[], cb: number[]) => {
      if (yb - ya < 1e-4) return
      const P = (a: number, y: number) => ax === 'x' ? [fixed, y, a] : [a, y, fixed]
      const flip = (ax === 'x' && n[0] < 0) || (ax === 'z' && n[2] > 0)
      const A = flip ? a0 : a1, B = flip ? a1 : a0
      gb.quad([P(A, ya), P(B, ya), P(B, yb), P(A, yb)], n, [[A * s, ya * s], [B * s, ya * s], [B * s, yb * s], [A * s, yb * s]], [ca, ca, cb, cb])
    }
    seg(y0, ym, dark, lite); seg(ym, y1, lite, lite)
  }
  if (sides & 1) side('x', x0, z0, z1, [-1, 0, 0])
  if (sides & 2) side('x', x1, z0, z1, [1, 0, 0])
  if (sides & 4) side('z', z0, x0, x1, [0, 0, -1])
  if (sides & 8) side('z', z1, x0, x1, [0, 0, 1])
  if (sides & 16) gb.quad([[x0, y1, z1], [x1, y1, z1], [x1, y1, z0], [x0, y1, z0]], [0, 1, 0], [[x0 * s, z1 * s], [x1 * s, z1 * s], [x1 * s, z0 * s], [x0 * s, z0 * s]], [lite, lite, lite, lite])
}

/** 同 key 相邻格贪心合并为矩形 */
function greedy(key: (x: number, z: number) => string | null): { x0: number; z0: number; x1: number; z1: number; key: string }[] {
  const used: boolean[][] = Array.from({ length: N }, () => new Array(N).fill(false))
  const out: { x0: number; z0: number; x1: number; z1: number; key: string }[] = []
  for (let z = 0; z < N; z++) for (let x = 0; x < N; x++) {
    if (used[z][x]) continue
    const k = key(x, z); if (k === null) continue
    let x1 = x
    while (x1 + 1 < N && !used[z][x1 + 1] && key(x1 + 1, z) === k) x1++
    let z1 = z
    outer: while (z1 + 1 < N) {
      for (let xx = x; xx <= x1; xx++) if (used[z1 + 1][xx] || key(xx, z1 + 1) !== k) break outer
      z1++
    }
    for (let zz = z; zz <= z1; zz++) for (let xx = x; xx <= x1; xx++) used[zz][xx] = true
    out.push({ x0: x, z0: z, x1, z1, key: k })
  }
  return out
}

const SHOPHOUSE = [0xe9c9a0, 0xd6e6c8, 0xf2d2d6, 0xf3e3a6, 0xc8dceb, 0xe8dcc8, 0xd9c2e6, 0xf0e6d8, 0xb9d9cf]
const CONTAINER = [0xb03a2e, 0x2f5f8f, 0x2e7d4f, 0xd9822b, 0x7d7d7d, 0x8c2f5a, 0x3b8686, 0xc9a227]
const SHUTTER = [0x3f6b4a, 0x35506b, 0x6b4a35, 0x7a2f2f, 0x55606a]

/**
 * 竞技场地图：网格布局 → 合并网格（4 种材质，约 6 draw call）+ 碰撞盒 + 导航网格 + 射线检测 + 移动物理。
 */
export class ArenaMap {
  readonly layout: Layout
  readonly group = new THREE.Group()
  readonly boxes: Box[] = []
  /** 每格碰撞盒索引（物理宽相） */
  private cellBoxes: number[][] = []
  private stamp: Uint32Array
  private stampN = 1
  /** 导航：可走格与地面高度 */
  readonly walk: Uint8Array
  readonly height: Float32Array
  private disposables: { dispose(): void }[] = []
  /** 雷达底图（格颜色） */
  readonly radarCanvas: HTMLCanvasElement

  constructor() {
    this.layout = buildLayout()
    const L = this.layout
    this.walk = new Uint8Array(N * N); this.height = new Float32Array(N * N)
    for (let z = 0; z < N; z++) for (let x = 0; x < N; x++) {
      const f = L.floor[z][x]
      this.height[z * N + x] = f === WALL ? 99 : f
      this.walk[z * N + x] = f !== WALL && L.obs[z][x] === '' ? 1 : 0
    }
    for (let i = 0; i < N * N; i++) this.cellBoxes.push([])
    this.buildColliders()
    this.stamp = new Uint32Array(this.boxes.length + 8)
    this.buildMeshes()
    this.radarCanvas = this.buildRadar()
  }

  // ———————————————————— 碰撞盒 ————————————————————
  private addCollider(b: Box) {
    const i = this.boxes.length
    this.boxes.push(b)
    const cx0 = Math.max(0, toCell(b.minX + 0.01)), cx1 = Math.min(N - 1, toCell(b.maxX - 0.01))
    const cz0 = Math.max(0, toCell(b.minZ + 0.01)), cz1 = Math.min(N - 1, toCell(b.maxZ - 0.01))
    for (let z = cz0; z <= cz1; z++) for (let x = cx0; x <= cx1; x++) this.cellBoxes[z * N + x].push(i)
  }
  /** 矩形（格）→ 世界 AABB */
  private rectBox(r: { x0: number; z0: number; x1: number; z1: number }, y0: number, y1: number, kind: Box['kind']): Box {
    return { minX: cellX(r.x0) - CELL / 2, maxX: cellX(r.x1) + CELL / 2, minZ: cellZ(r.z0) - CELL / 2, maxZ: cellZ(r.z1) + CELL / 2, minY: y0, maxY: y1, kind }
  }
  private wallRects: { x0: number; z0: number; x1: number; z1: number; key: string; h: number }[] = []
  private floorRects: { x0: number; z0: number; x1: number; z1: number; key: string; h: number }[] = []
  private obsRects: { x0: number; z0: number; x1: number; z1: number; key: string; y0: number; h: number; o: Exclude<Obs, ''> }[] = []
  private buildColliders() {
    const L = this.layout
    for (const r of greedy((x, z) => L.floor[z][x] === WALL ? 'W' : null)) {
      const edge = r.x0 === 0 || r.z0 === 0 || r.x1 === N - 1 || r.z1 === N - 1
      const h = edge ? 11 : 6.5 + Math.floor(hash(r.x0, r.z0) * 4) * 1.0
      this.wallRects.push({ ...r, h })
      this.addCollider(this.rectBox(r, -1, h, 'wall'))
    }
    for (const r of greedy((x, z) => L.floor[z][x] > 0 ? String(L.floor[z][x]) : null)) {
      const h = Number(r.key)
      this.floorRects.push({ ...r, h })
      this.addCollider(this.rectBox(r, -1, h, 'floor'))
    }
    for (const r of greedy((x, z) => L.floor[z][x] !== WALL && L.obs[z][x] ? L.obs[z][x] + '@' + L.floor[z][x] : null)) {
      const [o, f] = r.key.split('@'); const y0 = Number(f), oo = o as Exclude<Obs, ''>
      const h = OBS_H[oo]
      this.obsRects.push({ ...r, y0, h, o: oo })
      this.addCollider(this.rectBox(r, y0, y0 + h, oo))
    }
  }

  // ———————————————————— 网格 ————————————————————
  private buildMeshes() {
    const L = this.layout
    const tex = makeTextures()
    this.disposables.push(tex.paving, tex.plaster, tex.corrugated, tex.wood)
    const mk = (map: THREE.Texture, rough: number, metal = 0) => { const m = new THREE.MeshStandardMaterial({ map, vertexColors: true, roughness: rough, metalness: metal }); this.disposables.push(m); return m }
    const mFloor = mk(tex.paving, 0.92), mWall = mk(tex.plaster, 0.88), mCont = mk(tex.corrugated, 0.55, 0.35), mWood = mk(tex.wood, 0.8)
    const gFloor = new GeoBuilder(), gWall = new GeoBuilder(), gCont = new GeoBuilder(), gWood = new GeoBuilder(), gDeco = new GeoBuilder()
    const c = new THREE.Color()
    const solidTop = (x: number, z: number) => {
      if (x < 0 || z < 0 || x >= N || z >= N) return 99
      const f = L.floor[z][x]; if (f === WALL) return 99
      const o = L.obs[z][x]; return f + (o ? OBS_H[o] : 0)
    }
    // 地面（高度 0 的格，逐格四角 AO）
    for (let z = 0; z < N; z++) for (let x = 0; x < N; x++) {
      if (L.floor[z][x] !== 0) continue
      const x0 = cellX(x) - 1, x1 = x0 + 2, z0 = cellZ(z) - 1, z1 = z0 + 2
      const corner = (dx: number, dz: number) => {
        let n = 0
        for (const [ax, az] of [[x + dx, z + dz], [x, z + dz], [x + dx, z]]) if (solidTop(ax, az) > 0.5) n++
        const k = 1 - n * 0.14
        const tint = 0.96 + hash(x * 3 + dx, z * 7 + dz) * 0.06
        return [k * tint, k * tint * 0.99, k * tint * 0.97]
      }
      const s = 0.5
      gFloor.quad([[x0, 0, z1], [x1, 0, z1], [x1, 0, z0], [x0, 0, z0]], [0, 1, 0], [[x0 * s, z1 * s], [x1 * s, z1 * s], [x1 * s, z0 * s], [x0 * s, z0 * s]], [corner(-1, 1), corner(1, 1), corner(1, -1), corner(-1, -1)])
    }
    // 高台（顶面石材，侧面水泥）
    for (const r of this.floorRects) {
      const b = this.rectBox(r, 0, r.h, 'floor')
      c.setRGB(0.86, 0.84, 0.8)
      addBox(gFloor, b.minX, b.maxY - 0.001, b.minZ, b.maxX, b.maxY, b.maxZ, c, 2, 1, 0, 16)
      c.setRGB(0.62, 0.6, 0.57)
      addBox(gWall, b.minX, 0, b.minZ, b.maxX, b.maxY, b.maxZ, c, 2, 0.6, 0.6, 15)
    }
    // 店屋 / 仓库
    for (const r of this.wallRects) {
      const b = this.rectBox(r, 0, r.h, 'wall')
      const hue = SHOPHOUSE[Math.floor(hash(r.x0 + 11, r.z0 + 5) * SHOPHOUSE.length)]
      c.setHex(hue)
      addBox(gWall, b.minX, 0, b.minZ, b.maxX, b.maxY, b.maxZ, c, 3, 0.55, 1.2)
      // 屋顶压檐（深色）
      c.setHex(0x6b5a4a)
      addBox(gDeco, b.minX - 0.15, b.maxY, b.minZ - 0.15, b.maxX + 0.15, b.maxY + 0.35, b.maxZ + 0.15, c, 2, 1, 0)
      this.facade(gDeco, r, b)
    }
    // 障碍物
    for (const r of this.obsRects) {
      const b = this.rectBox(r, r.y0, r.y0 + r.h, r.o)
      if (r.o === 'k' || r.o === 'K') {
        // 货柜：每格留 0.08 m 缝不明显，整体略内收 0.05
        const col = CONTAINER[Math.floor(hash(r.x0 * 5 + 1, r.z0 * 3 + 2) * CONTAINER.length)]
        c.setHex(col)
        if (r.o === 'K') {
          addBox(gCont, b.minX + 0.05, b.minY, b.minZ + 0.05, b.maxX - 0.05, b.minY + 2.6, b.maxZ - 0.05, c, 2.6, 0.6, 0.8)
          c.setHex(CONTAINER[Math.floor(hash(r.x0 * 7 + 3, r.z0 * 11 + 1) * CONTAINER.length)])
          addBox(gCont, b.minX + 0.05, b.minY + 2.6, b.minZ + 0.05, b.maxX - 0.05, b.maxY, b.maxZ - 0.05, c, 2.6, 1, 0)
        } else addBox(gCont, b.minX + 0.05, b.minY, b.minZ + 0.05, b.maxX - 0.05, b.maxY, b.maxZ - 0.05, c, 2.6, 0.6, 0.8)
      } else if (r.o === 'w') {
        c.setRGB(0.7, 0.69, 0.66)
        addBox(gWall, b.minX + 0.1, b.minY, b.minZ + 0.1, b.maxX - 0.1, b.maxY, b.maxZ - 0.1, c, 2, 0.6, 0.5)
      } else {
        // 木箱：每格一个独立箱子（视觉），碰撞仍为合并盒
        for (let z = r.z0; z <= r.z1; z++) for (let x = r.x0; x <= r.x1; x++) {
          const cx = cellX(x), cz = cellZ(z)
          const k = 0.9 + hash(x, z) * 0.2
          c.setRGB(k, k * 0.97, k * 0.92)
          addBox(gWood, cx - 0.98, b.minY, cz - 0.98, cx + 0.98, b.minY + 1.1, cz + 0.98, c, 1.96, 0.65, 0.5)
          if (r.o === 'C') addBox(gWood, cx - 0.98, b.minY + 1.1, cz - 0.98, cx + 0.98, b.maxY, cz + 0.98, c, 1.96, 0.85, 0.3)
        }
      }
    }
    // 远景：天际线 + 码头吊机剪影
    const gSky = new GeoBuilder()
    seed = 4242
    for (let i = 0; i < 70; i++) {
      const a = (i / 70) * Math.PI * 2 + rnd() * 0.05, d = 150 + rnd() * 110
      const w = 10 + rnd() * 22, h = 18 + rnd() * (i % 5 === 0 ? 110 : 45)
      const x = Math.cos(a) * d, z = Math.sin(a) * d
      const k = 0.55 + rnd() * 0.2
      c.setRGB(k * 0.78, k * 0.82, k * 0.9)
      addBox(gSky, x - w / 2, 0, z - w / 2, x + w / 2, h, z + w / 2, c, 50, 1, 0, 31)
    }
    // 吊机（东南海港方向）
    for (let i = 0; i < 5; i++) {
      const x = 90 + i * 28, z = 120 + (i % 2) * 10
      c.setHex(0xc8452c)
      addBox(gSky, x - 1, 0, z - 6, x + 1, 42, z - 4, c, 50, 1, 0); addBox(gSky, x - 1, 0, z + 4, x + 1, 42, z + 6, c, 50, 1, 0)
      addBox(gSky, x - 1.2, 40, z - 30, x + 1.2, 43, z + 14, c, 50, 1, 0)
    }
    const mSky = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 1 }); this.disposables.push(mSky)

    const add = (gb: GeoBuilder, m: THREE.Material, shadow = true) => {
      if (!gb.pos.length) return
      const geo = gb.build(); this.disposables.push(geo)
      const mesh = new THREE.Mesh(geo, m)
      mesh.castShadow = shadow; mesh.receiveShadow = true
      mesh.matrixAutoUpdate = false; mesh.updateMatrix()
      this.group.add(mesh)
    }
    const mDeco = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.6, metalness: 0.05 }); this.disposables.push(mDeco)
    add(gFloor, mFloor); add(gWall, mWall); add(gCont, mCont); add(gWood, mWood); add(gDeco, mDeco); add(gSky, mSky, false)
    // 远处地面（地图外）
    const outer = new THREE.PlaneGeometry(800, 800); outer.rotateX(-Math.PI / 2); this.disposables.push(outer)
    const mOuter = new THREE.MeshStandardMaterial({ color: 0x8f8a80, roughness: 1 }); this.disposables.push(mOuter)
    const om = new THREE.Mesh(outer, mOuter); om.position.y = -0.02; om.receiveShadow = false; this.group.add(om)

    // 包点地标
    for (const [id, s] of Object.entries(SITES)) {
      const t = siteDecal(id); this.disposables.push(t)
      const m = new THREE.MeshBasicMaterial({ map: t, transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, toneMapped: true }); this.disposables.push(m)
      const g = new THREE.PlaneGeometry(5, 5); g.rotateX(-Math.PI / 2); this.disposables.push(g)
      const mesh = new THREE.Mesh(g, m)
      mesh.position.set(s.center.x, this.groundAt(s.center.x, s.center.z) + 0.02, s.center.z)
      mesh.renderOrder = 1
      this.group.add(mesh)
    }
  }

  /** 店屋立面细节：底层百叶门 + 骑楼雨棚（五脚基）+ 二楼窗 + 腰线 */
  private facade(gb: GeoBuilder, r: { x0: number; z0: number; x1: number; z1: number }, b: Box) {
    const L = this.layout
    const c = new THREE.Color()
    const open = (x: number, z: number) => x >= 0 && z >= 0 && x < N && z < N && L.floor[z][x] !== WALL
    const awn = hash(r.x0 * 13, r.z1 * 17) < 0.45
    const awnCol = SHUTTER[Math.floor(hash(r.x1, r.z0) * SHUTTER.length)]
    const faces: { cells: [number, number][]; dir: [number, number] }[] = []
    const f1: [number, number][] = [], f2: [number, number][] = [], f3: [number, number][] = [], f4: [number, number][] = []
    for (let x = r.x0; x <= r.x1; x++) { if (open(x, r.z0 - 1)) f1.push([x, r.z0]); if (open(x, r.z1 + 1)) f2.push([x, r.z1]) }
    for (let z = r.z0; z <= r.z1; z++) { if (open(r.x0 - 1, z)) f3.push([r.x0, z]); if (open(r.x1 + 1, z)) f4.push([r.x1, z]) }
    faces.push({ cells: f1, dir: [0, -1] }, { cells: f2, dir: [0, 1] }, { cells: f3, dir: [-1, 0] }, { cells: f4, dir: [1, 0] })
    for (const f of faces) for (const [x, z] of f.cells) {
      const cx = cellX(x), cz = cellZ(z)
      const [dx, dz] = f.dir
      // 面上的点：沿面切向 t ∈ [-1,1]，外推 o
      const box = (t0: number, t1: number, y0: number, y1: number, o0: number, o1: number, hex: number, ao = 1) => {
        c.setHex(hex)
        const fx = dx !== 0 ? (dx > 0 ? b.maxX : b.minX) : 0, fz = dz !== 0 ? (dz > 0 ? b.maxZ : b.minZ) : 0
        if (dx !== 0) { const xa = fx + dx * o0, xb = fx + dx * o1; addBox(gb, Math.min(xa, xb), y0, cz + t0, Math.max(xa, xb), y1, cz + t1, c, 1, ao, 0.5) }
        else { const za = fz + dz * o0, zb = fz + dz * o1; addBox(gb, cx + t0, y0, Math.min(za, zb), cx + t1, y1, Math.max(za, zb), c, 1, ao, 0.5) }
      }
      const shut = SHUTTER[Math.floor(hash(x * 3 + 1, z * 5 + 2) * SHUTTER.length)]
      if (b.maxY > 4) {
        // 二楼窗（深色玻璃 + 白窗框）
        box(-0.6, 0.6, 3.7, 5.1, 0, 0.05, 0xf0ebe0)
        box(-0.5, 0.5, 3.8, 5.0, 0.04, 0.07, 0x26323d)
        // 腰线
        box(-1, 1, 3.2, 3.35, 0, 0.12, 0xf2eee6)
      }
      if ((x + z) % 2 === 0) box(-0.75, 0.75, 0.05, 2.5, 0, 0.05, shut, 0.8)   // 百叶门
      if (awn) box(-1, 1, 3.45, 3.57, 0, 1.0, awnCol, 1)
    }
  }

  private buildRadar(): HTMLCanvasElement {
    const cv = document.createElement('canvas'); cv.width = cv.height = N * 4
    const g = cv.getContext('2d')!
    const L = this.layout
    for (let z = 0; z < N; z++) for (let x = 0; x < N; x++) {
      const f = L.floor[z][x], o = L.obs[z][x]
      g.fillStyle = f === WALL ? 'rgba(20,24,30,0.0)' : o ? (o === 'k' || o === 'K' || o === 'C' ? '#4b5563' : '#6b7280') : f > 0 ? '#a3a9b3' : '#8b93a1'
      g.fillRect(x * 4, z * 4, 4, 4)
    }
    g.fillStyle = 'rgba(220,60,40,0.9)'; g.font = 'bold 22px sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle'
    for (const [id, s] of Object.entries(SITES)) g.fillText(id, (toCell(s.center.x) + 0.5) * 4, (toCell(s.center.z) + 0.5) * 4)
    return cv
  }

  // ———————————————————— 查询 ————————————————————
  inBounds(cx: number, cz: number) { return cx >= 0 && cz >= 0 && cx < N && cz < N }
  zoneAt(x: number, z: number): string { const cx = toCell(x), cz = toCell(z); return this.inBounds(cx, cz) ? this.layout.zone[cz][cx] : '' }
  /** 格子地面高度（不含障碍） */
  groundAt(x: number, z: number): number { const cx = toCell(x), cz = toCell(z); if (!this.inBounds(cx, cz)) return 0; const f = this.layout.floor[cz][cx]; return f === WALL ? 0 : f }

  /** 射线：o + d·t，t ∈ (0, maxT]；d 不必归一化（t 以 |d| 为单位）。含地面 y=0。 */
  raycast(ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, maxT: number, out?: RayHit): RayHit | null {
    let best = maxT, bi = -2, nx = 0, ny = 0, nz = 0
    if (dy < -1e-9) { const t = -oy / dy; if (t > 0 && t < best) { best = t; bi = -1; nx = 0; ny = 1; nz = 0 } }
    const ix = 1 / dx, iy = 1 / dy, iz = 1 / dz
    const B = this.boxes
    for (let i = 0; i < B.length; i++) {
      const b = B[i]
      let t0 = (b.minX - ox) * ix, t1 = (b.maxX - ox) * ix
      let tmin = Math.min(t0, t1), tmax = Math.max(t0, t1), ax = 0
      t0 = (b.minY - oy) * iy; t1 = (b.maxY - oy) * iy
      let a = Math.min(t0, t1), c = Math.max(t0, t1)
      if (a > tmin) { tmin = a; ax = 1 }
      if (c < tmax) tmax = c
      t0 = (b.minZ - oz) * iz; t1 = (b.maxZ - oz) * iz
      a = Math.min(t0, t1); c = Math.max(t0, t1)
      if (a > tmin) { tmin = a; ax = 2 }
      if (c < tmax) tmax = c
      if (tmax < tmin || tmax <= 0 || tmin >= best) continue
      if (tmin <= 0) continue   // 起点在盒内：忽略（相机贴墙时不自挡）
      best = tmin; bi = i
      nx = ax === 0 ? -Math.sign(dx) : 0; ny = ax === 1 ? -Math.sign(dy) : 0; nz = ax === 2 ? -Math.sign(dz) : 0
    }
    if (bi === -2) return null
    const h = out ?? { t: 0, nx: 0, ny: 0, nz: 0, box: 0 }
    h.t = best; h.nx = nx; h.ny = ny; h.nz = nz; h.box = bi
    return h
  }
  /** a→b 线段是否被地图挡住 */
  blocked(ax: number, ay: number, az: number, bx: number, by: number, bz: number): boolean {
    return this.raycast(ax, ay, az, bx - ax, by - ay, bz - az, 0.999) !== null
  }

  // ———————————————————— 物理 ————————————————————
  private query(minX: number, minZ: number, maxX: number, maxZ: number, cb: (b: Box) => boolean | void): boolean {
    const s = ++this.stampN
    const cx0 = Math.max(0, toCell(minX)), cx1 = Math.min(N - 1, toCell(maxX)), cz0 = Math.max(0, toCell(minZ)), cz1 = Math.min(N - 1, toCell(maxZ))
    for (let z = cz0; z <= cz1; z++) for (let x = cx0; x <= cx1; x++) {
      for (const i of this.cellBoxes[z * N + x]) {
        if (this.stamp[i] === s) continue
        this.stamp[i] = s
        if (cb(this.boxes[i])) return true
      }
    }
    return false
  }
  /** 体积 (x,y,z,h,r) 是否与任何盒相交；hits 收集相交盒 */
  overlap(x: number, y: number, z: number, h: number, r: number, hits?: Box[]): boolean {
    if (hits) hits.length = 0
    let any = false
    this.query(x - r, z - r, x + r, z + r, (b) => {
      if (b.minX < x + r && b.maxX > x - r && b.minZ < z + r && b.maxZ > z - r && b.minY < y + h && b.maxY > y + 0.01) {
        any = true
        if (!hits) return true
        hits.push(b)
      }
    })
    // 地图外边界
    const lim = N * CELL / 2 - 0.5
    if (Math.abs(x) > lim || Math.abs(z) > lim) any = true
    return any
  }
  /** 脚下支撑高度（顶面 ≤ y+tol 的最高盒顶，或 0） */
  support(x: number, y: number, z: number, r: number, tol = 0.05): number {
    let best = 0
    this.query(x - r, z - r, x + r, z + r, (b) => {
      if (b.minX < x + r && b.maxX > x - r && b.minZ < z + r && b.maxZ > z - r && b.maxY <= y + tol && b.maxY > best) best = b.maxY
    })
    return best
  }
  /** 头顶最低盒底（> y+h-tol） */
  private ceiling(x: number, y: number, z: number, r: number, h: number): number {
    let best = Infinity
    this.query(x - r, z - r, x + r, z + r, (b) => {
      if (b.minX < x + r && b.maxX > x - r && b.minZ < z + r && b.maxZ > z - r && b.minY >= y + h - 0.05 && b.minY < best) best = b.minY
    })
    return best
  }
  private hits: Box[] = []
  private moveAxis(b: Body, dx: number, dz: number): boolean {
    const nx = b.x + dx, nz = b.z + dz
    if (!this.overlap(nx, b.y, nz, b.h, b.r, this.hits)) { b.x = nx; b.z = nz; return true }
    // 上台阶
    if (b.onGround) {
      let top = 0
      for (const h of this.hits) top = Math.max(top, h.maxY)
      if (top - b.y <= STEP && !this.overlap(nx, top + 0.001, nz, b.h, b.r)) { b.x = nx; b.z = nz; b.y = top + 0.001; return true }
    }
    // 贴到盒边
    if (dx !== 0) {
      let lim = dx > 0 ? Infinity : -Infinity
      for (const h of this.hits) lim = dx > 0 ? Math.min(lim, h.minX - b.r - EPS) : Math.max(lim, h.maxX + b.r + EPS)
      if (isFinite(lim) && (dx > 0 ? lim >= b.x - 0.01 : lim <= b.x + 0.01) && !this.overlap(lim, b.y, b.z, b.h, b.r)) b.x = lim
      b.vx = 0
    } else {
      let lim = dz > 0 ? Infinity : -Infinity
      for (const h of this.hits) lim = dz > 0 ? Math.min(lim, h.minZ - b.r - EPS) : Math.max(lim, h.maxZ + b.r + EPS)
      if (isFinite(lim) && (dz > 0 ? lim >= b.z - 0.01 : lim <= b.z + 0.01) && !this.overlap(b.x, b.y, lim, b.h, b.r)) b.z = lim
      b.vz = 0
    }
    return false
  }
  /** 推进物理体一步：水平滑墙 + 上台阶 + 重力/落地/顶头 + 下台阶贴地 */
  moveBody(b: Body, dt: number) {
    const wasGround = b.onGround
    // 水平：分步避免穿薄墙（最大 0.3 m / 次）
    const mx = b.vx * dt, mz = b.vz * dt
    const n = Math.max(1, Math.ceil(Math.max(Math.abs(mx), Math.abs(mz)) / 0.3))
    for (let i = 0; i < n; i++) { if (mx) this.moveAxis(b, mx / n, 0); if (mz) this.moveAxis(b, 0, mz / n) }
    // 垂直
    b.vy -= GRAVITY * dt
    let ny = b.y + b.vy * dt
    if (b.vy <= 0) {
      const g = this.support(b.x, b.y, b.z, b.r)
      if (ny <= g) { ny = g; b.vy = 0; b.onGround = true }
      else if (wasGround && b.y - g <= STEP + 0.02) { ny = g; b.vy = 0; b.onGround = true }   // 下台阶贴地
      else b.onGround = false
    } else {
      const c = this.ceiling(b.x, b.y, b.z, b.r, b.h)
      if (ny + b.h > c) { ny = c - b.h; b.vy = 0 }
      b.onGround = false
    }
    b.y = ny
    // 卡在盒里（生成/传送异常）：向上抬
    if (this.overlap(b.x, b.y, b.z, b.h, b.r)) {
      const s = this.support(b.x, b.y + STEP, b.z, b.r, 0)
      if (s > b.y && !this.overlap(b.x, s + 0.001, b.z, b.h, b.r)) b.y = s + 0.001
    }
  }

  // ———————————————————— 导航（格点 A*） ————————————————————
  isWalk(cx: number, cz: number) { return this.inBounds(cx, cz) && this.walk[cz * N + cx] === 1 }
  private hAt(cx: number, cz: number) { return this.height[cz * N + cx] }
  /** 最近可走格（BFS 外扩） */
  nearestCell(x: number, z: number): number {
    const cx = Math.min(N - 1, Math.max(0, toCell(x))), cz = Math.min(N - 1, Math.max(0, toCell(z)))
    if (this.isWalk(cx, cz)) return cz * N + cx
    for (let r = 1; r < 8; r++) {
      let best = -1, bd = Infinity
      for (let dz = -r; dz <= r; dz++) for (let dx = -r; dx <= r; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dz)) !== r) continue
        const ax = cx + dx, az = cz + dz
        if (!this.isWalk(ax, az)) continue
        const d = (cellX(ax) - x) ** 2 + (cellZ(az) - z) ** 2
        if (d < bd) { bd = d; best = az * N + ax }
      }
      if (best >= 0) return best
    }
    return cz * N + cx
  }
  private gScore = new Float32Array(N * N)
  private fScore = new Float32Array(N * N)
  private came = new Int32Array(N * N)
  private closed = new Uint32Array(N * N)
  private openStamp = new Uint32Array(N * N)
  private searchId = 0
  private heap: number[] = []
  /** A* → 平滑后的世界坐标路点（含高度）；不可达返回 null */
  findPath(fx: number, fz: number, tx: number, tz: number): THREE.Vector3[] | null {
    const s = this.nearestCell(fx, fz), t = this.nearestCell(tx, tz)
    const id = ++this.searchId
    const g = this.gScore, f = this.fScore, came = this.came, closed = this.closed, op = this.openStamp
    const heap = this.heap; heap.length = 0
    const tx0 = t % N, tz0 = (t / N) | 0
    const H = (i: number) => { const dx = Math.abs(i % N - tx0), dz = Math.abs(((i / N) | 0) - tz0); return (dx + dz) + (Math.SQRT2 - 2) * Math.min(dx, dz) }
    const push = (i: number) => { heap.push(i); let k = heap.length - 1; while (k > 0) { const p = (k - 1) >> 1; if (f[heap[p]] <= f[heap[k]]) break; [heap[p], heap[k]] = [heap[k], heap[p]]; k = p } }
    const pop = () => { const top = heap[0]; const last = heap.pop()!; if (heap.length) { heap[0] = last; let k = 0; for (;;) { const l = 2 * k + 1, r = l + 1; let m = k; if (l < heap.length && f[heap[l]] < f[heap[m]]) m = l; if (r < heap.length && f[heap[r]] < f[heap[m]]) m = r; if (m === k) break; [heap[m], heap[k]] = [heap[k], heap[m]]; k = m } } return top }
    g[s] = 0; f[s] = H(s); came[s] = -1; op[s] = id; push(s)
    let found = false, iter = 0
    while (heap.length && iter++ < 6000) {
      const cur = pop()
      if (closed[cur] === id) continue
      closed[cur] = id
      if (cur === t) { found = true; break }
      const cx = cur % N, cz = (cur / N) | 0, ch = this.hAt(cx, cz)
      for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) {
        if (!dx && !dz) continue
        const nx = cx + dx, nz = cz + dz
        if (!this.isWalk(nx, nz)) continue
        const nh = this.hAt(nx, nz)
        if (Math.abs(nh - ch) > STEP) continue
        if (dx && dz) {
          if (!this.isWalk(cx + dx, cz) || !this.isWalk(cx, cz + dz)) continue
          if (Math.abs(this.hAt(cx + dx, cz) - ch) > STEP || Math.abs(this.hAt(cx, cz + dz) - ch) > STEP) continue
        }
        const ni = nz * N + nx
        if (closed[ni] === id) continue
        // 贴墙格加一点代价（路线居中）
        let cost = dx && dz ? Math.SQRT2 : 1
        if (!this.isWalk(nx + 1, nz) || !this.isWalk(nx - 1, nz) || !this.isWalk(nx, nz + 1) || !this.isWalk(nx, nz - 1)) cost += 0.35
        const ng = g[cur] + cost
        if (op[ni] === id && ng >= g[ni]) continue
        op[ni] = id; g[ni] = ng; f[ni] = ng + H(ni); came[ni] = cur; push(ni)
      }
    }
    if (!found) return null
    const cells: number[] = []
    for (let i = t; i !== -1; i = came[i]) cells.push(i)
    cells.reverse()
    // 拉直：从当前点尽量直连更远的格
    const pts: THREE.Vector3[] = []
    const toV = (i: number) => new THREE.Vector3(cellX(i % N), this.hAt(i % N, (i / N) | 0), cellZ((i / N) | 0))
    let a = 0
    pts.push(toV(cells[0]))
    while (a < cells.length - 1) {
      let b = cells.length - 1
      while (b > a + 1 && !this.walkLine(cells[a], cells[b])) b--
      pts.push(toV(cells[b]))
      a = b
    }
    // 终点用精确目标（若与终点格同格）
    const last = pts[pts.length - 1]
    if (Math.abs(last.x - tx) < 1.2 && Math.abs(last.z - tz) < 1.2 && this.nearestCell(tx, tz) === t) { last.x = tx; last.z = tz }
    pts.shift()
    return pts
  }
  /** 两格之间直线可走（带身体宽度、高差连续） */
  private walkLine(a: number, b: number): boolean {
    const ax = cellX(a % N), az = cellZ((a / N) | 0), bx = cellX(b % N), bz = cellZ((b / N) | 0)
    const dx = bx - ax, dz = bz - az, len = Math.hypot(dx, dz)
    const steps = Math.ceil(len / 0.5)
    const px = -dz / (len || 1) * 0.55, pz = dx / (len || 1) * 0.55
    let prevH = this.hAt(a % N, (a / N) | 0)
    for (let i = 1; i <= steps; i++) {
      const t = i / steps, x = ax + dx * t, z = az + dz * t
      for (const o of [0, 1, -1]) {
        const cx = toCell(x + px * o), cz = toCell(z + pz * o)
        if (!this.isWalk(cx, cz)) return false
        if (Math.abs(this.hAt(cx, cz) - prevH) > STEP) return false
      }
      prevH = this.hAt(toCell(x), toCell(z))
    }
    return true
  }

  /** 随机可走点（死斗出生） */
  randomWalkable(rng: () => number = Math.random): Pt {
    for (let k = 0; k < 200; k++) {
      const cx = 1 + Math.floor(rng() * (N - 2)), cz = 1 + Math.floor(rng() * (N - 2))
      if (!this.isWalk(cx, cz) || !this.isWalk(cx + 1, cz) || !this.isWalk(cx - 1, cz) || !this.isWalk(cx, cz + 1) || !this.isWalk(cx, cz - 1)) continue
      return { x: cellX(cx), z: cellZ(cz) }
    }
    return { x: cellX(30), z: cellZ(30) }
  }

  dispose() {
    for (const d of this.disposables) d.dispose()
    this.disposables.length = 0
    this.group.removeFromParent()
  }
}
