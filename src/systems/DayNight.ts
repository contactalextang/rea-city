import * as THREE from 'three'
import type { Ctx } from '../core/Context'
import type { Settings } from '../core/Settings'
import { clamp, lerp } from '../config'

/**
 * 昼夜系统：太阳/月光方向光（阴影跟随玩家）、半球光、天空/雾/曝光色表、
 * 夜间窗户自发光与路灯光晕。只依赖 scene/renderer/ctx；世界实现通过
 * scene.userData 约定暴露：windows: MeshLambertMaterial[]，lamps: InstancedMesh，
 * lampHead: Vector3（灯头相对实例原点的偏移），roads: Material[]（由 Weather 使用）。
 */

/** 色表关键帧（按小时，首尾循环插值） */
interface Key {
  h: number
  sky: number; fog: number
  hemiSky: number; hemiGround: number; hemiI: number
  sun: number; sunI: number
  exposure: number
  fogNear: number; fogFar: number
}

const NIGHT: Omit<Key, 'h'> = { sky: 0x0a1020, fog: 0x0c1428, hemiSky: 0x2a3d6b, hemiGround: 0x15161a, hemiI: 0.42, sun: 0x8ea4dc, sunI: 0.22, exposure: 0.88, fogNear: 90, fogFar: 300 }
const DAY: Omit<Key, 'h'> = { sky: 0xa9c9e8, fog: 0xa9c9e8, hemiSky: 0xdfefff, hemiGround: 0x6b6b60, hemiI: 1.1, sun: 0xfff2dd, sunI: 1.6, exposure: 1.0, fogNear: 150, fogFar: 380 }
const KEYS: Key[] = [
  { h: 0, ...NIGHT },
  { h: 5.5, ...NIGHT },
  { h: 6.4, sky: 0x7d7fa6, fog: 0xb09aa8, hemiSky: 0x9aa3c8, hemiGround: 0x4a4040, hemiI: 0.6, sun: 0xffb080, sunI: 0.25, exposure: 0.92, fogNear: 110, fogFar: 320 },
  { h: 7.0, sky: 0xe9a87c, fog: 0xf0c09a, hemiSky: 0xffc9a0, hemiGround: 0x5a4a40, hemiI: 0.75, sun: 0xffa060, sunI: 0.6, exposure: 0.96, fogNear: 120, fogFar: 340 },
  { h: 8.0, sky: 0xa9c9e8, fog: 0xc8d4e6, hemiSky: 0xdfefff, hemiGround: 0x6b6b60, hemiI: 1.0, sun: 0xffe0bb, sunI: 1.3, exposure: 1.0, fogNear: 150, fogFar: 380 },
  { h: 12, ...DAY },
  { h: 17.5, ...DAY, sun: 0xffe2bb, sunI: 1.35 },
  { h: 18.6, sky: 0xe08a52, fog: 0xeaa070, hemiSky: 0xffb27a, hemiGround: 0x5a4a40, hemiI: 0.8, sun: 0xff9a4a, sunI: 0.95, exposure: 0.98, fogNear: 120, fogFar: 340 },
  { h: 19.1, sky: 0xb05a48, fog: 0xc07a60, hemiSky: 0xe0906a, hemiGround: 0x3a3030, hemiI: 0.6, sun: 0xff7a3a, sunI: 0.4, exposure: 0.94, fogNear: 110, fogFar: 320 },
  { h: 19.6, sky: 0x3c3458, fog: 0x4a405c, hemiSky: 0x5c5a86, hemiGround: 0x25222a, hemiI: 0.48, sun: 0x8a7aa0, sunI: 0.1, exposure: 0.9, fogNear: 100, fogFar: 310 },
  { h: 20.4, ...NIGHT },
  { h: 24, ...NIGHT },
]

