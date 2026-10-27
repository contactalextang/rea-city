import type { Game } from '../../core/Game'
import type { AppView, AppItem } from '../../core/Context'
import type { Poi } from '../../systems/Poi'
import type { PanelButton } from '../../ui/Panels'
import type { ActivityApi, ActivitySpec } from '../../ui/Activity'
import { spend } from '../../systems/Wallet'
import {
  NPCS, npcById, PROMPTS, TEXT_PROMPTS, DRINKS, GIFTS, giftById, DELIVERY_FEE, DATE_PLACES, datePlaceById, STAGE_LABEL,
  type NpcDef, type Stage, type Prompt, type PromptOption, type Spot,
} from '../../data/dates'
import { Companion } from './Companion'
import { CLUB_ID } from './Club'
import { el, btn, drawPortrait, injectStyle, fmt$ } from './ui'
import { t } from '../../i18n'

/**
 * P10.E 恋爱关系系统：8 位具名 NPC 的好感 / 阶段 / 短信 / 邀约 / 约会 / 同伴跟随。
 * 好感 0–100；阶段 陌生 → 认识（要到联系方式，好感 ≥ 20）→ 约会中（完成一次约会且好感 ≥ 45）→ 恋人（约会中表白，好感 ≥ 80 且已约会 ≥ 2 次）。
 * 阶段倒退：恋人 < 60 → 约会中；约会中 < 35 → 认识；认识 < 5 → 陌生（删了你的号码）。冷落 > 2 天每天扣好感。
 */
export interface Sms { day: number; t: string; from: 'npc' | 'me'; text: string }
export interface RelState {
  aff: number; stage: Stage; met: boolean
  /** 最近一次联系（见面 / 短信 / 送礼）的游戏日 */
  lastContact: number
  dates: number
  sms: Sms[]
  /** 当天对话已得好感（每日上限 TALK_CAP） */
  talkDay: number; talkGain: number
  /** 恋人每日首次联系心情加成的日期 */
  moodDay: number
  /** 当天已发短信条数（NPC 主动） */
  smsDay: number; smsCount: number
  inviteDay: number
  giftDay: number; giftCount: number
  /** 生日当天是否收到礼物 */
  bdayGift: number
}
export interface Appt { npc: string; place: string; at: number }
export interface RelSave { v: 1; rel: Record<string, RelState>; appt: Appt | null; inv: Record<string, number>; overnight: string | null; lastAbs: number }

const TALK_CAP = 15
const SMS_KEEP = 20
/** 好感一律保留 1 位小数 */
const r1 = (n: number) => Math.round(n * 10) / 10
/** 好感变化显示：+3.2 / ±0 / −1.5 */
export const fmtDelta = (d: number) => { const v = r1(d); return v > 0 ? `+${v}` : v === 0 ? '±0' : `−${Math.abs(v)}` }
const clamp = (n: number, a: number, b: number) => Math.max(a, Math.min(b, n))
const rand = (a: number, b: number) => a + Math.random() * (b - a)
const pick = <T>(a: readonly T[]): T => a[Math.floor(Math.random() * a.length)]
const shuffle = <T>(a: T[]): T[] => { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]] } return a }
function hash(s: string) { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) } return ((h >>> 0) % 10000) / 10000 }
const hhmm = (abs: number) => { const h = ((abs % 24) + 24) % 24; return `${String(Math.floor(h)).padStart(2, '0')}:${String(Math.floor((h % 1) * 60)).padStart(2, '0')}` }
const inHours = (h: number, [a, b]: [number, number]) => a < b ? h >= a && h < b : h >= a || h < b

export type TalkSource = 'club' | 'casino' | 'poi' | 'text'

export class Relations {
  rel: Record<string, RelState> = {}
  appt: Appt | null = null
  /** 礼物库存（商店买的） */
  inv: Record<string, number> = {}
  /** 恋人跟你回家（下次睡觉触发过夜心情） */
  overnight: string | null = null
  companion: Companion | null = null
  private lastAbs = 0
  private overnightUntil = 0
  /** 提前赴约的约会时间（开始约会时 +2 好感） */
  private early = -1
  /** 夜店插件注入：今晚是否 VIP 卡座、醉意 */
  vipTonight: () => boolean = () => false
  drunk: () => number = () => 0

  constructor(private game: Game) {
    game.ctx.events.on('slept', () => this.onSlept())
  }

  private get ctx() { return this.game.ctx }
  private get abs() { return this.ctx.clock.absHours }
  private get day() { return this.ctx.clock.day }
  private toast(t: string, sec = 2.5) { this.game.hud.toast(t, sec) }

  // ------------------------------------------------------------ 状态

  get(id: string): RelState {
    let r = this.rel[id]
    if (!r) r = this.rel[id] = { aff: 0, stage: 'stranger', met: false, lastContact: this.day, dates: 0, sms: [], talkDay: 0, talkGain: 0, moodDay: 0, smsDay: 0, smsCount: 0, inviteDay: 0, giftDay: 0, giftCount: 0, bdayGift: 0 }
    return r
  }
  known(): NpcDef[] { return NPCS.filter((n) => this.rel[n.id] && this.rel[n.id].stage !== 'stranger') }
  /** 改好感（带阶段倒退），返回实际变化 */
  affect(id: string, delta: number): number {
    const r = this.get(id), before = r.aff
    r.aff = clamp(Math.round((r.aff + delta) * 10) / 10, 0, 100)
    const npc = npcById(id)!
    const down = (to: Stage, why: string) => { r.stage = to; this.toast(t('{name}：{why}（{stage}）', { name: npc.name, why, stage: STAGE_LABEL[to] }), 3) }
    if (r.stage === 'lover' && r.aff < 60) down('dating', t('我们是不是该冷静一下'))
    else if (r.stage === 'dating' && r.aff < 35) down('contact', t('我觉得我们还是做朋友吧'))
    else if (r.stage === 'contact' && r.aff < 5) down('stranger', t('已把你从联系人里删除'))
    return r1(r.aff - before)
  }
  /** 有一次联系：更新最近联系日；恋人每日首次联系心情 +5 */
  touch(id: string) {
    const r = this.get(id)
    r.lastContact = this.day
    if (r.stage === 'lover' && r.moodDay !== this.day) { r.moodDay = this.day; this.ctx.needs.addMood(5); this.toast(t('和恋人 {name} 联系 · 心情 +5', { name: npcById(id)!.name })) }
  }
  private pushSms(id: string, from: 'npc' | 'me', text: string) {
    const r = this.get(id)
    r.sms.push({ day: this.day, t: this.ctx.clock.hhmm, from, text })
    if (r.sms.length > SMS_KEEP) r.sms.splice(0, r.sms.length - SMS_KEEP)
  }
  isBirthday(npc: NpcDef) { return this.day % 30 === npc.bday }

