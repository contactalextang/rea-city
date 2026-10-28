import * as THREE from 'three'
import type { Ctx } from '../core/Context'
import type { Settings } from '../core/Settings'
import { clamp, lerp } from '../config'
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js'
import { defaultGrade, type GradeParams } from '../core/PostFX'
import { LOOK } from '../core/LookUniforms'
import { agx, agxInverse } from '../core/AgX'
import { NightLights } from './NightLights'
import { FACADE } from '../world/FacadeShader'
import { setFacadeDetail } from '../world/FacadeDetail'
import { ATMO, ATMO_DEBUG, ATMO_OPTS, CsmShadows, SkyDome, installAtmosphereChunks } from './Atmosphere'

/**
 * 昼夜系统：太阳/月光方向光（阴影跟随玩家）、半球光、天空/雾/曝光色表、
 * 夜间窗户自发光与路灯光晕。只依赖 scene/renderer/ctx；世界实现通过
 * scene.userData 约定暴露：windows: MeshLambertMaterial[]，lamps: InstancedMesh，
 * lampHead: Vector3（灯头相对实例原点的偏移），roads: MeshStandardMaterial[]（由 Weather 使用），
 * lampsVersion: number（可选；流式世界每次灯柱实例变化时递增，光晕随之重建）。
 */

/** 色表关键帧（按小时，首尾循环插值） */
interface Key {
  h: number
  sky: number; fog: number
  hemiSky: number; hemiGround: number; hemiI: number
  sun: number; sunI: number
  exposure: number
  fogNear: number; fogFar: number
  /** scene.environmentIntensity（RoomEnvironment 的 IBL 漫反射补光） */
  envI: number
  /** 调色（PostFX，fx=off 时不生效） */
  g: Look
}
/** 调色关键帧：对比/饱和/暗部·亮部色调(sRGB hex)/分离强度/暗角/颗粒/色差/泛光强度·阈值/角色边缘光强度 */
interface Look { con: number; sat: number; shT: number; hiT: number; split: number; vig: number; grain: number; chroma: number; bloom: number; bTh: number; rim: number }

// AgX 抬暗部、压高光与饱和：调色里对比 1.1+/饱和 1.25 补回；RoomEnvironment 补的是中性漫反射（强度 1 时约等于 1× 反照率），
// 远亮于原半球光的有效亮度，故夜间 envI 只给 ≈0.05（否则墙面被照成灰褐色）；夜间亮度改由偏冷蓝的半球光 + 曝光 + 路灯点光（NightLights）补
const G_NIGHT: Look = { con: 1.05, sat: 1.2, shT: 0x1fa0e0, hiT: 0xff7aa0, split: 0.4, vig: 0.22, grain: 0.03, chroma: 1.2, bloom: 0.9, bTh: 0.95, rim: 0.8 }
const G_DAY: Look = { con: 1.2, sat: 1.4, shT: 0x8098c0, hiT: 0xffead2, split: 0.1, vig: 0.18, grain: 0.015, chroma: 0.4, bloom: 0.12, bTh: 2.2, rim: 0.15 }
const G_DUSK: Look = { con: 1.15, sat: 1.35, shT: 0x5a68a8, hiT: 0xffa05a, split: 0.38, vig: 0.3, grain: 0.022, chroma: 0.7, bloom: 0.4, bTh: 1.3, rim: 0.35 }
const G_DUSK2: Look = { con: 1.1, sat: 1.2, shT: 0x4a5ab0, hiT: 0xff7a6a, split: 0.42, vig: 0.28, grain: 0.028, chroma: 1.0, bloom: 0.65, bTh: 1.0, rim: 0.55 }
const G_DAWN: Look = { con: 1.08, sat: 1.15, shT: 0x6a70b0, hiT: 0xffb890, split: 0.3, vig: 0.28, grain: 0.025, chroma: 0.8, bloom: 0.45, bTh: 1.1, rim: 0.5 }
const NIGHT: Omit<Key, 'h'> = { sky: 0x0e1830, fog: 0x141e3a, hemiSky: 0x4a6cb8, hemiGround: 0x1a1c24, hemiI: 0.44, sun: 0x8ea8e8, sunI: 0.22, exposure: 0.82, fogNear: 90, fogFar: 300, envI: 0.05, g: G_NIGHT }
const DAY: Omit<Key, 'h'> = { sky: 0xa9c9e8, fog: 0xa9c9e8, hemiSky: 0xdfefff, hemiGround: 0x6b6b60, hemiI: 0.45, sun: 0xfff2dd, sunI: 1.6, exposure: 0.8, fogNear: 150, fogFar: 380, envI: 0.3, g: G_DAY }
const KEYS: Key[] = [
  { h: 0, ...NIGHT },
  { h: 5.5, ...NIGHT },
  { h: 6.4, sky: 0x7d7fa6, fog: 0xb09aa8, hemiSky: 0x9aa3c8, hemiGround: 0x4a4040, hemiI: 0.5, sun: 0xffb080, sunI: 0.25, exposure: 0.9, fogNear: 110, fogFar: 320, envI: 0.15, g: G_DAWN },
  { h: 7.0, sky: 0xe9a87c, fog: 0xf0c09a, hemiSky: 0xffc9a0, hemiGround: 0x5a4a40, hemiI: 0.48, sun: 0xffa060, sunI: 0.6, exposure: 0.82, fogNear: 120, fogFar: 340, envI: 0.18, g: { ...G_DUSK, split: 0.3, bloom: 0.3 } },
  { h: 8.0, sky: 0xa9c9e8, fog: 0xc8d4e6, hemiSky: 0xdfefff, hemiGround: 0x6b6b60, hemiI: 0.48, sun: 0xffe0bb, sunI: 1.3, exposure: 0.8, fogNear: 150, fogFar: 380, envI: 0.28, g: { ...G_DAY, split: 0.16 } },
  { h: 12, ...DAY },
  { h: 17.5, ...DAY, sun: 0xffe2bb, sunI: 1.35, g: { ...G_DAY, split: 0.18, hiT: 0xffdcb4 } },
  { h: 18.6, sky: 0xe08a52, fog: 0xeaa070, hemiSky: 0xffb27a, hemiGround: 0x5a4a40, hemiI: 0.42, sun: 0xff9a4a, sunI: 0.95, exposure: 0.78, fogNear: 120, fogFar: 340, envI: 0.14, g: G_DUSK },
  { h: 19.1, sky: 0xb05a48, fog: 0xc07a60, hemiSky: 0xe0906a, hemiGround: 0x3a3030, hemiI: 0.38, sun: 0xff7a3a, sunI: 0.4, exposure: 0.8, fogNear: 110, fogFar: 320, envI: 0.1, g: G_DUSK2 },
  { h: 19.6, sky: 0x3c3458, fog: 0x4a405c, hemiSky: 0x5c62a0, hemiGround: 0x22222c, hemiI: 0.44, sun: 0x8a8ab8, sunI: 0.16, exposure: 0.86, fogNear: 100, fogFar: 310, envI: 0.07, g: { ...G_DUSK2, shT: 0x3a80c8, hiT: 0xff6a9a, bloom: 0.8, bTh: 0.9, rim: 0.7 } },
  { h: 20.4, ...NIGHT },
  { h: 24, ...NIGHT },
]

