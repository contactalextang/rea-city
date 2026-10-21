import { DEFAULT_ROLE, isRoleId, type RoleId } from '../data/roles'

/** 运行时设置：localStorage 持久化，URL 查询参数优先覆盖（如 ?world=grid&chars=box&shadows=0&role=white&law=real） */
export interface Settings {
  world: 'sg' | 'grid'      // 路网/城市数据源
  timeSpeed: number          // 游戏时间流速倍率
  chars: 'gltf' | 'box'     // 角色渲染：骨骼 glTF 或方块
  shadows: boolean
  music: boolean             // 背景音乐（?music=0 关闭）
  role: RoleId               // 玩家身份（见 data/roles.ts）
  lawStrictness: LawStrictness   // 执法松紧：casual 默认畅玩（只管严重犯罪）/ relaxed 宽松 / real 接近真实（见 systems/Law.ts LAW_TUNING）
  fx: FxQuality              // 后期画质：high（GTAO+泛光+调色）/ low（半分辨率泛光+调色）/ off（直出，仍 AgX）
  brightness: number         // 画面亮度倍率 0.7–1.6（乘到曝光；?bright=1.2）
}
export const BRIGHTNESS_MIN = 0.7, BRIGHTNESS_MAX = 1.6
export const clampBrightness = (n: number) => Math.min(BRIGHTNESS_MAX, Math.max(BRIGHTNESS_MIN, n))
export type FxQuality = 'high' | 'low' | 'off'
export type LawStrictness = 'casual' | 'relaxed' | 'real'

export const DEFAULT_SETTINGS: Settings = { world: 'sg', timeSpeed: 1, chars: 'gltf', shadows: true, music: true, role: DEFAULT_ROLE, lawStrictness: 'casual', fx: 'high', brightness: 1 }
const KEY = 'rea.settings'

const parseBool = (v: string) => !(v === '0' || v === 'false' || v === 'off' || v === 'no')

/** 读取设置：默认值 ← localStorage ← URL 参数 */
export function loadSettings(search = typeof location !== 'undefined' ? location.search : ''): Settings {
  const s: Settings = { ...DEFAULT_SETTINGS }
  try {
    const raw = localStorage.getItem(KEY)
    if (raw) {
      // chars 只认 URL（?chars=box 回退），旧版本存过的 chars:'box' 不再生效
      const stored = JSON.parse(raw) as Record<string, unknown>
      delete stored.chars
      // lawStrictness 只认 URL（?law=relaxed|real）：旧版本存过的 relaxed 会挡住新默认 casual
      delete stored.lawStrictness
      apply(s, stored)
    }
  } catch { /* 隐私模式或数据损坏：忽略 */ }
  const q = new URLSearchParams(search)
  const fromUrl: Record<string, unknown> = {}
  for (const [k, v] of q) fromUrl[k] = v
  apply(s, fromUrl)
  return s
}

export function saveSettings(s: Settings) {
  try { localStorage.setItem(KEY, JSON.stringify(s)) } catch { /* 忽略 */ }
}

function apply(s: Settings, src: Record<string, unknown>) {
  if (src.world === 'sg' || src.world === 'grid') s.world = src.world
  if (src.chars === 'gltf' || src.chars === 'box') s.chars = src.chars
  if (src.timeSpeed !== undefined) { const n = Number(src.timeSpeed); if (Number.isFinite(n) && n > 0) s.timeSpeed = n }
  if (isRoleId(src.role)) s.role = src.role
  // ?law=real 是 ?lawStrictness=real 的简写
  for (const v of [src.lawStrictness, src.law]) if (v === 'casual' || v === 'relaxed' || v === 'real') s.lawStrictness = v
  if (src.music !== undefined) s.music = typeof src.music === 'boolean' ? src.music : parseBool(String(src.music))
  if (src.fx === 'high' || src.fx === 'low' || src.fx === 'off') s.fx = src.fx
  // ?bright=1.2 是 ?brightness=1.2 的简写
  for (const v of [src.brightness, src.bright]) if (v !== undefined && v !== '') { const n = Number(v); if (Number.isFinite(n)) s.brightness = clampBrightness(n) }
  if (src.shadows !== undefined) s.shadows = typeof src.shadows === 'boolean' ? src.shadows : parseBool(String(src.shadows))
}
