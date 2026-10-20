import * as THREE from 'three'
import type { ArenaMap, RayHit } from './ArenaMap'
import type { Actor } from './Actor'
import type { ArenaSfx } from './ArenaSfx'

export type NadeKind = 'he' | 'smoke' | 'flash'
interface Nade { kind: NadeKind; owner: Actor; p: THREE.Vector3; v: THREE.Vector3; t: number; rest: number; mesh: THREE.Mesh; done: boolean }
interface Smoke { p: THREE.Vector3; t: number; sprites: THREE.Sprite[]; mat: THREE.SpriteMaterial; group: THREE.Group; core: THREE.Mesh; coreMat: THREE.MeshStandardMaterial }
interface Boom { s: THREE.Sprite; t: number; life: number; size: number }

export const SMOKE_R = 4.3
const SMOKE_LIFE = 18
const hitTmp: RayHit = { t: 0, nx: 0, ny: 0, nz: 0, box: 0 }
const _v = new THREE.Vector3()

/** 投掷物：高爆手雷（伤害）/ 烟雾弹（遮挡视线）/ 闪光弹（致盲）。弹跳物理用地图射线。 */
export class Grenades {
  readonly group = new THREE.Group()
  private nades: Nade[] = []
  readonly smokes: Smoke[] = []
  private booms: Boom[] = []
  private geo = new THREE.SphereGeometry(0.06, 8, 6)
  private coreGeo = new THREE.IcosahedronGeometry(1, 2)
  private mats: Record<NadeKind, THREE.MeshStandardMaterial> = {
    he: new THREE.MeshStandardMaterial({ color: 0x3f5a36, roughness: 0.6 }),
    smoke: new THREE.MeshStandardMaterial({ color: 0x8a8f96, roughness: 0.6 }),
    flash: new THREE.MeshStandardMaterial({ color: 0xd0d4d8, roughness: 0.4, metalness: 0.4 }),
  }
  private smokeTex: THREE.CanvasTexture
  private boomTex: THREE.CanvasTexture
  private boomMat: THREE.SpriteMaterial
  /** 爆炸回调（伤害由 ArenaMode 结算） */
  onExplode: (kind: NadeKind, p: THREE.Vector3, owner: Actor) => void = () => {}
  constructor(private map: ArenaMap, private sfx: ArenaSfx) {
    const mk = (draw: (g: CanvasRenderingContext2D) => void) => { const c = document.createElement('canvas'); c.width = c.height = 128; draw(c.getContext('2d')!); const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; return t }
    this.smokeTex = mk((g) => {
      const base = g.createRadialGradient(64, 64, 0, 64, 64, 62); base.addColorStop(0, 'rgba(225,225,225,0.95)'); base.addColorStop(0.55, 'rgba(225,225,225,0.7)'); base.addColorStop(1, 'rgba(225,225,225,0)')
      g.fillStyle = base; g.fillRect(0, 0, 128, 128)
      for (let i = 0; i < 9; i++) {
        const x = 64 + (Math.random() - 0.5) * 50, y = 64 + (Math.random() - 0.5) * 50, r = 24 + Math.random() * 26
        const grd = g.createRadialGradient(x, y, 0, x, y, r); grd.addColorStop(0, 'rgba(245,245,245,0.5)'); grd.addColorStop(1, 'rgba(245,245,245,0)')
        g.fillStyle = grd; g.fillRect(0, 0, 128, 128)
      }
    })
    this.boomTex = mk((g) => { const grd = g.createRadialGradient(64, 64, 0, 64, 64, 64); grd.addColorStop(0, 'rgba(255,250,220,1)'); grd.addColorStop(0.25, 'rgba(255,190,90,0.95)'); grd.addColorStop(0.6, 'rgba(200,80,20,0.5)'); grd.addColorStop(1, 'rgba(60,30,10,0)'); g.fillStyle = grd; g.fillRect(0, 0, 128, 128) })
    this.boomMat = new THREE.SpriteMaterial({ map: this.boomTex, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, toneMapped: false })
  }