const smoothstep = (a: number, b: number, x: number) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t) }
const lum = (c: THREE.Color) => 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b
const SUNRISE = 7.0, SUNSET = 19.17          // 新加坡 1.3°N，全年近似不变
const MOON_DIR = new THREE.Vector3(-0.35, 0.72, 0.55).normalize()
const SHADOW_HALF = 60
const STORM_GREY = new THREE.Color(0x3c424c)
/** 夜间角色边缘光：霓虹青偏品红 */
const NEON_RIM = new THREE.Color(0x8aa6f2)
/** 天空 PMREM 环境图亮度增益（使其漫反射补光与原 RoomEnvironment 在同一 envI 下大致等亮） */
const SKY_ENV_GAIN = 1.5

/** 显示帧序号（rAF 驱动）：同一帧内多次渲染城市场景（AO 等 pass）时阴影图只更新一次 */
let frameToken = 0
let frameTicking = false
function startFrameToken() {
  if (frameTicking || typeof requestAnimationFrame === 'undefined') return
  frameTicking = true
  const tick = () => { frameToken++; requestAnimationFrame(tick) }
  requestAnimationFrame(tick)
}

export class DayNight {
  sun: THREE.DirectionalLight
  hemi: THREE.HemisphereLight
  /** 0–1 阴沉系数（Weather 写入）：叠加在色表上 */
  gloom = 0
  /** 闪电亮度（Weather 写入） */
  flash = 0
  /** 0–1 路面湿度（Weather 写入）：路灯地面光池拉出朝向相机的湿地倒影条纹 */
  wet = 0
  /** 当前夜间灯光开启度 0–1（窗户/路灯） */
  lights = 0
  /** 雾距倍率：方格城 1；真实城市放远（far ≈ 900 m）以看到天际线 */
  fogScale = 1
  /** 当前调色参数（每帧更新；Game 推给 PostFX） */
  readonly grade: GradeParams = defaultGrade()
  /**
   * 后期管线开启时为 true（Game 设置）：天空背景与雾色会经过 OutputPass 的 AgX（直出时背景清屏色、雾都在色调映射之后），
   * 此时把它们按 AgX 反解成 HDR 值，保证两种模式下天空色一致、不被 AgX 压灰。
   */
  hdrSky = false
  private shadowsOn: boolean
  private sunDir = new THREE.Vector3()
  private cSky = new THREE.Color(); private cFog = new THREE.Color(); private cHemiSky = new THREE.Color(); private cHemiGround = new THREE.Color(); private cSun = new THREE.Color()
  private tmpA = new THREE.Color(); private tmpB = new THREE.Color(); private tmpC = new THREE.Color()
  private windows: (THREE.MeshLambertMaterial | THREE.MeshStandardMaterial)[] = []
  private halo: THREE.InstancedMesh | null = null
  private pool: THREE.InstancedMesh | null = null
  private haloMat: THREE.ShaderMaterial | null = null
  private poolMat: THREE.ShaderMaterial | null = null
  private tmpV = new THREE.Vector3()
  private tmpM = new THREE.Matrix4()
  private lampSrc: THREE.InstancedMesh | null = null
  private lampHead = new THREE.Vector3(0, 5, 0)
  private lampVer = -1
  /** 路灯点光池 + 车前灯（构造时固定数量加进场景） */
  readonly nightLights: NightLights
  private lampHeads: Float32Array = new Float32Array(0)
  /** fx=high：物理天空 + 天空环境图 */
  private sky: SkyDome | null = null
  /** fx=high 且开阴影：级联阴影 */
  private csm: CsmShadows | null = null
  private cityCam: THREE.PerspectiveCamera | null = null
  private roomEnv: THREE.Texture | null = null
  /** 真实太阳方向（夜里在地平线下；sunDir 夜里换成月光） */
  private realSun = new THREE.Vector3(0, 1, 0)
  private shadowToken = -1

