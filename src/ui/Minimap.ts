import { CITY_MIN, CITY_MAX } from '../config'
import type { CityGenerator } from '../world/CityGenerator'
import type { P2 } from '../world/RoadGraph'
import { POI_COLOR, type Poi } from '../systems/Poi'

/** 预烘焙底图：1 px/m，图片左上角对应世界 (minX, minZ) */
export interface MinimapImageSource { image: HTMLImageElement | HTMLCanvasElement; minX: number; minZ: number }

/** 右下角圆形小地图：静态城市底图 + 玩家箭头 + 任务/警车/任务车标记，随朝向旋转 */
export class Minimap {
  private canvas = document.getElementById('minimap') as HTMLCanvasElement
  private ctx = this.canvas.getContext('2d')!
  private base: HTMLCanvasElement | HTMLImageElement
  private size = 200
  private scale = 0.75   // px / m
  /** 底图左上角对应的世界坐标与底图尺寸（米 = 像素） */
  private minX: number
  private minZ: number
  private baseW: number
  private baseH: number

  /** 传 CityGenerator 时按方格城合成底图；传 { image, minX, minZ } 时直接用预烘焙 PNG */
  constructor(source: CityGenerator | MinimapImageSource) {
    if ('image' in source) {
      this.base = source.image
      this.minX = source.minX; this.minZ = source.minZ
      this.baseW = source.image.width; this.baseH = source.image.height
      return
    }
    const city = source
    const span = CITY_MAX - CITY_MIN
    const base = document.createElement('canvas')
    base.width = base.height = Math.ceil(span)
    const c = base.getContext('2d')!
    c.fillStyle = '#5c5c63'; c.fillRect(0, 0, span, span)
    for (const b of city.blocks) {
      c.fillStyle = b.park ? '#4f7a3a' : '#9d9d98'
      c.fillRect(b.cx - 23 - CITY_MIN, b.cz - 23 - CITY_MIN, 46, 46)
    }
    for (const b of city.buildings) {
      c.fillStyle = '#' + b.color.clone().multiplyScalar(0.85).getHexString()
      c.fillRect(b.box.minX - CITY_MIN, b.box.minZ - CITY_MIN, b.box.maxX - b.box.minX, b.box.maxZ - b.box.minZ)
    }
    this.base = base
    this.minX = CITY_MIN; this.minZ = CITY_MIN
    this.baseW = base.width; this.baseH = base.height
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
    for (const p of pois) dot(p, '#' + POI_COLOR[p.type].toString(16).padStart(6, '0'), 3, true)
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
    for (const p of pois) {
      const x = X(p.x), z = Z(p.z)
      g.beginPath(); g.arc(x, z, 4, 0, Math.PI * 2)
      g.fillStyle = '#' + POI_COLOR[p.type].toString(16).padStart(6, '0'); g.fill()
      g.lineWidth = 1; g.strokeStyle = '#fff'; g.stroke()
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
