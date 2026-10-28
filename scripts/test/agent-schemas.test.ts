// AI 试玩员原子模板 / 规则规划器单测：node --test scripts/test/agent-schemas.test.ts（伪造观测，不开浏览器）
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { SCHEMAS, nextSubtask, planTravel, workJob, poiAt, type Obs, type PoiInfo, type PlanCtx } from '../agent/schemas.ts'

const POIS: PoiInfo[] = [
  { id: 'home_gang', type: 'home', name: '家', door: { x: 0, z: 0, yaw: 0 } },
  { id: 'hawker_a', type: 'hawker', name: '小贩 A', door: { x: 100, z: 0, yaw: 0 } },
  { id: 'hawker_b', type: 'hawker', name: '小贩 B', door: { x: -300, z: 0, yaw: 0 } },
  { id: 'office_a', type: 'office', name: '办公楼', door: { x: 0, z: 200, yaw: 0 } },
  { id: 'mrt_near', type: 'mrt', name: '近站', door: { x: 20, z: 0, yaw: 0 } },
  { id: 'mrt_far', type: 'mrt', name: '远站', door: { x: 3000, z: 20, yaw: 0 } },
  { id: 'shop_far', type: 'shop', name: '远店', door: { x: 3010, z: 0, yaw: 0 } },
  { id: 'taxi_a', type: 'taxi', name: '的士站', door: { x: 50, z: 50, yaw: 0 } },
]
const ctx: PlanCtx = { pois: POIS, mrtMin: 900 }

function obs(p: Partial<Obs> = {}): Obs {
  return {
    state: 'play', fps: 60, x: 0, z: 0, inVehicle: false, speed: 0, money: 500, hour: 8, day: 1, energy: 100, hunger: 80, camYaw: 0, car: null,
    quest: { id: 'ob_gang', step: 0, label: '', target: null, progress: 0, done: [] },
    job: { active: null, target: null, taxiPhase: null, canBoard: false },
    near: null, panel: { open: false, labels: [] }, phone: { open: false, sub: null }, stars: 0, level: 1, netWorth: 500,
    ...p,
  }
}

test('poiAt：任务目标点对上门口才算该 POI', () => {
  assert.equal(poiAt(POIS, { x: 100.5, z: 0.5 })?.id, 'hawker_a')
  assert.equal(poiAt(POIS, { x: 110, z: 0 }), null)
})

test('eat：先走到任务指定的小贩中心，到门口再按 E 选吃的', () => {
  const o = obs({ quest: { ...obs().quest, target: { x: 100, z: 0 } } })
  const a = nextSubtask({ kind: 'eat' }, o, ctx)
  assert.equal(a?.kind, 'travel')
  assert.equal(a?.kind === 'travel' && a.poi, 'hawker_a')
  const b = nextSubtask({ kind: 'eat' }, { ...o, x: 100, near: 'hawker_a' }, ctx)
  assert.equal(b?.kind, 'interact')
  assert.ok(b?.kind === 'interact' && b.pick.some((p) => p.note && /饱食/.test('饱食 +20') && new RegExp(p.note).test('$3 · 饱食 +20')))
})

test('sleep：精力 > 70 时先回家，到门口后等精力降下来，再按 E 睡觉', () => {
  const s = { kind: 'sleep' } as const
  assert.equal(nextSubtask(s, obs({ x: 100 }), ctx)?.kind, 'travel')
  assert.equal(nextSubtask(s, obs({ near: 'home_gang' }), ctx)?.kind, 'waitNeeds')
  assert.equal(nextSubtask(s, obs({ near: 'home_gang', energy: 60 }), ctx)?.kind, 'interact')
})

test('clockIn：12 点后 → 回家睡到第二天早上（不硬跳时钟）', () => {
  const o = obs({ near: 'office_a', x: 0, z: 200, hour: 13, energy: 60 })
  const a = nextSubtask({ kind: 'clockIn' }, o, ctx)
  assert.equal(a?.kind === 'travel' && a.poi, 'home_gang')
  assert.equal(nextSubtask({ kind: 'clockIn' }, { ...o, x: 0, z: 0, near: 'home_gang' }, ctx)?.kind, 'interact')
  assert.equal(nextSubtask({ kind: 'clockIn' }, { ...o, hour: 8.5 }, ctx)?.kind, 'interact')
})

test('earn / job：没开工先用手机开工，开工后按工作目标推进', () => {
  const step = { kind: 'earn', amount: 60, source: 'gang_protect' } as const
  const a = nextSubtask(step, obs(), ctx)
  assert.deepEqual(a, { kind: 'phoneJob', job: 'gang_protect', title: '收保护费' })
  const b = nextSubtask(step, obs({ job: { active: 'gang_protect', target: { x: 100, z: 0 }, taxiPhase: null, canBoard: false } }), ctx)
  assert.equal(b?.kind, 'travel')
})

