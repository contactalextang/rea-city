import { CharacterLibrary } from './CharacterLibrary'
import type { CharacterSpec } from './CharacterSpec'
import { DEFAULT_SPEC, cloneSpec, specFromPreset, validateSpec } from './CharacterSpec'

export type Rng = () => number

/** 肤色 6 档：欧裔浅、华裔、马来/东南亚、印裔中、印裔深、非裔 */
export const SKIN_PALETTE = ['#f5d6b8', '#f1c7a3', '#d9a56f', '#b8794a', '#8d5a3a', '#5c3a21']
/** 发色 */
export const HAIR_PALETTE = ['#101010', '#1a1a1a', '#2b1b10', '#4a3222', '#7a4a2a', '#8c8c8c', '#c9a66b', '#3b2a1a']
/** 衣色 12 档 */
export const CLOTH_PALETTE = ['#e74c3c', '#3498db', '#2ecc71', '#f1c40f', '#9b59b6', '#ecf0f1', '#1f2a44', '#e67e22', '#1abc9c', '#ff8fab', '#7f8c8d', '#2b2b2b']
/** 鞋色 */
export const SHOE_PALETTE = ['#1a1a1a', '#333333', '#3b2a1a', '#ffffff', '#8d5524', '#2e2e2e']

const pick = <T>(arr: T[], rng: Rng): T => arr[Math.floor(rng() * arr.length) % arr.length]

/** 所有预设 id（按 catalog 顺序） */
export function presetIds(): string[] {
  return CharacterLibrary.instance ? [...CharacterLibrary.instance.presets.keys()] : []
}

/** 行人预设 id（ped_*） */
export function pedPresetIds(): string[] { return presetIds().filter((id) => id.startsWith('ped_')) }

/** 玩家四身份默认外观 */
export function identitySpec(identity: 'gang' | 'gold' | 'white' | 'blue'): CharacterSpec { return specFromPreset(`default_${identity}`) }

/**
 * 随机行人：从 ped_* 预设随机取一个；30% 概率同性别部件随机混搭；肤色 / 发色 / 衣色从色板随机。
 * 库未加载时返回默认外观。
 */
export function randomPedSpec(rng: Rng = Math.random): CharacterSpec {
  const lib = CharacterLibrary.instance
  const ids = pedPresetIds()
  if (!lib || !ids.length) return cloneSpec(DEFAULT_SPEC)
  const spec = specFromPreset(pick(ids, rng))
  const gender = spec.body
  if (rng() < 0.3) {
    for (const slot of ['head', 'body', 'legs', 'feet'] as const) {
      const opts = lib.partsFor(slot, gender)
      if (opts.length) spec.parts[slot] = pick(opts, rng).id
    }
    // 连衣裙上下身必须同套；混搭出一半裙子就换成套装
    const dressTop = spec.parts.body === 'f_formal_body', dressBottom = spec.parts.legs === 'f_formal_legs'
    if (dressTop !== dressBottom) { spec.parts.body = 'f_formal_body'; spec.parts.legs = 'f_formal_legs' }
    spec.parts.hat = rng() < 0.12 ? 'cap' : null
  }
  spec.colors.skin = pick(SKIN_PALETTE, rng)
  spec.colors.hair = pick(HAIR_PALETTE, rng)
  spec.colors.top = pick(CLOTH_PALETTE, rng)
  spec.colors.bottom = pick(CLOTH_PALETTE, rng)
  spec.colors.shoes = pick(SHOE_PALETTE, rng)
  spec.colors.hat = pick(CLOTH_PALETTE, rng)
  spec.colors.accent = rng() < 0.5 ? pick(CLOTH_PALETTE, rng) : '#ffffff'
  // 连衣裙 / 西装：上下同色
  if ((spec.parts.body === 'f_formal_body' && spec.parts.legs === 'f_formal_legs') || (spec.parts.body === 'm_suit_body' && spec.parts.legs === 'm_suit_legs')) spec.colors.bottom = spec.colors.top
  // 自带安全帽的工人头：帽色固定黄
  if (spec.parts.head.endsWith('_worker_head') || spec.parts.hat === 'helmet') spec.colors.hat = '#f5c400'
  return validateSpec(spec)
}
