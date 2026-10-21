import * as THREE from 'three'
import { Sky } from 'three/examples/jsm/objects/Sky.js'
import { CSM } from 'three/examples/jsm/csm/CSM.js'

/**
 * P13 大气（只在 fx=high 生效，由 DayNight 驱动）：
 *
 * 1. 全局着色器片段补丁（模块首次 install 时一次性改 THREE.ShaderChunk，所有内置/onBeforeCompile 材质自动生效）：
 *    - 雾：fog_* 片段加一个世界空间相对相机的 varying；`reaFogParams.w > 0.5` 时走指数高度雾 + 太阳方向内散射，
 *      否则逐字节保持原线性雾公式。开关是共享 uniform（不是 define），切档不重编译；DayNight 只在渲染城市场景期间打开，
 *      竞技场等其它场景渲染时自动是原公式。
 *    - 级联阴影：lights_fragment_begin 的方向光段加一个分支——方向光恰好 3 盏且都投影（= CSM 三级）时，
 *      只算第 0 盏的直射光，阴影按"片元落在哪一级阴影图里"选最细的一级（各级边缘 6% 区间线性混合，最后一级向外淡出），
 *      不依赖每材质 uniform。其余情况（竞技场 1 盏太阳、low/off、阴影关）走原循环。
 *    共享 uniform 用不带 isVector 标记的普通对象 {x,y,z,w}：UniformsUtils.clone 对它只拷引用，所以所有材质读的是同一份活数据。
 *
 * 2. SkyDome：three 的 Preetham Sky（含程序云），片元末尾与 DayNight 色表混合（色表主导：夜晚/暴雨/闪电时物理天空权重→0），
 *    地平线附近渐变到雾的内散射色（远楼淡出与天空无缝）；另提供 PMREM 烘焙成 scene.environment（按时段节流）。
 *
 * 3. CsmShadows：three 的 CSM（3 级、maxFar 350、practical 分割 λ=0.75、每级 2048）。只用它的灯光/分割/包围盒拟合，
 *    不调用 setupMaterial：它会覆盖材质自己的 onBeforeCompile（角色/路面/车辆/招牌都有），且任何漏挂的材质会被 3 盏灯照三遍；
 *    级别选择改在全局 lights 片段里按阴影坐标做，所有材质（含后加载的分块、角色共享 program）零改动即生效。
 *    阴影图分级刷新：近级每帧、中级隔帧、远级每 4 帧（schedule）；同一显示帧里城市场景被渲染多次（AO pass）时只画一次。
 */

/** 雾/天空共享的活 uniform（普通对象 → 所有材质共享同一引用） */
export const ATMO = {
  /** 指向太阳的世界方向（雾内散射用） */
  sun: { x: 0, y: 1, z: 0 },
  /** 朝太阳方向雾的增亮倍率（rgb，0 = 无） */
  scatter: { x: 0, y: 0, z: 0 },
  /** x 高度衰减 1/m，y 保留，z 背光偏冷强度，w 模式（0 原线性雾，1 高度雾+内散射） */
  params: { x: 0, y: 0, z: 0, w: 0 },
}

/** 调试/调参开关（控制台 window.__atmo）：sky 物理天空、env 天空环境图、csm 级联阴影、envGain 环境图增益 */
export const ATMO_OPTS = { sky: true, env: true, csm: true, fog: true, envGain: 1.0, skyMesh: true, groundK: 1.2, envSat: 0.15 }
/** 调试：DayNight 写入当前实例 */
export const ATMO_DEBUG: { csm: unknown; sky: unknown; renderer: unknown } = { csm: null, sky: null, renderer: null }
if (typeof window !== 'undefined') (window as unknown as { __atmo: unknown }).__atmo = { ATMO, opts: ATMO_OPTS, debug: ATMO_DEBUG }

/** 级联数：同时也是着色器里识别"CSM 场景"的方向光数量 */
export const CSM_CASCADES = 3

