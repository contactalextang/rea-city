import * as THREE from 'three'
import { createFlightBody, heading, airspeed, type FlightBody } from '../physics/ArcadeFlight'
import type { Mount } from './Player'
import { loadAirfieldModels, type AirfieldModel } from '../world/AirfieldModels'

/**
 * Phase AIR 飞机实体（AIR.4）：FlightBody（物理，ArcadeFlight 纯函数推进）+ three Group（模型），实现 Player.Mount。
 * 模型先用程序化低模 Cessna 172（高单翼、翼展 11 m、机长 8.3 m、固定前三点起落架），机头朝 +z、原点在机轮触地点；
 * 顶点色白机身 + `_paint` 顶点属性标记的涂装条纹（着色器 uniform uPaint 可换色，与 AIR.1 套件 GLB 的 _paint/_glow 约定一致）。
 * AIR.1 套件 light-aircraft-cessna（11.0 翼展 × 4.66 高 × 9.83 长）异步加载后替换程序化模型（?plane=proc 保留程序化）。
 * 螺旋桨单独节点按油门旋转，高转速换半透明桨盘；航行灯（左红右绿尾白）与红色信标是自发光小体，不新增 Light。
 * useModel(group) 以后可换成 AIR.1 打包的套件模型（若模型里有名为 prop / propeller 的节点则接管旋转）。
 */

export type AircraftModel = 'cessna'

/** 机体局部：前 +z、上 +y、右 −x（左翼在 +x） */
const SPAN = 11, LEN = 8.3
/** 机身圆半径（与车辆、建筑碰撞用） */
export const AIRCRAFT_RADIUS = 4.2
/** 翼尖局部 x */
export const WINGTIP_X = SPAN / 2

const WHITE = 0xf3f4f6, GREY = 0x8b929c, DARK = 0x23272e, GLASS = 0x3b5670, TYRE = 0x1b1b1d

/** 简易几何拼装：盒子 / 圆柱合并成一份带 color + paint 属性的非索引几何 */
class PartBuilder {
  private pos: number[] = []
  private nor: number[] = []
  private col: number[] = []
  private paint: number[] = []
  private glow: number[] = []
  private c = new THREE.Color()
  private m = new THREE.Matrix4()
  private q = new THREE.Quaternion()
  private e = new THREE.Euler()

  add(g: THREE.BufferGeometry, x: number, y: number, z: number, color: number, paint = 0, rx = 0, ry = 0, rz = 0) {
    const geo = g.index ? g.toNonIndexed() : g
    this.q.setFromEuler(this.e.set(rx, ry, rz))
    this.m.compose(new THREE.Vector3(x, y, z), this.q, new THREE.Vector3(1, 1, 1))
    geo.applyMatrix4(this.m)
    const p = geo.getAttribute('position'), n = geo.getAttribute('normal')
    this.c.setHex(color).convertSRGBToLinear()
    for (let i = 0; i < p.count; i++) {
      this.pos.push(p.getX(i), p.getY(i), p.getZ(i))
      this.nor.push(n.getX(i), n.getY(i), n.getZ(i))
      this.col.push(this.c.r, this.c.g, this.c.b)
      this.paint.push(paint)
    this.glow.push(0)
    }
    if (geo !== g) geo.dispose()
    g.dispose()
  }
  box(sx: number, sy: number, sz: number, x: number, y: number, z: number, color: number, paint = 0, rx = 0, ry = 0, rz = 0) {
    this.add(new THREE.BoxGeometry(sx, sy, sz), x, y, z, color, paint, rx, ry, rz)
  }
  /** 沿 x 轴（轮子）或 y 轴的圆柱 */
  cyl(r: number, len: number, x: number, y: number, z: number, color: number, axis: 'x' | 'y' | 'z' = 'y', seg = 10) {
    const g = new THREE.CylinderGeometry(r, r, len, seg)
    this.add(g, x, y, z, color, 0, axis === 'z' ? Math.PI / 2 : 0, 0, axis === 'x' ? Math.PI / 2 : 0)
  }
  build(): THREE.BufferGeometry {
    const g = new THREE.BufferGeometry()
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3))
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.nor, 3))
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.col, 3))
    g.setAttribute('_paint', new THREE.Float32BufferAttribute(this.paint, 1))
    g.setAttribute('_glow', new THREE.Float32BufferAttribute(this.glow, 1))
    g.computeBoundingSphere()
    return g
  }
}

