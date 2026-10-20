import * as THREE from 'three'
import { LOOK } from '../core/LookUniforms'
import type { Role } from './CharacterSpec'

/**
 * 角色 PBR 材质：MeshStandardMaterial + onBeforeCompile 注入，按顶点属性 aMat 分区着色。
 *
 *   0 skin    皮肤：wrap 漫反射 + 偏红透光（次表面散射近似），roughness 0.55
 *   1 cloth   布料：绑定姿态物体空间三平面投影织纹（凹凸 + 粗糙度噪声 + 缝隙暗化），掠射 sheen，roughness ≈0.85
 *   2 leather 皮革（鞋）：roughness 0.35 / metalness 0.1
 *   3 hair    头发：Kajiya-Kay 各向异性高光（沿骨骼空间竖直方向），roughness 0.4
 *   4 accent  饰品/眼睛/头盔：roughness 0.35 / metalness 0.1
 *   全部分区：菲涅尔边缘光（LOOK.uRimColor × LOOK.uRimStrength，pow(1-N·V,4) 只在轮廓）
 *
 * onBeforeCompile / customProgramCacheKey 定义在子类原型上：Material.clone() 走 `new this.constructor().copy()`，
 * 原型方法天然保留（r186 的 copy 不复制实例上挂的 onBeforeCompile），所以每个 clone 都编出同一 cacheKey → 共用一个 program。
 * 自定义 uniform 全是模块级共享对象（同一引用），实例间无需同步。
 */

export const MAT_SKIN = 0, MAT_CLOTH = 1, MAT_LEATHER = 2, MAT_HAIR = 3, MAT_ACCENT = 4

/** 部件材质 → 着色分区 */
export function matClassOf(role: Role, materialName: string): number {
  switch (role) {
    case 'skin': return MAT_SKIN
    case 'top': case 'bottom': return MAT_CLOTH
    case 'hat': return materialName === 'Helmet' ? MAT_ACCENT : MAT_CLOTH   // 安全帽是硬塑料
    case 'shoes': return MAT_LEATHER
    case 'hair': return MAT_HAIR
    case 'accent': return MAT_ACCENT
    // fixed：catalog 里只有眼睛（男 'Eye'、女 'Brown'，#31251c）→ 当 accent（偏光滑，有一点高光点）
    default: return MAT_ACCENT
  }
}

const WEAVE_N = 128

/**
 * 运行时生成可平铺织纹贴图（128²，线性）：
 * R/G = 高度对 u/v 的偏导（编码到 0..1，除以 slopeScale）、B = 粗糙度噪声、A = 高度。
 * 平纹：16×16 根经纬纱，棋盘式上下交错；整数周期 → 无缝平铺。
 */
function makeWeaveTexture(): { tex: THREE.DataTexture; slopeScale: number } {
  const N = WEAVE_N, THREADS = 16, cell = N / THREADS
  const h = new Float32Array(N * N)
  // 可平铺值噪声（周期 8 格）
  const P = 8, grid = new Float32Array(P * P)
  let seed = 1337
  const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647 }
  for (let i = 0; i < grid.length; i++) grid[i] = rnd()
  const fine = new Float32Array(N * N)
  for (let i = 0; i < fine.length; i++) fine[i] = rnd()
  const smooth = (t: number) => t * t * (3 - 2 * t)
  const vnoise = (x: number, y: number) => {
    const fx = (x / N) * P, fy = (y / N) * P
    const x0 = Math.floor(fx), y0 = Math.floor(fy), tx = smooth(fx - x0), ty = smooth(fy - y0)
    const g = (a: number, b: number) => grid[((b % P) + P) % P * P + ((a % P) + P) % P]
    return (g(x0, y0) * (1 - tx) + g(x0 + 1, y0) * tx) * (1 - ty) + (g(x0, y0 + 1) * (1 - tx) + g(x0 + 1, y0 + 1) * tx) * ty
  }
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
    const i = Math.floor(x / cell), j = Math.floor(y / cell)
    const fu = (x + 0.5) / cell - i, fv = (y + 0.5) / cell - j
    const warpTop = ((i + j) & 1) === 0
    // 经纱（沿 v 走向）截面 = sin(π·fu)，在本格内顺纱向鼓起；纬纱同理
    const prof = (t: number) => Math.sqrt(Math.max(0, Math.sin(Math.PI * t)))
    const warp = prof(fu) * (warpTop ? 0.75 + 0.25 * Math.sin(Math.PI * fv) : 0.45)
    const weft = prof(fv) * (warpTop ? 0.45 : 0.75 + 0.25 * Math.sin(Math.PI * fu))
    h[y * N + x] = Math.max(warp, weft) * 0.92 + fine[y * N + x] * 0.08
  }
  // 中心差分（环绕）求偏导，单位：高度 / uv
  const du = new Float32Array(N * N), dv = new Float32Array(N * N)
  let maxS = 1e-6
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
    const xp = (x + 1) % N, xm = (x - 1 + N) % N, yp = (y + 1) % N, ym = (y - 1 + N) % N
    const a = (h[y * N + xp] - h[y * N + xm]) * 0.5 * N
    const b = (h[yp * N + x] - h[ym * N + x]) * 0.5 * N
    du[y * N + x] = a; dv[y * N + x] = b
    maxS = Math.max(maxS, Math.abs(a), Math.abs(b))
  }
  const data = new Uint8Array(N * N * 4)
  for (let k = 0; k < N * N; k++) {
    const x = k % N, y = (k / N) | 0
    data[k * 4] = Math.round((du[k] / maxS * 0.5 + 0.5) * 255)
    data[k * 4 + 1] = Math.round((dv[k] / maxS * 0.5 + 0.5) * 255)
    data[k * 4 + 2] = Math.round(vnoise(x, y) * 255)
    data[k * 4 + 3] = Math.round(h[k] * 255)
  }
  const tex = new THREE.DataTexture(data, N, N, THREE.RGBAFormat, THREE.UnsignedByteType)
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping
  tex.magFilter = THREE.LinearFilter
  tex.minFilter = THREE.LinearMipmapLinearFilter
  tex.generateMipmaps = true
  tex.anisotropy = 4
  tex.colorSpace = THREE.NoColorSpace
  tex.name = 'CharacterWeave'
  tex.needsUpdate = true
  return { tex, slopeScale: maxS }
}

