import * as THREE from 'three'
import { loadSettings } from '../core/Settings'

/**
 * P14.3 街道表面的程序化着色器片段（参考 Slop New York 的 tsl-materials：路面/人行道/路缘/积水场），
 * 全部用 onBeforeCompile 注入内置材质，保留 three 的光照/阴影/雾链路（Atmosphere 的 CSM 与高度雾全局补丁照常生效）。
 *
 * - 世界坐标 varying vStreetW：顶点阶段按 (instanceMatrix ×) modelMatrix 自算，不依赖 worldpos_vertex 的宏条件。
 * - 噪声：整数哈希的值噪声（不用 sin 哈希：新加坡本地坐标到 ±2 万米，乘频率后 sin 精度崩坏）。
 * - 抗锯齿：细节项都按像素足迹 fwidth(xz) 淡出到均值（远处不出摩尔纹），砖缝用 fwidth 过滤的线函数。
 * - 共享 uniform（普通对象引用，所有材质同一份）：uStreetWet 由 Weather 每帧写；uStreetDetail 0 = 关细节（fx=off）。
 */
export const STREET_UNIFORMS = {
  /** 路面湿度 0 干 … 1 刚下完暴雨（Weather 驱动）：决定湿斑 / 积水 / 整体水膜 */
  uStreetWet: { value: 0 },
  /** 细节总开关：1 程序化细节；0 = 平涂（fx=off 省 ALU） */
  uStreetDetail: { value: 1 },
}

// 档位：fx=off 时关细节（启动时读一次；运行时切档需调用 setStreetDetail）
try { STREET_UNIFORMS.uStreetDetail.value = loadSettings().fx === 'off' ? 0 : 1 } catch { /* 非浏览器环境 */ }
/** 运行时切换街面细节（fx=off → false） */
export function setStreetDetail(on: boolean) { STREET_UNIFORMS.uStreetDetail.value = on ? 1 : 0 }
if (typeof window !== 'undefined') (window as unknown as { __street: unknown }).__street = { uniforms: STREET_UNIFORMS, setStreetDetail }

/** sRGB 十六进制 → GLSL 线性色常量 */
function lin(hex: number): string {
  const c = new THREE.Color(hex)
  return `vec3(${c.r.toFixed(4)}, ${c.g.toFixed(4)}, ${c.b.toFixed(4)})`
}

/** 公共 GLSL：哈希 / 值噪声 / fbm / 过滤网格线 / 积水场与湿度遮罩 */
export const STREET_COMMON_GLSL = /* glsl */`
uniform float uStreetWet;
uniform float uStreetDetail;
varying vec3 vStreetW;
float sHash( ivec2 c ) {
	uvec2 q = uvec2( c + ivec2( 1 << 20 ) );
	uint h = q.x * 1597334677u ^ q.y * 3812015801u;
	h *= 0x2C1B3C6Du; h ^= h >> 15u; h *= 0x297A2D39u; h ^= h >> 15u;
	return float( h ) * ( 1.0 / 4294967295.0 );
}
float sNoise( vec2 p ) {
	vec2 i = floor( p ), f = fract( p );
	ivec2 c = ivec2( i );
	f = f * f * ( 3.0 - 2.0 * f );
	float a = sHash( c ), b = sHash( c + ivec2( 1, 0 ) ), d = sHash( c + ivec2( 0, 1 ) ), e = sHash( c + ivec2( 1, 1 ) );
	return mix( mix( a, b, f.x ), mix( d, e, f.x ), f.y );
}
// 像素足迹 pix（米）下的噪声：频率 freq 的一个周期 < 约 3 像素时淡出到 0.5
float sNoiseAA( vec2 p, float freq, float pix ) {
	return mix( sNoise( p * freq ), 0.5, smoothstep( 0.18, 0.5, pix * freq ) );
}
// 抗锯齿网格线：坐标 x、周期 P、线宽 w（米）；返回线覆盖率 0..1（已按像素足迹盒式过滤）
float sGridLine( float x, float P, float w ) {
	float fw = max( fwidth( x ), 1e-5 );
	float d = abs( fract( x / P + 0.5 ) - 0.5 ) * P;
	float cov = 1.0 - smoothstep( w * 0.5 - fw * 0.5, w * 0.5 + fw * 0.5, d );
	// 足迹比线宽大时只剩平均覆盖率 w/P
	return mix( cov, w / P, smoothstep( w, P * 0.5, fw ) );
}
// 积水场：低频为主（越大越"低洼"）
float sPuddleField( vec2 p ) {
	return sNoise( p * vec2( 0.095, 0.075 ) ) * 0.52 + sNoise( p * vec2( 0.25, 0.22 ) + vec2( 19.4, 11.8 ) ) * 0.34 + sNoise( p * 0.68 + vec2( -7.3, 29.1 ) ) * 0.14;
}
// 湿度遮罩：x 湿斑（变深、半光）、y 积水（镜面）、z 整体水膜；drainage 越大越不积水（人行道排水好）
vec3 sWetMasks( float field, float drainage ) {
	float w = uStreetWet;
	float level = mix( 0.86, 0.56, clamp( ( w - 0.1 ) / 0.55, 0.0, 1.0 ) ) + drainage;
	float damp = smoothstep( level - 0.09, level - 0.015, field ) * smoothstep( 0.02, 0.15, w );
	float puddle = smoothstep( level, level + 0.022, field ) * smoothstep( 0.1, 0.22, w );
	float film = smoothstep( 0.2, 0.8, w );
	return vec3( damp, puddle, film );
}
`

