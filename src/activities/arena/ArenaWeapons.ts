import * as THREE from 'three'
import { WEAPONS, AWP_NOSCOPE_SPREAD, HIT_MUL, recoilAt, type HitGroup, type WeaponDef } from '../../data/arena'
import type { ArenaMap, RayHit } from './ArenaMap'
import { Actor, WeaponState } from './Actor'

// ———————————————————— 命中盒 ————————————————————
const _o2 = { t0: 0, t1: 0 }
/** 射线对竖直圆柱（xz 圆 + y 区间），返回进入 t 或 null */
function rayCyl(ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, cx: number, cz: number, r: number, y0: number, y1: number): number | null {
  const fx = ox - cx, fz = oz - cz
  const a = dx * dx + dz * dz
  let t0: number, t1: number
  if (a < 1e-10) { if (fx * fx + fz * fz > r * r) return null; t0 = -Infinity; t1 = Infinity }
  else {
    const b = 2 * (fx * dx + fz * dz), c = fx * fx + fz * fz - r * r
    const disc = b * b - 4 * a * c
    if (disc < 0) return null
    const s = Math.sqrt(disc)
    t0 = (-b - s) / (2 * a); t1 = (-b + s) / (2 * a)
  }
  // y 区间
  let ya: number, yb: number
  if (Math.abs(dy) < 1e-10) { if (oy < y0 || oy > y1) return null; ya = -Infinity; yb = Infinity }
  else { ya = (y0 - oy) / dy; yb = (y1 - oy) / dy; if (ya > yb) { const t = ya; ya = yb; yb = t } }
  const enter = Math.max(t0, ya), exit = Math.min(t1, yb)
  if (enter > exit || exit < 0) return null
  _o2.t0 = enter; _o2.t1 = exit
  return Math.max(0, enter)
}
function raySphere(ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, cx: number, cy: number, cz: number, r: number): number | null {
  const fx = ox - cx, fy = oy - cy, fz = oz - cz
  const b = fx * dx + fy * dy + fz * dz, c = fx * fx + fy * fy + fz * fz - r * r
  const disc = b * b - c
  if (disc < 0) return null
  const t = -b - Math.sqrt(disc)
  return t < 0 ? null : t
}
/** 各部位高度（站立；蹲伏按比例压缩） */
export function headCenter(a: Actor, out: THREE.Vector3): THREE.Vector3 {
  const k = 1 - 0.27 * a.crouch
  const fx = -Math.sin(a.yaw), fz = -Math.cos(a.yaw)
  return out.set(a.body.x + fx * 0.04, a.body.y + 1.66 * k, a.body.z + fz * 0.04)
}
export function chestPoint(a: Actor, out: THREE.Vector3): THREE.Vector3 {
  const k = 1 - 0.27 * a.crouch
  return out.set(a.body.x, a.body.y + 1.25 * k, a.body.z)
}
const _hc = new THREE.Vector3()
/** 射线（d 归一化）对角色：返回 { t, group } */
export function rayActor(a: Actor, ox: number, oy: number, oz: number, dx: number, dy: number, dz: number): { t: number; group: HitGroup } | null {
  const k = 1 - 0.27 * a.crouch, y = a.body.y
  // 粗筛
  if (rayCyl(ox, oy, oz, dx, dy, dz, a.body.x, a.body.z, 0.45, y, y + 1.9 * k) === null) return null
  let best = Infinity, g: HitGroup = 'chest'
  headCenter(a, _hc)
  const th = raySphere(ox, oy, oz, dx, dy, dz, _hc.x, _hc.y, _hc.z, 0.14)
  if (th !== null && th < best) { best = th; g = 'head' }
  const tc = rayCyl(ox, oy, oz, dx, dy, dz, a.body.x, a.body.z, 0.24, y + 1.02 * k, y + 1.52 * k)
  if (tc !== null && tc < best) { best = tc; g = 'chest' }
  const ts = rayCyl(ox, oy, oz, dx, dy, dz, a.body.x, a.body.z, 0.22, y + 0.8 * k, y + 1.02 * k)
  if (ts !== null && ts < best) { best = ts; g = 'stomach' }
  const tl = rayCyl(ox, oy, oz, dx, dy, dz, a.body.x, a.body.z, 0.2, y, y + 0.8 * k)
  if (tl !== null && tl < best) { best = tl; g = 'legs' }
  return best === Infinity ? null : { t: best, group: g }
}