const FOG_TINT_GLSL = /* glsl */`
vec3 reaFogTint( vec3 fogC, vec3 dir ) {
	float s = max( dot( dir, reaFogSun ), 0.0 );
	float lobe = pow( s, 8.0 ) * 0.75 + s * s * 0.25;
	vec3 c = fogC * ( 1.0 + reaFogScatter * lobe );
	return mix( c, c * vec3( 0.9, 0.96, 1.08 ), reaFogParams.z * ( 1.0 - s ) );
}
`

let installed = false
/** 一次性改写着色器片段（必须在任何材质首次编译前调用；重复调用无副作用） */
export function installAtmosphereChunks() {
  if (installed) return
  installed = true
  const C = THREE.ShaderChunk as unknown as Record<string, string>
  const need = (src: string, s: string, name: string) => { if (!src.includes(s)) throw new Error(`[Atmosphere] three 片段 ${name} 已变化，找不到：${s}`) }

  // —— 雾 ——
  need(C.fog_vertex, 'vFogDepth = - mvPosition.z;', 'fog_vertex')
  need(C.fog_pars_vertex, 'varying float vFogDepth;', 'fog_pars_vertex')
  need(C.fog_pars_fragment, 'varying float vFogDepth;', 'fog_pars_fragment')
  need(C.fog_fragment, 'float fogFactor = smoothstep( fogNear, fogFar, vFogDepth );', 'fog_fragment')
  need(C.fog_fragment, 'gl_FragColor.rgb = mix( gl_FragColor.rgb, fogColor, fogFactor );', 'fog_fragment')
  C.fog_pars_vertex = C.fog_pars_vertex.replace('varying float vFogDepth;', 'varying float vFogDepth;\n\tvarying vec3 vReaFogRel;')
  C.fog_vertex = C.fog_vertex.replace('vFogDepth = - mvPosition.z;', 'vFogDepth = - mvPosition.z;\n\tvReaFogRel = ( vec4( mvPosition.xyz, 0.0 ) * viewMatrix ).xyz;')
  C.fog_pars_fragment = C.fog_pars_fragment.replace('varying float vFogDepth;', `varying float vFogDepth;
	varying vec3 vReaFogRel;
	uniform vec3 reaFogSun;
	uniform vec3 reaFogScatter;
	uniform vec4 reaFogParams;
	${FOG_TINT_GLSL}`)
  C.fog_fragment = C.fog_fragment
    .replace('float fogFactor = smoothstep( fogNear, fogFar, vFogDepth );', /* glsl */`float fogFactor = smoothstep( fogNear, fogFar, vFogDepth );
		vec3 reaFogC = fogColor;
		if ( reaFogParams.w > 0.5 ) {
			// 指数高度雾：沿视线对 exp(-b·y) 积分求平均密度 H（地面 = 1），距离用真实距离；
			// 地面附近按 exp² 拟合原 smoothstep(near, far) 曲线（地面观感与原雾一致），雾距末端仍强制全雾（遮住区块加载边缘）
			float reaD = length( vReaFogRel );
			vec3 reaDir = vReaFogRel / max( reaD, 1e-4 );
			float reaB = reaFogParams.x;
			float reaBy = reaB * vReaFogRel.y;
			float reaH = exp( - reaB * max( cameraPosition.y, 0.0 ) ) * ( abs( reaBy ) > 1e-3 ? ( 1.0 - exp( - reaBy ) ) / reaBy : 1.0 );
			float reaX = max( reaD - fogNear, 0.0 ) / max( fogFar - fogNear, 1.0 );
			float reaOd = 1.75 * reaX * min( reaH, 1.5 );
			fogFactor = max( 1.0 - exp( - reaOd * reaOd ), smoothstep( 0.7, 1.0, reaX ) );
			reaFogC = reaFogTint( fogColor, reaDir );
		}`)
    .replace('gl_FragColor.rgb = mix( gl_FragColor.rgb, fogColor, fogFactor );', /* glsl */`#ifdef FOG_EXP2
		gl_FragColor.rgb = mix( gl_FragColor.rgb, fogColor, fogFactor );
	#else
		gl_FragColor.rgb = mix( gl_FragColor.rgb, reaFogC, fogFactor );
	#endif`)
  // 内置材质的 uniform 模板加上共享引用（getUniforms 时 clone：普通对象只拷引用）
  for (const k of Object.keys(THREE.ShaderLib)) {
    const u = (THREE.ShaderLib as Record<string, { uniforms: Record<string, THREE.IUniform> }>)[k].uniforms
    if (!u || !('fogColor' in u)) continue
    u.reaFogSun = { value: ATMO.sun }
    u.reaFogScatter = { value: ATMO.scatter }
    u.reaFogParams = { value: ATMO.params }
  }

  // —— 级联阴影 ——
  const head = '#if ( NUM_DIR_LIGHTS > 0 ) && defined( RE_Direct )'
  need(C.lights_fragment_begin, head, 'lights_fragment_begin')
  need(C.shadowmap_pars_fragment, '#if NUM_DIR_LIGHT_SHADOWS > 0', 'shadowmap_pars_fragment')
  const N = CSM_CASCADES
  const sh = (i: number) => `getShadow( directionalShadowMap[ ${i} ], directionalLightShadows[ ${i} ].shadowMapSize, directionalLightShadows[ ${i} ].shadowIntensity, directionalLightShadows[ ${i} ].shadowBias, directionalLightShadows[ ${i} ].shadowRadius, vDirectionalShadowCoord[ ${i} ] )`
  C.lights_fragment_begin = C.lights_fragment_begin.replace(head, /* glsl */`#if ( NUM_DIR_LIGHTS == ${N} ) && ( NUM_DIR_LIGHT_SHADOWS == ${N} ) && defined( RE_Direct ) && defined( USE_SHADOWMAP )

	// CSM：3 盏方向光是同一个太阳的三级阴影，直射光只算一次
	getDirectionalLightInfo( directionalLights[ 0 ], directLight );
	if ( directLight.visible && receiveShadow ) {
		float reaW0 = reaCsmIn( vDirectionalShadowCoord[ 0 ], 0.06 );
		float reaW1 = reaCsmIn( vDirectionalShadowCoord[ 1 ], 0.06 );
		float reaW2 = reaCsmIn( vDirectionalShadowCoord[ 2 ], 0.12 );
		float reaS = 1.0;
		if ( reaW0 > 0.999 ) {
			reaS = ${sh(0)};
		} else {
			if ( reaW1 > 0.999 ) {
				reaS = ${sh(1)};
			} else {
				if ( reaW2 > 0.001 ) reaS = mix( 1.0, ${sh(2)}, reaW2 );
				if ( reaW1 > 0.001 ) reaS = mix( reaS, ${sh(1)}, reaW1 );
			}
			if ( reaW0 > 0.001 ) reaS = mix( reaS, ${sh(0)}, reaW0 );
		}
		directLight.color *= reaS;
	}
	RE_Direct( directLight, geometryPosition, geometryNormal, geometryViewDir, geometryClearcoatNormal, material, reflectedLight );

#elif ( NUM_DIR_LIGHTS > 0 ) && defined( RE_Direct )`)
  C.shadowmap_pars_fragment = C.shadowmap_pars_fragment + /* glsl */`
#if defined( USE_SHADOWMAP ) && NUM_DIR_LIGHT_SHADOWS == ${N}
	// 片元在该级阴影图内的程度：0 = 图外，边缘 m（贴图宽度比例）内线性升到 1
	float reaCsmIn( vec4 sc, float m ) {
		vec3 p = sc.xyz / sc.w;
		vec2 d = min( p.xy, 1.0 - p.xy );
		float e = min( d.x, d.y );
		return ( p.z > 1.0 || p.z < 0.0 ) ? 0.0 : clamp( e / m, 0.0, 1.0 );
	}
#endif
`
}