const VERT_PARS = /* glsl */`
varying vec3 vStreetW;
`
const VERT_MAIN = /* glsl */`
	{
		vec4 sw = vec4( transformed, 1.0 );
		#ifdef USE_INSTANCING
		sw = instanceMatrix * sw;
		#endif
		vStreetW = ( modelMatrix * sw ).xyz;
	}
`

/** 顶点着色器：声明并写出世界坐标 varying（extraPars/extraMain 追加自定义属性） */
function patchVertex(sh: { vertexShader: string }, extraPars = '', extraMain = '') {
  sh.vertexShader = sh.vertexShader
    .replace('#include <common>', `#include <common>\n${VERT_PARS}${extraPars}`)
    .replace('#include <project_vertex>', `#include <project_vertex>\n${VERT_MAIN}${extraMain}`)
}

function bindUniforms(sh: { uniforms: Record<string, THREE.IUniform> }) {
  sh.uniforms.uStreetWet = STREET_UNIFORMS.uStreetWet
  sh.uniforms.uStreetDetail = STREET_UNIFORMS.uStreetDetail
}

// ---------------------------------------------------------------------------
// 沥青
// ---------------------------------------------------------------------------

/**
 * 沥青（MeshStandardMaterial）：
 * color_fragment 之后：多尺度色差（大块补丁 / 修补接缝 / 细骨料 / 微颗粒）+ 油污 + 车辙近似（低频条带噪声）+ 湿度遮罩变深；
 * roughnessmap_fragment 之后：粗糙度随骨料/油污变化，湿斑/水膜降到 0.38，积水 0.04（局部镜面，非整片湿）。
 * 输出 sPuddleMask 供菲涅尔天光使用。
 */
