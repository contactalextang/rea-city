import { roll } from '../../../physics/ArcadeFlight'
import type { AutopilotTarget } from '../Autopilot'
import { t } from '../../../i18n'
import { FlightMission, DEG, clamp, hdist, fmtM, pickOrdered, safeAlt, type FlyState, type MissionHost, type NavPoint } from './Mission'
import { FLIGHT_PAY } from './params'

/**
 * 蓝领 blue_air_tour 观光载客：2–4 名游客，150–350 m 依次穿过 3 个地标门（从 4 个候选里按环线顺序挑 3 个），
 * 舒适度 100 起扣：过载 > 1.8 g、坡度 > 45°、失速；报酬 = $450 + 舒适奖励（≤ $250，按舒适度）+ 时间奖励（≤ $100，par 内满额）。
 * 门：圆环半径 40 m，穿过门平面时离圆心 ≤ 45 m 算通过（离圆心 30 m 内也直接算）。
 */
export interface GateDef { name: string; x: number; z: number; y: number }
/** 候选地标门（环线顺序：达士岭 → 鱼尾狮 → 摩天轮 → 金沙；高度避开周边高楼，见汇报的高度图核对） */
export const TOUR_GATES: GateDef[] = [
  // 达士岭 → 鱼尾狮之间要飞过 CBD（高度图最高约 242 m），两门放高
  { name: t('达士岭组屋'), x: -470, z: 560, y: 300 },
  { name: t('鱼尾狮 · 浮尔顿'), x: 960, z: -430, y: 290 },
  { name: t('新加坡摩天轮'), x: 1690, z: -640, y: 230 },
  // 金沙三塔东南侧（三塔顶约 200 m；放在西侧的话回机场的直线会擦过塔顶）
  { name: t('金沙酒店'), x: 1700, z: 80, y: 250 },
]
const PASS_R = 45, NEAR_R = 30
/** 舒适度扣分速率（/s）与失速一次性扣分 */
const COMFORT = { gLimit: 1.8, gRate: 25, bankLimit: 45 * DEG, bankRate: 15, stallHit: 10, stallRate: 8 }
/** 门间平均速度假设（par 时间用）m/s，外加起降 150 s */
const PAR_SPEED = 45, PAR_EXTRA = 150
const START = { x: 1500, z: 1980 }

interface Gate extends GateDef { nx: number; nz: number; passed: boolean; ring: number }

export class TourMission extends FlightMission {
  readonly kind = 'tour' as const
  readonly passengers: number
  readonly gates: Gate[]
  private idx = 0
  comfort = 100
  private prev: { vx: number; vy: number; vz: number } | null = null
  private g = 1
  private gMax = 1
  private wasStalled = false
  private lastSide: number | null = null
  readonly par: number

  constructor(host: MissionHost) {
    super(host)
    const [a, b] = FLIGHT_PAY.tour.passengers
    this.passengers = a + Math.floor(host.rand() * (b - a + 1))
    const defs = pickOrdered(TOUR_GATES, FLIGHT_PAY.tour.gates, host.rand)
    let px = START.x, pz = START.z, len = 0
    this.gates = defs.map((d) => {
      const L = hdist(px, pz, d.x, d.z) || 1
      const g: Gate = { ...d, nx: (d.x - px) / L, nz: (d.z - pz) / L, passed: false, ring: 0 }
      g.ring = host.visuals.addRing(d.x, d.y, d.z, g.nx, g.nz)
      len += L; px = d.x; pz = d.z
      return g
    })
    len += hdist(px, pz, START.x, START.z)
    this.par = len / PAR_SPEED + PAR_EXTRA
    host.visuals.focusRing(0)
  }

  private get gate(): Gate | null { return this.gates[this.idx] ?? null }

