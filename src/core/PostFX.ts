import * as THREE from 'three'
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js'
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js'
import { GTAOPass } from 'three/examples/jsm/postprocessing/GTAOPass.js'
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js'
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js'
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js'

/**
 * 后期管线（线性 HDR → AgX）：
 *   RenderPass（HalfFloat + MSAA×4）→ GTAO（半分辨率，仅 high；只算 AO 图，在调色里相乘）
 *   → UnrealBloom（阈值≈1 只抓 HDR 发光体；low 档半分辨率）→ 调色 ShaderPass（线性空间：对比/饱和/分离色调/
 *   AO/暗角/胶片颗粒/边缘色差）→ OutputPass（renderer.toneMapping=AgX + sRGB）。
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

const GradeShader = {
  name: 'ReaGradeShader',
  uniforms: {
    tDiffuse: { value: null as THREE.Texture | null },
    tAO: { value: null as THREE.Texture | null },
    uAO: { value: 0 },
    uResolution: { value: new THREE.Vector2(1, 1) },
    uTime: { value: 0 },
    uContrast: { value: 1 },
    uSaturation: { value: 1 },
    uShadowTint: { value: new THREE.Color(1, 1, 1) },
    uHighlightTint: { value: new THREE.Color(1, 1, 1) },
    uSplit: { value: 0 },
    uVignette: { value: 0 },
    uGrain: { value: 0 },
    uChroma: { value: 0 },
  },
  vertexShader: /* glsl */`
    varying vec2 vUv;
    void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
  fragmentShader: /* glsl */`
    uniform sampler2D tDiffuse;
    uniform sampler2D tAO;
    uniform float uAO;
    uniform vec2 uResolution;
    uniform float uTime;
    uniform float uContrast, uSaturation, uSplit, uVignette, uGrain, uChroma;
    uniform vec3 uShadowTint, uHighlightTint;
    varying vec2 vUv;

    float luma(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }
    float hash(vec2 p) { p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }
    vec3 normTint(vec3 t) { return t / max(luma(t), 1e-3); }

    void main() {
      vec2 d = vUv - 0.5;
      float r2 = dot(d, d);
      // 边缘色差：R/B 沿径向反向偏移，中心为 0
      vec2 off = d * r2 * 4.0 * uChroma / uResolution;
      vec3 c;
      c.g = texture2D(tDiffuse, vUv).g;
      c.r = texture2D(tDiffuse, vUv + off).r;
      c.b = texture2D(tDiffuse, vUv - off).b;
      #ifdef USE_AO
        float ao = texture2D(tAO, vUv).r;
        c *= mix(1.0, ao, uAO);
      #endif
      c = max(c, 0.0);

      // 对比：对数空间以中灰为支点（HDR 友好，不裁剪高光）
      float l = luma(c);
      float lc = 0.18 * pow(max(l, 1e-5) / 0.18, uContrast);
      c *= lc / max(l, 1e-5);
      l = lc;
      // 饱和
      c = max(mix(vec3(l), c, uSaturation), 0.0);
      // 分离色调：按对数亮度在暗部/亮部色相之间插值，保持亮度
      float t = smoothstep(-3.5, 0.5, log2(max(l, 1e-5) / 0.18));
      vec3 tint = mix(normTint(uShadowTint), normTint(uHighlightTint), t);
      c *= mix(vec3(1.0), tint, uSplit);
      // 暗角
      float v = 1.0 - uVignette * smoothstep(0.08, 0.55, r2 * 1.6);
      c *= v;
      // 胶片颗粒（每帧变化，按亮度比例 + 暗部保底，避免黑处纯黑噪点）
      float n = hash(vUv * uResolution + fract(uTime * 13.37) * 371.0) - 0.5;
      c += n * uGrain * (sqrt(l) * 0.6 + 0.02);
      gl_FragColor = vec4(max(c, 0.0), 1.0);
    }`,
}

export class PostFX {
  readonly composer: EffectComposer
  private renderPass: RenderPass
  private gtao: GTAOPass | null = null
  private bloom: UnrealBloomPass
  private grade: ShaderPass
  private output: OutputPass
  private time = 0
  private w = 1; private h = 1

  constructor(private renderer: THREE.WebGLRenderer, scene: THREE.Scene, camera: THREE.PerspectiveCamera, readonly quality: Exclude<FxQuality, 'off'>) {
    const size = renderer.getSize(new THREE.Vector2())
    this.w = size.x; this.h = size.y
    const pr = renderer.getPixelRatio()
    const rt = new THREE.WebGLRenderTarget(Math.max(1, size.x * pr), Math.max(1, size.y * pr), { type: THREE.HalfFloatType, samples: 4 })
    // high：渲染目标带深度纹理，GTAO 直接复用（不再额外渲染一遍法线/深度）
    if (quality === 'high') rt.depthTexture = new THREE.DepthTexture(1, 1)
    rt.texture.name = 'PostFX.rt'
    this.composer = new EffectComposer(renderer, rt)
    this.renderPass = new RenderPass(scene, camera)
    this.composer.addPass(this.renderPass)

    if (quality === 'high') {
      const g = new GTAOPass(scene, camera, Math.max(1, size.x * pr / 2), Math.max(1, size.y * pr / 2))
      g.output = GTAOPass.OUTPUT.Off
      g.needsSwap = false
      g.updateGtaoMaterial({ radius: 1.2, distanceExponent: 1.4, thickness: 1.2, scale: 1, samples: 12, distanceFallOff: 1, screenSpaceRadius: false })
      g.updatePdMaterial({ lumaPhi: 10, depthPhi: 2, normalPhi: 3, radius: 6, rings: 2, samples: 12 })
      // 半分辨率：composer.setSize 传全分辨率进来，这里减半
      const orig = g.setSize.bind(g)
      g.setSize = (w: number, h: number) => orig(Math.max(1, Math.round(w / 2)), Math.max(1, Math.round(h / 2)))
      this.gtao = g
      this.composer.addPass(g)
    }

    this.bloom = new UnrealBloomPass(new THREE.Vector2(size.x * pr, size.y * pr), 0.3, 0.5, 1.0)
    if (quality === 'low') {
      const orig = this.bloom.setSize.bind(this.bloom)
      this.bloom.setSize = (w: number, h: number) => orig(Math.max(1, Math.round(w / 2)), Math.max(1, Math.round(h / 2)))
    }
    this.composer.addPass(this.bloom)

    this.grade = new ShaderPass(GradeShader)
    if (this.gtao) {
      this.grade.material.defines.USE_AO = ''
      this.grade.uniforms.tAO.value = this.gtao.gtaoMap
    }
    this.composer.addPass(this.grade)

    this.output = new OutputPass()
    this.composer.addPass(this.output)
    this.setSize(this.w, this.h)
  }

  setSize(w: number, h: number) {
    this.w = w; this.h = h
    this.composer.setPixelRatio(this.renderer.getPixelRatio())
    this.composer.setSize(w, h)
    const pr = this.renderer.getPixelRatio()
    this.grade.uniforms.uResolution.value.set(w * pr, h * pr)
  }

  setBloom(strength: number, threshold?: number, radius?: number) {
    this.bloom.strength = strength
    this.bloom.enabled = strength > 0.001
    if (threshold !== undefined) this.bloom.threshold = threshold
    if (radius !== undefined) this.bloom.radius = radius
  }

  setGrade(g: GradeParams) {
    const u = this.grade.uniforms
    u.uContrast.value = g.contrast
    u.uSaturation.value = g.saturation
    ;(u.uShadowTint.value as THREE.Color).copy(g.shadowTint)
    ;(u.uHighlightTint.value as THREE.Color).copy(g.highlightTint)
    u.uSplit.value = g.split
    u.uVignette.value = g.vignette
    u.uGrain.value = this.quality === 'high' ? g.grain : g.grain * 0.6
    u.uChroma.value = g.chroma
    u.uAO.value = g.ao
    this.setBloom(g.bloom, g.bloomThreshold, g.bloomRadius)
  }

  render(dt: number) {
    this.time += dt
    this.grade.uniforms.uTime.value = this.time
    // GTAO 读取本帧 RenderPass 写入的那张 RT 的深度（composer 读写缓冲每帧会交换）
    if (this.gtao) {
      const dtex = this.composer.readBuffer.depthTexture
      if (dtex && this.gtao.depthTexture !== dtex) this.gtao.setGBuffer(dtex)
    }
    // 多个 pass 各自调用 renderer.render：关掉自动清零，让 info 统计整帧（场景 + 后期）
    const info = this.renderer.info
    info.autoReset = false
    info.reset()
    this.composer.render(dt)
    info.autoReset = true
  }

  dispose() {
    this.gtao?.dispose()
    this.bloom.dispose()
    this.grade.material.dispose()
    this.output.dispose()
    this.composer.dispose()
  }
}
