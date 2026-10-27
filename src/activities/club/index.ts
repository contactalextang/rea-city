import type { Game } from '../../core/Game'
import type { GamePlugin } from '../Plugin'
import type { Poi } from '../../systems/Poi'
import { NPCS, npcById, STAGE_LABEL, DATE_PLACES } from '../../data/dates'
import { Relations, type RelSave } from './Relations'
import { Club, DRUNK_LIMIT, type ClubSave } from './Club'
import { liveDance, GOOD_WIN, PERFECT_WIN } from './Dance'
import { BEAT, CLUB_BPM, SONG_LEN } from './ClubMusic'
import { t } from '../../i18n'

interface ClubPluginSave { v: 1; club: ClubSave; rel: RelSave }

/**
 * P10.E 夜店 + 恋爱关系插件（id 'club'）：克拉码头夜店（门票 / 点酒 / 舞蹈 / VIP / 搭讪）+ 8 位 NPC 的关系系统
 * （手机“联系人”页、邀约、约会同伴、恋人效果）。
 * 给主控的接口：drunkLevel()（醉意单位，0 = 清醒）/ overLimit()（≥ DRUNK_LIMIT，可接 Law 酒驾判定）。
 */
export class ClubPlugin implements GamePlugin {
  readonly id = 'club'
  readonly rel: Relations
  readonly club: Club
  readonly app = { name: 'contacts', title: t('联系人'), view: () => this.rel.view() }

  constructor(private game: Game) {
    this.rel = new Relations(game)
    this.club = new Club(game, this.rel)
  }

  /** 醉意单位（每杯 0–3，按游戏时间每小时消退 1）；Law 酒驾判定用 */
  drunkLevel() { return this.club.drunk }
  /** 是否超过酒驾标准 */
  overLimit() { return this.club.drunk >= DRUNK_LIMIT }

  update(dt: number) { this.club.update(dt); this.rel.update(dt) }
  serialize(): ClubPluginSave { return { v: 1, club: this.club.serialize(), rel: this.rel.serialize() } }
  restore(s: unknown) {
    const d = s as ClubPluginSave | undefined
    this.club.restore(d?.v === 1 ? d.club : undefined)
    this.rel.restore(d?.v === 1 ? d.rel : undefined)
  }
  poiButtons(poi: Poi) { return [...this.club.poiButtons(poi), ...this.rel.poiButtons(poi)] }
  hudCard() { return this.rel.hudCard() }
  navTarget() { return this.rel.navTarget() }
  onBustOrDeath() { this.rel.onBustOrDeath() }

