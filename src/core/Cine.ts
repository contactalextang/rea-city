/**
 * P13.3–P13.6 电影化镜头效果的总开关与强度（仅 fx=high 的城市场景生效；low/off 与竞技场不受影响）。
 * `?cine=0` 一键关闭本期全部新效果（丁达尔光束 / 镜头鬼影 / 手持晃动 / 速度 FOV / 速度模糊 / 胶片 LUT）；默认开。
 * 运行时调试：`__game.fx.cine.rays = 0`、`__game.fx.cine.on = false` 等（强度是倍率，0 = 关）。
 */
export interface CineFlags {
  /** 总开关：关掉时 PostFX 重建不含新效果的 EffectPass（性能对比用） */
  on: boolean
  /** 丁达尔光束强度倍率 */
  rays: number
  /** 镜头鬼影 + 宽银幕拉丝强度倍率 */
  lens: number
  /** 胶片 LUT 强度倍率 */
  lut: number
  /** 手持晃动倍率 */
  shake: number
  /** 速度 FOV 倍率（0 = 固定 62°） */
  fov: number
  /** 边缘速度模糊倍率 */
  blur: number
}

function parseCine(): boolean {
  if (typeof location === 'undefined') return true
  const v = new URLSearchParams(location.search).get('cine')
  return !(v === '0' || v === 'false' || v === 'off' || v === 'no')
}

export const cine: CineFlags = { on: parseCine(), rays: 1, lens: 1, lut: 1, shake: 1, fov: 1, blur: 1 }
