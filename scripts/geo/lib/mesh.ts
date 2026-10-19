// 路面网格生成的几何辅助：折线带状多边形（斜接 / 截角）、圆帽、矩形、多边形布尔运算封装、earcut 三角化。
// 坐标为本地米制 [x, z]；"右侧"法线取 (-dz, dx)，与 src/world/RoadGraph.ts 的 rx/rz 一致。
import earcut from 'earcut';
import polygonClipping from 'polygon-clipping';

export type Pair = [number, number];
export type Ring = Pair[];
export type Polygon = Ring[];
export type MultiPolygon = Polygon[];

export interface BBox {
  minX: number;
  minZ: number;
  maxX: number;
  maxZ: number;
}

export function ringBBox(ring: Ring): BBox {
  let minX = Infinity, minZ = Infinity, maxX = -Infinity, maxZ = -Infinity;
  for (const [x, z] of ring) {
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (z < minZ) minZ = z;
    if (z > maxZ) maxZ = z;
  }
  return { minX, minZ, maxX, maxZ };
}

/** 去掉折线中距离 < eps 的连续重复点 */
export function dedupePolyline(pts: ArrayLike<number>, eps = 0.05): Pair[] {
  const out: Pair[] = [];
  for (let k = 0; k + 1 < pts.length; k += 2) {
    const x = pts[k], z = pts[k + 1];
    const last = out[out.length - 1];
    if (last && Math.hypot(last[0] - x, last[1] - z) < eps) continue;
    out.push([x, z]);
  }
  return out;
}

/**
 * 折线 → 带状多边形（左右各 halfW）。折点处斜接；斜接比 > MITER_LIMIT 时截角。
 * 若某侧偏移后出现"回折"（短段 + 急弯导致自交），则退回为"每段矩形 + 折点圆盘"的多个多边形，
 * 由调用方交给 polygon-clipping 并集处理，保证结果稳健。
 */
export function stripPolygons(line: Pair[], halfW: number, miterLimit = 2): Ring[] {
  const n = line.length;
  if (n < 2 || halfW <= 0) return [];
  // 各段单位方向与右法线
  const dx: number[] = [], dz: number[] = [], nx: number[] = [], nz: number[] = [];
  for (let k = 0; k + 1 < n; k++) {
    const ddx = line[k + 1][0] - line[k][0];
    const ddz = line[k + 1][1] - line[k][1];
    const l = Math.hypot(ddx, ddz) || 1;
    dx.push(ddx / l);
    dz.push(ddz / l);
    nx.push(-ddz / l);
    nz.push(ddx / l);
  }
  const left: Pair[] = [];
  const right: Pair[] = [];
  // 每个偏移点之后应沿哪一段前进（-1 表示该点到下一点是截角边，不检测）
  const segAfter: number[] = [];
  for (let k = 0; k < n; k++) {
    const [px, pz] = line[k];
    if (k === 0 || k === n - 1) {
      const s = k === 0 ? 0 : n - 2;
      left.push([px - nx[s] * halfW, pz - nz[s] * halfW]);
      right.push([px + nx[s] * halfW, pz + nz[s] * halfW]);
      segAfter.push(k === 0 ? 0 : -1);
      continue;
    }
    const a = k - 1, b = k;
    // 斜接向量：两法线和的单位向量；斜接长度 = halfW / cos(θ/2)
    let mx = nx[a] + nx[b], mz = nz[a] + nz[b];
    const ml = Math.hypot(mx, mz);
    const cosHalf = ml / 2; // = cos(θ/2)，θ 为转角
    if (ml < 1e-9 || 1 / cosHalf > miterLimit) {
      // 截角：外侧两个点；内侧也用两个点（可能产生小回折，后面检测）
      left.push([px - nx[a] * halfW, pz - nz[a] * halfW], [px - nx[b] * halfW, pz - nz[b] * halfW]);
      right.push([px + nx[a] * halfW, pz + nz[a] * halfW], [px + nx[b] * halfW, pz + nz[b] * halfW]);
      segAfter.push(-1, b);
      continue;
    }
    mx /= ml;
    mz /= ml;
    const len = halfW / cosHalf;
    left.push([px - mx * len, pz - mz * len]);
    right.push([px + mx * len, pz + mz * len]);
    segAfter.push(b);
  }
  // 回折检测：偏移线相邻点连线在所属段方向上的投影应为正，否则该侧自交
  const checkFold = (side: Pair[]): boolean => {
    for (let k = 0; k + 1 < side.length; k++) {
      const s = segAfter[k];
      if (s < 0) continue;
      const vx = side[k + 1][0] - side[k][0];
      const vz = side[k + 1][1] - side[k][1];
      if (vx * dx[s] + vz * dz[s] < -1e-6) return true;
    }
    return false;
  };
  const folded = checkFold(left) || checkFold(right);
  if (!folded) {
    const ring: Ring = left.concat(right.reverse());
    return [ring];
  }
  // 退回：每段矩形 + 内部折点圆盘
  const out: Ring[] = [];
  for (let k = 0; k + 1 < n; k++) {
    const [ax, az] = line[k];
    const [bx, bz] = line[k + 1];
    out.push([
      [ax - nx[k] * halfW, az - nz[k] * halfW],
      [bx - nx[k] * halfW, bz - nz[k] * halfW],
      [bx + nx[k] * halfW, bz + nz[k] * halfW],
      [ax + nx[k] * halfW, az + nz[k] * halfW],
    ]);
  }
  for (let k = 1; k < n - 1; k++) out.push(circlePolygon(line[k][0], line[k][1], halfW, 12));
  return out;
}

