import type { Ctx } from '../core/Context'
import type { RoadEdge } from '../world/RoadGraph'
import type { LawStrictness } from '../core/Settings'
import { charge } from './Wallet'
import { lineClear } from '../entities/PoliceAI'

export type CrimeKind = 'shoot' | 'carjack' | 'hitPed' | 'hitPolice' | 'wreck' | 'shootVehicle' | 'hitVehicle'
export type TrafficKind = 'speeding' | 'redLight' | 'collision' | 'hitPedTraffic'

export const DEMERIT_LIMIT = 24

/**
 * 执法松紧可调参数（设置项 lawStrictness；默认 relaxed，?law=real 接近原版）。
 * 信号簇同步、碰撞按车辆对去重、肇事方判定、簇内部边不设停止线属于 bug 修复，两档都生效。
 */
export interface LawTuning {
  /** 闯红灯扣分 */
  redLightPoints: number
  /** 越线时红灯已持续不足此秒数不罚（黄灯刚转红的容错） */
  redLightGrace: number
  /** 同一路口簇闯红灯冷却（秒） */
  redLightCooldown: number
  /** 通缉身份撞 NPC 车的热度 */
  hitVehicleHeat: number
  /** 通缉身份撞 NPC 车是否还另开碰撞罚单（罚单会把热度直接抬到 1） */
  wantedCollisionTicket: boolean
  /** 通缉身份小额事件（< 此值）不立即出警，累计热度 ≥ 1 才出警；0 = 任何事件都出警 */
  chaseMinCrime: number
  /** 非通缉身份撞警车把热度抬到 2 的冷却（秒） */
  hitPoliceCooldown: number
  /** 玩家开巴士时碰撞计罪的冲量阈值倍率（巴士重、贴一下冲量就大） */
  busImpulseMul: number
  /** 热度开始衰减前需要的无事件秒数 / 附近无警车的距离 */
  decayDelay: number
  decayPoliceDist: number
  /** 警车追撞速度（m/s） */
  ramSpeed: number
  /** 车内被警车贴住多少秒算被捕 */
  bustTime: number
}
export const LAW_TUNING: Record<LawStrictness, LawTuning> = {
  relaxed: { redLightPoints: 6, redLightGrace: 0.5, redLightCooldown: 10, hitVehicleHeat: 0.2, wantedCollisionTicket: false, chaseMinCrime: 0.5, hitPoliceCooldown: 5, busImpulseMul: 1.5, decayDelay: 8, decayPoliceDist: 50, ramSpeed: 30, bustTime: 4 },
  real:    { redLightPoints: 12, redLightGrace: 0, redLightCooldown: 0, hitVehicleHeat: 0.34, wantedCollisionTicket: true, chaseMinCrime: 0, hitPoliceCooldown: 0, busImpulseMul: 1, decayDelay: 12, decayPoliceDist: 70, ramSpeed: 34, bustTime: 2.5 },
}
export const lawTuning = (ctx: Pick<Ctx, 'settings'>): LawTuning => LAW_TUNING[ctx.settings.lawStrictness] ?? LAW_TUNING.relaxed

const TICKETS: Record<Exclude<TrafficKind, 'hitPedTraffic'>, { fine: number; points: number; label: string }> = {
  speeding: { fine: 150, points: 4, label: '超速' },
  redLight: { fine: 200, points: 12, label: '闯红灯' },   // points 实际取 LawTuning.redLightPoints
  collision: { fine: 300, points: 6, label: '碰撞' },
}
/**
 * 酒驾（新加坡：初犯罚款 S$2,000–10,000、吊销驾照；游戏里取下限）：醉意超标开车被 40 m 内、无遮挡的警车看到 →
 * 罚款 + 扣分 + 1 星（警方出动拦截）。同一次醉酒只罚一次（醒到标准以下才重置），另有 60 s 冷却。
 */
export const DRUNK_DRIVING = { fine: 2000, points: 12, spotDist: 40, minSpeed: 3, cooldown: 60 }

const CRIME_LABEL: Partial<Record<CrimeKind, string>> = { carjack: '抢车', wreck: '毁车', shoot: '开枪', shootVehicle: '开枪' }

