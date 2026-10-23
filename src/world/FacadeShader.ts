import * as THREE from 'three'

/**
 * P14.1 程序化外墙（fx=high / low；fx=off 走 BuildingMesh.makeWallMaterial 的 Lambert 底线）。
 *
 * MeshStandardMaterial + onBeforeCompile：不新增灯光、不碰 Atmosphere 的全局片段补丁（CSM / 高度雾自动生效），
 * 整个城市外墙共用一个 program（customProgramCacheKey 'rea-facade'）。思路移植自 Slop New York 的
 * facadeCell / createPreWarBuildingMaterial / createCurtainWallMaterial / evaluateApartmentInterior（TSL → GLSL，大幅简化）。
 *
 * 顶点属性（BuildingMesh.appendBuilding 写入）：
 *   aWall vec4 = (s 沿立面米数, 立面宽 W, 立面随机数, 闭合环标记)；W = 0 表示屋顶。
 *     "立面" = 足迹环上相邻、转角 < 30° 的边合并成的一段（曲线楼的短边连成一整面，窗格连续）；
 *     没有锐角的环（圆楼）整圈一面、无墙角柱（w = 1）。
 *   aBld vec4 = (建筑种子 0–1, 类别 cls, 楼高 H, 色调 0–1)
 * 顶点色 = 外墙底色（BuildingMesh.buildingColor，按建筑 id 确定）。
 *
 * 片元：窗格按立面宽取整（墙角留实心柱、< 2.5 m 的立面当实心墙），窗洞视差凹进 + 窗框 + 一盒房间室内映射
 * （后墙/地板/天花/侧墙 + 窗帘/百叶），白天玻璃靠 Standard 自带 envMap 菲涅尔反射；夜间按随机率亮灯（HDR）。
 * 楼层腰线、窗台（下沿阴影）、窗楣、风化（窗下竖向污渍、近地变暗、檐下 AO 带）、粗糙度分区、dFdx/dFdy 凹凸。
 * 远处一个窗格小于 ~3–7 像素时淡化为平均色/平均亮灯，避免摩尔纹与闪烁。
 *
 * 夜间灯光接口不变：DayNight 对 scene.userData.windows 里的材质写 emissiveIntensity = 1.5·lights，
 * 本材质 emissive 色为白，所以着色器里 emissive.r 就是夜灯强度（0–1.5）。
 */

/** fx 档开关：DayNight 每帧按 settings.fx 写入；ChunkManager 据此在新旧外墙材质间切换 */
export const FACADE = { on: true }

/**
 * 立面网格常量（米）：着色器与 BuildingDetail（P14.2 几何细节件在 JS 端复算窗格/开间）共用的唯一真相。
 * 改这里两边同时生效；GLSL 里通过模板插值写成浮点字面量。
 */
export const FACADE_DIMS = {
  /** 店屋首层（五脚基）顶高；首层顶招牌梁 3.2–3.5 m */
  shopBase: 3.5,
  shopBeam0: 3.2,
  /** 层高基准：HDB / 店屋 / 玻璃塔（+0.5·种子）/ 普通楼（+0.35·种子） */
  floorHdb: 2.8,
  floorShop: 3.4,
  floorGlass: 3.6,
  floorGeneric: 3.05,
  /** 开间基准：HDB 走廊面 / HDB 窗户面 / 店屋 / 玻璃 / 普通楼带形窗 / 普通楼方窗（+0.9·hash） */
  bayHdbCorr: 3.2,
  bayHdb: 2.6,
  bayShop: 5.0,
  bayGlass: 1.5,
  bayRibbon: 1.8,
  bayGeneric: 2.6,
  /** 墙角柱宽：玻璃 / 店屋 / 其它 */
  pierGlass: 0.15,
  pierShop: 0.35,
  pierOther: 0.7,
  /** 顶部女儿墙（不开窗）高度：玻璃 / 其它 */
  parapetGlass: 0.6,
  parapet: 0.9,
  /** HDB 走廊面判定：立面随机 < corrP 且立面宽 > corrMinW；普通楼带形窗判定 fract(seed·3.17) < ribbonP */
  corrP: 0.45,
  corrMinW: 9.0,
  ribbonP: 0.38,
  /** 店屋五脚基拱廊柱宽（开间两侧各一根） */
  arcadeCol: 0.38,
} as const
/** 数字 → GLSL 浮点字面量 */
const gf = (v: number) => (Number.isInteger(v) ? v.toFixed(1) : String(v))
const D = FACADE_DIMS

