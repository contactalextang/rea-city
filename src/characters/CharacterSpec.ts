import { CharacterLibrary } from './CharacterLibrary'

/** 部件槽位 */
export type Slot = 'head' | 'body' | 'legs' | 'feet' | 'hat'
/** 材质语义：决定顶点色从 spec.colors 的哪一项取 */
export type Role = 'top' | 'bottom' | 'shoes' | 'skin' | 'hair' | 'hat' | 'accent' | 'fixed'

/** 角色外观描述：可序列化（存档 / 网络），由 CharacterInstance 合成为单个 SkinnedMesh */
export interface CharacterSpec {
  v: 1
  body: 'm' | 'f'
  parts: { head: string; body: string; legs: string; feet: string; hat: string | null }
  colors: { skin: string; hair: string; top: string; bottom: string; shoes: string; hat: string; accent?: string }
}

/** 默认外观 = catalog 预设 default_gang（白 T 恤、藏青长裤、红鸭舌帽） */
export const DEFAULT_SPEC: CharacterSpec = {
  v: 1,
  body: 'm',
  parts: { head: 'm_casual2_head', body: 'm_casual2_body', legs: 'm_casual2_legs', feet: 'm_casual2_feet', hat: 'cap' },
  colors: { skin: '#f1c7a3', hair: '#2b1b10', top: '#f2f2f2', bottom: '#2f3b5c', shoes: '#333333', hat: '#c0392b', accent: '#e6e6e6' },
}

/** 女性默认部件（spec 为 f 但部件缺失时的回退） */
const DEFAULT_F_PARTS: CharacterSpec['parts'] = { head: 'f_casual_head', body: 'f_casual_body', legs: 'f_casual_legs', feet: 'f_casual_feet', hat: null }

export function cloneSpec(s: CharacterSpec): CharacterSpec {
  return { v: 1, body: s.body, parts: { ...s.parts }, colors: { ...s.colors } }
}

/** 由 catalog 预设 id 生成 spec（库未加载或 id 不存在 → 默认外观） */
export function specFromPreset(id: string): CharacterSpec {
  const lib = CharacterLibrary.instance
  const p = lib?.presets.get(id)
  if (!lib || !p) return cloneSpec(DEFAULT_SPEC)
  const base = p.body === 'f' ? DEFAULT_F_PARTS : DEFAULT_SPEC.parts
  const c = p.colors
  const spec: CharacterSpec = {
    v: 1,
    body: p.body,
    parts: {
      head: p.parts.head ?? base.head,
      body: p.parts.body ?? base.body,
      legs: p.parts.legs ?? base.legs,
      feet: p.parts.feet ?? base.feet,
      hat: p.parts.hat ?? null,
    },
    colors: {
      skin: c.skin ?? DEFAULT_SPEC.colors.skin,
      hair: c.hair ?? DEFAULT_SPEC.colors.hair,
      top: c.top ?? DEFAULT_SPEC.colors.top,
      bottom: c.bottom ?? DEFAULT_SPEC.colors.bottom,
      shoes: c.shoes ?? DEFAULT_SPEC.colors.shoes,
      hat: c.hat ?? DEFAULT_SPEC.colors.hat,
    },
  }
  if (c.accent) spec.colors.accent = c.accent
  return validateSpec(spec)
}

const HEX = /^#[0-9a-fA-F]{6}$/

/** 校验并修复 spec：缺失 / 不存在 / 槽位或性别不符的部件回退到默认，颜色不合法回退默认色。返回新对象 */
export function validateSpec(s: Partial<CharacterSpec> | null | undefined): CharacterSpec {
  const lib = CharacterLibrary.instance
  const body: 'm' | 'f' = s?.body === 'f' ? 'f' : 'm'
  const base = body === 'f' ? DEFAULT_F_PARTS : DEFAULT_SPEC.parts
  const inParts = (s?.parts ?? {}) as Partial<CharacterSpec['parts']>
  const fix = (slot: Slot, id: string | null | undefined, optional: boolean): string | null => {
    if (id == null) return optional ? null : base[slot]
    if (!lib) return typeof id === 'string' ? id : base[slot]
    const p = lib.parts.get(id)
    if (p && p.slot === slot && (p.gender === 'any' || p.gender === body)) return id
    return optional ? null : base[slot]
  }
  const inColors = (s?.colors ?? {}) as Partial<CharacterSpec['colors']>
  const col = (k: keyof CharacterSpec['colors']): string => {
    const v = inColors[k]
    return typeof v === 'string' && HEX.test(v) ? v.toLowerCase() : (DEFAULT_SPEC.colors[k] as string)
  }
  const out: CharacterSpec = {
    v: 1,
    body,
    parts: {
      head: fix('head', inParts.head, false)!,
      body: fix('body', inParts.body, false)!,
      legs: fix('legs', inParts.legs, false)!,
      feet: fix('feet', inParts.feet, false)!,
      hat: fix('hat', inParts.hat, true),
    },
    colors: { skin: col('skin'), hair: col('hair'), top: col('top'), bottom: col('bottom'), shoes: col('shoes'), hat: col('hat') },
  }
  if (typeof inColors.accent === 'string' && HEX.test(inColors.accent)) out.colors.accent = inColors.accent.toLowerCase()
  return out
}

/** 几何缓存键：同 spec 的实例共享合并后的几何 */
export function specKey(s: CharacterSpec): string {
  const p = s.parts, c = s.colors
  return `${s.body}|${p.head}|${p.body}|${p.legs}|${p.feet}|${p.hat ?? '-'}|${c.skin}|${c.hair}|${c.top}|${c.bottom}|${c.shoes}|${c.hat}|${c.accent ?? '-'}`
}