// ———————————————————— 特效：曳光 / 弹孔 / 火花 / 血雾 / 枪口焰 ————————————————————
const _m = new THREE.Matrix4(), _q = new THREE.Quaternion(), _s = new THREE.Vector3(), _p = new THREE.Vector3(), _z = new THREE.Vector3(0, 0, 1), _c = new THREE.Color()
const _a = new THREE.Vector3(), _b = new THREE.Vector3()

class Pool {
  readonly mesh: THREE.InstancedMesh
  private life: Float32Array
  private max: Float32Array
  private kind: Uint8Array
  private pos: Float32Array
  private vel: Float32Array
  private size: Float32Array
  private quat: Float32Array
  private col: Float32Array
  private next = 0
  constructor(geo: THREE.BufferGeometry, mat: THREE.Material, readonly n: number) {
    this.mesh = new THREE.InstancedMesh(geo, mat, n)
    this.mesh.frustumCulled = false
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
    this.life = new Float32Array(n); this.max = new Float32Array(n); this.kind = new Uint8Array(n)
    this.pos = new Float32Array(n * 3); this.vel = new Float32Array(n * 3); this.size = new Float32Array(n * 3); this.quat = new Float32Array(n * 4); this.col = new Float32Array(n * 3)
    _m.makeScale(0, 0, 0)
    for (let i = 0; i < n; i++) { this.mesh.setMatrixAt(i, _m); this.mesh.setColorAt(i, _c.setRGB(0, 0, 0)) }
  }
  /** kind 0 = 缩小消失；1 = 颜色衰减（加法混合）；2 = 常驻（弹孔，按池轮换） */
  spawn(p: THREE.Vector3, q: THREE.Quaternion, size: THREE.Vector3, life: number, color: THREE.Color, kind: number, vel?: THREE.Vector3) {
    const i = this.next; this.next = (this.next + 1) % this.n
    this.life[i] = life; this.max[i] = life; this.kind[i] = kind
    this.pos.set([p.x, p.y, p.z], i * 3); this.size.set([size.x, size.y, size.z], i * 3); this.quat.set([q.x, q.y, q.z, q.w], i * 4)
    this.col.set([color.r, color.g, color.b], i * 3)
    this.vel.set(vel ? [vel.x, vel.y, vel.z] : [0, 0, 0], i * 3)
    this.write(i, 1)
    this.mesh.instanceMatrix.needsUpdate = true
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true
  }
  private write(i: number, f: number) {
    const k = this.kind[i]
    _p.fromArray(this.pos, i * 3); _q.fromArray(this.quat, i * 4); _s.fromArray(this.size, i * 3)
    if (k === 0) _s.multiplyScalar(f)
    _m.compose(_p, _q, _s); this.mesh.setMatrixAt(i, _m)
    _c.fromArray(this.col, i * 3); if (k === 1) _c.multiplyScalar(f)
    this.mesh.setColorAt(i, _c)
  }
  update(dt: number) {
    let dirty = false
    for (let i = 0; i < this.n; i++) {
      if (this.life[i] <= 0 || this.kind[i] === 2) continue
      dirty = true
      this.life[i] -= dt
      const vi = i * 3
      if (this.vel[vi] || this.vel[vi + 1] || this.vel[vi + 2]) { this.pos[vi] += this.vel[vi] * dt; this.pos[vi + 1] += this.vel[vi + 1] * dt; this.pos[vi + 2] += this.vel[vi + 2] * dt; this.vel[vi + 1] -= 6 * dt }
      const f = Math.max(0, this.life[i] / this.max[i])
      if (this.life[i] <= 0) { _m.makeScale(0, 0, 0); this.mesh.setMatrixAt(i, _m) } else this.write(i, f)
    }
    if (dirty) { this.mesh.instanceMatrix.needsUpdate = true; if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true }
  }
  clear() { this.life.fill(0); _m.makeScale(0, 0, 0); for (let i = 0; i < this.n; i++) this.mesh.setMatrixAt(i, _m); this.mesh.instanceMatrix.needsUpdate = true }
}

