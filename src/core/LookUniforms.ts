import * as THREE from 'three'

/**
 * 画面质感共享 uniform：DayNight 每帧写入，角色材质（CharacterMaterial）与招牌文字（Signage）读取。
 * 放在独立文件里，避免 systems/ 与 characters/ 互相依赖。
 */
export const LOOK = {
  /** 角色菲涅尔边缘光颜色（夜间偏霓虹青/品红，白天偏天空色） */
  uRimColor: { value: new THREE.Color(0x9fc8ff) },
  /** 边缘光强度（白天约 0.15，夜间约 0.8） */
  uRimStrength: { value: 0.15 },
  /** 夜间招牌自发光开启度 0–1（= DayNight.lights；Signage 文字材质读取，按每实例 aGlow 加权） */
  uSignGlow: { value: 0 },
}
