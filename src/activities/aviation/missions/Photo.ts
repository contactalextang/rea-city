import { heading } from '../../../physics/ArcadeFlight'
import type { AutopilotTarget } from '../Autopilot'
import { t } from '../../../i18n'
import { FlightMission, DEG, clamp, hdist, bearing, wrapAngle, fmtM, safeAlt, type FlyState, type MissionHost, type NavPoint } from './Mission'
import { FLIGHT_PAY } from './params'

/**
 * 白领 white_air_photo 航拍：3 栋指定楼（办公楼 / 地标 POI），在 150–400 m 距离、100–350 m 高度带内，
 * 目标在机头 15° 视锥内（水平方位；俯角 ≤ 55°）按 Space 拍照；横滚 / 俯仰角速度越小照片越清晰，清晰度 ≥ 40% 算合格。
 * 每张合格照片 $250；3 栋都拍到（合格）后回跑道落地结算。
 */
export interface PhotoTargetDef { id: string; name: string; x: number; z: number }
const DIST = [150, 400] as const
const ALT = [100, 350] as const
const CONE = 15 * DEG
const MAX_DEPRESSION = 55 * DEG
const MIN_SHARP = 0.4
/** 清晰度 = 1 − 角速度 / SHAKE（rad/s；横滚为主，俯仰 / 偏航各半权） */
const SHAKE = 0.5

interface Target extends PhotoTargetDef { top: number; shot: number | null }

export class PhotoMission extends FlightMission {
  readonly kind = 'photo' as const
  readonly targets: Target[]
  private idx = 0
  private lastCheck: { ok: boolean; why: string } = { ok: false, why: '' }
  shots = 0

  constructor(host: MissionHost, defs: PhotoTargetDef[]) {
    super(host)
    this.targets = defs.map((d) => ({ ...d, top: host.hf(d.x, d.z, 60), shot: null }))
    this.focus()
  }

  private get cur(): Target | null { return this.targets[this.idx] ?? null }
  private focus() {
    const c = this.cur
    this.host.visuals.setMarker(c && !this.done ? { x: c.x, z: c.z, y: c.top } : null)
  }
  /** 瞄准点：楼高 60% 处（至少 20 m） */
  private aimY(c: Target) { return Math.max(20, c.top * 0.6) }

  /** 此刻能否拍到当前目标（返回原因） */
  check(s: FlyState): { ok: boolean; why: string; d: number; err: number } {
    const c = this.cur
    if (!c) return { ok: false, why: '', d: 0, err: 0 }
    const b = s.b
    const d = hdist(b.x, b.z, c.x, c.z)
    const err = Math.abs(wrapAngle(bearing(b.x, b.z, c.x, c.z) - heading(b)))
    const dep = Math.atan2(b.y - this.aimY(c), Math.max(1, d))
    let why = ''
    if (!s.airborne) why = t('先起飞')
    else if (d < DIST[0]) why = t('太近了（{d}，要 {a}–{b} m）', { d: fmtM(d), a: DIST[0], b: DIST[1] })
    else if (d > DIST[1]) why = t('太远了（{d}，要 {a}–{b} m）', { d: fmtM(d), a: DIST[0], b: DIST[1] })
    else if (b.y < ALT[0] || b.y > ALT[1]) why = t('高度 {h} m 不在 {a}–{b} m', { h: Math.round(b.y), a: ALT[0], b: ALT[1] })
    else if (err > CONE) why = t('机头对准目标（偏 {n}°，要 ≤ 15°）', { n: Math.round(err / DEG) })
    else if (dep > MAX_DEPRESSION) why = t('俯角太大，拉远一点')
    return { ok: !why, why, d, err }
  }
  /** 清晰度 0–1 */
  sharpness(s: FlyState) { const b = s.b; return clamp(1 - Math.hypot(b.wr, b.wp * 0.5, b.wy * 0.5) / SHAKE, 0, 1) }

  update(s: FlyState) { this.lastCheck = this.check(s) }

  action(s: FlyState): boolean {
    const c = this.cur
    if (!c || this.done) return false
    const k = this.check(s)
    if (!k.ok) { this.host.toast(t('拍不到「{name}」：{why}', { name: c.name, why: k.why }), 2); return true }
    const sh = this.sharpness(s)
    if (sh < MIN_SHARP) { this.host.toast(t('照片糊了（清晰度 {n}%）· 稳住再拍', { n: Math.round(sh * 100) }), 2); return true }
    c.shot = sh; this.shots++
    this.idx++
    if (this.idx >= this.targets.length) { this.done = true; this.host.toast(t('拍完收工 · 返回机场，跑道落地停稳结算'), 3) }
    else this.host.toast(t('咔嚓！「{name}」清晰度 {n}% · {a}/{b}', { name: c.name, n: Math.round(sh * 100), a: this.idx, b: this.targets.length }), 2.5)
    this.focus()
    return true
  }

  target(): NavPoint | null { const c = this.cur; return c && !this.done ? { x: c.x, z: c.z } : null }
  path(): NavPoint[] { return this.targets.slice(this.idx).map((c) => ({ x: c.x, z: c.z })) }
  progress() { return `${this.idx}/${this.targets.length}` }

  desc(s: FlyState | null): string {
    const c = this.cur
    if (!c || this.done) return t('照片 {n} 张', { n: this.shots })
    const k = s ? this.lastCheck : null
    const st = k ? (k.ok ? t('可以拍！按 Space') : k.why) : ''
    return t('航拍 {a}/{b}：{name}', { a: this.idx + 1, b: this.targets.length, name: c.name }) + (s ? ` · ${fmtM(hdist(s.b.x, s.b.z, c.x, c.z))}` : '') + (st ? ` · ${st}` : '')
  }
  hint() { return t('距离 150–400 m、高度 100–350 m、机头对准目标按 Space 拍照；横滚越稳越清晰') }

  payout() {
    const n = this.targets.filter((c) => c.shot !== null).length
    return { amount: n * FLIGHT_PAY.photo.perShot, detail: t('合格照片 {n} 张 × ${p}', { n, p: FLIGHT_PAY.photo.perShot }) }
  }

  auto(s: FlyState): AutopilotTarget {
    const c = this.cur!
    // 航线安全高度（含目标楼顶 + 50 m），限在拍摄高度带内；太近（< 150 m）就飞过去再绕回
    const alt = clamp(safeAlt(this.host, s.b.x, s.b.z, c.x, c.z, clamp(c.top + 60, 140, 300), 50, 100), ALT[0] + 20, ALT[1] - 10)
    return { to: { x: c.x, z: c.z }, alt, spd: 45 }
  }
  autoAction(s: FlyState) { return this.check(s).ok && this.sharpness(s) >= 0.7 }

  debug() { return { idx: this.idx, shots: this.shots, check: this.lastCheck, targets: this.targets.map((c) => ({ id: c.id, name: c.name, x: c.x, z: c.z, top: Math.round(c.top), shot: c.shot === null ? null : +c.shot.toFixed(2) })) } }
}