export function patchAsphalt(sh: { vertexShader: string; fragmentShader: string; uniforms: Record<string, THREE.IUniform> }) {
  bindUniforms(sh)
  patchVertex(sh)
  sh.fragmentShader = sh.fragmentShader
    .replace('#include <common>', `#include <common>\n${STREET_COMMON_GLSL}`)
    .replace('#include <color_fragment>', /* glsl */`#include <color_fragment>
	float sRoughAdd = 0.0;
	vec3 sWet = vec3( 0.0 );
	{
		vec2 p = vStreetW.xz;
		float pix = length( fwidth( p ) );
		float det = uStreetDetail * smoothstep( 320.0, 25.0, length( vStreetW - cameraPosition ) );
		float patchN = sNoise( p * 0.11 + vec2( 3.1, -8.7 ) );
		float macro = sNoise( p * 0.028 + vec2( 17.0, 5.0 ) );
		float fine = sNoiseAA( p, 3.1, pix );
		float micro = sNoiseAA( p + 41.0, 17.0, pix );
		// 油污：中频斑块；车辙：两组正交的拉长噪声近似"沿行车方向"的暗带（没有车道坐标）
		float oil = smoothstep( 0.56, 0.86, sNoise( p * 0.45 + vec2( 31.0, 7.0 ) ) ) * det;
		float rut = smoothstep( 0.55, 0.8, max( sNoise( p * vec2( 0.9, 0.06 ) + 3.0 ), sNoise( p * vec2( 0.06, 0.9 ) - 9.0 ) ) ) * det;
		// 修补接缝：补丁噪声等值线上的细黑线（只在近处）
		float seam = ( 1.0 - smoothstep( 0.0, 0.03, abs( patchN - 0.5 ) ) ) * smoothstep( 0.25, 0.06, pix ) * det;
		// 补丁：等值线一侧略新（更深），另一侧旧（偏灰白）
		float tone = 1.0 + uStreetDetail * ( 0.34 * ( macro - 0.5 ) + 0.2 * ( step( 0.5, patchN ) - 0.5 ) * det + 0.3 * ( fine - 0.5 ) + 0.4 * ( micro - 0.5 ) );
		// 骨料：零星浅色碎石点（4 cm 格哈希），足迹大于 2 cm 时淡为均值
		float stone = step( 0.9, sHash( ivec2( floor( p * 25.0 ) ) ) );
		tone *= 1.0 + uStreetDetail * mix( stone * 0.35, 0.035, smoothstep( 0.01, 0.03, pix ) );
		diffuseColor.rgb *= tone * ( 1.0 - 0.38 * oil ) * ( 1.0 - 0.14 * rut ) * ( 1.0 - 0.45 * seam );
		sRoughAdd = uStreetDetail * ( ( micro - 0.5 ) * 0.12 - oil * 0.2 - rut * 0.06 );
		sWet = sWetMasks( sPuddleField( p ), 0.0 );
		diffuseColor.rgb *= mix( 1.0, 0.72, sWet.x ) * mix( 1.0, 0.6, sWet.y ) * mix( 1.0, 0.8, sWet.z );
	}`)
    .replace('#include <roughnessmap_fragment>', /* glsl */`#include <roughnessmap_fragment>
	roughnessFactor = clamp( roughnessFactor + sRoughAdd, 0.04, 1.0 );
	roughnessFactor = mix( roughnessFactor, 0.38, max( sWet.z * 0.9, sWet.x * 0.8 ) );
	roughnessFactor = mix( roughnessFactor, 0.05, sWet.y );`)
}

// ---------------------------------------------------------------------------
// 人行道 + 路缘
// ---------------------------------------------------------------------------

/** 人行道几何上的面类型（aKerb.x）：0 地砖顶面、1 路缘临车道立面、2 外缘立面（接地面）、3 路缘石顶面、4 路缘石内侧立面 */
export const KERB_TOP = 3

const C_PAVER_RED = lin(0x7a5a50), C_PAVER_GREY = lin(0x8d8a85), C_SLAB = lin(0x9c9a94)
const C_KERB = lin(0xb8b5ad), C_OUTER = lin(0x7d7a72)

/**
 * 人行道（MeshStandardMaterial，DoubleSide）：顶点属性 aKerb = (面类型, 沿边弧长)。
 * 顶面：按 40 m 区域哈希选 30×30 cm 红/灰透水砖（逐块随机）或 60×60 cm 灰色混凝土板；fwidth 抗锯齿砖缝、逐块色差、污迹；
 *       足迹大于砖尺寸时淡化为平均色。
 * 路缘：浅灰混凝土，1 m 一节接缝，底部车道侧污渍，顶边 2.5 cm 法线弯向 +Y 当倒角高光。
 * 法线：不用 DoubleSide 的 faceDirection 翻转（顶面网格绕序朝下），直接取插值顶点法线。
 */
