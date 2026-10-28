// AI 试玩员（Phase QA）· 原子任务模板 + 规则规划器（纯函数，不碰浏览器；单测见 scripts/test/agent-schemas.test.ts）
// 借鉴 HiSTEVE（arXiv:2610.31162）的 harness：规划器每次只从「当前适用」的参数化原子模板里挑一个子任务，
// 每个模板写明 适用条件 / 完成条件 / 失败条件 / 执行预算；执行结果判为 success / failure / interrupted，
// harness 据此推进、就地恢复或重新规划。完成判定只认游戏状态（__game），不信执行器自报。
import type { StepDef } from '../../src/data/quests.ts'

export interface P2 { x: number; z: number }

/** 每个控制周期从 __game 读出的观测（observe.ts 负责采集） */
export interface Obs {
  state: string
  /** 游戏帧率（无头渲染慢时游戏时间也会变慢：dt 上限 0.1 s） */
  fps: number
  x: number; z: number
  inVehicle: boolean
  speed: number
  money: number
  hour: number; day: number
  energy: number; hunger: number
  camYaw: number
  /** 玩家所在车辆（不在车上 = null）；yaw 约定同 Vehicle：前向 (sin, cos)，增大 = 左转 */
  car: { x: number; z: number; yaw: number; speed: number; kind: string; wrecked?: boolean } | null
  quest: { id: string | null; step: number; label: string; target: P2 | null; progress: number; done: string[] }
  job: { active: string | null; target: P2 | null; taxiPhase: string | null; canBoard: boolean }
  near: string | null
  panel: { open: boolean; labels: string[] }
  phone: { open: boolean; sub: string | null }
  stars: number
  level: number
  netWorth: number
  /** HUD 正在显示的提示（罚单 / 报废 / 被捕原因等） */
  toast?: string | null
}

export interface PoiInfo { id: string; type: string; name: string; door: P2 & { yaw: number } }

/** 面板按钮选择：label / note 正则（DOM 文本匹配，按钮须可点） */
export interface ButtonPick { label?: string; note?: string }

/** 原子子任务（规划器产出、执行器执行） */
export type Subtask =
  | { kind: 'travel'; to: P2; poi?: string; radius: number; mode: 'walk' | 'drive'; /** 驾驶不走路网，直接靠向目标往车道方向偏 offset m 的点（靠边上客 / 停进门口到达半径）；缺省 1.8 */ exact?: boolean; offset?: number }
  | { kind: 'mrt'; from: string; to: string }
  | { kind: 'interact'; poi: string; pick: ButtonPick[] }
  | { kind: 'phoneJob'; job: string; title: string; /** true = 收工（运行中的工作再点一次按钮即下班） */ stop?: boolean }
  | { kind: 'phoneInvest'; amount: number }
  | { kind: 'board' }
  | { kind: 'exitCar' }
  | { kind: 'stop'; secs: number }
  | { kind: 'waitNeeds'; energyMax: number }
  | { kind: 'waitHour'; hour: number }

export type Outcome = 'success' | 'failure' | 'interrupted'

export interface Schema<K extends Subtask['kind'] = Subtask['kind']> {
  kind: K
  /** 当前状态下能否执行（能力边界：不适用的不交给执行器） */
  applicable(o: Obs, s: Extract<Subtask, { kind: K }>): boolean
  /** 完成条件（只看观测） */
  done(o: Obs, s: Extract<Subtask, { kind: K }>, start: Obs): boolean
  /** 失败条件：一旦成立立即中止 */
  failed(o: Obs, s: Extract<Subtask, { kind: K }>, start: Obs): string | null
  /** 执行预算（真实秒） */
  budget(o: Obs, s: Extract<Subtask, { kind: K }>): number
}

export const dist = (a: P2, b: P2) => Math.hypot(a.x - b.x, a.z - b.z)
const pos = (o: Obs): P2 => (o.car ? { x: o.car.x, z: o.car.z } : { x: o.x, z: o.z })
const inWorld = (o: Obs) => o.state === 'play' || o.state === 'panel'