const FACADE_PARS = /* glsl */`
varying vec4 vFacWall;
varying vec4 vFacBld;
varying vec3 vFacPos;
varying vec3 vFacNrm;

float facH1( float n ) { return fract( sin( n * 12.9898 + 4.1414 ) * 43758.5453 ); }
float facH2( vec2 p ) { return fract( sin( dot( p, vec2( 127.1, 311.7 ) ) ) * 43758.5453 ); }
float facNoise( float x ) { float i = floor( x ), f = fract( x ); f = f * f * ( 3.0 - 2.0 * f ); return mix( facH1( i ), facH1( i + 1.0 ), f ); }
float facNoise2( vec2 p ) {
	vec2 i = floor( p ), f = fract( p ); f = f * f * ( 3.0 - 2.0 * f );
	return mix( mix( facH2( i ), facH2( i + vec2( 1.0, 0.0 ) ), f.x ), mix( facH2( i + vec2( 0.0, 1.0 ) ), facH2( i + vec2( 1.0, 1.0 ) ), f.x ), f.y );
}
// 抗锯齿区间：x ∈ [a, b] 为 1，w = 该坐标的像素宽（fwidth）
float facBand( float x, float a, float b, float w ) { return clamp( min( x - a, b - x ) / max( w, 1e-5 ) + 0.5, 0.0, 1.0 ); }
float facRect( vec2 p, vec4 r, vec2 w ) { return facBand( p.x, r.x, r.y, w.x ) * facBand( p.y, r.z, r.w, w.y ); }
vec3 facLin( vec3 c ) { return pow( c, vec3( 2.2 ) ); }

// 店屋粉彩（每开间一色）
vec3 facShopPal( float h ) {
	if ( h < 0.14 ) return facLin( vec3( 0.86, 0.56, 0.42 ) );
	if ( h < 0.28 ) return facLin( vec3( 0.90, 0.74, 0.42 ) );
	if ( h < 0.42 ) return facLin( vec3( 0.58, 0.76, 0.68 ) );
	if ( h < 0.56 ) return facLin( vec3( 0.88, 0.64, 0.64 ) );
	if ( h < 0.70 ) return facLin( vec3( 0.66, 0.78, 0.86 ) );
	if ( h < 0.84 ) return facLin( vec3( 0.94, 0.88, 0.66 ) );
	return facLin( vec3( 0.78, 0.66, 0.82 ) );
}
// 窗帘布色
vec3 facCurtain( float h ) {
	if ( h < 0.2 ) return facLin( vec3( 0.85, 0.80, 0.68 ) );
	if ( h < 0.4 ) return facLin( vec3( 0.62, 0.30, 0.26 ) );
	if ( h < 0.6 ) return facLin( vec3( 0.30, 0.42, 0.52 ) );
	if ( h < 0.8 ) return facLin( vec3( 0.80, 0.72, 0.50 ) );
	return facLin( vec3( 0.92, 0.92, 0.90 ) );
}
// 灯色：暖（住宅）/ 冷（办公、走廊）
vec3 facLight( float h, float warmth ) {
	vec3 warm = mix( vec3( 1.0, 0.55, 0.22 ), vec3( 1.0, 0.78, 0.48 ), fract( h * 7.1 ) );
	vec3 cool = mix( vec3( 0.80, 0.88, 1.0 ), vec3( 0.95, 0.97, 1.0 ), fract( h * 3.7 ) );
	return h < warmth ? warm : cool;
}

/**
 * 一盒房间的室内映射。g = 玻璃面上的点（窗内米数，原点窗左下），win = 窗宽高，ray = (沿墙, 竖直, 入墙) 视线，
 * floorY = 窗下沿离房间地面的高度，roomH 层净高，D 进深；
 * 返回房间颜色（反照率），lamp 为亮灯时的相对亮度分布（0–1.3）
 */
vec3 facRoom( vec2 g, vec2 win, vec3 ray, float floorY, float roomH, float D, float h, out float lamp ) {
	float roomW = win.x + 1.2;
	vec2 o = vec2( g.x - win.x * 0.5, g.y + floorY - roomH * 0.5 );
	float hw = roomW * 0.5, hh = roomH * 0.5;
	float tx = ( hw - o.x * sign( ray.x ) ) / max( abs( ray.x ), 1e-4 );
	float ty = ( hh - o.y * sign( ray.y ) ) / max( abs( ray.y ), 1e-4 );
	float tz = D / ray.z;
	float t = min( min( tx, ty ), tz );
	vec3 hit = vec3( o + ray.xy * t, ray.z * t );
	vec3 q = clamp( vec3( hit.x / roomW + 0.5, hit.y / roomH + 0.5, hit.z / D ), 0.0, 1.0 );
	vec3 wallC = mix( facLin( vec3( 0.80, 0.76, 0.68 ) ), facLin( vec3( 0.62, 0.68, 0.72 ) ), fract( h * 5.3 ) );
	vec3 floorC = mix( facLin( vec3( 0.42, 0.30, 0.20 ) ), facLin( vec3( 0.62, 0.60, 0.56 ) ), step( 0.5, fract( h * 9.1 ) ) );
	vec3 ceilC = facLin( vec3( 0.86, 0.85, 0.82 ) );
	vec3 c;
	if ( t == tz ) {
		// 后墙：踢脚线 + 随机一件深色家具（柜子/沙发剪影）
		c = wallC * mix( 0.6, 1.0, step( 0.06, q.y ) );
		float fx = fract( h * 13.7 );
		float furn = step( abs( q.x - ( 0.2 + 0.6 * fx ) ), 0.12 + 0.1 * fract( h * 3.3 ) ) * step( q.y, 0.25 + 0.4 * fract( h * 21.1 ) );
		c = mix( c, facLin( vec3( 0.22, 0.18, 0.16 ) ), furn * 0.85 );
		lamp = 0.85;
	} else if ( t == ty ) {
		if ( ray.y < 0.0 ) { c = floorC; lamp = 0.55; }
		else {
			c = ceilC;
			float r = length( vec2( q.x - 0.5, q.z - 0.45 ) );
			lamp = 1.0 + 1.0 * smoothstep( 0.16, 0.05, r );
		}
	} else {
		c = wallC * 0.85; lamp = 0.7;
	}
	// 越往里越暗（白天只有窗口进光）
	c *= mix( 1.0, 0.45, q.z );
	return c;
}
`