  // ------------------------------------------------------------ 在场 NPC

  private spotPoi(spot: Spot, npc: NpcDef): Poi | null {
    const pois = this.ctx.pois
    const ids = (spot.ids ?? []).filter((id) => pois.byId(id))
    if (ids.length) return pois.byId(ids[Math.floor(hash(npc.id + spot.type) * ids.length)])
    const list = pois.byType(spot.type)
    return list.length ? list[Math.floor(hash(npc.id + spot.type) * list.length)] : null
  }
  /** 此刻在这个 POI 的 NPC（同一晚结果稳定） */
  presentAt(poi: Poi): NpcDef[] {
    const h = this.ctx.clock.hour
    const night = h < 5 ? this.day - 1 : this.day
    const dow = (night - 1) % 7   // 第 1 天 = 周一 → 4 周五、5 周六
    return NPCS.filter((n) => {
      if (this.companion?.npc.id === n.id) return false
      return n.spots.some((s, i) => {
        if (s.type !== poi.type || !inHours(h, s.hours)) return false
        if (s.weekend && dow !== 4 && dow !== 5) return false
        if (hash(`${n.id}|${night}|${i}`) >= (s.chance ?? 0.7) * (s.weekend ? 1.3 : 1)) return false
        return this.spotPoi(s, n)?.id === poi.id
      })
    })
  }

  // ------------------------------------------------------------ 对话评分

  /** 一个选项的好感变化（按性格语气 + 喜欢 / 讨厌话题 + 少量随机） */
  score(npc: NpcDef, o: PromptOption, src: TalkSource): number {
    let d = (npc.tones[o.tone] ?? 0) * 1.2 + rand(-1.5, 1.5)
    if (o.topic && npc.loves.includes(o.topic)) d += 2.5
    if (o.topic && npc.hates.includes(o.topic)) d -= 6
    const dr = this.drunk()
    if (dr >= 5 && src !== 'text') d -= 1.5
    if (d > 0 && src === 'club' && this.vipTonight()) d *= 1.25
    const r = this.get(npc.id)
    if (r.talkDay !== this.day) { r.talkDay = this.day; r.talkGain = 0 }
    if (d > 0) {
      const room = Math.max(0, TALK_CAP - r.talkGain)
      const g = Math.min(d, room) + Math.max(0, d - room) * 0.2
      r.talkGain += Math.min(d, room)
      d = g
    }
    return Math.round(d * 10) / 10
  }

  // ------------------------------------------------------------ 对话活动

