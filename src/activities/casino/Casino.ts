import type { Game } from '../../core/Game'
import type { AppView } from '../../core/Context'
import type { ActivityApi, ActivitySpec } from '../../ui/Activity'
import type { PanelButton } from '../../ui/Panels'
import type { Poi } from '../../systems/Poi'
import { spend, earn } from '../../systems/Wallet'
import { venueOf } from '../../data/venues'
import { isUnlocked, unlockLevel } from '../../data/progression'
import { CASINO_GAMES, HALLS, hallById, gameName, type CasinoGameId, type HallDef, type HallId } from '../../data/casino'
import { CasinoSfx } from './sfx'
import { simulate } from './sim'
import { SLOT_STRIPS } from './rules'
import { money, type CasinoHost, type Table } from './table'
import { BlackjackTable } from './Blackjack'
import { RouletteTable } from './Roulette'
import { SicboTable } from './Sicbo'
import { BaccaratTable } from './Baccarat'
import { SlotsTable } from './Slots'
import { t } from '../../i18n'

export const CASINO_POI = 'casino_mbs'

interface GameStat { rounds: number; wagered: number; net: number; best: number }
export interface CasinoSave {
  hall: HallId
  stats: Partial<Record<CasinoGameId, GameStat>>
  today: { day: number; net: number }
  log: string[]
}

/** 每局大约耗时（游戏分钟），结算时 api.skipTime */
const ROUND_MIN: Record<CasinoGameId, number> = { blackjack: 3, roulette: 3, sicbo: 2, baccarat: 2, slots: 0.5 }

const TABLES: Record<CasinoGameId, new (h: CasinoHost, a: ActivityApi) => Table> = {
  blackjack: BlackjackTable, roulette: RouletteTable, sicbo: SicboTable, baccarat: BaccaratTable, slots: SlotsTable,
}

/**
 * 赌场插件（滨海湾金沙）：门口面板（五个游戏 / 换筹码选厅）、赌桌活动宿主、统计存档、手机页、测试钩子。
 * 不收入场税，门口按 E 即可直接开玩。
 */
export class Casino implements CasinoHost {
  hallId: HallId = 'main'
  stats: Partial<Record<CasinoGameId, GameStat>> = {}
  today = { day: 1, net: 0 }
  log: string[] = []
  lossStreak = 0
  readonly sfx: CasinoSfx
  table: Table | null = null
  tableGame: CasinoGameId | null = null

  constructor(private game: Game) {
    this.sfx = new CasinoSfx(() => game.audio.masterVolume)
  }

  get ctx() { return this.game.ctx }
  get level() { return this.game.progress?.level ?? 1 }
  hallLock(h: HallDef): string | null {
    if (!h.unlock) return null
    const role = this.ctx.role.id
    return isUnlocked(role, this.level, h.unlock) ? null : t('需要 Lv{need}（当前 Lv{cur}）', { need: unlockLevel(role, h.unlock), cur: this.level })
  }
  get hall(): HallDef {
    const h = hallById(this.hallId)
    return this.hallLock(h) ? HALLS[0] : h
  }
  setHall(id: HallId): boolean {
    const h = HALLS.find((x) => x.id === id)
    if (!h || this.hallLock(h)) return false
    this.hallId = id; return true
  }

  poiButtons(poi: Poi): PanelButton[] {
    if (venueOf(poi)?.id !== CASINO_POI) return []
    const hall = this.hall
    const out: PanelButton[] = []
    for (const g of CASINO_GAMES) {
      out.push({
        label: g.name,
        note: `${hall.name} ${money(hall.min)}–${money(hall.max)}`,
        onClick: () => { this.openGame(g.id, true) },
      })
    }
    out.push({ label: t('换筹码 / 选赌厅'), note: t('当前：{name}', { name: hall.name }), onClick: () => { this.openCashier(true) } })
    return out
  }

  // ---------- 赌桌 ----------
  openGame(id: CasinoGameId, fromPanel = false): boolean {
    const Ctor = TABLES[id]; if (!Ctor) return false
    const hall = this.hall
    let table: Table | null = null
    const spec: ActivitySpec = {
      id: `casino:${id}`,
      title: `${gameName(id)} · ${hall.name}`,
      subtitle: t('滨海湾金沙 · 每局 {min}–{max}', { min: money(hall.min), max: money(hall.max) }),
      opaque: true,
      returnToPanel: fromPanel,
      mount: (_root, api) => {
        table = new Ctor(this, api); table.mount()
        this.table = table; this.tableGame = id
      },
      update: (dt, input, ptr) => { table?.frame(dt, input, ptr) },
      onEscape: () => {
        if (table?.inRound) { table.notice(t('本局进行中，结束后再离开'), 1.8); return true }
        return false
      },
      onClose: () => {
        // 关闭（× 按钮）时进行中的一局立即结算，保证钱账一致
        table?.forceFinish()
        this.table = null; this.tableGame = null
      },
    }
    return this.game.openActivity(spec)
  }

