import { clampTier, tierLabel } from './tiers'
import { t } from '../i18n'

/**
 * P10.D 射击竞技（类 CS2 5v5 爆破）数据：武器 / 装备 / 经济 / 模式 / 难度 / 段位。
 * 单位：米、秒。CS 的 1 unit ≈ 0.026 m（跑速 250 u/s ≈ 6.5 m/s）。
 */

export const U = 0.026
export type Side = 'T' | 'CT'
export type WeaponKind = 'knife' | 'pistol' | 'smg' | 'rifle' | 'sniper' | 'shotgun'
export type Slot = 'primary' | 'secondary' | 'knife' | 'grenade' | 'c4'

export interface WeaponDef {
  id: string
  name: string
  kind: WeaponKind
  slot: Slot
  price: number
  /** 限定阵营（undefined = 双方） */
  side?: Side
  damage: number
  /** 打在护甲上时保留的伤害比例（CS armor penetration） */
  armorPen: number
  /** 爆头倍率 */
  hsMul: number
  /** 每分钟射速 */
  rpm: number
  auto: boolean
  mag: number
  reserve: number
  reload: number
  /** 持枪跑速 m/s */
  speed: number
  /** 每 500u（13 m）伤害衰减系数 */
  rangeMod: number
  /** 散布（弧度）：站立基础 / 满速移动附加 / 空中附加 / 每发累积 / 累积上限 */
  spread: number
  moveSpread: number
  airSpread: number
  bloom: number
  bloomMax: number
  /** 后坐力：前 10 发总上扬（度）、之后左右摆幅（度）、横向偏好 */
  recoilUp: number
  recoilSway: number
  recoilBias: number
  /** 弹丸数（霰弹） */
  pellets?: number
  /** 击杀奖励 */
  killReward: number
  /** 开镜 FOV 两档（狙击） */
  scope?: [number, number]
  /** 枪声：基频/衰减/音量（ArenaSfx） */
  sound: { pitch: number; decay: number; vol: number; crack?: number }
  /** 枪模颜色 */
  color: number
}