// ——————————————————————————————————————————— 天空 ———————————————————————————————————————————

export class SkyDome {
  readonly mesh: Sky
  readonly uniforms: Record<string, THREE.IUniform>
  private envScene = new THREE.Scene()
  private envMesh: THREE.Mesh
  private pmrem: THREE.PMREMGenerator | null = null
  private envRT: THREE.WebGLRenderTarget | null = null
  private envKey = ''
  private envAt = -1e9

  constructor(fogColor: THREE.Color) {
    this.mesh = new Sky()
    this.mesh.name = 'sky'
    this.mesh.scale.setScalar(1e5)        // 着色器把深度钉在远平面；网格放远是为了在 overrideMaterial 渲染（AO 法线/深度）里被远裁剪掉
    this.mesh.frustumCulled = false
    this.mesh.renderOrder = 10000         // 不透明物体最后画：被楼挡住的像素靠 early-z 省掉
    const mat = this.mesh.material as THREE.ShaderMaterial
    const u = mat.uniforms
    u.turbidity.value = 3.2; u.rayleigh.value = 1.6; u.mieCoefficient.value = 0.005; u.mieDirectionalG.value = 0.8
    u.showSunDisc.value = 0          // 太阳盘自己加（限亮度）
    u.cloudCoverage.value = 0.35; u.cloudDensity.value = 0.45; u.cloudElevation.value = 0.55
    Object.assign(u, {
      fogColor: { value: fogColor },
      reaFogSun: { value: ATMO.sun }, reaFogScatter: { value: ATMO.scatter }, reaFogParams: { value: ATMO.params },
      uSkyColor: { value: new THREE.Color() },
      /** x 物理天空权重，y 渐变强度，z 地平线混雾高度，w 太阳盘强度 */
      uMix: { value: new THREE.Vector4() },
      /** x 环境烘焙模式（1 = 地平线下画地面），y 烘焙增益 */
      uEnv: { value: new THREE.Vector3(0, 1, 0.5) },
      uGround: { value: new THREE.Color(0x202020) },
      uSunCol: { value: new THREE.Color(1, 1, 1) },
    })
    let f = mat.fragmentShader
    const anchors = ['uniform float time;', 'void main() {', 'gl_FragColor = vec4( texColor, 1.0 );', 'float sundisc = clamp(']
    for (const a of anchors) if (!f.includes(a)) throw new Error('[SkyDome] Sky.js 着色器已变化，找不到：' + a)
    f = f.replace('uniform float time;', /* glsl */`uniform float time;
		uniform vec3 fogColor;
		uniform vec3 reaFogSun;
		uniform vec3 reaFogScatter;
		uniform vec4 reaFogParams;
		uniform vec3 uSkyColor;
		uniform vec4 uMix;
		uniform vec3 uEnv;
		uniform vec3 uGround;
		uniform vec3 uSunCol;
		${FOG_TINT_GLSL}`)
    // 参考方向（与太阳方位垂直、仰角 45°）的无云散射亮度：把物理天空的整体亮度归一到色表天空色的亮度
    f = f.replace('void main() {', /* glsl */`float reaPreethamLum( vec3 direction ) {
			float zenithAngle = acos( max( 0.0, direction.y ) );
			float inverse = 1.0 / ( cos( zenithAngle ) + 0.15 * pow( 93.885 - ( ( zenithAngle * 180.0 ) / pi ), -1.253 ) );
			vec3 Fex = exp( -( vBetaR * rayleighZenithLength * inverse + vBetaM * mieZenithLength * inverse ) );
			float cosTheta = dot( direction, vSunDirection );
			vec3 betaRTheta = vBetaR * rayleighPhase( cosTheta * 0.5 + 0.5 );
			vec3 betaMTheta = vBetaM * hgPhase( cosTheta, mieDirectionalG );
			vec3 Lin = pow( vSunE * ( ( betaRTheta + betaMTheta ) / ( vBetaR + vBetaM ) ) * ( 1.0 - Fex ), vec3( 1.5 ) );
			Lin *= mix( vec3( 1.0 ), pow( vSunE * ( ( betaRTheta + betaMTheta ) / ( vBetaR + vBetaM ) ) * Fex, vec3( 1.0 / 2.0 ) ), clamp( pow( 1.0 - vSunDirection.y, 5.0 ), 0.0, 1.0 ) );
			vec3 c = ( Lin + vec3( 0.1 ) * Fex ) * 0.04 + vec3( 0.0, 0.0003, 0.00075 );
			return dot( c, vec3( 0.2126, 0.7152, 0.0722 ) );
		}
		void main() {`)
    f = f.replace('gl_FragColor = vec4( texColor, 1.0 );', /* glsl */`
			// 色表主导：tabl = 色表天空色 × 物理天空的相对明暗（渐变/日晕/云）；phys = 物理天空按色表亮度归一
			vec3 reaRefDir = normalize( vec3( - vSunDirection.z, 1.0, vSunDirection.x ) + vec3( 0.0, 0.0, 1e-4 ) );
			float reaRef = max( reaPreethamLum( reaRefDir ), 1e-6 );
			float reaSkyL = max( dot( uSkyColor, vec3( 0.2126, 0.7152, 0.0722 ) ), 1e-6 );
			// 亮度上限：天空整体不能超过色表亮度的 ~1.5 倍，否则越过泛光阈值，整片天空的泛光会把远楼罩成一层白雾
			float reaG = clamp( dot( texColor, vec3( 0.2126, 0.7152, 0.0722 ) ) / reaRef, 0.55, 1.35 );
			vec3 reaTabl = uSkyColor * mix( 1.0, reaG, uMix.y );
			vec3 reaPhys = texColor * ( reaSkyL / reaRef );
			reaPhys *= min( 1.0, reaSkyL * 1.5 / max( dot( reaPhys, vec3( 0.2126, 0.7152, 0.0722 ) ), 1e-6 ) );
			vec3 reaCol = mix( reaTabl, reaPhys, uMix.x );
			// 地平线附近渐变到雾的内散射色（远处楼淡出到同一颜色，天地无缝）
			float reaHb = 1.0 - smoothstep( 0.0, uMix.z, direction.y );
			reaCol = mix( reaCol, reaFogTint( fogColor, direction ), reaHb );
			// 太阳盘（限亮度，供泛光；被云挡住时随云透明度减弱——云已经混进 texColor，这里按 G 值近似）
			reaCol += uSunCol * ( sundisc * uMix.w * reaSkyL * 40.0 );
			if ( uEnv.x > 0.5 ) {
				// 环境烘焙：地平线以下画地面（否则路面/墙底被"地下的天空"照亮）
				reaCol = mix( reaCol, uGround, smoothstep( 0.0, -0.15, direction.y ) );
				// 环境补光去掉一半天空蓝（纯天空色会把暖色墙面冲成灰紫），亮度保持
				float reaL = dot( reaCol, vec3( 0.2126, 0.7152, 0.0722 ) );
				reaCol = mix( vec3( reaL ), reaCol, uEnv.z ) * uEnv.y;
			}
			gl_FragColor = vec4( reaCol, 1.0 );`)
    mat.fragmentShader = f
    this.uniforms = u
    this.envMesh = new THREE.Mesh(this.mesh.geometry, mat)
    this.envMesh.frustumCulled = false
    this.envScene.add(this.envMesh)
  }