const smoothstep = (a: number, b: number, x: number) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t) }
const lum = (c: THREE.Color) => 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b
const SUNRISE = 7.0, SUNSET = 19.17          // 新加坡 1.3°N，全年近似不变
const MOON_DIR = new THREE.Vector3(-0.35, 0.72, 0.55).normalize()
const SHADOW_HALF = 60
const STORM_GREY = new THREE.Color(0x3c424c)

export class DayNight {
  sun: THREE.DirectionalLight
  hemi: THREE.HemisphereLight
  /** 0–1 阴沉系数（Weather 写入）：叠加在色表上 */
  gloom = 0
  /** 闪电亮度（Weather 写入） */
  flash = 0
  /** 当前夜间灯光开启度 0–1（窗户/路灯） */
  lights = 0
  private shadowsOn: boolean
  private sunDir = new THREE.Vector3()
  private cSky = new THREE.Color(); private cFog = new THREE.Color(); private cHemiSky = new THREE.Color(); private cHemiGround = new THREE.Color(); private cSun = new THREE.Color()
  private tmpA = new THREE.Color(); private tmpB = new THREE.Color(); private tmpC = new THREE.Color()
  private windows: THREE.MeshLambertMaterial[] = []
  private halo: THREE.InstancedMesh | null = null
  private pool: THREE.InstancedMesh | null = null
  private haloMat: THREE.ShaderMaterial | null = null
  private poolMat: THREE.MeshBasicMaterial | null = null
  private tmpV = new THREE.Vector3()
  private tmpM = new THREE.Matrix4()

  constructor(private scene: THREE.Scene, private renderer: THREE.WebGLRenderer, settings: Settings) {
    this.shadowsOn = settings.shadows
    renderer.shadowMap.enabled = this.shadowsOn
    renderer.shadowMap.type = THREE.PCFShadowMap   // r186 已移除 PCFSoft，PCF 即为软阴影
    renderer.toneMapping = THREE.LinearToneMapping
    renderer.toneMappingExposure = 1

    this.hemi = new THREE.HemisphereLight(0xdfefff, 0x6b6b60, 1.1)
    scene.add(this.hemi)
    this.sun = new THREE.DirectionalLight(0xfff2dd, 1.6)
    this.sun.position.set(120, 200, 80)
    this.sun.castShadow = this.shadowsOn
    const sh = this.sun.shadow
    sh.mapSize.set(2048, 2048)
    sh.camera.left = -SHADOW_HALF; sh.camera.right = SHADOW_HALF
    sh.camera.top = SHADOW_HALF; sh.camera.bottom = -SHADOW_HALF
    sh.camera.near = 1; sh.camera.far = 420
    sh.bias = -0.0004
    sh.normalBias = 0.6
    scene.add(this.sun, this.sun.target)

    if (!scene.background) scene.background = new THREE.Color(0xa9c9e8)
    if (!scene.fog) scene.fog = new THREE.Fog(0xa9c9e8, 150, 380)
  }

  /** 世界网格就绪后调用：读取 userData 约定、设置投影/接收阴影、生成路灯光晕 */
  attachWorld() {
    const ud = this.scene.userData
    this.windows = (ud.windows as THREE.MeshLambertMaterial[] | undefined) ?? []
    this.applyShadowFlags(this.scene)
    const lamps = ud.lamps as THREE.InstancedMesh | undefined
    if (lamps) this.buildLampGlow(lamps, (ud.lampHead as THREE.Vector3 | undefined) ?? new THREE.Vector3(0, 5, 0))
  }

  /** 递归设置阴影标记：不透明 Lambert 网格投影+接收；userData.castShadow=false 可排除（地面等） */
  applyShadowFlags(root: THREE.Object3D) {
    root.traverse((o) => {
      const m = o as THREE.Mesh
      if (!m.isMesh) return
      const mat = m.material as THREE.Material
      const opaque = !mat.transparent && (mat as THREE.MeshLambertMaterial).isMeshLambertMaterial === true
      m.receiveShadow = opaque
      m.castShadow = opaque && m.userData.castShadow !== false
    })
    root.userData.shadowDone = true
  }

