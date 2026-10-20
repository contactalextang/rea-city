import * as THREE from 'three'
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js'
import { CAR_LEN, CAR_CIRCLE_OFF, CAR_CIRCLE_R, BUS_LEN, BUS_WID, BUS_HEIGHT, BUS_CIRCLE_OFFS, BUS_CIRCLE_R, type VehicleKind } from '../config'
import { stepVehicle, forwardSpeed, steerFactor, type Controls, type VehicleBody, type TuneMul } from '../physics/ArcadeVehicle'
import { playerEffects } from '../systems/Assets'
import type { Body } from '../physics/Collision'

export type Driver = 'none' | 'player' | 'traffic' | 'police'
/** 车身轮廓：轿车 / MPV / SUV / 跑车 / 巴士 */
export type CarModel = 'sedan' | 'mpv' | 'suv' | 'sports' | 'bus'

/*
 * 低多边形车辆：每车 2 个 draw call
 *  1) 车身：侧面轮廓挤出（含轮拱缺口）+ 收窄的玻璃舱；顶点色是"漆面系数"（1 = 车漆，深色 = 玻璃/底盘），
 *     与每车材质颜色相乘 → 一份几何体可被任意颜色复用，损坏变暗只改材质颜色
 *  2) 细节：轮胎、轮毂、车灯、格栅、车牌、的士顶灯、警车格纹/警灯、巴士 LED 线路牌；
 *     全部车辆共用一张图集 + 一个材质（警车追捕时换成"闪烁"变体），顶点属性 glow 标记夜间发光部件，
 *     材质推进 scene.userData.windows，由 DayNight 统一调 emissiveIntensity
 * 几何体按 (轮廓, 变体) 缓存共享。
 */

type P = [number, number]
type RGB = [number, number, number]
interface CarSpec {
  W: number; clear: number; r: number; wf: number; wr: number
  /** 车身下半部上沿：从车头底部 → 车头 → 发动机盖 → 腰线 → 行李箱 → 车尾底部（u = 纵向 z，v = 高度） */
  lower: P[]
  /** 玻璃舱轮廓（闭合多边形）与宽度 */
  green: P[]; gw: number
  head: P; tail: P
  roof: number; roofZ: number
}
const SPECS: Record<Exclude<CarModel, 'bus'>, CarSpec> = {
  sedan: {
    W: 1.96, clear: 0.28, r: 0.36, wf: 1.42, wr: -1.38,
    lower: [[2.3, 0], [2.34, 0.6], [2.24, 0.8], [1.2, 0.95], [0.75, 1.0], [-1.55, 1.02], [-2.2, 0.98], [-2.33, 0.8], [-2.3, 0]],
    green: [[0.82, 0.98], [0.05, 1.46], [-0.95, 1.47], [-1.62, 1.0]], gw: 1.74,
    head: [0.72, 2.27], tail: [0.86, -2.3], roof: 1.47, roofZ: -0.45,
  },
  mpv: {
    W: 1.96, clear: 0.3, r: 0.36, wf: 1.5, wr: -1.45,
    lower: [[2.3, 0], [2.35, 0.64], [2.22, 0.88], [1.45, 1.04], [1.3, 1.06], [-2.25, 1.08], [-2.34, 0.86], [-2.3, 0]],
    green: [[1.38, 1.03], [0.5, 1.8], [-2.0, 1.83], [-2.26, 1.06]], gw: 1.8,
    head: [0.8, 2.27], tail: [1.0, -2.32], roof: 1.83, roofZ: -0.7,
  },
  suv: {
    W: 2.0, clear: 0.4, r: 0.42, wf: 1.45, wr: -1.42,
    lower: [[2.3, 0], [2.35, 0.8], [2.24, 1.0], [1.1, 1.14], [0.85, 1.16], [-2.22, 1.18], [-2.34, 0.95], [-2.3, 0]],
    green: [[0.9, 1.13], [0.15, 1.76], [-1.95, 1.78], [-2.24, 1.16]], gw: 1.8,
    head: [0.92, 2.28], tail: [1.02, -2.32], roof: 1.78, roofZ: -0.6,
  },
  sports: {
    W: 2.0, clear: 0.2, r: 0.33, wf: 1.45, wr: -1.4,
    lower: [[2.3, 0], [2.37, 0.46], [2.18, 0.64], [1.0, 0.82], [0.6, 0.84], [-1.9, 0.88], [-2.28, 0.86], [-2.36, 0.55], [-2.3, 0]],
    green: [[0.62, 0.82], [-0.2, 1.2], [-0.95, 1.21], [-2.05, 0.87]], gw: 1.6,
    head: [0.58, 2.3], tail: [0.76, -2.33], roof: 1.21, roofZ: -0.5,
  },
}