  /**
   * 按需重烘环境图（PMREM，256 尺寸与 RoomEnvironment 相同 → envMapCubeUVHeight 不变，不触发材质重编译）。
   * key 变了且距上次 ≥ minGap 秒才烘；返回新纹理或 null（未烘）
   */
  bakeEnv(renderer: THREE.WebGLRenderer, key: string, now: number, gain: number, sat: number, minGap = 1.5): THREE.Texture | null {
    if (key === this.envKey || now - this.envAt < minGap) return null
    this.envKey = key; this.envAt = now
    this.pmrem ??= new THREE.PMREMGenerator(renderer)
    const u = this.uniforms
    u.uEnv.value.set(1, gain, sat)
    const sunDisc = u.uMix.value.w
    u.uMix.value.w = 0
    const rt = this.pmrem.fromScene(this.envScene as unknown as THREE.Scene, 0, 0.1, 100)
    u.uEnv.value.set(0, 1, 1)
    u.uMix.value.w = sunDisc
    this.envRT?.dispose()
    this.envRT = rt
    return rt.texture
  }

  get envTexture() { return this.envRT?.texture ?? null }

  /** 强制下次 bakeEnv 重烘 */
  invalidateEnv() { this.envKey = '' ; this.envAt = -1e9 }

  dispose() {
    this.mesh.removeFromParent()
    this.mesh.geometry.dispose(); (this.mesh.material as THREE.Material).dispose()
    this.envRT?.dispose(); this.envRT = null
    this.pmrem?.dispose(); this.pmrem = null
  }
}