export class Effects {
  readonly group = new THREE.Group()
  private tracers: Pool
  private holes: Pool
  private sparks: Pool
  private blood: Pool
  private flashes: Pool
  private disposables: { dispose(): void }[] = []
  constructor() {
    const box = new THREE.BoxGeometry(1, 1, 1)
    const tracerGeo = new THREE.BoxGeometry(1, 1, 1); tracerGeo.translate(0, 0, 0.5)
    const quad = new THREE.PlaneGeometry(1, 1)
    const holeTex = (() => {
      const c = document.createElement('canvas'); c.width = c.height = 64
      const g = c.getContext('2d')!
      const grd = g.createRadialGradient(32, 32, 2, 32, 32, 30)
      grd.addColorStop(0, 'rgba(10,8,6,1)'); grd.addColorStop(0.35, 'rgba(25,20,15,0.95)'); grd.addColorStop(0.6, 'rgba(60,50,40,0.5)'); grd.addColorStop(1, 'rgba(60,50,40,0)')
      g.fillStyle = grd; g.fillRect(0, 0, 64, 64)
      const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; return t
    })()
    const flashTex = (() => {
      const c = document.createElement('canvas'); c.width = c.height = 64
      const g = c.getContext('2d')!
      const grd = g.createRadialGradient(32, 32, 0, 32, 32, 32)
      grd.addColorStop(0, 'rgba(255,255,255,1)'); grd.addColorStop(0.3, 'rgba(255,220,140,0.9)'); grd.addColorStop(1, 'rgba(255,140,40,0)')
      g.fillStyle = grd; g.fillRect(0, 0, 64, 64)
      const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; return t
    })()
    const mAdd = new THREE.MeshBasicMaterial({ color: 0xffffff, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, toneMapped: false })
    const mHole = new THREE.MeshBasicMaterial({ map: holeTex, transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4 })
    const mSpark = new THREE.MeshBasicMaterial({ color: 0xffffff, toneMapped: false })
    const mBlood = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.6 })
    const mFlash = new THREE.MeshBasicMaterial({ map: flashTex, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, toneMapped: false, side: THREE.DoubleSide })
    this.disposables.push(box, tracerGeo, quad, holeTex, flashTex, mAdd, mHole, mSpark, mBlood, mFlash)
    this.tracers = new Pool(tracerGeo, mAdd, 40)
    this.holes = new Pool(quad, mHole, 96)
    this.sparks = new Pool(box, mSpark, 64)
    this.blood = new Pool(box, mBlood, 48)
    this.flashes = new Pool(quad, mFlash, 16)
    this.group.add(this.tracers.mesh, this.holes.mesh, this.sparks.mesh, this.blood.mesh, this.flashes.mesh)
    this.holes.mesh.renderOrder = 2
  }
  tracer(from: THREE.Vector3, to: THREE.Vector3) {
    _a.subVectors(to, from); const len = _a.length(); if (len < 0.5) return
    _q.setFromUnitVectors(_z, _a.divideScalar(len))
    // 只画一段（随机位置的 1/3 长，看起来像飞行中的弹头）
    const seg = Math.min(len, 6 + len * 0.15)
    const start = Math.random() * Math.max(0, len - seg) * 0.6
    _b.copy(from).addScaledVector(_a, start)
    this.tracers.spawn(_b, _q, _s.set(0.025, 0.025, seg), 0.07, _c.setRGB(3, 2.4, 1.2), 1)
  }
  impact(p: THREE.Vector3, n: THREE.Vector3, metal: boolean) {
    _q.setFromUnitVectors(_z, n)
    _b.copy(p).addScaledVector(n, 0.005)
    this.holes.spawn(_b, _q, _s.set(0.09, 0.09, 1), 1, _c.setRGB(1, 1, 1), 2)
    for (let i = 0; i < (metal ? 5 : 3); i++) {
      _a.set(n.x + (Math.random() - 0.5) * 1.4, n.y + Math.random() * 0.8, n.z + (Math.random() - 0.5) * 1.4).multiplyScalar(2 + Math.random() * 3)
      this.sparks.spawn(p, _q.identity(), _s.setScalar(0.03 + Math.random() * 0.03), 0.18 + Math.random() * 0.15, metal ? _c.setRGB(4, 2.6, 1) : _c.setRGB(0.55, 0.5, 0.42), 0, _a)
    }
  }
  bloodHit(p: THREE.Vector3, dir: THREE.Vector3, head: boolean) {
    for (let i = 0; i < (head ? 8 : 4); i++) {
      _a.set(dir.x + (Math.random() - 0.5), dir.y + Math.random() * 0.6, dir.z + (Math.random() - 0.5)).multiplyScalar(1.5 + Math.random() * 2)
      this.blood.spawn(p, _q.identity(), _s.setScalar(0.05 + Math.random() * 0.06), 0.35, _c.setRGB(0.45, 0.02, 0.02), 0, _a)
    }
  }
  muzzle(p: THREE.Vector3, camera: THREE.Camera, size = 0.35) {
    _q.copy(camera.quaternion)
    this.flashes.spawn(p, _q, _s.set(size, size, size), 0.05, _c.setRGB(1, 1, 1), 1)
  }
  update(dt: number) { this.tracers.update(dt); this.sparks.update(dt); this.blood.update(dt); this.flashes.update(dt); this.holes.update(dt) }
  clearHoles() { this.holes.clear() }
  dispose() { for (const d of this.disposables) d.dispose(); for (const p of [this.tracers, this.holes, this.sparks, this.blood, this.flashes]) p.mesh.dispose(); this.group.removeFromParent() }
}