/** 通用失败：死亡 / 被捕 / 卡在非游戏状态 */
function commonFail(o: Obs): string | null {
  if (o.state === 'dead') return '倒下'
  if (o.state === 'busted') return '被捕'
  return null
}

/** 步行速度按跑步 7.5 m/s 的一半估，驾驶按 6 m/s 估，加固定开销 */
export const travelBudget = (d: number, mode: 'walk' | 'drive') => 30 + d / (mode === 'walk' ? 3.5 : 5)

export const SCHEMAS: { [K in Subtask['kind']]: Schema<K> } = {
  travel: {
    kind: 'travel',
    applicable: (o, s) => o.state === 'play' && (s.mode === 'drive' ? o.inVehicle : !o.inVehicle),
    done: (o, s) => dist(pos(o), s.to) <= s.radius && (s.mode === 'walk' || (o.car?.speed ?? 0) < 1.5),
    failed: (o, s) => commonFail(o) ?? (s.mode === 'drive' && o.car?.wrecked ? '车报废' : null),
    budget: (o, s) => travelBudget(dist(pos(o), s.to), s.mode),
  },
  mrt: {
    kind: 'mrt',
    applicable: (o, s) => o.state === 'play' && !o.inVehicle && o.near === s.from,
    done: (o, s, st) => o.state === 'play' && dist(o, st) > 50 && o.near === s.to,
    failed: (o) => commonFail(o),
    budget: () => 15,
  },
  interact: {
    kind: 'interact',
    applicable: (o, s) => inWorld(o) && !o.inVehicle && o.near === s.poi,
    // 点过按钮后面板关闭或任务 / 工作 / 钱 / 精力（睡觉）有变化即算完成（具体推进由 harness 看任务步骤）
    done: (o, _s, st) => o.state === 'play' && (o.quest.step !== st.quest.step || o.quest.id !== st.quest.id || o.money !== st.money || o.quest.progress !== st.quest.progress || o.inVehicle !== st.inVehicle || o.energy > st.energy + 20),
    failed: (o) => commonFail(o),
    budget: () => 15,
  },
  phoneJob: {
    kind: 'phoneJob',
    applicable: (o) => o.state === 'play',
    done: (o, s) => (s.stop ? o.job.active !== s.job : o.job.active === s.job),
    failed: (o) => commonFail(o),
    budget: () => 15,
  },
  phoneInvest: {
    kind: 'phoneInvest',
    applicable: (o, s) => o.state === 'play' && o.money >= s.amount,
    done: (o, _s, st) => o.quest.progress !== st.quest.progress || o.quest.step !== st.quest.step || o.quest.id !== st.quest.id,
    failed: (o) => commonFail(o),
    budget: () => 15,
  },
  board: {
    kind: 'board',
    applicable: (o) => o.state === 'play' && o.inVehicle && o.job.canBoard,
    done: (o) => o.job.taxiPhase === 'ride',
    failed: (o) => commonFail(o),
    budget: () => 10,
  },
  exitCar: {
    kind: 'exitCar',
    applicable: (o) => o.state === 'play' && o.inVehicle,
    done: (o) => !o.inVehicle,
    failed: (o) => commonFail(o),
    budget: () => 10,
  },
  stop: {
    kind: 'stop',
    applicable: (o) => o.state === 'play' && o.inVehicle,
    done: (o, _s, st) => o.job.taxiPhase !== st.job.taxiPhase || o.quest.step !== st.quest.step || o.quest.id !== st.quest.id || o.job.active !== st.job.active,
    failed: (o) => commonFail(o),
    budget: (_o, s) => s.secs + 10,
  },
  waitNeeds: {
    kind: 'waitNeeds',
    applicable: (o) => o.state === 'play',
    done: (o, s) => o.energy <= s.energyMax,
    failed: (o) => commonFail(o),
    budget: (o, s) => 20 + Math.max(0, o.energy - s.energyMax) * 12,
  },
  waitHour: {
    kind: 'waitHour',
    applicable: (o) => o.state === 'play',
    done: (o, s) => Math.abs(o.hour - s.hour) < 0.5,
    failed: (o) => commonFail(o),
    budget: () => 60,
  },
}

