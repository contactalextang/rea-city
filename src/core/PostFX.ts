import * as THREE from 'three'
import { BlendFunction, BloomEffect, Effect, EffectAttribute, EffectComposer, EffectPass, RenderPass, ToneMappingEffect, ToneMappingMode } from 'postprocessing'
import { N8AOPostPass } from 'n8ao'

/**
 * 后期管线（pmndrs/postprocessing，线性 HDR → AgX）：
 *   EffectComposer（HalfFloat + MSAA×4）→ RenderPass → N8AO（半分辨率 + 降噪，仅 high；直接乘进画面）
 *   → 一个 EffectPass，按顺序合并成一次全屏绘制：
 *       Bloom（mipmap 模糊，阈值≈1 只抓 HDR 发光体；low 档半分辨率）
 *       → ReaGradeEffect（线性空间：对比/饱和/分离色调/暗角/胶片颗粒/边缘色差）
 *       → ToneMapping AgX（读 renderer.toneMappingExposure）→ sRGB 输出（postprocessing 默认流程）。
 * 后续效果（GodRays / 镜头鬼影 / LUT）都往这个 EffectPass 里按顺序插，不再新增全屏 pass。
 * postprocessing 要求渲染期间 renderer.toneMapping = NoToneMapping：render() 内临时切换、结束恢复，
 * DayNight / ArenaMode 对 renderer.toneMapping 的赋值不动（fx=off 直出仍用它）。
 * 抗锯齿用渲染目标 MSAA×4（几何边缘最干净、无额外 pass），不再叠 SMAA。
 * fx=off 时 Game 不调用本类，直接 renderer.render（仍有 AgX 与 environment）。
 */
import type { FxQuality } from './Settings'
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
}

export function defaultGrade(): GradeParams {
  return {
    contrast: 1.05, saturation: 1.1, shadowTint: new THREE.Color(1, 1, 1), highlightTint: new THREE.Color(1, 1, 1), split: 0,
    vignette: 0.2, grain: 0.02, chroma: 0.6, bloom: 0.2, bloomThreshold: 1.2, bloomRadius: 0.5, ao: 0.6,
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

  float gLuma(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }
  float gHash(vec2 p) { p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }
  vec3 gNormTint(vec3 t) { return t / max(gLuma(t), 1e-3); }

  void mainImage(const in vec4 inputColor, const in vec2 uv, out vec4 outputColor) {
    vec2 d = uv - 0.5;
    float r2 = dot(d, d);
    // 边缘色差：R/B 沿径向反向偏移，中心为 0
    vec3 c = inputColor.rgb;
    if (uChroma > 0.0) {
      vec2 off = d * r2 * 4.0 * uChroma / resolution;
      vec3 base = texture2D(inputBuffer, uv).rgb;
      c.r += texture2D(inputBuffer, uv + off).r - base.r;
      c.b += texture2D(inputBuffer, uv - off).b - base.b;
    }
    c = max(c, 0.0);

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
      attributes: EffectAttribute.CONVOLUTION,
      uniforms: new Map<string, THREE.Uniform>([
        ['uContrast', new THREE.Uniform(1)],
        ['uSaturation', new THREE.Uniform(1)],
        ['uShadowTint', new THREE.Uniform(new THREE.Color(1, 1, 1))],
        ['uHighlightTint', new THREE.Uniform(new THREE.Color(1, 1, 1))],
        ['uSplit', new THREE.Uniform(0)],
        ['uVignette', new THREE.Uniform(0)],
        ['uGrain', new THREE.Uniform(0)],
        ['uChroma', new THREE.Uniform(0)],
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

export class PostFX {
  readonly composer: EffectComposer
  private renderPass: RenderPass
  private n8ao: N8AOPostPass | null = null
  private bloom: BloomEffect
  private grade: ReaGradeEffect
  private toneMap: ToneMappingEffect
  private fxPass: EffectPass
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
    this.fxPass = new EffectPass(camera, this.bloom, this.grade, this.toneMap)
    this.composer.addPass(this.fxPass)
    this.setSize(this.w, this.h)
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
    e.set('uSplit', g.split)
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
  }
}
