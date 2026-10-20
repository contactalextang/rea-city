import type * as THREE from 'three'
import type { RoadGraph } from '../world/RoadGraph'
import type { StaticWorld } from '../world/Colliders'
import type { Vehicle } from '../entities/Vehicle'
import type { Player } from '../entities/Player'
import type { ChaseCamera } from './Camera'
import type { Settings } from './Settings'
import type { Clock } from '../systems/Clock'
import type { Signals } from '../systems/Signals'
import type { RoleDef } from '../data/roles'
import type { PoiRegistry } from '../systems/Poi'
import type { Needs } from '../systems/Needs'
import type { Law } from '../systems/Law'
import type { Poi } from '../systems/Poi'
import type { PanelButton } from '../ui/Panels'

/** 各系统共享的只读上下文（由 Game 构造并填充） */
export interface Ctx {
  scene: THREE.Scene
  graph: RoadGraph
  world: StaticWorld
  vehicles: Vehicle[]
  player: Player
  cam: ChaseCamera
  time: number
  /** 警方响应热度（Law.pursuitLevel；只发罚单不出警时为 0），floor 即星级 */
  pursuitLevel: number
  settings: Settings
  clock: Clock
  signals: Signals
  role: RoleDef
  /** 兴趣点注册表（世界实现提供） */
  pois: PoiRegistry
  needs: Needs
  law: Law
  /** 事件总线（Interactions / Jobs / Quests 之间解耦通知） */
  events: EventBus
}

export interface GameEvents {
  vehicleHitVehicle: { a: Vehicle; b: Vehicle; impulse: number }
  vehicleHitStatic: { v: Vehicle; impulse: number }
  vehicleHitPed: { v: Vehicle; speed: number }
  playerHitByVehicle: { v: Vehicle; impulse: number }
  vehicleWrecked: { v: Vehicle; byPlayer: boolean }
  carjack: { v: Vehicle; hadDriver: boolean }
  /** 在小贩中心/商店消费了一餐 */
  ate: { poi: Poi }
  /** 在家睡到次日；xpMul = 自有房产的次日 XP 倍率（Assets.restBonus，缺省 1） */
  slept: { day: number; xpMul?: number }
  /** 办公楼打卡上班（pay 为当日薪水） */
  clockIn: { day: number; pay: number }
  taxiRented: { v: Vehicle }
  /** 某项工作产生一笔收入（的士每单 / 保护费每家 / 一次性任务奖励） */
  /** amount = 实际入账（含心情倍率），base = 倍率前的标价（小费升级 / XP 按它算，避免心情倍率重复计） */
  jobDone: { job: string; amount: number; base?: number }
  invested: { asset: string; amount: number }
  /** 一次购买：商店物品（vehicle/property/upgrade）、产业（biz 买下 / bizTier 升级 / manager 雇经理） */
  purchased: { kind: PurchaseKind; id: string; cost: number }
  /** 产业收入入账：auto = 经理自动入账，否则为亲自收钱 */
  bizIncome: { biz: string; amount: number; auto: boolean }
  /** 产业每日风险事件；delta = 对现金/钱柜的影响（负数为损失） */
  bizEvent: { biz: string; kind: 'raid' | 'boom' | 'slump' | 'inspection'; delta: number }
  levelUp: { level: number }
  achievement: { id: string }
  /** 任务完成（reward = 现金奖励；Game 按它发 XP / 帝国线收尾总结） */
  questDone: { id: string; reward: number }
  // ---- P10 娱乐（发事件的一方负责记账：钱走 Wallet.spend/earn 的 gamble/race/arena/entertain/date 类别） ----
  /** 一局赌博结算：game = 'blackjack' | 'roulette' | 'sicbo' | 'baccarat' | 'slots' …；bet = 总下注，net = 净输赢（输为负） */
  gambled: { game: string; bet: number; net: number }
  /** 一场比赛结束：route = 路线 id，place = 名次（1 = 冠军；未完赛给 0），prize = 奖金 */
  raceDone: { route: string; place: number; prize: number }
  /** 一局竞技场结束：mode = 'defuse' | 'duel' | 'deathmatch' …；headshots 可选 */
  matchDone: { mode: string; won: boolean; kills: number; headshots?: number }
  /** 约会 / 关系推进：npc = 角色 id，stage = 'met' | 'contact' | 'dating' | 'lover' …（每次约会也发，stage 为当前阶段） */
  dated: { npc: string; stage: string }
  /** 喝了 n 杯 */
  drank: { n: number }
}
export type PurchaseKind = 'vehicle' | 'property' | 'upgrade' | 'biz' | 'bizTier' | 'manager'

/**
 * 子系统契约（Assets / Business 等）：由 Game 每帧 update、把 poiButtons 注册给 Interactions、
 * 手机应用页渲染 view()、存档时 serialize / 读档时 restore（旧存档缺字段时 s 为 undefined → 用默认值）。
 */
export interface Subsystem<S> {
  update(dt: number): void
  /** POI 面板追加的按钮（插在「离开」之前） */
  poiButtons(poi: Poi): PanelButton[]
  /** 手机应用页内容 */
  view(): AppView
  serialize(): S
  restore(s?: S): void
}

/** 手机应用页的通用视图（Phone.renderAppView 渲染）：摘要行 + 进度条 + 分组卡片 + 日志 */
export interface AppView {
  lines?: string[]
  bars?: { label: string; pct: number; text?: string }[]
  sections?: AppSection[]
  /** 底部日志（最近在前） */
  log?: string[]
  /** 空页提示（如「即将开放」） */
  empty?: string
}
export interface AppSection { title: string; items: AppItem[] }
export interface AppItem {
  title: string
  desc?: string
  /** 右侧数值（价格 / 钱柜） */
  value?: string
  /** 黄色状态行（如「需要 Lv8」「钱柜 $120」） */
  status?: string
  /** owned 绿框、locked 半透明 */
  tone?: 'owned' | 'locked'
  actions?: { label: string; disabled?: boolean; onClick: () => void }[]
}
type Handler<K extends keyof GameEvents> = (e: GameEvents[K]) => void

export class EventBus {
  private map = new Map<string, Handler<never>[]>()
  on<K extends keyof GameEvents>(k: K, h: Handler<K>) {
    const list = this.map.get(k) ?? []
    list.push(h as Handler<never>); this.map.set(k, list)
  }
  emit<K extends keyof GameEvents>(k: K, e: GameEvents[K]) {
    const list = this.map.get(k); if (!list) return
    for (const h of list) (h as Handler<K>)(e)
  }
}