  constructor(private scene: THREE.Scene, private renderer: THREE.WebGLRenderer, private settings: Settings) {
    installAtmosphereChunks()
    ATMO_DEBUG.renderer = renderer
    startFrameToken()
    this.shadowsOn = settings.shadows
    FACADE.on = settings.fx !== 'off'
    renderer.shadowMap.enabled = this.shadowsOn
    renderer.shadowMap.type = THREE.PCFShadowMap   // r186 已移除 PCFSoft，PCF 即为软阴影
    renderer.toneMapping = THREE.AgXToneMapping
    renderer.toneMappingExposure = 1
    // IBL：RoomEnvironment 预滤波成 PMREM，作为全场景漫反射补光（Lambert/Standard 都吃 scene.environment）
    const pmrem = new THREE.PMREMGenerator(renderer)
    const room = new RoomEnvironment()
    scene.environment = pmrem.fromScene(room, 0.04).texture
    this.roomEnv = scene.environment
    scene.environmentIntensity = DAY.envI
    room.dispose()
    // 湿路面专用反射环境：无热点的天空渐变（天顶灰蓝 → 地平线暖白 → 地下近黑）。RoomEnvironment 里有强发光灯箱，
    // 低粗糙度路面会把它们反射成一团 HDR 白斑；这张图只给"天空/远处城市"的柔和反光。Weather 读 scene.userData.roadEnv
    scene.userData.roadEnv = makeSkyGradientEnv(pmrem)
    pmrem.dispose()

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

    // 夜间真实光源：数量开局固定（high 8 盏路灯点光，low/off 4 盏），之后只改强度，不触发着色器重编译
    this.nightLights = new NightLights(scene, settings.fx === 'high' ? 8 : 4)

    if (!scene.background) scene.background = new THREE.Color(0xa9c9e8)
    if (!scene.fog) scene.fog = new THREE.Fog(0xa9c9e8, 150, 380)
    this.installSceneHooks()
  }

  /**
   * 城市场景渲染钩子（只作用于本场景：竞技场等其它场景渲染时不受影响）：
   * 渲染前打开高度雾、天空跟随相机、CSM 拟合当前相机；同一显示帧里只让阴影图更新一次。渲染后复原。
   */
  private installSceneHooks() {
    const scene = this.scene
    scene.onBeforeRender = (renderer, _sc, camera) => {
      if (!this.sky) return
      ATMO.params.w = ATMO_OPTS.fog ? 1 : 0
      this.sky.mesh.visible = ATMO_OPTS.skyMesh && !scene.overrideMaterial
      this.sky.mesh.position.copy(camera.position)
      if (this.csm && camera === this.cityCam) {
        this.csm.update(this.sunDir, this.cSun, this.sunI)
        renderer.shadowMap.autoUpdate = false
        if (frameToken !== this.shadowToken) { this.shadowToken = frameToken; renderer.shadowMap.needsUpdate = true; this.csm.schedule(frameToken) }
      }
    }
    scene.onAfterRender = (renderer) => {
      ATMO.params.w = 0
      renderer.shadowMap.autoUpdate = true
    }
  }