/**
 * 涂装材质（程序化模型与 AIR.1 套件 GLB 共用约定）：
 * - `_paint` 0/1：漆面条纹，color = mix(color, uPaint × 原色亮度, _paint)（uniform 每架飞机独立）；
 * - `_glow` 0/1：航行灯 / 着陆灯 / 窗，夜间自发光 = color × _glow × emissiveIntensity（setNight 按 DayNight.lights 调）。
 */
type PaintMat = THREE.MeshLambertMaterial & { userData: { uPaint: { value: THREE.Color } } }
function paintMaterial(paint: number): PaintMat {
  const mat = new THREE.MeshLambertMaterial({ vertexColors: true, emissive: 0xffffff, emissiveIntensity: 0 }) as PaintMat
  const uPaint = { value: new THREE.Color(paint) }
  mat.userData.uPaint = uPaint
  mat.onBeforeCompile = (s) => {
    s.uniforms.uPaint = uPaint
    s.vertexShader = 'attribute float _paint;\nattribute float _glow;\nuniform vec3 uPaint;\nvarying float vGlow;\n' + s.vertexShader.replace('#include <color_vertex>',
      '#include <color_vertex>\n\tvColor.rgb = mix(vColor.rgb, uPaint * dot(vColor.rgb, vec3(0.2126, 0.7152, 0.0722)), _paint);\n\tvGlow = _glow;')
    s.fragmentShader = 'varying float vGlow;\n' + s.fragmentShader.replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\n\ttotalEmissiveRadiance *= vColor.rgb * vGlow;')
  }
  mat.customProgramCacheKey = () => 'rea-aircraft-paint2'
  return mat
}

/** AIR.1 套件模型（light-aircraft-cessna）：全局只加载一次；失败返回 null（保留程序化模型） */
let kitP: Promise<AirfieldModel | null> | null = null
let kitModel: AirfieldModel | null = null
function loadKit(): Promise<AirfieldModel | null> {
  kitP ??= loadAirfieldModels().then((m) => (kitModel = m.get('light-aircraft-cessna') ?? null))
    .catch((e) => { console.warn('[aircraft] 套件模型加载失败，保留程序化 Cessna', e); return null })
  return kitP
}

