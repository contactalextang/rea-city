import type * as THREE from 'three'
import type { AutopilotTarget } from '../Autopilot'
import { t } from '../../../i18n'
import { FlightMission, hdist, fmtM, safeAlt, type FlyState, type MissionHost, type NavPoint } from './Mission'
import { FLIGHT_PAY } from './params'

/**
 * 黑帮 gang_air_drop 空投：3 个包裹依次投到 楼顶 / 公园 / 海上接应船，Space 投放。
 * 包裹初速 = 飞机速度，简单弹道（重力 + 线性阻力），落到高度图（楼顶）或地面 / 海面即判定：离目标 ≤ 25 m 命中，每个 $400。
 * 每个目标只有一个包裹，投偏也换下一个目标；3 个都落地后回跑道结算。
 */
export interface DropTargetDef { kind: 'roof' | 'park' | 'boat'; name: string; x: number; z: number }
const G = 9.8
/** 线性阻力系数（1/s） */
const DRAG = 0.06
const SIM_DT = 1 / 30

interface Target extends DropTargetDef { y: number; result: number | null }
interface Crate { mesh: THREE.Mesh; x: number; y: number; z: number; vx: number; vy: number; vz: number; target: number; t: number }

/** 弹道积分一步 */
function stepCrate(c: { x: number; y: number; z: number; vx: number; vy: number; vz: number }, dt: number) {
  const k = Math.exp(-DRAG * dt)
  c.vx *= k; c.vz *= k; c.vy = c.vy * k - G * dt
  c.x += c.vx * dt; c.y += c.vy * dt; c.z += c.vz * dt
}

/** 楼顶目标：POI 坐标多在门口街边 → 在 70 m 内找高度图最高点作为落点（楼顶中央附近） */
function roofOf(host: MissionHost, d: DropTargetDef): DropTargetDef & { y: number } {
  let best = { x: d.x, z: d.z, y: host.hf(d.x, d.z) }
  for (let dx = -70; dx <= 70; dx += 7) for (let dz = -70; dz <= 70; dz += 7) {
    if (dx * dx + dz * dz > 70 * 70) continue
    const y = host.hf(d.x + dx, d.z + dz)
    if (y > best.y + 0.5) best = { x: d.x + dx, z: d.z + dz, y }
  }
  return { ...d, ...best }
}

export class DropMission extends FlightMission {
  readonly kind = 'drop' as const
  readonly targets: Target[]
  private idx = 0
  private crates: Crate[] = []
  /** 已投出（含在空中）的包裹数 */
  dropped = 0
  hits = 0

  constructor(host: MissionHost, defs: DropTargetDef[]) {
    super(host)
    this.targets = defs.map((d) => (d.kind === 'roof' ? { ...roofOf(host, d), result: null } : { ...d, y: 0, result: null }))
    for (const d of this.targets) if (d.kind === 'boat') host.visuals.addBoat(d.x, d.z, 0.6)
    this.focus()
  }

  private get cur(): Target | null { return this.targets[this.idx] ?? null }
  private focus() { const c = this.cur; this.host.visuals.setMarker(c ? { x: c.x, z: c.z, y: c.y } : null) }
  private ground(x: number, z: number) { return Math.max(0, this.host.hf(x, z)) }

  /** 预测从当前飞机状态投放的落点 */
  predict(s: FlyState) {
    const c = { x: s.b.x, y: s.b.y - 1.5, z: s.b.z, vx: s.b.vx, vy: s.b.vy, vz: s.b.vz }
    for (let i = 0; i < 30 * 40; i++) {
      stepCrate(c, SIM_DT)
      if (c.y <= this.ground(c.x, c.z)) break
    }
    return { x: c.x, z: c.z }
  }

