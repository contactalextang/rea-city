// RoadClearance 单元测试：node --test scripts/test/clearance.test.ts（Node 22 原生跑 .ts）
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { RoadClearance } from '../../src/world/RoadClearance.ts'
import type { RoadGraph } from '../../src/world/RoadGraph.ts'

// 最小假路网：一条沿 +x 的双向路（各 2 车道 × 3.3 m → 总宽 13.2 m），两端节点 jr = 8
function fakeGraph(): RoadGraph {
  const a = { id: 0, x: 0, z: 0, jr: 8, out: [] as unknown[] }, b = { id: 1, x: 100, z: 0, jr: 8, out: [] as unknown[] }
  const e0 = { id: 0, from: a, to: b, pts: new Float32Array([0, 0, 100, 0]), lanes: 2, laneW: 3.3, reverse: null as unknown }
  const e1 = { id: 1, from: b, to: a, pts: new Float32Array([100, 0, 0, 0]), lanes: 2, laneW: 3.3, reverse: e0 as unknown }
  e0.reverse = e1
  a.out.push(e0); b.out.push(e1)
  return { nodes: [a, b], edges: [e0, e1] } as unknown as RoadGraph
}

test('车行道内的杆推到路缘外 0.5 m', () => {
  const rc = new RoadClearance(fakeGraph())
  assert.equal(rc.intrudes(50, 5, 0.2), true)
  const q = rc.fit(50, 5, 0.2)
  assert.ok(q.ok && q.moved)
  assert.ok(Math.abs(q.z - (6.6 + 0.5 + 0.2)) < 0.05, `z=${q.z}`)
  assert.ok(Math.abs(q.x - 50) < 1e-6)
  assert.equal(rc.intrudes(q.x, q.z, 0.2, 0.4), false)
})

test('人行道上的杆不动', () => {
  const rc = new RoadClearance(fakeGraph())
  const q = rc.fit(50, -9, 0.2)
  assert.ok(q.ok && !q.moved)
  assert.equal(q.z, -9)
})

test('路口圆内径向推出；圆心推不出', () => {
  const rc = new RoadClearance(fakeGraph())
  const q = rc.fit(-5, -5, 0.2)
  assert.ok(q.ok && q.moved)
  assert.ok(Math.hypot(q.x, q.z) >= 8 + 0.5 + 0.2 - 0.05)
  assert.equal(rc.fit(0.1, 0.1, 0.2).ok, false)
})
