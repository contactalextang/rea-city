// 世界切块（chunk）二进制格式：离线流水线（scripts/geo/09-chunks.ts）与运行时共用的唯一真相。
// 本文件零依赖、不 import three，Node 22 strip-only 模式可直接运行（不用 enum / 命名空间 / 构造器参数属性）。
//
// 坐标：本地米制，x 向东为正，z 向南为正（见 scripts/geo/lib/proj.ts）。yaw 弧度，0 朝 +z，yaw = atan2(dx, dz)。
//
// chunk 文件布局（全部小端）：
//   头：'REAC'(4) + u32 version + u32 i + u32 j + u32 sectionCount
//   段表：sectionCount × { u32 type, u32 offset, u32 length }（offset 相对文件头，length 为字节数）
//   各段起始 4 字节对齐，段内所有标量均为 4 字节，因此 Float32Array / Uint32Array 可直接作为视图零拷贝读取。
//   段类型：
//     1 roadPos   f32[]  路面顶点 (x, z) 对
//     2 roadIdx   u32[]  路面三角索引
//     3 walkPos   f32[]  人行道顶点 (x, z) 对
//     4 walkIdx   u32[]  人行道三角索引
//     5 buildings u32 count; 每栋：u32 id, f32 h, u32 cls, i32 nameIdx, u32 ringLen(float 数), u32 holeCount,
//                 f32 ring[ringLen], 每孔 { u32 len, f32[len] }
//     6 props     u32 count; 每个：u32 type, f32 x, f32 z, f32 yaw, f32 len
//     7 marks     u32 count; 每个：u32 type, f32 x, f32 z, f32 yaw, f32 len, f32 w
//     8 names     u32 count; 每个：u32 byteLen, utf8[byteLen], 补齐到 4 字节
//   未知段类型解码时忽略，便于以后扩展。
//
// skyline 文件：'REAS'(4) + u32 version + u32 vertexCount + f32 pos[3·n] + u8 cls[n]（补齐到 4 字节）。

export const CHUNK_SIZE = 256
export const CHUNK_VERSION = 1
const MAGIC_CHUNK = 0x43414552 // 'REAC' 小端读出的 u32
const MAGIC_SKYLINE = 0x53414552 // 'REAS'

// ---------------------------------------------------------------------------
// 类型与名称映射
// ---------------------------------------------------------------------------

/** 建筑类别：0 generic, 1 hdb, 2 shophouse, 3 glass, 4 landmark */
export type BuildingCls = 0 | 1 | 2 | 3 | 4
export const BUILDING_CLS_NAMES = ['generic', 'hdb', 'shophouse', 'glass', 'landmark'] as const
export type BuildingClsName = (typeof BUILDING_CLS_NAMES)[number]

/**
 * 道具类型：0 lamp, 1 signal, 2 busstop, 3 taxistand, 4 gantry, 5 mrtexit, 6 linkway, 7 bridge, 8 tree,
 * P14.4 街道小件（06-props 沿人行道撒点）：9 railing（路口行人护栏，len = 长度）, 10 bin, 11 hydrant, 12 bollard, 13 planter
 * （只在末尾追加：旧 chunk 的编号不变；旧运行时遇到未知编号走 default 忽略）
 */
export type PropType = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12 | 13
export const PROP_TYPE_NAMES = ['lamp', 'signal', 'busstop', 'taxistand', 'gantry', 'mrtexit', 'linkway', 'bridge', 'tree', 'railing', 'bin', 'hydrant', 'bollard', 'planter'] as const
export type PropTypeName = (typeof PROP_TYPE_NAMES)[number]

/** 标线类型：0 车道虚线, 1 斑马线, 2 停止线, 3 路缘 */
export type MarkType = 0 | 1 | 2 | 3
export const MARK_TYPE_NAMES = ['lanedash', 'zebra', 'stopline', 'kerb'] as const
export type MarkTypeName = (typeof MARK_TYPE_NAMES)[number]

export function buildingClsFromName(name: string): BuildingCls {
  const i = (BUILDING_CLS_NAMES as readonly string[]).indexOf(name)
  return (i < 0 ? 0 : i) as BuildingCls
}
export function propTypeFromName(name: string): PropType | -1 {
  return (PROP_TYPE_NAMES as readonly string[]).indexOf(name) as PropType | -1
}

export interface ChunkBuilding {
  id: number
  /** 高度（米） */
  h: number
  cls: BuildingCls
  /** 外环 [x0, z0, x1, z1, ...]，世界坐标，俯视逆时针，首点不重复 */
  ring: Float32Array
  /** 孔洞，同上，俯视顺时针 */
  holes: Float32Array[]
  /** 在本块 names 中的下标；-1 表示无名 */
  nameIdx: number
}