/** 新加坡巴士线路（LED 牌：号码 + 终点站） */
const BUS_ROUTES: [string, string][] = [
  ['961', 'Woodlands Int'], ['174', 'Boon Lay Int'], ['7', 'Clementi Int'],
  ['36', 'Changi Airport'], ['190', 'Choa Chu Kang'], ['2', 'Changi Village'],
]

// ---------- 图集：白块 / TAXI 灯牌 / 巴士 LED 线路牌 ----------
const AT = 256
let atlas: THREE.CanvasTexture | null = null
/** 图集矩形（像素）→ UV 矩形 [u0, v0, u1, v1]（纹理 flipY） */
const uvRect = (x0: number, y0: number, x1: number, y1: number): [number, number, number, number] => [x0 / AT, 1 - y1 / AT, x1 / AT, 1 - y0 / AT]
const WHITE_UV: [number, number] = [16 / AT, 1 - 16 / AT]
const TAXI_UV = uvRect(0, 34, 128, 62)
const routeUV = (i: number) => uvRect(0, 64 + i * 32, 256, 64 + (i + 1) * 32)

function getAtlas() {
  if (atlas) return atlas
  const c = document.createElement('canvas'); c.width = c.height = AT
  const g = c.getContext('2d')!
  g.fillStyle = '#ffffff'; g.fillRect(0, 0, AT, AT)
  // 的士顶灯：白底深蓝字
  g.fillStyle = '#16264a'; g.font = 'bold 24px Arial, sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle'
  g.fillText('TAXI', 64, 49)
  // 巴士 LED 线路牌：黑底橙字
  BUS_ROUTES.forEach(([no, dest], i) => {
    const y = 64 + i * 32
    g.fillStyle = '#060606'; g.fillRect(0, y, AT, 32)
    g.fillStyle = '#ffa21a'; g.textAlign = 'left'; g.textBaseline = 'middle'
    g.font = 'bold 24px "Courier New", monospace'; g.fillText(no, 8, y + 17)
    g.font = 'bold 15px Arial, sans-serif'; g.fillText(dest, 72, y + 17)
  })
  atlas = new THREE.CanvasTexture(c)
  atlas.colorSpace = THREE.SRGBColorSpace
  atlas.anisotropy = 4
  return atlas
}

// ---------- 细节材质（全车共享） ----------
const timeU = { value: 0 }
let detailMat: THREE.MeshLambertMaterial | null = null
let flashMat: THREE.MeshLambertMaterial | null = null
let registeredIn: unknown = null

function makeDetailMat(flash: boolean) {
  const tex = getAtlas()
  const m = new THREE.MeshLambertMaterial({ vertexColors: true, map: tex, emissive: 0xffffff, emissiveMap: tex, emissiveIntensity: 0 })
  if (flash) m.defines = { SIREN_FLASH: '' }
  m.onBeforeCompile = (sh) => {
    sh.uniforms.uTime = timeU
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nattribute float glow;\nvarying float vGlow;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvGlow = glow;')
    // glow：≥ 0 为夜间灯亮度系数（受 emissiveIntensity 控制，0 不发光）；-1/-2 为警灯红/蓝（闪烁变体里交替常亮）
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying float vGlow;\nuniform float uTime;')
      .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
        totalEmissiveRadiance *= vColor.rgb * max(vGlow, 0.0);
        #ifdef SIREN_FLASH
        if (vGlow < -0.5) {
          float ph = step(0.5, fract(uTime * 2.5));
          totalEmissiveRadiance += vColor.rgb * (vGlow > -1.5 ? ph : 1.0 - ph) * 2.2;
        }
        #endif`)
  }
  return m
}
function sharedMats() {
  detailMat ??= makeDetailMat(false)
  flashMat ??= makeDetailMat(true)
  return { detailMat, flashMat }
}
/** 把车灯材质推进 scene.userData.windows（DayNight 夜间统一点亮）；世界换了数组则重推 */
function registerNight(root: THREE.Object3D | null) {
  if (!root || !detailMat || !flashMat) return
  let arr = root.userData.windows as THREE.Material[] | undefined
  if (arr === registeredIn && arr) return
  if (!arr) { arr = []; root.userData.windows = arr }
  for (const m of [detailMat, flashMat]) if (!arr.includes(m)) arr.push(m)
  registeredIn = arr
}

