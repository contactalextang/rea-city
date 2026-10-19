import type { AABB } from '../world/Colliders'

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
