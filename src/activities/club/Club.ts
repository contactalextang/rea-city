import type { Game } from '../../core/Game'
import type { Poi } from '../../systems/Poi'
import type { PanelButton } from '../../ui/Panels'
import type { ActivityApi } from '../../ui/Activity'
import { spend } from '../../systems/Wallet'
import { isUnlocked } from '../../data/progression'
import { venueOf, venueOpen } from '../../data/venues'
import { DRINKS, npcById, type NpcDef } from '../../data/dates'
import { danceSpec, fakeResult, type DanceResult } from './Dance'
import type { Relations } from './Relations'

export const CLUB_ID = 'club_clarke_quay'
/** VIP 卡座最低消费（全额转为当晚酒水额度） */
export const VIP_MIN = 300
/** 醉意单位：≥ 2.5 视为超过酒驾标准，≥ 8 酒保拒绝再卖 */
export const DRUNK_LIMIT = 2.5
const DRUNK_CUTOFF = 8
const DECAY_PER_HOUR = 1

export interface ClubSave { drunk: number; entryNight: number; vipNight: number; vipCredit: number; danceNight: number; dances: number; best: number }

/**
 * 克拉码头夜店：门票进场、吧台点酒（醉意随时间消退，画面轻微晃动 / 模糊）、
 * 节奏舞蹈（跳得好吸引 NPC 搭话）、VIP 卡座（Lv3，最低消费，好感加成 / 更易遇到高端 NPC）、四处看看搭讪。
 */
export class Club {
  drunk = 0
  entryNight = 0
  vipNight = 0
  vipCredit = 0
  danceNight = 0
  dances = 0
  best = 0
  /** 最近一次舞蹈吸引来的 NPC（夜店面板显示“XX 在等你”） */
  attracted: { npc: string; bonus: number; night: number } | null = null
  private lastAbs = -1
  private overlay: HTMLDivElement | null = null
  private fxOn = false
  private wasInVehicle = false
  private t = 0

  constructor(private game: Game, private rel: Relations) {
    rel.vipTonight = () => this.vipTonight
    rel.drunk = () => this.drunk
  }

  private get ctx() { return this.game.ctx }
  /** “今晚”= 凌晨 5 点前算前一天的夜 */
  get night() { const c = this.ctx.clock; return c.hour < 5 ? c.day - 1 : c.day }
  get entered() { return this.entryNight === this.night }
  get vipTonight() { return this.vipNight === this.night }
  private get weekend() { const dow = (this.night - 1) % 7; return dow === 4 || dow === 5 }
  private get level() { return this.game.progress.level }
  /** 门票：平日 $30、周五 / 周六 $40；Lv5+ 半价，Lv8+ 免费（嘉宾名单） */
  ticketPrice() { const base = this.weekend ? 40 : 30; return this.level >= 8 ? 0 : this.level >= 5 ? base / 2 : base }
  get vipUnlocked() { return isUnlocked(this.ctx.role.id, this.level, 'club_vip') }

  private refresh() { const p = this.game.interactions.current; if (p && this.game.panels.open) this.game.interactions.open(p) }
  private toast(t: string, sec = 2.5) { this.game.hud.toast(t, sec) }

  // ------------------------------------------------------------ 动作

  buyTicket(): boolean {
    if (this.entered) return true
    const p = this.ticketPrice()
    if (p > 0 && !spend(this.ctx, p, 'entertain:club')) { this.toast('钱不够买门票'); return false }
    this.entryNight = this.night
    this.toast(p ? `门票 $${p} · 欢迎来到克拉码头` : '你在嘉宾名单上 · 免费入场')
    return true
  }
  buyVip(): boolean {
    if (!this.vipUnlocked) { this.toast('VIP 卡座需要 Lv3'); return false }
    if (this.vipTonight) return true
    if (!spend(this.ctx, VIP_MIN, 'entertain:vip')) { this.toast(`VIP 卡座最低消费 $${VIP_MIN}`); return false }
    this.vipNight = this.night; this.vipCredit = VIP_MIN
    this.toast(`入座 VIP 卡座 · 酒水额度 $${VIP_MIN}`, 3)
    return true
  }
  /** 点一杯：先扣 VIP 额度；发 drank 事件（心情由事件处理） */
  order(id: string): boolean {
    const d = DRINKS.find((x) => x.id === id); if (!d) return false
    if (d.vipOnly && !this.vipTonight) { this.toast('香槟塔只在 VIP 卡座供应'); return false }
    if (d.units > 0 && this.drunk >= DRUNK_CUTOFF) { this.toast('酒保：你今晚喝得够多了，来杯水吧'); return false }
    const fromCredit = Math.min(this.vipCredit, d.price)
    const cash = d.price - fromCredit
    if (cash > 0 && !spend(this.ctx, cash, 'entertain:drink')) { this.toast('钱不够'); return false }
    this.vipCredit -= fromCredit
    this.drunk = Math.round((this.drunk + d.units) * 100) / 100
    this.ctx.events.emit('drank', { n: 1 })
    const lvl = this.drunk >= 6 ? '天旋地转' : this.drunk >= 4 ? '醉醺醺' : this.drunk >= DRUNK_LIMIT ? '微醺（别开车）' : d.units ? '有点上头' : '清醒'
    this.toast(`${d.name}${fromCredit ? '（VIP 额度）' : ''} · ${lvl}`)
    return true
  }

