import * as THREE from 'three'
import { BlendFunction, BloomEffect, Effect, EffectAttribute, EffectComposer, EffectPass, GodRaysEffect, LUT3DEffect, LUTCubeLoader, LookupTexture, RenderPass, ToneMappingEffect, ToneMappingMode } from 'postprocessing'
import { N8AOPostPass } from 'n8ao'

/**
 * 后期管线（pmndrs/postprocessing，线性 HDR → AgX）：
 *   EffectComposer（HalfFloat + MSAA×4）→ RenderPass → N8AO（半分辨率 + 降噪，仅 high；直接乘进画面）
 *   → 一个 EffectPass，按顺序合并成一次全屏绘制：
 *       Bloom（mipmap 模糊，阈值≈1 只抓 HDR 发光体；low 档半分辨率）
 *       → ReaGradeEffect（线性空间：对比/饱和/分离色调/暗角/胶片颗粒/边缘色差）
 *       → ToneMapping AgX（读 renderer.toneMappingExposure）→ sRGB 输出（postprocessing 默认流程）。
 * 后续效果（GodRays / 镜头鬼影 / LUT）都往这个 EffectPass 里按顺序插，不再新增全屏 pass。
 * P13.3–13.5（仅 high + 城市场景 + cine 开）：EffectPass 实际执行顺序（postprocessing 按属性排序，卷积/深度类在前）
 *   ReaGradeEffect（+ 太阳镜头鬼影 / 宽银幕拉丝 / 边缘速度模糊）→ GodRays（ADD）→ Bloom → AgX → 胶片 LUT（白天 / 夜晚两张在 CPU 上按权重混成一张，只在权重变化时重写）。
 * `?cine=0`（或运行时 cine.on=false）时重建不含 GodRays / LUT 的 EffectPass，与 P13.0 管线一致。
 * postprocessing 要求渲染期间 renderer.toneMapping = NoToneMapping：render() 内临时切换、结束恢复，
 * DayNight / ArenaMode 对 renderer.toneMapping 的赋值不动（fx=off 直出仍用它）。
 * 抗锯齿用渲染目标 MSAA×4（几何边缘最干净、无额外 pass），不再叠 SMAA。
 * fx=off 时 Game 不调用本类，直接 renderer.render（仍有 AgX 与 environment）。
 */
import type { FxQuality } from './Settings'
import { cine } from './Cine'
export type { FxQuality }

/** 每帧由 DayNight 计算、Game 推入的调色参数（颜色为线性 RGB） */
export interface GradeParams {
  /** 对比度（以 0.18 中灰为支点、对数空间） */
  contrast: number
  /** 饱和度（1 = 不变；AgX 偏灰，白天略 >1 补回） */
  saturation: number
  /** 暗部 / 亮部色调（只取色相，亮度由着色器归一化） */
  shadowTint: THREE.Color
  highlightTint: THREE.Color
  /** 分离色调强度 0–1 */
  split: number
  /** 暗角强度 0–1 */
  vignette: number
  /** 胶片颗粒强度（≈0.02–0.06） */
  grain: number
  /** 屏幕边缘色差（像素量级，≈0–2.5） */
  chroma: number
  /** 泛光强度 / 阈值 / 半径 */
  bloom: number
  bloomThreshold: number
  bloomRadius: number
  /** AO 强度 0–1（仅 high） */
  ao: number
  /** P13.3 丁达尔光束强度 0–1（日出日落最强、正午弱、夜晚 / 暴雨 0；镜头鬼影也以它>0 作为「有太阳」的判据） */
  rays: number
  /** P13.5 胶片 LUT 权重 0–1：白天「2383 印片」/ 夜晚「青橙霓虹」（两张按比例混成一张，权重之和 = LUT 不透明度） */
  lutDay: number
  lutNight: number
}