let weave: { tex: THREE.DataTexture; slopeScale: number } | null = null

/** 共享 uniform（所有角色材质实例引用同一对象） */
export const CHAR_UNIFORMS = {
  /** 量化位置 → 米（scene 量化体积是等比缩放，由 CharacterLibrary 从骨骼反绑定矩阵算出） */
  uObjScale: { value: 1 },
  uWeave: { value: null as THREE.DataTexture | null },
  /** 织纹平铺频率（次 / 米）：一张 5 cm、16 根纱 → 每根约 3 mm（1 m 外基本只剩粗糙度/光泽变化） */
  uWeaveFreq: { value: 20.0 },
  /** 织纹凹凸幅度（米）× 贴图斜率还原系数 */
  uWeaveAmp: { value: 0.00045 },
  uWeaveSlope: { value: 1 },
  /** 皮肤透光色（wrap 区域的颜色） */
  uSSSColor: { value: new THREE.Color(1.0, 0.36, 0.24) },
}

const VERT_PARS = /* glsl */`
attribute float aMat;
varying float vCharMat;
varying vec3 vObjPos;
varying vec3 vObjN;
varying vec3 vUpV;
uniform float uObjScale;
`

const FRAG_PARS = /* glsl */`
varying float vCharMat;
varying vec3 vObjPos;
varying vec3 vObjN;
varying vec3 vUpV;
uniform sampler2D uWeave;
uniform float uWeaveFreq;
uniform float uWeaveAmp;
uniform float uWeaveSlope;
uniform vec3 uSSSColor;
uniform vec3 uRimColor;
uniform float uRimStrength;
int gCharMat;
vec3 gHairT;
`