/** 主体：按风格计算外墙反照率/粗糙度/金属度/自发光/凹凸高度（米）。fw = (沿墙, 竖直) 每像素米数 */
const FACADE_EVAL = /* glsl */`
void facadeEval( vec3 baseCol, vec2 fw, float night, out vec3 alb, out float rough, out float metal, out vec3 emit, out float hgt, out float lodOut ) {
	float s = vFacWall.x, W = vFacWall.y, runSeed = vFacWall.z, closedLoop = vFacWall.w;
	float seed = vFacBld.x, cls = floor( vFacBld.y + 0.5 ), H = vFacBld.z, tone = vFacBld.w;
	float y = vFacPos.y;
	alb = baseCol; rough = 0.88; metal = 0.0; emit = vec3( 0.0 ); hgt = 0.0; lodOut = 1.0;

	// —— 屋顶：混凝土 + 低频污迹 ——
	if ( W < 0.01 ) {
		float n = facNoise2( vFacPos.xz * 0.35 + seed * 31.0 ) * 0.6 + facNoise2( vFacPos.xz * 1.7 ) * 0.4;
		alb = baseCol * ( 0.8 + 0.3 * n );
		rough = 0.93;
		if ( cls == 2.0 ) {
			// 店屋：赤陶瓦屋面（瓦垄条纹，方向取世界 x/z 中较近的一条，粗略即可）
			float tl = 0.8 + 0.2 * smoothstep( 0.3, 0.7, fract( ( vFacPos.x + vFacPos.z ) * 3.0 ) );
			alb = facLin( vec3( 0.66, 0.36, 0.24 ) ) * ( 0.8 + 0.35 * n ) * mix( tl, 0.9, clamp( fw.x * 3.0, 0.0, 1.0 ) );
			rough = 0.8;
		}
		return;
	}

	bool isHdb = cls == 1.0, isShop = cls == 2.0, isGlass = cls == 3.0;
	// HDB 两种立面：走廊面（横向栏板带）/ 窗户面
	bool corridor = isHdb && runSeed < ${gf(D.corrP)} && W > ${gf(D.corrMinW)};
	// 普通楼：带形窗 / 方窗
	bool ribbon = !isHdb && !isShop && !isGlass && fract( seed * 3.17 ) < ${gf(D.ribbonP)};

	// —— 风格参数 ——
	float floorT = isHdb ? ${gf(D.floorHdb)} : isShop ? ${gf(D.floorShop)} : isGlass ? ${gf(D.floorGlass)} + 0.5 * seed : ${gf(D.floorGeneric)} + 0.35 * seed;
	float yBase = isShop ? ${gf(D.shopBase)} : 0.0;               // 店屋底层五脚基另算
	float parapet = isGlass ? ${gf(D.parapetGlass)} : ${gf(D.parapet)};
	// 层高按楼高取整（顶层不被女儿墙切半）：可用高度 / 层数，层高偏差超过 ±30% 时退回标准层高
	float avail = H - yBase - parapet;
	float nFloors = max( floor( avail / floorT + 0.5 ), 1.0 );
	float floorH = avail / nFloors;
	if ( floorH < floorT * ( nFloors < 1.5 ? 0.55 : 0.72 ) || floorH > floorT * 1.35 ) floorH = floorT;
	float bayT = isHdb ? ( corridor ? ${gf(D.bayHdbCorr)} : ${gf(D.bayHdb)} ) : isShop ? ${gf(D.bayShop)} : isGlass ? ${gf(D.bayGlass)} : ( ribbon ? ${gf(D.bayRibbon)} : ${gf(D.bayGeneric)} + 0.9 * fract( seed * 7.3 ) );
	float pierT = isGlass ? ${gf(D.pierGlass)} : isShop ? ${gf(D.pierShop)} : ${gf(D.pierOther)};
	float pier = closedLoop > 0.5 ? 0.0 : min( pierT, W * 0.2 );
	float inner = W - 2.0 * pier;
	float bays = max( floor( inner / bayT + 0.5 ), 1.0 );
	float bw = inner / bays;
	float gu = ( s - pier ) / bw;
	float bayI = floor( gu );
	float xm = fract( gu ) * bw;                    // 开间内横向米数
	float fy = ( y - yBase ) / floorH;
	float floorI = floor( fy );
	float ym = fract( fy ) * floorH;                // 层内竖向米数
	vec2 cellId = vec2( bayI + floor( runSeed * 97.0 ) * 131.0, floorI ) + seed * 57.0;
	float hc = facH2( cellId );

	// 远处 LOD：开间宽 / 层高小于 ~7 像素开始淡化，~3 像素完全取平均；横竖分开（街面掠射角下开间先糊，楼层线仍保留）
	float lodU = 1.0 - smoothstep( 3.0, 7.0, bw / max( fw.x, 1e-5 ) );
	float lodV = 1.0 - smoothstep( 3.0, 7.0, floorH / max( fw.y, 1e-5 ) );
	float lod = max( lodU, lodV );
	lodOut = lod;

	// 实心区：短立面、墙角柱、顶层女儿墙（层顶超过檐口的那一层不开窗）
	float topY = H - parapet;
	float solid = ( W < 2.5 || s < pier || s > W - pier || yBase + ( floorI + 1.0 ) * floorH > topY + 0.02 ) ? 1.0 : 0.0;
	if ( isShop && y < yBase ) solid = ( W < 2.5 || s < pier || s > W - pier ) ? 1.0 : 0.0;

	// 墙面底色：店屋每开间换色；普通楼按色调微调
	vec3 wallC = baseCol;
	if ( isShop ) wallC = mix( baseCol, facShopPal( facH2( vec2( bayI, floor( runSeed * 53.0 ) ) + seed * 11.0 ) ), 0.7 );
	// 风化：低频污迹
	float grime = facNoise2( vec2( s * 0.22, y * 0.09 ) + seed * 13.0 );
	wallC *= 0.9 + 0.14 * grime;

	// —— 窗洞（层内矩形，米）+ 凹进深度 + 窗框色 ——
	vec4 win = vec4( 0.0 );        // x0, x1, y0, y1
	float depth = 0.14, frameW = 0.05;
	vec3 frameC = facLin( vec3( 0.28, 0.29, 0.30 ) );
	float litP = 0.45, warmth = 0.75, cov = 0.0;
	bool shutters = false, arcade = false;
	if ( isGlass ) {
		win = vec4( 0.03, bw - 0.03, 0.95, floorH - 0.04 );
		depth = 0.03; frameW = 0.0; litP = 0.55; warmth = 0.15;
	} else if ( isShop ) {
		if ( y < yBase ) {
			arcade = true;
		} else {
			// 每开间两扇竖长窗，靠近开间中心的一扇偏左一扇偏右
			float ww = min( 1.15, bw * 0.22 );
			float cx = xm < bw * 0.5 ? bw * 0.3 : bw * 0.7;
			win = vec4( cx - ww * 0.5, cx + ww * 0.5, 0.55, floorH - 0.5 );
			depth = 0.18; frameC = facLin( vec3( 0.86, 0.84, 0.78 ) );
			shutters = facH2( cellId + vec2( step( bw * 0.5, xm ), 3.0 ) ) < 0.55;
			litP = 0.4; warmth = 0.9;
		}
	} else if ( isHdb ) {
		if ( corridor ) {
			win = vec4( 0.14, bw - 0.14, 1.05, floorH - 0.32 );
			depth = 1.6; frameW = 0.0; litP = 1.0; warmth = 0.0;
		} else {
			float ww = min( 1.4, bw * 0.52 );
			win = vec4( ( bw - ww ) * 0.5, ( bw + ww ) * 0.5, 0.95, 2.2 );
			frameC = facLin( vec3( 0.88, 0.88, 0.86 ) );
			litP = 0.6; warmth = 0.8;
		}
	} else {
		if ( floorI < 0.5 ) {
			win = vec4( 0.12, bw - 0.12, 0.08, floorH - 0.55 );     // 底层店面/大堂玻璃
			litP = 0.7; warmth = 0.6;
		} else if ( ribbon ) {
			win = vec4( 0.04, bw - 0.04, 0.95, floorH - 0.38 );
			depth = 0.08; litP = 0.45; warmth = 0.35;
		} else {
			float ww = clamp( bw * 0.55, 0.9, 1.8 );
			win = vec4( ( bw - ww ) * 0.5, ( bw + ww ) * 0.5, 0.9, min( floorH - 0.5, 2.45 ) );
			frameC = mix( frameC, facLin( vec3( 0.85, 0.85, 0.83 ) ), step( 0.5, fract( seed * 5.7 ) ) );
			litP = 0.45; warmth = 0.7;
		}
	}
	if ( !arcade ) cov = solid > 0.5 ? 0.0 : ( win.y - win.x ) * ( win.w - win.z ) / ( bw * floorH );

	vec2 p = vec2( xm, ym );
	float inWin = solid > 0.5 || arcade ? 0.0 : facRect( p, win, fw );

	// —— 视线（墙切向 t、法线 n）——
	vec3 n = normalize( vFacNrm );
	vec3 tng = vec3( n.z, 0.0, - n.x );
	vec3 rd = normalize( vFacPos - cameraPosition );
	vec3 ray = vec3( dot( rd, tng ), rd.y, max( - dot( rd, n ), 0.08 ) );

	// —— 墙面细节：腰线 / 窗台 / 窗楣 / 壁柱 / 檐口 ——
	vec3 c = wallC;
	if ( isGlass ) {
		// 幕墙：楼层间深色窗间墙（不透明玻璃/铝板）
		c = mix( baseCol * 0.35, facLin( vec3( 0.10, 0.11, 0.12 ) ), 0.5 );
		rough = 0.3; metal = 0.4;
	} else if ( isShop && !arcade && solid < 0.5 ) {
		// 壁柱（开间两侧）+ 每层檐口线脚
		float pil = 1.0 - facBand( xm, 0.24, bw - 0.24, fw.x );
		c = mix( c, c * 1.12, pil ); hgt += 0.08 * pil;
		float corn = facBand( ym, floorH - 0.3, floorH + 0.1, fw.y );
		c = mix( c, mix( c, vec3( 0.85 ), 0.35 ), corn ); hgt += 0.07 * corn;
		c *= 1.0 - 0.3 * facBand( ym, floorH - 0.42, floorH - 0.3, fw.y );
		// 窗下装饰板
		float panel = facBand( ym, 0.15, 0.6, fw.y ) * facBand( xm, win.x, win.y, fw.x );
		c *= 1.0 - 0.12 * panel; hgt -= 0.02 * panel;
	} else if ( !arcade ) {
		// 楼层板/腰线：层顶一条浅色带 + 下方细阴影
		float slab = facBand( ym, floorH - ( isHdb ? 0.2 : 0.16 ), floorH + 0.1, fw.y ) + facBand( ym, -0.1, 0.0, fw.y );
		c = mix( c, c * 1.1, slab ); hgt += 0.04 * slab;
		if ( corridor ) {
			// 走廊栏板带：亮色实心栏板 + 顶部压顶线
			float para = facBand( ym, 0.0, 1.05, fw.y );
			c = mix( c, c * 1.06, para );
			float cap = facBand( ym, 0.95, 1.05, fw.y );
			c = mix( c, vec3( 0.85 ), cap * 0.4 ); hgt += 0.08 * para;
			// 走廊柱（开间两侧）
			float col = 1.0 - facBand( xm, 0.14, bw - 0.14, fw.x );
			hgt += 0.05 * col * ( 1.0 - para );
		}
	}
	if ( !arcade && !isGlass && !corridor && solid < 0.5 ) {
		// 窗台：下沿外挑 6 cm、比窗宽 10 cm，下方 25 cm 阴影
		float wx = facBand( xm, win.x - 0.1, win.y + 0.1, fw.x );
		float sill = wx * facBand( ym, win.z - 0.07, win.z, fw.y );
		c = mix( c, c * 1.15, sill ); hgt += 0.06 * sill;
		float sh = wx * facBand( ym, win.z - 0.3, win.z - 0.07, fw.y ) * smoothstep( win.z - 0.32, win.z - 0.07, ym );
		c *= 1.0 - 0.25 * sh;
		// 窗楣
		float lint = facBand( xm, win.x - 0.05, win.y + 0.05, fw.x ) * facBand( ym, win.w, win.w + 0.1, fw.y );
		c = mix( c, c * 0.92, lint ); hgt += 0.03 * lint;
		// 窗下竖向污渍：沿墙噪声 × 离窗台越远越淡
		float st = facNoise( s * 5.0 + seed * 40.0 );
		float k = facBand( xm, win.x, win.y, fw.x ) * ( 1.0 - clamp( ( win.z - ym ) / 1.6, 0.0, 1.0 ) ) * step( ym, win.z - 0.07 );
		c *= 1.0 - 0.22 * st * st * k;
		// HDB 晾衣杆：部分窗下挂几件衣服（小色块）
		if ( isHdb && hc < 0.3 ) {
			float span = ( win.y - win.x ) / 3.0;
			float k3 = floor( ( xm - win.x ) / span );
			float hh = facH2( cellId + k3 * 7.3 );
			float len = 0.25 + 0.3 * hh;
			float cx0 = win.x + ( k3 + 0.15 ) * span, cx1 = win.x + ( k3 + 0.85 ) * span;
			float cloth = step( 0.25, hh ) * facBand( xm, cx0, cx1, fw.x ) * facBand( ym, win.z - 0.08 - len, win.z - 0.1, fw.y ) * step( 0.0, k3 ) * step( k3, 2.0 );
			c = mix( c, facCurtain( fract( hh * 7.7 ) ) * 0.9, cloth );
			float pole = facBand( xm, win.x - 0.15, win.y + 0.15, fw.x ) * facBand( ym, win.z - 0.11, win.z - 0.08, fw.y );
			c = mix( c, vec3( 0.5 ), pole );
		}
	}

	// 墙面（不含窗/拱内）快照，供远处平均
	vec3 cWall = c; float rWall = rough, mWall = metal;

	// —— 店屋五脚基：柱 + 拱券开口，进深 2.4 m 后是店面玻璃 / 卷闸门 ——
	if ( arcade && solid < 0.5 ) {
		float colW = ${gf(D.arcadeCol)};
		float cu = ( xm - colW ) / ( bw - 2.0 * colW );
		float archTop = 2.75 + 0.45 * sqrt( max( 0.0, 1.0 - pow( ( cu - 0.5 ) / 0.5, 2.0 ) ) );
		float open = facBand( xm, colW, bw - colW, fw.x ) * facBand( y, -1.0, archTop, fw.y );
		// 底层檐口/招牌梁（3.2–3.5 m）
		float beam = facBand( y, ${gf(D.shopBeam0)}, ${gf(D.shopBase)}, fw.y );
		c = mix( c, c * 0.85, beam ); hgt += 0.05 * beam;
		hgt -= 0.25 * open;
		// 拱内：视差到店面平面
		float D = 2.4;
		vec2 b = vec2( xm + ray.x / ray.z * D, y + ray.y / ray.z * D );
		float sh = facH2( cellId + vec2( 5.0, 9.0 ) );
		vec3 back;
		vec3 be = vec3( 0.0 );
		if ( b.y > 3.0 ) back = facLin( vec3( 0.18, 0.17, 0.16 ) );           // 廊顶
		else if ( b.y < 0.0 ) back = facLin( vec3( 0.45, 0.42, 0.40 ) ) * 0.6; // 廊地（地砖）
		else if ( sh < 0.62 ) {
			// 店面：门楣招牌带 + 玻璃（里面货架剪影）
			if ( b.y > 2.45 ) { back = facShopPal( fract( sh * 9.3 ) ) * 0.7; be = back * 0.8; }
			else {
				float shelf = step( 0.5, fract( b.y * 2.2 ) ) * step( 0.6, b.y );
				back = mix( facLin( vec3( 0.30, 0.27, 0.22 ) ), facLin( vec3( 0.12, 0.11, 0.10 ) ), shelf );
				be = facLin( vec3( 1.0, 0.82, 0.55 ) ) * ( 0.9 - 0.4 * shelf );
			}
		} else {
			// 卷闸门：灰蓝横纹
			float ln = 0.75 + 0.25 * step( 0.5, fract( b.y * 9.0 ) );
			back = facLin( vec3( 0.50, 0.53, 0.56 ) ) * ln;
			be = b.y > 2.45 ? facShopPal( fract( sh * 5.1 ) ) * 0.5 : vec3( 0.0 );
		}
		back *= 0.45;      // 廊下常年阴影
		// 拱门内侧（视差点仍落在柱上 → 看到柱侧面）
		float side = 1.0 - facBand( b.x, colW, bw - colW, 1e-3 );
		back = mix( back, wallC * 0.4, side );
		be *= 1.0 - side;
		c = mix( c, back, open );
		emit += be * open * night * 0.9;
		rough = mix( rough, 0.6, open );
		float aCov = 0.6;
		cov = aCov; litP = 0.62 * 0.6; warmth = 1.0;
	}

	// —— 窗内：视差（凹进 depth）→ 窗框 → 玻璃 + 室内 ——
	if ( inWin > 0.0 ) {
		vec2 wsz = win.yw - win.xz;
		vec2 g = p - win.xz + ray.xy / ray.z * depth;   // 玻璃面上的点（窗内米数）
		float inGlass = facRect( g, vec4( 0.0, wsz.x, 0.0, wsz.y ), fw );
		vec3 glassC;
		vec3 ge = vec3( 0.0 );
		float gRough = 0.08, gMetal = 0.0;
		float lit = step( hc, litP );
		vec3 lc = facLight( fract( hc * 17.3 ), warmth );
		if ( corridor ) {
			// HDB 走廊：后墙 + 每户小窗 / 铁门，走廊天花灯（夜间整条亮冷白）
			vec3 bk = wallC * 0.62;
			float dw = facRect( g, vec4( wsz.x * 0.25, wsz.x * 0.55, 0.3, wsz.y - 0.2 ), fw * 2.0 );
			bk = mix( bk, facLin( vec3( 0.12, 0.13, 0.15 ) ), dw );
			float ceil = smoothstep( wsz.y - 0.35, wsz.y, g.y );
			bk *= 1.0 - 0.45 * ceil;
			glassC = bk; gRough = 0.85;
			ge = lc * ( 0.35 + 0.5 * ceil ) * 0.5 + dw * facLight( hc, 0.85 ) * step( hc, 0.55 ) * 0.9;
		} else if ( shutters ) {
			// 店屋百叶窗（绿/棕），横向叶片
			vec3 sc = fract( seed * 9.1 ) < 0.6 ? facLin( vec3( 0.24, 0.42, 0.30 ) ) : facLin( vec3( 0.40, 0.27, 0.17 ) );
			float slat = 0.7 + 0.3 * smoothstep( 0.2, 0.8, fract( g.y * 11.0 ) );
			float mid = 1.0 - facBand( g.x, wsz.x * 0.5 - 0.02, wsz.x * 0.5 + 0.02, fw.x ) * 0.6;
			glassC = sc * mix( slat, 0.85, lod ) * mid; gRough = 0.7;
			ge = lc * lit * 0.08;
		} else {
			float lamp;
			float roomH = floorH - 0.25;
			vec3 room = facRoom( g, wsz, ray, isShop ? 0.7 : win.z, roomH, isGlass ? 6.0 : 4.0, hc, lamp );
			// 窗帘（住宅）/ 百叶帘（办公）
			float hcur = fract( hc * 31.7 );
			vec2 wu = g / wsz;
			float cl = hcur < 0.7 ? 0.08 + 0.3 * fract( hc * 41.3 ) : 0.0;
			float cr = hcur < 0.7 ? 0.08 + 0.3 * fract( hc * 23.9 ) : 0.0;
			float curtain = isGlass || ( ribbon && floorI > 0.5 ) ? 0.0 : max( facBand( wu.x, -1.0, cl, fw.x / wsz.x ), facBand( wu.x, 1.0 - cr, 2.0, fw.x / wsz.x ) );
			float drop = ( isGlass || ribbon ) ? fract( hc * 61.1 ) * 0.7 : 0.0;
			float blind = facBand( wu.y, 1.0 - drop, 2.0, fw.y / wsz.y );
			vec3 curC = facCurtain( fract( hc * 11.3 ) );
			float fold = 0.8 + 0.2 * sin( g.x * 40.0 );
			room = mix( room, curC * mix( fold, 0.9, lod ), curtain );
			float bl = 0.75 + 0.25 * step( 0.5, fract( g.y * 25.0 ) );
			room = mix( room, facLin( vec3( 0.82 ) ) * mix( bl, 0.9, lod ), blind );
			// 白天：室内很暗（只吃窗口进光），反射交给 envMap 菲涅尔
			glassC = room * ( isGlass ? 0.18 : 0.32 );
			float cover = max( curtain, blind );
			ge = room * lc * lit * mix( lamp, 0.45, cover ) * ( isGlass ? 1.1 : 1.0 );
			// 窗楣阴影：玻璃上部 0.25 m 暗一些
			glassC *= 1.0 - 0.35 * smoothstep( wsz.y - 0.3, wsz.y, g.y );
			gRough = mix( 0.06, 0.12, fract( seed * 3.3 ) );
			if ( isGlass ) { glassC = mix( glassC, baseCol * 0.55, 0.65 ); gMetal = 0.5; gRough = 0.05; }
			// 窗中梃（宽窗加一根竖梃 + 横档）
			if ( !isGlass && wsz.x > 1.25 ) {
				float mull = facBand( g.x, wsz.x * 0.5 - 0.025, wsz.x * 0.5 + 0.025, fw.x ) + facBand( g.y, wsz.y * 0.72 - 0.025, wsz.y * 0.72 + 0.025, fw.y );
				mull = clamp( mull, 0.0, 1.0 ) * ( 1.0 - lod );
				glassC = mix( glassC, frameC, mull ); ge *= 1.0 - mull; gRough = mix( gRough, 0.5, mull );
			}
		}
		// 窗框（玻璃面四周 frameW 宽）
		if ( frameW > 0.0 ) {
			float fr = 1.0 - facRect( g, vec4( frameW, wsz.x - frameW, frameW, wsz.y - frameW ), fw );
			fr *= inGlass;
			glassC = mix( glassC, frameC, fr ); ge *= 1.0 - fr; gRough = mix( gRough, 0.45, fr ); gMetal = mix( gMetal, 0.0, fr );
		}
		// 视差点落在玻璃外 → 看到窗洞侧壁（阴影里的墙）
		vec3 reveal = wallC * ( g.y > wsz.y ? 0.35 : 0.6 );
		glassC = mix( reveal, glassC, inGlass );
		ge *= inGlass;
		gRough = mix( 0.85, gRough, inGlass );
		gMetal *= inGlass;
		c = mix( c, glassC, inWin );
		rough = mix( rough, gRough, inWin );
		metal = mix( metal, gMetal, inWin );
		emit += ge * inWin * night;
		hgt -= min( depth, 0.15 ) * inWin;
	}

	// 幕墙竖梃/横档（铝，金属）
	if ( isGlass && solid < 0.5 ) {
		float mu = 1.0 - facBand( xm, 0.035, bw - 0.035, fw.x );
		float tr = facBand( ym, 0.88, 0.95, fw.y ) + facBand( ym, floorH - 0.03, floorH + 0.1, fw.y );
		float m = clamp( mu + tr, 0.0, 1.0 ) * ( 1.0 - lod );
		c = mix( c, facLin( vec3( 0.55, 0.57, 0.60 ) ), m );
		rough = mix( rough, 0.35, m ); metal = mix( metal, 0.8, m );
		emit *= 1.0 - m;
		hgt += 0.05 * m;
	}

	// —— 远处 LOD：横向先退化为"按层的横带平均"（窗带 × 开间覆盖率），竖向再退化为整面平均 ——
	if ( lod > 0.0 && solid < 0.5 ) {
		vec3 avgGlass = isGlass ? baseCol * 0.42 : ( isShop ? mix( facLin( vec3( 0.3, 0.32, 0.26 ) ), wallC * 0.3, 0.5 ) : facLin( vec3( 0.12, 0.13, 0.15 ) ) );
		if ( corridor ) avgGlass = wallC * 0.5;
		if ( arcade ) avgGlass = wallC * 0.12;
		float glassR = isGlass ? 0.12 : 0.35, glassM = isGlass ? 0.45 : 0.0;
		vec3 lightAvg = litP * facLight( 0.5 * warmth, warmth ) * night * ( corridor ? 0.45 : 0.5 );
		float covU = arcade ? 0.8 : ( win.y - win.x ) / bw;
		float kr = covU * ( arcade ? facBand( y, -1.0, 2.9, fw.y ) : facBand( ym, win.z, win.w, fw.y ) );
		c = mix( c, mix( cWall, avgGlass, kr ), lodU );
		rough = mix( rough, mix( rWall, glassR, kr ), lodU );
		metal = mix( metal, mix( mWall, glassM, kr ), lodU );
		emit = mix( emit, kr * lightAvg, lodU );
		c = mix( c, mix( cWall, avgGlass, cov ), lodV );
		rough = mix( rough, mix( rWall, glassR, cov ), lodV );
		metal = mix( metal, mix( mWall, glassM, cov ), lodV );
		emit = mix( emit, cov * lightAvg, lodV );
	}

	// —— 风化 / 环境遮蔽 ——
	// 檐口压顶（顶部 0.3 m 浅色）+ 下方 AO 带
	float coping = smoothstep( H - 0.32, H - 0.28, y );
	c = mix( c, mix( wallC, vec3( 0.8 ), 0.3 ), coping * ( isGlass ? 0.5 : 1.0 ) );
	hgt += 0.06 * coping;
	float ao = mix( 0.7, 1.0, smoothstep( 0.0, 1.2, H - 0.3 - y ) );
	// 近地 1 m 变暗（泥水溅）+ 地面接触阴影
	float splash = mix( 0.7, 1.0, smoothstep( 0.0, 1.0, y + 0.25 * facNoise( s * 1.3 + seed * 7.0 ) ) );
	c *= mix( 1.0, ao, 1.0 - coping ) * splash;

	alb = c;
	hgt *= 1.0 - lod;
}
`

