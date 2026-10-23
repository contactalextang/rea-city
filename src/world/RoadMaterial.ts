import * as THREE from 'three'
import { patchAsphalt } from './StreetShaders'

/**
 * 路面材质（沥青）：MeshStandardMaterial，干燥 roughness 0.9、metalness 0。
 * 湿地反光由 Weather 每帧驱动：降 roughness、给显式 envMap 抬 envMapIntensity，
 * 再加一项便宜的菲涅尔"天光"（(1-N·V)³ 加权叠加 uWetSheen 色，近似反射天空/雾色，不做 SSR）。
 * 共享 uniform：所有路面材质同一份，Weather 写一次即可。
 * P14.3：沥青细节与湿度遮罩见 StreetShaders.patchAsphalt（世界坐标多尺度噪声 + 油污/车辙 + 积水场）；
 * 湿度由 STREET_UNIFORMS.uStreetWet 驱动，材质 color/roughness 保持干燥基准（userData.streetWet 标记，Weather 不再整片改）。
 */
export const ROAD_UNIFORMS = {
  /** 菲涅尔叠加色（线性 HDR，已乘湿度）；干燥时为 0 */
  uWetSheen: { value: new THREE.Color(0, 0, 0) },
}

/** 白天 AgX + 对比 1.2 下呈深灰（原 0x3b3b41 几乎压成纯黑） */
export const ROAD_COLOR = 0x5c5c62
export const ROAD_ROUGH_DRY = 0.9
export const ROAD_ROUGH_WET = 0.25

export function makeRoadMaterial(params: THREE.MeshStandardMaterialParameters = {}): THREE.MeshStandardMaterial {
  const m = new THREE.MeshStandardMaterial({ color: ROAD_COLOR, roughness: ROAD_ROUGH_DRY, metalness: 0, ...params })
  // DayNight.applyShadowFlags 只给 Lambert 自动开接收阴影；路面显式标记
  m.userData.receiveShadow = true
  m.userData.streetWet = true
  m.onBeforeCompile = (sh) => {
    patchAsphalt(sh)
    sh.uniforms.uWetSheen = ROAD_UNIFORMS.uWetSheen
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform vec3 uWetSheen;')
      // 路面网格绕序朝下，DoubleSide 会把法线翻成 -Y（只吃半球地面色、太阳照不亮）；路面恒水平，直接用世界 +Y
      .replace('#include <normal_fragment_begin>', '#include <normal_fragment_begin>\nnormal = normalize((viewMatrix * vec4(0.0, 1.0, 0.0, 0.0)).xyz);\nnonPerturbedNormal = normal;')
      .replace('#include <opaque_fragment>', `
        {
          float fr = 1.0 - saturate(dot(normal, normalize(vViewPosition)));
          // 天光只出现在积水（全量）与水膜（部分）上：局部镜面而非整片湿
          outgoingLight += uWetSheen * (fr * fr * fr) * max(sWet.y, sWet.z * 0.35 + sWet.x * 0.2);
        }
        #include <opaque_fragment>`)
  }
  m.customProgramCacheKey = () => 'rea-road-p143'
  return m
}