test('planTravel：远且两端有地铁站 → 先走到近站，在站门口坐地铁；avoidMrt 时直接走', () => {
  const to = POIS.find((p) => p.id === 'shop_far')!.door
  const a = planTravel(obs(), to, 'shop_far', ctx)
  assert.equal(a.kind === 'travel' && a.poi, 'mrt_near')
  assert.deepEqual(planTravel(obs({ x: 20, near: 'mrt_near' }), to, 'shop_far', ctx), { kind: 'mrt', from: 'mrt_near', to: 'mrt_far' })
  const c = planTravel(obs(), to, 'shop_far', { ...ctx, avoidMrt: true })
  assert.equal(c.kind === 'travel' && c.poi, 'shop_far')
  // 已在上车站门口：剩余距离不到 mrtMin，只要坐车省 200 m 以上照样坐（不在站门口改主意）
  const mid = { x: 820, z: 20 }
  assert.deepEqual(planTravel(obs({ x: 20, near: 'mrt_near' }), mid, undefined, { ...ctx, pois: [...POIS, { id: 'mrt_mid', type: 'mrt', name: '中站', door: { x: 800, z: 20, yaw: 0 } }] }), { kind: 'mrt', from: 'mrt_near', to: 'mrt_mid' })
  // 近处不坐地铁
  const d = planTravel(obs(), { x: 100, z: 0 }, 'hawker_a', ctx)
  assert.equal(d.kind === 'travel' && d.mode, 'walk')
})

test('planTravel：在车上 → 驾驶', () => {
  const a = planTravel(obs({ inVehicle: true, car: { x: 0, z: 0, yaw: 0, speed: 0, kind: 'taxi' } }), { x: 100, z: 0 }, undefined, ctx)
  assert.equal(a.kind === 'travel' && a.mode, 'drive')
})

test('workJob 的士：可上客且停稳 → 按 F；还在动 → 先停；送客到门口附近 → 停稳等结算', () => {
  const car = { x: 0, z: 0, yaw: 0, speed: 0, kind: 'taxi' }
  const base = obs({ inVehicle: true, car })
  assert.equal(workJob('blue_taxi', { ...base, job: { active: 'blue_taxi', target: null, taxiPhase: 'hail', canBoard: true } }, ctx)?.kind, 'board')
  assert.equal(workJob('blue_taxi', { ...base, car: { ...car, speed: 5 }, job: { active: 'blue_taxi', target: null, taxiPhase: 'hail', canBoard: true } }, ctx)?.kind, 'stop')
  assert.equal(workJob('blue_taxi', { ...base, job: { active: 'blue_taxi', target: { x: 5, z: 5 }, taxiPhase: 'ride', canBoard: false } }, ctx)?.kind, 'stop')
  assert.equal(workJob('blue_taxi', { ...base, job: { active: 'blue_taxi', target: { x: 300, z: 0 }, taxiPhase: 'ride', canBoard: false } }, ctx)?.kind, 'travel')
})

test('模板：travel 完成要求在半径内（驾驶还要停下）；死亡 / 被捕判失败', () => {
  const s = { kind: 'travel', to: { x: 10, z: 0 }, radius: 3, mode: 'walk' } as const
  assert.equal(SCHEMAS.travel.done(obs({ x: 8 }), s, obs()), true)
  assert.equal(SCHEMAS.travel.done(obs({ x: 0 }), s, obs()), false)
  const d = { ...s, mode: 'drive' } as const
  assert.equal(SCHEMAS.travel.done(obs({ car: { x: 9, z: 0, yaw: 0, speed: 5, kind: 'taxi' } }), d, obs()), false)
  assert.equal(SCHEMAS.travel.done(obs({ car: { x: 9, z: 0, yaw: 0, speed: 0.5, kind: 'taxi' } }), d, obs()), true)
  assert.equal(SCHEMAS.travel.failed(obs({ state: 'dead' }), s, obs()), '倒下')
  assert.equal(SCHEMAS.travel.failed(obs({ state: 'busted' }), s, obs()), '被捕')
  assert.equal(SCHEMAS.travel.applicable(obs({ state: 'panel' }), s), false)
})

test('模板：interact 只在门口适用；任务步骤 / 钱 / 上下车有变化即完成', () => {
  const s = { kind: 'interact', poi: 'hawker_a', pick: [] } as const
  assert.equal(SCHEMAS.interact.applicable(obs({ near: 'hawker_b' }), s), false)
  assert.equal(SCHEMAS.interact.applicable(obs({ near: 'hawker_a' }), s), true)
  const st = obs()
  assert.equal(SCHEMAS.interact.done(obs({ money: 497 }), s, st), true)
  assert.equal(SCHEMAS.interact.done(obs({ state: 'panel', money: 497 }), s, st), false)
  assert.equal(SCHEMAS.interact.done(obs(), s, st), false)
})

