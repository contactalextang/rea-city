/** 数据驱动任务定义：每个身份一条新手引导链 + 原三个街头任务（黑帮）；逻辑见 systems/Quests.ts */
import type { RoleId } from './roles'
import type { PoiType } from '../systems/Poi'

/** POI 引用：具体 id，或按类型就近挑一个 */
export type PoiRef = string | { type: PoiType }

export type StepDef =
  | { kind: 'goto'; poi: PoiRef; radius?: number; label?: string }
  | { kind: 'drive'; poi: PoiRef; vehicle?: 'any' | 'taxi'; radius?: number; label?: string }
  /** 任务车（金色轿车）停在 from 门口，开到 to 门口 */
  | { kind: 'deliver'; from: PoiRef; to: PoiRef; radius?: number; label?: string }
  /** 赚到 amount；source 限定来源工作 id（jobDone 事件） */
  | { kind: 'earn'; amount: number; source?: string; label?: string }
  | { kind: 'wreck'; count: number; label?: string }
  | { kind: 'eat'; label?: string }
  | { kind: 'sleep'; label?: string }
  | { kind: 'clockIn'; label?: string }
  | { kind: 'rentTaxi'; label?: string }
  /** 某工作完成（jobDone 事件）count 次 */
  | { kind: 'job'; job: string; count?: number; label?: string }
  | { kind: 'invest'; amount: number; label?: string }

export interface QuestDef {
  id: string
  title: string
  roles: RoleId[] | 'all'
  /** auto = 开局自动接；POI 类型/id = 门口黄柱，走近即接 */
  giver: 'auto' | { type: PoiType } | string
  intro: string
  steps: StepDef[]
  /** 接受后总限时（秒） */
  timeLimit?: number
  reward: number
  /** 完成后自动接的下一条 */
  next?: string
  /** 需先完成的任务 id */
  requires?: string
}

export const QUESTS: QuestDef[] = [
  // ---------- 新手引导 ----------
  {
    id: 'ob_gang', title: '入行第一天', roles: ['gang'], giver: 'auto', reward: 200,
    intro: '老大说：先吃饱，再去店里收点"茶水费"，晚上回家睡觉。',
    steps: [
      { kind: 'eat', label: '去小贩中心吃一顿（门口按 E）' },
      { kind: 'earn', amount: 60, source: 'gang_protect', label: '手机「工作」开始「收保护费」，去商店收第一笔' },
      { kind: 'sleep', label: '回家睡觉（家门口按 E）' },
    ],
  },
  {
    id: 'ob_gold', title: '资本第一课', roles: ['gold'], giver: 'auto', reward: 300,
    intro: '先去公司露个脸，把闲钱投出去，然后回家。',
    steps: [
      { kind: 'clockIn', label: '去办公楼门口按 E 打卡' },
      { kind: 'invest', amount: 1000, label: '手机「工作」→ 投资 $1000' },
      { kind: 'sleep', label: '回家睡觉' },
    ],
  },
  {
    id: 'ob_white', title: '通勤日常', roles: ['white'], giver: 'auto', reward: 200,
    intro: '坐地铁上班、打卡、吃饭、回家，一天就这么过去。',
    steps: [
      { kind: 'goto', poi: { type: 'mrt' }, label: '走到地铁站，坐地铁去办公楼附近' },
      { kind: 'clockIn', label: '办公楼门口按 E 打卡上班' },
      { kind: 'eat', label: '下班去吃一顿' },
      { kind: 'sleep', label: '回家睡觉' },
    ],
  },
  {
    id: 'ob_blue', title: '开工第一单', roles: ['blue'], giver: 'auto', reward: 150,
    intro: '去的士站租辆车，开工载一单客，晚上回家。',
    steps: [
      { kind: 'rentTaxi', label: '去的士站租车（门口按 E）' },
      { kind: 'job', job: 'blue_taxi', count: 1, label: '手机「工作」开始「的士载客」，完成 1 单' },
      { kind: 'sleep', label: '回家睡觉' },
    ],
  },
  // ---------- 黑帮街头任务（原三任务） ----------
  {
    id: 'm_deliver', title: '运货', roles: ['gang'], giver: { type: 'landmark' }, reward: 600, timeLimit: 110,
    intro: '把金色轿车完好送到商店门口（蓝色标记）。',
    steps: [{ kind: 'deliver', from: { type: 'landmark' }, to: { type: 'shop' }, label: '上金色轿车，送到蓝色标记' }],
  },
  {
    id: 'm_race', title: '赶时间', roles: ['gang'], giver: { type: 'shop' }, reward: 450, timeLimit: 70,
    intro: '限时赶到地标（蓝色标记），用什么交通工具随你。',
    steps: [{ kind: 'goto', poi: { type: 'landmark' }, label: '限时赶到蓝色标记' }],
  },
  {
    id: 'm_wreck', title: '街头破坏', roles: ['gang'], giver: { type: 'landmark' }, reward: 900, timeLimit: 90, requires: 'm_deliver',
    intro: '限时撞毁 4 辆车，然后甩掉警察。',
    steps: [{ kind: 'wreck', count: 4, label: '撞毁车辆' }],
  },
]