export function defaultGrade(): GradeParams {
  return {
    contrast: 1.05, saturation: 1.1, shadowTint: new THREE.Color(1, 1, 1), highlightTint: new THREE.Color(1, 1, 1), split: 0,
    vignette: 0.2, grain: 0.02, chroma: 0.6, bloom: 0.2, bloomThreshold: 1.2, bloomRadius: 0.5, ao: 0.6,
    rays: 0.35, lutDay: 0.8, lutNight: 0,
  }
}

/**
 * 调色（原 GradeShader 原样移植）：在 EffectPass 里位于 Bloom 之后、色调映射之前，inputColor = 场景 + 泛光（线性 HDR）。
 * 色差需要偏移采样：inputBuffer 是本 pass 的输入（不含泛光），所以只把 R/B 的「场景部分」换成偏移处的值，
 * 泛光是低频的，偏移几个像素差别可忽略 —— 结果与原来对（场景 + 泛光）整体偏移采样一致。
 * resolution（缓冲像素尺寸）与 time（累计秒）是 EffectPass 内置 uniform。
 */
const GRADE_FRAG = /* glsl */`
  uniform float uContrast, uSaturation, uSplit, uVignette, uGrain, uChroma;
  uniform vec3 uShadowTint, uHighlightTint;
  // P13.4 镜头：太阳屏幕坐标 / 鬼影强度（已乘朝向与昼夜，0 = 关）/ 太阳色（亮度归一）/ 边缘速度模糊 0–1
  uniform vec2 uSunUv;
  uniform float uLens, uSpeedBlur;
  uniform vec3 uSunCol;

  float gLuma(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }
  float gHash(vec2 p) { p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }
  vec3 gNormTint(vec3 t) { return t / max(gLuma(t), 1e-3); }

  // 太阳可见度：太阳屏幕点周围 5 个深度采样中「天空」（深度≈远平面）的比例 × 出屏渐隐。楼挡住太阳时鬼影自然熄灭
  float gSunVis() {
    vec2 e = min(uSunUv, 1.0 - uSunUv);
    float edge = smoothstep(-0.01, 0.05, min(e.x, e.y));
    if (edge <= 0.0) return 0.0;
    vec2 o = vec2(0.006, 0.006 * aspect);
    float v = step(0.99995, readDepth(clamp(uSunUv, 0.001, 0.999)));
    v += step(0.99995, readDepth(clamp(uSunUv + vec2(o.x, 0.0), 0.001, 0.999)));
    v += step(0.99995, readDepth(clamp(uSunUv - vec2(o.x, 0.0), 0.001, 0.999)));
    v += step(0.99995, readDepth(clamp(uSunUv + vec2(0.0, o.y), 0.001, 0.999)));
    v += step(0.99995, readDepth(clamp(uSunUv - vec2(0.0, o.y), 0.001, 0.999)));
    return v * 0.2 * edge;
  }
  // 单个鬼影：软圆盘 + 略亮的边缘（光圈形状），半径按屏幕高度
  float gGhost(vec2 uv, vec2 c, float r) {
    float dd = length((uv - c) * vec2(aspect, 1.0));
    return smoothstep(r, r * 0.75, dd) * (0.55 + 0.45 * smoothstep(r * 0.35, r * 0.9, dd));
  }
  vec3 gLens(vec2 uv) {
    float vis = gSunVis();
    if (vis <= 0.0) return vec3(0.0);
    vec2 toC = vec2(0.5) - uSunUv;
    // 沿「太阳 → 屏幕中心」连线（越过中心到对侧）4 个彩色鬼影
    vec3 g = vec3(0.0);
    g += vec3(1.0, 0.62, 0.3) * gGhost(uv, uSunUv + toC * 0.55, 0.028);
    g += vec3(0.45, 0.9, 0.6) * 0.6 * gGhost(uv, uSunUv + toC * 1.3, 0.055);
    g += vec3(0.75, 0.45, 1.0) * 0.8 * gGhost(uv, uSunUv + toC * 1.6, 0.02);
    g += vec3(0.4, 0.6, 1.0) * 0.3 * gGhost(uv, uSunUv + toC * 2.05, 0.11);
    // 宽银幕横向拉丝：贴太阳高度的一道细横线，左右指数衰减，偏蓝
    float dy = (uv.y - uSunUv.y) / 0.0035;
    float dx = abs(uv.x - uSunUv.x) * aspect;
    float streak = exp(-dy * dy) * exp(-dx * 3.0);
    vec3 col = uSunCol;
    return (g * col * 0.05 + vec3(0.55, 0.72, 1.0) * streak * 0.16) * vis * uLens;
  }

  void mainImage(const in vec4 inputColor, const in vec2 uv, const in float depth, out vec4 outputColor) {
    vec2 d = uv - 0.5;
    float r2 = dot(d, d);
    vec3 c = inputColor.rgb;
    // 高速边缘径向速度模糊：沿径向朝中心多次采样 inputBuffer，只替换「场景部分」；中心清晰
    if (uSpeedBlur > 0.0) {
      float m = smoothstep(0.02, 0.2, r2) * uSpeedBlur;
      if (m > 0.002) {
        vec3 base = texture2D(inputBuffer, uv).rgb, acc = base;
        for (int i = 1; i < 7; i++) acc += texture2D(inputBuffer, uv - d * (float(i) * 0.011 * m)).rgb;
        c += acc / 7.0 - base;
      }
    }
    // 边缘色差：R/B 沿径向反向偏移，中心为 0
    if (uChroma > 0.0) {
      vec2 off = d * r2 * 4.0 * uChroma / resolution;
      vec3 base = texture2D(inputBuffer, uv).rgb;
      c.r += texture2D(inputBuffer, uv + off).r - base.r;
      c.b += texture2D(inputBuffer, uv - off).b - base.b;
    }
    c = max(c, 0.0);
    if (uLens > 0.0) c += gLens(uv);

    // 对比：对数空间以中灰为支点（HDR 友好，不裁剪高光）
    float l = gLuma(c);
    float lc = 0.18 * pow(max(l, 1e-5) / 0.18, uContrast);
    c *= lc / max(l, 1e-5);
    l = lc;
    // 饱和
    c = max(mix(vec3(l), c, uSaturation), 0.0);
    // 分离色调：按对数亮度在暗部/亮部色相之间插值，保持亮度
    float t = smoothstep(-3.5, 0.5, log2(max(l, 1e-5) / 0.18));
    vec3 tint = mix(gNormTint(uShadowTint), gNormTint(uHighlightTint), t);
    c *= mix(vec3(1.0), tint, uSplit);
    // 暗角
    float v = 1.0 - uVignette * smoothstep(0.08, 0.55, r2 * 1.6);
    c *= v;
    // 胶片颗粒（每帧变化，按亮度比例 + 暗部保底，避免黑处纯黑噪点）
    float n = gHash(uv * resolution + fract(time * 13.37) * 371.0) - 0.5;
    c += n * uGrain * (sqrt(l) * 0.6 + 0.02);
    outputColor = vec4(max(c, 0.0), inputColor.a);
  }`

