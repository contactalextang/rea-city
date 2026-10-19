import * as THREE from 'three'
import { FIXED_DT, PITCH, HALF, DRIVE_SIDE } from '../config'
import { Input } from './Input'
import { ChaseCamera } from './Camera'
import { EventBus, type Ctx } from './Context'
import { RoadGraph, type P2 } from '../world/RoadGraph'
import { buildGridGraphData } from '../world/GridGraph'
import { loadSettings, type Settings } from './Settings'
import { StaticWorld, type AABB } from '../world/Colliders'
import { CityGenerator } from '../world/CityGenerator'
import { circleAABB, circleCircle, pushOut } from '../physics/Collision'
import { Player } from '../entities/Player'
import { Vehicle } from '../entities/Vehicle'
import { Pedestrians } from '../entities/Pedestrians'
import { TrafficAI, releaseToken } from '../entities/TrafficAI'
import { PoliceAI } from '../entities/PoliceAI'
import { Spawner, policeCountFor } from '../systems/Spawner'
import { Law, type TrafficKind } from '../systems/Law'
import { Signals, type Phase, type SignalLights } from '../systems/Signals'
import { ROLES, type RoleDef } from '../data/roles'
import { Missions } from '../systems/Missions'
import { Audio } from '../systems/Audio'
import { Weapon } from '../systems/Weapon'
import { Hud } from '../ui/Hud'
import { Minimap } from '../ui/Minimap'
import { Clock } from '../systems/Clock'
import { DayNight } from '../systems/DayNight'
import { Weather, WEATHER_LABEL } from '../systems/Weather'

type State = 'intro' | 'play' | 'dead' | 'busted' | 'won'
const playingNow = (s: State) => s === 'play' || s === 'won'
const tmpBoxes: AABB[] = []
const c0 = { x: 0, z: 0 }, c1 = { x: 0, z: 0 }

/** 游戏主调度：固定步长物理、系统更新顺序、游戏状态机、调试钩子 */
export class Game {
  renderer: THREE.WebGLRenderer
  scene = new THREE.Scene()
  cam: ChaseCamera
  input = new Input()
  events = new EventBus()
  settings: Settings = loadSettings()
  graph: RoadGraph
  world = new StaticWorld()
  city: CityGenerator
  player = new Player()
  vehicles: Vehicle[] = []
  peds: Pedestrians
  trafficAI: TrafficAI
  policeAI: PoliceAI
  spawner: Spawner
  law = new Law()
  signals: Signals
  role: RoleDef
  private signalLights: SignalLights | null = null
  missions: Missions
  audio = new Audio()
  weapon: Weapon
  private muzzleTmp = new THREE.Vector3()
  hud = new Hud()
  minimap: Minimap
  clock: Clock
  dayNight: DayNight
  weather: Weather
  ctx: Ctx
  state: State = 'intro'
  stateTimer = 0
  time = 0
  hospital: P2
  private acc = 0
  private last = 0
  private fps = 60
  private frames = 0
  private fpsTimer = 0
  private wonShown = false
  private bustTimer = 0
  private unlockHintAt = 0
  private forceAim = false
  private viewW = 0
  private viewH = 0
  private clockHudTimer = 1

  constructor(container: HTMLElement) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' })
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
    this.renderer.setSize(window.innerWidth, window.innerHeight)
    this.renderer.domElement.className = 'game'
    container.appendChild(this.renderer.domElement)
    this.input.bindPointerLock(document.body)   // 覆盖层上点击也能开始并锁定鼠标
    this.scene.background = new THREE.Color(0xa9c9e8)
    this.scene.fog = new THREE.Fog(0xa9c9e8, 150, 380)   // 之后每帧由 DayNight 更新
    this.cam = new ChaseCamera(window.innerWidth / window.innerHeight)
    // 路网：sg 数据尚未就绪时回退方格城
    if (this.settings.world === 'sg') console.warn('[REA] 新加坡路网数据尚未就绪，回退到 grid')
    this.graph = new RoadGraph(buildGridGraphData())
    this.signals = new Signals(this.graph)
    this.role = ROLES[this.settings.role]
    this.player.money = this.role.cash
    this.hud.setGun(this.role.systems.gun)
    this.clock = new Clock(this.settings.timeSpeed)
    this.dayNight = new DayNight(this.scene, this.renderer, this.settings)   // 创建半球光/太阳光

