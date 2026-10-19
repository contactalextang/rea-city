// ChunkFormat 编解码 round-trip 测试：node --test scripts/test/chunk-format.test.ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  CHUNK_SIZE,
  BUILDING_CLS_NAMES,
  PROP_TYPE_NAMES,
  buildingClsFromName,
  propTypeFromName,
  chunkIndexOf,
  encodeChunk,
  decodeChunk,
  encodeSkyline,
  decodeSkyline,
  type ChunkData,
} from '../../src/world/ChunkFormat.ts'

const sample = (): ChunkData => ({
  i: 7,
  j: 3,
  roadPos: new Float32Array([0, 0, 10, 0, 10, 10, 0, 10]),
  roadIdx: new Uint32Array([0, 1, 2, 0, 2, 3]),
  walkPos: new Float32Array([-2.5, -2.5, 12.5, -2.5, 12.5, 12.5]),
  walkIdx: new Uint32Array([0, 1, 2]),
  buildings: [
    { id: 42, h: 180.5, cls: 4, ring: new Float32Array([0, 0, 20, 0, 20, 20, 0, 20]), holes: [new Float32Array([5, 5, 5, 15, 15, 15, 15, 5])], nameIdx: 0 },
    { id: 43, h: 12, cls: 1, ring: new Float32Array([30, 0, 40, 0, 35, 10]), holes: [], nameIdx: -1 },
    { id: 44, h: 9.25, cls: 2, ring: new Float32Array([50, 0, 60, 0, 60, 8, 50, 8]), holes: [], nameIdx: 1 },
  ],
  props: [
    { type: 0, x: 1.5, z: -2.25, yaw: 0.5, len: 0 },
    { type: 4, x: -232, z: 1016.5, yaw: 0.895, len: 16.61 },
  ],
  marks: [
    { type: 0, x: 3, z: 4, yaw: 1.2, len: 3, w: 0.15 },
    { type: 1, x: 5, z: 6, yaw: -1.2, len: 2.4, w: 6.6 },
    { type: 2, x: 7, z: 8, yaw: 3.1, len: 0.4, w: 3.3 },
  ],
  names: ['Guoco Tower', '牛车水 Chinatown 😀'],
})

const f32 = (v: number) => Math.fround(v)

test('encodeChunk → decodeChunk 完整 round-trip', () => {
  const src = sample()
  const buf = encodeChunk(src)
  assert.ok(buf instanceof ArrayBuffer)
  assert.equal(buf.byteLength % 4, 0)
  // 魔数
  assert.equal(String.fromCharCode(...new Uint8Array(buf, 0, 4)), 'REAC')

  const out = decodeChunk(buf)
  assert.equal(out.i, 7)
  assert.equal(out.j, 3)
  assert.deepEqual(Array.from(out.roadPos), Array.from(src.roadPos))
  assert.deepEqual(Array.from(out.roadIdx), Array.from(src.roadIdx))
  assert.deepEqual(Array.from(out.walkPos), Array.from(src.walkPos))
  assert.deepEqual(Array.from(out.walkIdx), Array.from(src.walkIdx))

  assert.equal(out.buildings.length, 3)
  for (let k = 0; k < 3; k++) {
    const a = src.buildings[k]
    const b = out.buildings[k]
    assert.equal(b.id, a.id)
    assert.equal(b.h, f32(a.h))
    assert.equal(b.cls, a.cls)
    assert.equal(b.nameIdx, a.nameIdx)
    assert.deepEqual(Array.from(b.ring), Array.from(a.ring))
    assert.equal(b.holes.length, a.holes.length)
    for (let q = 0; q < a.holes.length; q++) assert.deepEqual(Array.from(b.holes[q]), Array.from(a.holes[q]))
  }

  assert.equal(out.props.length, 2)
  for (let k = 0; k < 2; k++) {
    const a = src.props[k]
    const b = out.props[k]
    assert.equal(b.type, a.type)
    assert.equal(b.x, f32(a.x))
    assert.equal(b.z, f32(a.z))
    assert.equal(b.yaw, f32(a.yaw))
    assert.equal(b.len, f32(a.len))
  }

  assert.equal(out.marks.length, 3)
  for (let k = 0; k < 3; k++) {
    const a = src.marks[k]
    const b = out.marks[k]
    assert.equal(b.type, a.type)
    assert.equal(b.x, f32(a.x))
    assert.equal(b.z, f32(a.z))
    assert.equal(b.yaw, f32(a.yaw))
    assert.equal(b.len, f32(a.len))
    assert.equal(b.w, f32(a.w))
  }

  assert.deepEqual(out.names, src.names)
})

test('空块 round-trip', () => {
  const empty: ChunkData = {
    i: 0,
    j: 0,
    roadPos: new Float32Array(0),
    roadIdx: new Uint32Array(0),
    walkPos: new Float32Array(0),
    walkIdx: new Uint32Array(0),
    buildings: [],
    props: [],
    marks: [],
    names: [],
  }
  const out = decodeChunk(encodeChunk(empty))
  assert.equal(out.roadPos.length, 0)
  assert.equal(out.buildings.length, 0)
  assert.equal(out.names.length, 0)
})

test('解码时视图不越界、二次编码字节一致', () => {
  const buf = encodeChunk(sample())
  const again = encodeChunk(decodeChunk(buf))
  assert.deepEqual(new Uint8Array(again), new Uint8Array(buf))
})

test('坏魔数 / 坏版本报错', () => {
  const buf = encodeChunk(sample())
  const bad = buf.slice(0)
  new DataView(bad).setUint32(0, 0x12345678, true)
  assert.throws(() => decodeChunk(bad))
  const badVer = buf.slice(0)
  new DataView(badVer).setUint32(4, 99, true)
  assert.throws(() => decodeChunk(badVer))
})

test('encodeSkyline → decodeSkyline', () => {
  const pos = new Float32Array([0, 0, 0, 10, 0, 0, 10, 50, 0, 0, 0, 0, 10, 50, 0, 0, 50, 0])
  const cls = new Uint8Array([3, 3, 3, 4, 4, 4])
  const buf = encodeSkyline({ pos, cls })
  assert.equal(String.fromCharCode(...new Uint8Array(buf, 0, 4)), 'REAS')
  assert.equal(buf.byteLength % 4, 0)
  const out = decodeSkyline(buf)
  assert.deepEqual(Array.from(out.pos), Array.from(pos))
  assert.deepEqual(Array.from(out.cls), Array.from(cls))
  assert.throws(() => encodeSkyline({ pos: new Float32Array(5), cls: new Uint8Array(2) }))
})

test('名称映射与块下标', () => {
  assert.equal(CHUNK_SIZE, 256)
  assert.equal(BUILDING_CLS_NAMES[buildingClsFromName('hdb')], 'hdb')
  assert.equal(buildingClsFromName('unknown'), 0)
  assert.equal(PROP_TYPE_NAMES[propTypeFromName('tree') as number], 'tree')
  assert.equal(propTypeFromName('nope'), -1)
  assert.deepEqual(chunkIndexOf(-2392.78 + 300, -1382.17 + 10, { minX: -2392.78, minZ: -1382.17 }), [1, 0])
})