class ReaGradeEffect extends Effect {
  constructor() {
    super('ReaGradeEffect', GRADE_FRAG, {
      blendFunction: BlendFunction.SRC,
      // 色差对 inputBuffer 做偏移采样（同一 EffectPass 里只能有一个卷积类效果）
      // 镜头鬼影读深度判断太阳是否被挡
      attributes: EffectAttribute.CONVOLUTION | EffectAttribute.DEPTH,
      uniforms: new Map<string, THREE.Uniform>([
        ['uContrast', new THREE.Uniform(1)],
        ['uSaturation', new THREE.Uniform(1)],
        ['uShadowTint', new THREE.Uniform(new THREE.Color(1, 1, 1))],
        ['uHighlightTint', new THREE.Uniform(new THREE.Color(1, 1, 1))],
        ['uSplit', new THREE.Uniform(0)],
        ['uVignette', new THREE.Uniform(0)],
        ['uGrain', new THREE.Uniform(0)],
        ['uChroma', new THREE.Uniform(0)],
        ['uSunUv', new THREE.Uniform(new THREE.Vector2(0.5, 0.5))],
        ['uLens', new THREE.Uniform(0)],
        ['uSpeedBlur', new THREE.Uniform(0)],
        ['uSunCol', new THREE.Uniform(new THREE.Color(1, 1, 1))],
      ]),
    })
  }
  set(name: string, v: number) { this.uniforms.get(name)!.value = v }
  color(name: string) { return this.uniforms.get(name)!.value as THREE.Color }
}

