import * as THREE from 'three'
import { POI_COLOR, type Poi, type PoiType } from '../systems/Poi'

/**
 * POI 世界标志（方格城与真实城市共用）：
 * - 普通类型：细柱 + 顶部自发光方块（按类型配色）+ 可选半透明光柱 + 名牌精灵；
 * - smallTypes（巴士站/的士站，数量多）：矮柱 + 小色牌，不带名牌与光柱。
 * 柱子/方块/光柱/小牌全部用 InstancedMesh（每种一个 draw call）；名牌是独立 Sprite，
 * 只在玩家 labelDist 内显示（update 里按距离开关），避免远处一片文字。
 */
export interface PoiMarkerOptions {
  /** 普通类型是否加光柱（真实城市用，便于远处找到） */
  beams: boolean
  /** 名牌显示距离（m），Infinity = 一直显示 */
  labelDist: number
  /** 只画小牌的类型 */
  smallTypes: readonly PoiType[]
  /** 标志放在门口（真实城市：POI 坐标多在建筑中心，门口才在人行道上）；否则放在 poi.x/z */
  atDoor: boolean
}

const BEAM_H = 26
const tmpM = new THREE.Matrix4()
const tmpC = new THREE.Color()

export class PoiMarkers {
  readonly group = new THREE.Group()
  private labels: { sprite: THREE.Sprite; x: number; z: number }[] = []
  private lastX = Infinity
  private lastZ = Infinity

  constructor(pois: Poi[], private opts: PoiMarkerOptions) {
    this.group.name = 'poiMarkers'
    const big: { p: Poi; x: number; z: number }[] = [], small: { p: Poi; x: number; z: number }[] = []
    for (const p of pois) {
      let x = p.x, z = p.z
      if (opts.atDoor) {
        // 门口向建筑方向退 1.2 m，避免挡住站位
        const dx = p.x - p.door.x, dz = p.z - p.door.z, d = Math.hypot(dx, dz)
        x = p.door.x + (d > 0.01 ? (dx / d) * Math.min(1.2, d) : 0)
        z = p.door.z + (d > 0.01 ? (dz / d) * Math.min(1.2, d) : 0)
      }
      ;(opts.smallTypes.includes(p.type) ? small : big).push({ p, x, z })
    }
    if (big.length) {
      const pole = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.09, 0.12, 3.2, 8).translate(0, 1.6, 0), new THREE.MeshLambertMaterial({ color: 0x3a3f47 }), big.length)
      const cube = new THREE.InstancedMesh(new THREE.BoxGeometry(0.6, 0.6, 0.6).translate(0, 3.5, 0), new THREE.MeshBasicMaterial({ color: 0xffffff }), big.length)
      cube.userData.castShadow = false
      const beam = opts.beams
        ? new THREE.InstancedMesh(new THREE.CylinderGeometry(0.35, 0.35, BEAM_H, 8, 1, true).translate(0, 3.8 + BEAM_H / 2, 0),
          new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.28, depthWrite: false, side: THREE.DoubleSide }), big.length)
        : null
      if (beam) beam.userData.castShadow = false
      big.forEach(({ p, x, z }, k) => {
        tmpM.makeTranslation(x, 0.12, z)
        pole.setMatrixAt(k, tmpM); cube.setMatrixAt(k, tmpM)
        tmpC.setHex(POI_COLOR[p.type])
        cube.setColorAt(k, tmpC)
        if (beam) { beam.setMatrixAt(k, tmpM); beam.setColorAt(k, tmpC) }
        const label = makeLabelSprite(p.name)
        label.position.set(x, 4.5, z)
        label.visible = !Number.isFinite(opts.labelDist)
        this.labels.push({ sprite: label, x, z })
        this.group.add(label)
      })
      for (const m of [pole, cube, beam]) if (m) { m.computeBoundingSphere(); this.group.add(m) }
    }
    if (small.length) {
      const post = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.05, 0.06, 2.4, 6).translate(0, 1.2, 0), new THREE.MeshLambertMaterial({ color: 0x5a5f66 }), small.length)
      const plate = new THREE.InstancedMesh(new THREE.BoxGeometry(0.5, 0.36, 0.08).translate(0, 2.3, 0), new THREE.MeshBasicMaterial({ color: 0xffffff }), small.length)
      plate.userData.castShadow = false
      small.forEach(({ p, x, z }, k) => {
        tmpM.makeRotationY(p.door.yaw).setPosition(x, 0.12, z)
        post.setMatrixAt(k, tmpM); plate.setMatrixAt(k, tmpM)
        plate.setColorAt(k, tmpC.setHex(POI_COLOR[p.type]))
      })
      for (const m of [post, plate]) { m.computeBoundingSphere(); this.group.add(m) }
    }
  }

  attach(scene: THREE.Scene) { scene.add(this.group) }

  /** 名牌按距离开关（玩家移动超过 5 m 才重算） */
  update(px: number, pz: number) {
    if (!Number.isFinite(this.opts.labelDist)) return
    if (Math.abs(px - this.lastX) < 5 && Math.abs(pz - this.lastZ) < 5) return
    this.lastX = px; this.lastZ = pz
    const r2 = this.opts.labelDist * this.opts.labelDist
    for (const l of this.labels) l.sprite.visible = (l.x - px) * (l.x - px) + (l.z - pz) * (l.z - pz) < r2
  }

  get visibleLabels() { return this.labels.reduce((n, l) => n + (l.sprite.visible ? 1 : 0), 0) }
}

/** 名牌：canvas 文字精灵（固定像素比例，距离远时自然缩小） */
export function makeLabelSprite(text: string) {
  const c = document.createElement('canvas')
  const g = c.getContext('2d')!
  const font = 'bold 28px -apple-system, "PingFang SC", "Helvetica Neue", Arial, sans-serif'
  g.font = font
  const w = Math.ceil(g.measureText(text).width) + 28
  c.width = w; c.height = 48
  g.font = font
  g.fillStyle = 'rgba(0,0,0,0.6)'
  g.beginPath(); g.roundRect(0, 0, w, 48, 10); g.fill()
  g.fillStyle = '#ffffff'; g.textBaseline = 'middle'; g.textAlign = 'center'
  g.fillText(text, w / 2, 25)
  const tex = new THREE.CanvasTexture(c)
  tex.colorSpace = THREE.SRGBColorSpace
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false }))
  sprite.scale.set(w / 48 * 0.9, 0.9, 1)
  return sprite
}
