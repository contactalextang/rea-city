import type { P2 } from '../world/RoadGraph'
import { poiCss, type Poi, type PoiType } from '../systems/Poi'
import { TARGET_CSS } from '../world/Marker'
import {
  AIRFIELD_MAP_RECT, APRON, CAUSEWAY_DECK, CONNECTORS, HANGAR_XS, hangarRect, ISLAND, LANDSIDE_ROAD, PARKING, RUNWAY, SERVICE_AREA,
  TAXIWAY, TERMINAL, TERMINAL_PLAZA, TOWER,
} from '../world/Airfield'

/** 海面色（与城市底图 minimap.png 里的水面同色）：底图之外的区域都画成海 */
const SEA_CSS = 'rgb(58,110,165)'

const MINOR = new Set<PoiType>(['bus', 'taxi'])
/** P10 娱乐场馆：小地图上画大点 */
const VENUE = new Set<PoiType>(['casino', 'club', 'race', 'arena', 'airport'])
const NAMED = new Set<PoiType>(['mrt', 'home', 'office', 'police', 'hospital', 'landmark', 'site', 'casino', 'club', 'race', 'arena', 'airport'])
/** 已拥有产业的金圈颜色（与品红目标 TARGET_CSS、黄色任务点 #ffd33d 区分：空心粗环 + 深色描边） */
export const BIZ_RING_CSS = '#ffb300'
/** 插件导航折线（赛道线）颜色：青色，和品红目标 / 金色产业区分 */
export const NAV_PATH_CSS = '#35e0ff'

/** 距离文字：320m / 1.2km（米数取整到 5，减少跳动；sep 为数字与单位间的分隔） */
export const fmtDist = (d: number, sep = '') => d < 1000 ? `${Math.round(d / 5) * 5}${sep}m` : `${(d / 1000).toFixed(d < 10000 ? 1 : 0)}${sep}km`

/** 小地图每帧算出的目标导航（距离 m、相对相机朝向的方位角 rad，0 = 正前、顺时针为正）；Hud 读它画方位箭头，无目标为 null */
export const minimapNav: { target: { dist: number; angle: number } | null } = { target: null }

/** 预烘焙底图：1 px/m，图片左上角对应世界 (minX, minZ) */
export interface MinimapImageSource { image: HTMLImageElement | HTMLCanvasElement; minX: number; minZ: number }

/**
 * AIR.2 机场叠加层：按 Airfield 常量运行时画一张 1 px/m 的 canvas（覆盖 AIRFIELD_MAP_RECT），
 * 配色沿用城市底图：草地 / 铺装灰 / 路面深灰 / 建筑浅灰；海面透明（下面是海色背景）。只在 sg 世界且机场接入时使用。
 */