// ---------- 几何体工具 ----------
const tmpN = new THREE.Vector3()

/** 转成非索引几何并写入 color/glow/uv（uvMap 为空则全部指向图集白块） */
function part(g: THREE.BufferGeometry, color: number | RGB, glow = 0, uvMap?: { rect: [number, number, number, number]; face?: (nx: number, ny: number, nz: number) => boolean }) {
  const ng = g.index ? g.toNonIndexed() : g
  if (g !== ng) g.dispose()
  const n = ng.attributes.position.count
  const rgb: RGB = typeof color === 'number' ? (() => { const c = new THREE.Color(color); return [c.r, c.g, c.b] as RGB })() : color
  const col = new Float32Array(n * 3), gl = new Float32Array(n).fill(glow), uv = new Float32Array(n * 2)
  const srcUv = ng.attributes.uv as THREE.BufferAttribute | undefined
  const nrm = ng.attributes.normal as THREE.BufferAttribute
  for (let i = 0; i < n; i++) {
    col[i * 3] = rgb[0]; col[i * 3 + 1] = rgb[1]; col[i * 3 + 2] = rgb[2]
    if (uvMap && srcUv && (!uvMap.face || uvMap.face(nrm.getX(i), nrm.getY(i), nrm.getZ(i)))) {
      const [u0, v0, u1, v1] = uvMap.rect
      uv[i * 2] = u0 + srcUv.getX(i) * (u1 - u0); uv[i * 2 + 1] = v0 + srcUv.getY(i) * (v1 - v0)
    } else { uv[i * 2] = WHITE_UV[0]; uv[i * 2 + 1] = WHITE_UV[1] }
  }
  ng.setAttribute('color', new THREE.BufferAttribute(col, 3))
  ng.setAttribute('glow', new THREE.BufferAttribute(gl, 1))
  ng.setAttribute('uv', new THREE.BufferAttribute(uv, 2))
  return ng
}

/** 按三角形法线上色（挤出体：侧面 = cap，其余 = 墙） */
function colorByFace(g: THREE.BufferGeometry, fn: (nx: number, ny: number, nz: number) => RGB) {
  const ng = part(g, [1, 1, 1])
  const nrm = ng.attributes.normal as THREE.BufferAttribute, col = ng.attributes.color as THREE.BufferAttribute
  for (let t = 0; t < nrm.count; t += 3) {
    tmpN.set(0, 0, 0)
    for (let k = 0; k < 3; k++) tmpN.x += nrm.getX(t + k), tmpN.y += nrm.getY(t + k), tmpN.z += nrm.getZ(t + k)
    tmpN.normalize()
    const c = fn(tmpN.x, tmpN.y, tmpN.z)
    for (let k = 0; k < 3; k++) col.setXYZ(t + k, c[0], c[1], c[2])
  }
  return ng
}

/** 侧面轮廓 (u=z, v=y) 沿 x 挤出 width，居中 */
function extrude(pts: P[], width: number) {
  const s = new THREE.Shape(pts.map(([u, v]) => new THREE.Vector2(u, v)))
  const g = new THREE.ExtrudeGeometry(s, { depth: width, bevelEnabled: false, curveSegments: 1, steps: 1 })
  g.rotateY(-Math.PI / 2)
  g.translate(width / 2, 0, 0)
  return g
}