const rpmOf = (r: number) => r
export const WEAPONS: Record<string, WeaponDef> = {
  knife: {
    id: 'knife', name: t('军刀'), kind: 'knife', slot: 'knife', price: 0, damage: 40, armorPen: 0.85, hsMul: 1, rpm: rpmOf(150), auto: true, mag: 0, reserve: 0, reload: 0,
    speed: 250 * U, rangeMod: 1, spread: 0, moveSpread: 0, airSpread: 0, bloom: 0, bloomMax: 0, recoilUp: 0, recoilSway: 0, recoilBias: 0, killReward: 1500,
    sound: { pitch: 900, decay: 0.08, vol: 0.25 }, color: 0x9aa3ad,
  },
  glock: {
    id: 'glock', name: t('G18 手枪'), kind: 'pistol', slot: 'secondary', price: 200, side: 'T', damage: 30, armorPen: 0.47, hsMul: 4, rpm: 400, auto: false, mag: 20, reserve: 120, reload: 2.27,
    speed: 240 * U, rangeMod: 0.85, spread: 0.0065, moveSpread: 0.03, airSpread: 0.12, bloom: 0.01, bloomMax: 0.035, recoilUp: 2.2, recoilSway: 0.6, recoilBias: 0.2, killReward: 300,
    sound: { pitch: 520, decay: 0.12, vol: 0.55 }, color: 0x2b2b2b,
  },
  usp: {
    id: 'usp', name: t('USP-S 消音'), kind: 'pistol', slot: 'secondary', price: 200, side: 'CT', damage: 35, armorPen: 0.505, hsMul: 4, rpm: 352, auto: false, mag: 12, reserve: 24, reload: 2.2,
    speed: 240 * U, rangeMod: 0.91, spread: 0.0045, moveSpread: 0.03, airSpread: 0.12, bloom: 0.012, bloomMax: 0.04, recoilUp: 2.4, recoilSway: 0.5, recoilBias: -0.2, killReward: 300,
    sound: { pitch: 1400, decay: 0.07, vol: 0.28 }, color: 0x33363b,
  },
  deagle: {
    id: 'deagle', name: t('沙漠之鹰'), kind: 'pistol', slot: 'secondary', price: 700, damage: 53, armorPen: 0.932, hsMul: 3.9, rpm: 267, auto: false, mag: 7, reserve: 35, reload: 2.2,
    speed: 230 * U, rangeMod: 0.85, spread: 0.004, moveSpread: 0.08, airSpread: 0.2, bloom: 0.035, bloomMax: 0.07, recoilUp: 5, recoilSway: 1.2, recoilBias: 0.3, killReward: 300,
    sound: { pitch: 260, decay: 0.22, vol: 0.85, crack: 1 }, color: 0x8c8f94,
  },
  mac10: {
    id: 'mac10', name: t('MAC-10 冲锋枪'), kind: 'smg', slot: 'primary', price: 1050, side: 'T', damage: 29, armorPen: 0.575, hsMul: 4, rpm: 800, auto: true, mag: 30, reserve: 100, reload: 2.6,
    speed: 240 * U, rangeMod: 0.8, spread: 0.009, moveSpread: 0.028, airSpread: 0.13, bloom: 0.004, bloomMax: 0.03, recoilUp: 4.5, recoilSway: 1.6, recoilBias: 0.4, killReward: 600,
    sound: { pitch: 620, decay: 0.08, vol: 0.5 }, color: 0x2a2a2a,
  },
  mp9: {
    id: 'mp9', name: t('MP9 冲锋枪'), kind: 'smg', slot: 'primary', price: 1250, side: 'CT', damage: 26, armorPen: 0.6, hsMul: 4, rpm: 857, auto: true, mag: 30, reserve: 120, reload: 2.1,
    speed: 240 * U, rangeMod: 0.87, spread: 0.008, moveSpread: 0.025, airSpread: 0.13, bloom: 0.004, bloomMax: 0.028, recoilUp: 4, recoilSway: 1.4, recoilBias: -0.3, killReward: 600,
    sound: { pitch: 700, decay: 0.07, vol: 0.45 }, color: 0x2e3238,
  },
  nova: {
    id: 'nova', name: t('Nova 霰弹枪'), kind: 'shotgun', slot: 'primary', price: 1050, damage: 26, armorPen: 0.5, hsMul: 4, rpm: 68, auto: false, mag: 8, reserve: 32, reload: 2.8,
    speed: 220 * U, rangeMod: 0.7, spread: 0.045, moveSpread: 0.02, airSpread: 0.1, bloom: 0, bloomMax: 0, recoilUp: 4, recoilSway: 0.5, recoilBias: 0, pellets: 9, killReward: 900,
    sound: { pitch: 180, decay: 0.3, vol: 0.95 }, color: 0x4a3a2a,
  },
  ak47: {
    id: 'ak47', name: t('AK-47 步枪'), kind: 'rifle', slot: 'primary', price: 2700, side: 'T', damage: 36, armorPen: 0.775, hsMul: 4, rpm: 600, auto: true, mag: 30, reserve: 90, reload: 2.5,
    speed: 215 * U, rangeMod: 0.98, spread: 0.0042, moveSpread: 0.1, airSpread: 0.25, bloom: 0.006, bloomMax: 0.035, recoilUp: 6.5, recoilSway: 2.6, recoilBias: 0.3, killReward: 300,
    sound: { pitch: 300, decay: 0.16, vol: 0.8, crack: 0.6 }, color: 0x5a3b22,
  },
  m4a4: {
    id: 'm4a4', name: t('M4A4 步枪'), kind: 'rifle', slot: 'primary', price: 3100, side: 'CT', damage: 33, armorPen: 0.7, hsMul: 4, rpm: 666, auto: true, mag: 30, reserve: 90, reload: 3.1,
    speed: 225 * U, rangeMod: 0.97, spread: 0.0035, moveSpread: 0.09, airSpread: 0.25, bloom: 0.005, bloomMax: 0.03, recoilUp: 5.2, recoilSway: 2.0, recoilBias: -0.3, killReward: 300,
    sound: { pitch: 380, decay: 0.13, vol: 0.7, crack: 0.5 }, color: 0x25282c,
  },
  awp: {
    id: 'awp', name: t('AWP 狙击枪'), kind: 'sniper', slot: 'primary', price: 4750, damage: 115, armorPen: 0.975, hsMul: 4, rpm: 41, auto: false, mag: 5, reserve: 30, reload: 3.7,
    speed: 200 * U, rangeMod: 0.99, spread: 0.0012, moveSpread: 0.16, airSpread: 0.4, bloom: 0, bloomMax: 0, recoilUp: 3, recoilSway: 0.3, recoilBias: 0, killReward: 100,
    scope: [40, 15], sound: { pitch: 150, decay: 0.45, vol: 1.0, crack: 1.2 }, color: 0x3f5a3a,
  },
}
/** 狙击未开镜散布 */
export const AWP_NOSCOPE_SPREAD = 0.09

