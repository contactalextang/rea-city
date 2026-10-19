import type { AABB, StaticBody } from '../world/Colliders'

/** 具有 XZ 平面圆形碰撞体的运动物体 */
export interface Body {
  x: number; z: number
  vx: number; vz: number
}

export interface Contact { nx: number; nz: number; depth: number }
const tmp: Contact = { nx: 0, nz: 0, depth: 0 }

/** 圆与 AABB 的接触：返回由盒子指向圆心的法线与穿透深度，不相交返回 null */
export function circleAABB(cx: number, cz: number, r: number, b: AABB): Contact | null {
  const qx = cx < b.minX ? b.minX : cx > b.maxX ? b.maxX : cx
  const qz = cz < b.minZ ? b.minZ : cz > b.maxZ ? b.maxZ : cz
  let dx = cx - qx, dz = cz - qz
  const d2 = dx * dx + dz * dz
  if (d2 >= r * r) return null
  if (d2 < 1e-8) {
    // 圆心在盒子内部：沿穿透最小的轴推出
    const pl = cx - b.minX, pr = b.maxX - cx, pt = cz - b.minZ, pb = b.maxZ - cz
    const m = Math.min(pl, pr, pt, pb)
    tmp.nx = m === pl ? -1 : m === pr ? 1 : 0
    tmp.nz = m === pt ? -1 : m === pb ? 1 : 0
    tmp.depth = m + r
    return tmp
  }
  const d = Math.sqrt(d2)
  tmp.nx = dx / d; tmp.nz = dz / d; tmp.depth = r - d
  return tmp
}

/**
 * 把物体沿法线推出并反射法向速度。返回撞击法向速度（正数，0 表示在分离）
 */
export function pushOut(body: Body, c: Contact, restitution: number): number {
  body.x += c.nx * c.depth
  body.z += c.nz * c.depth
  const vn = body.vx * c.nx + body.vz * c.nz
  if (vn < 0) {
    body.vx -= c.nx * vn * (1 + restitution)
    body.vz -= c.nz * vn * (1 + restitution)
    return -vn
  }
  return 0
}

/**
 * 两个圆形物体相撞：按质量比推开、沿法线交换动量。返回相对撞击速度（0 表示未碰撞/在分离）
 */
export function circleCircle(a: Body, ar: number, am: number, b: Body, br: number, bm: number, restitution: number,
  ax = a.x, az = a.z, bx = b.x, bz = b.z): number {
  let dx = bx - ax, dz = bz - az
  const d2 = dx * dx + dz * dz, rr = ar + br
  if (d2 >= rr * rr) return 0
  let d = Math.sqrt(d2)
  if (d < 1e-6) { dx = 1; dz = 0; d = 1 }
  const nx = dx / d, nz = dz / d, depth = rr - d
  const total = am + bm
  a.x -= nx * depth * (bm / total); a.z -= nz * depth * (bm / total)
  b.x += nx * depth * (am / total); b.z += nz * depth * (am / total)
  const rvn = (b.vx - a.vx) * nx + (b.vz - a.vz) * nz
  if (rvn >= 0) return 0
  const jImp = (-(1 + restitution) * rvn) / (1 / am + 1 / bm)
  a.vx -= (jImp / am) * nx; a.vz -= (jImp / am) * nz
  b.vx += (jImp / bm) * nx; b.vz += (jImp / bm) * nz
  return -rvn
}

/** 射线法判断点是否在多边形内（poly 为 [x0,z0,x1,z1,...]，闭合、不重复首点） */
export function pointInPoly(x: number, z: number, poly: Float32Array): boolean {
  const n = poly.length >> 1
  let inside = false
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const xi = poly[i * 2], zi = poly[i * 2 + 1], xj = poly[j * 2], zj = poly[j * 2 + 1]
    if ((zi > z) !== (zj > z) && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside
  }
  return inside
}

/**
 * 圆与任意多边形（可凹）的接触：返回把圆推到多边形外的法线与穿透深度，不相交返回 null。
 * 圆心在内：法线指向最近边外侧，depth = 到最近边距离 + r；圆心在外：对每条边取最近点，距离 < r 时 depth = r − dist
 */