/** 车身下半部轮廓：上沿 lower（车头→车尾）+ 底边（车尾→车头，带两个轮拱缺口） */
function lowerProfile(lower: P[], clear: number, r: number, wf: number, wr: number): P[] {
  const top = lower.map(([u, v], i) => [u, i === 0 || i === lower.length - 1 ? clear : v] as P)
  const ra = r + 0.06
  const arch = (wz: number): P[] => {
    const pts: P[] = [[wz - ra, clear], [wz - ra, r]]
    for (let k = 1; k < 8; k++) { const a = Math.PI - (k / 8) * Math.PI; pts.push([wz + ra * Math.cos(a), r + ra * Math.sin(a)]) }
    pts.push([wz + ra, r], [wz + ra, clear])
    return pts
  }
  return [...top, ...arch(wr), ...arch(wf)]
}

const PAINT: RGB = [1, 1, 1]
const GLASS: RGB = [0.055, 0.06, 0.07]
const DARK: RGB = [0.03, 0.03, 0.03]
const TIRE = 0x161616, RIM = 0xb9bdc3, TRIM = 0x1e1f22
const HEAD = 0xfff4d6, TAIL = 0xe0141e, PLATE_F = 0xf2f2f2, PLATE_R = 0xf2c200
const GLOW_HEAD = 2.4, GLOW_TAIL = 1.6

function wheels(parts: THREE.BufferGeometry[], W: number, r: number, zs: number[], tireW = 0.26) {
  for (const sx of [-1, 1]) for (const wz of zs) {
    parts.push(part(new THREE.CylinderGeometry(r, r, tireW, 14).rotateZ(Math.PI / 2).translate(sx * (W / 2 - tireW / 2 + 0.03), r, wz), TIRE))
    parts.push(part(new THREE.CylinderGeometry(r * 0.6, r * 0.6, 0.04, 10).rotateZ(Math.PI / 2).translate(sx * (W / 2 + 0.03), r, wz), RIM))
  }
}

function carBody(s: CarSpec) {
  const parts: THREE.BufferGeometry[] = []
  // 下半车身：车漆；朝下的面（底盘、轮拱内侧）深色
  parts.push(colorByFace(extrude(lowerProfile(s.lower, s.clear, s.r, s.wf, s.wr), s.W), (_x, ny) => (ny < -0.2 ? DARK : PAINT)))
  // 玻璃舱：侧窗 / 风挡 / 后窗为深色玻璃，车顶为车漆
  parts.push(colorByFace(extrude(s.green, s.gw), (nx, ny) => (Math.abs(nx) < 0.7 && ny > 0.95 ? PAINT : GLASS)))
  // 车底接触阴影
  parts.push(part(new THREE.PlaneGeometry(s.W - 0.1, 4.4).rotateX(-Math.PI / 2).translate(0, 0.03, 0), DARK))
  return mergeGeometries(parts, false)!
}

function carDetail(s: CarSpec, variant: 'plain' | 'taxi' | 'police') {
  const parts: THREE.BufferGeometry[] = []
  wheels(parts, s.W, s.r, [s.wf, s.wr])
  const [hy, hz] = s.head, [ty, tz] = s.tail
  for (const sx of [-1, 1]) {
    parts.push(part(new THREE.BoxGeometry(0.44, 0.15, 0.1).translate(sx * 0.64, hy, hz), HEAD, GLOW_HEAD))
    parts.push(part(new THREE.BoxGeometry(0.46, 0.14, 0.1).translate(sx * 0.66, ty, tz), TAIL, GLOW_TAIL))
    // 后视镜（深色）
    parts.push(part(new THREE.BoxGeometry(0.16, 0.12, 0.1).translate(sx * (s.gw / 2 + 0.1), s.green[0][1] + 0.12, s.green[0][0] - 0.12), TRIM))
  }
  // 格栅与车牌（新加坡：前白后黄）
  parts.push(part(new THREE.BoxGeometry(0.8, 0.14, 0.06).translate(0, hy - 0.02, hz + 0.02), TRIM))
  parts.push(part(new THREE.BoxGeometry(0.52, 0.12, 0.04).translate(0, hy - 0.26, hz + 0.05), PLATE_F))
  parts.push(part(new THREE.BoxGeometry(0.52, 0.12, 0.04).translate(0, ty - 0.24, tz - 0.04), PLATE_R))
  if (variant === 'taxi') {
    // 车顶 TAXI 灯牌：前后两面印字，白底夜间发光
    parts.push(part(new THREE.BoxGeometry(0.62, 0.18, 0.26).translate(0, s.roof + 0.09, s.roofZ), 0xffffff, 1, { rect: TAXI_UV, face: (_x, _y, nz) => Math.abs(nz) > 0.9 }))
  }
  if (variant === 'police') {
    // 顶部警灯：左红右蓝（右舵车：-x 为右侧）
    parts.push(part(new THREE.BoxGeometry(0.06, 0.08, 0.26).translate(0, s.roof + 0.04, s.roofZ), TRIM))
    parts.push(part(new THREE.BoxGeometry(0.5, 0.12, 0.26).translate(0.28, s.roof + 0.06, s.roofZ), 0xff1a1a, -1))
    parts.push(part(new THREE.BoxGeometry(0.5, 0.12, 0.26).translate(-0.28, s.roof + 0.06, s.roofZ), 0x1a4dff, -2))
    // 侧面 Battenburg 简化格纹：蓝 / 荧光黄两行方格（避开轮拱）
    const z0 = s.wr + s.r + 0.2, z1 = s.wf - s.r - 0.2, cols = Math.max(4, Math.round((z1 - z0) / 0.26))
    const cw = (z1 - z0) / cols
    for (const sx of [-1, 1]) for (let c = 0; c < cols; c++) for (let row = 0; row < 2; row++) {
      const blue = (c + row) % 2 === 0
      const pl = new THREE.PlaneGeometry(cw, 0.17).rotateY(sx * Math.PI / 2).translate(sx * (s.W / 2 + 0.006), 0.6 + row * 0.17, z0 + (c + 0.5) * cw)
      parts.push(part(pl, blue ? 0x1b3fbf : 0xd8f000))
    }
  }
  return mergeGeometries(parts, false)!
}