export interface EquipDef { id: string; name: string; price: number; side?: Side; kind: 'armor' | 'helmet' | 'kit' | 'he' | 'smoke' | 'flash' }
export const EQUIP: Record<string, EquipDef> = {
  vest: { id: 'vest', name: t('防弹衣'), price: 650, kind: 'armor' },
  vesthelm: { id: 'vesthelm', name: t('防弹衣+头盔'), price: 1000, kind: 'helmet' },
  kit: { id: 'kit', name: t('拆弹器'), price: 400, side: 'CT', kind: 'kit' },
  he: { id: 'he', name: t('高爆手雷'), price: 300, kind: 'he' },
  smoke: { id: 'smoke', name: t('烟雾弹'), price: 300, kind: 'smoke' },
  flash: { id: 'flash', name: t('闪光弹'), price: 200, kind: 'flash' },
}
export const GRENADE_NAMES: Record<string, string> = { he: t('高爆手雷'), smoke: t('烟雾弹'), flash: t('闪光弹') }

/** 购买菜单分组（数字键：组号 → 组内序号） */
export const BUY_MENU: { title: string; items: string[] }[] = [
  { title: t('手枪'), items: ['glock', 'usp', 'deagle'] },
  { title: t('冲锋/霰弹'), items: ['mac10', 'mp9', 'nova'] },
  { title: t('步枪'), items: ['ak47', 'm4a4', 'awp'] },
  { title: t('装备'), items: ['vest', 'vesthelm', 'kit'] },
  { title: t('投掷物'), items: ['he', 'smoke', 'flash'] },
]

export const ECON = {
  start: 800,
  max: 16000,
  win: 3250,
  winBomb: 3500,
  lossBonus: [1400, 1900, 2400, 2900, 3400],
  plantBonusTeam: 800,
  plantPlayer: 300,
  defusePlayer: 300,
}

export const TIMES = {
  freeze: 15,
  round: 115,
  buyWindow: 20,
  bomb: 40,
  plant: 3.2,
  defuse: 10,
  defuseKit: 5,
  roundEnd: 5,
}

/** 胜利回合数 / 半场 */
export const MATCH = { winRounds: 7, half: 6, duelWin: 5, dmTime: 300 }

