import type { Game } from '../../core/Game'
import type { AppView } from '../../core/Context'
import { venueOf } from '../../data/venues'
import { isUnlocked, unlockLevel } from '../../data/progression'
import { spend } from '../../systems/Wallet'
import { MODES, ELO_START, DIFF_ELO, PRO_TIER, rankOf, rankedDifficulty, toTier, type ArenaModeId, type Difficulty } from '../../data/arena'
import { TIER_COUNT, clampTier, tierLabel, tierReward, unlockAfterWin } from '../../data/tiers'
import { ArenaMode, type MatchResult } from './ArenaMode'
import { t } from '../../i18n'

interface Rec { mode: ArenaModeId; won: boolean; draw: boolean; score: string; k: number; d: number; hs: number; prize: number; elo: number; day: number; time: string }
interface ArenaSave { elo: number; best: number; matches: number; wins: number; kills: number; deaths: number; hs: number; ranked: number; history: Rec[]; tier: number; tierMax: number }
const fresh = (): ArenaSave => ({ elo: ELO_START, best: ELO_START, matches: 0, wins: 0, kills: 0, deaths: 0, hs: 0, ranked: 0, history: [], tier: 1, tierMax: 1 })

/** P10.D 射击竞技插件：丹戎巴葛射击俱乐部报名、天梯段位存档、手机竞技页、调试钩子 */
export function installArena(game: Game) {
  let st = fresh()
  let session: ArenaMode | null = null
  let pending: { enemy: Difficulty[]; mate: Difficulty } | null = null
  let difficultyOverride: Difficulty | null = null

  const diffsFor = (mode: ArenaModeId): { enemy: Difficulty[]; mate: Difficulty } => {
    if (difficultyOverride) return { enemy: Array(5).fill(difficultyOverride), mate: difficultyOverride }
    if (mode === 'ranked') { const e = rankedDifficulty(st.elo); return { enemy: e, mate: e[2] } }
    if (mode === 'pro') return { enemy: [PRO_TIER, 9, 9, 10, 10], mate: 9 }
    const t = st.tier
    if (mode === 'dm') return { enemy: [t - 1, t, t, t - 1, t, t, t + 1].map(clampTier), mate: t }
    // 队友固定 T4–T6：低级别不拖后腿，高级别也不会被队友带飞
    return { enemy: Array(5).fill(t), mate: Math.min(6, Math.max(4, t)) }
  }

  const onResult = (mode: ArenaModeId, enemy: Difficulty[], tier?: number) => (r: MatchResult): string[] => {
    const lines: string[] = []
    st.matches++; if (r.won) st.wins++
    st.kills += r.kills; st.deaths += r.deaths; st.hs += r.headshots
    let delta = 0
    if (mode === 'ranked') {
      const opp = enemy.reduce((s, d) => s + DIFF_ELO(d), 0) / enemy.length
      const exp = 1 / (1 + Math.pow(10, (opp - st.elo) / 400))
      const score = r.won ? 1 : r.draw ? 0.5 : 0
      delta = Math.round(40 * (score - exp) + (r.surrender ? -5 : Math.min(6, r.mvps * 2)))
      if (r.won) delta = Math.max(8, delta)
      const before = st.elo, rb = rankOf(before)
      st.elo = Math.max(0, st.elo + delta)
      st.best = Math.max(st.best, st.elo)
      st.ranked++
      const ra = rankOf(st.elo)
      lines.push(t('天梯：{rb} → {ra}（ELO {before} → {elo}，{delta}）', { rb, ra, before, elo: st.elo, delta: `${delta >= 0 ? '+' : ''}${delta}` }))
      if (ra !== rb) game.hud.toast(st.elo > before ? t('段位晋升：{ra}', { ra }) : t('段位降级：{ra}', { ra }), 4)
    }
    if (r.won && tier && (mode === 'casual' || mode === 'duel')) {
      const max = unlockAfterWin(st.tierMax, tier)
      if (max > st.tierMax) {
        st.tierMax = max; st.tier = max
        lines.push(t('解锁新难度：{tier}（奖金 ×{mul}）', { tier: tierLabel(max), mul: tierReward(max) }))
        game.hud.toast(t('射击难度解锁：{tier}', { tier: tierLabel(max) }), 4)
      }
    }
    st.history.unshift({ mode, won: r.won, draw: r.draw, score: `${r.scoreUs}:${r.scoreThem}`, k: r.kills, d: r.deaths, hs: r.headshots, prize: r.prize, elo: delta, day: game.clock.day, time: game.clock.hhmm })
    st.history = st.history.slice(0, 10)
    game.saveGame(false)
    return lines
  }

  game.arenaFactory = (mode, g) => {
    const m = (mode in MODES ? mode : 'casual') as ArenaModeId
    const d = pending ?? diffsFor(m)
    pending = null
    // 手动级别只对休闲 / 单挑 / 死斗生效；调试覆盖难度时不算解锁
    const tier = (m === 'casual' || m === 'duel' || m === 'dm') && !difficultyOverride ? st.tier : undefined
    session = new ArenaMode(m, g, { enemyDiff: d.enemy, mateDiff: d.mate, tier, onResult: onResult(m, d.enemy, tier) })
    const dispose = session.dispose.bind(session)
    const s = session
    s.dispose = () => { dispose(); if (session === s) session = null }
    return session
  }

  /** 报名：解锁检查 → 扣报名费 → 进入 */
  const start = (mode: ArenaModeId, pay = true): boolean => {
    const m = MODES[mode]
    if (m.unlock && !isUnlocked(game.ctx.role.id, game.progress.level, m.unlock)) { game.hud.toast(t('需要 Lv{lv}', { lv: unlockLevel(game.ctx.role.id, m.unlock) })); return false }
    if (pay && m.fee > 0 && !spend(game.ctx, m.fee, 'arena:entry')) { game.hud.toast(t('现金不足')); return false }
    pending = diffsFor(mode)
    const ok = game.enterArena(mode)
    if (!ok) { pending = null; if (pay && m.fee > 0) game.wallet.earn(m.fee, 'arena:refund') }
    return ok
  }

  const view = (): AppView => {
    const rate = st.matches ? Math.round(st.wins / st.matches * 100) : 0
    const kd = st.deaths ? (st.kills / st.deaths).toFixed(2) : String(st.kills)
    const lvlOk = isUnlocked(game.ctx.role.id, game.progress.level, 'arena_ranked')
    return {
      lines: [
        t('段位：{rank}（ELO {elo}，最高 {best}）', { rank: rankOf(st.elo), elo: st.elo, best: rankOf(st.best) }),
        t('战绩：{n} 场 · 胜 {wins}（{rate}%）· 天梯 {ranked} 场', { n: st.matches, wins: st.wins, rate, ranked: st.ranked }),
        t('击杀 {k} · 死亡 {d} · K/D {kd} · 爆头 {hs}', { k: st.kills, d: st.deaths, kd, hs: st.hs }),
        st.tierMax < TIER_COUNT ? t('难度：{tier}（已解锁到 {max}，在最高级别赢一局解锁下一级）', { tier: tierLabel(st.tier), max: tierLabel(st.tierMax) }) : t('难度：{tier}（已解锁到 {max}，全部解锁）', { tier: tierLabel(st.tier), max: tierLabel(st.tierMax) }),
        lvlOk ? t('丹戎巴葛射击俱乐部（24 小时）报名天梯赛') : t('天梯赛 Lv{lv} 解锁', { lv: unlockLevel(game.ctx.role.id, 'arena_ranked') }),
      ],
      sections: [...game.venueSections('arena_tanjong_pagar'), {
        title: t('最近 10 场'),
        items: st.history.length ? st.history.map((h) => ({
          title: `${h.won ? t('胜') : h.draw ? t('平') : t('负')} · ${MODES[h.mode]?.name ?? h.mode} · ${h.score}`,
          desc: t('K {k} / D {d} · 爆头 {hs} · 第 {day} 天 {time}', { k: h.k, d: h.d, hs: h.hs, day: h.day, time: h.time }),
          value: h.prize ? `+$${h.prize}` : '',
          status: h.mode === 'ranked' ? `ELO ${h.elo >= 0 ? '+' : ''}${h.elo}` : undefined,
          tone: h.won ? 'owned' as const : undefined,
        })) : [{ title: t('还没有比赛记录'), desc: t('去丹戎巴葛射击俱乐部报名一场吧') }],
      }],
    }
  }

  const dbg = {
    enter(mode: ArenaModeId = 'casual', pay = false) { return start(mode, pay) },
    state() { return session?.debugState() ?? null },
    buy(id: string) { return session?.playerBuy(id) ?? false },
    teleport(x: number, z: number) { session?.debugTeleport(x, z) },
    aimAt(i: number, part: 'head' | 'chest' = 'head') { return session?.debugAimAt(i, part) ?? false },
    fire() { return session?.debugFire() ?? null },
    killAll(side: 'T' | 'CT') { session?.debugKillAll(side) },
    skipRound() { session?.debugSkipRound() },
    forceEnd(won: boolean) { session?.debugForceEnd(won) },
    surrender() { session?.surrender() },
    exit() { game.exitArena() },
    closeBuy() { session?.closeBuy() },
    money(n: number) { if (session) session.player.money = n },
    giveC4() { session?.debugGiveC4() },
    select(slot: 'primary' | 'secondary' | 'knife' | 'grenade' | 'c4') { session?.debugSelect(slot) },
    look(yaw: number, pitch = 0) { if (session) { session.player.yaw = yaw; session.player.pitch = pitch } },
    set timeScale(n: number) { if (session) session.timeScale = n },
    get timeScale() { return session?.timeScale ?? 1 },
    autopilot(on = true, diff: Difficulty | string = PRO_TIER) { session?.setAutopilot(on, toTier(diff)) },
    freezeBots(on = true) { if (session) session.freezeBots = on },
    bots: {
      get difficulty() { return difficultyOverride },
      set difficulty(d: Difficulty | string | null) { difficultyOverride = d === null ? null : toTier(d); if (difficultyOverride) session?.setDifficulty(difficultyOverride) },
    },
    get tier() { return st.tier },
    set tier(t: number) { st.tier = Math.min(clampTier(t), st.tierMax) },
    get tierMax() { return st.tierMax },
    set tierMax(t: number) { st.tierMax = clampTier(t); st.tier = Math.min(st.tier, st.tierMax) },
    get fps() { return session?.fps ?? 0 },
    get record() { return st },
    get session() { return session },
    get memory() { const m = game.renderer.info.memory; return { geometries: m.geometries, textures: m.textures, programs: game.renderer.info.programs?.length ?? 0 } },
  }

  game.addPlugin({
    id: 'arena',
    serialize: () => st,
    restore: (s) => {
      const d = s as Partial<ArenaSave> | undefined
      st = { ...fresh(), ...(d ?? {}) }
      if (!Array.isArray(st.history)) st.history = []
      st.tierMax = clampTier(st.tierMax); st.tier = Math.min(clampTier(st.tier), st.tierMax)
    },
    poiButtons: (poi) => {
      if (venueOf(poi)?.id !== 'arena_tanjong_pagar') return []
      const role = game.ctx.role.id, lv = game.progress.level
      const btn = (mode: ArenaModeId) => {
        const m = MODES[mode]
        const locked = m.unlock ? !isUnlocked(role, lv, m.unlock) : false
        return { label: m.name, note: locked ? t('需要 Lv{lv}', { lv: unlockLevel(role, m.unlock!) }) : `${m.fee ? '$' + m.fee : t('免费')} · ${m.desc}`, disabled: locked, onClick: () => { start(mode) } }
      }
      const tierBtn = {
        label: t('难度：{tier}', { tier: tierLabel(st.tier) }),
        note: t('奖金 / XP ×{mul} · 休闲 / 单挑 / 死斗生效 · {next}（点按切换）', { mul: tierReward(st.tier), next: st.tierMax < TIER_COUNT ? t('在 {tier} 赢一局解锁下一级', { tier: tierLabel(st.tierMax) }) : t('已全部解锁') }),
        onClick: () => { st.tier = st.tier >= st.tierMax ? 1 : st.tier + 1; game.interactions.open(poi) },
      }
      return [tierBtn, btn('casual'), btn('ranked'), btn('pro'), btn('duel'), btn('dm')]
    },
    app: { name: 'arena', title: t('竞技场'), view },
    debug: () => dbg,
  })
}