const LOW_MAX_PR = 1.25
/**
 * GradeParams → 新管线参数换算（以迁移前 UnrealBloom / GTAO 截图对齐）：
 * UnrealBloom 是 5 级高斯按系数加权求和（系数和≈3），mipmap 模糊是归一化的且光晕摊得更开：
 * 7 级 + 上采样混合 0.78–0.88、强度 ×10 时 19:00 / 22:00 路灯光晕与原来最接近（同页 A/B 扫参）；
 * N8AO 的 intensity 是 AO 的幂指数，原来是 mix(1, ao, uAO) 线性混合。
 */
const BLOOM_GAIN = 10
const AO_GAIN = 2.5

/** P13.3 光束光源：太阳盘放在相机前 far×SUN_DIST 处，角半径 SUN_ANG（只画进 GodRays 自己的光源场景，不进城市场景） */
const SUN_DIST = 0.8
const SUN_ANG = THREE.MathUtils.degToRad(9)

/** 光源贴图：亮核 + 指数衰减的大光晕（整片「太阳附近的天空」都发光，楼的边缘才能切出成束的光柱） */
function sunTexture() {
  const n = 64, d = new Uint8Array(n * n * 4)
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
    const u = (x + 0.5) / n * 2 - 1, v = (y + 0.5) / n * 2 - 1, r = Math.hypot(u, v)
    const a = r >= 1 ? 0 : Math.min(1, Math.exp(-r * r * 9) * 0.85 + (r < 0.06 ? 1 : 0)) * (1 - r * r)
    const i = (y * n + x) * 4
    d[i] = d[i + 1] = d[i + 2] = Math.round(255 * a); d[i + 3] = 255
  }
  const t = new THREE.DataTexture(d, n, n)
  t.magFilter = THREE.LinearFilter; t.minFilter = THREE.LinearFilter
  t.needsUpdate = true
  return t
}
/** high 档开 LUT 时分离色调整体减弱（避免两层调色叠加过重） */
const SPLIT_WITH_LUT = 0.55
const LUT_SIZE = 33
const LUT_URL = { day: '/assets/lut/day.cube', night: '/assets/lut/night.cube' }

const smoothstep = (a: number, b: number, x: number) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t) }

export class PostFX {
  readonly composer: EffectComposer
  private renderPass: RenderPass
  private n8ao: N8AOPostPass | null = null
  private bloom: BloomEffect
  private grade: ReaGradeEffect
  private toneMap: ToneMappingEffect
  private fxPass: EffectPass
  /** P13.3–13.5（仅 high）：光束 / LUT；cine 关时不进 EffectPass */
  private godRays: GodRaysEffect | null = null
  private sunMesh: THREE.Mesh<THREE.CircleGeometry, THREE.MeshBasicMaterial> | null = null
  private raysOn = false
  private lut: LUT3DEffect | null = null
  /** LUT 当前混合结果（LUT3DEffect 用的那张）与两张原始数据（加载完成前为 null → 保持单位 LUT） */
  private lutMix: LookupTexture | null = null
  private lutSrc: { day: Float32Array | null; night: Float32Array | null } = { day: null, night: null }
  private lutKey = -1
  private builtCine = false
  /** Game 每帧推入：太阳方向（指向太阳、单位向量）、太阳色、车速 m/s */
  private sunDir = new THREE.Vector3(0, 1, 0)
  private sunCol = new THREE.Color(1, 1, 1)
  private speed = 0
  private tmpV = new THREE.Vector3()
  private tmpV2 = new THREE.Vector3()
  private w = 1; private h = 1
  private aoIntensity = -1
  /** 构造时的城市场景 / 相机（resetScene 恢复） */
  private baseScene: THREE.Scene
  private baseCamera: THREE.PerspectiveCamera
  private scene: THREE.Scene
  private camera: THREE.PerspectiveCamera

