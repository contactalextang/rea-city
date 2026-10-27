import { roll } from '../../../physics/ArcadeFlight'
import type { AutopilotTarget } from '../Autopilot'
import { t } from '../../../i18n'
import { FlightMission, DEG, hdist, fmtM, safeAlt, type FlyState, type MissionHost, type NavPoint } from './Mission'
import { FLIGHT_PAY } from './params'

/**
 * 金领 gold_air_charter 商务包机：老板要看自己的楼盘 ——
 * 1–2. 低空（< 200 m）掠过 2 个商务区目标（水平 150 m 内）；
 * 3. 在金沙空中花园高度（200 ± 40 m）平飞（|升降率| < 3 m/s、坡度 < 20°）经过金沙（离三塔中心 350 m 内，别撞楼）；
 * 然后平稳降落。报酬 $1,200 × 落地倍率 × 涂装 payMul（VIP 金色涂装 +20%，由 FlightJobs 乘）。
 */
export interface CharterTargetDef { name: string; x: number; z: number }
/** 商务区目标（掠过点选在高楼之间 / 水边空旷处，见汇报的高度图核对） */
// 顺序：机场 → 滨海湾金融中心 → 莱佛士坊 → 金沙南侧 → 27 号跑道进近，各段直线高度图核对无 > 0 m 障碍
export const CHARTER_TARGETS: CharterTargetDef[] = [
  { name: t('滨海湾金融中心'), x: 1120, z: 220 },
  { name: t('莱佛士坊 · 海湾一侧'), x: 760, z: -330 },
]
/** 金沙三塔中心 */
export const MBS_CENTER = { x: 1565, z: -120 }
const LOW = 200, PASS_R = 150
const SKY = { y: 200, tol: 40, r: 350, vs: 3, bank: 20 * DEG }
/** 调试自动驾驶掠过金沙的点（三塔南侧，离塔中心约 270 m；之后往东南去 27 号跑道不擦塔） */
const MBS_PASS = { x: 1560, z: 150 }

interface Step { name: string; x: number; z: number; kind: 'low' | 'sky'; done: boolean }

export class CharterMission extends FlightMission {
  readonly kind = 'charter' as const
  readonly steps: Step[]
  private idx = 0
  private why = ''

  constructor(host: MissionHost, defs: CharterTargetDef[]) {
    super(host)
    this.steps = [
      ...defs.map((d) => ({ ...d, kind: 'low' as const, done: false })),
      { name: t('金沙空中花园'), x: MBS_CENTER.x, z: MBS_CENTER.z, kind: 'sky' as const, done: false },
    ]
    this.focus()
  }
  private get cur(): Step | null { return this.steps[this.idx] ?? null }
  private focus() { const c = this.cur; this.host.visuals.setMarker(c && c.kind === 'low' ? { x: c.x, z: c.z } : null) }

  update(s: FlyState) {
    const c = this.cur
    if (!c || this.done || !s.airborne) { this.why = ''; return }
    const b = s.b, d = hdist(b.x, b.z, c.x, c.z)
    let ok = false
    if (c.kind === 'low') {
      ok = d <= PASS_R && b.y < LOW
      this.why = d <= PASS_R && b.y >= LOW ? t('太高了：要低于 {n} m', { n: LOW }) : ''
    } else {
      const inAlt = Math.abs(b.y - SKY.y) <= SKY.tol, level = Math.abs(b.vy) < SKY.vs && Math.abs(roll(b)) < SKY.bank
      ok = d <= SKY.r && inAlt && level
      this.why = d <= SKY.r ? (!inAlt ? t('高度要在 {a}–{b} m', { a: SKY.y - SKY.tol, b: SKY.y + SKY.tol }) : !level ? t('保持平飞（别爬升 / 下降 / 压坡度）') : '') : ''
    }
    if (!ok) return
    c.done = true
    this.idx++
    if (this.idx >= this.steps.length) { this.done = true; this.host.toast(t('老板很满意 · 返回机场，平稳降落'), 3) }
    else this.host.toast(t('掠过「{name}」 {a}/{b}', { name: c.name, a: this.idx, b: this.steps.length }), 2)
    this.focus()
  }

  target(): NavPoint | null { const c = this.cur; return c && !this.done ? { x: c.x, z: c.z } : null }
  path(): NavPoint[] { return this.steps.slice(this.idx).map((c) => ({ x: c.x, z: c.z })) }
  progress() { return `${this.idx}/${this.steps.length}` }

  desc(s: FlyState | null): string {
    const c = this.cur
    if (!c || this.done) return t('客户已就座 · 平稳降落')
    const d = s ? ` · ${fmtM(hdist(s.b.x, s.b.z, c.x, c.z))}` : ''
    const req = c.kind === 'low' ? t('低于 {n} m 掠过', { n: LOW }) : t('{a}–{b} m 平飞经过', { a: SKY.y - SKY.tol, b: SKY.y + SKY.tol })
    return t('包机 {a}/{b}：{name}（{req}）', { a: this.idx + 1, b: this.steps.length, name: c.name, req }) + d + (this.why ? ` · ${this.why}` : '')
  }
  hint() { return t('商务区低空掠过、金沙空中花园高度平飞，最后平稳落地（落地评级影响报酬）') }

  payout() { return { amount: FLIGHT_PAY.charter.base, detail: t('包机 ${n}', { n: FLIGHT_PAY.charter.base.toLocaleString() }) } }

  auto(s: FlyState): AutopilotTarget {
    const c = this.cur!
    if (c.kind === 'sky') {
      const d = hdist(s.b.x, s.b.z, MBS_PASS.x, MBS_PASS.z)
      return { to: { x: MBS_PASS.x, z: MBS_PASS.z }, alt: d < 1500 ? SKY.y : safeAlt(this.host, s.b.x, s.b.z, MBS_PASS.x, MBS_PASS.z, SKY.y), spd: 45 }
    }
    const d = hdist(s.b.x, s.b.z, c.x, c.z)
    const low = Math.max(110, this.host.hf(c.x, c.z, 120) + 40)
    return { to: { x: c.x, z: c.z }, alt: d < 900 ? Math.min(low, 185) : safeAlt(this.host, s.b.x, s.b.z, c.x, c.z, Math.min(low, 185)), spd: 45 }
  }

  debug() { return { idx: this.idx, why: this.why, steps: this.steps.map((c) => ({ name: c.name, kind: c.kind, x: c.x, z: c.z, done: c.done })) } }
}
