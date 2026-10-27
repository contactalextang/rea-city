import * as THREE from 'three'
import { Marker, TARGET_COLOR } from '../../../world/Marker'

/**
 * 飞行工作的 3D 目标指示（AIR.5b）：只用 MeshBasicMaterial（自发光、不受光照、不新增 Light），
 * - 门：发光圆环（下一个门亮、再下一个暗）；
 * - 地面 / 楼顶目标：复用 world/Marker 的品红目标光柱（可抬到楼顶高度）；
 * - 空投包裹：小木箱；接应船：程序化小船（船体 + 驾驶舱）。
 * 所有对象挂在一个常驻 group 下（插件建一个），任务结束 clear() 清掉本单的门 / 包裹 / 船，光柱保留复用。
 */
const RING_R = 40
const ringGeo = () => new THREE.TorusGeometry(RING_R, 2.2, 8, 48)

export class MissionVisuals {
  readonly group = new THREE.Group()
  private rings: THREE.Mesh[] = []
  private ringMats: THREE.MeshBasicMaterial[] = []
  private marker = new Marker(TARGET_COLOR)
  private crates: THREE.Mesh[] = []
  private crateGeo: THREE.BoxGeometry | null = null
  private crateMat: THREE.MeshBasicMaterial | null = null
  private boat: THREE.Group | null = null
  private geos: THREE.BufferGeometry[] = []
  private mats: THREE.Material[] = []

  constructor(scene: THREE.Scene) {
    this.group.name = 'flight-mission'
    this.group.add(this.marker.group)
    scene.add(this.group)
  }

  /** 门：圆心 (x,y,z)，法线沿 (dx,dz) 水平方向 */
  addRing(x: number, y: number, z: number, dx: number, dz: number): number {
    const g = ringGeo(); this.geos.push(g)
    const m = new THREE.MeshBasicMaterial({ color: 0x38e8ff, transparent: true, opacity: 0.85, depthWrite: false, fog: false, side: THREE.DoubleSide })
    this.mats.push(m)
    const r = new THREE.Mesh(g, m)
    r.position.set(x, y, z)
    r.rotation.y = Math.atan2(dx, dz)
    r.name = 'flight-gate'
    r.frustumCulled = true
    this.group.add(r)
    this.rings.push(r); this.ringMats.push(m)
    return this.rings.length - 1
  }
  /** 当前门 i 高亮、i+1 暗显、其余隐藏（i ≥ 门数 → 全藏） */
  focusRing(i: number) {
    this.rings.forEach((r, k) => {
      r.visible = k === i || k === i + 1
      this.ringMats[k].opacity = k === i ? 0.9 : 0.3
      this.ringMats[k].color.setHex(k === i ? 0x38e8ff : 0x9adfff)
    })
  }

  /** 目标光柱（y 抬高：楼顶目标）；null 隐藏 */
  setMarker(p: { x: number; z: number; y?: number } | null) {
    this.marker.set(p)
    if (p) this.marker.group.position.y = p.y ?? 0
  }

  /** 空投包裹（返回 mesh，位置由调用方逐帧更新） */
  addCrate(): THREE.Mesh {
    this.crateGeo ??= new THREE.BoxGeometry(1.2, 1.2, 1.2)
    this.crateMat ??= new THREE.MeshBasicMaterial({ color: 0xb07a3c, fog: true })
    const c = new THREE.Mesh(this.crateGeo, this.crateMat)
    c.name = 'flight-crate'
    this.group.add(c)
    this.crates.push(c)
    return c
  }

  /** 接应小船（海面，船头朝 yaw） */
  addBoat(x: number, z: number, yaw: number) {
    const g = new THREE.Group(); g.name = 'flight-boat'
    const hullG = new THREE.BoxGeometry(4, 1.6, 12), cabG = new THREE.BoxGeometry(3, 2, 3.5), flagG = new THREE.BoxGeometry(0.15, 3, 0.15)
    const hullM = new THREE.MeshBasicMaterial({ color: 0xe8e2d4 }), cabM = new THREE.MeshBasicMaterial({ color: 0x2b3a4a }), flagM = new THREE.MeshBasicMaterial({ color: 0xff3b30 })
    this.geos.push(hullG, cabG, flagG); this.mats.push(hullM, cabM, flagM)
    const hull = new THREE.Mesh(hullG, hullM); hull.position.y = 0.5
    const cab = new THREE.Mesh(cabG, cabM); cab.position.set(0, 2.2, -1.5)
    const flag = new THREE.Mesh(flagG, flagM); flag.position.set(0, 4.5, -1.5)
    g.add(hull, cab, flag)
    g.position.set(x, 0, z); g.rotation.y = yaw
    this.group.add(g)
    this.boat = g
  }

  sync(t: number) {
    this.marker.sync(t)
    if (this.boat) { this.boat.position.y = Math.sin(t * 1.3) * 0.15; this.boat.rotation.z = Math.sin(t * 0.9) * 0.03 }
    for (const r of this.rings) if (r.visible) r.rotation.z = t * 0.4
  }

  /** 清掉本单的门 / 包裹 / 船（光柱隐藏，几何与材质释放） */
  clear() {
    for (const o of [...this.rings, ...this.crates]) o.removeFromParent()
    this.boat?.removeFromParent(); this.boat = null
    for (const g of this.geos) g.dispose()
    for (const m of this.mats) m.dispose()
    this.geos = []; this.mats = []
    this.rings = []; this.ringMats = []; this.crates = []
    this.marker.set(null)
  }
  /** 调试：场景里的门 / 包裹 / 船数 */
  get counts() { return { rings: this.rings.length, crates: this.crates.length, boat: !!this.boat, marker: this.marker.visible } }
}
