// 静态 AABB（楼房、围墙）+ 均匀网格空间哈希
export interface AABB { minX: number; maxX: number; minZ: number; maxZ: number }

export class StaticWorld {
  private cells = new Map<number, AABB[]>()
  readonly boxes: AABB[] = []
  constructor(private cellSize = 24) {}

  private key(cx: number, cz: number) { return (cx + 2048) * 8192 + (cz + 2048) }

  add(box: AABB) {
    this.boxes.push(box)
    const x0 = Math.floor(box.minX / this.cellSize), x1 = Math.floor(box.maxX / this.cellSize)
    const z0 = Math.floor(box.minZ / this.cellSize), z1 = Math.floor(box.maxZ / this.cellSize)
    for (let cx = x0; cx <= x1; cx++) for (let cz = z0; cz <= z1; cz++) {
      const k = this.key(cx, cz)
      let list = this.cells.get(k)
      if (!list) { list = []; this.cells.set(k, list) }
      list.push(box)
    }
  }

  /** 查询与圆 (x,z,r) 可能相交的盒子，写入 out（去重） */
  query(x: number, z: number, r: number, out: AABB[]): AABB[] {
    out.length = 0
    const x0 = Math.floor((x - r) / this.cellSize), x1 = Math.floor((x + r) / this.cellSize)
    const z0 = Math.floor((z - r) / this.cellSize), z1 = Math.floor((z + r) / this.cellSize)
    for (let cx = x0; cx <= x1; cx++) for (let cz = z0; cz <= z1; cz++) {
      const list = this.cells.get(this.key(cx, cz))
      if (!list) continue
      for (const b of list) if (!out.includes(b)) out.push(b)
    }
    return out
  }

  /** 点是否在任何盒子内 */
  contains(x: number, z: number): boolean {
    const tmp: AABB[] = []
    for (const b of this.query(x, z, 0.01, tmp)) if (x >= b.minX && x <= b.maxX && z >= b.minZ && z <= b.maxZ) return true
    return false
  }
}