  constructor(private renderer: THREE.WebGLRenderer, scene: THREE.Scene, camera: THREE.PerspectiveCamera, readonly quality: Exclude<FxQuality, 'off'>) {
    const size = renderer.getSize(new THREE.Vector2())
    this.w = size.x; this.h = size.y
    this.baseScene = scene; this.baseCamera = camera; this.scene = scene; this.camera = camera
    this.composer = new EffectComposer(renderer, { frameBufferType: THREE.HalfFloatType, multisampling: 4 })
    this.renderPass = new RenderPass(scene, camera)
    this.composer.addPass(this.renderPass)

    if (quality === 'high') {
      // N8AO：复用 composer 的深度纹理（needsDepthTexture），半分辨率 + 深度感知上采样 + 泊松降噪
      const ao = new N8AOPostPass(scene, camera, size.x, size.y)
      // 透明物体检测要每帧遍历整座城市场景，且开启后会把透明物体多画两遍：关掉
      ao.autoDetectTransparency = false
      const c = ao.configuration
      c.transparencyAware = false
      c.halfRes = true
      c.depthAwareUpsampling = true
      c.aoSamples = 16
      c.denoiseSamples = 8
      c.denoiseRadius = 12
      c.aoRadius = 2.0
      c.distanceFalloff = 1.0
      c.screenSpaceRadius = false
      c.gammaCorrection = false
      c.intensity = AO_GAIN * defaultGrade().ao
      // N8AO 的合成目标默认 8 位，首帧才按输入改类型（实测仍按 8 位分配）→ HDR 高光被截到 1、亮面整体变暗。
      // 构造时直接设成与 composer 一致的 HalfFloat
      ao.outputTargetInternal.texture.type = THREE.HalfFloatType
      this.n8ao = ao
      this.composer.addPass(ao)
    }

    this.bloom = new BloomEffect({
      blendFunction: BlendFunction.ADD, mipmapBlur: true, levels: 7,
      luminanceThreshold: 1.0, luminanceSmoothing: 0.01, intensity: 0.3 * BLOOM_GAIN, radius: 0.83,
    })
    // 亮度提取半分辨率（mipmap 链第一级本来就是一半，全分辨率提取只是多一次满屏填充）
    this.bloom.luminancePass.resolution.scale = 0.5
    if (quality === 'low') {
      // low 档泛光再减半：mipmap 链从 1/4 起步（同原 UnrealBloom low 档的半分辨率），亮度提取随之 1/4
      const orig = this.bloom.setSize.bind(this.bloom)
      this.bloom.setSize = (w: number, h: number) => orig(Math.max(1, Math.round(w / 2)), Math.max(1, Math.round(h / 2)))
    }
    this.grade = new ReaGradeEffect()
    this.toneMap = new ToneMappingEffect({ mode: ToneMappingMode.AGX })
    if (quality === 'high') this.initCine(camera)
    this.builtCine = this.cineActive()
    this.fxPass = this.makeFxPass(camera)
    this.composer.addPass(this.fxPass)
    this.setSize(this.w, this.h)
  }