  /** 聊天（夜店搭讪 / 其他场所 / 手机短信）。bonus = 开场额外好感（舞跳得好被吸引） */
  talkSpec(npc: NpcDef, src: TalkSource, opts: { bonus?: number; returnToPanel?: boolean } = {}): ActivitySpec {
    const r = this.get(npc.id)
    const text = src === 'text'
    const first = !r.met
    let api: ActivityApi
    let rounds = text ? 1 : 3
    const prompts: Prompt[] = text ? shuffle([...TEXT_PROMPTS]) : shuffle([...shuffle([...npc.prompts]).slice(0, 1), ...shuffle([...PROMPTS]).slice(0, 4)])
    let pi = 0, done = 0
    let say = '', mine = '', delta: number | null = null, mood = 0
    let phase: 'prompt' | 'react' | 'menu' | 'drinks' | 'gifts' | 'invite' = 'react'
    let sideCv: HTMLCanvasElement | null = null

    if (first) { r.met = true; if (r.aff < 5) r.aff = Math.round(rand(4, 9)) }
    if (opts.bonus) { this.affect(npc.id, opts.bonus); }
    say = text ? (r.sms.length && r.sms[r.sms.length - 1].from === 'npc' ? r.sms[r.sms.length - 1].text : pick(TEXT_PROMPTS).line) : first ? npc.intro : pick(npc.greet)
    if (opts.bonus && !text) say = say + '\n' + t('（刚才看你跳舞，{name} 显然被吸引了）', { name: npc.name })
    if (!text && this.isBirthday(npc) && r.stage !== 'stranger') say += '\n' + t('今天是我生日哦～')
    if (!text) this.touch(npc.id)
    phase = 'react'

    const where = src === 'club' ? t('克拉码头夜店') : src === 'casino' ? t('金沙赌场') : src === 'text' ? t('短信') : ''
    const render = () => {
      const root = api.root
      root.innerHTML = ''
      const wrap = el('div', 'club-wrap')
      const side = el('div', 'club-side')
      sideCv = el('canvas'); drawPortrait(sideCv, npc, mood)
      side.append(sideCv, el('div', 'nm', npc.name), el('div', 'meta', t('{alias} · {age} 岁 · {origin}\n{job}', { alias: npc.alias, age: npc.age, origin: npc.origin, job: npc.job })))
      const bar = el('div', 'club-bar'), fill = el('i'); fill.style.width = `${Math.round(r.aff)}%`; bar.append(fill)
      side.append(bar, el('div', 'meta', t('好感 {n} · {stage}', { n: Math.round(r.aff), stage: STAGE_LABEL[r.stage] })))
      if (r.met && r.stage !== 'stranger') side.append(el('div', 'meta', t('性格：{p}', { p: npc.persona })))
      const main = el('div', 'club-main')
      if (mine) main.append(el('div', 'club-me', mine))
      const sb = el('div', 'club-say'); sb.append(el('span', 'who', npc.name), document.createTextNode(say)); sb.style.whiteSpace = 'pre-line'
      main.append(sb)
      if (delta !== null) { const d = el('div', `club-delta ${delta >= 0 ? 'up' : 'down'}`, t('好感 {d}', { d: fmtDelta(delta) })); main.append(d) }
      const box = el('div', 'club-opts')
      if (phase === 'prompt') {
        const p = prompts[pi % prompts.length]
        sb.lastChild!.textContent = p.line
        shuffle([...p.options]).forEach((o, i) => box.append(btn(o.text, () => choose(o), { id: `opt${i}` })))
      } else if (phase === 'react') {
        box.append(btn(done < rounds ? t('继续') : '……', () => { if (done < rounds) { phase = 'prompt'; mine = ''; delta = null } else phase = 'menu'; render() }, { id: 'next' }))
      } else if (phase === 'menu') this.menu(npc, src, box, {
        drinks: () => { phase = 'drinks'; render() },
        gifts: () => { phase = 'gifts'; render() },
        invite: () => { phase = 'invite'; render() },
        more: () => { rounds = done + (text ? 1 : 2); phase = 'prompt'; mine = ''; delta = null; api.skipTime(1 / 6); render() },
        number: () => {
          if (r.aff >= 20) { r.stage = 'contact'; say = npc.gender === 'f' ? t('好啊，这是我的号码。记得找我。') : t('好啊，这是我的号码。别忘了找我。'); delta = null; this.pushSms(npc.id, 'npc', t('嗨，我是{name} :)', { name: npc.name })); api.toast(t('已添加联系人：{name}', { name: npc.name })) }
          else { say = t('呃……我们才刚认识，下次吧。'); delta = this.affect(npc.id, -2) }
          mine = t('方便留个联系方式吗？'); render()
        },
        close: () => api.close(),
      })
      else if (phase === 'drinks') {
        for (const d of DRINKS.filter((x) => !x.vipOnly || this.vipTonight())) {
          const fav = d.id === npc.drink
          box.append(btn(t('请 TA 喝 {drink}', { drink: d.name }) + (fav ? t('（TA 的最爱）') : ''), () => {
            if (!spend(this.ctx, d.price, 'date:drink')) { api.toast(t('钱不够')); return }
            mine = t('请你喝一杯 {drink}？', { drink: d.name })
            const base = fav ? 6 : d.units === 0 && npc.drink !== 'mocktail' ? 1 : npc.drink === 'mocktail' && d.units > 0 ? -3 : 3
            delta = this.affect(npc.id, base * (this.vipTonight() ? 1.25 : 1))
            say = fav ? t('你怎么知道我最喜欢这个！') : base < 0 ? t('谢谢……不过我不喝酒的。') : t('谢啦，干杯！')
            mood = delta > 0 ? 1 : -0.5
            phase = 'menu'; render()
          }, { note: fmt$(d.price), id: `drink_${d.id}` }))
        }
        box.append(btn(t('算了'), () => { phase = 'menu'; render() }, { id: 'back' }))
      } else if (phase === 'gifts') {
        for (const g of GIFTS.filter((x) => (this.inv[x.id] ?? 0) > 0)) {
          box.append(btn(t('送出 {gift} ×1', { gift: g.name }), () => { const res = this.giveGift(npc, g.id); mine = t('送你的，{gift}。', { gift: g.name }); say = res.line; delta = res.delta; mood = res.delta > 0 ? 1 : -1; phase = 'menu'; render() }, { note: t('库存 {n}', { n: this.inv[g.id] }), id: `gift_${g.id}` }))
        }
        box.append(btn(t('算了'), () => { phase = 'menu'; render() }, { id: 'back' }))
      } else if (phase === 'invite') {
        this.inviteUi(npc, box, (msg) => { say = msg.line; mine = msg.mine; delta = null; phase = 'menu'; render() }, () => { phase = 'menu'; render() })
      }
      main.append(box)
      main.append(el('div', 'club-note', where ? `${where} · ${this.ctx.clock.hhmm}` : this.ctx.clock.hhmm))
      wrap.append(side, main)
      root.append(wrap)
    }
    const choose = (o: PromptOption) => {
      const d = this.score(npc, o, src)
      delta = this.affect(npc.id, d)
      mine = o.text
      const cat = d >= 2.5 ? 'good' : d >= -1 ? 'ok' : 'bad'
      say = pick(npc.react[cat])
      mood = cat === 'good' ? 1 : cat === 'ok' ? 0.2 : -0.8
      if (text) { this.pushSms(npc.id, 'me', o.text); this.pushSms(npc.id, 'npc', say); this.touch(npc.id) }
      done++; pi++
      phase = 'react'
      api.skipTime(text ? 1 / 30 : 1 / 12)
      render()
    }
    return {
      id: text ? 'club_text' : 'club_talk', title: text ? t('短信 · {name}', { name: npc.name }) : npc.name, subtitle: text ? STAGE_LABEL[r.stage] : `${npc.job}${where ? ' · ' + where : ''}`,
      returnToPanel: opts.returnToPanel ?? !text,
      mount: (_root, a) => { api = a; injectStyle(); render() },
    }
  }