// ———————————————————— 第一人称枪模 ————————————————————
const VM_SCALE = 0.6
export class Viewmodel {
  readonly group = new THREE.Group()
  private models = new Map<string, THREE.Group>()
  private cur: THREE.Group | null = null
  private curId = ''
  private disposables: { dispose(): void }[] = []
  private kick = 0
  private bobT = 0
  private swayX = 0; private swayY = 0
  readonly muzzleLocal = new THREE.Vector3()
  readonly flashLight: THREE.PointLight
  private flashT = 0
  private sleeve: THREE.MeshStandardMaterial
  constructor() {
    this.sleeve = new THREE.MeshStandardMaterial({ color: 0x3a3328, roughness: 0.85 })
    this.disposables.push(this.sleeve)
    this.flashLight = new THREE.PointLight(0xffc070, 0, 6, 2)
    this.flashLight.position.set(0.1, -0.08, -0.5)
    this.group.add(this.flashLight)
  }
  setSide(side: 'T' | 'CT') { this.sleeve.color.setHex(side === 'T' ? 0x5a4a32 : 0x1f2a44) }
  private build(id: string): THREE.Group {
    const def = WEAPONS[id] ?? WEAPONS.knife
    const g = new THREE.Group()
    const dark = new THREE.MeshStandardMaterial({ color: def.color, roughness: 0.38, metalness: 0.7 })
    const black = new THREE.MeshStandardMaterial({ color: 0x1b1c1f, roughness: 0.5, metalness: 0.5 })
    const wood = new THREE.MeshStandardMaterial({ color: 0x7a4a26, roughness: 0.55 })
    const skin = new THREE.MeshStandardMaterial({ color: 0xc89070, roughness: 0.65 })
    const glove = new THREE.MeshStandardMaterial({ color: 0x2a2a2a, roughness: 0.8 })
    this.disposables.push(dark, black, wood, skin, glove)
    const B = (w: number, h: number, d: number, x: number, y: number, z: number, m: THREE.Material, rx = 0) => {
      const geo = new THREE.BoxGeometry(w, h, d); this.disposables.push(geo)
      const mesh = new THREE.Mesh(geo, m); mesh.position.set(x, y, z); mesh.rotation.x = rx; g.add(mesh); return mesh
    }
    /** 手 + 前臂：从握点伸向屏幕外（右下后 / 左下后），不穿过相机 */
    const arm = (hx: number, hy: number, hz: number, ex: number, ey: number, ez: number) => {
      B(0.042, 0.046, 0.06, hx, hy, hz, glove)
      const from = new THREE.Vector3(hx, hy - 0.01, hz + 0.02), to = new THREE.Vector3(ex, ey, ez)
      const dir = to.clone().sub(from), len = dir.length()
      const geo = new THREE.BoxGeometry(0.05, 0.05, len); this.disposables.push(geo)
      const m = new THREE.Mesh(geo, this.sleeve)
      m.position.copy(from).addScaledVector(dir, 0.5)
      m.quaternion.setFromUnitVectors(_z, dir.normalize())
      g.add(m)
      const wr = new THREE.BoxGeometry(0.036, 0.036, 0.03); this.disposables.push(wr)
      const w = new THREE.Mesh(wr, skin); w.position.copy(from).addScaledVector(dir, 0.04); w.quaternion.copy(m.quaternion); g.add(w)
    }
    const kind = def.kind
    const L = kind === 'sniper' ? 0.42 : kind === 'rifle' ? 0.36 : kind === 'shotgun' ? 0.35 : kind === 'smg' ? 0.26 : 0.16
    if (kind === 'knife') {
      B(0.024, 0.03, 0.08, 0, 0, 0, black)
      B(0.006, 0.026, 0.13, 0, 0.004, -0.1, dark)
      arm(0, -0.005, 0.02, 0.12, -0.26, 0.3)
      g.userData.muzzle = new THREE.Vector3(0, 0, -0.17)
    } else if (kind === 'pistol') {
      B(0.026, 0.03, L, 0, 0.012, -L / 2, dark)
      B(0.024, 0.06, 0.03, 0, -0.025, -0.012, black, 0.25)
      if (def.id === 'usp') B(0.02, 0.02, 0.07, 0, 0.012, -L - 0.035, black)
      if (def.id === 'deagle') B(0.03, 0.012, L * 0.9, 0, 0.032, -L / 2, black)
      arm(0, -0.05, 0.0, 0.11, -0.27, 0.3)
      arm(-0.03, -0.055, 0.005, -0.17, -0.28, 0.24)
      g.userData.muzzle = new THREE.Vector3(0, 0.012, def.id === 'usp' ? -L - 0.07 : -L)
    } else {
      const ak = def.id === 'ak47'
      B(0.034, 0.05, L * 0.5, 0, 0, -L * 0.28, dark)                            // 机匣
      B(0.013, 0.013, L * 0.42, 0, 0.012, -L * 0.79, black)                     // 枪管
      B(0.03, 0.04, L * 0.26, 0, -0.004, -L * 0.56, ak ? wood : black)          // 护木
      B(0.024, 0.055, 0.028, 0, -0.04, -0.02, black, 0.3)                       // 握把
      if (kind !== 'shotgun') B(0.022, ak ? 0.085 : 0.075, 0.03, 0, -0.06, -L * 0.36, black, ak ? -0.35 : -0.1)   // 弹匣
      else B(0.026, 0.026, L * 0.4, 0, -0.03, -L * 0.62, black)                // 霰弹枪管状弹仓
      B(0.03, 0.045, 0.12, 0, -0.012, 0.05, ak ? wood : black)                  // 枪托
      if (kind === 'sniper') { B(0.026, 0.026, 0.16, 0, 0.048, -L * 0.3, black); B(0.034, 0.034, 0.015, 0, 0.048, -L * 0.3 - 0.085, black) }
      if (def.id === 'm4a4') { B(0.01, 0.022, 0.16, 0, 0.038, -L * 0.3, black); B(0.008, 0.03, 0.01, 0, 0.03, -L * 0.88, black) }
      if (ak) B(0.006, 0.022, 0.01, 0, 0.026, -L * 0.95, black)
      arm(0, -0.06, -0.02, 0.12, -0.26, 0.3)
      arm(0, -0.035, -L * 0.56, -0.17, -0.28, 0.12)
      g.userData.muzzle = new THREE.Vector3(0, 0.012, -L)
    }
    g.traverse((o) => { (o as THREE.Mesh).castShadow = false; (o as THREE.Mesh).receiveShadow = false })
    // 整体缩小：枪模放得近（避免穿墙），按比例缩小后视觉大小与 CS 相当
    g.scale.setScalar(VM_SCALE)
    ;(g.userData.muzzle as THREE.Vector3).multiplyScalar(VM_SCALE)
    return g
  }
  private placeFor(id: string, out: THREE.Vector3) {
    const def = WEAPONS[id] ?? WEAPONS.knife
    // 枪模尽量靠近相机（枪口 ≤0.4 m），避免贴墙时穿进墙体
    if (def.kind === 'knife') return out.set(0.075, -0.075, -0.13)
    if (def.kind === 'pistol') return out.set(0.06, -0.062, -0.15)
    return out.set(0.062, -0.066, -0.07)
  }
  show(id: string) {
    if (id === this.curId) return
    this.curId = id
    if (this.cur) this.cur.visible = false
    let m = this.models.get(id)
    if (!m) { m = this.build(id); this.models.set(id, m); this.group.add(m) }
    this.muzzleLocal.copy(m.userData.muzzle as THREE.Vector3)
    m.visible = true
    this.cur = m
  }
  /** 组装枪模的显示（模型 = 'grenade' / 'c4' 用小方块） */
  showItem(kind: 'grenade' | 'c4', sub = 'he') {
    const id = kind === 'c4' ? '__c4' : '__nade_' + sub
    if (id === this.curId) return
    this.curId = id
    if (this.cur) this.cur.visible = false
    let m = this.models.get(id)
    if (!m) {
      m = new THREE.Group()
      const col = kind === 'c4' ? 0x4a5a3a : sub === 'smoke' ? 0x8a8f96 : sub === 'flash' ? 0xd0d4d8 : 0x3f5a36
      const mat = new THREE.MeshStandardMaterial({ color: col, roughness: 0.6, metalness: 0.2 })
      const geo = kind === 'c4' ? new THREE.BoxGeometry(0.12, 0.05, 0.08) : new THREE.CylinderGeometry(0.025, 0.025, 0.08, 10)
      this.disposables.push(mat, geo)
      const mesh = new THREE.Mesh(geo, mat); mesh.position.set(0, -0.02, -0.12); m.add(mesh)
      if (kind === 'c4') { const sg = new THREE.BoxGeometry(0.05, 0.012, 0.03); const sm = new THREE.MeshBasicMaterial({ color: 0xff3020 }); this.disposables.push(sg, sm); const s = new THREE.Mesh(sg, sm); s.position.set(0.02, 0.01, -0.12); m.add(s) }
      const ag = new THREE.BoxGeometry(0.055, 0.055, 0.3); this.disposables.push(ag)
      const arm = new THREE.Mesh(ag, this.sleeve); arm.position.set(0.01, -0.06, 0.06); m.add(arm)
      m.scale.setScalar(VM_SCALE)
      this.models.set(id, m); this.group.add(m)
    }
    m.visible = true
    this.cur = m
  }
  fire(strength = 1) { this.kick = Math.min(1.5, this.kick + strength); this.flashT = 0.04 }
  /** 每帧：位置（跑动摆动 / 后坐 / 换弹 / 切枪下沉 / 视角拖拽） */
  update(dt: number, speed: number, onGround: boolean, reload01: number, draw01: number, mouseDX: number, mouseDY: number, crouch: number) {
    if (!this.cur) return
    this.bobT += dt * (onGround ? speed : 0) * 1.6
    this.kick = Math.max(0, this.kick - dt * 9)
    this.swayX += (-mouseDX * 0.0004 - this.swayX) * Math.min(1, dt * 10)
    this.swayY += (mouseDY * 0.0004 - this.swayY) * Math.min(1, dt * 10)
    const base = this.placeFor(this.curId.startsWith('__') ? 'knife' : this.curId, _p)
    const bob = Math.min(1, speed / 6)
    const x = base.x + Math.sin(this.bobT) * 0.008 * bob + this.swayX - crouch * 0.01
    const y = base.y + Math.abs(Math.cos(this.bobT)) * 0.006 * bob - draw01 * 0.18 - Math.sin(reload01 * Math.PI) * 0.09 + this.swayY
    const z = base.z + this.kick * 0.03
    this.cur.position.set(x, y, z)
    this.cur.rotation.set(this.kick * 0.09 + Math.sin(reload01 * Math.PI) * -0.6 - draw01 * 0.6, 0, Math.sin(reload01 * Math.PI) * 0.5)
    this.flashT -= dt
    this.flashLight.intensity = this.flashT > 0 ? 6 : 0
    _a.copy(this.muzzleLocal).applyEuler(this.cur.rotation).add(this.cur.position)
    this.flashLight.position.copy(_a)
  }
  /** 枪口世界坐标 */
  muzzleWorld(out: THREE.Vector3): THREE.Vector3 {
    if (!this.cur) return out.set(0, 0, 0)
    out.copy(this.muzzleLocal).applyEuler(this.cur.rotation).add(this.cur.position)
    return this.group.localToWorld(out)
  }
  dispose() { for (const d of this.disposables) d.dispose(); this.flashLight.dispose(); this.group.removeFromParent() }
}