/** 圆形多边形（n 边） */
export function circlePolygon(cx: number, cz: number, r: number, n = 16, phase = 0): Ring {
  const ring: Ring = [];
  for (let k = 0; k < n; k++) {
    const a = phase + (k / n) * Math.PI * 2;
    ring.push([cx + Math.cos(a) * r, cz + Math.sin(a) * r]);
  }
  return ring;
}

export function rectPolygon(minX: number, minZ: number, maxX: number, maxZ: number): Ring {
  return [
    [minX, minZ],
    [maxX, minZ],
    [maxX, maxZ],
    [minX, maxZ],
  ];
}

/** 把环顶点吸附到 step 网格并去掉连续重复点（polygon-clipping 对近退化线段不稳，吸附到 1 cm 网格可避免大部分） */
export function snapRing(ring: Ring, step = 0.01): Ring {
  const out: Ring = [];
  for (const [x, z] of ring) {
    const sx = Math.round(x / step) * step;
    const sz = Math.round(z / step) * step;
    const last = out[out.length - 1];
    if (last && last[0] === sx && last[1] === sz) continue;
    out.push([sx, sz]);
  }
  if (out.length > 1 && out[0][0] === out[out.length - 1][0] && out[0][1] === out[out.length - 1][1]) out.pop();
  return out.length >= 3 ? out : [];
}

export function snapMP(mp: MultiPolygon, step = 0.01): MultiPolygon {
  const out: MultiPolygon = [];
  for (const poly of mp) {
    const rings = poly.map((r) => snapRing(r, step)).filter((r) => r.length >= 3);
    if (rings.length && poly[0].length >= 3 && rings[0].length >= 3) out.push(rings);
  }
  return out;
}

/** 记录布尔运算失败后退化处理的次数（由调用方读取并打印） */
export const clipFailures = { retried: 0, dropped: 0, byOp: {} as Record<string, number> };
const bump = (k: string) => (clipFailures.byOp[k] = (clipFailures.byOp[k] ?? 0) + 1);

/**
 * 多个环（可相互重叠）→ 并集 MultiPolygon。
 * polygon-clipping 偶尔会在近退化输入上抛 "Unable to find segment"：失败时二分递归，
 * 两半各自并集后再合并；合并仍失败则吸附到 5 cm 重试，再失败只丢弃面积较小的一半。
 */
export function unionRings(rings: Ring[]): MultiPolygon {
  const snapped = rings.map((r) => snapRing(r)).filter((r) => r.length >= 3);
  return unionSnapped(snapped);
}

function unionSnapped(rings: Ring[]): MultiPolygon {
  if (rings.length === 0) return [];
  try {
    return polygonClipping.union(rings.map((r) => [r]));
  } catch {
    clipFailures.retried++;
    bump('union');
  }
  if (rings.length === 1) {
    clipFailures.dropped++;
    bump('union-single-dropped');
    return [];
  }
  const mid = rings.length >> 1;
  const a = unionSnapped(rings.slice(0, mid));
  const b = unionSnapped(rings.slice(mid));
  return unionMP(a, b);
}

