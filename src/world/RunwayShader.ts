import * as THREE from 'three'
import { STREET_COMMON_GLSL, STREET_UNIFORMS } from './StreetShaders'
import { APRON, CONNECTORS, HOLD_SHORT_Z, RUNWAY, STANDS, TAXIWAY } from './Airfield'

/**
 * AIR.2 机场铺装材质：跑道 / 滑行道 / 联络道 / 停机坪 / 服务区共用一个 MeshStandardMaterial（一个 program），
 * onBeforeCompile 注入，按世界坐标（米）在片元里画全部标线——不需要贴图，远近都清晰：
 *  - 跑道（kind 0）：入口横线、两端斑马键（piano keys）、跑道号 09/27（七段笔画）、中线虚线、接地区与瞄准点标志、边线、接地区轮胎印；
 *  - 主滑行道（1）/ 联络道（2）：黄色中线与双黄边线，联络道上的等待线（hold short，滑行道侧双实线、跑道侧双虚线）；
 *  - 停机坪（3）：混凝土分块、黄色引入线与停机位框、停止线、白色服务车道线、系留点圆环；
 *  - 服务区（4）：素混凝土分块。
 * 顶点属性 aRw = 铺装类型。抗锯齿：所有条带都按像素足迹（fwidth）做盒式滤波，远处自然淡成平均色，不闪。
 * 共享 STREET_UNIFORMS（湿度 uStreetWet / 细节开关 uStreetDetail）：fx=off 时去掉噪声与轮胎印，只保留标线。
 * 路面网格法线恒为世界 +Y（同 RoadMaterial 的做法，不依赖绕序）。
 */

/** sRGB 十六进制 → GLSL 线性色常量 */
function lin(hex: number): string {
  const c = new THREE.Color(hex)
  return `vec3(${c.r.toFixed(4)}, ${c.g.toFixed(4)}, ${c.b.toFixed(4)})`
}
const f = (n: number) => n.toFixed(2)

export const RW_KIND = { runway: 0, taxiway: 1, connector: 2, apron: 3, service: 4 } as const

const C_RUNWAY = lin(0x46474b), C_TAXI = lin(0x505155), C_APRON = lin(0xa4a29a), C_SERVICE = lin(0x9a988f)
const C_WHITE = lin(0xe8e8e2), C_YELLOW = lin(0xdca524), C_DARK = lin(0x222222)

const standsGlsl = STANDS.map((s) => `vec2(${f(s.x)}, ${f(s.z)})`).join(', ')
const connGlsl = CONNECTORS.map((x) => f(x)).join(', ')

const VERT_PARS = /* glsl */`
attribute float aRw;
varying float vRwKind;
varying vec3 vStreetW;
`
const VERT_MAIN = /* glsl */`
	vRwKind = aRw;
	vStreetW = ( modelMatrix * vec4( transformed, 1.0 ) ).xyz;
`

/** 片元公共函数：盒式滤波条带 / 七段数字 */
const FRAG_PARS = /* glsl */`
varying float vRwKind;
// 区间 [a,b] 在坐标 x 处的覆盖率（fw = 该坐标的像素足迹，显式传入：取模后的坐标求导会在折返处跳变）
float rwB( float x, float a, float b, float fw ) {
	fw = max( fw, 1e-4 );
	return clamp( ( min( x + fw * 0.5, b ) - max( x - fw * 0.5, a ) ) / fw, 0.0, 1.0 );
}
float rwR( vec2 p, vec2 a, vec2 b, vec2 fw ) { return rwB( p.x, a.x, b.x, fw.x ) * rwB( p.y, a.y, b.y, fw.y ); }
// 周期虚线：x 沿线坐标，周期 P、实段 L（从 0 起）
float rwDash( float x, float P, float L, float fw ) {
	float m = mod( x, P );
	// 足迹接近周期时取平均占空比，避免远处摩尔纹
	return mix( max( rwB( m, 0.0, L, fw ), rwB( m, P, P + L, fw ) ), L / P, smoothstep( P * 0.25, P * 0.6, fw ) );
}
// 七段数字：q = 字符局部坐标（x 向右 0..W，y 向上 0..H），笔画宽 s；m = 段位掩码 a1 b2 c4 d8 e16 f32 g64
float rwDigit( vec2 q, int m, vec2 fw ) {
	const float W = 7.0, H = 12.0, s = 1.5;
	float c = 0.0;
	if ( ( m & 1 ) != 0 ) c = max( c, rwR( q, vec2( 0.0, H - s ), vec2( W, H ), fw ) );
	if ( ( m & 2 ) != 0 ) c = max( c, rwR( q, vec2( W - s, H * 0.5 ), vec2( W, H ), fw ) );
	if ( ( m & 4 ) != 0 ) c = max( c, rwR( q, vec2( W - s, 0.0 ), vec2( W, H * 0.5 ), fw ) );
	if ( ( m & 8 ) != 0 ) c = max( c, rwR( q, vec2( 0.0, 0.0 ), vec2( W, s ), fw ) );
	if ( ( m & 16 ) != 0 ) c = max( c, rwR( q, vec2( 0.0, 0.0 ), vec2( s, H * 0.5 ), fw ) );
	if ( ( m & 32 ) != 0 ) c = max( c, rwR( q, vec2( 0.0, H * 0.5 ), vec2( s, H ), fw ) );
	if ( ( m & 64 ) != 0 ) c = max( c, rwR( q, vec2( 0.0, H * 0.5 - s * 0.5 ), vec2( W, H * 0.5 + s * 0.5 ), fw ) );
	return c;
}
// 横向成组的条（|v| 从 v0 起每 pitch 一条、宽 w，共 n 条）
float rwBars( float av, float v0, float pitch, float w, float n, float fw ) {
	if ( av < v0 || av > v0 + pitch * n ) return 0.0;
	return rwDash( av - v0, pitch, w, fw );
}
`