  /** 对话末尾的操作菜单 */
  private menu(npc: NpcDef, src: TalkSource, box: HTMLElement, h: { drinks(): void; gifts(): void; invite(): void; more(): void; number(): void; close(): void }) {
    const r = this.get(npc.id)
    if ((src === 'club' || src === 'casino')) box.append(btn(t('请 TA 喝一杯'), h.drinks, { note: t('TA 爱喝：{drink}', { drink: DRINKS.find((d) => d.id === npc.drink)?.name ?? '' }), id: 'm_drink' }))
    if (src !== 'text' && Object.values(this.inv).some((n) => n > 0)) box.append(btn(t('送礼物'), h.gifts, { id: 'm_gift' }))
    if (r.stage === 'stranger') box.append(btn(t('要联系方式'), h.number, { note: r.aff >= 20 ? t('时机不错') : t('好感还不够'), id: 'm_number' }))
    else box.append(btn(t('约 TA 出来'), h.invite, { note: this.appt ? t('已有约会') : r.inviteDay === this.day ? t('今天约过了') : '', disabled: !!this.appt || r.inviteDay === this.day, id: 'm_invite' }))
    box.append(btn(t('再聊一会儿'), h.more, { note: src === 'text' ? '' : t('约 10 分钟'), id: 'm_more' }))
    box.append(btn(src === 'text' ? t('放下手机') : t('告辞'), h.close, { id: 'm_close' }))
  }

  /** 送礼：喜欢 ×2、讨厌扣分、生日 ×2.5、同日多份递减 */
  giveGift(npc: NpcDef, giftId: string, delivered = false): { delta: number; line: string } {
    const g = giftById(giftId)!, r = this.get(npc.id)
    if (!delivered) { if ((this.inv[giftId] ?? 0) <= 0) return { delta: 0, line: '' }; this.inv[giftId]--; if (!this.inv[giftId]) delete this.inv[giftId] }
    if (r.giftDay !== this.day) { r.giftDay = this.day; r.giftCount = 0 }
    const love = npc.gifts.love.includes(giftId), hate = npc.gifts.hate.includes(giftId)
    let d = hate ? -3 : g.value * (love ? 2 : 1)
    const bday = this.isBirthday(npc)
    if (bday && d > 0) { d *= 2.5; r.bdayGift = this.day }
    if (d > 0) d *= Math.pow(0.5, r.giftCount)
    if (r.stage === 'lover' && d > 0) d += 1
    r.giftCount++
    const delta = this.affect(npc.id, d)
    this.touch(npc.id)
    const line = hate ? t('呃……谢谢，不过这不太是我的风格。') : bday ? t('你记得我生日！{gift}……我好开心。', { gift: g.name }) : love ? t('{gift}！你怎么知道我最想要这个！', { gift: g.name }) : t('谢谢你，好用心。')
    if (delivered) { this.pushSms(npc.id, 'me', t('[快递] 送你一份 {gift}', { gift: g.name })); this.pushSms(npc.id, 'npc', line) }
    return { delta, line }
  }

  // ------------------------------------------------------------ 邀约

  /** 可选约会时间：今天 / 明天 12、18–23 点中晚于现在 45 分钟的，且在地点营业时段内 */
  inviteTimes(placeId: string): number[] {
    const pl = datePlaceById(placeId)!
    const out: number[] = []
    for (const d of [this.day, this.day + 1]) for (const h of [12, 18, 19, 20, 21, 22, 23]) {
      const at = (d - 1) * 24 + h
      if (at > this.abs + 0.75 && inHours(h, pl.hours)) out.push(at)
    }
    return out.slice(0, 7)
  }
  resolvePlace(placeId: string): Poi | null {
    const pl = datePlaceById(placeId); if (!pl) return null
    for (const id of pl.pois) { const p = this.ctx.pois.byId(id); if (p) return p }
    return this.ctx.pois.byType(pl.fallbackType)[0] ?? null
  }
  /** 尝试邀约：按好感 / 是否喜欢该地点决定是否答应 */
  invite(npc: NpcDef, placeId: string, at: number, force = false): { ok: boolean; line: string } {
    const r = this.get(npc.id)
    r.inviteDay = this.day
    const liked = npc.places.includes(placeId)
    const p = r.stage === 'lover' ? 0.97 : clamp((r.aff - 15) / 45 + (liked ? 0.15 : 0), 0.12, 0.95)
    const pl = datePlaceById(placeId)!
    const when = Math.floor(at / 24) + 1 === this.day ? t('今天 {time}', { time: hhmm(at) }) : t('明天 {time}', { time: hhmm(at) })
    this.touch(npc.id)
    this.pushSms(npc.id, 'me', t('{when} 一起去{place}？', { when, place: pl.name }))
    if (!force && Math.random() > p) {
      const line = pick([t('这次不太方便，下次吧。'), t('那天我有事……抱歉。'), t('嗯……让我想想，先不了。')])
      this.pushSms(npc.id, 'npc', line)
      return { ok: false, line }
    }
    this.appt = { npc: npc.id, place: placeId, at }
    const line = (liked ? t('好呀！我最喜欢{place}了。', { place: pl.name }) : t('好啊。')) + t('{when}见，别迟到哦。', { when })
    this.pushSms(npc.id, 'npc', line)
    return { ok: true, line }
  }
  private inviteUi(npc: NpcDef, box: HTMLElement, done: (m: { line: string; mine: string }) => void, back: () => void) {
    let place: string | null = null
    const draw = () => {
      box.innerHTML = ''
      if (!place) {
        box.append(el('div', 'club-note', t('去哪里？')))
        for (const p of DATE_PLACES) {
          const poi = this.resolvePlace(p.id)
          box.append(btn(`${p.name}${npc.places.includes(p.id) ? '  ♥' : ''}`, () => { place = p.id; draw() }, { note: poi ? '' : t('此世界没有'), disabled: !poi || !this.inviteTimes(p.id).length, id: `pl_${p.id}` }))
        }
      } else {
        box.append(el('div', 'club-note', t('{place} · 什么时候？', { place: datePlaceById(place)!.name })))
        this.inviteTimes(place).forEach((at, i) => box.append(btn(Math.floor(at / 24) + 1 === this.day ? t('今天 {time}', { time: hhmm(at) }) : t('明天 {time}', { time: hhmm(at) }), () => {
          const res = this.invite(npc, place!, at)
          done({ line: res.line, mine: t('{when} 一起去{place}？', { when: hhmm(at), place: datePlaceById(place!)!.name }) })
        }, { id: `t_${i}` })))
      }
      box.append(btn(t('算了'), back, { id: 'back' }))
    }
    draw()
  }

