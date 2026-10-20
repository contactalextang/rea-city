import type { Ctx, Subsystem, AppView } from '../core/Context'
import type { PanelButton } from '../ui/Panels'
import type { Poi } from './Poi'

/** 一个已拥有的产业（P8.3 可细化） */
export interface OwnedBiz {
  id: string
  type: string
  poi: string
  tier: number
  /** 钱柜（待收现金） */
  till: number
  manager: boolean
  /** 上次累积到的 clock.absHours */
  lastHour: number
  /** 当日景气倍率（景气 1.3 / 低迷 0.7 / 查封 0） */
  mood: number
}
export interface BizSave {
  owned: OwnedBiz[]
  /** 上次掷每日风险的游戏日 */
  riskDay: number
  /** 事件日志（最近在前） */
  log: string[]
}

/** Game 提供给产业系统的依赖 */
export interface BusinessHost {
  toast(s: string, sec?: number): void
  save(): void
}

const empty = (): BizSave => ({ owned: [], riskDay: -1, log: [] })

/**
 * 产业帝国——P8.1 桩：接口与存档已接好，产业表、钱柜累积、每日风险由 P8.3 填。
 * value() = 产业估值（计入净资产）；list() = 已拥有产业。
 */
export class Business implements Subsystem<BizSave> {
  private s: BizSave = empty()

  constructor(private ctx: Ctx, private host: BusinessHost) { void this.ctx; void this.host }

  update(_dt: number) {}
  poiButtons(_poi: Poi): PanelButton[] { return [] }
  view(): AppView { return { empty: '生意即将开放：买下地盘、档口、公司，每小时进账。' } }
  serialize(): BizSave { return JSON.parse(JSON.stringify(this.s)) as BizSave }
  restore(s?: BizSave) {
    const b = empty()
    this.s = s ? { ...b, ...s, owned: [...(s.owned ?? [])], log: [...(s.log ?? [])] } : b
  }

  list(): readonly OwnedBiz[] { return this.s.owned }
  value() { return 0 }
}
