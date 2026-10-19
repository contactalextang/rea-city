// 通用平面几何（本地米制 [x, z] 坐标；x 向东为正，z 向南为正）。
// 环（Ring）统一用 Pos[] 表示；本文件的函数对"首尾是否重复"不敏感（会自行处理）。
//
// 方向约定：有符号面积用鞋带公式 A = ½ Σ (x_i·z_{i+1} − x_{i+1}·z_i) 在 (x, z) 平面上直接计算。
// 由于 z 轴指向南（屏幕上北朝上时 z 朝下），(x, z) 平面是一个"左手"平面：
//   A < 0  ⇔  从 +y 向下俯视（北朝上）时为逆时针（CCW）
//   A > 0  ⇔  俯视时为顺时针（CW）
// 外环统一取 CCW（A < 0），孔洞统一取 CW（A > 0）。

export type Pos = [number, number];
export type Ring = Pos[];

/** 鞋带公式有符号面积（见文件头的方向约定），单位 m² */
export function signedArea(ring: Ring): number {
  let a = 0;
  const n = ring.length;
  for (let i = 0; i < n; i++) {
    const [x0, z0] = ring[i];
    const [x1, z1] = ring[(i + 1) % n];
    a += x0 * z1 - x1 * z0;
  }
  return a / 2;
}

/** 绝对面积 m² */
export function area(ring: Ring): number {
  return Math.abs(signedArea(ring));
}

/** 从上俯视是否逆时针（见文件头约定） */
export function isCCW(ring: Ring): boolean {
  return signedArea(ring) < 0;
}

/** 环质心（面积加权；退化环退回顶点平均） */
export function centroid(ring: Ring): Pos {
  const n = ring.length;
  let a = 0;
  let cx = 0;
  let cz = 0;
  for (let i = 0; i < n; i++) {
    const [x0, z0] = ring[i];
    const [x1, z1] = ring[(i + 1) % n];
    const cross = x0 * z1 - x1 * z0;
    a += cross;
    cx += (x0 + x1) * cross;
    cz += (z0 + z1) * cross;
  }
  if (Math.abs(a) < 1e-9) {
    let sx = 0;
    let sz = 0;
    for (const [x, z] of ring) {
      sx += x;
      sz += z;
    }
    return [sx / n, sz / n];
  }
  return [cx / (3 * a), cz / (3 * a)];
}

export interface BBox {
  minX: number;
  minZ: number;
  maxX: number;
  maxZ: number;
}

/** 一个或多个环的轴对齐包围盒 */
export function bbox(rings: Ring[]): BBox {
  let minX = Infinity;
  let minZ = Infinity;
  let maxX = -Infinity;
  let maxZ = -Infinity;
  for (const ring of rings) {
    for (const [x, z] of ring) {
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (z < minZ) minZ = z;
      if (z > maxZ) maxZ = z;
    }
  }
  return { minX, minZ, maxX, maxZ };
}

export function bboxContains(b: BBox, [x, z]: Pos): boolean {
  return x >= b.minX && x <= b.maxX && z >= b.minZ && z <= b.maxZ;
}

/** 射线法：点是否在单个环内（边界上视为内） */
export function pointInRing([px, pz]: Pos, ring: Ring): boolean {
  let inside = false;
  const n = ring.length;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const [xi, zi] = ring[i];
    const [xj, zj] = ring[j];
    if (zi > pz !== zj > pz) {
      const xCross = ((xj - xi) * (pz - zi)) / (zj - zi) + xi;
      if (px < xCross) inside = !inside;
    }
  }
  return inside;
}

/** 点是否在带孔多边形内：在外环内且不在任一孔内 */
export function pointInPolygon(p: Pos, outer: Ring, holes: Ring[] = []): boolean {
  if (!pointInRing(p, outer)) return false;
  for (const h of holes) if (pointInRing(p, h)) return false;
  return true;
}

/**
 * 清理环：去掉与首点重复的闭合点、连续重复点；返回新数组。
 * 返回环顶点数可能 < 3（退化），调用方需自行判断。
 */
export function cleanRing(ring: Ring, eps = 1e-6): Ring {
  const out: Ring = [];
  for (const p of ring) {
    const last = out[out.length - 1];
    if (last && Math.abs(last[0] - p[0]) < eps && Math.abs(last[1] - p[1]) < eps) continue;
    out.push([p[0], p[1]]);
  }
  while (out.length > 1) {
    const a = out[0];
    const b = out[out.length - 1];
    if (Math.abs(a[0] - b[0]) < eps && Math.abs(a[1] - b[1]) < eps) out.pop();
    else break;
  }
  return out;
}

/** 按约定统一方向：ccw=true 要求俯视逆时针（外环），false 要求顺时针（孔洞） */
export function orient(ring: Ring, ccw: boolean): Ring {
  return isCCW(ring) === ccw ? ring : ring.slice().reverse();
}