  update(dt: number, ctx: Ctx) {
    const h = ctx.clock.hour
    this.sample(h)
    const gloom = clamp(this.gloom, 0, 1)
    const flash = clamp(this.flash, 0, 1)

    // 阴沉：向灰色靠拢并降低亮度（保持夜晚仍比白天暗）
    const gloomTint = (c: THREE.Color, out: THREE.Color) => {
      const l = lum(c)
      out.copy(STORM_GREY).multiplyScalar((l * 0.5) / lum(STORM_GREY))
      return c.lerp(out, gloom)
    }
    gloomTint(this.cSky, this.tmpA); gloomTint(this.cFog, this.tmpA); gloomTint(this.cHemiSky, this.tmpA)
    this.cHemiGround.multiplyScalar(1 - 0.4 * gloom)
    this.hemiI *= 1 - 0.4 * gloom
    this.sunI *= 1 - 0.85 * gloom
    this.exposure *= 1 - 0.12 * gloom
    this.fogNear = lerp(this.fogNear, 22, gloom); this.fogFar = lerp(this.fogFar, 140, gloom)
    // 闪电：天空与半球光瞬间拉亮
    if (flash > 0.001) {
      this.tmpB.setHex(0xdde6ff)
      this.cSky.lerp(this.tmpB, flash * 0.7); this.cFog.lerp(this.tmpB, flash * 0.6)
      this.hemiI += flash * 2.5
    }

    ;(this.scene.background as THREE.Color).copy(this.cSky)
    const fog = this.scene.fog as THREE.Fog
    fog.color.copy(this.cFog); fog.near = this.fogNear; fog.far = this.fogFar
    this.hemi.color.copy(this.cHemiSky); this.hemi.groundColor.copy(this.cHemiGround); this.hemi.intensity = this.hemiI
    this.renderer.toneMappingExposure = this.exposure

    // 太阳方向：日出在东、日落在西，正午近头顶；地平线下改用固定方向的月光
    const f = (h - SUNRISE) / (SUNSET - SUNRISE)
    const theta = Math.PI * f
    const elev = f > 0 && f < 1 ? Math.sin(theta) : -1
    if (elev > 0.03) this.sunDir.set(Math.cos(theta), elev * 0.985, 0.3).normalize()
    else this.sunDir.copy(MOON_DIR)
    this.sun.color.copy(this.cSun); this.sun.intensity = this.sunI
    const pl = ctx.player
    const px = pl.worldX, pz = pl.worldZ
    this.sun.target.position.set(px, 0, pz)
    this.sun.position.set(px + this.sunDir.x * 200, this.sunDir.y * 200, pz + this.sunDir.z * 200)

    // 夜间灯光：19:00 前后亮起、06:30 前后熄灭；暴雨时也部分亮起
    const on = h < 12 ? 1 - smoothstep(6.0, 6.8, h) : smoothstep(18.7, 19.5, h)
    const target = Math.max(on, gloom * 0.55)
    this.lights = Math.abs(target - this.lights) > 0.3 ? target : lerp(this.lights, target, 1 - Math.exp(-dt * 3))
    for (const w of this.windows) w.emissiveIntensity = 0.9 * this.lights
    if (this.haloMat) { this.haloMat.uniforms.uOpacity.value = this.lights; this.halo!.visible = this.lights > 0.01 }
    if (this.poolMat) { this.poolMat.opacity = 0.55 * this.lights; this.pool!.visible = this.lights > 0.01 }

    // 新生成的动态物体（车辆）补阴影标记
    if (this.shadowsOn) for (const v of ctx.vehicles) if (!v.group.userData.shadowDone) this.applyShadowFlags(v.group)
  }

  // 采样结果（update 内临时使用）
  private hemiI = 1; private sunI = 1; private exposure = 1; private fogNear = 150; private fogFar = 380