/** Bot 难度 = 级别 1–10（src/data/tiers.ts）；T4 ≈ 旧“新手”、T6 ≈ 旧“普通”、T8 ≈ 旧“职业” */
export type Difficulty = number
export interface DiffParams {
  label: string
  /** 反应时间（秒） */
  reaction: number
  /** 瞄准误差（度，初始放大后收敛） */
  aimError: number
  /** 转向速度（度/秒） */
  turnSpeed: number
  /** 爆头倾向 0–1 */
  headPref: number
  /** 后坐力补偿 0–1 */
  recoilComp: number
  /** 急停概率 */
  counterStrafe: number
  /** 视野（度） */
  fov: number
  /** 点射长度（远距离） */
  burst: number
  /** 对玩家造成伤害的倍率（低级别手下留情） */
  dmgMul: number
  /** 会不会用烟雾弹 / 手雷 */
  utility: boolean
}
type Anchor = Omit<DiffParams, 'label' | 'utility'>
/** 插值锚点：级别 → 参数 */
const DIFF_ANCHORS: [number, Anchor][] = [
  [1, { reaction: 1.1, aimError: 6, turnSpeed: 110, headPref: 0, recoilComp: 0, counterStrafe: 0, fov: 80, burst: 14, dmgMul: 0.5 }],
  [4, { reaction: 0.6, aimError: 3.2, turnSpeed: 160, headPref: 0.08, recoilComp: 0, counterStrafe: 0, fov: 100, burst: 12, dmgMul: 0.9 }],
  [5, { reaction: 0.47, aimError: 2.3, turnSpeed: 220, headPref: 0.2, recoilComp: 0.25, counterStrafe: 0.25, fov: 108, burst: 9, dmgMul: 1 }],
  [6, { reaction: 0.35, aimError: 1.6, turnSpeed: 280, headPref: 0.3, recoilComp: 0.5, counterStrafe: 0.5, fov: 115, burst: 6, dmgMul: 1 }],
  [8, { reaction: 0.2, aimError: 0.7, turnSpeed: 480, headPref: 0.6, recoilComp: 0.9, counterStrafe: 1, fov: 125, burst: 4, dmgMul: 1 }],
  [10, { reaction: 0.14, aimError: 0.4, turnSpeed: 620, headPref: 0.75, recoilComp: 1, counterStrafe: 1, fov: 135, burst: 3, dmgMul: 1 }],
]
/** T2/T3 的伤害倍率按计划单独定（插值会偏高） */
const DMG_MUL: Record<number, number> = { 2: 0.6, 3: 0.75 }
const diffCache = new Map<number, DiffParams>()
export function botParams(t: Difficulty): DiffParams {
  const k = clampTier(t)
  let p = diffCache.get(k)
  if (p) return p
  let i = 0
  while (i < DIFF_ANCHORS.length - 2 && DIFF_ANCHORS[i + 1][0] < k) i++
  const [ta, a] = DIFF_ANCHORS[i], [tb, b] = DIFF_ANCHORS[i + 1]
  const u = Math.max(0, Math.min(1, (k - ta) / (tb - ta)))
  const o = {} as Anchor
  for (const key of Object.keys(a) as (keyof Anchor)[]) o[key] = a[key] + (b[key] - a[key]) * u
  o.burst = Math.round(o.burst)
  o.dmgMul = DMG_MUL[k] ?? o.dmgMul
  p = { ...o, label: tierLabel(k), utility: k >= 4 }
  diffCache.set(k, p)
  return p
}
/** 旧字符串难度 → 级别（调试 API 兼容） */
export const DIFF_ALIAS: Record<string, number> = { novice: 4, normal: 6, pro: 8 }
export const toTier = (d: Difficulty | string): number => clampTier(typeof d === 'string' ? DIFF_ALIAS[d] ?? Number(d) : d)
/** 记分板 ★ / 职业式走位门槛 */
export const PRO_TIER = 8

export type ArenaModeId = 'casual' | 'ranked' | 'pro' | 'duel' | 'dm'
export interface ModeDef {
  id: ArenaModeId
  name: string
  fee: number
  /** 胜利奖金 */
  prize: number
  /** 个人表现奖金：每击杀 / MVP */
  perKill: number
  perMvp: number
  unlock?: string
  desc: string
}
export const MODES: Record<ArenaModeId, ModeDef> = {
  casual: { id: 'casual', name: t('5v5 爆破（休闲）'), fee: 50, prize: 150, perKill: 10, perMvp: 20, desc: t('先赢 7 回合 · 难度可选（赢一局解锁下一级）') },
  ranked: { id: 'ranked', name: t('5v5 天梯'), fee: 200, prize: 600, perKill: 30, perMvp: 60, unlock: 'arena_ranked', desc: t('影响段位 · Bot 随段位变强') },
  pro: { id: 'pro', name: t('职业联赛'), fee: 1000, prize: 3000, perKill: 120, perMvp: 250, unlock: 'arena_pro', desc: t('T8–T10 Bot · 高额奖金') },
  duel: { id: 'duel', name: t('1v1 单挑'), fee: 100, prize: 250, perKill: 0, perMvp: 0, desc: t('先赢 5 回合 · 无炸弹 · 难度可选') },
  dm: { id: 'dm', name: t('死斗热身'), fee: 0, prize: 0, perKill: 0, perMvp: 0, desc: t('免费 · 5 分钟 · 随买随用') },
}