  /** 按 fx 档与阴影开关创建/销毁物理天空与 CSM（运行时切档、切阴影都走这里） */
  private syncHigh(camera: THREE.PerspectiveCamera) {
    const high = this.settings.fx === 'high' && ATMO_OPTS.sky
    if (high && !this.sky) {
      this.sky = new SkyDome((this.scene.fog as THREE.Fog).color)
      this.scene.add(this.sky.mesh)
    } else if (!high && this.sky) {
      this.sky.dispose(); this.sky = null
      this.scene.environment = this.roomEnv
      ATMO.params.w = 0
    }
    const wantCsm = high && this.shadowsOn && ATMO_OPTS.csm
    if (wantCsm && (!this.csm || this.cityCam !== camera)) {
      this.csm?.dispose()
      this.cityCam = camera
      this.csm = new CsmShadows(this.scene, camera)
      this.shadowToken = -1
      // 原太阳的 2048² 阴影图在 CSM 期间用不到：释放，切回时 three 会重建
      this.sun.shadow.map?.dispose(); this.sun.shadow.map = null
    } else if (!wantCsm && this.csm) {
      this.csm.dispose(); this.csm = null
      this.renderer.shadowMap.autoUpdate = true
    }
    // CSM 期间原太阳隐藏（否则方向光数量不是 3，且会多照一次）；灯光数量变化由 three 自动触发材质重编译
    this.sun.visible = !this.csm
    ATMO_DEBUG.csm = this.csm; ATMO_DEBUG.sky = this.sky
    this.sun.castShadow = this.shadowsOn
  }

  /** 世界网格就绪后调用：读取 userData 约定、设置投影/接收阴影、生成路灯光晕 */
  attachWorld() {
    const ud = this.scene.userData
    this.windows = (ud.windows as (THREE.MeshLambertMaterial | THREE.MeshStandardMaterial)[] | undefined) ?? []
    this.applyShadowFlags(this.scene)
    const lamps = ud.lamps as THREE.InstancedMesh | undefined
    if (lamps) {
      this.lampHead.copy((ud.lampHead as THREE.Vector3 | undefined) ?? new THREE.Vector3(0, 5, 0))
      this.buildLampGlow(lamps)
    }
  }

  /** 运行时开关阴影（设置面板用）：切换 shadowMap 后材质需重新编译 */
  setShadows(on: boolean) {
    if (on === this.shadowsOn) return
    this.shadowsOn = on
    this.renderer.shadowMap.enabled = on
    this.sun.castShadow = on
    if (!on && this.csm) { this.csm.dispose(); this.csm = null; this.sun.visible = true; this.renderer.shadowMap.autoUpdate = true }
    this.scene.traverse((o) => {
      const m = o as THREE.Mesh
      if (!m.isMesh) return
      const mats = Array.isArray(m.material) ? m.material : [m.material]
      for (const mat of mats) mat.needsUpdate = true
    })
  }

