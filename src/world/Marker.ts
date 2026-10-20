import * as THREE from 'three'
import type { P2 } from './RoadGraph'

/** 地面光柱标记：圆盘 + 竖直光束（任务起点黄、目标蓝）；Jobs / Quests 共用 */
export class Marker {
  group = new THREE.Group()
  private disc: THREE.Mesh
  private beam: THREE.Mesh
  constructor(color: number) {
    const mat = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.55, depthWrite: false })
    this.disc = new THREE.Mesh(new THREE.CylinderGeometry(3.2, 3.2, 0.5, 24, 1, true), mat)
    this.disc.position.y = 0.3
    this.beam = new THREE.Mesh(new THREE.CylinderGeometry(0.6, 1.2, 70, 10, 1, true), new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.22, depthWrite: false, side: THREE.DoubleSide }))
    this.beam.position.y = 35
    this.group.add(this.disc, this.beam)
    this.group.visible = false
  }
  get visible() { return this.group.visible }
  get point(): P2 | null { return this.group.visible ? { x: this.group.position.x, z: this.group.position.z } : null }
  set(p: P2 | null) { if (p) { this.group.position.set(p.x, 0, p.z); this.group.visible = true } else this.group.visible = false }
  sync(t: number) { if (!this.group.visible) return; this.disc.rotation.y = t; this.disc.scale.setScalar(1 + Math.sin(t * 3) * 0.05) }
}