export interface ChunkProp {
  type: PropType
  x: number
  z: number
  yaw: number
  /** 长度（米），点状道具为 0 */
  len: number
}

export interface ChunkMark {
  type: MarkType
  x: number
  z: number
  /** 沿路方向 */
  yaw: number
  /** 沿路方向的长度（米） */
  len: number
  /** 横向宽度（米） */
  w: number
}

export interface ChunkData {
  i: number
  j: number
  /** 路面顶点 (x, z) 对 */
  roadPos: Float32Array
  roadIdx: Uint32Array
  /** 人行道顶点 (x, z) 对 */
  walkPos: Float32Array
  walkIdx: Uint32Array
  buildings: ChunkBuilding[]
  props: ChunkProp[]
  marks: ChunkMark[]
  names: string[]
}

export interface SkylineData {
  /** xyz 非索引三角 */
  pos: Float32Array
  /** 每顶点建筑类别 */
  cls: Uint8Array
}

export interface ManifestChunk {
  i: number
  j: number
  file: string
  bytes: number
  buildings: number
  props: number
}

export interface Manifest {
  version: 1
  origin: { lon: number; lat: number }
  bbox: { minX: number; maxX: number; minZ: number; maxZ: number }
  chunkSize: 256
  grid: { cols: number; rows: number; minX: number; minZ: number }
  chunks: ManifestChunk[]
  files: { graph: string; pois: string; skyline: string; ground: string; minimap: string; landuse: string }
  attribution: string[]
}

/** 世界坐标 → 块下标（与 09-chunks 一致） */
export function chunkIndexOf(x: number, z: number, grid: { minX: number; minZ: number }): [number, number] {
  return [Math.floor((x - grid.minX) / CHUNK_SIZE), Math.floor((z - grid.minZ) / CHUNK_SIZE)]
}

// ---------------------------------------------------------------------------
// 字节读写辅助
// ---------------------------------------------------------------------------

const SEC_ROAD_POS = 1
const SEC_ROAD_IDX = 2
const SEC_WALK_POS = 3
const SEC_WALK_IDX = 4
const SEC_BUILDINGS = 5
const SEC_PROPS = 6
const SEC_MARKS = 7
const SEC_NAMES = 8

const align4 = (n: number) => (n + 3) & ~3

/** 自增长的小端写入器 */
class ByteWriter {
  buf: ArrayBuffer
  view: DataView
  bytes: Uint8Array
  pos: number

  constructor(initial = 1024) {
    this.buf = new ArrayBuffer(initial)
    this.view = new DataView(this.buf)
    this.bytes = new Uint8Array(this.buf)
    this.pos = 0
  }

  private ensure(extra: number): void {
    if (this.pos + extra <= this.buf.byteLength) return
    let size = this.buf.byteLength * 2
    while (size < this.pos + extra) size *= 2
    const nb = new ArrayBuffer(size)
    new Uint8Array(nb).set(this.bytes.subarray(0, this.pos))
    this.buf = nb
    this.view = new DataView(nb)
    this.bytes = new Uint8Array(nb)
  }

  u32(v: number): void {
    this.ensure(4)
    this.view.setUint32(this.pos, v >>> 0, true)
    this.pos += 4
  }
  i32(v: number): void {
    this.ensure(4)
    this.view.setInt32(this.pos, v | 0, true)
    this.pos += 4
  }
  f32(v: number): void {
    this.ensure(4)
    this.view.setFloat32(this.pos, v, true)
    this.pos += 4
  }
  /** 写入 f32 数组（按本机字节序逐个写，保证小端） */
  f32Array(a: ArrayLike<number>): void {
    this.ensure(a.length * 4)
    for (let k = 0; k < a.length; k++) {
      this.view.setFloat32(this.pos, a[k], true)
      this.pos += 4
    }
  }
  u32Array(a: ArrayLike<number>): void {
    this.ensure(a.length * 4)
    for (let k = 0; k < a.length; k++) {
      this.view.setUint32(this.pos, a[k] >>> 0, true)
      this.pos += 4
    }
  }
  rawBytes(b: Uint8Array): void {
    this.ensure(b.length)
    this.bytes.set(b, this.pos)
    this.pos += b.length
  }
  /** 补零到 4 字节对齐 */
  pad4(): void {
    const target = align4(this.pos)
    this.ensure(target - this.pos)
    while (this.pos < target) this.bytes[this.pos++] = 0
  }
  /** 回填某个位置的 u32 */
  patchU32(at: number, v: number): void {
    this.view.setUint32(at, v >>> 0, true)
  }
  result(): ArrayBuffer {
    return this.buf.slice(0, this.pos)
  }
}

