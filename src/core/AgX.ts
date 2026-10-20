import * as THREE from 'three'

/**
 * three.js AgXToneMapping 的 CPU 版（与 tonemapping_pars_fragment 一致，输入输出均为线性 sRGB），
 * 以及数值反解：给定想在屏幕上看到的颜色，求送进 AgX 前应有的 HDR 颜色。
 * 用途：后期管线里天空背景/雾色会经过 AgX（直出时不会），DayNight 用反解让两种模式的天空色一致、不发灰。
 */
const SRGB_TO_2020 = [0.6274, 0.3293, 0.0433, 0.0691, 0.9195, 0.0113, 0.0164, 0.0880, 0.8956]
const R2020_TO_SRGB = [1.6605, -0.5876, -0.0728, -0.1246, 1.1329, -0.0083, -0.0182, -0.1006, 1.1187]
const INSET = [0.856627153315983, 0.0951212405381588, 0.0482516061458583, 0.137318972929847, 0.761241990602591, 0.101439036467562, 0.11189821299995, 0.0767994186031903, 0.811302368396859]
const OUTSET = [1.1271005818144368, -0.11060664309660323, -0.016493938717834573, -0.1413297634984383, 1.157823702216272, -0.016493938717834257, -0.14132976349843826, -0.11060664309660294, 1.2519364065950405]
const MIN_EV = -12.47393, MAX_EV = 4.026069

/** 行主序 3×3 乘向量（就地） */
function mul(m: number[], v: number[]) {
  const x = v[0], y = v[1], z = v[2]
  v[0] = m[0] * x + m[1] * y + m[2] * z
  v[1] = m[3] * x + m[4] * y + m[5] * z
  v[2] = m[6] * x + m[7] * y + m[8] * z
}
const sigmoid = (x: number) => { const x2 = x * x, x4 = x2 * x2; return 15.5 * x4 * x2 - 40.14 * x4 * x + 31.96 * x4 - 6.868 * x2 * x + 0.4298 * x2 + 0.1191 * x - 0.00232 }
const v = [0, 0, 0]

export function agx(c: THREE.Color, exposure: number, out: THREE.Color): THREE.Color {
  v[0] = c.r * exposure; v[1] = c.g * exposure; v[2] = c.b * exposure
  mul(SRGB_TO_2020, v); mul(INSET, v)
  for (let i = 0; i < 3; i++) {
    const l = (Math.log2(Math.max(v[i], 1e-10)) - MIN_EV) / (MAX_EV - MIN_EV)
    v[i] = sigmoid(Math.min(1, Math.max(0, l)))
  }
  mul(OUTSET, v)
  for (let i = 0; i < 3; i++) v[i] = Math.pow(Math.max(0, v[i]), 2.2)
  mul(R2020_TO_SRGB, v)
  return out.setRGB(Math.min(1, Math.max(0, v[0])), Math.min(1, Math.max(0, v[1])), Math.min(1, Math.max(0, v[2])), THREE.LinearSRGBColorSpace)
}

const tmp = new THREE.Color()
/** 反解：求 x 使 agx(x, exposure) ≈ target（逐通道乘性迭代，结果夹在 [0, 64]） */
export function agxInverse(target: THREE.Color, exposure: number, out: THREE.Color, iters = 8): THREE.Color {
  out.copy(target)
  for (let k = 0; k < iters; k++) {
    agx(out, exposure, tmp)
    out.r = Math.min(64, out.r * Math.pow(Math.max(target.r, 1e-4) / Math.max(tmp.r, 1e-4), 1.6))
    out.g = Math.min(64, out.g * Math.pow(Math.max(target.g, 1e-4) / Math.max(tmp.g, 1e-4), 1.6))
    out.b = Math.min(64, out.b * Math.pow(Math.max(target.b, 1e-4) / Math.max(tmp.b, 1e-4), 1.6))
  }
  return out
}