// ——————————————————————————————————————————— 级联阴影 ———————————————————————————————————————————

const SPLIT_LAMBDA = 0.75

export class CsmShadows {
  readonly csm: CSM
  private lastProj = ''

  constructor(scene: THREE.Scene, private camera: THREE.PerspectiveCamera) {
    const C = THREE.ShaderChunk as unknown as Record<string, string>
    const keepLights = C.lights_fragment_begin, keepPars = C.lights_pars_begin
    this.csm = new CSM({
      camera, parent: scene, cascades: CSM_CASCADES, maxFar: 350, mode: 'custom', shadowMapSize: 2048,
      lightDirection: new THREE.Vector3(-1, -1, -1).normalize(), lightIntensity: 1,
      lightNear: 1, lightFar: 1400, lightMargin: 320, shadowBias: -0.0001,
      // practical 分割（log/uniform 插值），λ 取 0.75 偏对数：近级约 0.3–32 m、中级 –83 m、远级 –350 m
      customSplitsCallback: (n: number, near: number, far: number, out: number[]) => {
        for (let i = 1; i < n; i++) {
          const log = near * Math.pow(far / near, i / n), uni = near + (far - near) * i / n
          out.push(THREE.MathUtils.lerp(uni, log, SPLIT_LAMBDA) / far)
        }
        out.push(1)
      },
    })
    // CSM 构造时会用自己的快照覆盖 lights 片段：恢复成我们的版本（材质不调用 setupMaterial，USE_CSM 永不定义）
    C.lights_fragment_begin = keepLights; C.lights_pars_begin = keepPars
    for (const l of this.csm.lights) { l.name = 'csm'; l.shadow.radius = 1.5; l.shadow.autoUpdate = false; l.shadow.needsUpdate = true }
    this.refreshBounds()
  }