/** 外墙材质（顶点色 = 墙底色；emissive 白色，DayNight 写 emissiveIntensity 驱动夜灯） */
export function makeFacadeMaterial(): THREE.MeshStandardMaterial {
  const m = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.88, metalness: 0, emissive: 0xffffff, emissiveIntensity: 0 })
  m.name = 'facade'
  m.onBeforeCompile = (sh) => {
    const need = (src: string, s: string) => { if (!src.includes(s)) throw new Error('[Facade] three 着色器已变化，找不到：' + s) }
    for (const a of ['#include <common>', '#include <begin_vertex>']) need(sh.vertexShader, a)
    for (const a of ['#include <common>', '#include <color_fragment>', '#include <roughnessmap_fragment>', '#include <metalnessmap_fragment>', '#include <normal_fragment_maps>', '#include <emissivemap_fragment>']) need(sh.fragmentShader, a)
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', `#include <common>
attribute vec4 aWall;
attribute vec4 aBld;
varying vec4 vFacWall;
varying vec4 vFacBld;
varying vec3 vFacPos;
varying vec3 vFacNrm;`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>
vFacWall = aWall;
vFacBld = aBld;
vFacPos = ( modelMatrix * vec4( transformed, 1.0 ) ).xyz;
vFacNrm = normalize( mat3( modelMatrix ) * objectNormal );`)
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\n' + FACADE_PARS + FACADE_EVAL)
      .replace('#include <color_fragment>', `#include <color_fragment>
	// 夜灯强度：emissive 色为白，DayNight 写 emissiveIntensity = 1.5·lights
	float facNight = emissive.r;
	// 每像素米数：用世界坐标导数（连续，不受立面接缝处 s 跳变影响）
	vec2 facFw = vec2( length( fwidth( vFacPos.xz ) ), fwidth( vFacPos.y ) );
	vec3 facAlb; vec3 facEmit; float facRough; float facMetal; float facH; float facLod;
	facadeEval( diffuseColor.rgb, facFw, facNight, facAlb, facRough, facMetal, facEmit, facH, facLod );
	diffuseColor.rgb = facAlb;`)
      .replace('#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>\n\troughnessFactor = facRough;')
      .replace('#include <metalnessmap_fragment>', '#include <metalnessmap_fragment>\n\tmetalnessFactor = facMetal;')
      .replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>
	{
		// 基于导数的凹凸（高度单位：米）：窗洞/窗台/腰线/壁柱的边缘出现受光/背光细线
		vec3 dpx = dFdx( - vViewPosition ), dpy = dFdy( - vViewPosition );
		float dhx = dFdx( facH ), dhy = dFdy( facH );
		vec3 r1 = cross( dpy, normal ), r2 = cross( normal, dpx );
		float det = dot( dpx, r1 );
		vec3 grad = sign( det ) * ( dhx * r1 + dhy * r2 );
		normal = normalize( abs( det ) * normal - grad * 0.3 );
	}`)
      .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\n\ttotalEmissiveRadiance = facEmit;')
  }
  m.customProgramCacheKey = () => 'rea-facade'
  return m
}