/** 巴士车身：深绿下裙 + 浅绿腰线 + 深色车窗带（白漆窗柱）+ 车漆车顶 + 左侧车门 */
function busBody() {
  const L = BUS_LEN, W = BUS_WID, h = L / 2
  const parts: THREE.BufferGeometry[] = []
  const lowerTop: P[] = [[h, 0], [h + 0.02, 1.0], [h - 0.02, 1.3], [-h + 0.02, 1.3], [-h - 0.02, 0.9], [-h, 0]]
  const DEEP: RGB = [0.42, 0.5, 0.42], LIGHT: RGB = [1.35, 1.25, 1.35]
  parts.push(colorByFace(extrude(lowerProfile(lowerTop, 0.36, 0.5, 3.7, -2.5), W), (_x, ny) => (ny < -0.2 ? DARK : DEEP)))
  parts.push(part(new THREE.BoxGeometry(W + 0.02, 0.1, L + 0.02).translate(0, 1.28, 0), LIGHT))
  parts.push(part(new THREE.BoxGeometry(W - 0.04, 1.4, L - 0.06).translate(0, 2.03, -0.01), GLASS))
  parts.push(part(new THREE.BoxGeometry(W, BUS_HEIGHT - 2.73, L).translate(0, (BUS_HEIGHT + 2.73) / 2, 0), PAINT))
  // 窗柱（车漆色）
  for (const sx of [-1, 1]) for (let z = -h + 0.6; z < h - 1.0; z += 1.45) {
    parts.push(part(new THREE.BoxGeometry(0.03, 1.4, 0.12).translate(sx * (W / 2 - 0.005), 2.03, z), PAINT))
  }
  // 左侧（+x，路边）前门、中门：深色玻璃门板
  for (const zc of [4.95, 0.35]) parts.push(part(new THREE.BoxGeometry(0.03, 2.25, 1.15).translate(W / 2 + 0.01, 1.5, zc), GLASS))
  parts.push(part(new THREE.PlaneGeometry(W - 0.1, L - 0.2).rotateX(-Math.PI / 2).translate(0, 0.03, 0), DARK))
  return mergeGeometries(parts, false)!
}