export function schemaOf<K extends Subtask['kind']>(s: Extract<Subtask, { kind: K }>): Schema<K> {
  return SCHEMAS[s.kind] as unknown as Schema<K>
}

// ---------------- 规则规划器 ----------------

/** 规划器上下文：世界记忆（POI）+ 程序性记忆（各步骤类型上次成功的走法） */
export interface PlanCtx {
  pois: PoiInfo[]
  /** 步行超过这个距离且两端附近都有地铁站时坐地铁（米） */
  mrtMin: number
  /** 程序性记忆：某次 travel 用 mrt 失败过 → 这次不再坐地铁 */
  avoidMrt?: boolean
  /** 情节记忆：哪一天在的士站租过车（的士站一天只租一次） */
  rentedDay?: number
  /** 身份 id：自己的家是 home_<role>（别人的家只能买、不能睡） */
  role?: string
}

/** 自己的家；不知道身份时退回最近的 home */
export function homeOf(ctx: PlanCtx, p: P2): PoiInfo | null {
  return ctx.pois.find((q) => q.id === `home_${ctx.role}`) ?? nearestPoi(ctx.pois, p, 'home')
}

/** 门口按 E 的触发距离（Interactions 用 near 判定，这里只用于走到门口） */
export const DOOR_R = 2.2

export function nearestPoi(pois: PoiInfo[], p: P2, type?: string): PoiInfo | null {
  let best: PoiInfo | null = null, bd = Infinity
  for (const q of pois) {
    if (type && q.type !== type) continue
    const d = dist(q.door, p)
    if (d < bd) { bd = d; best = q }
  }
  return best
}

/** 目标点对应的 POI（任务目标点 = 某 POI 的门口） */
export function poiAt(pois: PoiInfo[], p: P2): PoiInfo | null {
  const q = nearestPoi(pois, p)
  return q && dist(q.door, p) < 3 ? q : null
}

/** 去某个点：远且两端有地铁站 → 先走到上车站，再坐地铁；否则直接走 / 开 */
export function planTravel(o: Obs, to: P2, poi: string | undefined, ctx: PlanCtx, radius = DOOR_R): Subtask {
  const here = pos(o)
  if (o.inVehicle) {
    // 去门口办事（按 E）：车开不到门口——开到附近，停稳后先收工（的士招手阶段 F 被「上客」占用，下不了车），再下车步行
    if (poi && radius <= DOOR_R) {
      if (dist(here, to) <= 25 && (o.car?.speed ?? 0) < 1.5) {
        if (o.job.active) return { kind: 'phoneJob', job: o.job.active, title: JOB_TITLES[o.job.active] ?? o.job.active, stop: true }
        return { kind: 'exitCar' }
      }
      return { kind: 'travel', to, poi, radius: 12, mode: 'drive' }
    }
    return { kind: 'travel', to, poi, radius, mode: 'drive' }
  }
  const d = dist(here, to)
  if (!ctx.avoidMrt) {
    const a = nearestPoi(ctx.pois, here, 'mrt'), b = nearestPoi(ctx.pois, to, 'mrt')
    if (a && b && a.id !== b.id) {
      const viaMrt = dist(here, a.door) + dist(b.door, to)
      // 已经站在上车站门口：只要坐车能省 200 m 就坐（否则走到站后剩余距离 < mrtMin 会改主意直接走）
      const atA = o.near === a.id || dist(here, a.door) < 3
      if (atA ? viaMrt + 200 < d : d > ctx.mrtMin && viaMrt < d * 0.6) {
        if (o.near === a.id) return { kind: 'mrt', from: a.id, to: b.id }
        return { kind: 'travel', to: a.door, poi: a.id, radius: 1.2, mode: 'walk' }
      }
    }
  }
  return { kind: 'travel', to, poi, radius, mode: 'walk' }
}