  /** P13.3 光束 + P13.5 LUT 效果实例（只建一次；是否进 EffectPass 看 cine.on） */
  private initCine(camera: THREE.PerspectiveCamera) {
    // 光源：太阳盘。不加进任何场景（GodRaysEffect 渲染时把它放进自己的 lightScene，与深度比较后做径向模糊），
    // 因此不受雾、Sky 穹顶影响，也不会出现在城市画面里；楼挡住太阳时深度测试自然遮掉
    const disc = new THREE.Mesh(new THREE.CircleGeometry(1, 32), new THREE.MeshBasicMaterial({ color: 0xffffff, map: sunTexture(), fog: false, toneMapped: false }))
    disc.frustumCulled = false
    disc.matrixAutoUpdate = true
    this.sunMesh = disc
    const gr = new GodRaysEffect(camera, disc, {
      blendFunction: BlendFunction.ADD,
      samples: 48, density: 0.94, decay: 0.92, weight: 0.32, exposure: 0.5, clampMax: 1,
      resolutionScale: 0.5, blur: false,   // 光源本身是软光晕贴图，径向模糊后已足够平滑；Kawase 模糊实测 ≈0.75 ms，省掉
    })
    // 光源目标默认全分辨率（深度拷贝 + 光源绘制两次满屏填充）：改成与径向模糊相同的半分辨率
    const gs = gr.setSize.bind(gr), lt = (gr as unknown as { renderTargetLight: THREE.WebGLRenderTarget }).renderTargetLight
    gr.setSize = (w: number, h: number) => { gs(w, h); lt.setSize(gr.resolution.width, gr.resolution.height) }
    // 强度为 0（夜晚 / 背对太阳 / 竞技场 / cine 关）时整段跳过：不渲染光源、不做径向模糊
    const upd = gr.update.bind(gr)
    gr.update = (r, i, dt) => { if (this.raysOn) upd(r, i, dt) }
    gr.blendMode.opacity.value = 0
    this.godRays = gr

    // 同时只用一张 LUT（一次四面体插值）：混合纹理初始为单位 LUT，两张 .cube 加载后按昼夜权重在 CPU 上混合写入
    this.lutMix = LookupTexture.createNeutral(LUT_SIZE)
    this.lut = new LUT3DEffect(this.lutMix, { blendFunction: BlendFunction.NORMAL, tetrahedralInterpolation: true })
    this.lut.blendMode.opacity.value = 0
    const loader = new LUTCubeLoader()
    const load = (k: 'day' | 'night') => loader.load(LUT_URL[k], (t) => {
      const d = t.image.data as Float32Array
      if (t.image.width !== LUT_SIZE || d.length !== this.lutMix!.image.data!.length) { console.warn('[PostFX] LUT 尺寸不符', LUT_URL[k]); return }
      this.lutSrc[k] = d.slice(); t.dispose(); this.lutKey = -1
    }, undefined, () => console.warn('[PostFX] LUT 加载失败', LUT_URL[k]))
    load('day'); load('night')
  }

  /** 本期新效果是否进管线：high 档 + cine.on */
  private cineActive() { return this.quality === 'high' && cine.on && this.godRays !== null }

  private makeFxPass(camera: THREE.Camera) {
    const fx: Effect[] = [this.bloom, this.grade, this.toneMap]
    if (this.builtCine) fx.unshift(this.godRays!), fx.push(this.lut!)
    return new EffectPass(camera, ...fx)
  }

  /** cine.on 运行时切换：换一个 EffectPass（效果实例复用，不释放） */
  private rebuildFxPass() {
    this.builtCine = this.cineActive()
    const old = this.fxPass
    this.composer.removePass(old)
    // 解除旧 pass 对效果 change 事件的监听，只释放它自己的全屏材质
    ;(old as unknown as { setEffects(e: Effect[]): void }).setEffects([])
    old.fullscreenMaterial.dispose()
    this.fxPass = this.makeFxPass(this.camera)
    this.composer.addPass(this.fxPass)
    this.setSize(this.w, this.h)
    if (!this.builtCine) this.resetCineUniforms()
  }

  private resetCineUniforms() {
    this.grade.set('uLens', 0); this.grade.set('uSpeedBlur', 0)
    this.raysOn = false
  }

  /**
   * P13.3/13.4 每帧输入（Game 在 setGrade 前调用）：太阳方向光（取 position − target 作方向、color 作色）与车速（m/s，步行 0）。
   * 不调用时光束 / 鬼影按默认朝上的太阳计算（基本看不到），不会出错。
   */
  setCine(sun: THREE.DirectionalLight, speed: number) {
    this.sunDir.copy(sun.position).sub(sun.target.position).normalize()
    this.sunCol.copy(sun.color)
    this.speed = Math.abs(speed)
  }