export function patchSidewalk(sh: { vertexShader: string; fragmentShader: string; uniforms: Record<string, THREE.IUniform> }) {
  bindUniforms(sh)
  patchVertex(sh, 'attribute vec2 aKerb;\nvarying vec2 vKerb;\n', '\tvKerb = aKerb;\n')
  sh.fragmentShader = sh.fragmentShader
    .replace('#include <common>', `#include <common>\n${STREET_COMMON_GLSL}\nvarying vec2 vKerb;`)
    .replace('#include <color_fragment>', /* glsl */`#include <color_fragment>
	float sRoughAdd = 0.0;
	vec3 sWet = vec3( 0.0 );
	float sKerbT = 0.0;
	int sFace = int( vKerb.x + 0.5 );
	{
		vec2 p = vStreetW.xz;
		float pix = length( fwidth( p ) );
		float det = uStreetDetail * smoothstep( 260.0, 18.0, length( vStreetW - cameraPosition ) );
		float stain = smoothstep( 0.55, 0.9, sNoise( p * 0.35 + vec2( 5.0, 13.0 ) ) ) * det;
		vec3 col;
		if ( sFace == 0 ) {
			// 区域：40 m 格哈希选铺装
			bool paver = sHash( ivec2( floor( p / 40.0 ) ) + ivec2( 31, 7 ) ) < 0.6;
			float P = paver ? 0.3 : 0.6;
			ivec2 tile = ivec2( floor( p / P ) );
			float th = sHash( tile ), th2 = sHash( tile + ivec2( 97, 13 ) );
			vec3 avg = paver ? mix( ${C_PAVER_GREY}, ${C_PAVER_RED}, 0.3 ) : ${C_SLAB};
			vec3 tcol = paver ? ( th2 < 0.3 ? ${C_PAVER_RED} : ${C_PAVER_GREY} ) : ${C_SLAB};
			tcol *= 1.0 + ( th - 0.5 ) * ( paver ? 0.18 : 0.12 );
			// 足迹接近砖尺寸时逐块色差淡出（远处平均色，避免摩尔纹）
			float tileVis = uStreetDetail * ( 1.0 - smoothstep( P * 0.12, P * 0.6, pix ) );
			col = mix( avg, tcol, tileVis );
			float joint = max( sGridLine( p.x, P, 0.012 ), sGridLine( p.y, P, 0.012 ) ) * uStreetDetail;
			col *= 1.0 - joint * 0.5;
			col *= 1.0 + ( sNoiseAA( p, 9.0, pix ) - 0.5 ) * 0.14 * uStreetDetail;
			sRoughAdd = ( th - 0.5 ) * 0.08 * tileVis + joint * 0.08;
		} else {
			// 路缘与外缘立面：混凝土，按沿边弧长 1 m 一节
			float s = vKerb.y;
			bool kerb = sFace != 2;
			float t = kerb ? clamp( ( vStreetW.y + 0.02 ) / 0.17, 0.0, 1.0 ) : clamp( ( vStreetW.y + 0.12 ) / 0.24, 0.0, 1.0 );
			sKerbT = t;
			col = kerb ? ${C_KERB} : ${C_OUTER};
			col *= 1.0 + ( sNoiseAA( vec2( s, vStreetW.y ) , 6.0, pix ) - 0.5 ) * 0.16 * uStreetDetail;
			col *= 1.0 + ( sNoise( vec2( s * 0.4, 3.0 ) ) - 0.5 ) * 0.12 * uStreetDetail;
			float joint = sGridLine( s, 1.0, 0.01 ) * uStreetDetail;
			col *= 1.0 - joint * 0.45;
			// 车道侧立面：底部被溅水/轮胎蹭黑
			if ( sFace == 1 ) col *= mix( 0.55, 1.0, mix( 1.0, smoothstep( 0.0, 0.7, t ), uStreetDetail ) );
			if ( sFace == 2 ) col *= mix( 0.7, 1.0, t );
		}
		col *= 1.0 - 0.3 * stain;
		diffuseColor.rgb = col;
		// 人行道排水好：积水阈值抬高；立面不积水
		sWet = sWetMasks( sNoise( p * 0.14 + vec2( 7.4, -13.1 ) ) * 0.65 + sNoise( p * 0.38 ) * 0.35, 0.06 );
		if ( sFace == 1 || sFace == 2 || sFace == 4 ) sWet.y = 0.0;
		diffuseColor.rgb *= mix( 1.0, 0.72, max( sWet.x, sWet.y ) ) * mix( 1.0, 0.8, sWet.z );
	}`)
    .replace('#include <roughnessmap_fragment>', /* glsl */`#include <roughnessmap_fragment>
	roughnessFactor = clamp( roughnessFactor + sRoughAdd, 0.04, 1.0 );
	roughnessFactor = mix( roughnessFactor, 0.55, max( sWet.z, sWet.x * 0.7 ) );
	roughnessFactor = mix( roughnessFactor, 0.12, sWet.y );`)
    .replace('#include <normal_fragment_begin>', /* glsl */`#include <normal_fragment_begin>
	// 顶面网格绕序朝下：不按 faceDirection 翻转，直接用顶点法线；路缘顶边 2.5 cm 弯向 +Y 当倒角
	normal = normalize( vNormal );
	if ( sFace == 1 ) normal = normalize( mix( normal, ( viewMatrix * vec4( 0.0, 1.0, 0.0, 0.0 ) ).xyz, smoothstep( 0.85, 1.0, sKerbT ) * 0.75 ) );
	nonPerturbedNormal = normal;`)
}