/** 先走到 POI 门口，在门口时按 E 点按钮 */
/** 回家睡觉：精力 > 70 睡不着，先回到家门口再等精力降下来 */
function sleepAt(o: Obs, p: PoiInfo, ctx: PlanCtx): Subtask {
  if (o.energy > 70) {
    if (o.near === p.id || dist(o, p.door) < DOOR_R) return { kind: 'waitNeeds', energyMax: 70 }
    return planTravel(o, p.door, p.id, ctx)
  }
  return visit(o, p, PICK.sleep, ctx)
}

function visit(o: Obs, poi: PoiInfo, pick: ButtonPick[], ctx: PlanCtx): Subtask {
  if (o.near === poi.id && !o.inVehicle) return { kind: 'interact', poi: poi.id, pick }
  return planTravel(o, poi.door, poi.id, ctx)
}

export const PICK = {
  eat: [{ note: '饱食 \\+' }],
  sleep: [{ label: '睡觉到' }],
  clockIn: [{ label: '打卡上班|迟到打卡' }],
  rentWork: [{ label: '租车并开工载客' }, { label: '租一辆的士' }],
  rent: [{ label: '租一辆的士' }],
  protect: [{ label: '收保护费' }],
} satisfies Record<string, ButtonPick[]>

/** 工作 id → 手机工作页里的标题（点「开始」用） */
export const JOB_TITLES: Record<string, string> = {
  gang_protect: '收保护费',
  blue_taxi: '的士载客',
}

/**
 * 规则规划器：给定当前任务步骤（StepDef）与观测，返回下一个原子子任务；null = 等（交给 harness 处理超时）。
 * 只返回 applicable 的子任务；不适用时先返回让它变得适用的子任务（走到门口、等精力降下来……）。
 */
export function nextSubtask(step: StepDef, o: Obs, ctx: PlanCtx): Subtask | null {
  const target = o.quest.target
  const tgtPoi = target ? poiAt(ctx.pois, target) : null
  // 生存需求优先：精力见底（< 15）且不在车上 → 先回家睡觉，免得半路昏倒被送医院
  if (o.energy < 15 && !o.inVehicle && step.kind !== 'sleep') {
    const h = homeOf(ctx, o)
    if (h) return sleepAt(o, h, ctx)
  }
  switch (step.kind) {
    case 'goto':
      if (!target) return null
      return planTravel(o, target, tgtPoi?.id, ctx, step.radius ?? 6)
    case 'eat': {
      const p = tgtPoi ?? nearestPoi(ctx.pois, o, 'hawker')
      return p ? visit(o, p, PICK.eat, ctx) : null
    }
    case 'sleep': {
      const p = tgtPoi ?? homeOf(ctx, o)
      return p ? sleepAt(o, p, ctx) : null
    }
    case 'clockIn': {
      const p = tgtPoi ?? nearestPoi(ctx.pois, o, 'office')
      if (!p) return null
      // 12:00 后当天不再接收 → 回家睡到第二天早上再来（不硬跳时钟：快进照扣精力，跳近 20 小时会昏倒）
      if (o.hour >= 12) { const h = homeOf(ctx, o); return h ? sleepAt(o, h, ctx) : { kind: 'waitHour', hour: 8 } }
      return visit(o, p, PICK.clockIn, ctx)
    }
    case 'rentTaxi': {
      const p = tgtPoi ?? nearestPoi(ctx.pois, o, 'taxi')
      return p ? visit(o, p, PICK.rentWork, ctx) : null
    }
    case 'invest':
      return { kind: 'phoneInvest', amount: 1000 }
    case 'earn':
    case 'job': {
      const jobId = step.kind === 'earn' ? step.source : step.job
      if (!jobId) return null
      // 的士报废 / 不在车上：先下车，再回的士站重租（租车并开工）
      if (jobId === 'blue_taxi' && (!o.inVehicle || o.car?.wrecked)) return workJob(jobId, o, ctx)
      if (o.job.active !== jobId) return { kind: 'phoneJob', job: jobId, title: JOB_TITLES[jobId] ?? jobId }
      return workJob(jobId, o, ctx)
    }
    default:
      return null
  }
}