/** 程序化低模 Cessna 172（机身 + 机翼 + 尾翼 + 起落架；螺旋桨另建） */
function buildCessnaGeometry(): THREE.BufferGeometry {
  const b = new PartBuilder()
  // 机身：发动机罩 → 座舱 → 尾锥（逐段收窄）
  b.box(1.0, 0.85, 1.2, 0, 1.12, 3.45, WHITE)                // 发动机罩（顶面 1.55，座舱视角能看到）
  b.box(0.7, 0.55, 0.25, 0, 1.0, 4.12, GREY)                  // 进气口面板
  b.box(1.18, 1.35, 2.5, 0, 1.42, 1.6, WHITE)                 // 座舱
  b.box(1.0, 1.05, 1.6, 0, 1.45, -0.45, WHITE)                // 后舱
  b.box(0.75, 0.75, 1.6, 0, 1.55, -2.05, WHITE)               // 尾锥 1
  b.box(0.45, 0.48, 1.3, 0, 1.65, -3.45, WHITE)               // 尾锥 2
  // 涂装条纹（两侧腰线 + 尾锥）
  b.box(1.2, 0.16, 4.0, 0, 1.18, 1.2, WHITE, 1)
  b.box(0.78, 0.14, 1.6, 0, 1.4, -2.05, WHITE, 1)
  b.box(1.02, 0.1, 1.2, 0, 0.72, 3.45, WHITE, 1)              // 发动机罩下沿
  // 玻璃：风挡（前倾）、两侧窗、后窗
  b.box(1.08, 0.62, 0.08, 0, 1.78, 2.86, GLASS, 0, -0.55, 0, 0)
  b.box(1.2, 0.5, 1.7, 0, 1.78, 1.55, GLASS)
  b.box(1.02, 0.4, 0.9, 0, 1.75, -0.35, GLASS)
  // 高单翼：翼展 11 m、弦长 1.5 m，翼根在座舱顶上方
  b.box(SPAN, 0.16, 1.5, 0, 2.18, 1.35, WHITE)
  b.box(SPAN - 0.1, 0.05, 0.25, 0, 2.27, 2.0, WHITE, 1)       // 翼前缘涂装
  b.box(1.0, 0.1, 1.4, 0, 2.08, 1.35, GREY)                   // 翼根整流
  // 翼撑杆（机身下沿 → 翼下 2/3 处，左右各一）
  for (const s of [1, -1]) b.box(3.0, 0.07, 0.09, s * 1.92, 1.5, 1.4, GREY, 0, 0, 0, s * 0.41)
  // 尾翼：平尾（翼展 3.4 m）、垂尾（后掠）
  b.box(3.4, 0.08, 0.95, 0, 1.7, -3.75, WHITE)
  b.box(0.08, 1.45, 1.1, 0, 2.5, -3.75, WHITE, 0, -0.35, 0, 0)
  b.box(0.1, 0.5, 0.8, 0, 2.75, -3.9, WHITE, 1, -0.35, 0, 0)   // 垂尾涂装
  // 前三点起落架：前轮在机头下，主轮在机翼后缘下（弹簧钢腿外撇）
  b.cyl(0.04, 0.85, 0, 0.62, 3.25, GREY)
  b.cyl(0.24, 0.13, 0, 0.24, 3.25, TYRE, 'x', 12)
  for (const s of [1, -1]) {
    b.box(1.05, 0.07, 0.07, s * 0.86, 0.55, 0.65, GREY, 0, 0, 0, -s * 0.5)
    b.cyl(0.29, 0.16, s * 1.32, 0.29, 0.65, TYRE, 'x', 12)
    b.box(0.22, 0.32, 0.65, s * 1.32, 0.42, 0.65, WHITE, 1)    // 轮罩
  }
  // 门（左侧深色缝）与踏板
  b.box(0.02, 1.0, 1.0, 0.6, 1.4, 1.7, DARK)
  return b.build()
}

/** 座舱视角用的内饰（座舱视角时替换机身：机身盒子从里面看会挡住风挡）：仪表板、遮光罩、发动机罩、A 柱、侧壁、机翼与撑杆 */
function buildCockpitGeometry(): THREE.BufferGeometry {
  const b = new PartBuilder()
  b.box(1.0, 0.2, 0.12, 0, 1.3, 2.62, DARK)                   // 仪表板
  b.box(1.0, 0.04, 0.26, 0, 1.42, 2.52, DARK)                 // 遮光罩
  b.box(1.0, 0.85, 1.2, 0, 1.12, 3.45, WHITE)                 // 发动机罩
  b.box(1.02, 0.1, 1.22, 0, 0.72, 3.45, WHITE, 1)
  for (const s of [1, -1]) {
    b.box(0.05, 0.62, 0.06, s * 0.57, 1.86, 2.78, DARK, 0, -0.55, 0, 0)   // A 柱
    b.box(0.05, 0.62, 0.06, s * 0.6, 1.86, 0.45, DARK)                    // B 柱
    b.box(0.04, 0.45, 2.6, s * 0.6, 1.15, 1.55, WHITE)                    // 侧壁（窗下）
    b.box(0.05, 0.05, 2.5, s * 0.6, 1.4, 1.6, WHITE, 1)                   // 侧壁涂装线
    b.box(3.0, 0.07, 0.09, s * 1.92, 1.5, 1.4, GREY, 0, 0, 0, s * 0.41)   // 撑杆
  }
  b.box(SPAN, 0.16, 1.5, 0, 2.18, 1.35, WHITE)                // 机翼
  b.box(1.2, 0.08, 1.6, 0, 2.08, 1.35, GREY)                  // 顶棚
  return b.build()
}