/** 片元主体：算出 diffuseColor 与粗糙度修正（sRoughAdd）、湿度遮罩 sWet */
const FRAG_MAIN = /* glsl */`
	float sRoughAdd = 0.0;
	vec3 sWet = vec3( 0.0 );
	{
		vec2 p = vStreetW.xz;
		vec2 fw = max( fwidth( p ), vec2( 1e-4 ) );
		float pix = length( fw );
		float det = uStreetDetail * smoothstep( 600.0, 30.0, length( vStreetW - cameraPosition ) );
		int kind = int( vRwKind + 0.5 );
		vec3 col;
		float white = 0.0, yellow = 0.0, dark = 0.0;
		if ( kind <= 2 ) {
			// ---- 沥青底色（跑道略深） ----
			col = kind == 0 ? ${C_RUNWAY} : ${C_TAXI};
			float macro = sNoise( p * 0.021 + vec2( 4.0, -9.0 ) );
			float fine = sNoiseAA( p, 2.7, pix );
			col *= 1.0 + uStreetDetail * ( 0.22 * ( macro - 0.5 ) + 0.22 * ( fine - 0.5 ) * det );
		} else {
			// ---- 混凝土分块（停机坪 5 m、服务区 6 m），逐块色差 + 接缝 ----
			float P = kind == 3 ? 5.0 : 6.0;
			col = kind == 3 ? ${C_APRON} : ${C_SERVICE};
			float th = sHash( ivec2( floor( p / P ) ) + ivec2( 17, 3 ) );
			float tileVis = uStreetDetail * ( 1.0 - smoothstep( P * 0.1, P * 0.5, pix ) );
			col *= 1.0 + ( th - 0.5 ) * 0.1 * tileVis;
			col *= 1.0 + uStreetDetail * 0.16 * ( sNoise( p * 0.05 + 7.0 ) - 0.5 );
			col *= 1.0 + 0.12 * uStreetDetail * ( sNoiseAA( p, 3.3, pix ) - 0.5 );
			float joint = max( sGridLine( p.x, P, 0.05 ), sGridLine( p.y, P, 0.05 ) );
			col *= 1.0 - joint * 0.35;
			// 油迹：停机位附近的暗斑
			col *= 1.0 - 0.25 * det * smoothstep( 0.62, 0.9, sNoise( p * 0.35 + vec2( 3.0, 1.0 ) ) );
		}
		if ( kind == 0 ) {
			// ---- 跑道：u 从入口沿跑道向内、v 为飞行员右手侧（两端各自镜像，跑道号不同）----
			bool west = p.x < ${f((RUNWAY.x0 + RUNWAY.x1) / 2)};
			float u = west ? p.x - ${f(RUNWAY.x0)} : ${f(RUNWAY.x1)} - p.x;
			float v = west ? p.y - ${f(RUNWAY.z)} : ${f(RUNWAY.z)} - p.y;
			float fu = fw.x, fv = fw.y;
			float av = abs( v );
			// 边线
			white = max( white, rwB( av, 20.7, 21.6, fv ) );
			// 入口横线 + 斑马键（每侧 6 条，宽 1.8 m）
			white = max( white, rwB( u, 1.0, 2.8, fu ) * rwB( av, 0.0, 21.6, fv ) );
			white = max( white, rwB( u, 6.0, 36.0, fu ) * rwBars( av, 3.0, 3.0, 1.8, 6.0, fv ) );
			// 跑道号：左字在 v<0，右字在 v>0；字的"上"朝跑道内（+u）
			int dl = west ? 63 : 91;   // 0 : 2
			int dr = west ? 111 : 7;   // 9 : 7
			if ( u > 46.0 && u < 60.0 ) {
				white = max( white, rwDigit( vec2( v + 8.5, u - 47.0 ), dl, vec2( fv, fu ) ) );
				white = max( white, rwDigit( vec2( v - 1.5, u - 47.0 ), dr, vec2( fv, fu ) ) );
			}
			// 中线虚线（30 m 实 / 20 m 空）
			white = max( white, rwB( u, 72.0, 600.0, fu ) * rwDash( u - 72.0, 50.0, 30.0, fu ) * rwB( av, 0.0, 0.45, fv ) );
			// 接地区：150 m 处三对、450 m 处两对（22.5 m 长）；瞄准点 250–295 m 实心大块
			white = max( white, rwB( u, 150.0, 172.5, fu ) * rwBars( av, 3.0, 3.0, 1.8, 3.0, fv ) );
			white = max( white, rwB( u, 450.0, 472.5, fu ) * rwBars( av, 3.0, 3.0, 1.8, 2.0, fv ) );
			white = max( white, rwB( u, 250.0, 295.0, fu ) * rwB( av, 4.0, 10.0, fv ) );
			// 轮胎印：接地区中线两侧的深色纵向条纹（细节档）
			float tyre = smoothstep( 0.45, 0.8, sNoise( vec2( u * 0.025, v * 1.3 ) ) ) * smoothstep( 120.0, 180.0, u ) * smoothstep( 560.0, 380.0, u ) * smoothstep( 9.0, 3.0, av );
			col *= 1.0 - 0.45 * tyre * uStreetDetail;
			white *= 1.0 - 0.5 * tyre * uStreetDetail;
		} else if ( kind == 1 ) {
			// ---- 主滑行道（沿 x）：中线、联络道 / 停机位引入线的延伸、双黄边线（在开口处断开） ----
			float v = p.y - ${f(TAXIWAY.z)};
			float av = abs( v );
			yellow = max( yellow, rwB( av, 0.0, 0.15, fw.y ) );
			const float CONN[${CONNECTORS.length}] = float[]( ${connGlsl} );
			const vec2 ST[${STANDS.length}] = vec2[]( ${standsGlsl} );
			bool openS = false, openN = p.x > ${f(APRON.minX)} && p.x < ${f(APRON.maxX)};
			for ( int i = 0; i < ${CONNECTORS.length}; i++ ) {
				float dx = abs( p.x - CONN[i] );
				if ( v > 0.0 ) yellow = max( yellow, rwB( dx, 0.0, 0.15, fw.x ) );
				if ( dx < 9.5 ) openS = true;
			}
			for ( int i = 0; i < ${STANDS.length}; i++ ) if ( v < 0.0 ) yellow = max( yellow, rwB( abs( p.x - ST[i].x ), 0.0, 0.15, fw.x ) );
			float edge = max( rwB( av, 8.0, 8.15, fw.y ), rwB( av, 8.35, 8.5, fw.y ) );
			if ( ( v > 0.0 && !openS ) || ( v < 0.0 && !openN ) ) yellow = max( yellow, edge );
		} else if ( kind == 2 ) {
			// ---- 联络道（沿 z）：中线、双黄边线、等待线 ----
			const float CONN[${CONNECTORS.length}] = float[]( ${connGlsl} );
			float cx = CONN[0];
			for ( int i = 1; i < ${CONNECTORS.length}; i++ ) if ( abs( p.x - CONN[i] ) < abs( p.x - cx ) ) cx = CONN[i];
			float lat = p.x - cx, al = abs( lat );
			yellow = max( yellow, rwB( al, 0.0, 0.15, fw.x ) );
			yellow = max( yellow, max( rwB( al, 8.0, 8.15, fw.x ), rwB( al, 8.35, 8.5, fw.x ) ) );
			// 等待线：滑行道侧（北）两条实线，跑道侧（南）两条虚线
			float h = p.y - ${f(HOLD_SHORT_Z)};
			float across = rwB( al, 0.0, 8.5, fw.x );
			yellow = max( yellow, across * max( rwB( h, -1.05, -0.75, fw.y ), rwB( h, -0.45, -0.15, fw.y ) ) );
			yellow = max( yellow, across * max( rwB( h, 0.15, 0.45, fw.y ), rwB( h, 0.75, 1.05, fw.y ) ) * rwDash( lat + 100.0, 1.8, 0.9, fw.x ) );
		} else if ( kind == 3 ) {
			// ---- 停机坪：引入线、停机位框、停止线、系留点；服务车道白线 ----
			const vec2 ST[${STANDS.length}] = vec2[]( ${standsGlsl} );
			for ( int i = 0; i < ${STANDS.length}; i++ ) {
				vec2 d = p - ST[i];
				vec2 ad = abs( d );
				// 引入线：从滑行道北缘到停机位中心
				yellow = max( yellow, rwB( ad.x, 0.0, 0.15, fw.x ) * rwB( d.y, 0.0, ${f(APRON.maxZ)} - ST[i].y, fw.y ) );
				// 停止线（机头位置）
				yellow = max( yellow, rwB( ad.x, 0.0, 2.5, fw.x ) * rwB( d.y, 4.0, 4.4, fw.y ) );
				// 停机位框 15 × 18 m（翼展 11 m 的轻型机）
				float box = max( rwB( ad.x, 7.35, 7.55, fw.x ) * rwB( d.y, -9.0, 9.0, fw.y ), rwB( ad.y, 8.8, 9.0, fw.y ) * rwB( ad.x, 0.0, 7.55, fw.x ) );
				yellow = max( yellow, box );
				// 系留点：两翼 + 尾部，深色环
				float r1 = length( d - vec2( 5.0, 0.5 ) ), r2 = length( d - vec2( -5.0, 0.5 ) ), r3 = length( d - vec2( 0.0, -5.0 ) );
				float r = min( min( r1, r2 ), r3 );
				dark = max( dark, rwB( r, 0.22, 0.34, pix ) );
			}
			// 机库门前服务车道（两条白实线 + 中间白虚线）
			float sz = p.y - ${f(APRON.minZ)};
			white = max( white, max( rwB( sz, 3.0, 3.15, fw.y ), rwB( sz, 10.0, 10.15, fw.y ) ) );
			white = max( white, rwB( sz, 6.5, 6.65, fw.y ) * rwDash( p.x, 6.0, 3.0, fw.x ) );
		}
		// 标线磨损（细节档）：局部变淡
		float wear = mix( 1.0, 0.75 + 0.25 * sNoiseAA( p * 0.7, 1.0, pix ), det );
		col = mix( col, ${C_WHITE}, white * wear );
		col = mix( col, ${C_YELLOW}, yellow * wear );
		col = mix( col, ${C_DARK}, dark );
		diffuseColor.rgb = col;
		sRoughAdd = -0.12 * max( white, yellow );
		// 湿度：沥青积水、混凝土排水好
		sWet = sWetMasks( sPuddleField( p ), kind >= 3 ? 0.08 : 0.02 );
		diffuseColor.rgb *= mix( 1.0, 0.72, sWet.x ) * mix( 1.0, 0.62, sWet.y ) * mix( 1.0, 0.82, sWet.z );
	}
`

