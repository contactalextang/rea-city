/**
 * 射击竞技 / 街头赛车共用的 10 级难度阶梯：默认 T1 很容易上手，赢一场解锁下一级，T10 比原来的“职业”还难。
 * 级别越高奖金 / XP 越多（TIER_REWARD）。
 */
import { t } from '../i18n'
export const TIER_COUNT = 10
export const TIER_NAMES = [t('入门'), t('新手'), t('业余'), t('普通'), t('熟手'), t('老手'), t('精英'), t('职业'), t('大师'), t('传奇')]
/** 奖金 / XP 倍率（下标 = 级别 − 1） */
export const TIER_REWARD = [0.6, 0.8, 1, 1.2, 1.5, 1.8, 2.2, 2.7, 3.3, 4]

export const clampTier = (t: number) => Math.max(1, Math.min(TIER_COUNT, Math.round(t) || 1))
export const tierLabel = (t: number) => `T${clampTier(t)} ${TIER_NAMES[clampTier(t) - 1]}`
export const tierReward = (t: number) => TIER_REWARD[clampTier(t) - 1]
/** 在当前最高级别上获胜 → 解锁下一级；返回新的最高级别 */
export const unlockAfterWin = (max: number, tier: number) => (tier >= max && max < TIER_COUNT ? max + 1 : max)