/** 螺旋桨：两片桨叶 + 桨毂整流罩（节点绕局部 z 旋转）；桨盘单独半透明 */
function buildProp(): { prop: THREE.Group; blades: THREE.Mesh; disc: THREE.Mesh } {
  const prop = new THREE.Group()
  prop.name = 'prop'
  prop.position.set(0, 1.12, 4.3)
  const bladeMat = new THREE.MeshLambertMaterial({ color: 0x2a2a2c })
  const bg = new THREE.BoxGeometry(0.13, 1.9, 0.04)
  const blades = new THREE.Mesh(bg, bladeMat)
  blades.rotation.y = 0.25
  const spinner = new THREE.Mesh(new THREE.ConeGeometry(0.2, 0.42, 10).rotateX(Math.PI / 2), new THREE.MeshLambertMaterial({ color: 0xe9eaec }))
  spinner.position.z = 0.15
  const disc = new THREE.Mesh(new THREE.CircleGeometry(0.97, 28), new THREE.MeshBasicMaterial({ color: 0x9aa0a8, transparent: true, opacity: 0.22, depthWrite: false, side: THREE.DoubleSide }))
  disc.visible = false
  disc.userData.castShadow = false
  prop.add(blades, spinner, disc)
  return { prop, blades, disc }
}

/** 航行灯 / 信标：自发光小球（MeshBasicMaterial，不受光照、不投影） */
function lamp(color: number, r = 0.09): THREE.Mesh {
  const m = new THREE.Mesh(new THREE.SphereGeometry(r, 8, 6), new THREE.MeshBasicMaterial({ color }))
  m.castShadow = false
  m.userData.castShadow = false
  return m
}

let sharedGeo: THREE.BufferGeometry | null = null
let cockpitGeo: THREE.BufferGeometry | null = null

export class Aircraft implements Mount {
  readonly body: FlightBody
  readonly group = new THREE.Group()
  readonly model: AircraftModel = 'cessna'
  /** 自有飞机 / 租机等由调用方区分（AIR.5：'rent' | 'own'） */
  owner: 'rent' | 'own' = 'rent'
  /** 业务 id（AIR.5 自有飞机用商店物品 id；租机 'rental'） */
  id = 'rental'
  /** 发动机运转（有人驾驶时） */
  engineOn = false
  /** 已坠毁（实体保留供相机/存档读位置，网格已移除） */
  wrecked = false
  private visual = new THREE.Group()
  private hull: THREE.Object3D
  private cockpit: THREE.Mesh
  private mat: ReturnType<typeof paintMaterial>
  private prop: THREE.Object3D
  private blades: THREE.Object3D | null
  private disc: THREE.Mesh | null
  private beacon: THREE.Mesh
  private strobeL: THREE.Mesh
  private strobeR: THREE.Mesh
  /** 座舱眼点（机身局部；套件模型更高更胖，加载后改） */
  eye = { x: 0, y: 1.65, z: 0.7 }
  /** 已换成套件模型 */
  kit = false
  private propAngle = 0
  private propSpeed = 0
  private t = 0
  /** saveSpot 回调：空中存档落点（插件注入，默认机库门口） */
  spotProvider: ((a: Aircraft) => { x: number; z: number; yaw: number }) | null = null

  constructor(x: number, z: number, yaw: number, paint = 0x1f5fbf) {
    this.body = createFlightBody(x, z, yaw)
    this.group.name = 'aircraft'
    sharedGeo ??= buildCessnaGeometry()
    this.mat = paintMaterial(paint)
    const hull = new THREE.Mesh(sharedGeo, this.mat)
    hull.castShadow = true; hull.receiveShadow = true
    hull.name = 'hull'
    this.visual.add(hull)
    this.hull = hull
    cockpitGeo ??= buildCockpitGeometry()
    this.cockpit = new THREE.Mesh(cockpitGeo, this.mat)
    this.cockpit.name = 'cockpit'
    this.cockpit.visible = false
    this.cockpit.castShadow = false
    this.visual.add(this.cockpit)
    const p = buildProp()
    this.prop = p.prop; this.blades = p.blades; this.disc = p.disc
    p.blades.castShadow = true
    this.visual.add(this.prop)
    // 航行灯：左翼尖红、右翼尖绿（左 = +x）、尾白；信标在垂尾顶；翼尖白色频闪
    const red = lamp(0xff2a2a), green = lamp(0x2aff5a), white = lamp(0xffffff, 0.07)
    red.position.set(WINGTIP_X + 0.02, 2.18, 1.6); green.position.set(-WINGTIP_X - 0.02, 2.18, 1.6); white.position.set(0, 1.7, -4.15)
    this.beacon = lamp(0xff3030, 0.1); this.beacon.position.set(0, 3.22, -4.05)
    this.strobeL = lamp(0xffffff, 0.08); this.strobeL.position.set(WINGTIP_X, 2.22, 1.2)
    this.strobeR = lamp(0xffffff, 0.08); this.strobeR.position.set(-WINGTIP_X, 2.22, 1.2)
    red.userData.navLamp = green.userData.navLamp = white.userData.navLamp = true
    this.visual.add(red, green, white, this.beacon, this.strobeL, this.strobeR)
    this.group.add(this.visual)
    this.sync(0)
    // 套件模型就绪后替换（加载前先显示程序化模型；?plane=proc 保留程序化）
    const proc = typeof location !== 'undefined' && new URLSearchParams(location.search).get('plane') === 'proc'
    if (!proc) {
      if (kitModel) this.useKit(kitModel)
      else void loadKit().then((m) => { if (m && !this.kit && !this.disposed) this.useKit(m) })
    }
  }
  private disposed = false