  openCashier(fromPanel = false): boolean {
    const spec: ActivitySpec = {
      id: 'casino:cashier', title: t('换筹码 · 选赌厅'), subtitle: t('滨海湾金沙'), returnToPanel: fromPanel,
      mount: (root) => {
        const render = () => {
          root.innerHTML = ''
          const wrap = document.createElement('div')
          wrap.style.cssText = 'max-width:880px;margin:24px auto;padding:0 16px;display:flex;flex-direction:column;gap:14px'
          const info = document.createElement('div')
          info.style.cssText = 'opacity:.85;font-size:14px;line-height:1.6'
          info.textContent = t('筹码按现金结算：下注时从现金扣除，结算后返还到现金。今日净输赢 {net} · 当前赌厅：{hall}', { net: this.signed(this.todayNet), hall: this.hall.name })
          wrap.appendChild(info)
          const row = document.createElement('div')
          row.style.cssText = 'display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:14px'
          for (const h of HALLS) {
            const lock = this.hallLock(h), cur = this.hall.id === h.id
            const card = document.createElement('div')
            card.className = 'casino-hall'
            card.dataset.hall = h.id
            card.style.cssText = `border:2px solid ${cur ? '#ffd33d' : 'rgba(255,255,255,.2)'};border-radius:14px;padding:16px;background:rgba(255,255,255,.06);opacity:${lock ? 0.55 : 1}`
            card.innerHTML = `<div style="font-size:20px;font-weight:800">${h.name}</div>
              <div style="margin:6px 0;color:#7ee787;font-weight:700">${t('每局 {min}–{max}', { min: money(h.min), max: money(h.max) })}</div>
              <div style="font-size:13px;opacity:.8">${t('筹码：{list}', { list: h.chips.map((c) => money(c)).join(' / ') })}</div>
              <div style="font-size:13px;margin-top:6px;color:#ffd33d">${lock ? '🔒 ' + lock : cur ? t('当前所在') : t('可进入')}</div>`
            const b = document.createElement('button')
            b.className = 'pbtn'; b.textContent = cur ? t('已选择') : lock ? t('未解锁') : t('进入此厅')
            b.disabled = !!lock || cur
            b.style.marginTop = '10px'
            b.addEventListener('click', () => { if (this.setHall(h.id)) { this.sfx.chip(); render() } })
            card.appendChild(b)
            row.appendChild(card)
          }
          wrap.appendChild(row)
          const tip = document.createElement('div')
          tip.style.cssText = 'font-size:12px;opacity:.6;line-height:1.6'
          tip.textContent = t('高额厅 Lv6、VIP 厅 Lv10 解锁。理性娱乐：每个游戏都有庄家优势，长期下注必然亏损。')
          wrap.appendChild(tip)
          root.appendChild(wrap)
        }
        render()
      },
    }
    return this.game.openActivity(spec)
  }

  // ---------- CasinoHost ----------
  stake(game: CasinoGameId, amount: number): boolean {
    return spend(this.ctx, amount, `gamble:${game}`)
  }

  settle(game: CasinoGameId, stake: number, ret: number, api: ActivityApi) {
    ret = Math.round(ret * 100) / 100
    if (ret > 0) earn(this.ctx, ret, `gamble:${game}`)
    const net = Math.round((ret - stake) * 100) / 100
    const s = this.stats[game] ?? (this.stats[game] = { rounds: 0, wagered: 0, net: 0, best: 0 })
    s.rounds++; s.wagered += stake; s.net = Math.round((s.net + net) * 100) / 100; s.best = Math.max(s.best, net)
    this.rollDay(); this.today.net = Math.round((this.today.net + net) * 100) / 100
    this.ctx.events.emit('gambled', { game, bet: stake, net })
    if (net < 0) this.lossStreak++
    else if (net > 0) this.lossStreak = 0
    if (net < 0 && this.lossStreak % 5 === 0) api.toast(t('已连输 {n} 局\n适度娱乐，理性消费', { n: this.lossStreak }), 3.2)
    this.pushLog(t('{game} 押 {bet} → {net}', { game: gameName(game), bet: money(stake), net: this.signed(net) }))
    api.skipTime(ROUND_MIN[game] / 60)
  }