/** 改写 RE_Direct_Physical：皮肤 wrap+透光、布料掠射 sheen、头发 Kajiya-Kay */
function patchedPhysicalPars(): string {
  let s = THREE.ShaderChunk.lights_physical_pars_fragment
  const a = 'vec3 irradiance = dotNL * directLight.color;'
  const b = 'reflectedLight.directSpecular += irradiance * specularBRDF * material.multiScatteringCompensation;'
  const c = 'reflectedLight.directDiffuse += irradiance * BRDF_Lambert( material.diffuseContribution ) * ( 1.0 - F );'
  for (const k of [a, b, c]) if (!s.includes(k)) throw new Error('[CharacterMaterial] three 着色器片段已变化，找不到：' + k)
  s = s.replace(a, /* glsl */`${a}
	float charNL = dot( geometryNormal, directLight.direction );
	float charNV = saturate( dot( geometryNormal, geometryViewDir ) );
	vec3 charDiffIrr = irradiance;
	if ( gCharMat == 0 ) {
		// wrap 漫反射：越过明暗交界线的部分染成透光红
		float wrapNL = saturate( ( charNL + 0.45 ) / 1.45 );
		charDiffIrr = directLight.color * ( dotNL + uSSSColor * max( wrapNL - dotNL, 0.0 ) * 0.75 );
	} else if ( gCharMat == 1 ) {
		// 布料：掠射亮边（sheen 近似），只在受光面
		float sheen = pow( 1.0 - charNV, 4.0 ) * saturate( charNL * 0.6 + 0.4 );
		charDiffIrr += directLight.color * sheen * 0.35;
	}`)
  s = s.replace(b, /* glsl */`if ( gCharMat == 3 ) {
		// Kajiya-Kay 双瓣：主瓣偏发梢方向、白色；次瓣偏发根、带发色
		vec3 H = normalize( directLight.direction + geometryViewDir );
		vec3 T1 = normalize( gHairT + geometryNormal * 0.12 );
		vec3 T2 = normalize( gHairT - geometryNormal * 0.18 );
		float th1 = dot( T1, H ), th2 = dot( T2, H );
		float s1 = pow( sqrt( max( 1.0 - th1 * th1, 0.0 ) ), 96.0 );
		float s2 = pow( sqrt( max( 1.0 - th2 * th2, 0.0 ) ), 22.0 );
		float vis = smoothstep( -0.1, 0.35, charNL );
		vec3 hairSpec = ( vec3( 0.2 ) * s1 + material.diffuseColor * 1.6 * s2 * 0.35 ) * vis;
		reflectedLight.directSpecular += directLight.color * hairSpec + irradiance * specularBRDF * material.multiScatteringCompensation * 0.25;
	} else {
		${b}
	}`)
  s = s.replace(c, c.replace('irradiance *', 'charDiffIrr *'))
  return s
}

const FRAG_COLOR = /* glsl */`
	gCharMat = int( vCharMat + 0.5 );
	float charCloth = gCharMat == 1 ? 1.0 : 0.0;
	// 三平面投影（绑定姿态物体空间，不随动画游动）。无条件采样：分支里用隐式导数是未定义行为
	vec3 charBN = normalize( vObjN );
	vec3 charW = pow( abs( charBN ), vec3( 4.0 ) );
	charW /= ( charW.x + charW.y + charW.z + 1e-5 );
	vec3 charP = vObjPos * uWeaveFreq;
	// 像素覆盖的纱线根数（一张贴图 16 根）：超过 ~0.3 根/像素就淡出凹凸，防止摩尔纹
	float charTpp = length( fwidth( vObjPos ) ) * uWeaveFreq * 16.0;
	float charFade = charCloth * ( 1.0 - smoothstep( 0.2, 0.5, charTpp ) );
	vec4 wX = texture2D( uWeave, charP.zy );
	vec4 wY = texture2D( uWeave, charP.xz );
	vec4 wZ = texture2D( uWeave, charP.xy );
	vec2 gX = wX.rg * 2.0 - 1.0, gY = wY.rg * 2.0 - 1.0, gZ = wZ.rg * 2.0 - 1.0;
	// 物体空间高度梯度（米/米）
	vec3 charGrad = ( charW.x * vec3( 0.0, gX.y, gX.x ) + charW.y * vec3( gY.x, 0.0, gY.y ) + charW.z * vec3( gZ.x, gZ.y, 0.0 ) )
		* ( uWeaveFreq * uWeaveAmp * uWeaveSlope * charFade );
	float charRoughN = charW.x * wX.b + charW.y * wY.b + charW.z * wZ.b;
	float charH = charW.x * wX.a + charW.y * wY.a + charW.z * wZ.a;
	// 纱线缝隙轻微暗化（远处 mip 平均后自然消失）
	diffuseColor.rgb *= mix( 1.0, 0.92 + 0.08 * charH, charFade );
`

const FRAG_ROUGH = /* glsl */`
	roughnessFactor = gCharMat == 0 ? 0.55
		: gCharMat == 1 ? 0.85 + ( charRoughN - 0.5 ) * 0.16
		: gCharMat == 3 ? 0.4
		: 0.35;
	metalnessFactor = ( gCharMat == 2 || gCharMat == 4 ) ? 0.1 : 0.0;
`

