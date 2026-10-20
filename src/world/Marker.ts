import * as THREE from 'three'
import type { P2 } from './RoadGraph'

/** 当前目标专用色（品红）：小地图目标点、HUD 方位、3D 目标光柱共用；避开 POI 各类色、警察红与任务起点黄 */
export const TARGET_COLOR = 0xff2bd6
export const TARGET_CSS = '#ff2bd6'
/** 旧代码里"蓝色目标"的颜色：构造时自动换成目标样式（兼容 Jobs 的 new Marker(0x3ea6ff)） */
const LEGACY_TARGET = 0x3ea6ff

/** 地面光柱标记：圆盘 + 竖直光束（任务起点黄、目标品红）；Jobs / Quests 共用 */
export class Marker {
  group = new THREE.Group()
  private disc: THREE.Mesh
  private beam: THREE.Mesh
  private core: THREE.Mesh | null = null
  /** 目标样式：更粗更亮的光柱 + 内芯，轻微脉动，与 POI 细光柱一眼可分 */
  readonly target: boolean
  constructor(color: number) {
    this.target = color === LEGACY_TARGET || color === TARGET_COLOR
    if (this.target) color = TARGET_COLOR
    const mat = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: this.target ? 0.7 : 0.55, depthWrite: false })
    this.disc = new THREE.Mesh(new THREE.CylinderGeometry(3.2, 3.2, 0.5, 24, 1, true), mat)
    this.disc.position.y = 0.3
    const [r0, r1, h, op] = this.target ? [1.3, 2.4, 160, 0.5] : [0.6, 1.2, 70, 0.22]
    this.beam = new THREE.Mesh(new THREE.CylinderGeometry(r0, r1, h, 12, 1, true), new THREE.MeshBasicMaterial({ color, transparent: true, opacity: op, depthWrite: false, side: THREE.DoubleSide }))
    this.beam.position.y = h / 2
    this.group.add(this.disc, this.beam)
    if (this.target) {
      // 白色内芯：远处也能看出是"任务目标"而不是 POI
      this.core = new THREE.Mesh(new THREE.CylinderGeometry(0.35, 0.5, h, 8, 1, true), new THREE.MeshBasicMaterial({ color: 0xffd6f6, transparent: true, opacity: 0.55, depthWrite: false }))
      this.core.position.y = h / 2
      this.group.add(this.core)
    }
    this.group.visible = false
  }
  get visible() { return this.group.visible }
  get point(): P2 | null { return this.group.visible ? { x: this.group.position.x, z: this.group.position.z } : null }
  set(p: P2 | null) { if (p) { this.group.position.set(p.x, 0, p.z); this.group.visible = true } else this.group.visible = false }
  sync(t: number) {
    if (!this.group.visible) return
    this.disc.rotation.y = t; this.disc.scale.setScalar(1 + Math.sin(t * 3) * 0.05)
    if (this.target) {
      const k = 0.5 + 0.5 * Math.sin(t * 4)
      ;(this.beam.material as THREE.MeshBasicMaterial).opacity = 0.4 + 0.18 * k
      this.beam.scale.set(1 + 0.12 * k, 1, 1 + 0.12 * k)
    }
  }
}
