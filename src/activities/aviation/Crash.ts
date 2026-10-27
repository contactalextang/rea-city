import * as THREE from 'three'

/**
 * 坠毁特效（AIR.4）：加色火球 Sprite（迅速膨胀再淡出）+ 一串缓慢上升扩散的烟 Sprite；落水时换成白色水花。
 * 全部是 Sprite（自发光 / 不投影），不新增 Light；同一时间只保留最近一次。
 */
function radialTex(inner: string, outer: string): THREE.CanvasTexture {
  const c = document.createElement('canvas'); c.width = c.height = 64
  const g = c.getContext('2d')!
  const grd = g.createRadialGradient(32, 32, 0, 32, 32, 32)
  grd.addColorStop(0, inner); grd.addColorStop(0.45, outer); grd.addColorStop(1, 'rgba(0,0,0,0)')
  g.fillStyle = grd; g.fillRect(0, 0, 64, 64)
  const tex = new THREE.CanvasTexture(c)
  tex.colorSpace = THREE.SRGBColorSpace
  return tex
}

interface Puff { s: THREE.Sprite; mat: THREE.SpriteMaterial; t: number; life: number; vy: number; grow: number; size: number; peak: number }

export class CrashFx {
  private group = new THREE.Group()
  private fireTex = radialTex('rgba(255,250,220,1)', 'rgba(255,120,20,0.85)')
  private smokeTex = radialTex('rgba(70,70,72,0.9)', 'rgba(40,40,42,0.55)')
  private sprayTex = radialTex('rgba(255,255,255,0.95)', 'rgba(200,225,240,0.6)')
  private puffs: Puff[] = []
  /** 最近一次坠毁点（调试） */
  last: { x: number; y: number; z: number; water: boolean } | null = null

  constructor(scene: THREE.Scene) {
    this.group.name = 'crashFx'
    scene.add(this.group)
  }

  private puff(tex: THREE.Texture, x: number, y: number, z: number, size: number, life: number, vy: number, grow: number, additive: boolean, peak = 1, color = 0xffffff) {
    const mat = new THREE.SpriteMaterial({ map: tex, color, transparent: true, depthWrite: false, opacity: 0, blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending, toneMapped: !additive, fog: !additive })
    const s = new THREE.Sprite(mat)
    s.position.set(x, y, z); s.scale.setScalar(size)
    s.userData.castShadow = false
    this.group.add(s)
    this.puffs.push({ s, mat, t: 0, life, vy, grow, size, peak })
  }

  spawn(x: number, y: number, z: number, water: boolean) {
    this.clear()
    this.last = { x, y, z, water }
    const by = Math.max(0.5, y)
    if (water) {
      // 水花：几团白色喷溅 + 低矮水雾
      for (let i = 0; i < 7; i++) this.puff(this.sprayTex, x + (Math.random() - 0.5) * 6, by + Math.random() * 3, z + (Math.random() - 0.5) * 6, 5 + Math.random() * 4, 1.6 + Math.random(), 4 + Math.random() * 5, 6, false, 0.95)
      for (let i = 0; i < 5; i++) this.puff(this.sprayTex, x + (Math.random() - 0.5) * 10, by, z + (Math.random() - 0.5) * 10, 8, 5, 0.6, 3, false, 0.55, 0xdfe8ee)
      return
    }
    // 火球：两层加色（核心白黄 + 外层橙），0.25 s 膨胀到 ~22 m
    this.puff(this.fireTex, x, by + 2, z, 4, 1.4, 2, 26, true, 1)
    this.puff(this.fireTex, x, by + 3, z, 3, 2.2, 3.5, 16, true, 0.8, 0xff9a40)
    for (let i = 0; i < 4; i++) this.puff(this.fireTex, x + (Math.random() - 0.5) * 8, by + 1 + Math.random() * 4, z + (Math.random() - 0.5) * 8, 3, 1.2 + Math.random() * 0.8, 3, 9, true, 0.9, 0xffb060)
    // 烟柱：10 团，逐个延迟（t 负值 = 尚未出现）
    for (let i = 0; i < 10; i++) {
      this.puff(this.smokeTex, x + (Math.random() - 0.5) * 6, by + 2, z + (Math.random() - 0.5) * 6, 6, 7 + Math.random() * 3, 3 + Math.random() * 2.5, 3.5, false, 0.85)
      this.puffs[this.puffs.length - 1].t = -i * 0.25
    }
  }

  update(dt: number) {
    for (let i = this.puffs.length - 1; i >= 0; i--) {
      const p = this.puffs[i]
      p.t += dt
      if (p.t < 0) continue
      const k = p.t / p.life
      if (k >= 1) { this.group.remove(p.s); p.mat.dispose(); this.puffs.splice(i, 1); continue }
      // 0.08 寿命内淡入，之后线性淡出
      p.mat.opacity = p.peak * (k < 0.08 ? k / 0.08 : 1 - (k - 0.08) / 0.92)
      p.s.position.y += p.vy * dt
      p.vy *= Math.exp(-0.4 * dt)
      p.s.scale.setScalar(p.size + p.grow * Math.sqrt(p.t))
    }
  }

  get active() { return this.puffs.length > 0 }

  clear() {
    for (const p of this.puffs) { this.group.remove(p.s); p.mat.dispose() }
    this.puffs.length = 0
  }
}