  /** 舞蹈结算（UI 与调试共用）：心情（每晚前 2 曲）、吸引 NPC */
  settleDance(res: DanceResult): { mood: number; attracted: NpcDef | null } {
    if (this.danceNight !== this.night) { this.danceNight = this.night; this.dances = 0 }
    this.dances++
    this.best = Math.max(this.best, res.score)
    const mood = this.dances <= 2 ? Math.round(res.pct * 8) : 0
    if (mood) this.ctx.needs.addMood(mood)
    let attracted: NpcDef | null = null
    if (res.pct >= 0.7) {
      const poi = this.ctx.pois.byId(CLUB_ID)
      const here = poi ? this.rel.presentAt(poi) : []
      const dancers = here.filter((n) => n.dancer), pool = dancers.length ? dancers : here
      attracted = pool.length ? pool[Math.floor(Math.random() * pool.length)] : null
      if (attracted) this.attracted = { npc: attracted.id, bonus: res.pct >= 0.9 ? 8 : 5, night: this.night }
    }
    return { mood, attracted }
  }

  /** 四处看看：按时段抽一位在场 NPC（VIP 时高端 NPC 权重 ×3） */
  lookAround(): NpcDef | null {
    const poi = this.ctx.pois.byId(CLUB_ID); if (!poi) return null
    const here = this.rel.presentAt(poi)
    if (!here.length) return null
    const w = here.map((n) => (this.vipTonight && n.vip ? 3 : 1) * (this.rel.rel[n.id]?.met ? 0.6 : 1))
    let x = Math.random() * w.reduce((a, b) => a + b, 0)
    for (let i = 0; i < here.length; i++) { x -= w[i]; if (x <= 0) return here[i] }
    return here[here.length - 1]
  }

  openDance(): boolean {
    let unmuted = false
    return this.game.openActivity(danceSpec({
      muteWorldMusic: () => {
        const was = this.game.settings.music
        if (was) this.game.audio.setMusic(false)
        return () => { if (!unmuted) { unmuted = true; if (was) this.game.audio.setMusic(this.game.settings.music) } }
      },
      onFinish: (res, api: ActivityApi) => {
        api.skipTime(0.25)
        const { mood, attracted } = this.settleDance(res)
        const lines: string[] = []
        if (mood) lines.push(`跳得尽兴 · 心情 +${mood}`)
        const buttons: { label: string; onClick: () => void; id?: string }[] = []
        if (attracted) {
          lines.push(`${this.rel.rel[attracted.id]?.met ? attracted.name : '有人'}被你的舞姿吸引，朝你走了过来……`)
          buttons.push({ label: `和 ${this.rel.rel[attracted.id]?.met ? attracted.name : 'TA'} 聊聊`, id: 'dance-talk', onClick: () => { api.close(); this.talkTo(attracted, true) } })
        } else if (res.pct >= 0.7) lines.push('全场为你欢呼，可惜今晚没什么熟面孔。')
        else lines.push('再练练，舞跳得好会有人来搭讪哦。')
        return { lines, buttons }
      },
    }, (this.ctx.clock.day * 7 + this.dances) | 0))
  }

  /** 在夜店和某人聊天（bonus：被舞姿吸引） */
  talkTo(npc: NpcDef, useAttract = false): boolean {
    let bonus = 0
    if (useAttract && this.attracted?.npc === npc.id && this.attracted.night === this.night) { bonus = this.attracted.bonus; this.attracted = null }
    return this.game.openActivity(this.rel.talkSpec(npc, 'club', { bonus }))
  }

  // ------------------------------------------------------------ 面板