export function circlePoly(cx: number, cz: number, r: number, poly: Float32Array): Contact | null {
  const n = poly.length >> 1
  if (n < 3) return null
  // 找最近边上的最近点
  let bestD2 = Infinity, qx = 0, qz = 0, bi = 0
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const ax = poly[j * 2], az = poly[j * 2 + 1], bx = poly[i * 2], bz = poly[i * 2 + 1]
    const ex = bx - ax, ez = bz - az
    const len2 = ex * ex + ez * ez
    let t = len2 > 1e-12 ? ((cx - ax) * ex + (cz - az) * ez) / len2 : 0
    t = t < 0 ? 0 : t > 1 ? 1 : t
    const px = ax + ex * t, pz = az + ez * t
    const dx = cx - px, dz = cz - pz
    const d2 = dx * dx + dz * dz
    if (d2 < bestD2) { bestD2 = d2; qx = px; qz = pz; bi = i }
  }
  const inside = pointInPoly(cx, cz, poly)
  if (!inside && bestD2 >= r * r) return null
  const d = Math.sqrt(bestD2)
  if (d < 1e-6) {
    // 圆心恰在边上：用该边的垂线作法线，朝多边形外侧
    const j = bi === 0 ? n - 1 : bi - 1
    const ex = poly[bi * 2] - poly[j * 2], ez = poly[bi * 2 + 1] - poly[j * 2 + 1]
    const L = Math.hypot(ex, ez) || 1
    let nx = -ez / L, nz = ex / L
    if (pointInPoly(cx + nx * 1e-3, cz + nz * 1e-3, poly)) { nx = -nx; nz = -nz }
    tmp.nx = nx; tmp.nz = nz; tmp.depth = r
    return tmp
  }
  // 圆心在内：从圆心指向最近点即朝外；圆心在外：从最近点指向圆心即朝外
  const sx = inside ? qx - cx : cx - qx, sz = inside ? qz - cz : cz - qz
  tmp.nx = sx / d; tmp.nz = sz / d
  tmp.depth = inside ? d + r : r - d
  return tmp
}

/** 圆与静态体：有多边形足迹走 circlePoly，否则走 circleAABB */
export function circleBody(cx: number, cz: number, r: number, b: StaticBody): Contact | null {
  return b.poly ? circlePoly(cx, cz, r, b.poly) : circleAABB(cx, cz, r, b)
}

/**
 * 2D 射线 o + d·t 与 AABB 求交，返回最近的 t（原点在盒内返回 0），不相交返回 null。
 * d 不要求归一化，t 与调用方的参数化一致
 */
export function rayAABB(ox: number, oz: number, dx: number, dz: number, b: AABB): number | null {
  let tmin = -Infinity, tmax = Infinity
  if (Math.abs(dx) < 1e-12) { if (ox < b.minX || ox > b.maxX) return null }
  else {
    const ix = 1 / dx
    const t1 = (b.minX - ox) * ix, t2 = (b.maxX - ox) * ix
    tmin = Math.min(t1, t2); tmax = Math.max(t1, t2)
  }
  if (Math.abs(dz) < 1e-12) { if (oz < b.minZ || oz > b.maxZ) return null }
  else {
    const iz = 1 / dz
    const t1 = (b.minZ - oz) * iz, t2 = (b.maxZ - oz) * iz
    tmin = Math.max(tmin, Math.min(t1, t2)); tmax = Math.min(tmax, Math.max(t1, t2))
  }
  if (tmax < 0 || tmin > tmax) return null
  return Math.max(0, tmin)
}

/** 2D 射线与多边形求交：逐边做线段求交取最小 t（原点在多边形内返回 0），不相交返回 null */
export function rayPoly(ox: number, oz: number, dx: number, dz: number, poly: Float32Array): number | null {
  const n = poly.length >> 1
  if (n < 3) return null
  if (pointInPoly(ox, oz, poly)) return 0
  let best: number | null = null
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const ax = poly[j * 2], az = poly[j * 2 + 1]
    const ex = poly[i * 2] - ax, ez = poly[i * 2 + 1] - az
    // 解 o + d t = a + e s
    const den = dx * ez - dz * ex
    if (Math.abs(den) < 1e-12) continue   // 平行
    const wx = ax - ox, wz = az - oz
    const t = (wx * ez - wz * ex) / den
    const s = (wx * dz - wz * dx) / den
    if (t < 0 || s < 0 || s > 1) continue
    if (best === null || t < best) best = t
  }
  return best
}

/** 2D 射线与静态体求交：有多边形足迹走 rayPoly，否则走 rayAABB */
export function rayBody(ox: number, oz: number, dx: number, dz: number, b: StaticBody): number | null {
  return b.poly ? rayPoly(ox, oz, dx, dz, b.poly) : rayAABB(ox, oz, dx, dz, b)
}
