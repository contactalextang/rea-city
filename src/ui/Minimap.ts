import type { P2 } from '../world/RoadGraph'
import { POI_COLOR, type Poi, type PoiType } from '../systems/Poi'

const MINOR = new Set<PoiType>(['bus', 'taxi'])
const NAMED = new Set<PoiType>(['mrt', 'home', 'office', 'police', 'hospital', 'landmark', 'site'])

/** 预烘焙底图：1 px/m，图片左上角对应世界 (minX, minZ) */
export interface MinimapImageSource { image: HTMLImageElement | HTMLCanvasElement; minX: number; minZ: number }

/** 右下角圆形小地图：静态城市底图 + 玩家箭头 + 任务/警车/任务车标记，随朝向旋转 */
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

  /** 底图来源：方格城由 GridWorld 合成 canvas，真实城市用预烘焙 PNG；scale = 圆形小地图 px/m */
  constructor(source: MinimapImageSource, scale = 0.75) {
    this.base = source.image
    this.minX = source.minX; this.minZ = source.minZ
    this.baseW = source.image.width; this.baseH = source.image.height
    this.scale = scale
  }

  draw(px: number, pz: number, yaw: number, target: P2 | null, starts: P2[], police: P2[], gold: P2 | null, hospital: P2, pois: Poi[] = []) {
    const g = this.ctx, S = this.size, R = S / 2
    g.clearRect(0, 0, S, S)
    g.save()
    g.beginPath(); g.arc(R, R, R - 2, 0, Math.PI * 2); g.clip()
    g.fillStyle = '#2f5d8a'; g.fillRect(0, 0, S, S)
    g.translate(R, R)
    g.rotate(yaw + Math.PI)
    g.scale(this.scale, this.scale)
    g.drawImage(this.base, -(px - this.minX), -(pz - this.minZ))
    const dot = (p: P2, color: string, r: number, ring = false) => {
      let dx = p.x - px, dz = p.z - pz
      const d = Math.hypot(dx, dz), max = (R - 10) / this.scale
      if (d > max) { dx *= max / d; dz *= max / d }
      g.beginPath(); g.arc(dx, dz, r, 0, Math.PI * 2)
      g.fillStyle = color; g.fill()
      if (ring) { g.lineWidth = 1.5; g.strokeStyle = '#fff'; g.stroke() }
    }
    // POI 不夹到边缘（真实城市有几百个，夹边会围成一圈）；巴士/的士站画小点
    const view2 = ((R - 6) / this.scale) ** 2
    for (const p of pois) {
      const dx = p.x - px, dz = p.z - pz
      if (dx * dx + dz * dz > view2) continue
      const minor = MINOR.has(p.type)
      dot(p, '#' + POI_COLOR[p.type].toString(16).padStart(6, '0'), minor ? 1.8 : 3, !minor)
    }
    for (const s of starts) dot(s, '#ffd33d', 5, true)
    if (gold) dot(gold, '#f5b400', 4)
    if (target) dot(target, '#3ea6ff', 6, true)
    for (const p of police) dot(p, '#ff3b3b', 3.5)
    dot(hospital, '#ff6b6b', 4)
    g.restore()
    // 玩家箭头（朝上）
    g.save(); g.translate(R, R)
    g.beginPath(); g.moveTo(0, -8); g.lineTo(6, 7); g.lineTo(0, 4); g.lineTo(-6, 7); g.closePath()
    g.fillStyle = '#ffffff'; g.fill(); g.lineWidth = 1.5; g.strokeStyle = '#000'; g.stroke()
    g.restore()
  }

  /** 手机里的大地图：整城不旋转（按长边等比缩放），画 POI 图标 + 名字、警车、玩家箭头 */
  drawLarge(canvas: HTMLCanvasElement, px: number, pz: number, yaw: number, police: P2[], pois: Poi[]) {
    const g = canvas.getContext('2d')!
    const S = canvas.width
    const k = S / Math.max(this.baseW, this.baseH)
    g.clearRect(0, 0, S, S)
    g.fillStyle = '#1a1f2e'; g.fillRect(0, 0, S, S)
    g.drawImage(this.base, 0, 0, this.baseW * k, this.baseH * k)
    const X = (x: number) => (x - this.minX) * k, Z = (z: number) => (z - this.minZ) * k
    g.font = '10px -apple-system, "PingFang SC", Arial, sans-serif'
    g.textBaseline = 'middle'
    // POI 多时（真实城市）只给主要地点写名字，巴士/的士站画小点
    const many = pois.length > 60
    for (const p of pois) {
      const x = X(p.x), z = Z(p.z)
      const minor = MINOR.has(p.type)
      g.beginPath(); g.arc(x, z, minor ? 1.5 : many ? 3 : 4, 0, Math.PI * 2)
      g.fillStyle = '#' + POI_COLOR[p.type].toString(16).padStart(6, '0'); g.fill()
      if (minor) continue
      g.lineWidth = 1; g.strokeStyle = '#fff'; g.stroke()
      if (many && !NAMED.has(p.type)) continue
      g.fillStyle = '#fff'; g.shadowColor = '#000'; g.shadowBlur = 3
      g.fillText(p.name, x + 6, z)
      g.shadowBlur = 0
    }
    for (const p of police) { g.beginPath(); g.arc(X(p.x), Z(p.z), 3.5, 0, Math.PI * 2); g.fillStyle = '#ff3b3b'; g.fill() }
    g.save(); g.translate(X(px), Z(pz)); g.rotate(-yaw + Math.PI)
    g.beginPath(); g.moveTo(0, -8); g.lineTo(6, 7); g.lineTo(0, 4); g.lineTo(-6, 7); g.closePath()
    g.fillStyle = '#ffffff'; g.fill(); g.lineWidth = 1.5; g.strokeStyle = '#000'; g.stroke()
    g.restore()
  }
}