  private sample(h: number) {
    let i = 0
    while (i < KEYS.length - 2 && KEYS[i + 1].h <= h) i++
    const a = KEYS[i], b = KEYS[i + 1]
    const t = clamp((h - a.h) / (b.h - a.h), 0, 1)
    const mix = (x: number, y: number, out: THREE.Color) => out.setHex(x).lerp(this.tmpC.setHex(y), t)
    mix(a.sky, b.sky, this.cSky); mix(a.fog, b.fog, this.cFog)
    mix(a.hemiSky, b.hemiSky, this.cHemiSky); mix(a.hemiGround, b.hemiGround, this.cHemiGround); mix(a.sun, b.sun, this.cSun)
    this.hemiI = lerp(a.hemiI, b.hemiI, t); this.sunI = lerp(a.sunI, b.sunI, t); this.exposure = lerp(a.exposure, b.exposure, t)
    this.fogNear = lerp(a.fogNear, b.fogNear, t); this.fogFar = lerp(a.fogFar, b.fogFar, t)
  }

  /** 路灯光晕：面向相机的 additive 四边形（InstancedMesh + 小 shader）+ 地面光池 */
  private buildLampGlow(lamps: THREE.InstancedMesh, head: THREE.Vector3) {
    const n = lamps.count
    const tex = makeGlowTexture()
    this.haloMat = new THREE.ShaderMaterial({
      uniforms: { uMap: { value: tex }, uOpacity: { value: 0 }, uSize: { value: 2.6 }, uColor: { value: new THREE.Color(0xffd79a) } },
      vertexShader: `
        uniform float uSize;
        varying vec2 vUv;
        void main() {
          vUv = uv;
          vec4 center = modelMatrix * instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0);
          vec4 mv = viewMatrix * center;
          mv.xy += position.xy * uSize;
          gl_Position = projectionMatrix * mv;
        }`,
      fragmentShader: `
        uniform sampler2D uMap; uniform float uOpacity; uniform vec3 uColor;
        varying vec2 vUv;
        void main() {
          float a = texture2D(uMap, vUv).a;
          gl_FragColor = vec4(uColor * a * uOpacity, 1.0);
        }`,
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, fog: false,
    })
    this.halo = new THREE.InstancedMesh(new THREE.PlaneGeometry(1, 1), this.haloMat, n)
    this.poolMat = new THREE.MeshBasicMaterial({ map: tex, color: 0xffc77a, transparent: true, opacity: 0, depthWrite: false, blending: THREE.AdditiveBlending })
    this.pool = new THREE.InstancedMesh(new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2), this.poolMat, n)
    const q = new THREE.Quaternion(), s = new THREE.Vector3(1, 1, 1), ps = new THREE.Vector3(9, 1, 9)
    for (let i = 0; i < n; i++) {
      lamps.getMatrixAt(i, this.tmpM)
      this.tmpV.copy(head).applyMatrix4(this.tmpM)
      this.halo.setMatrixAt(i, this.tmpM.compose(this.tmpV, q, s))
      this.tmpV.y = 0.04
      this.pool.setMatrixAt(i, this.tmpM.compose(this.tmpV, q, ps))
    }
    this.halo.frustumCulled = false
    this.pool.frustumCulled = false
    this.halo.visible = this.pool.visible = false
    this.scene.add(this.halo, this.pool)
  }
}

function makeGlowTexture() {
  const c = document.createElement('canvas'); c.width = c.height = 64
  const g = c.getContext('2d')!
  const grad = g.createRadialGradient(32, 32, 0, 32, 32, 32)
  grad.addColorStop(0, 'rgba(255,255,255,1)'); grad.addColorStop(0.25, 'rgba(255,255,255,0.55)'); grad.addColorStop(0.6, 'rgba(255,255,255,0.12)'); grad.addColorStop(1, 'rgba(255,255,255,0)')
  g.fillStyle = grad; g.fillRect(0, 0, 64, 64)
  const tex = new THREE.CanvasTexture(c)
  tex.colorSpace = THREE.SRGBColorSpace
  return tex
}