  debug() {
    const self = this, g = this.game, rel = this.rel, club = this.club
    return {
      npcs: () => NPCS.map((n) => { const r = rel.rel[n.id]; return { id: n.id, name: n.name, aff: r?.aff ?? 0, stage: r?.stage ?? 'stranger', met: !!r?.met, dates: r?.dates ?? 0, sms: r?.sms.length ?? 0, lastContact: r?.lastContact ?? 0 } }),
      rel: (id: string) => rel.rel[id] ?? null,
      present: (poiId: string) => { const p = g.ctx.pois.byId(poiId); return p ? rel.presentAt(p).map((n) => n.id) : [] },
      meet: (id: string) => { const n = npcById(id); if (!n) return null; const r = rel.get(id); r.met = true; if (r.stage === 'stranger') r.stage = 'contact'; r.aff = Math.max(r.aff, 25); rel.touch(id); return { ...r, sms: undefined } },
      setAffection: (id: string, n: number) => { rel.get(id); rel.rel[id].aff = Math.max(0, Math.min(100, n)); rel.affect(id, 0); return rel.rel[id].aff },
      setStage: (id: string, s: 'stranger' | 'contact' | 'dating' | 'lover') => { rel.get(id).stage = s; return STAGE_LABEL[s] },
      /** 强制答应的邀约：hour 为今天的小时（已过则明天） */
      invite: (id: string, place: string, hour: number) => {
        const n = npcById(id); if (!n || !DATE_PLACES.some((p) => p.id === place)) return null
        const c = g.ctx.clock
        let at = (c.day - 1) * 24 + hour
        if (at <= c.absHours) at += 24
        rel.invite(n, place, at, true)
        return { ...rel.appt!, poi: rel.resolvePlace(place)?.id ?? null }
      },
      get appt() { return rel.appt ? { ...rel.appt, poi: rel.resolvePlace(rel.appt.place)?.id ?? null } : null },
      get hud() { return rel.hudCard() },
      get nav() { return rel.navTarget() },
      companion: () => { const c = rel.companion; if (!c) return null; const p = g.ctx.player; return { npc: c.npc.id, mode: c.mode, x: c.x, z: c.z, visible: c.visible, dist: c.dist(p), mesh: c.group.children.length } },
      /** 传送到约会地点并直接开始约会活动（时钟拨到约定时间） */
      startDate: () => {
        const st = rel.apptState(); if (!st?.poi) return false
        const c = g.ctx.clock
        if (c.absHours < rel.appt!.at - 0.5) c.set(rel.appt!.at % 24, Math.floor(rel.appt!.at / 24) + 1)
        const d = st.poi.door
        if (g.player.vehicle) g.player.exit(g.world)
        g.player.place(d.x, d.z, d.yaw); g.cam.snap(d.yaw)
        rel.spawnCompanion()
        const spec = rel.dateSpec(); return spec ? g.openActivity(spec) : false
      },
      missDate: () => rel.missDate(),
      talk: (id: string) => { const n = npcById(id); return n ? g.openActivity(rel.talkSpec(n, 'club')) : false },
      text: (id: string) => { const n = npcById(id); return n ? g.openActivity(rel.talkSpec(n, 'text')) : false },
      giveGift: (id: string, gift: string) => { const n = npcById(id); if (!n) return null; rel.inv[gift] = (rel.inv[gift] ?? 0) + 1; return rel.giveGift(n, gift) },
      get inv() { return { ...rel.inv } },
      dance: (score?: number) => club.debugDance(score ?? 0.85),
      openDance: () => club.openDance(),
      /** 进行中的舞蹈：谱面 / 歌曲时间 / 底鼓时间 / 判定窗 */
      get live() {
        const L = liveDance; if (!L) return null
        return { now: L.now(), notes: L.chart.map((n) => ({ t: n.t, lane: n.lane, hit: n.hit, dt: n.dt ?? null })), kicks: [...L.kicks], combo: L.combo(), audible: L.audible, bpm: CLUB_BPM, beat: BEAT, len: SONG_LEN, perfect: PERFECT_WIN, good: GOOD_WIN }
      },
      press: (lane: number) => liveDance?.press(lane) ?? null,
      songTime: () => liveDance?.now() ?? null,
      get drunk() { return club.drunk }, set drunk(v: number) { club.drunk = Math.max(0, v) },
      get overLimit() { return self.overLimit() },
      get club() { return { entered: club.entered, vip: club.vipTonight, vipCredit: club.vipCredit, ticket: club.ticketPrice(), dances: club.dances, best: club.best, attracted: club.attracted } },
      buyTicket: () => club.buyTicket(), order: (id: string) => club.order(id), vip: () => club.buyVip(),
      lookAround: () => club.lookAround()?.id ?? null,
    }
  }
}

export function installClub(game: Game) {
  const pl = new ClubPlugin(game)
  game.addPlugin(pl)
  // 酒驾：Law 读醉意（被警车 40 m 内无遮挡看到 → 罚款 / 扣分 / 1 星），Game 按醉意给转向 / 步行加漂移
  game.law.drunkLevel = () => pl.drunkLevel()
  game.law.drunkLimit = DRUNK_LIMIT
}
