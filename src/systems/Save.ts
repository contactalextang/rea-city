import type { Ctx } from '../core/Context'
import { isRoleId, type RoleId } from '../data/roles'
import type { JobsSave } from './Jobs'
import type { QuestsSave } from './Quests'
import type { WeatherSave } from './Weather'
import type { ProgressSave } from './Progress'
import type { AssetsSave } from './Assets'
import type { BizSave } from './Business'
import type { LedgerSave } from './Wallet'

import { MOOD } from './Needs'

export const SAVE_KEY = 'rea.save'

export interface SaveData {
  v: 1
  role: RoleId
  /** 存档所在世界；与当前世界不同则不恢复位置（旧存档缺省视为 grid） */
  world?: 'sg' | 'grid'
  money: number
  day: number
  hour: number
  x: number
  z: number
  yaw: number
  inVehicle: false
  /** mood：P10 心情（旧存档缺省 → 70） */
  needs: { hunger: number; energy: number; mood?: number }
  law: { demerits: number; fines: number; arrests: number; licenseSuspendedUntilDay: number }
  /** 工作统计（今日收入/的士评分/投资持仓）与任务进度；旧存档可缺省 */
  jobs?: JobsSave
  quests?: QuestsSave
  /** 天气（状态 + 自然剩余 + 手动锁定剩余）；旧存档可缺省 */
  weather?: WeatherSave
  /** 成长（等级/XP/成就/终身统计）、资产、产业（Phase 8）；旧存档缺省 → 各系统用默认值，v 仍为 1 */
  progress?: ProgressSave
  assets?: AssetsSave
  biz?: BizSave
  /** P10：钱包分类账（今日 / 累计各类别收支）；旧存档缺省 → 空账本 */
  wallet?: LedgerSave
  /** P10 娱乐插件存档，键 = GamePlugin.id */
  plugins?: Record<string, unknown>
  savedAt: number
}
export interface SaveExtra { jobs?: JobsSave; quests?: QuestsSave; weather?: WeatherSave; progress?: ProgressSave; assets?: AssetsSave; biz?: BizSave; wallet?: LedgerSave; plugins?: Record<string, unknown> }

/** 把当前状态写入 localStorage；返回写入的数据（失败返回 null） */
export function save(ctx: Ctx, extra: SaveExtra = {}): SaveData | null {
  const pl = ctx.player, law = ctx.law
  const data: SaveData = {
    v: 1, role: ctx.role.id, world: ctx.settings.world, money: pl.money, day: ctx.clock.day, hour: ctx.clock.hour,
    x: pl.worldX, z: pl.worldZ, yaw: pl.vehicle ? pl.vehicle.yaw : pl.yaw, inVehicle: false,
    needs: { hunger: ctx.needs.hunger, energy: ctx.needs.energy, mood: Math.round(ctx.needs.mood * 10) / 10 },
    law: { demerits: law.demerits, fines: law.fines, arrests: law.arrests, licenseSuspendedUntilDay: law.licenseSuspendedUntilDay },
    jobs: extra.jobs, quests: extra.quests, weather: extra.weather,
    progress: extra.progress, assets: extra.assets, biz: extra.biz, wallet: extra.wallet, plugins: extra.plugins,
    savedAt: Date.now(),
  }
  try { localStorage.setItem(SAVE_KEY, JSON.stringify(data)) } catch { return null }
  return data
}

export function load(): SaveData | null {
  try {
    const raw = localStorage.getItem(SAVE_KEY)
    if (!raw) return null
    const d = JSON.parse(raw) as Partial<SaveData>
    if (d.v !== 1 || !isRoleId(d.role) || typeof d.money !== 'number' || typeof d.x !== 'number' || typeof d.z !== 'number') return null
    return d as SaveData
  } catch { return null }
}

export function clear() { try { localStorage.removeItem(SAVE_KEY) } catch { /* 忽略 */ } }

/** 把存档套用到运行中的世界：钱、时间、位置、需求、执法记录（不处理车辆） */
export function apply(ctx: Ctx, d: SaveData) {
  const pl = ctx.player
  if (pl.vehicle) pl.exit(ctx.world)
  pl.money = d.money
  ctx.clock.set(d.hour ?? 7.5, d.day ?? 1)
  pl.place(d.x, d.z, d.yaw ?? 0)
  ctx.needs.set(d.needs?.hunger ?? 80, d.needs?.energy ?? 100)
  ctx.needs.mood = typeof d.needs?.mood === 'number' ? d.needs.mood : MOOD.start
  ctx.needs.sync()
  const law = ctx.law
  law.demerits = d.law?.demerits ?? 0
  law.fines = d.law?.fines ?? 0
  law.arrests = d.law?.arrests ?? 0
  law.licenseSuspendedUntilDay = d.law?.licenseSuspendedUntilDay ?? -1
}