  // ------------------------------------------------------------ 约会

  apptState(): { npc: NpcDef; place: ReturnType<typeof datePlaceById>; poi: Poi | null; phase: 'early' | 'now' | 'late' } | null {
    const a = this.appt; if (!a) return null
    const npc = npcById(a.npc), place = datePlaceById(a.place)
    if (!npc || !place) return null
    const t = this.abs
    return { npc, place, poi: this.resolvePlace(a.place), phase: t < a.at - 0.5 ? 'early' : t <= a.at + 1.5 ? 'now' : 'late' }
  }

  dateSpec(): ActivitySpec | null {
    const st = this.apptState(); if (!st || !st.place) return null
    const { npc, place } = st
    const r = this.get(npc.id)
    let api: ActivityApi
    let step: 'act' | 'talk' | 'react' | 'end' | 'done' = 'act'
    let say = pick(npc.greet) + (npc.places.includes(place.id) ? '\n' + t('{place}！我一直想来。', { place: place.name }) : '')
    let mine = '', delta: number | null = null, mood = 0.5
    const prompts = shuffle([...shuffle([...npc.prompts]).slice(0, 1), ...shuffle([...PROMPTS]).slice(0, 2)])
    let talked = 0
    let spent = 0
    let home = false
    const total = () => Math.round(r.aff)
    if (this.early === this.appt!.at) { this.early = -1; this.affect(npc.id, 2); say = t('你来得好早，我很开心。') + '\n' + say }
    const finish = () => {
      if (step === 'done') return
      step = 'done'
      r.dates++
      if (r.stage === 'contact' && r.aff >= 45) { r.stage = 'dating'; api.toast(t('{name} 和你开始约会了！', { name: npc.name }), 3) }
      this.touch(npc.id)
      this.ctx.events.emit('dated', { npc: npc.id, stage: r.stage === 'lover' ? 'lover' : r.stage })
      this.appt = null
      if (home && r.stage === 'lover') { this.overnight = npc.id; this.overnightUntil = this.abs + 2 + 10 }
      else this.dismissCompanion()
      api.skipTime(2)
    }
    const render = () => {
      const root = api.root
      root.innerHTML = ''
      const wrap = el('div', 'club-wrap'), side = el('div', 'club-side')
      const cv = el('canvas'); drawPortrait(cv, npc, mood)
      const bar = el('div', 'club-bar'), fill = el('i'); fill.style.width = `${Math.round(r.aff)}%`; bar.append(fill)
      side.append(cv, el('div', 'nm', npc.name), el('div', 'meta', t('{place} · 第 {n} 次约会', { place: place.name, n: r.dates + 1 })), bar, el('div', 'meta', t('好感 {n} · {stage}', { n: total(), stage: STAGE_LABEL[r.stage] })))
      const main = el('div', 'club-main')
      if (mine) main.append(el('div', 'club-me', mine))
      const sb = el('div', 'club-say'); sb.style.whiteSpace = 'pre-line'; sb.append(el('span', 'who', npc.name), document.createTextNode(say)); main.append(sb)
      if (delta !== null) main.append(el('div', `club-delta ${delta >= 0 ? 'up' : 'down'}`, t('好感 {d}', { d: fmtDelta(delta) })))
      const box = el('div', 'club-opts')
      if (step === 'act') {
        box.append(el('div', 'club-note', t('先做点什么？')))
        place.acts.forEach((a, i) => box.append(btn(a.label, () => {
          if (a.cost > 0 && !spend(this.ctx, a.cost, `date:${place.id}`)) { api.toast(t('钱不够')); return }
          spent += a.cost
          delta = this.affect(npc.id, a.aff + (npc.places.includes(place.id) ? 3 : 0) + (r.stage === 'lover' ? 1 : 0))
          mine = a.label; say = a.line; mood = 1
          step = 'react'; api.skipTime(0.5); render()
        }, { note: a.cost ? fmt$(a.cost) : t('免费'), disabled: a.cost > this.ctx.player.money, id: `act${i}` })))
      } else if (step === 'react') {
        box.append(btn(t('继续'), () => { step = talked < 2 ? 'talk' : 'end'; mine = ''; delta = null; render() }, { id: 'next' }))
      } else if (step === 'talk') {
        const p = prompts[talked % prompts.length]
        sb.lastChild!.textContent = p.line
        shuffle([...p.options]).forEach((o, i) => box.append(btn(o.text, () => {
          const d = this.score(npc, o, 'poi')
          delta = this.affect(npc.id, d); mine = o.text
          const cat = d >= 2.5 ? 'good' : d >= -1 ? 'ok' : 'bad'
          say = pick(npc.react[cat]); mood = cat === 'good' ? 1 : cat === 'ok' ? 0.3 : -0.8
          talked++; step = 'react'; render()
        }, { id: `opt${i}` })))
      } else if (step === 'end') {
        say = r.stage === 'lover' ? t('今天好开心。接下来呢？') : t('时间过得好快……')
        box.append(el('div', 'club-note', t('约会快结束了')))
        const close = (line: string, me: string, d: number) => { mine = me; say = line; delta = d ? this.affect(npc.id, d) : null; mood = (delta ?? 0) >= 0 ? 1 : -0.5; finish(); render() }
        box.append(btn(t('牵着手散散步'), () => r.aff >= 50 ? close(t('（TA 轻轻握住了你的手）'), t('要不要走走？'), 3) : close(t('呃……我们慢慢来好吗？'), t('（伸出手）'), -2), { id: 'e_hand' }))
        box.append(btn(t('拥抱道别'), () => r.aff >= 65 ? close(t('（一个温暖的拥抱）下次见。'), t('今天谢谢你。'), 3) : close(t('（TA 有点僵硬地拍了拍你的背）'), t('抱一下？'), -2), { id: 'e_hug' }))
        if (r.stage === 'dating' && r.aff >= 60) box.append(btn(t('表白'), () => {
          if (r.aff >= 80 && r.dates >= 2) { r.stage = 'lover'; close(t('……我也喜欢你。那我们，就在一起吧。'), t('我喜欢你，做我的恋人好吗？'), 5); api.toast(t('{name} 成为了你的恋人', { name: npc.name }), 3) }
          else close(t('我很开心……但我还没准备好。'), t('我喜欢你。'), -5)
        }, { note: r.aff >= 80 && r.dates >= 2 ? t('气氛正好') : t('再等等？'), id: 'e_confess' }))
        if (r.stage === 'lover') box.append(btn(t('一起回家'), () => { home = true; close(t('嗯，我们回家吧。'), t('今晚去我家？'), 2) }, { note: t('睡觉时额外心情'), id: 'e_home' }))
        box.append(btn(t('礼貌道别'), () => close(t('今天很开心，路上小心。'), t('那……下次见。'), 1), { id: 'e_bye' }))
      } else {
        box.append(el('div', 'club-note', t('约会结束 · 花费 {cost} · 好感 {n} · {stage}', { cost: fmt$(spent), n: total(), stage: STAGE_LABEL[r.stage] }) + (home ? t(' · TA 跟你回家了') : '')))
        box.append(btn(t('结束约会'), () => api.close(), { id: 'd_close' }))
      }
      main.append(box)
      wrap.append(side, main); root.append(wrap)
    }
    return {
      id: 'club_date', title: t('约会 · {name}', { name: npc.name }), subtitle: place.name, returnToPanel: false, closable: true,
      mount: (_root, a) => { api = a; injectStyle(); render() },
      onClose: () => { if (step !== 'done' && step !== 'act') finish() },
    }
  }