  throw(owner: Actor, kind: NadeKind, from: THREE.Vector3, vel: THREE.Vector3) {
    const mesh = new THREE.Mesh(this.geo, this.mats[kind]); mesh.castShadow = true
    mesh.position.copy(from)
    this.group.add(mesh)
    this.nades.push({ kind, owner, p: from.clone(), v: vel.clone(), t: 0, rest: 0, mesh, done: false })
  }

  update(dt: number) {
    for (const n of this.nades) {
      if (n.done) continue
      n.t += dt
      // 物理（细分步，射线弹跳）
      const steps = 3
      for (let s = 0; s < steps; s++) {
        const h = dt / steps
        n.v.y -= 20.8 * h * 0.85
        const mx = n.v.x * h, my = n.v.y * h, mz = n.v.z * h
        const hit = this.map.raycast(n.p.x, n.p.y, n.p.z, mx, my, mz, 1, hitTmp)
        if (hit) {
          n.p.x += mx * hit.t * 0.98; n.p.y += my * hit.t * 0.98; n.p.z += mz * hit.t * 0.98
          const vn = n.v.x * hit.nx + n.v.y * hit.ny + n.v.z * hit.nz
          const sp = n.v.length()
          n.v.x -= 2 * vn * hit.nx; n.v.y -= 2 * vn * hit.ny; n.v.z -= 2 * vn * hit.nz
          n.v.multiplyScalar(hit.ny > 0.5 ? 0.42 : 0.55)
          if (sp > 3) this.sfx.bounce(n.p.x, n.p.z)
          if (hit.ny > 0.5 && Math.abs(n.v.y) < 1.2) { n.v.y = 0; n.v.x *= 0.7; n.v.z *= 0.7 }
        } else { n.p.x += mx; n.p.y += my; n.p.z += mz }
      }
      if (n.p.y < 0.06) { n.p.y = 0.06; if (n.v.y < 0) n.v.y = 0; n.v.x *= 0.96; n.v.z *= 0.96 }
      n.mesh.position.copy(n.p)
      const slow = n.v.lengthSq() < 0.3
      n.rest = slow ? n.rest + dt : 0
      const fuse = n.kind === 'he' ? 1.6 : n.kind === 'flash' ? 1.5 : 99
      if (n.t >= fuse || (n.kind === 'smoke' && (n.rest > 0.25 || n.t > 3.5))) this.detonate(n)
    }
    this.nades = this.nades.filter((n) => !n.done)
    // 烟雾：淡入 / 维持 / 淡出
    for (const s of this.smokes) {
      s.t += dt
      const a = s.t < 1.2 ? s.t / 1.2 : s.t > SMOKE_LIFE - 2 ? Math.max(0, (SMOKE_LIFE - s.t) / 2) : 1
      s.mat.opacity = a
      s.coreMat.opacity = a * 0.97
      s.core.scale.set(SMOKE_R * 0.78 * Math.min(1, s.t / 1.2 + 0.3), SMOKE_R * 0.5, SMOKE_R * 0.78 * Math.min(1, s.t / 1.2 + 0.3))
      const grow = Math.min(1, s.t / 1.2)
      s.sprites.forEach((sp, i) => { const k = 0.6 + 0.4 * grow; sp.scale.setScalar((sp.userData.size as number) * k); sp.material.rotation = i + s.t * 0.03 })
    }
    for (let i = this.smokes.length - 1; i >= 0; i--) if (this.smokes[i].t > SMOKE_LIFE) { const s = this.smokes[i]; s.group.removeFromParent(); s.mat.dispose(); s.coreMat.dispose(); this.smokes.splice(i, 1) }
    for (const b of this.booms) { b.t += dt; const f = b.t / b.life; b.s.scale.setScalar(b.size * (0.5 + f)); b.s.material.opacity = Math.max(0, 1 - f) }
    for (let i = this.booms.length - 1; i >= 0; i--) if (this.booms[i].t > this.booms[i].life) { this.booms[i].s.removeFromParent(); this.booms[i].s.material.dispose(); this.booms.splice(i, 1) }
  }

