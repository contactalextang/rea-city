import type { Ctx } from '../core/Context'
import { isRoleId, type RoleId } from '../data/roles'
import type { JobsSave } from './Jobs'
import type { QuestsSave } from './Quests'

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
  needs: { hunger: number; energy: number }
  law: { demerits: number; fines: number; arrests: number; licenseSuspendedUntilDay: number }
  /** 工作统计（今日收入/的士评分/投资持仓）与任务进度；旧存档可缺省 */
  jobs?: JobsSave
  quests?: QuestsSave
  savedAt: number
}
export interface SaveExtra { jobs?: JobsSave; quests?: QuestsSave }

/** 把当前状态写入 localStorage；返回写入的数据（失败返回 null） */
export function save(ctx: Ctx, extra: SaveExtra = {}): SaveData | null {
  const pl = ctx.player, law = ctx.law
  const data: SaveData = {
    v: 1, role: ctx.role.id, world: ctx.settings.world, money: pl.money, day: ctx.clock.day, hour: ctx.clock.hour,
    x: pl.worldX, z: pl.worldZ, yaw: pl.vehicle ? pl.vehicle.yaw : pl.yaw, inVehicle: false,
    needs: { hunger: ctx.needs.hunger, energy: ctx.needs.energy },
    law: { demerits: law.demerits, fines: law.fines, arrests: law.arrests, licenseSuspendedUntilDay: law.licenseSuspendedUntilDay },
    jobs: extra.jobs, quests: extra.quests,
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
  ctx.needs.sync()
  const law = ctx.law
  law.demerits = d.law?.demerits ?? 0
  law.fines = d.law?.fines ?? 0
  law.arrests = d.law?.arrests ?? 0
  law.licenseSuspendedUntilDay = d.law?.licenseSuspendedUntilDay ?? -1
}