  private rollDay() { const d = this.ctx.clock.day; if (this.today.day !== d) this.today = { day: d, net: 0 } }
  get todayNet() { this.rollDay(); return this.today.net }
  private signed(n: number) { return n > 0 ? `+${money(n)}` : n < 0 ? `-${money(-n)}` : '$0' }
  private pushLog(s: string) { this.log.unshift(`D${this.ctx.clock.day} ${this.ctx.clock.hhmm} ${s}`); if (this.log.length > 12) this.log.length = 12 }

  // ---------- 手机页 ----------
  view(): AppView {
    const all = Object.values(this.stats) as GameStat[]
    const rounds = all.reduce((a, s) => a + s.rounds, 0), wag = all.reduce((a, s) => a + s.wagered, 0), net = all.reduce((a, s) => a + s.net, 0)
    return {
      lines: [
        t('当前赌厅：{name}（{min}–{max}）', { name: this.hall.name, min: money(this.hall.min), max: money(this.hall.max) }),
        t('终身 {n} 局 · 总下注 {bet} · 净输赢 {net}', { n: rounds, bet: money(wag), net: this.signed(Math.round(net * 100) / 100) }),
        t('今日净输赢 {net}', { net: this.signed(this.todayNet) }),
      ],
      sections: [
        ...this.game.venueSections(CASINO_POI),
        {
          title: t('各游戏'),
          items: CASINO_GAMES.map((g) => {
            const s = this.stats[g.id]
            return {
              title: g.name,
              value: s ? this.signed(s.net) : '—',
              desc: s ? t('{n} 局 · 下注 {bet} · 实际返还率 {rtp}% · 单局最多赢 {best}', { n: s.rounds, bet: money(s.wagered), rtp: s.wagered ? ((1 + s.net / s.wagered) * 100).toFixed(1) : '—', best: money(s.best) }) : g.desc,
            }
          }),
        },
        {
          title: t('赌厅'),
          items: HALLS.map((h) => {
            const lock = this.hallLock(h)
            return { title: h.name, value: `${money(h.min)}–${money(h.max)}`, status: lock ?? (this.hall.id === h.id ? t('当前') : t('已解锁')), tone: lock ? 'locked' as const : this.hall.id === h.id ? 'owned' as const : undefined }
          }),
        },
      ],
      log: this.log.length ? this.log : [t('理性娱乐：每个游戏都有庄家优势，长期必输。')],
    }
  }

  // ---------- 存档 ----------
  serialize(): CasinoSave {
    return { hall: this.hallId, stats: JSON.parse(JSON.stringify(this.stats)), today: { ...this.today }, log: this.log.slice() }
  }
  restore(s: unknown) {
    const d = (s ?? {}) as Partial<CasinoSave>
    this.hallId = d.hall && HALLS.some((h) => h.id === d.hall) ? d.hall : 'main'
    this.stats = d.stats && typeof d.stats === 'object' ? JSON.parse(JSON.stringify(d.stats)) : {}
    this.today = d.today && typeof d.today.day === 'number' ? { day: d.today.day, net: d.today.net ?? 0 } : { day: this.ctx?.clock.day ?? 1, net: 0 }
    this.log = Array.isArray(d.log) ? d.log.slice(0, 12) : []
    this.lossStreak = 0
  }

  // ---------- 测试钩子 ----------
  debug() {
    const self = this
    return {
      get hall() { return self.hall.id },
      get stats() { return JSON.parse(JSON.stringify(self.stats)) },
      get todayNet() { return self.todayNet },
      get lossStreak() { return self.lossStreak },
      get log() { return self.log.slice() },
      hallLock: (id: HallId) => self.hallLock(hallById(id)),
      /** 兼容旧测试：已不收入场税，直接 true */
      enter: () => true,
      open: (g: CasinoGameId, hall?: HallId) => { if (hall && !self.setHall(hall)) return false; return self.openGame(g) },
      cashier: () => self.openCashier(),
      setHall: (h: HallId) => self.setHall(h),
      /** 无 UI 快速模拟：返回 RTP 等 */
      simulate: (g: CasinoGameId, rounds = 100_000, strategy?: string) => simulate(g, rounds, strategy),
      /** 老虎机：某符号在三条轴上的停位（测试 forceNext 用） */
      slotFind: (sym: string) => SLOT_STRIPS.map((st) => st.indexOf(sym as never)),
      /** 当前赌桌对象（stackNext / forceNext / clickRegion / regionList / phase …） */
      get table() { return self.table },
      get ui() {
        const t = self.table as (Table & { phase?: string }) | null
        return t ? { game: self.tableGame, phase: t.phase ?? '', inRound: t.inRound, betTotal: t.betTotal, chip: t.chip, bets: { ...t.bets }, regions: t.regionList() } : null
      },
    }
  }
}