export function airfieldMinimapLayer(): MinimapImageSource {
  const R = AIRFIELD_MAP_RECT
  const c = document.createElement('canvas')
  c.width = Math.ceil(R.maxX - R.minX); c.height = Math.ceil(R.maxZ - R.minZ)
  const g = c.getContext('2d')!
  g.translate(-R.minX, -R.minZ)
  const rect = (x0: number, z0: number, x1: number, z1: number, css: string) => { g.fillStyle = css; g.fillRect(x0, z0, x1 - x0, z1 - z0) }
  const GRASS = 'rgb(79,122,58)', PAVE = 'rgb(140,138,132)', ROAD = 'rgb(92,92,99)', CASING = 'rgb(122,127,138)', BLD = 'rgb(157,157,152)', RUNWAY_CSS = 'rgb(74,74,80)'
  // 岛（倒角 24 m）+ 护岸浅边
  const I = ISLAND, C = 24
  g.beginPath()
  g.moveTo(I.minX + C, I.minZ); g.lineTo(I.maxX - C, I.minZ); g.lineTo(I.maxX, I.minZ + C); g.lineTo(I.maxX, I.maxZ - C)
  g.lineTo(I.maxX - C, I.maxZ); g.lineTo(I.minX + C, I.maxZ); g.lineTo(I.minX, I.maxZ - C); g.lineTo(I.minX, I.minZ + C); g.closePath()
  g.fillStyle = GRASS; g.fill()
  g.lineWidth = 3; g.strokeStyle = 'rgb(138,133,114)'; g.stroke()
  // 堤道（桥面多边形，外描边当路缘）
  g.beginPath()
  for (let i = 0; i < CAUSEWAY_DECK.length; i += 2) i ? g.lineTo(CAUSEWAY_DECK[i], CAUSEWAY_DECK[i + 1]) : g.moveTo(CAUSEWAY_DECK[i], CAUSEWAY_DECK[i + 1])
  g.closePath()
  g.fillStyle = ROAD; g.fill(); g.lineWidth = 2; g.strokeStyle = CASING; g.stroke()
  // 陆侧路 / 停车场 / 前广场
  const L = LANDSIDE_ROAD
  rect(L.x0, L.z - 6.3, L.x1, L.z + 6.3, CASING)
  rect(L.x0, L.z - 3.3, L.x1, L.z + 3.3, ROAD)
  rect(CAUSEWAY_DECK[8], CAUSEWAY_DECK[7], CAUSEWAY_DECK[6], L.z, ROAD)
  rect(TERMINAL_PLAZA.minX, TERMINAL_PLAZA.minZ, TERMINAL_PLAZA.maxX, TERMINAL_PLAZA.maxZ, CASING)
  rect(PARKING.minX, PARKING.minZ, PARKING.maxX, PARKING.maxZ, ROAD)
  // 空侧铺装：服务区、停机坪、滑行道、联络道、跑道
  const T = TAXIWAY, hw = T.width / 2
  rect(SERVICE_AREA.minX, SERVICE_AREA.minZ, SERVICE_AREA.maxX, SERVICE_AREA.maxZ, PAVE)
  rect(APRON.minX, APRON.minZ, APRON.maxX, APRON.maxZ, PAVE)
  rect(T.x0 - hw, T.z - hw, T.x1 + hw, T.z + hw, PAVE)
  for (const cx of CONNECTORS) rect(cx - hw, T.z, cx + hw, RUNWAY.z, PAVE)
  rect(RUNWAY.x0, RUNWAY.z - RUNWAY.width / 2, RUNWAY.x1, RUNWAY.z + RUNWAY.width / 2, RUNWAY_CSS)
  // 跑道中线虚线 + 两端入口白条
  g.fillStyle = 'rgba(255,255,255,.85)'
  for (let x = RUNWAY.x0 + 72; x < RUNWAY.x1 - 72; x += 50) g.fillRect(x, RUNWAY.z - 1, 30, 2)
  g.fillRect(RUNWAY.x0 + 6, RUNWAY.z - 20, 30, 40); g.fillRect(RUNWAY.x1 - 36, RUNWAY.z - 20, 30, 40)
  // 滑行道黄中线
  g.fillStyle = 'rgba(224,192,96,.9)'
  g.fillRect(T.x0, T.z - 0.75, T.x1 - T.x0, 1.5)
  for (const cx of CONNECTORS) g.fillRect(cx - 0.75, T.z, 1.5, RUNWAY.z - RUNWAY.width / 2 - T.z)
  // 建筑：航站楼、机库、塔台
  rect(TERMINAL.minX, TERMINAL.minZ, TERMINAL.maxX, TERMINAL.maxZ, BLD)
  for (let i = 0; i < HANGAR_XS.length; i++) { const h = hangarRect(i); rect(h.minX, h.minZ, h.maxX, h.maxZ, BLD) }
  const s = TOWER.size / 2
  rect(TOWER.x - s, TOWER.z - s, TOWER.x + s, TOWER.z + s, BLD)
  return { image: c, minX: R.minX, minZ: R.minZ }
}

/** 右下角圆形小地图：静态城市底图 + 玩家箭头 + 任务/警车/任务车标记，随朝向旋转；目标在视野外时圆边画箭头 + 距离 */
export class Minimap {
  private canvas = document.getElementById('minimap') as HTMLCanvasElement
  private ctx = this.canvas.getContext('2d')!
  private base: HTMLCanvasElement | HTMLImageElement
  private size = 200
  private scale: number   // px / m
  /** 底图左上角对应的世界坐标与底图尺寸（米 = 像素） */
  private minX: number
  private minZ: number
  private baseW: number
  private baseH: number
  private dpr = 0
  /** 最近一次 draw 传入的已拥有产业位置（大地图沿用） */
  private owned: P2[] = []
  /** 最近一次 draw 传入的插件导航折线（大地图沿用） */
  private path: P2[] | null = null
  /** AIR.2 叠加层（机场岛）与「底图 ∪ 叠加层」的范围（手机大地图按它缩放） */
  private overlay: MinimapImageSource | null
  private ext: { minX: number; minZ: number; w: number; h: number }