const FRAG_NORMAL = /* glsl */`
	{
		// 表面梯度凹凸（Mikkelsen）：高度对屏幕 x/y 的导数 = 物体空间梯度 · 物体坐标导数 → 与分辨率、贴图尺寸无关
		vec3 sigX = dFdx( - vViewPosition ), sigY = dFdy( - vViewPosition );
		float dHx = dot( charGrad, dFdx( vObjPos ) ), dHy = dot( charGrad, dFdy( vObjPos ) );
		vec3 R1 = cross( sigY, normal ), R2 = cross( normal, sigX );
		float det = dot( sigX, R1 ) * faceDirection;
		vec3 bumpGrad = sign( det ) * ( dHx * R1 + dHy * R2 );
		vec3 bumped = normalize( abs( det ) * normal - bumpGrad );
		normal = abs( det ) > 1e-12 ? normalize( mix( normal, bumped, charCloth ) ) : normal;
		// 头发切线：骨骼空间 +Y 的视空间方向，对法线正交化
		vec3 upV = normalize( vUpV );
		gHairT = normalize( upV - normal * dot( normal, upV ) + 1e-4 );
	}
`

const FRAG_SPEC = /* glsl */`
	// 布料/头发：压低环境镜面的菲涅尔（否则低模面片掠射处整片泛白像塑料）
	if ( gCharMat == 1 ) { material.specularF90 = 0.3; material.specularColor *= 0.7; material.specularColorBlended = material.specularColor; }
	else if ( gCharMat == 3 ) { material.specularF90 = 0.55; }
`

const FRAG_RIM = /* glsl */`
	{
		vec3 rimV = isOrthographic ? vec3( 0.0, 0.0, 1.0 ) : normalize( vViewPosition );
		// 只在轮廓：低模面片法线跨度大，用 smoothstep 把 N·V > 0.45 的面全部截掉，正面不发白
		float rimF = smoothstep( 0.6, 1.0, 1.0 - saturate( dot( normal, rimV ) ) );
		outgoingLight += uRimColor * ( uRimStrength * 0.6 * rimF * rimF );
	}
`

const CACHE_KEY = 'rea-character-pbr-v1'

function inject(src: string, anchor: string, code: string, before = false): string {
  if (!src.includes(anchor)) throw new Error('[CharacterMaterial] 找不到注入点 ' + anchor)
  return src.replace(anchor, before ? code + '\n' + anchor : anchor + '\n' + code)
}

export class CharacterMaterial extends THREE.MeshStandardMaterial {
  readonly isCharacterMaterial = true

  constructor(params?: THREE.MeshStandardMaterialParameters) {
    super({ vertexColors: true, roughness: 1, metalness: 0, name: 'CharacterPBR', ...params })
  }

  override onBeforeCompile(shader: THREE.WebGLProgramParametersWithUniforms) {
    weave ??= makeWeaveTexture()
    CHAR_UNIFORMS.uWeave.value = weave.tex
    CHAR_UNIFORMS.uWeaveSlope.value = weave.slopeScale
    Object.assign(shader.uniforms, CHAR_UNIFORMS, { uRimColor: LOOK.uRimColor, uRimStrength: LOOK.uRimStrength })

    let v = shader.vertexShader
    v = inject(v, '#include <common>', VERT_PARS)
    v = inject(v, '#include <beginnormal_vertex>', '\tvObjN = objectNormal;')
    v = inject(v, '#include <skinnormal_vertex>', /* glsl */`
	#ifdef USE_SKINNING
		vUpV = ( modelViewMatrix * vec4( mat3( skinMatrix ) * vec3( 0.0, 1.0, 0.0 ), 0.0 ) ).xyz;
	#else
		vUpV = ( modelViewMatrix * vec4( 0.0, 1.0, 0.0, 0.0 ) ).xyz;
	#endif`)
    v = inject(v, '#include <begin_vertex>', '\tvObjPos = position * uObjScale;\n\tvCharMat = aMat;')
    shader.vertexShader = v

    let f = shader.fragmentShader
    f = inject(f, '#include <lights_physical_pars_fragment>', FRAG_PARS, true)
    f = f.replace('#include <lights_physical_pars_fragment>', patchedPhysicalPars())
    f = inject(f, '#include <color_fragment>', FRAG_COLOR)
    f = inject(f, '#include <metalnessmap_fragment>', FRAG_ROUGH)
    f = inject(f, '#include <normal_fragment_maps>', FRAG_NORMAL)
    f = inject(f, '#include <lights_physical_fragment>', FRAG_SPEC)
    f = inject(f, '#include <opaque_fragment>', FRAG_RIM, true)
    shader.fragmentShader = f
  }

  override customProgramCacheKey() { return CACHE_KEY }
}

/** 角色模板材质（CharacterLibrary 持有；实例各自 clone 以支持受击着色，program 共享） */
export function createCharacterMaterial(): CharacterMaterial {
  return new CharacterMaterial()
}
