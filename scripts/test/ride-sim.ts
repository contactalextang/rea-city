// 叫车计价与拒绝分支单测（P11.B）：node --experimental-transform-types scripts/test/ride-sim.ts（npm run ride:sim）
// 直接调用 src/systems/Ride.ts 的纯函数（与游戏同一份代码）；打印 2 / 8 / 15 km 在 14:00 与 19:00 的报价表，然后逐项断言。
// src 里的相对导入不带扩展名（vite 风格），先注册解析钩子（scripts/lib/ts-resolve.mjs）补 .ts / index.ts；Jobs.ts 有参数属性，需要 --experimental-transform-types。
await import('../lib/ts-resolve.mjs')

const R = await import('../../src/systems/Ride.ts')
const { taxiFare, isTaxiPeak } = await import('../../src/systems/Jobs.ts')

let fails = 0, passes = 0
function ok(cond: boolean, msg: string) {
  if (cond) passes++
  else { fails++; console.error(`✗ ${msg}`) }
}

// ---------- 报价表 ----------
console.log('路程     时间   Taxi            Grab')
for (const km of [2, 8, 15]) for (const h of [14, 19]) {
  const t = R.quote('taxi', km * 1000, h), g = R.quote('grab', km * 1000, h)
  console.log(`${String(km).padStart(2)} km   ${h}:00  $${t.fare.toFixed(2).padStart(6)} ${String(t.minutes).padStart(3)} 分   $${g.fare.toFixed(2).padStart(6)} ${String(g.minutes).padStart(3)} 分 ×${g.surge}`)
}
console.log(`雨天 19:00 8 km Grab $${R.quote('grab', 8000, 19, true).fare.toFixed(2)}`)

// ---------- 价格随距离单调不减、时长随距离单调不减 ----------
for (const kind of ['taxi', 'grab'] as const) for (const h of [3, 8, 14, 19, 23]) for (const rain of [false, true]) {
  let prev = R.quote(kind, 0, h, rain)
  for (let d = 50; d <= 30000; d += 50) {
    const q = R.quote(kind, d, h, rain)
    ok(q.fare >= prev.fare, `${kind} ${h}h rain=${rain}: ${d} m 车费 ${q.fare} < ${d - 50} m 的 ${prev.fare}`)
    ok(q.minutes >= prev.minutes, `${kind} ${h}h: ${d} m 时长变短`)
    prev = q
  }
  ok(R.quote(kind, 20000, h, rain).fare > R.quote(kind, 2000, h, rain).fare, `${kind} ${h}h: 20 km 应比 2 km 贵`)
}

// ---------- Taxi 与 taxiFare 一致（等候 0、评分 0 不给小费，高峰按 isTaxiPeak） ----------
for (let h = 0; h < 24; h += 0.5) for (const d of [0, 400, 1000, 1001, 2500, 8000, 15000, 27321]) {
  const q = R.quote('taxi', d, h)
  ok(q.fare === taxiFare(d, 0, isTaxiPeak(h), 0), `Taxi ${d} m ${h}h 与 taxiFare 不一致：${q.fare} vs ${taxiFare(d, 0, isTaxiPeak(h), 0)}`)
  ok(q.surge === 1, 'Taxi 不该有 surge')
  ok(q.waitMin >= 3 && q.waitMin <= 6, `Taxi 等车 ${q.waitMin} 不在 3–6`)
}
ok(R.quote('taxi', 0, 14).fare === 4.4, 'Taxi 起步价 $4.40')

