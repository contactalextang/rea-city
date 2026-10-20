/** 数据驱动任务定义：每个身份一条新手引导链 + 原三个街头任务（黑帮）；逻辑见 systems/Quests.ts */
import type { RoleId } from './roles'
import type { PoiType } from '../systems/Poi'
import type { PurchaseKind } from '../core/Context'

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
  // ---- 帝国线（P8.5）：读 Business / Assets / Progress / 净资产（Quests.setSources 注入） ----
  /** 买下某商店物品 / 产业（item = 物品 id 或产业类型 id），或任一某类购买（itemKind）；监听 purchased */
  | { kind: 'buy'; item?: string; itemKind?: PurchaseKind; label?: string }
  /** 当前拥有 count 处产业（type 限定类型；tier = 至少到第几档，的士车队即车辆数） */
  | { kind: 'ownBiz'; type?: string; count: number; tier?: number; label?: string }
  /** 本步骤开始后累计产业入账 amount（bizIncome 事件，含经理自动入账） */
  | { kind: 'bizIncome'; amount: number; label?: string }
  /** 净资产达到 amount */
  | { kind: 'netWorth'; amount: number; label?: string }
  /** 等级达到 level */
  | { kind: 'level'; level: number; label?: string }

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
  /** story（缺省）= 故事线，allDone 只算它；empire = 帝国线，故事线全部完成后自动接上 */
  tier?: 'story' | 'empire'
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
    intro: '把金色轿车完好送到商店门口（粉色标记）。',
    steps: [{ kind: 'deliver', from: { type: 'landmark' }, to: { type: 'shop' }, label: '上金色轿车，送到粉色标记' }],
  },
  {
    id: 'm_race', title: '赶时间', roles: ['gang'], giver: { type: 'shop' }, reward: 450, timeLimit: 70,
    intro: '限时赶到地标（粉色标记），用什么交通工具随你。',
    steps: [{ kind: 'goto', poi: { type: 'landmark' }, label: '限时赶到粉色标记' }],
  },
  {
    id: 'm_wreck', title: '街头破坏', roles: ['gang'], giver: { type: 'landmark' }, reward: 900, timeLimit: 90, requires: 'm_deliver',
    intro: '限时撞毁 4 辆车，然后甩掉警察。',
    steps: [{ kind: 'wreck', count: 4, label: '撞毁车辆' }],
  },

  // ---------- 帝国线（P8.5）：故事线全部完成后自动接上，按 next 串联 ----------
  // 黑帮：地盘初成 → 拆车厂 → 赌档 → 话事人
  {
    id: 'emp_gang_1', title: '地盘初成', roles: ['gang'], giver: 'auto', tier: 'empire', reward: 150, next: 'emp_gang_2',
    intro: '老大拍拍你肩膀：光收茶水费没出息，罩住两家店，那才叫地盘。',
    steps: [{ kind: 'ownBiz', type: 'biz_protect', count: 2, label: '到商店门口按 E「买下 保护费地盘」，罩住 2 家' }],
  },
  {
    id: 'emp_gang_2', title: '拆车厂', roles: ['gang'], giver: 'auto', tier: 'empire', reward: 600, next: 'emp_gang_3', requires: 'emp_gang_1',
    intro: '偷来的车总得有个去处。混出点名堂，去工地盘个拆车厂。',
    steps: [
      { kind: 'level', level: 6, label: '混到 Lv6（干活、收钱都涨经验）' },
      { kind: 'ownBiz', type: 'biz_chop', count: 1, label: '到工地门口按 E 买下拆车厂' },
    ],
  },
  {
    id: 'emp_gang_3', title: '赌档', roles: ['gang'], giver: 'auto', tier: 'empire', reward: 3000, next: 'emp_gang_4', requires: 'emp_gang_2',
    intro: '熟食中心楼上那间麻将馆，谁坐镇谁就是这条街的话事人候选。',
    steps: [
      { kind: 'level', level: 12, label: '在道上升到 Lv12' },
      { kind: 'ownBiz', type: 'biz_gamble', count: 1, label: '到小贩中心门口按 E 盘下地下赌档' },
    ],
  },
  {
    id: 'emp_gang_4', title: '话事人', roles: ['gang'], giver: 'auto', tier: 'empire', reward: 25000, requires: 'emp_gang_3',
    intro: '地盘、车厂、赌档都有了。身家过二十五万，整条街都得听你的。',
    steps: [{ kind: 'netWorth', amount: 250000, label: '净资产做到 $250,000' }],
  },
  // 蓝领：自己的档口 → 车队 → 搬新家 → 小老板
  {
    id: 'emp_blue_1', title: '自己的档口', roles: ['blue'], giver: 'auto', tier: 'empire', reward: 100, next: 'emp_blue_2',
    intro: '帮人打工一辈子也是打工。盘个炒粿条档口，做自己的老板。',
    steps: [
      { kind: 'ownBiz', type: 'biz_hawker', count: 1, label: '到小贩中心门口按 E 买下档口' },
      { kind: 'bizIncome', amount: 100, label: '隔天回档口门口收钱' },
    ],
  },
  {
    id: 'emp_blue_2', title: '车队', roles: ['blue'], giver: 'auto', tier: 'empire', reward: 900, next: 'emp_blue_3', requires: 'emp_blue_1',
    intro: '老司机都知道：自己开车赚辛苦钱，让车替你跑才赚大钱。',
    steps: [
      { kind: 'level', level: 4, label: '升到 Lv4 解锁的士车队' },
      { kind: 'ownBiz', type: 'biz_fleet', count: 1, tier: 3, label: '到的士站门口买下车队并扩到 3 辆' },
    ],
  },
  {
    id: 'emp_blue_3', title: '搬新家', roles: ['blue'], giver: 'auto', tier: 'empire', reward: 800, next: 'emp_blue_4', requires: 'emp_blue_2',
    intro: '租来的床位睡不踏实，是时候给自己置一套房了。',
    steps: [{ kind: 'buy', itemKind: 'property', label: '到房产门口买下一套房（HDB 起步）' }],
  },
  {
    id: 'emp_blue_4', title: '小老板', roles: ['blue'], giver: 'auto', tier: 'empire', reward: 10000, requires: 'emp_blue_3',
    intro: '档口、车队、房子都齐了，再攒一攒，街坊都要叫你一声老板。',
    steps: [{ kind: 'netWorth', amount: 100000, label: '净资产做到 $100,000' }],
  },
  // 白领：副业 → 辞职创业 → 买公寓 → 独角兽
  {
    id: 'emp_white_1', title: '副业', roles: ['white'], giver: 'auto', tier: 'empire', reward: 250, next: 'emp_white_2',
    intro: 'KPI 考不完，工资涨不动。下班后租层共享办公，先把副业做起来。',
    steps: [{ kind: 'ownBiz', type: 'biz_startup', count: 1, label: '到办公楼门口按 E 开一家创业公司' }],
  },
  {
    id: 'emp_white_2', title: '辞职创业', roles: ['white'], giver: 'auto', tier: 'empire', reward: 5000, next: 'emp_white_3', requires: 'emp_white_1',
    intro: '副业的收入快追上工资了。把公司做到 T3，就可以潇洒地递辞职信。',
    steps: [{ kind: 'ownBiz', type: 'biz_startup', count: 1, tier: 3, label: '把创业公司升级到 T3' }],
  },
  {
    id: 'emp_white_3', title: '买公寓', roles: ['white'], giver: 'auto', tier: 'empire', reward: 6000, next: 'emp_white_4', requires: 'emp_white_2',
    intro: '创业者也要有个体面的落脚处，丈母娘问起来也好回答。',
    steps: [{ kind: 'buy', itemKind: 'property', label: '到房产门口买下一套房（公寓最体面）' }],
  },
  {
    id: 'emp_white_4', title: '独角兽', roles: ['white'], giver: 'auto', tier: 'empire', reward: 50000, requires: 'emp_white_3',
    intro: '投资人开始排队了。身家做到五十万，你就是圈里人人想见的独角兽创始人。',
    steps: [{ kind: 'netWorth', amount: 500000, label: '净资产做到 $500,000' }],
  },
  // 金领：收租 → 写字楼 → 豪车 → 地标
  {
    id: 'emp_gold_1', title: '收租', roles: ['gold'], giver: 'auto', tier: 'empire', reward: 1500, next: 'emp_gold_2',
    intro: '钱生钱的第一步：买下店面，坐着收租。',
    steps: [
      { kind: 'ownBiz', type: 'biz_rental', count: 1, label: '到商店门口按 E 买下商铺出租' },
      { kind: 'bizIncome', amount: 2000, label: '隔天去收第一笔租金' },
    ],
  },
  {
    id: 'emp_gold_2', title: '写字楼', roles: ['gold'], giver: 'auto', tier: 'empire', reward: 6000, next: 'emp_gold_3', requires: 'emp_gold_1',
    intro: '商铺是小钱，甲级写字楼的股份才是真资产。',
    steps: [
      { kind: 'level', level: 5, label: '升到 Lv5 解锁写字楼股份' },
      { kind: 'ownBiz', type: 'biz_office', count: 1, label: '到办公楼门口买下写字楼股份' },
    ],
  },
  {
    id: 'emp_gold_3', title: '豪车', roles: ['gold'], giver: 'auto', tier: 'empire', reward: 12000, next: 'emp_gold_4', requires: 'emp_gold_2',
    intro: '酒会门口泊车小弟只认车标。去提一台限量超跑。',
    steps: [
      { kind: 'level', level: 10, label: '升到 Lv10 解锁超跑' },
      { kind: 'buy', item: 'car_super', label: '手机「商店」买下超跑' },
    ],
  },
  {
    id: 'emp_gold_4', title: '地标', roles: ['gold'], giver: 'auto', tier: 'empire', reward: 500000, requires: 'emp_gold_3',
    intro: '城市天际线上该有你的名字：参股地标项目，身家做到五百万。',
    steps: [
      { kind: 'level', level: 12, label: '升到 Lv12 解锁地标项目' },
      { kind: 'ownBiz', type: 'biz_landmark', count: 1, label: '到地标门口参股地标项目' },
      { kind: 'netWorth', amount: 5000000, label: '净资产做到 $5,000,000' },
    ],
  },
]