/** 进行中的工作：按工作目标点推进 */
export function workJob(jobId: string, o: Obs, ctx: PlanCtx): Subtask | null {
  const t = o.job.target
  if (jobId === 'gang_protect') {
    if (!t) return null
    const p = poiAt(ctx.pois, t)
    return p ? visit(o, p, PICK.protect, ctx) : planTravel(o, t, undefined, ctx)
  }
  if (jobId === 'blue_taxi') {
    if (o.inVehicle && o.car?.wrecked) return { kind: 'exitCar' }
    if (!o.inVehicle) {
      const p = nearestPoi(ctx.pois, o, 'taxi')
      if (!p) return null
      // 今天租过了：在的士站门口等过午夜（租车按自然日算；别跳到第二天早上——快进照扣精力，跳 20 多小时会昏倒）
      if (ctx.rentedDay === o.day && o.near === p.id) return { kind: 'waitHour', hour: 0.25 }
      return visit(o, p, PICK.rentWork, ctx)
    }
    if (o.job.canBoard) return (o.car?.speed ?? 0) < 1 ? { kind: 'board' } : { kind: 'stop', secs: 2 }
    if (!t) return null
    // 送客阶段：到门口附近停稳等结算
    // 游戏到达判定：车中心距门口 ≤ 8 m 且停稳 3 s；留 0.5 m 余量
    if (o.job.taxiPhase === 'ride' && dist(pos(o), t) <= 7.5) return { kind: 'stop', secs: 6 }
    // 送客停在门口 15 m 内却进不了 8 m（双向路停在对向车道 / 路线终点偏了）：直接靠向门口最近的车道点
    if (o.job.taxiPhase === 'ride' && dist(pos(o), t) < 15) return { kind: 'travel', to: t, radius: 7, mode: 'drive', exact: true, offset: 99 }
    // 停在乘客附近却还够不着（上客要乘客到车身 ≤ 3 m，车道中心常差一点）：贴边靠过去
    if (o.job.taxiPhase === 'hail' && o.car && dist(o.car, t) < 9) return { kind: 'travel', to: t, radius: 2.6, mode: 'drive', exact: true }
    // 接客：执行器把终点投影到车道上（乘客在人行道，离车道中心约 2.5 m，车身仍在上客 3 m 内）；送客：门口 8 m 内停稳
    return { kind: 'travel', to: t, radius: o.job.taxiPhase === 'ride' ? 6 : 4.5, mode: 'drive' }
  }
  return null
}

/** 子任务的短描述（日志 / 报告用） */
export function describe(s: Subtask): string {
  switch (s.kind) {
    case 'travel': return `${s.mode === 'walk' ? '步行' : '驾驶'}到 ${s.poi ?? `(${s.to.x.toFixed(0)},${s.to.z.toFixed(0)})`}`
    case 'mrt': return `地铁 ${s.from} → ${s.to}`
    case 'interact': return `在 ${s.poi} 按 E 选「${s.pick.map((p) => p.label ?? p.note).join(' / ')}」`
    case 'phoneJob': return `手机${s.stop ? '收工' : '开始工作'}「${s.title}」`
    case 'phoneInvest': return `手机投资 $${s.amount}`
    case 'board': return '按 F 上客'
    case 'exitCar': return '按 F 下车'
    case 'stop': return `停稳 ${s.secs}s`
    case 'waitNeeds': return `等精力降到 ${s.energyMax}`
    case 'waitHour': return `等到 ${Math.floor(s.hour)}:${String(Math.round((s.hour % 1) * 60)).padStart(2, '0')}`
  }
}