function busDetail(route: number) {
  const L = BUS_LEN, W = BUS_WID, h = L / 2
  const parts: THREE.BufferGeometry[] = []
  wheels(parts, W, 0.5, [3.7, -2.5], 0.34)
  // 前 LED 线路牌（夜间发光，黑底橙字）
  parts.push(part(new THREE.PlaneGeometry(2.0, 0.27).translate(0, 2.92, h + 0.012), 0xffffff, 1.4, { rect: routeUV(route) }))
  // 后部小线路牌
  parts.push(part(new THREE.PlaneGeometry(1.0, 0.22).rotateY(Math.PI).translate(0, 2.92, -h - 0.012), 0xffffff, 1.4, { rect: routeUV(route) }))
  for (const sx of [-1, 1]) {
    parts.push(part(new THREE.BoxGeometry(0.34, 0.16, 0.08).translate(sx * 0.9, 0.72, h + 0.03), HEAD, GLOW_HEAD))
    parts.push(part(new THREE.BoxGeometry(0.22, 0.4, 0.08).translate(sx * 1.0, 1.0, -h - 0.03), TAIL, GLOW_TAIL))
    // 后视镜支架
    parts.push(part(new THREE.BoxGeometry(0.1, 0.4, 0.1).translate(sx * (W / 2 + 0.2), 2.3, h - 0.15), TRIM))
  }
  parts.push(part(new THREE.BoxGeometry(1.3, 0.25, 0.05).translate(0, 0.55, h + 0.03), TRIM))
  parts.push(part(new THREE.BoxGeometry(0.52, 0.12, 0.04).translate(0, 0.38, h + 0.05), PLATE_F))
  parts.push(part(new THREE.BoxGeometry(0.52, 0.12, 0.04).translate(0, 0.6, -h - 0.05), PLATE_R))
  return mergeGeometries(parts, false)!
}

const geoCache = new Map<string, THREE.BufferGeometry>()
function cached(key: string, make: () => THREE.BufferGeometry) {
  let g = geoCache.get(key)
  if (!g) { g = make(); geoCache.set(key, g) }
  return g
}

const DAMAGED = new THREE.Color(0x2b2b2b)
const defaultModel = (k: VehicleKind): CarModel => (k === 'bus' ? 'bus' : k === 'luxury' ? 'sports' : 'sedan')

export class Vehicle implements VehicleBody, Body {
  x = 0; z = 0; yaw = 0; vx = 0; vz = 0
  readonly radius: number
  readonly mass: number
  /** 碰撞圆个数（轿车 2：前/后；巴士 4：前/后/中前/中后） */
  readonly circleCount: number
  /** 半车长（交通 AI 跟车间距用） */
  readonly halfLen: number
  health = 100
  /** 这辆车自己的调校倍率（商店车辆，如超跑）；NPC 车为 1 */
  tune: TuneMul = { accel: 1, maxFwd: 1 }
  wrecked = false
  active = false
  /** 运动学模式：位置由 AI 直接设置，不跑物理积分、不与静态体碰撞 */
  kinematic = false
  driver: Driver = 'none'
  controls: Controls = { throttle: 0, steer: 0, handbrake: false }
  /** 交通 / 警车 AI 的私有状态，由对应系统填充 */
  ai: unknown = null
  /** 最近一次被玩家车辆撞击的时间（任务计数用） */
  lastHitByPlayer = -1
  /** 报废时刻（用于回收） */
  wreckedAt = -1
  group = new THREE.Group()
  /** 巴士线路号（非巴士为 null） */
  readonly route: string | null = null
  /** 前灯高度 / 车头前灯纵向位置（车身坐标，NightLights 放车灯光源与路面光锥） */
  readonly headY: number
  readonly headZ: number
  private circleOffs: readonly number[]
  private bodyMat: THREE.MeshLambertMaterial
  private tilt = new THREE.Group()
  private detail: THREE.Mesh
  baseColor: THREE.Color