  update(s: FlyState) {
    for (const c of [...this.crates]) {
      stepCrate(c, s.dt); c.t += s.dt
      c.mesh.position.set(c.x, c.y, c.z)
      c.mesh.rotation.x += s.dt * 2; c.mesh.rotation.y += s.dt * 1.3
      const gy = this.ground(c.x, c.z)
      if (c.y > gy && c.t < 60) continue
      // 落地判定
      c.y = gy; c.mesh.position.y = gy + 0.6
      this.crates.splice(this.crates.indexOf(c), 1)
      const tg = this.targets[c.target]
      const miss = hdist(c.x, c.z, tg.x, tg.z)
      tg.result = miss
      if (miss <= FLIGHT_PAY.drop.hitRadius) { this.hits++; this.host.toast(t('命中「{name}」！偏差 {d}', { name: tg.name, d: fmtM(miss) }), 2.5) }
      else this.host.toast(t('偏了 {d}（要 ≤ {r} m）', { d: fmtM(miss), r: FLIGHT_PAY.drop.hitRadius }), 2.5)
      if (this.dropped >= this.targets.length && !this.crates.length) { this.done = true; this.host.toast(t('货都送到了 · 返回机场，跑道落地停稳结算'), 3) }
    }
  }

  action(s: FlyState): boolean {
    const c = this.cur
    if (!c || this.dropped >= this.targets.length) return false
    if (!s.airborne) { this.host.toast(t('先起飞'), 1.5); return true }
    const mesh = this.host.visuals.addCrate()
    const cr: Crate = { mesh, x: s.b.x, y: s.b.y - 1.5, z: s.b.z, vx: s.b.vx, vy: s.b.vy, vz: s.b.vz, target: this.idx, t: 0 }
    mesh.position.set(cr.x, cr.y, cr.z)
    this.crates.push(cr)
    this.dropped++
    this.idx++
    this.focus()
    this.host.toast(t('包裹投出 {a}/{b}', { a: this.dropped, b: this.targets.length }), 1.5)
    return true
  }

  target(): NavPoint | null { const c = this.cur; return c ? { x: c.x, z: c.z } : null }
  path(): NavPoint[] { return this.targets.slice(this.idx).map((c) => ({ x: c.x, z: c.z })) }
  progress() { return `${this.dropped}/${this.targets.length}` }

  desc(s: FlyState | null): string {
    const c = this.cur
    if (!c) return this.done ? t('命中 {h}/{n}', { h: this.hits, n: this.targets.length }) : t('包裹下落中…')
    const KIND = { roof: t('楼顶'), park: t('公园'), boat: t('接应船') }
    let tail = ''
    if (s && s.airborne) { const p = this.predict(s); tail = ` · ${t('预计落点偏 {d}', { d: fmtM(hdist(p.x, p.z, c.x, c.z)) })}` }
    return t('空投 {a}/{b}：{kind}「{name}」', { a: this.idx + 1, b: this.targets.length, kind: KIND[c.kind], name: c.name }) + (s ? ` · ${fmtM(hdist(s.b.x, s.b.z, c.x, c.z))}` : '') + tail + ` · ${t('命中 {h}', { h: this.hits })}`
  }
  hint() { return t('Space 投放包裹：包裹带着飞机的速度往前飞，要提前投；落点 25 m 内算命中') }

  payout() { return { amount: this.hits * FLIGHT_PAY.drop.perHit, detail: t('命中 {h} 个 × ${p}', { h: this.hits, p: FLIGHT_PAY.drop.perHit }) } }

  auto(s: FlyState): AutopilotTarget {
    const c = this.cur
    if (!c) return { hdg: Math.atan2(s.b.vx, s.b.vz), alt: 150, spd: 45 }
    const alt = safeAlt(this.host, s.b.x, s.b.z, c.x, c.z, Math.max(c.y + 90, 160), 50, 120)
    return { to: { x: c.x, z: c.z }, alt, spd: 42 }
  }
  /** 预测落点越过目标（沿航向的距离 ≤ 0）且横向偏差小 → 投 */
  autoAction(s: FlyState) {
    const c = this.cur
    if (!c || !s.airborne) return false
    const p = this.predict(s)
    const V = Math.hypot(s.b.vx, s.b.vz) || 1
    const along = ((c.x - p.x) * s.b.vx + (c.z - p.z) * s.b.vz) / V
    return along <= 4 && hdist(p.x, p.z, c.x, c.z) < 40
  }

  dispose() { this.crates = []; super.dispose() }

  debug() { return { idx: this.idx, dropped: this.dropped, hits: this.hits, inAir: this.crates.length, targets: this.targets.map((c) => ({ kind: c.kind, name: c.name, x: c.x, z: c.z, y: Math.round(c.y), miss: c.result === null ? null : +c.result.toFixed(1) })) } }
}