/** 段位：ELO → 名称 */
export const RANKS: { name: string; min: number }[] = [
  { name: t('青铜 I'), min: -Infinity }, { name: t('青铜 II'), min: 800 }, { name: t('青铜 III'), min: 900 },
  { name: t('白银 I'), min: 1000 }, { name: t('白银 II'), min: 1100 }, { name: t('白银 III'), min: 1200 },
  { name: t('黄金 I'), min: 1300 }, { name: t('黄金 II'), min: 1400 }, { name: t('黄金 III'), min: 1500 },
  { name: t('铂金 I'), min: 1600 }, { name: t('铂金 II'), min: 1700 }, { name: t('铂金 III'), min: 1800 },
  { name: t('钻石 I'), min: 1900 }, { name: t('钻石 II'), min: 2000 }, { name: t('钻石 III'), min: 2100 },
  { name: t('大师'), min: 2200 }, { name: t('传奇'), min: 2500 },
]
export const ELO_START = 1000
export function rankOf(elo: number): string {
  let r = RANKS[0].name
  for (const k of RANKS) if (elo >= k.min) r = k.name
  return r
}
/** bot 级别等效 ELO */
export const DIFF_ELO = (t: Difficulty) => 700 + 170 * (clampTier(t) - 1)
/** 天梯 bot 难度：按 ELO 定中心级别，5 个敌方 bot 在中心 ±1 混合 */
export function rankedDifficulty(elo: number): Difficulty[] {
  const c = clampTier(Math.round((elo - 700) / 170) + 1)
  return [c - 1, c, c, c, c + 1].map(clampTier)
}

/** 伤害部位倍率（头部用武器 hsMul） */
export const HIT_MUL = { head: 0, chest: 1, stomach: 1.25, legs: 0.75 }
export type HitGroup = keyof typeof HIT_MUL

export const BOT_NAMES_T = [t('阿强'), t('老黑'), 'Ah Beng', 'Rizal', 'Kumar', t('大头'), 'Jun', 'Wei', 'Siva', 'Ahmad']
export const BOT_NAMES_CT = ['Marcus', t('志明'), 'Hafiz', 'Daniel', 'Ravi', 'Kenji', 'Leon', 'Ivan', 'Arjun', 'Tan']

/**
 * 确定性后坐力图案（度）：返回第 i 发的累计偏移 [yaw 右正, pitch 上正]。
 * 前 10 发主要上扬（先快后慢），之后沿正弦左右摆、继续缓慢上飘——每把枪固定，可练压枪。
 */
export function recoilAt(def: WeaponDef, i: number): [number, number] {
  if (i <= 0 || def.recoilUp === 0) return [0, 0]
  const n = Math.min(i, 30)
  // 上扬：前 10 发占 recoilUp，之后每发 +3%
  const k = Math.min(n, 10) / 10
  let pitch = def.recoilUp * (1 - (1 - k) * (1 - k))
  if (n > 10) pitch += def.recoilUp * 0.03 * (n - 10)
  // 横向：前 10 发轻微偏向 bias，之后摆动
  let yaw = def.recoilBias * def.recoilUp * 0.12 * Math.min(n, 10) / 10
  if (n > 10) {
    const t = (n - 10) / 20
    yaw += def.recoilSway * Math.sin(t * Math.PI * 1.6 + 0.4) * (0.6 + 0.4 * t) * (def.recoilBias >= 0 ? -1 : 1)
  }
  // 小数发插值（idx 衰减时平滑回落）
  const frac = i - Math.floor(i)
  if (frac > 0 && i < 30) {
    const [y2, p2] = recoilAt(def, Math.floor(i) + 1)
    const [y1, p1] = Math.floor(i) <= 0 ? [0, 0] : recoilAt(def, Math.floor(i))
    return [y1 + (y2 - y1) * frac, p1 + (p2 - p1) * frac]
  }
  return [yaw, pitch]
}