  private detonate(n: Nade) {
    n.done = true
    n.mesh.removeFromParent()
    if (n.kind === 'smoke') this.spawnSmoke(n.p)
    else {
      this.boom(n.p, n.kind === 'he' ? 5 : 3)
      if (n.kind === 'he') this.sfx.explosion(n.p.x, n.p.z, false); else this.sfx.flashPop(n.p.x, n.p.z)
    }
    this.onExplode(n.kind, n.p, n.owner)
  }
  boom(p: THREE.Vector3, size: number, life = 0.45) {
    const s = new THREE.Sprite(this.boomMat.clone()); s.position.copy(p).setY(p.y + 0.4); s.scale.setScalar(size)
    this.group.add(s); this.booms.push({ s, t: 0, life, size })
  }
  private spawnSmoke(p: THREE.Vector3) {
    const g = new THREE.Group()
    const mat = new THREE.SpriteMaterial({ map: this.smokeTex, color: 0xaeb2b8, transparent: true, depthWrite: false, opacity: 0 })
    const sprites: THREE.Sprite[] = []
    for (let i = 0; i < 26; i++) {
      const sp = new THREE.Sprite(mat)
      const a = Math.random() * Math.PI * 2, r = Math.sqrt(Math.random()) * SMOKE_R * 0.75
      sp.position.set(p.x + Math.cos(a) * r, p.y + 0.6 + Math.random() * 2.8, p.z + Math.sin(a) * r)
      sp.userData.size = 4.5 + Math.random() * 3
      sprites.push(sp); g.add(sp)
    }
    // 实心内核：保证烟雾中心完全不透明（精灵在外围柔化边缘）
    const coreMat = new THREE.MeshStandardMaterial({ color: 0xa4a8ae, roughness: 1, transparent: true, opacity: 0, depthWrite: false })
    const core = new THREE.Mesh(this.coreGeo, coreMat)
    core.position.set(p.x, p.y + 1.5, p.z); core.scale.set(SMOKE_R * 0.78, SMOKE_R * 0.5, SMOKE_R * 0.78)
    core.renderOrder = -0.5
    g.add(core)
    this.group.add(g)
    this.smokes.push({ p: p.clone().setY(Math.max(1.2, p.y + 1.2)), t: 0, sprites, mat, group: g, core, coreMat })
    this.sfx.smokePop(p.x, p.z)
  }
  /** a→b 线段是否穿过烟雾（仅烟雾浓时） */
  smokeBlocks(ax: number, ay: number, az: number, bx: number, by: number, bz: number): boolean {
    for (const s of this.smokes) {
      if (s.t < 0.8 || s.t > SMOKE_LIFE - 1) continue
      // 线段到球心距离
      _v.set(bx - ax, by - ay, bz - az)
      const L2 = _v.lengthSq(); if (L2 < 1e-6) continue
      const t = Math.max(0, Math.min(1, ((s.p.x - ax) * _v.x + (s.p.y - ay) * _v.y + (s.p.z - az) * _v.z) / L2))
      const dx = ax + _v.x * t - s.p.x, dy = (ay + _v.y * t - s.p.y) * 0.6, dz = az + _v.z * t - s.p.z
      if (dx * dx + dy * dy + dz * dz < (SMOKE_R * 0.92) ** 2) return true
    }
    return false
  }
  clear() {
    for (const n of this.nades) n.mesh.removeFromParent()
    this.nades = []
    for (const s of this.smokes) { s.group.removeFromParent(); s.mat.dispose(); s.coreMat.dispose() }
    this.smokes.length = 0
    for (const b of this.booms) { b.s.removeFromParent(); b.s.material.dispose() }
    this.booms = []
  }
  dispose() {
    this.clear()
    this.geo.dispose(); this.coreGeo.dispose(); for (const m of Object.values(this.mats)) m.dispose()
    this.smokeTex.dispose(); this.boomTex.dispose(); this.boomMat.dispose()
    this.group.removeFromParent()
  }
}