    this.city = new CityGenerator(this.scene, this.graph, this.world)
    this.city.build()
    this.minimap = new Minimap(this.city)
    this.signalLights = (this.scene.userData.signalLights as SignalLights | undefined) ?? null

    this.scene.add(this.player.group)
    this.peds = new Pedestrians(this.scene, this.events)
    this.trafficAI = new TrafficAI(this.peds)
    this.policeAI = new PoliceAI(this.peds)
    this.ctx = { scene: this.scene, graph: this.graph, world: this.world, vehicles: this.vehicles, player: this.player, cam: this.cam, time: 0, pursuitLevel: 0, settings: this.settings, clock: this.clock, signals: this.signals, role: this.role }
    this.spawner = new Spawner(this.ctx, this.peds, this.trafficAI, this.policeAI)
    this.missions = new Missions(this.ctx, this.events)
    this.missions.setToast((s) => this.hud.toast(s))
    this.law.setToast((s, sec) => this.hud.toast(s, sec))
    this.weapon = new Weapon(this.scene)
    this.weather = new Weather(this.scene, this.dayNight, this.audio)
    // 世界与实体都已挂到 scene：读取 userData 约定、设置阴影标记、生成路灯光晕
    this.dayNight.attachWorld()
    this.weather.attachWorld()

    // 医院（重生点）：路口 (1,1) 东向路段行驶侧的人行道
    const n = this.graph.node(1, 1)
    const e = n.out.find((o) => o.to === this.graph.node(2, 1))!
    this.hospital = this.graph.sidewalkPoint(e, 14, { x: 0, z: 0 })
    this.player.place(this.hospital.x, this.hospital.z, Math.PI / 2)
    const park = this.graph.lanePoint(e, 22, { x: 0, z: 0 })
    const dir = this.graph.dirAt(e, 22, { x: 0, z: 0 })
    this.spawner.parkCarNear(this.ctx, park.x, park.z, Math.atan2(dir.x, dir.z))