function unionMP(a: MultiPolygon, b: MultiPolygon): MultiPolygon {
  if (a.length === 0) return b;
  if (b.length === 0) return a;
  try {
    return polygonClipping.union(a, b);
  } catch {
    clipFailures.retried++;
    bump('union-merge');
  }
  try {
    return polygonClipping.union(snapMP(a, 0.05), snapMP(b, 0.05));
  } catch {
    clipFailures.dropped++;
    bump('union-merge-dropped');
    return areaMP(a) >= areaMP(b) ? a : b;
  }
}

/** 二元布尔运算的稳健封装：失败时吸附到更粗网格重试，再失败返回 fallback */
function robust(name: string, op: (a: MultiPolygon, b: MultiPolygon) => MultiPolygon, a: MultiPolygon, b: MultiPolygon, fallback: MultiPolygon): MultiPolygon {
  try {
    return op(a, b);
  } catch {
    clipFailures.retried++;
    bump(`${name}-fine`);
  }
  try {
    return op(snapMP(a, 0.05), snapMP(b, 0.05));
  } catch {
    clipFailures.dropped++;
    bump(`${name}-coarse`);
    return fallback;
  }
}

export function intersectMP(a: MultiPolygon, b: MultiPolygon): MultiPolygon {
  if (a.length === 0 || b.length === 0) return [];
  return robust('intersection', (x, y) => polygonClipping.intersection(x, y), a, b, []);
}

export function differenceMP(a: MultiPolygon, b: MultiPolygon): MultiPolygon {
  if (a.length === 0) return [];
  if (b.length === 0) return a;
  return robust('difference', (x, y) => polygonClipping.difference(x, y), a, b, a);
}

/** MultiPolygon 总面积（m²，外环减孔） */
export function areaMP(mp: MultiPolygon): number {
  let total = 0;
  for (const poly of mp) {
    for (let r = 0; r < poly.length; r++) {
      const ring = poly[r];
      let a = 0;
      const n = ring.length;
      for (let k = 0; k < n; k++) {
        const [x0, z0] = ring[k];
        const [x1, z1] = ring[(k + 1) % n];
        a += x0 * z1 - x1 * z0;
      }
      total += r === 0 ? Math.abs(a) / 2 : -Math.abs(a) / 2;
    }
  }
  return total;
}

export interface TriMesh {
  /** (x, z) 对 */
  pos: number[];
  idx: number[];
}

/** 去掉自闭合的末点 */
function openRing(ring: Ring): Ring {
  const n = ring.length;
  if (n > 1 && ring[0][0] === ring[n - 1][0] && ring[0][1] === ring[n - 1][1]) return ring.slice(0, n - 1);
  return ring;
}

/** earcut 三角化一个 MultiPolygon（含孔），顶点追加到 mesh */
export function triangulateMP(mp: MultiPolygon, mesh: TriMesh): number {
  let tris = 0;
  for (const poly of mp) {
    const flat: number[] = [];
    const holes: number[] = [];
    for (let r = 0; r < poly.length; r++) {
      const ring = openRing(poly[r]);
      if (ring.length < 3) continue;
      if (r > 0) holes.push(flat.length / 2);
      for (const [x, z] of ring) flat.push(x, z);
    }
    if (flat.length < 6) continue;
    const idx = earcut(flat, holes.length ? holes : undefined, 2);
    const base = mesh.pos.length / 2;
    for (let k = 0; k < flat.length; k++) mesh.pos.push(flat[k]);
    for (let k = 0; k < idx.length; k += 3) {
      // 丢掉零面积三角
      const a = idx[k] * 2, b = idx[k + 1] * 2, c = idx[k + 2] * 2;
      const cross = (flat[b] - flat[a]) * (flat[c + 1] - flat[a + 1]) - (flat[c] - flat[a]) * (flat[b + 1] - flat[a + 1]);
      if (Math.abs(cross) < 1e-6) continue;
      mesh.idx.push(base + idx[k], base + idx[k + 1], base + idx[k + 2]);
      tris++;
    }
  }
  return tris;
}