  /** 底图来源：方格城由 GridWorld 合成 canvas，真实城市用预烘焙 PNG；scale = 圆形小地图 px/m；
   *  overlay = 底图外的叠加层（1 px/m）；'airfield' = 由 Airfield 常量现画机场岛（sg 世界机场接入时） */
  constructor(source: MinimapImageSource, scale = 0.75, overlay: MinimapImageSource | 'airfield' | null = null) {
    if (overlay === 'airfield') overlay = airfieldMinimapLayer()
    this.base = source.image
    this.minX = source.minX; this.minZ = source.minZ
    this.baseW = source.image.width; this.baseH = source.image.height
    this.scale = scale
    this.overlay = overlay
    let minX = this.minX, minZ = this.minZ, maxX = this.minX + this.baseW, maxZ = this.minZ + this.baseH
    if (overlay) {
      minX = Math.min(minX, overlay.minX); minZ = Math.min(minZ, overlay.minZ)
      maxX = Math.max(maxX, overlay.minX + overlay.image.width); maxZ = Math.max(maxZ, overlay.minZ + overlay.image.height)
    }
    this.ext = { minX, minZ, w: maxX - minX, h: maxZ - minZ }
  }

  /** 按 devicePixelRatio 调整画布像素尺寸（CSS 尺寸不变），高分屏不发糊 */
  private fitDpr() {
    const d = Math.min(3, window.devicePixelRatio || 1)
    if (d === this.dpr) return
    this.dpr = d
    this.canvas.width = this.canvas.height = Math.round(this.size * d)
  }

  /** health 可选：低于 35 时医院点夹到边缘常驻，否则只在视野内画；owned = 已拥有产业位置（金圈，视野内才画） */
  draw(px: number, pz: number, yaw: number, target: P2 | null, starts: P2[], police: P2[], gold: P2 | null, hospital: P2, pois: Poi[] = [], health?: number, owned: P2[] = [], path: P2[] | null = null) {
    this.owned = owned
    this.path = path
    this.fitDpr()
    const g = this.ctx, S = this.size, R = S / 2
    g.setTransform(this.dpr, 0, 0, this.dpr, 0, 0)
    g.clearRect(0, 0, S, S)
    g.save()
    g.beginPath(); g.arc(R, R, R - 2, 0, Math.PI * 2); g.clip()
    g.fillStyle = SEA_CSS; g.fillRect(0, 0, S, S)
    g.translate(R, R)
    g.rotate(yaw + Math.PI)
    g.scale(this.scale, this.scale)
    g.drawImage(this.base, -(px - this.minX), -(pz - this.minZ))
    if (this.overlay) g.drawImage(this.overlay.image, -(px - this.overlay.minX), -(pz - this.overlay.minZ))
    // 插件导航折线（赛道线）：世界坐标，相对玩家；屏幕上约 3.5 px 宽 + 深色描边
    if (path && path.length > 1) this.strokePath(g, path, (p) => p.x - px, (p) => p.z - pz, 1 / this.scale)
    const dot = (p: P2, color: string, r: number, ring = false) => {
      let dx = p.x - px, dz = p.z - pz
      const d = Math.hypot(dx, dz), max = (R - 10) / this.scale
      if (d > max) { dx *= max / d; dz *= max / d }
      g.beginPath(); g.arc(dx, dz, r, 0, Math.PI * 2)
      g.fillStyle = color; g.fill()
      if (ring) { g.lineWidth = 1.5; g.strokeStyle = '#fff'; g.stroke() }
    }
    // POI 不夹到边缘（真实城市有几百个，夹边会围成一圈）；巴士/的士站画小点；整体半透明，把视觉重心让给目标
    const view2 = ((R - 6) / this.scale) ** 2
    g.globalAlpha = 0.55
    for (const p of pois) {
      const dx = p.x - px, dz = p.z - pz
      if (dx * dx + dz * dz > view2) continue
      const minor = MINOR.has(p.type)
      if (VENUE.has(p.type)) continue
      dot(p, poiCss(p.type), minor ? 1.6 : 2.6, !minor)
    }
    g.globalAlpha = 1
    // 娱乐场馆（P10）：不透明大点，夜里找得到；视野外夹到边缘（只有 4 个，不会围成一圈），远处也看得出方向
    for (const p of pois) {
      if (!VENUE.has(p.type)) continue
      const dx = p.x - px, dz = p.z - pz
      dot(p, poiCss(p.type), (dx * dx + dz * dz > view2 ? 3.2 : 4.5) / this.scale, true)   // 屏幕上约 4.5 px（边缘 3.2 px），不随缩放变小
    }
    // 已拥有产业：金色空心圈（屏幕上约 7 px 半径，不随缩放变细）
    for (const o of owned) {
      const dx = o.x - px, dz = o.z - pz
      if (dx * dx + dz * dz > view2) continue
      const r = 7 / this.scale
      g.beginPath(); g.arc(dx, dz, r, 0, Math.PI * 2)
      g.lineWidth = 5 / this.scale; g.strokeStyle = 'rgba(0,0,0,.6)'; g.stroke()
      g.lineWidth = 3 / this.scale; g.strokeStyle = BIZ_RING_CSS; g.stroke()
    }
    for (const s of starts) dot(s, '#ffd33d', 5, true)
    if (gold) dot(gold, '#f5b400', 4)
    for (const p of police) dot(p, '#ff3b3b', 3.5)
    // 医院：视野内才画；血量低时夹边常驻，指路去医院
    const hd2 = (hospital.x - px) ** 2 + (hospital.z - pz) ** 2
    if (hd2 <= view2 || (health !== undefined && health < 35)) dot(hospital, '#ff6b6b', 4)
    g.restore()
    minimapNav.target = target ? this.drawTarget(px, pz, yaw, target) : null
    // 玩家箭头（朝上）
    g.save(); g.translate(R, R)
    g.beginPath(); g.moveTo(0, -8); g.lineTo(6, 7); g.lineTo(0, 4); g.lineTo(-6, 7); g.closePath()
    g.fillStyle = '#ffffff'; g.fill(); g.lineWidth = 1.5; g.strokeStyle = '#000'; g.stroke()
    g.restore()
  }

