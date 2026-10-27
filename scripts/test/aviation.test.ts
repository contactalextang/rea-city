// AIR.4 单测：HeightField 栅格化 + Autopilot（起飞 → 爬升定高 → 转向 → 下滑道降落）
// node --test --experimental-transform-types --no-warnings scripts/test/aviation.test.ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { HeightField } from '../../src/world/HeightField.ts'

// Autopilot 里的 src 相对导入不带扩展名：先注册解析钩子再动态导入
await import('../lib/ts-resolve.mjs')
const F = await import('../../src/physics/ArcadeFlight.ts')
const { autopilotInput } = await import('../../src/activities/aviation/Autopilot.ts')

/** 盒子网格（鸭子类型 MeshLike）：12 个三角 */
function boxMesh(x0: number, x1: number, z0: number, z1: number, h: number) {
  const v = [[x0, 0, z0], [x1, 0, z0], [x1, 0, z1], [x0, 0, z1], [x0, h, z0], [x1, h, z0], [x1, h, z1], [x0, h, z1]]
  const f = [[4, 5, 6], [4, 6, 7], [0, 1, 5], [0, 5, 4], [1, 2, 6], [1, 6, 5], [2, 3, 7], [2, 7, 6], [3, 0, 4], [3, 4, 7], [0, 2, 1], [0, 3, 2]]
  const pos = f.flat().map((i) => v[i])
  return {
    geometry: {
      getAttribute: () => ({ count: pos.length, getX: (i: number) => pos[i][0], getY: (i: number) => pos[i][1], getZ: (i: number) => pos[i][2] }),
      index: null,
    },
    matrixWorld: { elements: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1] },
  }
}

test('HeightField：盒子屋顶栅格化、范围外为 0、低矮三角跳过', () => {
  const hf = new HeightField({ minX: -100, maxX: 100, minZ: -100, maxZ: 100 }, 8)
  hf.addMesh(boxMesh(-20, 20, -10, 10, 150.3))
  hf.addMesh(boxMesh(50, 60, 50, 60, 2))      // 低于 3 m：跳过
  assert.equal(hf.sample(0, 0), 150.3)
  assert.equal(hf.sample(-19, 9), 150.3)
  assert.equal(hf.sample(0, 40), 0)
  assert.equal(hf.sample(55, 55), 0)
  assert.equal(hf.sample(500, 0), 0)
  assert.ok(hf.sampleMax(0, 20, 12) >= 150)
  assert.equal(hf.sampleMax(0, 40, 4), 0)
})

test('HeightField：斜放的细长楼（墙描线 + 屋顶）不漏格', () => {
  const hf = new HeightField({ minX: 0, maxX: 400, minZ: 0, maxZ: 400 }, 8)
  // 旋转 30° 的 6 m × 120 m 板楼
  const c = Math.cos(Math.PI / 6), s = Math.sin(Math.PI / 6)
  const pts = [[-3, -60], [3, -60], [3, 60], [-3, 60]].map(([a, b]) => [200 + a * c - b * s, 200 + a * s + b * c])
  const tri = (p: number[], q: number[], r: number[], h: number) => hf.addTriangle(p[0], h, p[1], q[0], h, q[1], r[0], h, r[1])
  tri(pts[0], pts[1], pts[2], 80); tri(pts[0], pts[2], pts[3], 80)
  for (let k = -55; k <= 55; k += 5) {
    const x = 200 - k * s, z = 200 + k * c
    assert.equal(hf.sample(x, z), 80, `中线 k=${k}`)
  }
})

const DEG = Math.PI / 180
const dt = 1 / 60

test('Autopilot：跑道起飞 → 300 m 定高 50 m/s → 转向南北', () => {
  const b = F.createFlightBody(960, 1980, Math.PI / 2)
  let lift = -1
  for (let i = 0; i < 60 * 90; i++) {
    const r = F.stepFlight(b, autopilotInput(b, { hdg: Math.PI / 2, alt: 300, spd: 50 }), dt)
    if (r.liftoff && lift < 0) lift = b.x - 960
    assert.ok(!b.stalled, '爬升不失速')
  }
  assert.ok(lift > 200 && lift < 450, `滑跑 ${lift.toFixed(0)} m`)
  assert.ok(Math.abs(b.y - 300) < 15, `高度 ${b.y.toFixed(1)}`)
  assert.ok(Math.abs(F.airspeed(b) - 50) < 4, `空速 ${F.airspeed(b).toFixed(1)}`)
  for (let i = 0; i < 60 * 40; i++) F.stepFlight(b, autopilotInput(b, { hdg: Math.PI, alt: 300, spd: 50 }), dt)
  assert.ok(Math.abs(F.heading(b) - Math.PI) < 3 * DEG || Math.abs(F.heading(b) + Math.PI) < 3 * DEG, `航向 ${(F.heading(b) / DEG).toFixed(1)}`)
  assert.ok(Math.abs(b.y - 300) < 15, `转弯后高度 ${b.y.toFixed(1)}`)
})

test('Autopilot land：从 1.5 km 外 90 m 高、偏离中线 40 m 进近，跑道上正常 / 完美接地并停稳', () => {
  const b = F.createFlightBody(-450, 2020, Math.PI / 2)
  b.onGround = false; b.y = 90; b.vx = 32; b.throttle = 0.4
  let grade = ''
  for (let i = 0; i < 60 * 150; i++) {
    const r = F.stepFlight(b, autopilotInput(b, { land: { x: 1050, z: 1980, hdg: Math.PI / 2 } }), dt)
    if (r.touchdown) {
      grade = F.classifyTouchdown(r.touchdown.vy, r.touchdown.roll, r.touchdown.pitch, 'runway')
      assert.ok(b.x > 900 && b.x < 2100 && Math.abs(b.z - 1980) < 22, `接地点 ${b.x.toFixed(0)},${b.z.toFixed(0)} 在跑道内`)
    }
    if (b.onGround && F.airspeed(b) < 0.3) break
  }
  assert.ok(grade === 'perfect' || grade === 'normal', `评级 ${grade}`)
  assert.ok(b.x < 2100, `停在跑道内 x=${b.x.toFixed(0)}`)
})