  /** 生成同伴（约会地点门口等候） */
  spawnCompanion(): Companion | null {
    const st = this.apptState(); if (!st?.poi) return null
    if (this.companion?.npc.id === st.npc.id) return this.companion
    this.dismissCompanion()
    const d = st.poi.door
    const sx = d.x + Math.cos(d.yaw) * 1.4, sz = d.z - Math.sin(d.yaw) * 1.4
    this.companion = new Companion(st.npc, this.game.scene, this.game.charLib, sx, sz, d.yaw)
    return this.companion
  }
  dismissCompanion() { this.companion?.dispose(); this.companion = null }

  private onSlept() {
    if (!this.overnight) return
    const npc = npcById(this.overnight)
    this.overnight = null
    this.dismissCompanion()
    if (!npc) return
    this.ctx.needs.addMood(8)
    this.affect(npc.id, 2)
    this.pushSms(npc.id, 'npc', t('早安。昨晚聊到好晚，今天也要加油哦。'))
    this.toast(t('和 {name} 在家度过了温馨的一晚 · 心情 +8', { name: npc.name }), 3)
  }

  onBustOrDeath() {
    if (this.overnight) { const id = this.overnight; this.overnight = null; this.affect(id, -3); this.pushSms(id, 'npc', t('你没事吧？我先回家了。')) }
    if (this.companion && !this.appt) this.dismissCompanion()
  }

  // ------------------------------------------------------------ 每帧

  update(dt: number) {
    const now = this.abs
    // 整点：短信；跨日：冷落 / 生日
    if (this.lastAbs === 0) this.lastAbs = now
    if (now < this.lastAbs) this.lastAbs = now   // 读档回退
    const h0 = Math.floor(this.lastAbs), h1 = Math.floor(now)
    if (h1 > h0) {
      const d0 = Math.floor(h0 / 24), d1 = Math.floor(h1 / 24)
      for (let d = d0 + 1; d <= Math.min(d1, d0 + 7); d++) this.newDay(d + 1)
      for (let h = Math.max(h0 + 1, h1 - 12); h <= h1; h++) this.hourTick(h)
    }
    this.lastAbs = now
    // 约会：提前 1 小时同伴到场；超时爽约
    const st = this.apptState()
    if (st) {
      if (st.phase === 'late') this.missDate()
      else if (now >= this.appt!.at - 1 && !this.companion) this.spawnCompanion()
    }
    if (this.overnight && now > this.overnightUntil) {
      const npc = npcById(this.overnight); this.overnight = null
      if (npc) this.pushSms(npc.id, 'npc', t('我先回家啦，今天谢谢你。'))
      this.dismissCompanion()
    }
    const c = this.companion
    if (c) {
      const was = c.mode
      c.update(dt, this.ctx.player)
      if (was === 'wait' && c.mode === 'follow' && this.appt && now <= this.appt.at) this.early = this.appt.at
    }
  }

  missDate() {
    const a = this.appt; if (!a) return
    const npc = npcById(a.npc)!
    this.appt = null
    this.dismissCompanion()
    const d = this.affect(npc.id, -12)
    this.pushSms(npc.id, 'npc', pick([t('我等了你一个多小时……'), t('你放我鸽子了。'), t('算了，不用解释了。')]))
    this.toast(t('你放了 {name} 鸽子 · 好感 {d}', { name: npc.name, d: fmtDelta(d) }), 3.5)
  }

  private newDay(day: number) {
    for (const npc of NPCS) {
      const r = this.rel[npc.id]; if (!r || r.stage === 'stranger') continue
      // 昨天是生日却没送礼（约会中 / 恋人）
      if ((day - 1) % 30 === npc.bday && (r.stage === 'dating' || r.stage === 'lover') && r.bdayGift !== day - 1) {
        this.affect(npc.id, -4); this.pushSms(npc.id, 'npc', t('昨天是我生日……算了。'))
      }
      const gap = day - r.lastContact
      if (gap > 2) this.affect(npc.id, r.stage === 'lover' ? -3 : r.stage === 'dating' ? -2 : -1)
      if (day % 30 === npc.bday) this.pushSms(npc.id, 'npc', t('今天是我生日哦～'))
    }
  }

