import { DEFAULT_ROLE, isRoleId, type RoleId } from '../data/roles'

/** 运行时设置：localStorage 持久化，URL 查询参数优先覆盖（如 ?world=grid&chars=box&shadows=0&role=white） */
export interface Settings {
  world: 'sg' | 'grid'      // 路网/城市数据源
  timeSpeed: number          // 游戏时间流速倍率
  chars: 'gltf' | 'box'     // 角色渲染：骨骼 glTF 或方块
  shadows: boolean
  role: RoleId               // 玩家身份（见 data/roles.ts）
}

export const DEFAULT_SETTINGS: Settings = { world: 'sg', timeSpeed: 1, chars: 'box', shadows: true, role: DEFAULT_ROLE }
const KEY = 'rea.settings'

const parseBool = (v: string) => !(v === '0' || v === 'false' || v === 'off' || v === 'no')

/** 读取设置：默认值 ← localStorage ← URL 参数 */
export function loadSettings(search = typeof location !== 'undefined' ? location.search : ''): Settings {
  const s: Settings = { ...DEFAULT_SETTINGS }
  try {
    const raw = localStorage.getItem(KEY)
    if (raw) apply(s, JSON.parse(raw) as Record<string, unknown>)
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
  if (src.shadows !== undefined) s.shadows = typeof src.shadows === 'boolean' ? src.shadows : parseBool(String(src.shadows))
}
