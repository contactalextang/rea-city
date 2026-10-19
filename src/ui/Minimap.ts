import { CITY_MIN, CITY_MAX } from '../config'
import type { CityGenerator } from '../world/CityGenerator'
import type { P2 } from '../world/RoadGraph'

/** 右下角圆形小地图：静态城市底图 + 玩家箭头 + 任务/警车/任务车标记，随朝向旋转 */
export class Minimap {
  private canvas = document.getElementById('minimap') as HTMLCanvasElement
  private ctx = this.canvas.getContext('2d')!
  private base = document.createElement('canvas')
  private size = 200
  private scale = 0.75   // px / m

  constructor(city: CityGenerator) {
    const span = CITY_MAX - CITY_MIN
    this.base.width = this.base.height = Math.ceil(span)
    const c = this.base.getContext('2d')!
    c.fillStyle = '#5c5c63'; c.fillRect(0, 0, span, span)
    for (const b of city.blocks) {
      c.fillStyle = b.park ? '#4f7a3a' : '#9d9d98'
      c.fillRect(b.cx - 23 - CITY_MIN, b.cz - 23 - CITY_MIN, 46, 46)
    }
    for (const b of city.buildings) {
      c.fillStyle = '#' + b.color.clone().multiplyScalar(0.85).getHexString()
      c.fillRect(b.box.minX - CITY_MIN, b.box.minZ - CITY_MIN, b.box.maxX - b.box.minX, b.box.maxZ - b.box.minZ)
    }
  }

  draw(px: number, pz: number, yaw: number, target: P2 | null, starts: P2[], police: P2[], gold: P2 | null, hospital: P2) {
    const g = this.ctx, S = this.size, R = S / 2
    g.clearRect(0, 0, S, S)
    g.save()
    g.beginPath(); g.arc(R, R, R - 2, 0, Math.PI * 2); g.clip()
    g.fillStyle = '#4f7a3a'; g.fillRect(0, 0, S, S)
    g.translate(R, R)
    g.rotate(yaw + Math.PI)
    g.scale(this.scale, this.scale)
    g.drawImage(this.base, -(px - CITY_MIN), -(pz - CITY_MIN))
    const dot = (p: P2, color: string, r: number, ring = false) => {
      let dx = p.x - px, dz = p.z - pz
      const d = Math.hypot(dx, dz), max = (R - 10) / this.scale
      if (d > max) { dx *= max / d; dz *= max / d }
      g.beginPath(); g.arc(dx, dz, r, 0, Math.PI * 2)
      g.fillStyle = color; g.fill()
      if (ring) { g.lineWidth = 1.5; g.strokeStyle = '#fff'; g.stroke() }
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
}