  constructor(public kind: VehicleKind, color: number, readonly model: CarModel = defaultModel(kind)) {
    const bus = model === 'bus'
    this.radius = bus ? BUS_CIRCLE_R : CAR_CIRCLE_R
    this.mass = bus ? 9000 : kind === 'luxury' ? 1500 : 1200
    this.circleOffs = bus ? BUS_CIRCLE_OFFS : [CAR_CIRCLE_OFF, -CAR_CIRCLE_OFF]
    this.circleCount = this.circleOffs.length
    this.halfLen = bus ? BUS_LEN / 2 : CAR_LEN / 2
    this.baseColor = new THREE.Color(color)
    if (bus) { this.headY = 0.72; this.headZ = BUS_LEN / 2 + 0.05 }
    else { const [hy, hz] = SPECS[model as Exclude<CarModel, 'bus'>].head; this.headY = hy; this.headZ = hz + 0.05 }
    this.bodyMat = new THREE.MeshLambertMaterial({ color, vertexColors: true })
    const { detailMat } = sharedMats()
    let body: THREE.BufferGeometry, detail: THREE.BufferGeometry
    if (bus) {
      const r = Math.floor(Math.random() * BUS_ROUTES.length)
      this.route = BUS_ROUTES[r][0]
      body = cached('body:bus', busBody)
      detail = cached(`detail:bus${r}`, () => busDetail(r))
    } else {
      const spec = SPECS[model as Exclude<CarModel, 'bus'>]
      const variant = kind === 'taxi' ? 'taxi' : kind === 'police' ? 'police' : 'plain'
      body = cached(`body:${model}`, () => carBody(spec))
      detail = cached(`detail:${model}:${variant}`, () => carDetail(spec, variant))
    }
    const bodyMesh = new THREE.Mesh(body, this.bodyMat)
    this.detail = new THREE.Mesh(detail, detailMat)
    this.detail.userData.castShadow = false
    this.tilt.add(bodyMesh, this.detail)
    this.group.add(this.tilt)
    this.group.visible = false
  }

  /** 更换涂装（的士随机公司色用） */
  setColor(hex: number) { this.baseColor.setHex(hex); this.bodyMat.color.setHex(hex) }

  get speed() { return forwardSpeed(this) }
  get absSpeed() { return Math.hypot(this.vx, this.vz) }

  activate(x: number, z: number, yaw: number) {
    this.x = x; this.z = z; this.yaw = yaw; this.vx = this.vz = 0
    this.health = 100; this.wrecked = false; this.wreckedAt = -1
    this.bodyMat.color.copy(this.baseColor)
    this.controls.throttle = 0; this.controls.steer = 0; this.controls.handbrake = false
    this.active = true; this.group.visible = true; this.ai = null; this.driver = 'none'; this.kinematic = false
    this.sync(0)
  }
  deactivate() { this.active = false; this.group.visible = false; this.driver = 'none'; this.ai = null; this.kinematic = false }

  /** 第 i 个碰撞圆的圆心（0 = 前，1 = 后；巴士另有 2/3 = 中前/中后） */
  circle(i: number, out: { x: number; z: number }) {
    const s = this.circleOffs[i]
    out.x = this.x + Math.sin(this.yaw) * s
    out.z = this.z + Math.cos(this.yaw) * s
    return out
  }

  step(dt: number) {
    if (this.wrecked) { this.controls.throttle = 0; this.controls.steer = 0; this.controls.handbrake = true }
    stepVehicle(this, this.controls, this.kind, dt, true, this.tuneMul)
  }

  /** 实际生效的调参倍率：车自身 tune × 玩家驾驶时的升级效果（引擎套件只作用于玩家开的车） */
  get tuneMul(): TuneMul {
    if (this.driver !== 'player') return this.tune
    const e = playerEffects()
    return { accel: this.tune.accel * e.accelMul, maxFwd: this.tune.maxFwd * e.maxFwdMul }
  }

  damage(amount: number) {
    if (this.wrecked || amount <= 0) return
    this.health -= amount
    const t = Math.max(0, this.health) / 100
    this.bodyMat.color.copy(this.baseColor).lerp(DAMAGED, (1 - t) * 0.6)
    if (this.health <= 0) {
      this.wrecked = true
      this.kinematic = false
      this.bodyMat.color.set(0x242424)
    }
  }

  sync(time: number) {
    this.group.position.set(this.x, 0, this.z)
    this.group.rotation.y = this.yaw
    // 转向时车身轻微侧倾（巴士更稳）
    this.tilt.rotation.z = -this.controls.steer * (this.model === 'bus' ? 0.02 : 0.05) * steerFactor(this.speed) * Math.sign(this.speed || 1)
    timeU.value = time
    if (this.kind === 'police') {
      const { detailMat, flashMat } = sharedMats()
      this.detail.material = this.driver === 'police' && !this.wrecked ? flashMat : detailMat
    }
    registerNight(this.group.parent)
  }
}