  private hourTick(absH: number) {
    const h = absH % 24
    if (h >= 2 && h < 9) return
    const day = Math.floor(absH / 24) + 1
    for (const npc of NPCS) {
      const r = this.rel[npc.id]; if (!r || r.stage === 'stranger') continue
      if (r.smsDay !== day) { r.smsDay = day; r.smsCount = 0 }
      const cap = r.stage === 'lover' ? 2 : 1
      if (r.smsCount >= cap) continue
      if (Math.random() < 0.02 + (r.aff / 100) * 0.09) {
        r.smsCount++
        this.pushSms(npc.id, 'npc', pick(npc.sms))
        if (this.game.state === 'play') this.toast(t('短信 · {name}：{text}', { name: npc.name, text: r.sms[r.sms.length - 1].text }), 3)
      }
    }
  }

  // ------------------------------------------------------------ 面板 / 手机 / HUD

  /** 非夜店 POI：在场 NPC 的聊天按钮、约会地点按钮、商店礼品柜台 */
  poiButtons(poi: Poi): PanelButton[] {
    const out: PanelButton[] = []
    const st = this.apptState()
    if (st && st.poi?.id === poi.id) {
      const can = st.phase === 'now'
      out.push({ label: t('和 {name} 约会', { name: st.npc.name }), note: can ? st.place!.name : t('约在 {time}', { time: hhmm(this.appt!.at) }), disabled: !can, anyHour: true, onClick: () => { const s = this.dateSpec(); if (s) this.game.openActivity(s) } })
    }
    if (poi.type !== 'club') for (const npc of this.presentAt(poi)) out.push(this.talkButton(npc, poi.type === 'casino' ? 'casino' : 'poi'))
    if (poi.type === 'shop') out.push({ label: t('礼品柜台'), note: t('给 TA 挑礼物'), onClick: () => this.game.openActivity(this.giftShopSpec(null)) })
    return out
  }
  talkButton(npc: NpcDef, src: TalkSource, bonus = 0): PanelButton {
    const r = this.rel[npc.id]
    const name = r?.met ? t('和 {name} 聊聊', { name: npc.name }) : t('搭讪：{who}', { who: npc.blurb })
    return { label: name, note: r?.met ? t('{stage} · 好感 {n}', { stage: STAGE_LABEL[r.stage], n: Math.round(r.aff) }) : '', onClick: () => this.game.openActivity(this.talkSpec(npc, src, { bonus })) }
  }

  /** 礼品柜台（商店）或快递送礼（联系人页，to = 收礼人） */
  giftShopSpec(to: NpcDef | null): ActivitySpec {
    let api: ActivityApi
    const render = () => {
      const root = api.root; root.innerHTML = ''
      const wrap = el('div', 'club-wrap'), main = el('div', 'club-main')
      main.append(el('div', 'club-say', to ? t('快递送礼给 {name}（运费 {fee}，库存里的礼物只收运费）', { name: to.name, fee: fmt$(DELIVERY_FEE) }) : t('挑一份礼物，下次见面时送出（或在联系人页快递）。')))
      if (to) { const rr = this.get(to.id); main.append(el('div', 'club-note', rr.dates > 0 || rr.aff >= 40 ? t('TA 喜欢：{list}', { list: to.gifts.love.map((g) => giftById(g)?.name).join(t('、')) }) : t('多聊聊、约会几次才知道 TA 喜欢什么'))) }
      const list = el('div', 'club-list')
      for (const g of GIFTS) {
        const have = this.inv[g.id] ?? 0
        const cost = to ? (have > 0 ? DELIVERY_FEE : g.price + DELIVERY_FEE) : g.price
        const b = el('button')
        b.dataset.club = `g_${g.id}`
        b.innerHTML = ''
        b.append(el('b', '', g.name), el('br'), document.createTextNode(`${g.desc}`), el('br'), document.createTextNode(fmt$(cost) + (have ? ' · ' + t('库存 {n}', { n: have }) : '')))
        b.disabled = cost > this.ctx.player.money
        b.addEventListener('click', () => {
          if (to) {
            if (have <= 0 && !spend(this.ctx, g.price, 'date:gift')) return
            if (have > 0) { this.inv[g.id]--; if (!this.inv[g.id]) delete this.inv[g.id] }
            spend(this.ctx, DELIVERY_FEE, 'date:delivery')
            const res = this.giveGift(to, g.id, true)
            api.toast(t('{name}：{line}\n好感 {d}', { name: to.name, line: res.line, d: fmtDelta(res.delta) }), 3)
          } else {
            if (!spend(this.ctx, g.price, 'date:gift')) return
            this.inv[g.id] = have + 1
            api.toast(t('买下 {gift}', { gift: g.name }))
          }
          render()
        })
        list.append(b)
      }
      main.append(list, btn(t('关闭'), () => api.close(), { id: 'gs_close' }))
      wrap.append(main); root.append(wrap)
    }
    return { id: 'club_gifts', title: to ? t('送礼 · {name}', { name: to.name }) : t('礼品柜台'), subtitle: to ? t('快递') : t('商店'), returnToPanel: !to, mount: (_r, a) => { api = a; injectStyle(); render() } }
  }