// ---------------------------------------------------------------------------
// 标线磨损
// ---------------------------------------------------------------------------

/**
 * 标线（MeshBasicMaterial 实例化）：近处按世界坐标噪声局部变淡、少量缺损（discard；足迹大时不缺损防闪烁），湿时变暗。
 */
export function patchMarking(sh: { vertexShader: string; fragmentShader: string; uniforms: Record<string, THREE.IUniform> }) {
  bindUniforms(sh)
  patchVertex(sh)
  sh.fragmentShader = sh.fragmentShader
    .replace('#include <common>', `#include <common>\n${STREET_COMMON_GLSL}`)
    .replace('#include <color_fragment>', /* glsl */`#include <color_fragment>
	{
		vec2 p = vStreetW.xz;
		float pix = length( fwidth( p ) );
		float near = uStreetDetail * smoothstep( 120.0, 12.0, length( vStreetW - cameraPosition ) );
		float wear = sNoise( p * 0.8 ) * 0.6 + sNoiseAA( p + 7.0, 2.3, pix ) * 0.4;
		float chips = sNoiseAA( p - 13.0, 9.0, pix );
		// 缺损：磨损重处剥落成沥青色小块；像素足迹大于 3 cm 时不剥（远处不闪）
		float lose = smoothstep( 0.80, 0.86, wear * 0.7 + chips * 0.45 ) * near * ( 1.0 - smoothstep( 0.015, 0.04, pix ) );
		if ( lose > 0.5 ) discard;
		diffuseColor.rgb *= mix( 1.0, mix( 0.62, 1.0, smoothstep( 0.25, 0.65, wear ) ), near );
		vec3 sWet = sWetMasks( sPuddleField( p ), 0.0 );
		diffuseColor.rgb *= mix( 1.0, 0.72, sWet.y ) * mix( 1.0, 0.86, sWet.z );
	}`)
}

// ---------------------------------------------------------------------------
// 地面
// ---------------------------------------------------------------------------

/**
 * 地面（Lambert + ground.png 2 m/px 土地利用色）：map 采样后叠世界坐标细节——
 * 偏绿像素做草地斑驳（深浅草块 + 枯黄斑），其余做泥土/铺地色差；近处加颗粒（按足迹淡出）。
 */
export function patchGround(sh: { vertexShader: string; fragmentShader: string; uniforms: Record<string, THREE.IUniform> }) {
  bindUniforms(sh)
  patchVertex(sh)
  sh.fragmentShader = sh.fragmentShader
    .replace('#include <common>', `#include <common>\n${STREET_COMMON_GLSL}`)
    .replace('#include <map_fragment>', /* glsl */`#include <map_fragment>
	if ( uStreetDetail > 0.5 ) {
		vec2 p = vStreetW.xz;
		float pix = length( fwidth( p ) );
		vec3 c = diffuseColor.rgb;
		float green = smoothstep( 0.0, 0.04, c.g - max( c.r, c.b ) );
		float m1 = sNoise( p * 0.07 + 11.0 ), m2 = sNoise( p * 0.31 - 4.0 ), m3 = sNoiseAA( p, 1.7, pix );
		float grain = sNoiseAA( p + 23.0, 9.0, pix );
		// 草地：深浅草块 + 枯黄斑
		vec3 grass = c * ( 0.78 + 0.32 * m1 + 0.18 * ( m2 - 0.5 ) + 0.16 * ( m3 - 0.5 ) );
		grass = mix( grass, grass * vec3( 1.25, 1.08, 0.62 ), smoothstep( 0.62, 0.85, m2 ) * 0.55 );
		// 泥土/铺地：色差 + 颗粒
		vec3 dirt = c * ( 0.84 + 0.3 * m1 + 0.16 * ( m2 - 0.5 ) + 0.14 * ( m3 - 0.5 ) );
		dirt = mix( dirt, dirt * vec3( 1.08, 1.0, 0.86 ), smoothstep( 0.6, 0.8, m2 ) * 0.5 );
		vec3 outC = mix( dirt, grass, green );
		outC *= 1.0 + ( grain - 0.5 ) * 0.22;
		diffuseColor.rgb = outC;
	}`)
}
