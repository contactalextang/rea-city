import type { Ctx } from '../core/Context'
import type { RoadEdge } from '../world/RoadGraph'

export type CrimeKind = 'shoot' | 'carjack' | 'hitPed' | 'hitPolice' | 'wreck' | 'shootVehicle' | 'hitVehicle'
export type TrafficKind = 'speeding' | 'redLight' | 'collision' | 'hitPedTraffic'

export const DEMERIT_LIMIT = 24
const TICKETS: Record<Exclude<TrafficKind, 'hitPedTraffic'>, { fine: number; points: number; label: string }> = {
  speeding: { fine: 150, points: 4, label: '超速' },
  redLight: { fine: 200, points: 12, label: '闯红灯' },
  collision: { fine: 300, points: 6, label: '碰撞' },
}
const CRIME_LABEL: Partial<Record<CrimeKind, string>> = { carjack: '抢车', wreck: '毁车', shoot: '开枪', shootVehicle: '开枪' }

/**
 * 执法系统（取代 Wanted）：
 * - pursuitLevel 0~5 浮点热度，floor 为星级；12 s 无事件且 70 m 无警车则衰减
 * - 犯罪型：通缉身份累加热度并出警；其他身份降级为交通执法
 * - 交通型：罚单（扣钱 + 扣分）并把热度抬到 1；≥2 才出警（chase）
 */
export class Law {
  pursuitLevel = 0
  lastCrime = -100
  flash = 0
  chase = false                 // 警方是否出动；只开罚单时为 false
  demerits = 0
  fines = 0
  arrests = 0
  licenseSuspendedUntilDay = -1
  private speedTimer = 0
  private lastSpeedTicket = -100
  private lastCollisionTicket = -100
  private prevEdge: RoadEdge | null = null
  private prevT = 0
  private toastFn: (text: string, seconds?: number) => void = () => {}

  setToast(fn: (text: string, seconds?: number) => void) { this.toastFn = fn }

  get stars() { return Math.min(5, Math.floor(this.pursuitLevel + 1e-6)) }
  /** 出警星级：罚单级别不出警 → 0 */
  get policeStars() { return this.chase ? this.stars : 0 }
  licenseSuspended(day: number) { return day < this.licenseSuspendedUntilDay }

  /** 兼容旧 Wanted.addCrime：直接累加热度（通缉逻辑） */
  addCrime(amount: number, time: number) {
    const before = this.stars
    this.pursuitLevel = Math.min(5, this.pursuitLevel + amount)
    this.lastCrime = time
    if (amount > 0) this.chase = true
    if (this.stars > before) this.flash = 1
  }

  /** 犯罪型事件：按身份路由 */
  crime(kind: CrimeKind, weight: number, ctx: Ctx) {
    if (ctx.role.systems.wanted) { this.addCrime(weight, ctx.time); return }
    switch (kind) {
      case 'hitPed': this.traffic('hitPedTraffic', ctx); break
      case 'hitPolice': this.collision(ctx, true); this.raise(2, ctx.time); break
      case 'hitVehicle': break                        // 已由 Game 走 collision()
      default: this.collision(ctx, false, CRIME_LABEL[kind])
    }
  }

  /** 撞 NPC 车：80 m 内有警车才开罚单，5 s 内不重复 */
  collision(ctx: Ctx, force = false, label?: string) {
    if (ctx.time - this.lastCollisionTicket < 5) return
    if (!force && this.policeDist(ctx) >= 80) return
    this.lastCollisionTicket = ctx.time
    this.traffic('collision', ctx, label)
  }

  /** 交通型事件（被抓到即生效） */
  traffic(kind: TrafficKind, ctx: Ctx, label?: string) {
    const t = ctx.time
    if (kind === 'hitPedTraffic') {
      this.raise(2, t)
      this.toastFn('撞人了！警方出动', 3)
      return
    }
    const def = TICKETS[kind]
    this.fines += def.fine; this.demerits += def.points
    ctx.player.money -= def.fine
    this.raise(kind === 'redLight' && this.policeDist(ctx) < 80 ? 2 : 1, t)
    this.toastFn(`罚单 $${def.fine} · ${label ?? def.label} +${def.points} 分`, 3)
    if (this.demerits >= DEMERIT_LIMIT) {
      this.licenseSuspendedUntilDay = ctx.clock.day + 1
      this.demerits = 0
      this.toastFn(`扣满 ${DEMERIT_LIMIT} 分，驾照吊销至第 ${this.licenseSuspendedUntilDay} 天`, 4)
    }
  }

  private raise(level: number, t: number) {
    const before = this.stars
    this.pursuitLevel = Math.max(this.pursuitLevel, Math.min(5, level))
    this.lastCrime = t
    if (level >= 2) this.chase = true
    if (this.stars > before) this.flash = 1
  }

  policeDist(ctx: Ctx) {
    let nearest = Infinity
    const px = ctx.player.worldX, pz = ctx.player.worldZ
    for (const v of ctx.vehicles) {
      if (!v.active || v.driver !== 'police' || v.wrecked) continue
      nearest = Math.min(nearest, Math.hypot(v.x - px, v.z - pz))
    }
    return nearest
  }

  reset() { this.pursuitLevel = 0; this.lastCrime = -100; this.chase = false; this.speedTimer = 0; this.prevEdge = null }

  update(dt: number, ctx: Ctx) {
    this.flash = Math.max(0, this.flash - dt)
    this.detectTraffic(dt, ctx)
    if (this.pursuitLevel <= 0) { this.chase = false; return }
    if (ctx.time - this.lastCrime < 12) return
    if (this.policeDist(ctx) < 70) return
    // 每 10 秒掉一星；不满一星的热度更快清零
    this.pursuitLevel = Math.max(0, this.pursuitLevel - dt * (this.pursuitLevel < 1 ? 0.25 : 0.1))
    if (this.pursuitLevel <= 0) this.chase = false
  }

  /** 玩家在车内：超速（连续 2 s 且 80 m 内有警车）与闯红灯（红灯相位越过停止线） */
  private detectTraffic(dt: number, ctx: Ctx) {
    const v = ctx.player.vehicle
    if (!v || v.wrecked) { this.prevEdge = null; this.speedTimer = 0; return }
    const lane = ctx.graph.nearestLane(v.x, v.z, Math.sin(v.yaw), Math.cos(v.yaw))
    if (lane.dist > 8) { this.prevEdge = null; this.speedTimer = 0; return }
    const e = lane.edge
    if (Math.abs(v.speed) * 3.6 > e.speedLimit + 10) this.speedTimer += dt; else this.speedTimer = 0
    if (this.speedTimer >= 2 && ctx.time - this.lastSpeedTicket > 30 && this.policeDist(ctx) < 80) {
      this.lastSpeedTicket = ctx.time; this.speedTimer = 0
      this.traffic('speeding', ctx)
    }
    const stop = e.length - e.to.jr
    if (e === this.prevEdge && e.to.signal && this.prevT < stop && lane.t >= stop && ctx.signals.phaseFor(e) === 'red') this.traffic('redLight', ctx)
    this.prevEdge = e; this.prevT = lane.t
  }
}