  /**
   * 递归设置阴影标记：不透明 Lambert 网格投影+接收；userData.castShadow=false 可排除（地面等）；
   * Standard 材质（路面/角色）同样参与；其它材质可用 material.userData.receiveShadow=true 显式加入
   */
  applyShadowFlags(root: THREE.Object3D) {
    root.traverse((o) => {
      const m = o as THREE.Mesh
      if (!m.isMesh) return
      const mat = m.material as THREE.Material
      const opaque = !mat.transparent && ((mat as THREE.MeshLambertMaterial).isMeshLambertMaterial === true || (mat as THREE.MeshStandardMaterial).isMeshStandardMaterial === true || mat.userData.receiveShadow === true)
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
    // 夜间（night≈1）暴雨不再一味压暗：城市灯光被低云反射（天光），半球光不降、曝光不降，墙面不至于全黑；
    // 但湿路面镜面反射 + 路灯点光/车灯已经很亮，半球光略收，避免暴雨夜比晴夜还亮
    const night = clamp((0.3 - this.envI) / 0.26, 0, 1)
    this.cHemiGround.multiplyScalar(1 - 0.4 * gloom * (1 - night))
    this.hemiI *= 1 - 0.4 * gloom * (1 - night) - 0.12 * gloom * night
    // 夜间暴雨雾很近（22 m 起）：夜雾色比晴夜（已提亮）再压一些，否则整条街被灰粉色雾罩白
    this.cFog.multiplyScalar(1 - 0.3 * gloom * night)
    // 夜里暴雨月光几乎全灭：否则湿路面（低粗糙度）上会出现一大团月光镜面高光，被泛光放大成白斑
    this.sunI *= 1 - (0.85 + 0.13 * night) * gloom
    this.exposure *= 1 - 0.12 * gloom * (1 - night)
    this.envI = this.envI * (1 - 0.35 * gloom) + 0.02 * gloom * night
    const gr = this.grade
    gr.saturation *= 1 - 0.18 * gloom
    gr.split *= 1 - 0.3 * gloom
    gr.vignette = Math.min(0.6, gr.vignette + 0.1 * gloom)
    gr.bloom += 0.15 * gloom * this.lights
    gr.bloomThreshold = lerp(gr.bloomThreshold, Math.min(gr.bloomThreshold, 1.0), gloom)
    this.fogNear = lerp(this.fogNear, 22, gloom); this.fogFar = lerp(this.fogFar, 140, gloom)
    // 闪电：天空与半球光瞬间拉亮
    if (flash > 0.001) {
      this.tmpB.setHex(0xdde6ff)
      this.cSky.lerp(this.tmpB, flash * 0.7); this.cFog.lerp(this.tmpB, flash * 0.6)
      this.hemiI += flash * 2.5
    }

    const bg = this.scene.background as THREE.Color
    const fog = this.scene.fog as THREE.Fog
    // 玩家亮度设置乘到曝光；天空/雾按最终曝光反解，亮度滑杆只提亮场景、天空色不变（与 fx=off 直出一致）
    const exposure = this.exposure * clamp(this.settings.brightness ?? 1, 0.5, 2)
    if (this.hdrSky) { this.toHdr(this.cSky, exposure, bg); this.toHdr(this.cFog, exposure, fog.color) }
    else { bg.copy(this.cSky); fog.color.copy(this.cFog) }
    fog.near = this.fogNear * this.fogScale; fog.far = this.fogFar * this.fogScale
    this.hemi.color.copy(this.cHemiSky); this.hemi.groundColor.copy(this.cHemiGround); this.hemi.intensity = this.hemiI
    this.renderer.toneMappingExposure = exposure
    this.scene.environmentIntensity = this.envI
    // 角色边缘光：白天取天空色、夜间霓虹；暴雨时略增
    LOOK.uRimColor.value.copy(this.cSky).lerp(NEON_RIM, clamp((this.rim - 0.15) / 0.65, 0, 1))
    LOOK.uRimStrength.value = this.rim + 0.12 * gloom

    // 太阳方向：日出在东、日落在西，正午近头顶；地平线下改用固定方向的月光
    const f = (h - SUNRISE) / (SUNSET - SUNRISE)
    const theta = Math.PI * f
    const elev = f > 0 && f < 1 ? Math.sin(theta) : -1
    if (elev > 0.03) this.sunDir.set(Math.cos(theta), elev * 0.985, 0.3).normalize()
    else this.sunDir.copy(MOON_DIR)
    this.realSun.set(Math.cos(theta), Math.sin(theta) * 0.985, 0.3).normalize()
    this.syncHigh(ctx.cam.camera)
    if (this.sky) this.updateAtmosphere(dt, gloom, flash)
    this.sun.color.copy(this.cSun); this.sun.intensity = this.sunI
    const pl = ctx.player
    const px = pl.worldX, pz = pl.worldZ
    this.sun.target.position.set(px, 0, pz)
    this.sun.position.set(px + this.sunDir.x * 200, this.sunDir.y * 200, pz + this.sunDir.z * 200)

    // 夜间灯光：19:00 前后亮起、06:30 前后熄灭；暴雨时也部分亮起
    const on = h < 12 ? 1 - smoothstep(6.0, 6.8, h) : smoothstep(18.7, 19.5, h)
    const target = Math.max(on, gloom * 0.55)
    this.lights = Math.abs(target - this.lights) > 0.3 ? target : lerp(this.lights, target, 1 - Math.exp(-dt * 3))
    for (const w of this.windows) w.emissiveIntensity = 1.5 * this.lights   // HDR：>1 才会被泛光阈值抓到
    // 程序化外墙（FacadeShader 读 emissive.r 作夜灯强度）只在 fx=high/low 用；fx=off 回退 Lambert 窗格贴图
    FACADE.on = this.settings.fx !== 'off'
    // P14.6 照片扫描细节只在 fx=high（首次进 high 才下载贴图；运行时切档即时生效）
    setFacadeDetail(this.settings.fx === 'high', this.renderer)
    LOOK.uSignGlow.value = this.lights
    if (this.haloMat) { this.haloMat.uniforms.uOpacity.value = this.lights; this.halo!.visible = this.lights > 0.01 }
    if (this.poolMat) {
      const u = this.poolMat.uniforms
      u.uOpacity.value = 0.42 * this.lights; u.uWet.value = clamp(this.wet, 0, 1)
      this.pool!.visible = this.lights > 0.01
    }

    // 流式世界：灯柱实例集合变了（区块加载/卸载）→ 重写光晕实例
    const ud = this.scene.userData
    const lamps = ud.lamps as THREE.InstancedMesh | undefined
    if (lamps && this.lampSrc && (lamps !== this.lampSrc || ((ud.lampsVersion as number | undefined) ?? 0) !== this.lampVer)) this.buildLampGlow(lamps)

    // 路灯点光 + 车前灯：夜间灯光开启度；车灯在暴雨（阴沉）白天也开
    const head = clamp(Math.max(this.lights, (gloom - 0.3) / 0.4), 0, 1)
    this.nightLights.update(dt, px, pz, ctx.cam.camera, ctx.vehicles, pl.vehicle, this.lights, head, this.wet, ctx.world)

    // 新生成的动态物体（车辆）补阴影标记
    if (this.shadowsOn) for (const v of ctx.vehicles) if (!v.group.userData.shadowDone) this.applyShadowFlags(v.group)
  }

  /**
   * fx=high：天空混合参数、雾内散射、环境图节流重烘。色表仍主导：夜晚/暴雨/闪电时物理天空权重 → 0，
   * 天空色表色本身已按 AgX 反解成 HDR（scene.background），物理天空按它的亮度归一，不再反解。
   */
  private updateAtmosphere(dt: number, gloom: number, flash: number) {
    const sky = this.sky!
    const u = sky.uniforms
    const e = this.realSun.y
    const day = smoothstep(-0.05, 0.25, e)
    const clear = (1 - gloom) * (1 - gloom)
    u.sunPosition.value.copy(this.realSun)
    u.time.value += dt
    u.uSkyColor.value.copy(this.scene.background as THREE.Color)
    u.uMix.value.set(
      0.55 * day * clear * (1 - flash),                       // 物理天空权重
      0.85 * smoothstep(-0.12, 0.1, e) * (1 - 0.7 * gloom),   // 渐变/日晕强度
      lerp(0.14, 0.3, gloom),                                 // 地平线混雾高度
      day * clear * (1 - flash),                              // 太阳盘
    )
    u.uSunCol.value.copy(this.cSun)
    u.cloudCoverage.value = lerp(0.35, 0.9, gloom)
    u.turbidity.value = lerp(3.2, 10, gloom)
    // 雾：高度衰减（暴雨时雨幕填满，不随高度变薄）、朝太阳偏暖偏亮（低太阳最明显）、背光偏冷
    const low = 1 - smoothstep(0.1, 0.7, e)
    const sc = smoothstep(-0.04, 0.08, e) * (0.35 + 0.95 * low) * (1 - gloom)
    const warm = this.cSun
    ATMO.sun.x = this.realSun.x; ATMO.sun.y = this.realSun.y; ATMO.sun.z = this.realSun.z
    ATMO.scatter.x = warm.r * sc; ATMO.scatter.y = warm.g * sc * 0.85; ATMO.scatter.z = warm.b * sc * 0.6
    ATMO.params.x = (1 / 110) * (1 - 0.85 * gloom)
    ATMO.params.z = 0.35 * day * (1 - gloom)
    // 环境图：每 15 游戏分钟 / 阴沉度每 1/8 档重烘一次（夜里不随时间变），闪电期间不烘
    // 夜里（太阳在地平线下）仍用 RoomEnvironment：夜间 envI 只有 ≈0.05，中性补光保持原来的夜景色调（天空烘焙图是深蓝，会把墙面染蓝）
    if (!ATMO_OPTS.env || e < -0.05) { this.scene.environment = this.roomEnv; sky.invalidateEnv() }
    else if (flash < 0.01) {
      const key = `${Math.round(this.lastHour * 4)}|${Math.round(gloom * 8)}`
      // 亮度归一：环境图平均亮度 ≈ 正午水平，昼夜/阴晴的明暗仍只由色表 envI 控制（否则日落、暴雨时天空变暗 × envI 变小，双重压暗）
      const skyL = (lum(u.uSkyColor.value) + lum((this.scene.fog as THREE.Fog).color)) * 0.5
      const norm = clamp(1.02 / Math.max(skyL, 1e-3), 1, 3)
      // 地平线以下：城市地面/楼体的反弹光 ≈ 雾色（已是 HDR）× groundK，再偏一点半球光地面色（否则立面只吃到半边天空，比 RoomEnvironment 暗很多）
      u.uGround.value.copy((this.scene.fog as THREE.Fog).color).multiplyScalar(ATMO_OPTS.groundK).lerp(this.cHemiGround, 0.3)
      const tex = sky.bakeEnv(this.renderer, `${key}|${ATMO_OPTS.envGain}|${ATMO_OPTS.groundK}|${ATMO_OPTS.envSat}`, performance.now() / 1000, SKY_ENV_GAIN * ATMO_OPTS.envGain * norm, ATMO_OPTS.envSat)
      if (tex) this.scene.environment = tex
    }
  }

  /** 显示色 → AgX 前的 HDR 色；暗色（AgX 地板以下）反解不收敛时退回原色 */
  private toHdr(c: THREE.Color, exposure: number, out: THREE.Color) {
    agxInverse(c, exposure, out)
    agx(out, exposure, this.tmpB)
    if (Math.abs(this.tmpB.r - c.r) + Math.abs(this.tmpB.g - c.g) + Math.abs(this.tmpB.b - c.b) > 0.03 || lum(c) < 0.02) out.copy(c)
  }

  // 采样结果（update 内临时使用）
  private hemiI = 1; private sunI = 1; private exposure = 1; private fogNear = 150; private fogFar = 380; private envI = 0.6; private rim = 0.15

  private lastHour = 12
  private sample(h: number) {
    this.lastHour = h
    let i = 0
    while (i < KEYS.length - 2 && KEYS[i + 1].h <= h) i++
    const a = KEYS[i], b = KEYS[i + 1]
    const t = clamp((h - a.h) / (b.h - a.h), 0, 1)
    const mix = (x: number, y: number, out: THREE.Color) => out.setHex(x).lerp(this.tmpC.setHex(y), t)
    mix(a.sky, b.sky, this.cSky); mix(a.fog, b.fog, this.cFog)
    mix(a.hemiSky, b.hemiSky, this.cHemiSky); mix(a.hemiGround, b.hemiGround, this.cHemiGround); mix(a.sun, b.sun, this.cSun)
    this.hemiI = lerp(a.hemiI, b.hemiI, t); this.sunI = lerp(a.sunI, b.sunI, t); this.exposure = lerp(a.exposure, b.exposure, t)
    this.fogNear = lerp(a.fogNear, b.fogNear, t); this.fogFar = lerp(a.fogFar, b.fogFar, t)
    this.envI = lerp(a.envI, b.envI, t)
    const ga = a.g, gb = b.g, gr = this.grade
    gr.contrast = lerp(ga.con, gb.con, t); gr.saturation = lerp(ga.sat, gb.sat, t)
    mix(ga.shT, gb.shT, gr.shadowTint); mix(ga.hiT, gb.hiT, gr.highlightTint)
    gr.split = lerp(ga.split, gb.split, t); gr.vignette = lerp(ga.vig, gb.vig, t)
    gr.grain = lerp(ga.grain, gb.grain, t); gr.chroma = lerp(ga.chroma, gb.chroma, t)
    gr.bloom = lerp(ga.bloom, gb.bloom, t); gr.bloomThreshold = lerp(ga.bTh, gb.bTh, t)
    this.rim = lerp(ga.rim, gb.rim, t)
    // P13.3/13.5（仅 fx=high 生效）：光束强度——太阳方向光离开地平线（7.12–19.05 h，之外 this.sun 换成月光方向）才有，
    // 日出（≈7.6 h）/ 日落（≈18.5 h）最强、正午弱、夜晚与暴雨 0；胶片 LUT 昼夜权重（6:30 / 19:40 前后各 1 h 渐变）
    const sunUp = smoothstep(7.15, 7.45, h) * (1 - smoothstep(18.75, 19.05, h))
    const golden = Math.max(1 - smoothstep(0, 1.6, Math.abs(h - 7.6)), 1 - smoothstep(0, 1.6, Math.abs(h - 18.5)))
    gr.rays = sunUp * (0.22 + 0.58 * golden) * (1 - this.gloom)
    const nightW = clamp(1 - smoothstep(5.8, 6.8, h) + smoothstep(19.2, 20.2, h), 0, 1)
    gr.lutDay = (1 - nightW) * 0.85 * (1 - 0.3 * this.gloom)
    gr.lutNight = nightW * 0.8 * (1 - 0.3 * this.gloom)
  }

  /**
   * 路灯光晕：面向相机的 additive 四边形（InstancedMesh + 小 shader）+ 地面光池。
   * 可重复调用：容量够时只重写实例矩阵与 count，不够才换新的 InstancedMesh（材质复用）。
   */
  private buildLampGlow(lamps: THREE.InstancedMesh) {
    this.lampSrc = lamps
    this.lampVer = (this.scene.userData.lampsVersion as number | undefined) ?? 0
    const n = lamps.count
    const cap = Math.max(1, lamps.instanceMatrix.count)
    if (!this.haloMat || !this.poolMat) this.makeGlowMaterials()
    if (!this.halo || !this.pool || this.halo.instanceMatrix.count < n) {
      if (this.halo) { this.halo.removeFromParent(); this.halo.dispose(); this.halo.geometry.dispose() }
      if (this.pool) { this.pool.removeFromParent(); this.pool.dispose(); this.pool.geometry.dispose() }
      this.halo = new THREE.InstancedMesh(new THREE.PlaneGeometry(1, 1), this.haloMat!, cap)
      this.pool = new THREE.InstancedMesh(new THREE.PlaneGeometry(1, 1, 1, 1), this.poolMat!, cap)
      this.halo.frustumCulled = false
      this.pool.frustumCulled = false
      this.halo.visible = this.pool.visible = this.lights > 0.01
      this.scene.add(this.halo, this.pool)
    }
    const head = this.lampHead
    const q = new THREE.Quaternion(), s = new THREE.Vector3(1, 1, 1)
    if (this.lampHeads.length < n * 3) this.lampHeads = new Float32Array(cap * 3)
    const hp = this.lampHeads
    for (let i = 0; i < n; i++) {
      lamps.getMatrixAt(i, this.tmpM)
      this.tmpV.copy(head).applyMatrix4(this.tmpM)
      hp[i * 3] = this.tmpV.x; hp[i * 3 + 1] = this.tmpV.y; hp[i * 3 + 2] = this.tmpV.z
      this.halo.setMatrixAt(i, this.tmpM.compose(this.tmpV, q, s))
      this.tmpV.y = 0.15   // 高于人行道（0.12），否则人行道上的灯下光池/倒影被遮住
      this.pool.setMatrixAt(i, this.tmpM.compose(this.tmpV, q, s))
    }
    this.halo.count = n; this.pool.count = n
    this.nightLights.setLamps(hp, n)
    this.halo.instanceMatrix.needsUpdate = true
    this.pool.instanceMatrix.needsUpdate = true
  }

  private makeGlowMaterials() {
    const tex = makeGlowTexture()
    this.haloMat = new THREE.ShaderMaterial({
      uniforms: { uMap: { value: tex }, uOpacity: { value: 0 }, uSize: { value: 2.6 }, uColor: { value: new THREE.Color(0xffd79a).multiplyScalar(1.6) } },   // HDR 光晕，供泛光抓取
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
    // 地面光池 + 湿地倒影：同一个实例四边形，顶点着色器把它沿"灯→相机"方向拉长（干燥时就是半径 7 m 的圆形光池），
    // 片元里解析计算圆形光池 + 一条朝相机的高斯条纹（灯头在湿路面上的拉长倒影，HDR 供泛光抓取）。不增加 draw call。
    this.poolMat = new THREE.ShaderMaterial({
      uniforms: { uOpacity: { value: 0 }, uWet: { value: 0 }, uColor: { value: new THREE.Color(0xffc77a) }, uStreak: { value: new THREE.Color(0xffd79a).multiplyScalar(1.7) }, uR: { value: 7 }, uFar: { value: 170 } },
      vertexShader: `
        uniform float uWet, uR;
        varying vec2 vLocal;      // x = 沿"灯→相机"距离，y = 横向距离（米）
        varying float vC, vL, vD;
        void main() {
          vec3 c = (modelMatrix * instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0)).xyz;
          vec2 tc = cameraPosition.xz - c.xz;
          float D = length(tc);
          vec2 f = D > 1e-3 ? tc / D : vec2(0.0, 1.0);
          vec2 sd = vec2(-f.y, f.x);
          // 倒影中心：灯头高 H≈5 m、相机高 E≈3 m，镜面点离灯 D·H/(H+E) ≈ 0.6·D；粗糙湿面再沿视线拉成长条。
          // 只给中远处的灯画倒影（近处的会糊在镜头前），镜面点离相机至少 ~8 m
          float cc = clamp(D * 0.6, 0.0, max(0.0, D - 8.0));
          float ll = 0.8 + cc * 0.16;
          float front = max(uR, uWet > 0.01 ? min(cc + ll * 2.2, D - 2.0) : uR);
          float along = mix(-uR, front, position.x + 0.5);
          float across = position.y * 2.0 * uR;
          vLocal = vec2(along, across); vC = cc; vL = ll; vD = D;
          vec3 w = vec3(c.x + f.x * along + sd.x * across, c.y, c.z + f.y * along + sd.y * across);
          gl_Position = projectionMatrix * viewMatrix * vec4(w, 1.0);
        }`,
      fragmentShader: `
        uniform float uOpacity, uWet, uR, uFar; uniform vec3 uColor, uStreak;
        varying vec2 vLocal; varying float vC, vL, vD;
        void main() {
          float r = length(vLocal) / uR;
          // 与原径向贴图同形：中心亮、0.25/0.6 处衰减
          float pool = r < 0.25 ? mix(1.0, 0.55, r / 0.25) : r < 0.6 ? mix(0.55, 0.12, (r - 0.25) / 0.35) : max(0.0, mix(0.12, 0.0, (r - 0.6) / 0.4));
          float w = 0.16 + 0.008 * vC;
          float da = (vLocal.x - vC) / vL;
          float streak = exp(-(vLocal.y * vLocal.y) / (w * w)) * exp(-da * da) * uWet * smoothstep(10.0, 22.0, vD);
          float fade = 1.0 - smoothstep(uFar * 0.55, uFar, vD);
          vec3 col = uColor * pool * uOpacity * (1.0 + 0.15 * uWet) + uStreak * streak * uOpacity * 1.6;
          gl_FragColor = vec4(col * fade, 1.0);
        }`,
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, fog: false, side: THREE.DoubleSide,
    })
  }
}

function makeSkyGradientEnv(pmrem: THREE.PMREMGenerator): THREE.Texture {
  const geo = new THREE.SphereGeometry(10, 32, 16)
  const pos = geo.getAttribute('position')
  const col = new Float32Array(pos.count * 3)
  const zen = new THREE.Color(0.55, 0.62, 0.75), hor = new THREE.Color(1.0, 0.92, 0.82), low = new THREE.Color(0.04, 0.04, 0.05), c = new THREE.Color()
  for (let i = 0; i < pos.count; i++) {
    const y = pos.getY(i) / 10
    if (y >= 0) c.copy(hor).lerp(zen, Math.pow(y, 0.6))
    else c.copy(hor).lerp(low, Math.min(1, -y * 6))
    col[i * 3] = c.r; col[i * 3 + 1] = c.g; col[i * 3 + 2] = c.b
  }
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3))
  const sky = new THREE.Scene()
  const mesh = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.BackSide }))
  sky.add(mesh)
  const tex = pmrem.fromScene(sky, 0.02).texture
  geo.dispose(); (mesh.material as THREE.Material).dispose()
  return tex
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