/**
 * 执法系统（取代 Wanted）：
 * - pursuitLevel 0~5 浮点热度，floor 为星级；decayDelay 秒无事件且 decayPoliceDist 内无警车则衰减
 * - 犯罪型：通缉身份累加热度并出警（宽松档小额事件攒够 1 星才出警）；其他身份降级为交通执法
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
  /** 比赛豁免（P10.C 赛车期间由比赛插件打开）：暂停对玩家的超速 / 闯红灯 / 碰撞罚单；默认关闭 */
  trafficExempt = false
  private speedTimer = 0
  private lastSpeedTicket = -100
  private lastCollisionTicket = -100
  private lastPoliceRaise = -100
  /** 路口簇 id → 上次闯红灯罚单时刻 */
  private redLightAt = new Map<number, number>()
  private prevEdge: RoadEdge | null = null
  private prevT = 0
  private toastFn: (text: string, seconds?: number) => void = () => {}
  /** 醉意来源（P10.E 夜店插件注入 club.drunkLevel）；0 = 清醒 */
  drunkLevel: () => number = () => 0
  /** 酒驾标准（醉意单位，夜店插件注入 DRUNK_LIMIT） */
  drunkLimit = 2.5
  /** 本次醉酒已被查到（醒到标准以下才重置） */
  private drunkCaught = false
  private lastDrunkTicket = -100
  private drunkScan = 0
  /** 累计酒驾次数（调试 / 统计） */
  drunkTickets = 0

  setToast(fn: (text: string, seconds?: number) => void) { this.toastFn = fn }

  get stars() { return Math.min(5, Math.floor(this.pursuitLevel + 1e-6)) }
  /** 出警星级：罚单级别不出警 → 0 */
  get policeStars() { return this.chase ? this.stars : 0 }
  licenseSuspended(day: number) { return day < this.licenseSuspendedUntilDay }

  /** 兼容旧 Wanted.addCrime：直接累加热度（通缉逻辑）；minChase>0 时小额事件攒够 1 星才出警 */
  addCrime(amount: number, time: number, minChase = 0) {
    const before = this.stars
    this.pursuitLevel = Math.min(5, this.pursuitLevel + amount)
    this.lastCrime = time
    if (amount > 0 && (amount >= minChase || this.pursuitLevel >= 1)) this.chase = true
    if (this.stars > before) this.flash = 1
  }

  /** 犯罪型事件：按身份路由 */
  crime(kind: CrimeKind, weight: number, ctx: Ctx) {
    const tune = lawTuning(ctx)
    if (ctx.role.systems.wanted) { this.addCrime(weight, ctx.time, tune.chaseMinCrime); return }
    switch (kind) {
      case 'hitPed': this.traffic('hitPedTraffic', ctx); break
      case 'hitPolice':
        this.collision(ctx, true)
        if (ctx.time - this.lastPoliceRaise >= tune.hitPoliceCooldown) { this.lastPoliceRaise = ctx.time; this.raise(2, ctx.time) }
        break
      case 'hitVehicle': break                        // 已由 Game 走 collision()
      default: this.collision(ctx, false, CRIME_LABEL[kind])
    }
  }

  /** 撞 NPC 车：80 m 内有警车才开罚单，5 s 内不重复 */
  collision(ctx: Ctx, force = false, label?: string) {
    if (this.trafficExempt) return                  // 比赛中：碰撞罚单也豁免（撞警车的通缉热度照常在 crime() 里抬）
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
    const points = kind === 'redLight' ? lawTuning(ctx).redLightPoints : def.points
    this.fines += def.fine; this.demerits += points
    charge(ctx, def.fine, 'fine')
    this.raise(kind === 'redLight' && this.policeDist(ctx) < 80 ? 2 : 1, t)
    this.toastFn(`罚单 $${def.fine} · ${label ?? def.label} +${points} 分`, 3)
    this.checkDemerits(ctx)
  }

  private checkDemerits(ctx: Ctx) {
    if (this.demerits < DEMERIT_LIMIT) return
    this.licenseSuspendedUntilDay = ctx.clock.day + 1
    this.demerits = 0
    this.toastFn(`扣满 ${DEMERIT_LIMIT} 分，驾照吊销至第 ${this.licenseSuspendedUntilDay} 天`, 4)
  }

  /** 醉意超标（夜店插件提供） */
  get drunk() { return this.drunkLevel() >= this.drunkLimit }

  /** 醉驾查处：罚款 + 扣分 + 1 星并出警 */
  drunkDriving(ctx: Ctx) {
    const d = DRUNK_DRIVING
    this.drunkCaught = true; this.lastDrunkTicket = ctx.time; this.drunkTickets++
    this.fines += d.fine; this.demerits += d.points
    charge(ctx, d.fine, 'fine:drunk')
    this.pursuitLevel = Math.max(this.pursuitLevel, 1)
    this.lastCrime = ctx.time
    this.chase = true
    this.flash = 1
    this.toastFn(`酒驾被警察拦查！罚款 $${d.fine.toLocaleString()} · +${d.points} 分 · 通缉 1 星`, 4)
    this.checkDemerits(ctx)
  }

  /** 醉酒开车且附近警车看得见 → drunkDriving；每 0.5 s 扫一次 */
  private detectDrunk(dt: number, ctx: Ctx) {
    if (!this.drunk) { this.drunkCaught = false; return }
    const v = ctx.player.vehicle
    if (!v || v.wrecked || this.drunkCaught || this.trafficExempt) return
    if (v.absSpeed < DRUNK_DRIVING.minSpeed || ctx.time - this.lastDrunkTicket < DRUNK_DRIVING.cooldown) return
    this.drunkScan -= dt
    if (this.drunkScan > 0) return
    this.drunkScan = 0.5
    const px = ctx.player.worldX, pz = ctx.player.worldZ
    for (const p of ctx.vehicles) {
      // 出勤警车 + 路边停着的警车（路检 / 巡逻点）都算
      if (!p.active || p.kind !== 'police' || p.wrecked || (p.driver !== 'police' && p.driver !== 'none')) continue
      if (Math.hypot(p.x - px, p.z - pz) > DRUNK_DRIVING.spotDist || !lineClear(ctx, p.x, p.z, px, pz)) continue
      this.drunkDriving(ctx)
      return
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
    this.detectDrunk(dt, ctx)
    if (this.pursuitLevel <= 0) { this.chase = false; return }
    const tune = lawTuning(ctx)
    if (ctx.time - this.lastCrime < tune.decayDelay) return
    if (this.policeDist(ctx) < tune.decayPoliceDist) return
    // 每 10 秒掉一星；不满一星的热度更快清零
    this.pursuitLevel = Math.max(0, this.pursuitLevel - dt * (this.pursuitLevel < 1 ? 0.25 : 0.1))
    if (this.pursuitLevel <= 0) this.chase = false
  }

  /**
   * 玩家在车内：超速（连续 2 s 且 80 m 内有警车）与闯红灯（红灯相位越过停止线）。
   * 闯红灯只看从簇外进入路口的边（簇内部短边没有停止线）；红灯刚亮 redLightGrace 秒内越线不罚；同一路口簇冷却。
   */
  private detectTraffic(dt: number, ctx: Ctx) {
    const v = ctx.player.vehicle
    if (!v || v.wrecked || this.trafficExempt) { this.prevEdge = null; this.speedTimer = 0; return }
    const lane = ctx.graph.nearestLane(v.x, v.z, Math.sin(v.yaw), Math.cos(v.yaw))
    if (lane.dist > 8) { this.prevEdge = null; this.speedTimer = 0; return }
    const e = lane.edge
    if (Math.abs(v.speed) * 3.6 > e.speedLimit + 10) this.speedTimer += dt; else this.speedTimer = 0
    if (this.speedTimer >= 2 && ctx.time - this.lastSpeedTicket > 30 && this.policeDist(ctx) < 80) {
      this.lastSpeedTicket = ctx.time; this.speedTimer = 0
      this.traffic('speeding', ctx)
    }
    const stop = e.length - e.to.jr
    const sig = ctx.signals
    if (e === this.prevEdge && e.to.signal && this.prevT < stop && lane.t >= stop && !sig.isInternalEdge(e) && sig.phaseFor(e) === 'red') {
      const tune = lawTuning(ctx)
      const cluster = sig.clusterOf(e.to.id)
      const last = this.redLightAt.get(cluster) ?? -Infinity
      if (sig.redElapsed(e) >= tune.redLightGrace && ctx.time - last >= tune.redLightCooldown) {
        this.redLightAt.set(cluster, ctx.time)
        this.traffic('redLight', ctx)
      }
    }
    this.prevEdge = e; this.prevT = lane.t
  }
}
