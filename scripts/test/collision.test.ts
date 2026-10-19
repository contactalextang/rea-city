// Collision 最小单元测试：node --test scripts/test/collision.test.ts（Node 22 原生跑 .ts）
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { circlePoly, rayPoly, rayAABB, rayBody, circleBody, pointInPoly } from '../../src/physics/Collision.ts'
import { StaticWorld, polyBody } from '../../src/world/Colliders.ts'

const near = (a: number, b: number, eps = 1e-6) => Math.abs(a - b) <= eps
// 10×10 正方形，角在原点
const square = new Float32Array([0, 0, 10, 0, 10, 10, 0, 10])
// L 形（凹）：外轮廓 10×10，右上角挖掉 5×5
const L = new Float32Array([0, 0, 10, 0, 10, 5, 5, 5, 5, 10, 0, 10])

test('pointInPoly 内/外/凹口', () => {
  assert.equal(pointInPoly(5, 5, square), true)
  assert.equal(pointInPoly(11, 5, square), false)
  assert.equal(pointInPoly(2, 2, L), true)
  assert.equal(pointInPoly(8, 8, L), false)   // 凹口处在 AABB 内但在多边形外
})

test('circlePoly 圆心在外：靠近一条边', () => {
  const c = circlePoly(12, 5, 3, square)!
  assert.ok(c)
  assert.ok(near(c.nx, 1) && near(c.nz, 0))
  assert.ok(near(c.depth, 1))   // r − dist = 3 − 2
  assert.equal(circlePoly(14, 5, 3, square), null)   // 距离 4 ≥ r
})

test('circlePoly 圆心在内：推到最近边外侧', () => {
  const c = circlePoly(1, 5, 0.5, square)!
  assert.ok(near(c.nx, -1) && near(c.nz, 0))
  assert.ok(near(c.depth, 1.5))   // dist 1 + r 0.5
})

test('circlePoly 角点：法线沿对角线', () => {
  const c = circlePoly(11, 11, 2, square)!
  assert.ok(c)
  const s = Math.SQRT1_2
  assert.ok(near(c.nx, s) && near(c.nz, s))
  assert.ok(near(c.depth, 2 - Math.SQRT2))
})

test('circlePoly 凹多边形（L 形）：凹口内不碰、凹口内角推出', () => {
  assert.equal(circlePoly(8.5, 8.5, 1, L), null)          // 在凹口中央，离边 3.5 > r
  const c = circlePoly(6, 6, 1.5, L)!                     // 凹口内角附近，距两条内边各 1
  assert.ok(c)
  assert.ok(near(c.depth, 0.5))
  assert.ok(c.nx > 0 || c.nz > 0)                         // 朝凹口方向（外）推
  const d = circlePoly(2, 2, 1, L)!                       // 内部：最近边距离 2
  assert.ok(near(d.depth, 3))
})

test('rayPoly 命中/未命中/原点在内', () => {
  const t = rayPoly(-5, 5, 1, 0, square)
  assert.ok(t !== null && near(t, 5))
  assert.equal(rayPoly(-5, 15, 1, 0, square), null)        // 在上方擦过
  assert.equal(rayPoly(15, 5, 1, 0, square), null)         // 背向
  assert.equal(rayPoly(5, 5, 1, 0, square), 0)             // 原点在内
  // L 形：从右侧沿 z=8 射入，先穿过凹口空隙，命中 x=5 的内边
  const tl = rayPoly(20, 8, -1, 0, L)
  assert.ok(tl !== null && near(tl, 15))
  // 非归一化方向：t 按参数化换算
  const t2 = rayPoly(-10, 5, 2, 0, square)
  assert.ok(t2 !== null && near(t2, 5))
})

test('rayAABB 命中/未命中/轴平行/原点在内', () => {
  const box = { minX: 0, maxX: 10, minZ: 0, maxZ: 10 }
  const t = rayAABB(-5, 5, 1, 0, box)
  assert.ok(t !== null && near(t, 5))
  assert.equal(rayAABB(-5, 15, 1, 0, box), null)
  assert.equal(rayAABB(15, 5, 1, 0, box), null)
  assert.equal(rayAABB(5, 5, 1, 0, box), 0)
  const td = rayAABB(-5, -5, 1, 1, box)
  assert.ok(td !== null && near(td, 5))
  assert.equal(rayAABB(-5, 5, 0, 1, box), null)             // 与 x 轴平行且在盒外
})

test('rayBody / circleBody 按 poly 分派', () => {
  const pb = polyBody(L, 20)
  assert.ok(near(rayBody(20, 8, -1, 0, pb)!, 15))           // 多边形：AABB 会在 t=10 命中，多边形在 15
  const ab = { minX: 0, maxX: 10, minZ: 0, maxZ: 10, h: 20 }
  assert.ok(near(rayBody(20, 8, -1, 0, ab)!, 10))
  assert.equal(circleBody(8.5, 8.5, 1, pb), null)
  assert.ok(circleBody(8.5, 8.5, 1, ab))
})

test('StaticWorld：区块增删、query/queryRay/contains', () => {
  const w = new StaticWorld(24)
  w.add({ minX: 0, maxX: 10, minZ: 0, maxZ: 10 })
  const pb = polyBody(L, 30)
  w.addChunk('c1', [pb, { minX: 100, maxX: 110, minZ: 0, maxZ: 10, h: 12 }])
  assert.equal(w.boxes.length, 3)
  assert.equal(w.boxes[0].h, 80)
  assert.equal(w.contains(8, 8), true)                      // AABB 盒覆盖
  assert.equal(w.contains(105, 5), true)
  assert.equal(w.contains(150, 5), false)
  // 射线从 x=-50 沿 +x，z=5：应收集到两个 AABB 与 L 形
  const ray = w.queryRay(-50, 5, 1, 0, 200, [])
  assert.equal(ray.length, 3)
  assert.ok(new Set(ray).size === 3)
  w.removeChunk('c1')
  assert.equal(w.boxes.length, 1)
  assert.equal(w.contains(105, 5), false)
  assert.equal(w.query(105, 5, 1, []).length, 0)
  assert.equal(w.queryRay(-50, 5, 1, 0, 200, []).length, 1)
  // 重新加入同 key 不会重复
  w.addChunk('c1', [pb]); w.addChunk('c1', [pb])
  assert.equal(w.boxes.length, 2)
})