  /**
   * 换上 AIR.1 套件 Cessna：机身几何（_paint/_glow）共用涂装材质；螺旋桨子件 prop:cessna-prop（桨毂原点、绕局部 z、半径 1.45 m）；
   * 航行灯由几何里的 _glow 负责（只保留程序化信标与翼尖频闪，按模型包围盒重新摆位）；座舱内饰按模型尺寸缩放、眼点上移。
   */
  private useKit(m: AirfieldModel) {
    this.kit = true
    const hull = new THREE.Mesh(m.geometry, this.mat)
    hull.name = 'hull'; hull.castShadow = true; hull.receiveShadow = true
    hull.visible = this.hull.visible
    this.visual.remove(this.hull)
    this.hull = hull
    this.visual.add(hull)
    // 螺旋桨
    const part = m.children.get('prop:cessna-prop') ?? m.children.get('cessna-prop') ?? [...m.children.values()].find((c) => /prop/i.test(c.id))
    if (part) {
      this.visual.remove(this.prop)
      const prop = new THREE.Group(); prop.name = 'prop'
      prop.position.copy(part.position)
      const blades = new THREE.Mesh(part.geometry, this.mat)
      blades.castShadow = true
      const r = (part.geometry.boundingSphere?.radius ?? 1.45)
      const disc = new THREE.Mesh(new THREE.CircleGeometry(Math.min(1.6, r), 28), new THREE.MeshBasicMaterial({ color: 0x9aa0a8, transparent: true, opacity: 0.22, depthWrite: false, side: THREE.DoubleSide }))
      disc.visible = false; disc.userData.castShadow = false
      prop.add(blades, disc)
      this.visual.add(prop)
      this.prop = prop; this.blades = blades; this.disc = disc
    }
    // 程序化航行灯点去掉（几何自带 _glow 灯），信标 / 频闪按包围盒摆
    for (const c of [...this.visual.children]) if (c.userData.navLamp) this.visual.remove(c)
    const bb = m.geometry.boundingBox ?? new THREE.Box3().setFromBufferAttribute(m.geometry.getAttribute('position') as THREE.BufferAttribute)
    // 翼尖高度：|x| > 0.95 半翼展的顶点平均 y
    const pos = m.geometry.getAttribute('position')
    let wy = 0, wz = 0, wn = 0
    for (let i = 0; i < pos.count; i++) if (Math.abs(pos.getX(i)) > bb.max.x * 0.95) { wy += pos.getY(i); wz += pos.getZ(i); wn++ }
    if (wn) { wy /= wn; wz /= wn } else { wy = bb.max.y * 0.6; wz = 1 }
    this.strobeL.position.set(bb.max.x, wy + 0.05, wz - 0.3)
    this.strobeR.position.set(bb.min.x, wy + 0.05, wz - 0.3)
    this.beacon.position.set(0, bb.max.y + 0.06, bb.min.z + 0.9)
    // 座舱：内饰整体平移到套件螺旋桨轴（程序化桨轴在 (0, 1.12, 4.3)），尺寸不缩放；眼点同步平移
    const hub = part ? part.position : new THREE.Vector3(0, 2.36, 4.83)
    const dy = hub.y - 1.12, dz = hub.z - 4.3
    this.cockpit.position.set(0, dy, dz)
    this.eye = { x: 0, y: 1.65 + dy, z: 0.7 + dz }
  }