// ---------- Grab：高峰比平峰贵、surge 在 1.3–1.8、雨天更贵、等车 2–4 ----------
for (const d of [1000, 2000, 8000, 15000]) {
  ok(R.quote('grab', d, 19).fare > R.quote('grab', d, 14).fare, `Grab ${d} m：19:00 应比 14:00 贵`)
  ok(R.quote('grab', d, 8).fare > R.quote('grab', d, 14).fare, `Grab ${d} m：08:00 应比 14:00 贵`)
  ok(d < 2000 ? R.quote('grab', d, 14, true).fare >= R.quote('grab', d, 14).fare : R.quote('grab', d, 14, true).fare > R.quote('grab', d, 14).fare, `Grab ${d} m：雨天应更贵（最低消费内持平）`)
}
for (let h = 0; h < 24; h += 0.25) {
  const s = R.grabSurge(h)
  ok(s === 1 || (s >= 1.3 && s <= 1.8), `${h}h surge ${s} 不在 1 或 1.3–1.8`)
  const w = R.waitMinutes('grab', h)
  ok(w >= 2 && w <= 4, `Grab 等车 ${w} 不在 2–4`)
}
ok(R.grabSurge(14) === 1 && R.grabSurge(19) >= 1.3, '14:00 无加价、19:00 有加价')
ok(R.grabSurge(43) === R.grabSurge(19), '小时超过 24 按模取')
ok(R.quote('grab', 300, 14).fare === R.RIDE.grab.min, 'Grab 最低消费')
// Grab 公式：8 km 14:00 = 3 + 5.6 + 16 分×0.2 + 0.9
ok(Math.abs(R.quote('grab', 8000, 14).fare - (3 + 5.6 + 16 * 0.2 + 0.9)) < 0.011, 'Grab 平峰公式')
// 车程：30 km/h（高峰 22 km/h）+ 等车
ok(R.quote('grab', 15000, 14).minutes === 30 + 2, '15 km 平峰 Grab = 30 分 + 2 分等车')
ok(R.quote('grab', 11000, 18).minutes === 30 + 3, '11 km 高峰 Grab = 30 分（22 km/h）+ 3 分等车')

// ---------- 路程：路网可达用最短路，不可达 / 无图回退直线 × 1.3 ----------
const node = (id: number, x: number, z: number) => ({ id, x, z }) as never
const edge = { length: 100 } as never
const fakeGraph = (routeDist: number, laneDist = 3, nodeAt = { x: 1000, z: 0 }) => ({
  nearestLane: () => ({ edge, t: 20, dist: laneDist }),
  nearestNode: () => node(1, nodeAt.x, nodeAt.z),
  routeDist: () => routeDist,
})
const A = { x: 0, z: 0 }, B = { x: 1000, z: 0 }
ok(R.routeDistance(null, A, B) === 1300, '无图回退 1.3 倍直线')
ok(R.routeDistance(fakeGraph(Infinity), A, B) === 1300, '不可达回退 1.3 倍直线')
ok(R.routeDistance(fakeGraph(1400), A, B) === 1403, '可达：上路 3 m + 最短路 1400 m + 终点 0 m')
ok(R.routeDistance(fakeGraph(500), A, B) === 1000, '路程不短于直线')
ok(R.routeDistance(fakeGraph(1400, 200), A, B) === 1300, '起点离路太远回退')
ok(R.routeDistance(fakeGraph(99999), A, B) === 1300, '绕路离谱（> 4 倍）回退')

// ---------- canRide 各拒绝分支 ----------
const base = { state: 'play', chase: false, stars: 0, job: null as string | null }
ok(R.canRide(base) === null, '正常可以叫车')
ok(R.canRide({ ...base, distM: 5000 }) === null, '5 km 可以叫车')
ok(R.canRide({ ...base, chase: true })?.includes('通缉') === true, '被追捕拒绝')
ok(R.canRide({ ...base, stars: 1 })?.includes('通缉') === true, '有星级拒绝')
ok(R.canRide({ ...base, state: 'panel' }) !== null, '非 play 拒绝')
ok(R.canRide({ ...base, state: 'ride' }) !== null, '乘车中不能再叫')
ok(R.canRide({ ...base, job: '的士载客' })?.includes('的士载客') === true, '工作进行中拒绝并给出工作名')
ok(R.canRide({ ...base, distM: 80 })?.includes('附近') === true, '太近拒绝')
ok(R.canRide({ ...base, state: 'dead', stars: 2 })?.includes('通缉') === true, '通缉优先提示')

console.log(`\nride-sim: ${passes} 项通过，${fails} 项失败`)
if (fails) process.exit(1)