  /** 邀约（联系人页） */
  inviteSpec(npc: NpcDef): ActivitySpec {
    let api: ActivityApi
    return {
      id: 'club_invite', title: t('邀约 · {name}', { name: npc.name }), subtitle: STAGE_LABEL[this.get(npc.id).stage],
      mount: (_r, a) => {
        api = a; injectStyle()
        const wrap = el('div', 'club-wrap'), side = el('div', 'club-side'), cv = el('canvas'); drawPortrait(cv, npc, 0.3)
        side.append(cv, el('div', 'nm', npc.name))
        const main = el('div', 'club-main'), say = el('div', 'club-say', t('想约 TA 去哪里？')), box = el('div', 'club-opts')
        main.append(say, box); wrap.append(side, main); api.root.append(wrap)
        this.inviteUi(npc, box, (m) => { say.textContent = m.line; box.innerHTML = ''; box.append(btn(t('好'), () => api.close(), { id: 'inv_ok' })) }, () => api.close())
      },
    }
  }

  view(): AppView {
    const ks = this.known()
    const st = this.apptState()
    if (!ks.length && !st) return { lines: [t('还没有认识的人 · 晚上去克拉码头夜店（21:00–04:00）看看，或者在小贩中心 / 商场 / 赌场留意身边的人')], sections: this.game.venueSections(CLUB_ID) }
    const lines = [t('联系人 {n} 位 · 恋人 {m} 位', { n: ks.length, m: ks.filter((n) => this.rel[n.id].stage === 'lover').length }) + (Object.keys(this.inv).length ? t(' · 礼物库存 {k} 件', { k: Object.values(this.inv).reduce((a, b) => a + b, 0) }) : '')]
    if (st) lines.push(t('约会：{name} · {place} · {when}', { name: st.npc.name, place: st.place!.name, when: Math.floor(this.appt!.at / 24) + 1 === this.day ? t('今天 {time}', { time: hhmm(this.appt!.at) }) : t('明天 {time}', { time: hhmm(this.appt!.at) }) }))
    const items: AppItem[] = ks.map((npc) => {
      const r = this.rel[npc.id]
      const last = r.sms[r.sms.length - 1]
      return {
        title: `${npc.name} · ${npc.alias}`,
        desc: t('{age} 岁 · {job}', { age: npc.age, job: npc.job }) + (last ? '\n' + t('{who}：{text}', { who: last.from === 'me' ? t('我') : npc.name, text: last.text }) : ''),
        value: `♥ ${Math.round(r.aff)}`,
        status: STAGE_LABEL[r.stage] + (this.isBirthday(npc) ? t(' · 今天生日') : '') + (this.day - r.lastContact > 2 ? t(' · {n} 天没联系', { n: this.day - r.lastContact }) : ''),
        tone: r.stage === 'lover' ? 'owned' : undefined,
        actions: [
          { label: t('发消息'), onClick: () => this.game.openActivity(this.talkSpec(npc, 'text')) },
          { label: t('邀约'), disabled: !!this.appt || r.inviteDay === this.day, onClick: () => this.game.openActivity(this.inviteSpec(npc)) },
          { label: t('送礼（快递）'), onClick: () => this.game.openActivity(this.giftShopSpec(npc)) },
        ],
      }
    })
    const log: string[] = []
    for (const npc of ks) for (const m of this.rel[npc.id].sms) log.push(`${String(m.day).padStart(4, '0')}${m.t}|` + t('第{d}天 {time} {who}：{text}', { d: m.day, time: m.t, who: m.from === 'me' ? t('我 → {name}', { name: npc.name }) : npc.name, text: m.text }))
    log.sort().reverse()
    return {
      lines,
      bars: ks.map((n) => ({ label: n.name, pct: this.rel[n.id].aff / 100, text: `${Math.round(this.rel[n.id].aff)} · ${STAGE_LABEL[this.rel[n.id].stage]}` })),
      sections: [...this.game.venueSections(CLUB_ID), { title: t('联系人'), items }],
      log: log.slice(0, 10).map((s) => s.slice(s.indexOf('|') + 1)),
    }
  }

  /** 约会前 3 小时起才占用 HUD 任务卡 / 导航（更早的约会只在联系人页显示） */
  private get apptSoon() { return !!this.appt && this.appt.at - this.abs <= 3 }
  hudCard() {
    const st = this.apptState(); if (!st || !this.apptSoon) return null
    const left = this.appt!.at - this.abs
    const timer = st.phase === 'early' ? `${Math.floor(left) ? Math.floor(left) + 'h' : ''}${String(Math.floor((left % 1) * 60)).padStart(2, '0')}m` : t('现在')
    return {
      title: t('约会 · {name}', { name: st.npc.name }),
      desc: `${st.place!.name} ${hhmm(this.appt!.at)}`,
      timer,
      sub: this.companion ? (this.companion.mode === 'follow' ? t('{name} 跟着你 · 在门口按 E 开始约会', { name: st.npc.name }) : t('{name} 已在门口等你', { name: st.npc.name })) : t('提前到会更加分'),
    }
  }
  navTarget() {
    const st = this.apptState()
    if (st?.poi && this.apptSoon) return { x: st.poi.door.x, z: st.poi.door.z }
    return null
  }

  serialize(): RelSave {
    return { v: 1, rel: JSON.parse(JSON.stringify(this.rel)) as Record<string, RelState>, appt: this.appt ? { ...this.appt } : null, inv: { ...this.inv }, overnight: this.overnight, lastAbs: this.lastAbs }
  }
  restore(s: RelSave | undefined) {
    this.dismissCompanion()
    this.rel = {}; this.appt = null; this.inv = {}; this.overnight = null
    this.lastAbs = 0
    if (!s || s.v !== 1) return
    for (const [id, r] of Object.entries(s.rel ?? {})) if (npcById(id)) { this.get(id); Object.assign(this.rel[id], r); this.rel[id].aff = clamp(r1(Number(r.aff) || 0), 0, 100); this.rel[id].sms = (r.sms ?? []).slice(-SMS_KEEP) }
    this.appt = s.appt && npcById(s.appt.npc) && datePlaceById(s.appt.place) ? { ...s.appt } : null
    this.inv = { ...(s.inv ?? {}) }
    this.lastAbs = s.lastAbs ?? 0
  }
}
