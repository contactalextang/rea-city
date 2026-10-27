// 静态碰撞体（楼房、围墙）：2D AABB 或任意多边形（含凹多边形）+ 均匀网格空间哈希
// 支持按区块（chunk）整批增删，供流式加载的真实城市使用；并提供射线走格粗筛
export interface AABB { minX: number; maxX: number; minZ: number; maxZ: number }

export interface StaticBody extends AABB {
  /** 多边形足迹 [x0,z0,x1,z1,...]，闭合、不重复首点；缺省则视为 AABB */
  poly?: Float32Array
  /** 高度 m，射线命中用 */
  h: number
  /** 所属区块 key，按区块卸载时用 */
  chunk?: string
  /** 'bound' = 边界体（城市墙、堤道护栏、岛边缘）：挡人与车，飞机碰撞跳过 */
  tag?: 'bound'
}

export class StaticWorld {
  private cells = new Map<number, StaticBody[]>()
  private chunks = new Map<string, StaticBody[]>()
  readonly boxes: StaticBody[] = []
  private readonly cellSize: number
  // 不用参数属性：让 node --test 的 strip-only 模式也能直接加载本文件
  constructor(cellSize = 24) { this.cellSize = cellSize }

  private key(cx: number, cz: number) { return (cx + 2048) * 8192 + (cz + 2048) }

  /** 遍历 AABB 覆盖的所有格子 */
  private eachCell(b: AABB, fn: (k: number) => void) {
    const x0 = Math.floor(b.minX / this.cellSize), x1 = Math.floor(b.maxX / this.cellSize)
    const z0 = Math.floor(b.minZ / this.cellSize), z1 = Math.floor(b.maxZ / this.cellSize)
    for (let cx = x0; cx <= x1; cx++) for (let cz = z0; cz <= z1; cz++) fn(this.key(cx, cz))
  }

  /** 兼容旧接口：加入一个 AABB（就地补上高度，保持对象引用不变） */
  add(box: AABB, h = 80) {
    const b = box as StaticBody
    if (typeof b.h !== 'number') b.h = h
    this.addBody(b)
  }

  addBody(b: StaticBody) {
    this.boxes.push(b)
    this.eachCell(b, (k) => {
      let list = this.cells.get(k)
      if (!list) { list = []; this.cells.set(k, list) }
      list.push(b)
    })
  }

  /** 整批加入一个区块的碰撞体（同 key 重复加入会先卸载旧的） */
  addChunk(key: string, bodies: StaticBody[]) {
    if (this.chunks.has(key)) this.removeChunk(key)
    const list: StaticBody[] = []
    for (const b of bodies) { b.chunk = key; this.addBody(b); list.push(b) }
    this.chunks.set(key, list)
  }

  /** 卸载一个区块：从空间哈希与 boxes 数组中移除，query 不再返回这些对象 */
  removeChunk(key: string) {
    const list = this.chunks.get(key)
    if (!list) return
    this.chunks.delete(key)
    const dead = new Set(list)
    for (const b of list) {
      this.eachCell(b, (k) => {
        const cell = this.cells.get(k)
        if (!cell) return
        const i = cell.indexOf(b)
        if (i >= 0) { cell[i] = cell[cell.length - 1]; cell.pop() }
        if (cell.length === 0) this.cells.delete(k)
      })
    }
    // boxes 数组压缩，不留空洞
    let w = 0
    for (let i = 0; i < this.boxes.length; i++) if (!dead.has(this.boxes[i])) this.boxes[w++] = this.boxes[i]
    this.boxes.length = w
  }

  /** 查询与圆 (x,z,r) 可能相交的盒子（粗筛 AABB），写入 out（去重） */
  query(x: number, z: number, r: number, out: AABB[]): StaticBody[] {
    out.length = 0
    const x0 = Math.floor((x - r) / this.cellSize), x1 = Math.floor((x + r) / this.cellSize)
    const z0 = Math.floor((z - r) / this.cellSize), z1 = Math.floor((z + r) / this.cellSize)
    for (let cx = x0; cx <= x1; cx++) for (let cz = z0; cz <= z1; cz++) {
      const list = this.cells.get(this.key(cx, cz))
      if (!list) continue
      for (const b of list) if (!out.includes(b)) out.push(b)
    }
    return out as StaticBody[]
  }

  /**
   * 射线粗筛：从 (ox,oz) 沿 (dx,dz) 走到参数 t = maxT 为止，用 2D DDA 逐格收集候选（去重）。
   * dx,dz 不要求归一化（可直接传 3D 单位向量的 xz 分量，t 与 3D 射线参数一致）。精确求交由 Collision.rayBody 做。
   */
  queryRay(ox: number, oz: number, dx: number, dz: number, maxT: number, out: StaticBody[]): StaticBody[] {
    out.length = 0
    const cs = this.cellSize
    let cx = Math.floor(ox / cs), cz = Math.floor(oz / cs)
    const stepX = dx > 0 ? 1 : dx < 0 ? -1 : 0, stepZ = dz > 0 ? 1 : dz < 0 ? -1 : 0
    // 到下一条格线的 t，以及跨过一格所需的 t 增量
    let tMaxX = stepX === 0 ? Infinity : ((stepX > 0 ? (cx + 1) * cs : cx * cs) - ox) / dx
    let tMaxZ = stepZ === 0 ? Infinity : ((stepZ > 0 ? (cz + 1) * cs : cz * cs) - oz) / dz
    const tDeltaX = stepX === 0 ? Infinity : cs / Math.abs(dx), tDeltaZ = stepZ === 0 ? Infinity : cs / Math.abs(dz)
    const seen = new Set<StaticBody>()
    const maxSteps = 4096
    for (let n = 0; n < maxSteps; n++) {
      const list = this.cells.get(this.key(cx, cz))
      if (list) for (const b of list) if (!seen.has(b)) { seen.add(b); out.push(b) }
      if (tMaxX < tMaxZ) {
        if (tMaxX > maxT) break
        cx += stepX; tMaxX += tDeltaX
      } else {
        if (tMaxZ > maxT) break
        cz += stepZ; tMaxZ += tDeltaZ
      }
    }
    return out
  }

  /** 点是否在任何盒子内（多边形体按真实足迹判断） */
  contains(x: number, z: number): boolean {
    const tmp: StaticBody[] = []
    for (const b of this.query(x, z, 0.01, tmp)) {
      if (x < b.minX || x > b.maxX || z < b.minZ || z > b.maxZ) continue
      if (!b.poly || insidePoly(x, z, b.poly)) return true
    }
    return false
  }
}

/** 射线法点在多边形内。与 Collision.pointInPoly 相同；此处独立实现以免本文件运行时依赖 Collision（Node 直接加载时无法解析无扩展名 import） */
function insidePoly(x: number, z: number, poly: Float32Array): boolean {
  const n = poly.length >> 1
  let inside = false
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const xi = poly[i * 2], zi = poly[i * 2 + 1], xj = poly[j * 2], zj = poly[j * 2 + 1]
    if ((zi > z) !== (zj > z) && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside
  }
  return inside
}

/** 由多边形足迹构造 StaticBody（自动算 AABB） */
export function polyBody(poly: Float32Array, h: number, chunk?: string): StaticBody {
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity
  for (let i = 0; i < poly.length; i += 2) {
    const x = poly[i], z = poly[i + 1]
    if (x < minX) minX = x; if (x > maxX) maxX = x
    if (z < minZ) minZ = z; if (z > maxZ) maxZ = z
  }
  return { minX, maxX, minZ, maxZ, poly, h, chunk }
}