  update(s: FlyState) {
    const b = s.b
    if (s.airborne) {
      // 过载：|dv/dt + g·ŷ| / g（平滑），坡度、失速
      if (this.prev && s.dt > 0) {
        const ax = (b.vx - this.prev.vx) / s.dt, ay = (b.vy - this.prev.vy) / s.dt + 9.8, az = (b.vz - this.prev.vz) / s.dt
        const n = Math.hypot(ax, ay, az) / 9.8
        this.g += (n - this.g) * clamp(s.dt * 6, 0, 1)
        this.gMax = Math.max(this.gMax, this.g)
      }
      let hit = 0
      if (this.g > COMFORT.gLimit) hit += COMFORT.gRate * s.dt
      if (Math.abs(roll(b)) > COMFORT.bankLimit) hit += COMFORT.bankRate * s.dt
      if (b.stalled) hit += COMFORT.stallRate * s.dt + (this.wasStalled ? 0 : COMFORT.stallHit)
      this.wasStalled = b.stalled
      if (hit > 0) this.comfort = Math.max(0, this.comfort - hit)
    }
    this.prev = { vx: b.vx, vy: b.vy, vz: b.vz }
    const g = this.gate
    if (!g || this.done) return
    // 穿门：门平面带符号距离由负变正，且离圆心 ≤ PASS_R；或直接离圆心 NEAR_R 内
    const side = (b.x - g.x) * g.nx + (b.z - g.z) * g.nz
    const d3 = Math.hypot(b.x - g.x, b.y - g.y, b.z - g.z)
    const crossed = this.lastSide !== null && this.lastSide < 0 && side >= 0 && d3 <= PASS_R
    this.lastSide = side
    if (crossed || d3 <= NEAR_R) {
      g.passed = true
      this.idx++
      this.lastSide = null
      this.host.visuals.focusRing(this.idx)
      if (this.idx >= this.gates.length) { this.done = true; this.host.toast(t('游客拍够了照片 · 返回机场，跑道落地停稳结算'), 3) }
      else this.host.toast(t('穿过「{name}」 {a}/{b}', { name: g.name, a: this.idx, b: this.gates.length }), 2)
    }
  }

  target(): NavPoint | null { const g = this.gate; return g && !this.done ? { x: g.x, z: g.z, y: g.y } : null }
  path(): NavPoint[] { return this.gates.slice(this.idx).map((g) => ({ x: g.x, z: g.z })) }
  progress() { return `${this.idx}/${this.gates.length}` }

  desc(s: FlyState | null): string {
    const g = this.gate
    const base = t('{n} 名游客 · 舒适 {c}', { n: this.passengers, c: Math.round(this.comfort) })
    if (!g || this.done) return base
    const d = s ? fmtM(Math.hypot(s.b.x - g.x, s.b.z - g.z)) : '—'
    return t('穿门 {a}/{b}：{name} · {d} · 门高 {y} m', { a: this.idx + 1, b: this.gates.length, name: g.name, d, y: g.y }) + ' · ' + base
  }
  hint() { return t('平稳飞行：过载 > 1.8 g、坡度 > 45°、失速都会扣舒适度') }

  payout(time: number) {
    const P = FLIGHT_PAY.tour
    const comfortBonus = Math.round(P.comfortMax * this.comfort / 100)
    const el = time - this.startedAt
    const timeBonus = Math.round(P.timeMax * clamp((2 * this.par - el) / this.par, 0, 1))
    return { amount: P.base + comfortBonus + timeBonus, detail: t('基础 ${b} + 舒适 ${c}（{p}） + 准时 ${tm}', { b: P.base, c: comfortBonus, p: Math.round(this.comfort), tm: timeBonus }) }
  }

  auto(s: FlyState): AutopilotTarget {
    const g = this.gate!
    // 门前 600 m 内对准门高；更远按航线安全高度
    const d = hdist(s.b.x, s.b.z, g.x, g.z)
    const alt = d < 600 ? g.y : safeAlt(this.host, s.b.x, s.b.z, g.x, g.z, g.y)
    // 瞄门后方一点，保证从正面穿过
    return { to: { x: g.x + g.nx * 200, z: g.z + g.nz * 200 }, alt, spd: 48 }
  }

  debug() {
    return { passengers: this.passengers, idx: this.idx, comfort: +this.comfort.toFixed(1), g: +this.g.toFixed(2), gMax: +this.gMax.toFixed(2), par: Math.round(this.par), gates: this.gates.map((g) => ({ name: g.name, x: g.x, z: g.z, y: g.y, passed: g.passed })) }
  }
}