  /** 夜间自发光（_glow 部分）：k = DayNight.lights（0 白天 – 1 夜） */
  setNight(k: number) { this.mat.emissiveIntensity = 1.5 * k }

  // ---- Mount 接口 ----
  get x() { return this.body.x }
  get y() { return this.body.y }
  get z() { return this.body.z }
  get vx() { return this.body.vx }
  get vz() { return this.body.vz }
  get yaw() { return heading(this.body) }
  saveSpot() { return this.spotProvider ? this.spotProvider(this) : { x: this.body.x, z: this.body.z, yaw: this.yaw } }

  get speed() { return airspeed(this.body) }

  /** 座舱视角：机身换成内饰（外部模型同样隐藏） */
  setCockpit(on: boolean) { this.hull.visible = !on; this.cockpit.visible = on }

  /** 涂装色 */
  setPaint(hex: number) { this.mat.userData.uPaint.value.setHex(hex) }

  /**
   * 换成外部模型（AIR.1 套件 GLB；机头须朝 +z、原点在机轮触地点、真实尺寸）。
   * 模型里名为 prop / propeller 的节点接管螺旋桨旋转（绕局部 z）；没有就保留程序化螺旋桨。
   */
  useModel(g: THREE.Object3D) {
    const old = this.visual.children.find((c) => c.name === 'hull')
    if (old) { this.visual.remove(old) }
    g.name = 'hull'
    g.visible = this.hull.visible
    this.hull = g
    g.traverse((o) => { const m = o as THREE.Mesh; if (m.isMesh) { m.castShadow = true; m.receiveShadow = true } })
    this.visual.add(g)
    let p: THREE.Object3D | undefined
    g.traverse((o) => { if (!p && /^prop(eller)?/i.test(o.name)) p = o })
    if (p) { this.visual.remove(this.prop); this.prop = p; this.blades = null; this.disc = null }
  }

  /** 物理 → 网格；dt 用于螺旋桨与灯 */
  sync(dt: number) {
    const b = this.body
    this.t += dt
    this.group.position.set(b.x, b.y, b.z)
    this.group.quaternion.set(b.qx, b.qy, b.qz, b.qw)
    // 螺旋桨：怠速 ~12 rad/s，满油门 ~60 rad/s（视觉上已糊成桨盘）
    const want = this.engineOn ? 12 + b.throttle * 48 : 0
    this.propSpeed += (want - this.propSpeed) * Math.min(1, dt * 1.5)
    this.propAngle = (this.propAngle + this.propSpeed * dt) % (Math.PI * 2)
    this.prop.rotation.z = this.propAngle
    const blur = this.propSpeed > 25
    if (this.blades) this.blades.visible = !blur
    if (this.disc) this.disc.visible = blur
    // 信标 1 Hz（亮 0.15 s），翼尖频闪 1.2 s 双闪；发动机关时信标灭
    const ph = this.t % 1
    this.beacon.visible = this.engineOn && ph < 0.15
    const s = this.t % 1.2
    const strobe = this.engineOn && (s < 0.05 || (s > 0.15 && s < 0.2))
    this.strobeL.visible = strobe; this.strobeR.visible = strobe
  }

  /** 机体局部点 → 世界（相机座舱视角、下机点用） */
  localToWorld(lx: number, ly: number, lz: number, out = new THREE.Vector3()) {
    const b = this.body
    out.set(lx, ly, lz).applyQuaternion(new THREE.Quaternion(b.qx, b.qy, b.qz, b.qw))
    return out.set(out.x + b.x, out.y + b.y, out.z + b.z)
  }

  dispose() {
    this.disposed = true
    this.group.removeFromParent()
    this.mat.dispose()
    this.group.traverse((o) => {
      const m = o as THREE.Mesh
      if (!m.isMesh || m.geometry === sharedGeo || m.geometry === cockpitGeo || (kitModel && (m.geometry === kitModel.geometry || [...kitModel.children.values()].some((c) => c.geometry === m.geometry)))) return
      m.geometry.dispose()
      const mm = m.material as THREE.Material
      if (mm !== this.mat) mm.dispose()
    })
  }
}

/** 机长（m，供 AIR.5 停机位间距等） */
export const AIRCRAFT_LENGTH = LEN