test('模板预算：越远预算越多；等精力的预算随差值增长', () => {
  const near = SCHEMAS.travel.budget(obs(), { kind: 'travel', to: { x: 50, z: 0 }, radius: 2, mode: 'walk' })
  const far = SCHEMAS.travel.budget(obs(), { kind: 'travel', to: { x: 500, z: 0 }, radius: 2, mode: 'walk' })
  assert.ok(far > near)
  assert.ok(SCHEMAS.waitNeeds.budget(obs({ energy: 100 }), { kind: 'waitNeeds', energyMax: 70 }) > SCHEMAS.waitNeeds.budget(obs({ energy: 75 }), { kind: 'waitNeeds', energyMax: 70 }))
})

test('workJob 的士：车报废 → 下车；不在车上 → 回的士站重租；今天租过且在站门口 → 等过午夜', () => {
  const step = { kind: 'job', job: 'blue_taxi', count: 1 } as const
  const wrecked = obs({ inVehicle: true, car: { x: 0, z: 0, yaw: 0, speed: 0, kind: 'taxi', wrecked: true } })
  assert.equal(nextSubtask(step, wrecked, ctx)?.kind, 'exitCar')
  const a = nextSubtask(step, obs({ x: 200 }), ctx)
  assert.equal(a?.kind === 'travel' && a.poi, 'taxi_a')
  assert.equal(nextSubtask(step, obs({ x: 50, z: 50, near: 'taxi_a' }), ctx)?.kind, 'interact')
  assert.deepEqual(nextSubtask(step, obs({ x: 50, z: 50, near: 'taxi_a', day: 2 }), { ...ctx, rentedDay: 2 }), { kind: 'waitHour', hour: 0.25 })
})

test('自己的家：有 role 时回 home_<role>，不去最近的别人家', () => {
  const pois = [...POIS, { id: 'home_blue', type: 'home', name: '蓝领家', door: { x: 900, z: 0, yaw: 0 } }]
  const a = nextSubtask({ kind: 'sleep' }, obs({ x: 10, energy: 50 }), { ...ctx, pois, role: 'blue' })
  assert.equal(a?.kind === 'travel' && a.poi, 'home_blue')
})

test('生存需求：精力 < 15 且不在车上 → 先回家睡觉（任何步骤）', () => {
  const a = nextSubtask({ kind: 'clockIn' }, obs({ hour: 9, energy: 10, x: 100 }), ctx)
  assert.equal(a?.kind === 'travel' && a.poi, 'home_gang')
  assert.equal(nextSubtask({ kind: 'clockIn' }, obs({ hour: 9, energy: 10, near: 'home_gang' }), ctx)?.kind, 'interact')
})

test('workJob 的士：招手阶段停在乘客 9 m 内还上不了客 → 贴边靠过去（exact，不投影到车道）', () => {
  const car = { x: 0, z: 0, yaw: 0, speed: 0, kind: 'taxi' }
  const a = workJob('blue_taxi', obs({ inVehicle: true, car, job: { active: 'blue_taxi', target: { x: 3, z: 3 }, taxiPhase: 'hail', canBoard: false } }), ctx)
  assert.ok(a?.kind === 'travel' && a.exact && a.mode === 'drive')
  const b = workJob('blue_taxi', obs({ inVehicle: true, car, job: { active: 'blue_taxi', target: { x: 50, z: 0 }, taxiPhase: 'hail', canBoard: false } }), ctx)
  assert.ok(b?.kind === 'travel' && !b.exact)
})

test('车上去门口办事：远 → 开到附近；近且停稳 → 先手机收工，再下车', () => {
  const car = { x: 0, z: 0, yaw: 0, speed: 0, kind: 'taxi' }
  const home = { ...ctx, role: 'gang' }
  const far = nextSubtask({ kind: 'sleep' }, obs({ inVehicle: true, car: { ...car, x: 300 }, x: 300, energy: 50 }), home)
  assert.ok(far?.kind === 'travel' && far.mode === 'drive' && far.radius === 12)
  const job = { active: 'blue_taxi', target: null, taxiPhase: 'hail', canBoard: false }
  assert.deepEqual(nextSubtask({ kind: 'sleep' }, obs({ inVehicle: true, car: { ...car, x: 10 }, x: 10, energy: 50, job }), home), { kind: 'phoneJob', job: 'blue_taxi', title: '的士载客', stop: true })
  assert.equal(nextSubtask({ kind: 'sleep' }, obs({ inVehicle: true, car: { ...car, x: 10 }, x: 10, energy: 50 }), home)?.kind, 'exitCar')
})

test('workJob 的士：送客停在门口 7.5–15 m → 直接靠向门口最近车道点；7.5 m 内 → 停稳', () => {
  const car = { x: 0, z: 0, yaw: 0, speed: 0, kind: 'taxi' }
  const job = (x: number) => ({ active: 'blue_taxi', target: { x, z: 0 }, taxiPhase: 'ride', canBoard: false })
  const a = workJob('blue_taxi', obs({ inVehicle: true, car, job: job(10) }), ctx)
  assert.ok(a?.kind === 'travel' && a.exact && a.offset === 99)
  assert.equal(workJob('blue_taxi', obs({ inVehicle: true, car, job: job(7) }), ctx)?.kind, 'stop')
})
