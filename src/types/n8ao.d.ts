/** n8ao 2.x 不带类型声明：只声明 PostFX 用到的部分 */
declare module 'n8ao' {
  import type { Camera, Color, Scene, WebGLRenderTarget } from 'three'
  import { Pass } from 'postprocessing'

  export interface N8AOConfiguration {
    aoSamples: number
    aoRadius: number
    aoTones: number
    denoiseSamples: number
    denoiseRadius: number
    denoiseIterations: number
    distanceFalloff: number
    intensity: number
    renderMode: 0 | 1 | 2 | 3 | 4
    biasOffset: number
    biasMultiplier: number
    color: Color
    gammaCorrection: boolean
    screenSpaceRadius: boolean
    halfRes: boolean
    depthAwareUpsampling: boolean
    colorMultiply: boolean
    transparencyAware: boolean
    accumulate: boolean
    neuralDenoise: boolean
  }

  export class N8AOPostPass extends Pass {
    constructor(scene: Scene, camera: Camera, width?: number, height?: number)
    scene: Scene
    camera: Camera
    configuration: N8AOConfiguration
    /** 每帧遍历场景找透明材质；大场景要关掉 */
    autoDetectTransparency: boolean
    /** 合成输出目标（类型需与 composer 帧缓冲一致） */
    outputTargetInternal: WebGLRenderTarget
    setQualityMode(mode: 'Performance' | 'Low' | 'Medium' | 'High' | 'Ultra'): void
  }
}