  poiButtons(poi: Poi): PanelButton[] {
    const v = venueOf(poi)
    if (v?.id !== CLUB_ID) return []
    if (!venueOpen(v, this.ctx.clock.hour)) return []
    const out: PanelButton[] = []
    if (!this.entered) {
      const p = this.ticketPrice()
      out.push({ label: '买票进场', note: `${p ? `$${p}` : '免费'}${this.weekend ? ' · 周末' : ''}${this.level >= 5 ? ` · Lv${this.level} 优惠` : ''}`, onClick: () => { this.buyTicket(); this.refresh() } })
      return out
    }
    for (const d of DRINKS) {
      if (d.vipOnly && !this.vipTonight) continue
      out.push({ label: `点一杯 ${d.name}`, note: `$${d.price}${this.vipTonight && this.vipCredit > 0 ? `（额度 $${this.vipCredit}）` : ''} · ${d.desc}`, disabled: d.units > 0 && this.drunk >= DRUNK_CUTOFF, onClick: () => { this.order(d.id); this.refresh() } })
    }
    out.push({ label: '下舞池跳舞', note: '节奏小游戏 · 约 60 秒', onClick: () => { this.openDance() } })
    const here = this.rel.presentAt(poi)
    out.push({ label: '四处看看 / 搭讪', note: here.length ? `今晚有 ${here.length} 个人值得认识` : '人不多', onClick: () => {
      const n = this.lookAround()
      if (!n) { this.toast('转了一圈，今晚没遇到感兴趣的人'); return }
      this.talkTo(n)
    } })
    const att = this.attracted && this.attracted.night === this.night ? npcById(this.attracted.npc) : null
    if (att && here.includes(att)) out.push({ label: `${this.rel.rel[att.id]?.met ? att.name : '刚才看你跳舞的人'} 在等你`, note: '被你的舞姿吸引', onClick: () => { this.talkTo(att, true) } })
    for (const n of here) if (this.rel.rel[n.id]?.met && n !== att) out.push(this.rel.talkButton(n, 'club'))
    if (!this.vipTonight) out.push({ label: 'VIP 卡座', note: this.vipUnlocked ? `最低消费 $${VIP_MIN}（全额转酒水额度）· 好感加成` : '需要 Lv3', disabled: !this.vipUnlocked, onClick: () => { this.buyVip(); this.refresh() } })
    return out
  }

  // ------------------------------------------------------------ 每帧：醉意消退 + 画面晃动

  update(dt: number) {
    const abs = this.ctx.clock.absHours
    if (this.lastAbs < 0 || abs < this.lastAbs) this.lastAbs = abs
    const dh = abs - this.lastAbs
    this.lastAbs = abs
    if (dh > 0 && this.drunk > 0) this.drunk = Math.max(0, this.drunk - DECAY_PER_HOUR * dh)
    this.t += dt
    const inV = this.ctx.player.inVehicle
    if (inV && !this.wasInVehicle && this.drunk >= DRUNK_LIMIT) this.toast('你喝了酒还开车——小心被查酒驾！', 3)
    this.wasInVehicle = inV
    this.applyFx()
  }

  /** 醉意视觉：只动画布的 CSS（模糊 + 轻微摇晃）与一层暗角，不碰 Game / Player */
  applyFx() {
    const k = Math.max(0, Math.min(1, (this.drunk - 1) / 5))
    const cv = this.game.renderer?.domElement
    if (!this.overlay) { this.overlay = document.createElement('div'); this.overlay.id = 'club-drunk'; document.body.appendChild(this.overlay) }
    this.overlay.style.opacity = String(k)
    if (!cv) return
    if (k <= 0) {
      if (this.fxOn) { cv.style.filter = ''; cv.style.transform = ''; this.fxOn = false }
      return
    }
    this.fxOn = true
    const t = this.t
    const rot = Math.sin(t * 0.8) * 1.2 * k, tx = Math.sin(t * 0.53) * 10 * k, ty = Math.cos(t * 0.71) * 6 * k
    cv.style.transform = `translate(${tx.toFixed(1)}px, ${ty.toFixed(1)}px) rotate(${rot.toFixed(2)}deg) scale(${(1 + 0.04 * k).toFixed(3)})`
    cv.style.filter = `blur(${(k * 1.6 * (0.7 + 0.3 * Math.sin(t * 1.7))).toFixed(2)}px) saturate(${(1 + 0.35 * k).toFixed(2)})`
  }

  /** 调试：无 UI 结算一局舞蹈 */
  debugDance(pct = 0.85) {
    const res = fakeResult(pct)
    this.ctx.clock.skip(0.25)
    const r = this.settleDance(res)
    return { grade: res.grade, pct: res.pct, score: res.score, mood: r.mood, attracted: r.attracted?.id ?? null }
  }

  serialize(): ClubSave { return { drunk: this.drunk, entryNight: this.entryNight, vipNight: this.vipNight, vipCredit: this.vipCredit, danceNight: this.danceNight, dances: this.dances, best: this.best } }
  restore(s: ClubSave | undefined) {
    this.drunk = s?.drunk ?? 0; this.entryNight = s?.entryNight ?? 0; this.vipNight = s?.vipNight ?? 0; this.vipCredit = s?.vipCredit ?? 0
    this.danceNight = s?.danceNight ?? 0; this.dances = s?.dances ?? 0; this.best = s?.best ?? 0
    this.attracted = null; this.lastAbs = -1
    this.applyFx()
  }
}