// ———————————————————— 开火 / 伤害 ————————————————————
export interface ShotResult { victim: Actor | null; group: HitGroup | null; point: THREE.Vector3; normal: THREE.Vector3; dist: number; boxKind: string }

/** 散布（弧度） */
export function inaccuracy(a: Actor, w: WeaponState): number {
  const d = w.def
  let base = d.spread
  if (d.kind === 'sniper' && w.scope === 0) base = AWP_NOSCOPE_SPREAD
  const sp = a.speed2(), max = Math.max(0.5, d.speed)
  const mv = Math.min(1, Math.max(0, (sp - 0.34 * max) / (0.66 * max)))
  let inacc = base + d.moveSpread * mv + (a.body.onGround ? 0 : d.airSpread) + w.bloom
  if (a.crouch > 0.5 && a.body.onGround) inacc *= d.kind === 'sniper' ? 0.6 : 0.75
  return inacc
}

const _up = new THREE.Vector3(), _rt = new THREE.Vector3()
const hitTmp: RayHit = { t: 0, nx: 0, ny: 0, nz: 0, box: 0 }

/** 由 yaw/pitch + 后坐（度）+ 散布（弧度）算子弹方向 */
export function shotDir(yaw: number, pitch: number, recoilYawDeg: number, recoilPitchDeg: number, inacc: number, out: THREE.Vector3): THREE.Vector3 {
  const y = yaw - recoilYawDeg * Math.PI / 180, p = pitch + recoilPitchDeg * Math.PI / 180
  const cp = Math.cos(p)
  out.set(-Math.sin(y) * cp, Math.sin(p), -Math.cos(y) * cp)
  if (inacc > 0) {
    // 圆盘均匀随机 × 偏中心（CS 的散布更集中于中心）
    const r = inacc * Math.pow(Math.random(), 0.7), th = Math.random() * Math.PI * 2
    _rt.set(Math.cos(y), 0, -Math.sin(y))
    _up.crossVectors(_rt, out).normalize()
    out.addScaledVector(_rt, Math.cos(th) * r).addScaledVector(_up, Math.sin(th) * r).normalize()
  }
  return out
}