  get lights() { return this.csm.lights }

  /**
   * 每个显示帧调用一次：决定本帧重画哪几级阴影图。近级每帧、中级隔帧、远级每 4 帧（错开），
   * 阴影图绘制量从 3× 降到 ≈1.75×。没重画的级保留上次的 shadow.matrix（着色器用它取样），与旧阴影图自洽，
   * 只是远处移动物体的影子更新频率降低。
   */
  schedule(frame: number) {
    const L = this.csm.lights
    L[0].shadow.needsUpdate = true
    if (frame % 2 === 0) L[1].shadow.needsUpdate = true
    if (frame % 4 === 1) L[2].shadow.needsUpdate = true
  }

  /** 相机投影变化（窗口比例/FOV/far）时重算分割与每级包围；同时按每级纹素尺寸设置法线偏移 */
  refreshBounds() {
    const c = this.camera
    const key = `${c.fov}|${c.aspect.toFixed(4)}|${c.near}|${c.far}|${c.zoom}`
    if (key === this.lastProj) return
    this.lastProj = key
    this.csm.updateFrustums()
    for (const l of this.csm.lights) {
      const cam = l.shadow.camera
      const texel = (cam.right - cam.left) / l.shadow.mapSize.x
      l.shadow.normalBias = Math.max(0.03, texel * 2.2)
    }
  }

  /** 每次渲染城市场景前：灯光方向/颜色/强度跟随太阳，重拟合各级包围盒 */
  update(dirToLight: THREE.Vector3, color: THREE.Color, intensity: number) {
    this.refreshBounds()
    this.csm.lightDirection.copy(dirToLight).negate()
    for (const l of this.csm.lights) { l.color.copy(color); l.intensity = intensity }
    this.csm.update()
  }

  dispose() {
    this.csm.remove()
    for (const l of this.csm.lights) l.dispose()
    this.csm.dispose()
  }
}