/** 从 ArrayBuffer 按小端读出 f32 数组：小端机器直接建视图（零拷贝），否则逐个转换 */
const LITTLE_ENDIAN = new Uint8Array(new Uint32Array([1]).buffer)[0] === 1

function readF32(buf: ArrayBuffer, offset: number, count: number): Float32Array {
  if (LITTLE_ENDIAN && offset % 4 === 0) return new Float32Array(buf, offset, count)
  const view = new DataView(buf)
  const out = new Float32Array(count)
  for (let k = 0; k < count; k++) out[k] = view.getFloat32(offset + k * 4, true)
  return out
}
function readU32(buf: ArrayBuffer, offset: number, count: number): Uint32Array {
  if (LITTLE_ENDIAN && offset % 4 === 0) return new Uint32Array(buf, offset, count)
  const view = new DataView(buf)
  const out = new Uint32Array(count)
  for (let k = 0; k < count; k++) out[k] = view.getUint32(offset + k * 4, true)
  return out
}

const textEncoder = new TextEncoder()
const textDecoder = new TextDecoder()

// ---------------------------------------------------------------------------
// chunk 编解码
// ---------------------------------------------------------------------------

export function encodeChunk(c: ChunkData): ArrayBuffer {
  const w = new ByteWriter(64 * 1024)
  // 头
  w.u32(MAGIC_CHUNK)
  w.u32(CHUNK_VERSION)
  w.u32(c.i)
  w.u32(c.j)
  const sectionCount = 8
  w.u32(sectionCount)
  // 段表占位，稍后回填
  const tableAt = w.pos
  for (let k = 0; k < sectionCount; k++) {
    w.u32(0)
    w.u32(0)
    w.u32(0)
  }
  let entry = 0
  const begin = (type: number): number => {
    w.pad4()
    const off = w.pos
    w.patchU32(tableAt + entry * 12, type)
    w.patchU32(tableAt + entry * 12 + 4, off)
    return off
  }
  const end = (off: number): void => {
    w.patchU32(tableAt + entry * 12 + 8, w.pos - off)
    entry++
  }

  let off = begin(SEC_ROAD_POS)
  w.f32Array(c.roadPos)
  end(off)
  off = begin(SEC_ROAD_IDX)
  w.u32Array(c.roadIdx)
  end(off)
  off = begin(SEC_WALK_POS)
  w.f32Array(c.walkPos)
  end(off)
  off = begin(SEC_WALK_IDX)
  w.u32Array(c.walkIdx)
  end(off)

  off = begin(SEC_BUILDINGS)
  w.u32(c.buildings.length)
  for (const b of c.buildings) {
    w.u32(b.id)
    w.f32(b.h)
    w.u32(b.cls)
    w.i32(b.nameIdx)
    w.u32(b.ring.length)
    w.u32(b.holes.length)
    w.f32Array(b.ring)
    for (const h of b.holes) {
      w.u32(h.length)
      w.f32Array(h)
    }
  }
  end(off)

  off = begin(SEC_PROPS)
  w.u32(c.props.length)
  for (const p of c.props) {
    w.u32(p.type)
    w.f32(p.x)
    w.f32(p.z)
    w.f32(p.yaw)
    w.f32(p.len)
  }
  end(off)

  off = begin(SEC_MARKS)
  w.u32(c.marks.length)
  for (const m of c.marks) {
    w.u32(m.type)
    w.f32(m.x)
    w.f32(m.z)
    w.f32(m.yaw)
    w.f32(m.len)
    w.f32(m.w)
  }
  end(off)

  off = begin(SEC_NAMES)
  w.u32(c.names.length)
  for (const s of c.names) {
    const bytes = textEncoder.encode(s)
    w.u32(bytes.length)
    w.rawBytes(bytes)
    w.pad4()
  }
  end(off)

  return w.result()
}