  /** 画导航折线：k = 每屏幕像素对应的绘制单位（小地图在世界坐标系里画，需要除以缩放） */
  private strokePath(g: CanvasRenderingContext2D, path: P2[], X: (p: P2) => number, Z: (p: P2) => number, k: number) {
    g.save()
    g.lineJoin = 'round'; g.lineCap = 'round'
    g.beginPath()
    path.forEach((p, i) => { if (i === 0) g.moveTo(X(p), Z(p)); else g.lineTo(X(p), Z(p)) })
    g.lineWidth = 6 * k; g.strokeStyle = 'rgba(0,0,0,.55)'; g.stroke()
    g.lineWidth = 3.5 * k; g.strokeStyle = NAV_PATH_CSS; g.stroke()
    g.restore()
  }

  /** 当前目标：视野内画品红菱形 + 脉冲外环；视野外在圆边画朝向目标的三角箭头 + 距离 */
  private drawTarget(px: number, pz: number, yaw: number, t: P2) {
    const g = this.ctx, R = this.size / 2
    const a = yaw + Math.PI, ca = Math.cos(a), sa = Math.sin(a)
    const dx = (t.x - px) * this.scale, dz = (t.z - pz) * this.scale
    // 与底图同一旋转：屏幕坐标（相对圆心，y 向下 = 相机后方）
    const sx = dx * ca - dz * sa, sy = dx * sa + dz * ca
    const r = Math.hypot(sx, sy), dist = Math.hypot(t.x - px, t.z - pz)
    const phase = (performance.now() / 1000) % 1.2 / 1.2
    const edge = R - 16
    g.save(); g.translate(R, R)
    if (r <= edge) {
      g.beginPath(); g.arc(sx, sy, 6 + phase * 12, 0, Math.PI * 2)
      g.globalAlpha = 1 - phase; g.lineWidth = 2.5; g.strokeStyle = TARGET_CSS; g.stroke()
      g.globalAlpha = 1
      g.beginPath(); g.moveTo(sx, sy - 8); g.lineTo(sx + 7, sy); g.lineTo(sx, sy + 8); g.lineTo(sx - 7, sy); g.closePath()
      g.fillStyle = TARGET_CSS; g.fill(); g.lineWidth = 2; g.strokeStyle = '#fff'; g.stroke()
    } else {
      const th = Math.atan2(sy, sx), pulse = 1 + Math.sin(phase * Math.PI * 2) * 0.12
      g.save(); g.rotate(th)
      const tip = R - 4, base = tip - 15 * pulse, w = 9 * pulse
      g.beginPath(); g.moveTo(tip, 0); g.lineTo(base, -w); g.lineTo(base + 4, 0); g.lineTo(base, w); g.closePath()
      g.fillStyle = TARGET_CSS; g.fill(); g.lineWidth = 2; g.strokeStyle = '#fff'; g.stroke()
      g.restore()
      const lr = R - 34, lx = Math.cos(th) * lr, ly = Math.sin(th) * lr
      g.font = 'bold 12px -apple-system, "PingFang SC", Arial, sans-serif'
      g.textAlign = 'center'; g.textBaseline = 'middle'
      g.lineWidth = 3.5; g.strokeStyle = 'rgba(0,0,0,.85)'; g.strokeText(fmtDist(dist), lx, ly)
      g.fillStyle = '#fff'; g.fillText(fmtDist(dist), lx, ly)
    }
    g.restore()
    // 方位角：0 = 相机正前方，顺时针为正
    return { dist, angle: Math.atan2(sx, -sy) }
  }