  /** 每帧按太阳与相机更新光束 / 鬼影 / 速度模糊 / LUT 参数（setGrade 内调用） */
  private updateCine(g: GradeParams) {
    const city = this.scene === this.baseScene
    if (!this.builtCine || !city) {
      this.resetCineUniforms()
      if (this.lut) this.lut.blendMode.opacity.value = 0
      return
    }
    const cam = this.camera
    const view = cam.getWorldDirection(this.tmpV)
    const facing = view.dot(this.sunDir)
    // 太阳贴地平线以下渐隐（夜里 DayNight 的方向光是月亮，靠 g.rays = 0 关掉）
    const up = smoothstep(-0.02, 0.06, this.sunDir.y)
    const rays = Math.max(0, g.rays) * up * cine.rays * smoothstep(0.05, 0.75, facing)
    // 光束：太阳盘放到相机前方远处，正对相机
    const disc = this.sunMesh!, gr = this.godRays!
    const dist = cam.far * SUN_DIST
    disc.position.copy(cam.position).addScaledVector(this.sunDir, dist)
    disc.scale.setScalar(dist * Math.tan(SUN_ANG))
    disc.lookAt(cam.position)
    // 太阳色归一到亮度 1：光束颜色跟随日出日落的暖色，强度只由 rays 决定
    const l = Math.max(1e-3, 0.2126 * this.sunCol.r + 0.7152 * this.sunCol.g + 0.0722 * this.sunCol.b)
    disc.material.color.copy(this.sunCol).multiplyScalar(1 / l)
    this.raysOn = rays > 0.003
    gr.blendMode.opacity.value = rays
    // 镜头鬼影：只要太阳在屏幕附近且「有太阳」（rays > 0，白天）就出现，强度随朝向
    const lens = smoothstep(0, 0.08, g.rays) * up * cine.lens * smoothstep(0.55, 0.85, facing)
    this.grade.set('uLens', lens)
    if (lens > 0) {
      const p = this.tmpV2.copy(cam.position).addScaledVector(this.sunDir, dist).project(cam)
      ;(this.grade.uniforms.get('uSunUv')!.value as THREE.Vector2).set(p.x * 0.5 + 0.5, p.y * 0.5 + 0.5)
      this.grade.color('uSunCol').copy(disc.material.color)
    }
    // 边缘速度模糊：50 km/h 起，≈135 km/h 满
    this.grade.set('uSpeedBlur', smoothstep(14, 38, this.speed) * 0.7 * cine.blur)
    // LUT：不透明度 = 两张权重之和；昼夜比例变化 ≥1/64 时才重混纹理（只在晨昏过渡时发生）
    const wd = Math.max(0, g.lutDay), wn = Math.max(0, g.lutNight), sum = wd + wn
    this.lut!.blendMode.opacity.value = Math.min(1, sum * cine.lut)
    const { day, night } = this.lutSrc
    if (day && night && sum > 1e-4) {
      const k = Math.round((wn / sum) * 64)
      if (k !== this.lutKey) {
        this.lutKey = k
        const t = k / 64, out = this.lutMix!.image.data as Float32Array
        for (let i = 0; i < out.length; i++) out[i] = day[i] + (night[i] - day[i]) * t
        this.lutMix!.needsUpdate = true
      }
    }
  }

  /** 后期分辨率倍率：low 档在高 DPI 屏封顶 1.25×（手机/视网膜屏省填充率），high 档跟随 renderer */
  private pixelRatio() {
    const pr = this.renderer.getPixelRatio()
    return this.quality === 'low' ? Math.min(pr, LOW_MAX_PR) : pr
  }

  setSize(w: number, h: number) {
    this.w = w; this.h = h
    // composer.setSize 按 renderer 的绘制缓冲尺寸（renderer 像素比）分配
    this.composer.setSize(w, h)
    const pr = this.pixelRatio()
    if (pr < this.renderer.getPixelRatio()) {
      // low 档封顶：中间缓冲与各 pass 按封顶倍率重设，最后 EffectPass 输出到画布时拉伸
      const bw = Math.max(1, Math.round(w * pr)), bh = Math.max(1, Math.round(h * pr))
      this.composer.inputBuffer.setSize(bw, bh)
      this.composer.outputBuffer.setSize(bw, bh)
      for (const p of this.composer.passes) p.setSize(bw, bh)
    }
  }