export function decodeChunk(buf: ArrayBuffer): ChunkData {
  if (buf.byteLength < 20) throw new Error('ChunkFormat: 文件太短')
  const view = new DataView(buf)
  if (view.getUint32(0, true) !== MAGIC_CHUNK) throw new Error('ChunkFormat: 魔数不是 REAC')
  const version = view.getUint32(4, true)
  if (version !== CHUNK_VERSION) throw new Error(`ChunkFormat: 不支持的版本 ${version}`)
  const c: ChunkData = {
    i: view.getUint32(8, true),
    j: view.getUint32(12, true),
    roadPos: new Float32Array(0),
    roadIdx: new Uint32Array(0),
    walkPos: new Float32Array(0),
    walkIdx: new Uint32Array(0),
    buildings: [],
    props: [],
    marks: [],
    names: [],
  }
  const sectionCount = view.getUint32(16, true)
  const tableAt = 20
  for (let k = 0; k < sectionCount; k++) {
    const type = view.getUint32(tableAt + k * 12, true)
    const off = view.getUint32(tableAt + k * 12 + 4, true)
    const len = view.getUint32(tableAt + k * 12 + 8, true)
    if (off + len > buf.byteLength) throw new Error(`ChunkFormat: 段 ${type} 越界`)
    let p = off
    switch (type) {
      case SEC_ROAD_POS:
        c.roadPos = readF32(buf, off, len >> 2)
        break
      case SEC_ROAD_IDX:
        c.roadIdx = readU32(buf, off, len >> 2)
        break
      case SEC_WALK_POS:
        c.walkPos = readF32(buf, off, len >> 2)
        break
      case SEC_WALK_IDX:
        c.walkIdx = readU32(buf, off, len >> 2)
        break
      case SEC_BUILDINGS: {
        const n = view.getUint32(p, true)
        p += 4
        for (let b = 0; b < n; b++) {
          const id = view.getUint32(p, true)
          const h = view.getFloat32(p + 4, true)
          const cls = view.getUint32(p + 8, true) as BuildingCls
          const nameIdx = view.getInt32(p + 12, true)
          const ringLen = view.getUint32(p + 16, true)
          const holeCount = view.getUint32(p + 20, true)
          p += 24
          const ring = readF32(buf, p, ringLen)
          p += ringLen * 4
          const holes: Float32Array[] = []
          for (let q = 0; q < holeCount; q++) {
            const hl = view.getUint32(p, true)
            p += 4
            holes.push(readF32(buf, p, hl))
            p += hl * 4
          }
          c.buildings.push({ id, h, cls, ring, holes, nameIdx })
        }
        break
      }
      case SEC_PROPS: {
        const n = view.getUint32(p, true)
        p += 4
        for (let q = 0; q < n; q++) {
          c.props.push({
            type: view.getUint32(p, true) as PropType,
            x: view.getFloat32(p + 4, true),
            z: view.getFloat32(p + 8, true),
            yaw: view.getFloat32(p + 12, true),
            len: view.getFloat32(p + 16, true),
          })
          p += 20
        }
        break
      }
      case SEC_MARKS: {
        const n = view.getUint32(p, true)
        p += 4
        for (let q = 0; q < n; q++) {
          c.marks.push({
            type: view.getUint32(p, true) as MarkType,
            x: view.getFloat32(p + 4, true),
            z: view.getFloat32(p + 8, true),
            yaw: view.getFloat32(p + 12, true),
            len: view.getFloat32(p + 16, true),
            w: view.getFloat32(p + 20, true),
          })
          p += 24
        }
        break
      }
      case SEC_NAMES: {
        const n = view.getUint32(p, true)
        p += 4
        for (let q = 0; q < n; q++) {
          const bl = view.getUint32(p, true)
          p += 4
          c.names.push(textDecoder.decode(new Uint8Array(buf, p, bl)))
          p = align4(p + bl)
        }
        break
      }
      default:
        // 未知段：忽略
        break
    }
  }
  return c
}

// ---------------------------------------------------------------------------
// skyline 编解码
// ---------------------------------------------------------------------------

export function encodeSkyline(s: SkylineData): ArrayBuffer {
  const n = s.cls.length
  if (s.pos.length !== n * 3) throw new Error('ChunkFormat: skyline pos 长度应为 cls 的 3 倍')
  const w = new ByteWriter(12 + n * 13 + 4)
  w.u32(MAGIC_SKYLINE)
  w.u32(CHUNK_VERSION)
  w.u32(n)
  w.f32Array(s.pos)
  w.rawBytes(s.cls)
  w.pad4()
  return w.result()
}

export function decodeSkyline(buf: ArrayBuffer): SkylineData {
  if (buf.byteLength < 12) throw new Error('ChunkFormat: skyline 文件太短')
  const view = new DataView(buf)
  if (view.getUint32(0, true) !== MAGIC_SKYLINE) throw new Error('ChunkFormat: 魔数不是 REAS')
  const version = view.getUint32(4, true)
  if (version !== CHUNK_VERSION) throw new Error(`ChunkFormat: 不支持的 skyline 版本 ${version}`)
  const n = view.getUint32(8, true)
  if (12 + n * 12 + n > buf.byteLength) throw new Error('ChunkFormat: skyline 数据越界')
  const pos = readF32(buf, 12, n * 3)
  const cls = new Uint8Array(buf, 12 + n * 12, n).slice()
  return { pos, cls }
}