export function patchRunway(sh: { vertexShader: string; fragmentShader: string; uniforms: Record<string, THREE.IUniform> }) {
  sh.uniforms.uStreetWet = STREET_UNIFORMS.uStreetWet
  sh.uniforms.uStreetDetail = STREET_UNIFORMS.uStreetDetail
  sh.vertexShader = sh.vertexShader
    .replace('#include <common>', `#include <common>\n${VERT_PARS}`)
    .replace('#include <project_vertex>', `#include <project_vertex>\n${VERT_MAIN}`)
  sh.fragmentShader = sh.fragmentShader
    .replace('#include <common>', `#include <common>\n${STREET_COMMON_GLSL}\n${FRAG_PARS}`)
    .replace('#include <color_fragment>', `#include <color_fragment>\n${FRAG_MAIN}`)
    .replace('#include <roughnessmap_fragment>', /* glsl */`#include <roughnessmap_fragment>
	roughnessFactor = clamp( roughnessFactor + sRoughAdd, 0.04, 1.0 );
	roughnessFactor = mix( roughnessFactor, 0.4, max( sWet.z * 0.9, sWet.x * 0.8 ) );
	roughnessFactor = mix( roughnessFactor, 0.06, sWet.y );`)
    // 铺装恒水平：法线直接取世界 +Y（不依赖绕序 / faceDirection）
    .replace('#include <normal_fragment_begin>', '#include <normal_fragment_begin>\nnormal = normalize((viewMatrix * vec4(0.0, 1.0, 0.0, 0.0)).xyz);\nnonPerturbedNormal = normal;')
}

/** 机场铺装材质（DoubleSide；轻微 polygonOffset 拉近，压住下方 −0.12 的岛面） */
export function makeRunwayMaterial(): THREE.MeshStandardMaterial {
  const m = new THREE.MeshStandardMaterial({
    color: 0xffffff, roughness: 0.88, metalness: 0, side: THREE.DoubleSide,
    polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -2,
  })
  m.userData.receiveShadow = true
  m.userData.streetWet = true
  m.onBeforeCompile = patchRunway
  m.customProgramCacheKey = () => 'rea-runway-air2'
  return m
}