    this.wireEvents()
    window.addEventListener('resize', () => this.fitViewport())
    document.addEventListener('fullscreenchange', () => this.fitViewport())
    new ResizeObserver(() => this.fitViewport()).observe(document.documentElement)
    this.hud.showOverlay('REA CITY', '程序生成的开放城市 · 偷车、飙车、躲警察、做任务', '', true, '按任意键或点击开始')
    this.exposeDebug()
  }

  /** 画布与相机跟随窗口尺寸；每帧也会校验一次，防止漏掉 resize 事件 */
  private fitViewport() {
    const w = window.innerWidth, h = window.innerHeight
    if (w === this.viewW && h === this.viewH) return
    this.viewW = w; this.viewH = h
    this.renderer.setSize(w, h)
    this.cam.resize(w / h)
  }

  private toggleFullscreen() {
    if (document.fullscreenElement) { document.exitFullscreen?.(); return }
    const req = document.documentElement.requestFullscreen?.({ navigationUI: 'hide' } as FullscreenOptions)
    req?.catch((err: unknown) => {
      console.warn('[REA] 全屏请求失败：', err)
      this.hud.toast('浏览器拒绝全屏，请用浏览器菜单进入全屏', 3)
    })
  }

  private wireEvents() {
    this.events.on('vehicleHitPed', ({ v, speed }) => {
      if (v.driver === 'player') this.law.crime('hitPed', 1, this.ctx)
      this.audio.crash(Math.min(speed, 8))
    })
    this.events.on('vehicleHitVehicle', ({ a, b, impulse }) => {
      const mine = a.driver === 'player' ? a : b.driver === 'player' ? b : null
      if (!mine) return
      const other = mine === a ? b : a
      other.lastHitByPlayer = this.time
      if (other.kind === 'police') { if (impulse > 3) this.law.crime('hitPolice', 1, this.ctx) }
      else if (impulse > 4) { this.law.crime('hitVehicle', 0.34, this.ctx); this.law.collision(this.ctx) }
      if (impulse > 12) this.player.damage((impulse - 12) * 0.8)
    })
    this.events.on('vehicleHitStatic', ({ v, impulse }) => {
      if (v.driver === 'player' && impulse > 14) this.player.damage((impulse - 14) * 0.8)
    })
    this.events.on('vehicleWrecked', ({ byPlayer }) => { if (byPlayer) this.law.crime('wreck', 0.5, this.ctx) })
    this.events.on('carjack', ({ hadDriver }) => { if (hadDriver) this.law.crime('carjack', 0.5, this.ctx) })
    this.events.on('playerHitByVehicle', ({ v, impulse }) => {
      this.player.damage(impulse * 2.2)
      this.player.vx += v.vx * 0.8; this.player.vz += v.vz * 0.8; this.player.vy = 3
    })
  }

  start() {
    this.last = performance.now()
    const loop = (now: number) => {
      requestAnimationFrame(loop)
      const dt = Math.min(0.1, (now - this.last) / 1000)
      this.last = now
      this.acc += dt
      let steps = 0
      while (this.acc >= FIXED_DT && steps < 5) { this.step(FIXED_DT); this.acc -= FIXED_DT; steps++ }
      if (steps === 5) this.acc = 0
      this.render(dt)
      // 只有真正跑过物理步才清除按键边沿，避免高刷新率下丢键
      if (steps > 0) this.input.endFrame()
    }
    requestAnimationFrame(loop)
  }

  private beginPlay() {
    this.state = 'play'
    this.unlockHintAt = this.time
    this.hud.hideOverlay()
    this.audio.unlock()
    this.cam.snap(this.player.yaw)
    this.cam.camera.position.set(this.player.x - Math.sin(this.player.yaw) * 6, 3, this.player.z - Math.cos(this.player.yaw) * 6)
    this.hud.toast('去黄色标记接任务，按 F 上车', 4)
  }

  private step(dt: number) {
    this.time += dt
    this.ctx.time = this.time
    this.ctx.pursuitLevel = this.law.chase ? this.law.pursuitLevel : 0
    this.signals.update(dt)
    // 时钟/天气/昼夜在任何状态下都推进（含开场与死亡）
    this.clock.advance(dt)
    this.weather.update(dt, this.ctx)
    this.dayNight.update(dt, this.ctx)
    this.clockHudTimer += dt
    if (this.clockHudTimer >= 1) { this.clockHudTimer = 0; this.hud.clock(`第${this.clock.day}天 ${this.clock.hhmm} · ${WEATHER_LABEL[this.weather.state]}`) }
    const input = this.input

    if (this.state === 'intro') {
      if (input.anyKeyPressed || input.clicked) this.beginPlay()
      return
    }
    if (this.state === 'won' && (input.anyKeyPressed || input.clicked) && this.stateTimer > 1) { this.state = 'play'; this.hud.hideOverlay() }
    const mouse = input.takeMouse()
    if (playingNow(this.state)) this.cam.applyMouse(mouse.dx, mouse.dy)
    if (this.state === 'dead' || this.state === 'busted') {
      this.stateTimer += dt
      if (this.stateTimer > 3) this.respawn()
    }
    this.stateTimer += this.state === 'won' ? dt : 0
    const playing = this.state === 'play'

    // 玩家输入与上下车
    const gun = this.role.systems.gun
    this.player.aiming = playing && gun && (input.locked || this.forceAim) && !this.player.inVehicle
    this.player.update(dt, input, this.cam.yaw, this.world, playing)
    this.weapon.update(dt)
    if (playing && gun && (input.mouseDown(0) || input.down('ControlLeft') || input.down('KeyE')) && this.weapon.ready) this.shoot()
    if (playing && input.justPressed('KeyF')) this.toggleVehicle()
    if (playing && input.justPressed('KeyM')) this.hud.toast(`任务进度 ${this.missions.completed}/3 · 黄色标记开始任务`, 3)
    if (input.justPressed('Enter')) this.toggleFullscreen()

    // AI → 物理
    this.trafficAI.update(dt, this.ctx)
    this.policeAI.update(dt, this.ctx)
    for (const v of this.vehicles) if (v.active && !v.kinematic) v.step(dt)
    this.resolveCollisions()
    this.peds.update(dt, this.ctx)

    // 系统
    this.law.update(dt, this.ctx)
    this.ctx.pursuitLevel = this.law.chase ? this.law.pursuitLevel : 0
    this.spawner.update(dt, this.ctx, policeCountFor(this.law.policeStars))
    this.missions.update(dt)

    if (playing) {
      if (this.player.health <= 0) this.enterState('dead')
      else if (this.law.policeStars > 0) {
        const pl = this.player
        const near = this.vehicles.some((v) => v.active && v.driver === 'police' && !v.wrecked && v.absSpeed < 8 && Math.hypot(v.x - pl.worldX, v.z - pl.worldZ) < (pl.inVehicle ? 6.5 : 3.4))
        if (!pl.inVehicle && near) this.enterState('busted')
        else if (pl.inVehicle && near && pl.vehicle!.absSpeed < 4) {
          // 在车里几乎不动且被警车贴住约 2.5 秒 → 被拖下车逮捕
          this.bustTimer += dt
          if (this.bustTimer > 2.5) this.enterState('busted')
        } else this.bustTimer = Math.max(0, this.bustTimer - dt * 0.5)
      } else this.bustTimer = 0
      if (this.missions.allDone && !this.wonShown) {
        this.wonShown = true; this.state = 'won'; this.stateTimer = 0
        this.hud.showOverlay('通关！', `三个任务全部完成 · 账户 $${this.player.money}`, 'gold', false, '按任意键继续自由游荡')
      }
    }

    // 相机与同步
    const target = this.player.vehicle ?? this.player
    const moving = this.player.inVehicle ? Math.abs(this.player.vehicle!.speed) > 1 : Math.hypot(this.player.vx, this.player.vz) > 0.5
    this.cam.update(dt, this.player.inVehicle ? 'car' : 'foot', target, this.player.vehicle?.speed ?? 0, this.time, moving, this.state === 'play' && (this.input.locked || this.forceAim))
    this.player.sync()
    for (const v of this.vehicles) if (v.active) v.sync(this.time)
    this.missions.sync(this.time)
    this.updateHud(dt)
  }

  private enterState(s: State) {
    this.state = s; this.stateTimer = 0
    this.missions.onPlayerDown()
    if (s === 'dead') this.hud.showOverlay('WASTED', '你倒下了，正在送往医院…', 'red', false, '')
    else this.hud.showOverlay('BUSTED', '被捕了，罚金 10%…', 'red', false, '')
  }

  private respawn() {
    if (this.player.vehicle) this.player.exit(this.world)
    this.player.health = 100
    const fine = Math.ceil(Math.max(0, this.player.money) * 0.1)
    if (this.state === 'busted') { this.law.fines += fine; this.law.arrests++ }
    this.player.money -= fine
    this.player.place(this.hospital.x, this.hospital.z, Math.PI / 2)
    this.law.reset()
    for (const v of this.vehicles) if (v.driver === 'police') { v.deactivate() }
    this.cam.snap(this.player.yaw)
    this.state = 'play'
    this.hud.hideOverlay()
    this.hud.toast('在医院醒来', 2)
  }

  private shoot() {
    const hit = this.weapon.fire(this.ctx, this.peds, this.cam.camera, this.player.muzzle(this.muzzleTmp))
    this.audio.gunshot()
    this.peds.scare(this.player.worldX, this.player.worldZ, 28)
    if (hit.kind === 'ped') {
      const dir = this.cam.camera.getWorldDirection(new THREE.Vector3())
      this.peds.knockDown(hit.ped, dir.x * 4, dir.z * 4)
      this.law.crime('shoot', 1, this.ctx)
    } else if (hit.kind === 'vehicle') {
      const v = hit.vehicle
      v.lastHitByPlayer = this.time
      this.hitVehicle(v, this.weapon.vehicleDamage, true)
      if (v.driver === 'traffic') this.trafficAI.knock(v)
      this.law.crime('shootVehicle', v.kind === 'police' ? 0.6 : 0.2, this.ctx)
    } else {
      // 当街开枪本身就是犯罪，但只小幅加热度
      this.law.crime('shoot', 0.05, this.ctx)
    }
  }

  private toggleVehicle() {
    const pl = this.player
    if (pl.vehicle) { pl.exit(this.world); return }
    const v = pl.findNearbyVehicle(this.vehicles)
    if (!v) return
    const hadDriver = v.driver === 'traffic'
    if (hadDriver) {
      releaseToken(v)
      const fx = Math.sin(v.yaw), fz = Math.cos(v.yaw)
      this.peds.spawnFleeing(v.x - fz * 2.2, v.z + fx * 2.2, v.x, v.z)
    }
    if (v.driver === 'police') return   // 不能偷有人开的警车
    pl.enter(v)
    this.events.emit('carjack', { v, hadDriver })
  }

  private resolveCollisions() {
    const V = this.vehicles
    // 车 vs 静态
    for (const v of V) {
      if (!v.active || v.kinematic) continue
      for (const i of [0, 1] as const) {
        v.circle(i, c0)
        for (const b of this.world.query(c0.x, c0.z, v.radius, tmpBoxes)) {
          const c = circleAABB(c0.x, c0.z, v.radius, b)
          if (!c) continue
          const imp = pushOut(v, c, 0.25)
          if (imp > 2.5) {
            this.hitVehicle(v, (imp - 2.5) * 2.2, false)
            this.events.emit('vehicleHitStatic', { v, impulse: imp })
            if (v.driver === 'player') this.audio.crash(imp)
          }
          // 撞墙后轻微转开，避免卡死
          v.yaw += (c.nx * Math.cos(v.yaw) - c.nz * Math.sin(v.yaw)) * 0.02 * (i === 0 ? 1 : -1)
          v.circle(i, c0)
        }
      }
    }
    // 车 vs 车
    for (let i = 0; i < V.length; i++) {
      const a = V[i]; if (!a.active) continue
      for (let j = i + 1; j < V.length; j++) {
        const b = V[j]; if (!b.active) continue
        const dx = a.x - b.x, dz = a.z - b.z
        if (dx * dx + dz * dz > 7 * 7) continue
        for (const ia of [0, 1] as const) for (const ib of [0, 1] as const) {
          a.circle(ia, c0); b.circle(ib, c1)
          const imp = circleCircle(a, a.radius, a.mass, b, b.radius, b.mass, 0.3, c0.x, c0.z, c1.x, c1.z)
          if (imp > 0) {
            if (imp > 2) {
              const byPlayer = a.driver === 'player' || b.driver === 'player'
              // 玩家车结实（1.2×），被玩家撞的车脆（3.5×），NPC 互撞伤害低（0.8×）避免车流自毁
              const scaleFor = (v: Vehicle) => (v.driver === 'player' ? 1.2 : byPlayer ? 3.5 : 0.8)
              this.hitVehicle(a, (imp - 2) * scaleFor(a), byPlayer && b.driver === 'player')
              this.hitVehicle(b, (imp - 2) * scaleFor(b), byPlayer && a.driver === 'player')
              this.events.emit('vehicleHitVehicle', { a, b, impulse: imp })
              if (byPlayer) this.audio.crash(imp)
              // 被明显撞到的交通车改为物理滑行
              if (imp > 4) { if (a.driver === 'traffic') this.trafficAI.knock(a); if (b.driver === 'traffic') this.trafficAI.knock(b) }
            }
          }
        }
      }
    }
    // 步行玩家 vs 车
    const pl = this.player
    if (!pl.inVehicle) {
      for (const v of V) {
        if (!v.active) continue
        const dx = v.x - pl.x, dz = v.z - pl.z
        if (dx * dx + dz * dz > 25) continue
        for (const i of [0, 1] as const) {
          v.circle(i, c0)
          const ex = pl.x - c0.x, ez = pl.z - c0.z, d2 = ex * ex + ez * ez, rr = v.radius + pl.radius
          if (d2 >= rr * rr) continue
          const d = Math.sqrt(d2) || 0.001
          pl.x += (ex / d) * (rr - d); pl.z += (ez / d) * (rr - d)
          const closing = -((v.vx - pl.vx) * (ex / d) + (v.vz - pl.vz) * (ez / d))
          if (closing > 3) this.events.emit('playerHitByVehicle', { v, impulse: closing })
        }
      }
    }
  }

  /** 给车辆扣血，并在报废瞬间发事件 */
  private hitVehicle(v: Vehicle, amount: number, byPlayerDirect: boolean) {
    const was = v.wrecked
    v.damage(amount)
    if (!was && v.wrecked) {
      v.wreckedAt = this.time
      const byPlayer = byPlayerDirect || this.time - v.lastHitByPlayer < 3
      if (v.driver === 'traffic') releaseToken(v)
      this.events.emit('vehicleWrecked', { v, byPlayer })
    }
  }

  private updateHud(dt: number) {
    const pl = this.player
    let hint: string | null = null
    if (this.state === 'play') {
      if (!this.input.locked && this.time - this.unlockHintAt < 4) hint = '点击画面锁定鼠标，转动视角（Esc 解锁）'
      else if (!pl.inVehicle && pl.findNearbyVehicle(this.vehicles)) hint = '按 F 上车'
      else if (pl.vehicle?.wrecked) hint = '车已报废，按 F 下车'
      else if (this.bustTimer > 0.5) hint = '快开走！警察要把你拖下车了'
    }
    this.hud.hint(hint)
    this.hud.aiming(this.state === 'play' && (this.input.locked || this.forceAim))
    const law = this.law
    const lawParts: string[] = []
    if (law.licenseSuspended(this.clock.day)) lawParts.push(`驾照吊销至第${law.licenseSuspendedUntilDay}天`)
    if (law.demerits > 0) lawParts.push(`扣分 ${law.demerits}/24`)
    if (law.fines > 0) lawParts.push(`罚款 $${law.fines.toLocaleString()}`)
    this.hud.law(lawParts.join(' · '))
    const police: P2[] = []
    let policeDist = Infinity
    for (const v of this.vehicles) if (v.active && v.driver === 'police') { police.push(v); policeDist = Math.min(policeDist, Math.hypot(v.x - pl.worldX, v.z - pl.worldZ)) }
    const starts = this.missions.active ? [] : this.missions.defs.filter((d) => !d.done).map((d) => d.start)
    const gold = this.missions.missionCar.active && pl.vehicle !== this.missions.missionCar ? { x: this.missions.missionCar.x, z: this.missions.missionCar.z } : null
    this.minimap.draw(pl.worldX, pl.worldZ, this.cam.yaw, this.missions.targetPoint, starts, police, gold, this.hospital)
    const speedKmh = pl.vehicle ? pl.vehicle.speed * 3.6 : null
    const dbg = `${this.fps.toFixed(0)} fps · peds ${this.peds.activeCount} · cars ${this.vehicles.filter((v) => v.active).length} · draw ${this.renderer.info.render.calls}\n视口 ${window.innerWidth}×${window.innerHeight} @${window.devicePixelRatio.toFixed(2)} · 窗口 ${window.outerWidth}×${window.outerHeight} · 屏幕 ${screen.width}×${screen.height}${document.fullscreenElement ? ' · 全屏' : ''}${this.input.locked ? ' · 鼠标锁定' : ''}`
    this.hud.update(dt, pl.health, pl.money, this.law.stars, this.law.flash, speedKmh, this.missions.hudText(), dbg)
    this.audio.update(this.time, pl.inVehicle, pl.vehicle?.speed ?? 0, pl.vehicle?.controls.throttle ?? 0, this.law.policeStars, policeDist)
  }

  private render(dt: number) {
    this.fitViewport()
    if (this.state === 'intro') {
      this.cam.update(dt, 'orbit', this.player, 0, performance.now() / 1000)
      // 开场时也让世界动起来
      this.signals.update(dt)
      this.trafficAI.update(dt, this.ctx); this.policeAI.update(dt, this.ctx)
      for (const v of this.vehicles) if (v.active) { if (!v.kinematic) v.step(dt); v.sync(this.time) }
      this.resolveCollisions()
      this.peds.update(dt, this.ctx)
      this.spawner.update(dt, this.ctx, 0)
      this.missions.sync(performance.now() / 1000)
      this.time += dt; this.ctx.time = this.time
    }
    this.frames++; this.fpsTimer += dt
    if (this.fpsTimer >= 0.5) { this.fps = this.frames / this.fpsTimer; this.frames = 0; this.fpsTimer = 0 }
    if (this.signalLights) this.signals.applyToMesh(this.signalLights.mesh, this.signalLights.edgeIds)
    this.renderer.render(this.scene, this.cam.camera)
  }

  private exposeDebug() {
    const self = this
    ;(window as unknown as { __game: unknown }).__game = {
      get ready() { return true },
      get state() { return self.state },
      get stats() { return { fps: self.fps, peds: self.peds.activeCount, cars: self.vehicles.filter((v) => v.active).length, drawCalls: self.renderer.info.render.calls, time: self.time } },
      get player() { return { x: self.player.worldX, z: self.player.worldZ, health: self.player.health, money: self.player.money, inVehicle: self.player.inVehicle, speed: self.player.vehicle?.speed ?? 0 } },
      get wanted() { return { stars: self.law.stars, heat: self.law.pursuitLevel, demerits: self.law.demerits, fines: self.law.fines } },
      get role() { return self.role },
      get weaponReady() { return self.weapon.ready },
      law: {
        traffic(kind: TrafficKind) { self.law.traffic(kind, self.ctx) },
        crime(kind: Parameters<Law['crime']>[0], weight = 1) { self.law.crime(kind, weight, self.ctx) },
        get pursuitLevel() { return self.law.pursuitLevel }, get stars() { return self.law.stars }, get chase() { return self.law.chase },
        get policeStars() { return self.law.policeStars },
        get demerits() { return self.law.demerits }, get fines() { return self.law.fines }, get arrests() { return self.law.arrests },
        get licenseSuspendedUntilDay() { return self.law.licenseSuspendedUntilDay },
      },
      signals: {
        stateOf(nodeId: number) { return self.signals.stateOf(nodeId) },
        setPhase(nodeId: number, phase: Phase | null) { return self.signals.setPhase(nodeId, phase) },
        phaseFor(edgeId: number) { return self.signals.phaseFor(self.graph.edges[edgeId]) },
        get nodeIds() { return self.signals.nodeIds },
        get time() { return self.signals.time }, get cycle() { return self.signals.cycle },
        node(id: number) { const n = self.graph.nodes[id]; return { id: n.id, x: n.x, z: n.z, jr: n.jr, i: n.i, j: n.j, signal: n.signal, incoming: self.graph.edges.filter((e) => e.to === n).map((e) => ({ id: e.id, from: e.from.id, length: e.length, phase: self.signals.phaseFor(e) })) } },
        /** 玩家车（或任意坐标）在某条边上的投影弧长，用于测试停止线 */
        projectT(edgeId: number, x: number, z: number) { return self.graph.projectT(self.graph.edges[edgeId], x, z) },
        lanePoint(edgeId: number, t: number) { return self.graph.lanePoint(self.graph.edges[edgeId], t, { x: 0, z: 0 }) },
      },
      get missions() { return { active: self.missions.active?.id ?? null, completed: self.missions.completed, timer: self.missions.timer, progress: self.missions.progress } },
      get police() { return self.vehicles.filter((v) => v.active && v.driver === 'police').map((v) => ({ x: v.x, z: v.z, mode: (v.ai as { mode: string } | null)?.mode })) },
      get cars() { return self.vehicles.filter((v) => v.active).map((v) => ({ kind: v.kind, driver: v.driver, speed: +v.speed.toFixed(1), health: v.health, wrecked: v.wrecked, x: +v.x.toFixed(1), z: +v.z.toFixed(1), yaw: +v.yaw.toFixed(2), vx: +v.vx.toFixed(1), vz: +v.vz.toFixed(1), stuck: (v.ai as { stuck?: number } | null)?.stuck ?? 0, dbg: (v.ai as { dbg?: string } | null)?.dbg ?? '' })) },
      get missionCar() { const m = self.missions.missionCar; return { active: m.active, x: m.x, z: m.z } },
      get missionDefs() { return self.missions.defs.map((d) => ({ id: d.id, start: d.start, target: d.target, done: d.done })) },
      boxesNear(x: number, z: number, r = 3) { return self.world.query(x, z, r, []).map((b) => ({ ...b, w: +(b.maxX - b.minX).toFixed(1), d: +(b.maxZ - b.minZ).toFixed(1) })) },
      carDetail(i: number) { const v = self.vehicles.filter((q) => q.active)[i]; return { x: v.x, z: v.z, yaw: v.yaw, vx: v.vx, vz: v.vz, ctl: v.controls, kind: v.kind, driver: v.driver } },
      get peds() { return self.peds.peds.filter((p) => p.active).map((p) => ({ x: +p.x.toFixed(1), z: +p.z.toFixed(1), state: p.state })) },
      setVel(vx: number, vz: number) { const v = self.player.vehicle; if (v) { v.vx = vx; v.vz = vz; v.yaw = Math.atan2(vx, vz) } },
      hurt(n: number) { self.player.damage(n) },
      mouse(dx: number, dy: number) { self.cam.applyMouse(dx, dy) },
      get camYaw() { return self.cam.yaw },
      get locked() { return self.input.locked },
      shoot() { if (self.role.systems.gun && self.weapon.ready) self.shoot() },
      aimAt(x: number, z: number) { self.cam.camera.lookAt(x, 1.0, z) },
      forceAim(on: boolean) { self.forceAim = on },
      // 测试辅助
      teleport(x: number, z: number) { if (self.player.vehicle) { self.player.vehicle.x = x; self.player.vehicle.z = z } else { self.player.x = x; self.player.z = z } },
      addCrime(n: number) { self.law.addCrime(n, self.time) },
      startPlay() { if (self.state === 'intro') self['beginPlay']() },
      get grid() { return { PITCH, HALF, DRIVE_SIDE } },
      get graphStats() { return self.graph.stats() },
      get settings() { return self.settings },
      clock: {
        set(hour: number, day?: number) { self.clock.set(hour, day) },
        skip(hours: number) { self.clock.skip(hours) },
        get hour() { return self.clock.hour }, get day() { return self.clock.day },
        get hhmm() { return self.clock.hhmm }, get phase() { return self.clock.phase },
        get speed() { return self.clock.speed }, set speed(v: number) { self.clock.speed = v },
      },
      weather: {
        set(s: 'clear' | 'cloudy' | 'storm') { self.weather.set(s) },
        get state() { return self.weather.state }, get gloom() { return self.weather.gloom }, get rain() { return self.weather.rainIntensity },
      },
      get dayNight() { const d = self.dayNight; return { sunIntensity: d.sun.intensity, hemiIntensity: d.hemi.intensity, lights: d.lights, gloom: d.gloom, shadows: self.renderer.shadowMap.enabled, sunDir: d.sun.position.clone().sub(d.sun.target.position).normalize().toArray().map((n) => +n.toFixed(2)) } },
    }
  }
}