/** 一发子弹的命中（地图 AABB 遮挡 + 角色命中盒） */
export function traceShot(map: ArenaMap, actors: Actor[], shooter: Actor, ox: number, oy: number, oz: number, d: THREE.Vector3, range: number, out: ShotResult): ShotResult {
  const h = map.raycast(ox, oy, oz, d.x, d.y, d.z, range, hitTmp)
  let best = h ? h.t : range
  let victim: Actor | null = null, group: HitGroup | null = null
  for (const a of actors) {
    if (a === shooter || !a.alive || a.team === shooter.team) continue   // 子弹穿过队友（无友伤）
    const r = rayActor(a, ox, oy, oz, d.x, d.y, d.z)
    if (r && r.t < best) { best = r.t; victim = a; group = r.group }
  }
  out.victim = victim; out.group = group; out.dist = best
  out.point.set(ox + d.x * best, oy + d.y * best, oz + d.z * best)
  if (!victim && h) { out.normal.set(h.nx, h.ny, h.nz); out.boxKind = h.box >= 0 ? map.boxes[h.box].kind : 'ground' }
  else { out.normal.set(-d.x, -d.y, -d.z); out.boxKind = h ? 'none' : 'sky' }
  if (!h && !victim) out.boxKind = 'sky'
  return out
}

/** CS 式伤害：距离衰减 → 部位倍率 → 护甲（腿不受护甲保护；头部需头盔） */
export function computeDamage(def: WeaponDef, dist: number, group: HitGroup, victim: Actor): { hp: number; armor: number } {
  let dmg = def.damage * Math.pow(def.rangeMod, dist / 13)
  dmg *= group === 'head' ? def.hsMul : HIT_MUL[group]
  const armored = victim.armor > 0 && group !== 'legs' && (group !== 'head' || victim.helmet)
  if (!armored) return { hp: dmg, armor: 0 }
  let hp = dmg * def.armorPen
  let armor = (dmg - hp) * 0.5
  if (armor > victim.armor) { hp += (armor - victim.armor) * 2; armor = victim.armor }
  return { hp, armor }
}

/** 后坐力偏移（度）：当前连发序号 */
export function recoilOf(w: WeaponState): [number, number] { return recoilAt(w.def, w.shotIdx) }
