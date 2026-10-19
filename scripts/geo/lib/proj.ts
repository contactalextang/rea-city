// 本地米制坐标投影（等距圆柱近似，切片仅 4.8 km × 2.8 km，误差可忽略）。
// x 向东为正，z 向南为正（北为 −z），与 Three.js 的 XZ 地面平面习惯一致。

export const BBOX = {
  west: 103.825,
  south: 1.27,
  east: 103.868,
  north: 1.295,
} as const;

export const ORIGIN = { lon: 103.8465, lat: 1.2825 } as const;

const DEG_TO_RAD = Math.PI / 180;
/** 1 度纬度对应的米数 */
export const M_PER_DEG_LAT = 110574;
/** 1 度经度在原点纬度处对应的米数 */
export const M_PER_DEG_LON = 111320 * Math.cos(ORIGIN.lat * DEG_TO_RAD);

/** 经纬度 → 本地米制 [x, z] */
export function proj(lon: number, lat: number): [number, number] {
  return [(lon - ORIGIN.lon) * M_PER_DEG_LON, (ORIGIN.lat - lat) * M_PER_DEG_LAT];
}

/** 本地米制 [x, z] → 经纬度 [lon, lat] */
export function unproj(x: number, z: number): [number, number] {
  return [ORIGIN.lon + x / M_PER_DEG_LON, ORIGIN.lat - z / M_PER_DEG_LAT];
}

/** bbox 在本地坐标系中的范围（矩形；投影是线性的，所以仍是轴对齐矩形） */
export const LOCAL_BBOX = (() => {
  const [x0, zSouth] = proj(BBOX.west, BBOX.south);
  const [x1, zNorth] = proj(BBOX.east, BBOX.north);
  return {
    minX: Math.min(x0, x1),
    maxX: Math.max(x0, x1),
    minZ: Math.min(zSouth, zNorth),
    maxZ: Math.max(zSouth, zNorth),
  };
})();

/** `ogr2ogr -spat` 用的参数顺序：xmin ymin xmax ymax */
export const SPAT_ARGS = [BBOX.west, BBOX.south, BBOX.east, BBOX.north].map(String);