  /** 手机里的大地图：整城不旋转（按长边等比缩放），画 POI 图标 + 名字、警车、玩家箭头 */
  drawLarge(canvas: HTMLCanvasElement, px: number, pz: number, yaw: number, police: P2[], pois: Poi[]) {
    const g = canvas.getContext('2d')!
    const S = canvas.width
    const E = this.ext
    const k = S / Math.max(E.w, E.h)
    const X = (x: number) => (x - E.minX) * k, Z = (z: number) => (z - E.minZ) * k
    g.clearRect(0, 0, S, S)
    g.fillStyle = '#1a1f2e'; g.fillRect(0, 0, S, S)
    // 地图范围内（底图 ∪ 叠加层）先铺海色，底图外的海面不再是深色空白
    g.fillStyle = SEA_CSS; g.fillRect(0, 0, E.w * k, E.h * k)
    g.drawImage(this.base, X(this.minX), Z(this.minZ), this.baseW * k, this.baseH * k)
    const ov = this.overlay
    if (ov) g.drawImage(ov.image, X(ov.minX), Z(ov.minZ), ov.image.width * k, ov.image.height * k)
    g.font = '10px -apple-system, "PingFang SC", Arial, sans-serif'
    g.textBaseline = 'middle'
    // POI 多时（真实城市）只给主要地点写名字，巴士/的士站画小点
    const many = pois.length > 60
    for (const p of pois) {
      const x = X(p.x), z = Z(p.z)
      const minor = MINOR.has(p.type)
      g.beginPath(); g.arc(x, z, minor ? 1.5 : many ? 3 : 4, 0, Math.PI * 2)
      g.fillStyle = poiCss(p.type); g.fill()
      if (minor) continue
      g.lineWidth = 1; g.strokeStyle = '#fff'; g.stroke()
      if (many && !NAMED.has(p.type)) continue
      g.fillStyle = '#fff'; g.shadowColor = '#000'; g.shadowBlur = 3
      g.fillText(p.name, x + 6, z)
      g.shadowBlur = 0
    }
    if (this.path && this.path.length > 1) this.strokePath(g, this.path, (p) => X(p.x), (p) => Z(p.z), 0.8)
    for (const p of police) { g.beginPath(); g.arc(X(p.x), Z(p.z), 3.5, 0, Math.PI * 2); g.fillStyle = '#ff3b3b'; g.fill() }
    for (const o of this.owned) { g.beginPath(); g.arc(X(o.x), Z(o.z), 7, 0, Math.PI * 2); g.lineWidth = 2.5; g.strokeStyle = BIZ_RING_CSS; g.stroke() }
    g.save(); g.translate(X(px), Z(pz)); g.rotate(-yaw + Math.PI)
    g.beginPath(); g.moveTo(0, -8); g.lineTo(6, 7); g.lineTo(0, 4); g.lineTo(-6, 7); g.closePath()
    g.fillStyle = '#ffffff'; g.fill(); g.lineWidth = 1.5; g.strokeStyle = '#000'; g.stroke()
    g.restore()
  }
}