  /**
   * 切换渲染的场景 / 相机（P10.D 竞技场）：RenderPass、EffectPass 与 N8AO 同时换；调色 / 泛光参数不动（调用方自己 setGrade）。
   * near/far/投影矩阵每帧从 camera 读取。
   */
  setScene(scene: THREE.Scene, camera: THREE.PerspectiveCamera) {
    if (this.scene === scene && this.camera === camera) return
    this.scene = scene; this.camera = camera
    this.composer.setMainScene(scene)
    this.composer.setMainCamera(camera)
    if (this.n8ao) { this.n8ao.scene = scene; this.n8ao.camera = camera }
  }
  /** 恢复构造时的城市场景 / 相机 */
  resetScene() { this.setScene(this.baseScene, this.baseCamera) }
  get currentScene() { return this.scene }

  setBloom(strength: number, threshold?: number, radius?: number) {
    // 强度可为 0（不关 pass：关掉亮度提取会让 mipmap 链直接模糊整幅画面；切 SKIP 混合会触发重编译）
    this.bloom.intensity = Math.max(0, strength) * BLOOM_GAIN
    if (threshold !== undefined) this.bloom.luminanceMaterial.threshold = threshold
    // UnrealBloom 半径 0–1（大半径偏向粗 mip）→ mipmap 上采样混合系数
    if (radius !== undefined) this.bloom.mipmapBlurPass.radius = 0.78 + 0.1 * radius
  }

  setGrade(g: GradeParams) {
    const e = this.grade
    e.set('uContrast', g.contrast)
    e.set('uSaturation', g.saturation)
    e.color('uShadowTint').copy(g.shadowTint)
    e.color('uHighlightTint').copy(g.highlightTint)
    // P13.5：high 档开 LUT 时分离色调减弱
    e.set('uSplit', this.builtCine && cine.lut > 0 && this.scene === this.baseScene ? g.split * SPLIT_WITH_LUT : g.split)
    e.set('uVignette', g.vignette)
    e.set('uGrain', this.quality === 'high' ? g.grain : g.grain * 0.6)
    e.set('uChroma', g.chroma)
    if (this.n8ao) {
      // N8AO 改配置会重置时域累积：只在变化时写
      const k = Math.round(g.ao * AO_GAIN * 100) / 100
      if (k !== this.aoIntensity) { this.aoIntensity = k; this.n8ao.configuration.intensity = k }
      this.n8ao.enabled = k > 0.001
    }
    this.setBloom(g.bloom, g.bloomThreshold, g.bloomRadius)
    if (this.cineActive() !== this.builtCine) this.rebuildFxPass()
    if (this.godRays) this.updateCine(g)
  }

  render(dt: number) {
    const r = this.renderer
    // postprocessing 自己做色调映射：渲染期间 renderer 不做（曝光仍由 ToneMappingEffect 的 AgX 读 toneMappingExposure）
    const tm = r.toneMapping
    r.toneMapping = THREE.NoToneMapping
    // 多个 pass 各自调用 renderer.render：关掉自动清零，让 info 统计整帧（场景 + 后期）
    const info = r.info
    info.autoReset = false
    info.reset()
    this.composer.render(dt)
    info.autoReset = true
    r.toneMapping = tm
  }

  dispose() {
    // composer.dispose 会逐个释放 pass（含 N8AO、EffectPass 内的各效果）
    this.composer.dispose()
    // cine 关时光束 / LUT 不在 EffectPass 里，单独释放
    if (!this.builtCine) { this.godRays?.dispose(); this.lut?.dispose() }
    this.lutMix?.dispose()
    this.sunMesh?.geometry.dispose(); this.sunMesh?.material.map?.dispose(); this.sunMesh?.material.dispose()
  }
}
