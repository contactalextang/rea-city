import * as THREE from 'three'
import { FIXED_DT, PITCH, HALF, DRIVE_SIDE, MAX_TRAFFIC } from '../config'
import { Input } from './Input'
import { ChaseCamera } from './Camera'
import { EventBus, type Ctx } from './Context'
import type { RoadGraph, P2 } from '../world/RoadGraph'
import { clampBrightness, loadSettings, type Settings } from './Settings'
import type { StaticWorld, AABB } from '../world/Colliders'
import type { WorldSource } from '../world/WorldSource'
import { SgWorld } from '../world/SgWorld'
import { GridWorld } from '../world/GridWorld'
import { PoiMarkers } from '../world/PoiMarkers'
import { circleBody, circleCircle, pushOut } from '../physics/Collision'
import { Player } from '../entities/Player'
import { Vehicle } from '../entities/Vehicle'
import { Pedestrians } from '../entities/Pedestrians'
import { TrafficAI, releaseToken } from '../entities/TrafficAI'
import { PoliceAI } from '../entities/PoliceAI'
import { Spawner, policeCountFor } from '../systems/Spawner'
import { Law, lawTuning, type TrafficKind } from '../systems/Law'
import { Signals, type Phase, type SignalLights } from '../systems/Signals'
import { ROLES, type RoleDef } from '../data/roles'
import { Jobs, taxiFare } from '../systems/Jobs'
import { Quests } from '../systems/Quests'
import type { AssetId } from '../data/jobs'
import { Audio } from '../systems/Audio'
import { Weapon } from '../systems/Weapon'
import { Hud } from '../ui/Hud'
import { Minimap } from '../ui/Minimap'
import { Clock } from '../systems/Clock'
import { DayNight } from '../systems/DayNight'
import { Weather, WEATHER_LABEL } from '../systems/Weather'
import { PoiRegistry, type Poi } from '../systems/Poi'
import { Needs, wireMood, MOOD } from '../systems/Needs'
import { Interactions } from '../systems/Interactions'
import { Panels, type PanelSpec } from '../ui/Panels'
import { Phone } from '../ui/Phone'
import * as Save from '../systems/Save'
import { Progress } from '../systems/Progress'
import { Wallet, setWageMul, charge, serializeLedger, restoreLedger } from '../systems/Wallet'
import { Activity, type ActivitySpec } from '../ui/Activity'
import { VENUES, sgVenuePois, venueOf, venueOpen, hoursText } from '../data/venues'
import { Assets } from '../systems/Assets'
import { Business } from '../systems/Business'
import { ACHIEVEMENTS } from '../data/progression'
import { saveSettings } from './Settings'
import { PostFX } from './PostFX'
import type { FxQuality } from './Settings'
import { CharacterLibrary } from '../characters/CharacterLibrary'
import type { GamePlugin } from '../activities/Plugin'
import { installActivities } from '../activities'
import { identitySpec } from '../characters/presets'
import { Creator, loadCreatorResult, saveCreatorResult, type CreatorResult } from '../ui/Creator'

/** creator：开局建角色（世界暂停，只渲染建角色界面） */
/** activity：全屏小游戏（Activity 宿主）；arena：射击竞技场（P10.D 切换渲染场景）——两者都暂停城市世界 */
type State = 'intro' | 'creator' | 'play' | 'dead' | 'busted' | 'won' | 'panel' | 'activity' | 'arena'
/** 城市世界暂停（不跑物理/AI，骨骼动画冻结，时钟不走） */
const worldPaused = (s: State) => s === 'panel' || s === 'activity' || s === 'arena'

/**
 * 竞技场会话（P10.D 实现）：Game.enterArena(mode) 用 arenaFactory 创建，state='arena' 期间每渲染帧
 * update(dt, input) + render(dt) 代替城市模拟与渲染；会话结束时调用 game.exitArena()。
 * P10.D 需要给 PostFX 加 setScene()（或自己 renderer.render），这里只约定形状。
 */
export interface ArenaSession {
  readonly mode: string
  update(dt: number, input: Input): void
  render(dt: number): void
  /** exitArena 时调用：释放场景/几何、发 matchDone 等 */
  dispose(): void
}
export type ArenaFactory = (mode: string, game: Game) => ArenaSession
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
  /** 世界数据源（sg 真实城市 / grid 方格城）；下面的 graph/world 在 init() 里取自它 */
  source: WorldSource & { firstLoadMs?: number }
  graph!: RoadGraph
  world!: StaticWorld
  poiMarkers!: PoiMarkers
  player = new Player()
  vehicles: Vehicle[] = []
  peds!: Pedestrians
  trafficAI!: TrafficAI
  policeAI!: PoliceAI
  spawner!: Spawner
  law = new Law()
  signals!: Signals
  role: RoleDef
  private signalLights: SignalLights | null = null
  jobs!: Jobs
  quests!: Quests
  /** Phase 8：资产（车/房/升级）、产业、钱包（净资产）、成长（等级/成就/统计） */
  assets!: Assets
  business!: Business
  wallet!: Wallet
  progress!: Progress
  audio = new Audio()
  weapon: Weapon
  private muzzleTmp = new THREE.Vector3()
  hud = new Hud()
  minimap!: Minimap
  clock: Clock
  dayNight: DayNight
  /** 后期管线；fx=off 时为 null（直接 renderer.render，仍 AgX） */
  postfx: PostFX | null = null
  weather: Weather
  pois = new PoiRegistry()
  needs: Needs
  interactions!: Interactions
  panels = new Panels()
  phone: Phone
  /** P10 活动宿主（全屏小游戏）；openActivity 打开 */
  activity!: Activity
  /** P10.D 注入：竞技场会话工厂（null = 竞技场未实现，enterArena 返回 false） */
  arenaFactory: ArenaFactory | null = null
  /** P10 娱乐插件（赌场 / 赛车 / 夜店 / 竞技场），见 activities/Plugin.ts */
  readonly plugins: GamePlugin[] = []
  private pluginSaves: Record<string, unknown> = {}
  /** 当前竞技场会话（state='arena' 时非空） */
  arena: ArenaSession | null = null
  /** 打开活动时来源的 POI（returnToPanel 用） */
  private activityPoi: Poi | null = null
  ctx!: Ctx
  /** init() 完成（世界数据就绪、系统已构建） */
  ready = false
  private bootAt = performance.now()
  private readyAt = 0
  state: State = 'intro'
  stateTimer = 0
  time = 0
  hospital: P2 = { x: 0, z: 0 }
  private hospitalDoor = { x: 0, z: 0, yaw: 0 }
  private policeDoor = { x: 0, z: 0, yaw: 0 }
  private acc = 0
  private last = 0
  private fps = 60
  private frames = 0
  private fpsTimer = 0
  /** 本步内有购买（purchased 事件）→ 步末自动存档一次 */
  private saveDue = false
  private bustTimer = 0
  private unlockHintAt = 0
  private forceAim = false
  private viewW = 0
  private viewH = 0
  private clockHudTimer = 1
  private phoneTimer = 0
  /** 自己家的门口（昏倒/开局传送点） */
  private homeDoor = { x: 0, z: 0, yaw: Math.PI / 2 }
  /** 骨骼角色库（chars=box 或加载失败时为 null → 盒子人回退） */
  charLib: CharacterLibrary | null = null
  /** 已保存的建角色结果（localStorage['rea.character']） */
  private creatorSaved: CreatorResult | null = null
  /** 开始游戏前需要走建角色流程 */
  private needCreator = false
  /** 当前打开的建角色/衣柜界面（打开期间主循环只跑它） */
  private creatorUi: Creator | null = null
  /** 建角色界面的 DOM 容器：拦截 mousedown，避免点按钮时触发指针锁定 */
  private uiLayer: HTMLDivElement
  playerName = ''
  /** 测试：固定相机 [x,y,z,lookX,lookY,lookZ]（玩家局部坐标），null = 正常追尾 */
  private camShotRel: number[] | null = null
  private get camShot(): number[] | null {
    const r = this.camShotRel; if (!r) return null
    // 相对玩家局部坐标（+Z 前、+X 左），随玩家朝向旋转
    const x = this.player.x, z = this.player.z, c = Math.cos(this.player.yaw), sn = Math.sin(this.player.yaw)
    return [x + r[0] * c + r[2] * sn, r[1], z - r[0] * sn + r[2] * c, x + r[3] * c + r[5] * sn, r[4], z - r[3] * sn + r[5] * c]
  }

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
    // 已建角色：身份以建角色结果为准（URL ?role= 仍可临时覆盖，便于测试）
    const q = new URLSearchParams(location.search)
    this.creatorSaved = loadCreatorResult()
    if (this.creatorSaved && !q.has('role') && !q.has('fresh')) this.settings.role = this.creatorSaved.role
    this.playerName = this.creatorSaved?.name ?? ''
    this.role = ROLES[this.settings.role]
    this.player.money = this.role.cash
    this.hud.setGun(this.role.systems.gun)
    this.player.showGun = this.role.systems.gun
    this.uiLayer = document.createElement('div')
    this.uiLayer.className = 'creator-layer'
    this.uiLayer.addEventListener('mousedown', (e) => e.stopPropagation())
    document.body.appendChild(this.uiLayer)   // 放在 body 末尾：盖住 HUD
    this.clock = new Clock(this.settings.timeSpeed)
    this.dayNight = new DayNight(this.scene, this.renderer, this.settings)   // 创建半球光/太阳光
    this.setFx(this.settings.fx, false)
    this.needs = new Needs(this.clock, this.role.needsRate)
    this.weapon = new Weapon(this.scene)
    this.weather = new Weather(this.scene, this.dayNight, this.audio)
    this.panels.onClose = () => this.closePanel()
    this.law.setToast((s, sec) => this.hud.toast(s, sec))
    this.phone = new Phone({
      setTimeSpeed: (v) => { this.settings.timeSpeed = v; this.clock.speed = v; saveSettings(this.settings); this.hud.toast(`时间流速 ${v}×`) },
      setShadows: (on) => { this.settings.shadows = on; this.dayNight.setShadows(on); saveSettings(this.settings); this.hud.toast(on ? '阴影已开启' : '阴影已关闭') },
      setMusic: (on) => { this.settings.music = on; this.audio.setMusic(on); saveSettings(this.settings); this.hud.toast(on ? '音乐已开启' : '音乐已关闭') },
      setFx: (q) => this.setFx(q),
      setBrightness: (v) => { this.settings.brightness = clampBrightness(v); saveSettings(this.settings) },
      save: () => this.saveGame(true),
      load: () => this.loadGame(),
      restart: () => { Save.clear(); const q = new URLSearchParams(location.search); q.set('fresh', '1'); location.search = q.toString() },
      drawMap: (c) => this.minimap.drawLarge(c, this.player.worldX, this.player.worldZ, this.cam.yaw, this.vehicles.filter((v) => v.active && v.driver === 'police'), this.pois.all),
      toast: (t) => this.hud.toast(t),
      startJob: (id) => { const r = this.jobs.start(id); if (r !== true) this.hud.toast(r) },
      stopJob: () => this.jobs.stop(),
      buy: (asset, amount) => this.jobs.buy(asset, amount),
      sell: (asset) => this.jobs.sell(asset),
      wardrobe: () => this.openWardrobe(),
    })

    // 世界数据源：默认真实新加坡（异步加载烘焙数据），?world=grid 为方格城回归基线
    this.source = this.settings.world === 'sg' ? new SgWorld() : new GridWorld()
    this.hud.showOverlay('REA CITY', this.source.kind === 'sg' ? '加载新加坡…' : '生成城市…', '', false, '')
    this.hud.attribution('')

    window.addEventListener('resize', () => this.fitViewport())
    document.addEventListener('fullscreenchange', () => this.fitViewport())
    new ResizeObserver(() => this.fitViewport()).observe(document.documentElement)
    this.exposeDebug()
    this.init().catch((e: unknown) => {
      console.error('[REA] 世界加载失败：', e)
      this.hud.showOverlay('加载失败', String((e as Error)?.message ?? e), 'red', false, '刷新页面重试，或加 ?world=grid 进入方格城')
    })
  }

  /** 世界就绪后构建依赖路网/碰撞/POI 的全部系统（顺序：路网 → 静态网格 → 实体/系统 → 灯光约定 → 出生点） */
  private async init() {
    const src = this.source
    // 世界数据与角色库并行加载；?chars=box 或角色库加载失败 → 盒子人回退
    const libP = this.settings.chars === 'gltf'
      ? CharacterLibrary.load().catch((e: unknown) => { console.warn('[REA] 角色库加载失败，回退方块角色：', e); return null })
      : Promise.resolve(null)
    const [, lib] = await Promise.all([src.ready, libP])
    this.charLib = lib
    const sg = src.kind === 'sg'
    this.graph = src.graph
    this.world = src.world
    this.signals = new Signals(this.graph)
    // P10 娱乐场馆：sg 世界运行时吸附门口追加（方格城已在 gridPois 里合成）
    this.pois.load(sg ? [...src.pois, ...sgVenuePois(this.graph, src.pois, (x, z) => this.world.contains(x, z))] : src.pois)
    // 静态网格挂进 scene（方格城此时才生成城市；真实城市挂地面/天际线/道具池，区块随 update 流式加载）
    src.attach(this.scene)
    this.poiMarkers = new PoiMarkers(this.pois.all, sg
      ? { beams: true, labelDist: 120, smallTypes: ['bus', 'taxi'], atDoor: true }
      : { beams: false, labelDist: Infinity, smallTypes: [], atDoor: false })
    this.poiMarkers.attach(this.scene)
    const b = src.bounds
    this.minimap = new Minimap({ image: src.minimapBase(), minX: b.minX, minZ: b.minZ }, sg ? 0.5 : 0.75)
    // 红绿灯灯具：真实城市的对象由 PropMeshes 持有（mesh 随区块增删更换，每帧读 .mesh）
    this.signalLights = (this.scene.userData.signalLights as SignalLights | undefined) ?? null

    const q = new URLSearchParams(location.search)
    if (lib) {
      const cr = this.creatorSaved
      this.player.useCharacter(lib, cr && cr.role === this.role.id ? cr.spec : identitySpec(this.role.id))
      this.needCreator = !cr || q.has('fresh') || q.has('creator')
    }
    this.scene.add(this.player.group)
    this.peds = new Pedestrians(this.scene, this.events, lib)
    this.trafficAI = new TrafficAI(this.peds)
    this.policeAI = new PoliceAI(this.peds)
    this.ctx = { scene: this.scene, graph: this.graph, world: this.world, vehicles: this.vehicles, player: this.player, cam: this.cam, time: 0, pursuitLevel: 0, settings: this.settings, clock: this.clock, signals: this.signals, role: this.role, pois: this.pois, needs: this.needs, law: this.law, events: this.events }
    this.spawner = new Spawner(this.ctx, this.peds, this.trafficAI, this.policeAI, sg ? 30 : MAX_TRAFFIC)
    this.jobs = new Jobs(this.ctx, this.peds)
    this.jobs.toast = (t, sec) => this.hud.toast(t, sec)
    this.jobs.closePanel = () => this.closePanel()
    this.interactions = new Interactions(this.ctx, this.panels, {
      toast: (t, sec) => this.hud.toast(t, sec),
      closePanel: () => this.closePanel(),
      teleport: (x, z, yaw) => { this.player.place(x, z, yaw); this.cam.snap(yaw) },
      save: () => this.saveGame(false),
      parkTaxi: (x, z, yaw) => this.spawner.parkTaxiNear(this.ctx, x, z, yaw),
      wardrobe: () => this.openWardrobe(),
      ownsHome: (id) => id === this.role.home || this.assets.ownsHome(id),
      restBonus: (id) => this.assets.restBonus(id),
    })
    this.interactions.jobs = this.jobs
    this.quests = new Quests(this.ctx)
    this.quests.toast = (t, sec) => this.hud.toast(t, sec)
    // Phase 8 子系统：资产 / 产业（P8.2 / P8.3 填实）→ 钱包 → 成长
    this.assets = new Assets(this.ctx, { toast: (t, sec) => this.hud.toast(t, sec), save: () => this.saveGame(false), spawner: this.spawner, level: () => this.progress.level, closePanel: () => this.closePanel(), refresh: () => { const c = this.interactions.current; if (c && this.panels.open) this.interactions.open(c) } })
    this.business = new Business(this.ctx, { toast: (t, sec) => this.hud.toast(t, sec), save: () => this.saveGame(false), level: () => this.progress.level, hasBloomberg: () => this.assets.owns('upg_bloomberg'), refresh: () => { const c = this.interactions.current; if (c && this.panels.open) this.interactions.open(c) } })
    this.wallet = new Wallet(this.ctx, () => { const v = this.jobs.stats.invest; return v.fixed + v.index + v.crypto }, this.assets, this.business)
    // 心情：工资倍率（job 类收入）+ 事件规则；XP 倍率在 Progress.addXp 里读 needs.moodMul
    setWageMul(() => this.needs.moodMul)
    wireMood(this.events, this.needs)
    this.activity = new Activity(() => this.ctx)
    this.activity.onClosed = (spec) => this.afterActivity(spec)
    // 活动期间 HUD 隐藏：hud.toast / 成就横幅转发到活动提示条（赌场入场税、成就、心情等即时可见）
    this.hud.sink = (text, sec) => {
      if (this.state !== 'activity' || !this.activity.isOpen) return false
      this.activity.toast(text, sec); return true
    }
    this.progress = new Progress(this.ctx, { netWorth: () => this.wallet.netWorth(), bizCount: () => this.business.list().length })
    // 投资买卖只是现金 ↔ 持仓互换，不计入终身收支
    this.jobs.onInvestCash = (d) => this.progress.excludeCash(d)
    // 帝国任务线读产业 / 资产 / 等级 / 净资产
    this.quests.setSources({ business: this.business, assets: this.assets, progress: this.progress, netWorth: () => this.wallet.netWorth() })
    this.interactions.addProvider((p) => this.jobs.poiButtons(p))
    this.interactions.addProvider((p) => this.assets.poiButtons(p))
    this.interactions.addProvider((p) => this.business.poiButtons(p))
    this.phone.registerView('progress', '成长', () => this.progress.view())
    this.phone.registerView('shop', '商店', () => this.assets.view())
    this.phone.registerView('biz', '生意', () => this.business.view())
    this.phone.registerView('wallet', '钱包', () => this.wallet.view())
    installActivities(this)
    // 升级装备：防弹衣减伤（所有玩家受伤都经 Player.damage）
    const rawDamage = this.player.damage.bind(this.player)
    this.player.damage = (n: number) => rawDamage(n * (1 - this.assets.effects().armor))

    // 视距：真实城市雾放远到 ~900 m 看天际线，相机远裁剪面随之加大；方格城保持原值
    this.dayNight.fogScale = sg ? 900 / 380 : 1
    this.cam.setFar(sg ? 1600 : 420)
    // 世界与实体都已挂到 scene：读取 userData 约定、设置阴影标记、生成路灯光晕
    this.dayNight.attachWorld()
    this.weather.attachWorld()

    // 重生点 = 医院门口，被捕 = 警署门口，出生/昏倒 = 自己家门口；缺失时回退到世界默认出生点
    const fallback = { ...src.spawn }
    const door = (p: Poi | undefined | null) => (p ? { ...p.door } : { ...fallback })
    this.hospitalDoor = door(this.pois.byType('hospital')[0])
    this.policeDoor = door(this.pois.byType('police')[0] ?? this.pois.byType('hospital')[0])
    this.hospital = { x: this.hospitalDoor.x, z: this.hospitalDoor.z }
    this.homeDoor = door(this.pois.byId(this.role.home))
    this.player.place(this.homeDoor.x, this.homeDoor.z, this.homeDoor.yaw)
    // 存档：同身份且未带 ?fresh=1 则读档；存档来自另一个世界时不恢复位置
    const fresh = q.has('fresh')
    let saved = fresh ? null : Save.load()
    // 存档身份与建角色结果不一致：以建角色为准，清掉旧存档
    if (saved && this.creatorSaved && !q.has('role') && saved.role !== this.creatorSaved.role) { Save.clear(); saved = null }
    if (saved && saved.role === this.role.id) {
      Save.apply(this.ctx, saved); this.jobs.restore(saved.jobs); this.quests.init(saved.quests); this.weather.restore(saved.weather)
      this.restorePhase8(saved)
      if ((saved.world ?? 'grid') !== src.kind) this.player.place(this.homeDoor.x, this.homeDoor.z, this.homeDoor.yaw)
      console.info(`[REA] 读取存档：第${saved.day}天 $${saved.money}`)
    } else { this.quests.init(null); this.restorePhase8(null) }
    this.progress.resync()
    this.parkCarNearDoor(this.player.x, this.player.z)

    this.wireEvents()
    // 开场环绕镜头：方格城绕原点，真实城市绕出生点
    if (sg) {
      this.cam.orbitCenter = { x: this.player.x, z: this.player.z }
      this.cam.orbitRadius = 140; this.cam.orbitHeight = 60
    }
    this.cam.camera.position.set(this.cam.orbitCenter.x, this.cam.orbitHeight, this.cam.orbitCenter.z + this.cam.orbitRadius)
    this.readyAt = performance.now()
    this.ready = true
    this.hud.showOverlay('REA CITY', sg ? '新加坡 · 牛车水 / 莱佛士坊 / 滨海湾 / 中峇鲁' : '程序生成的开放城市 · 偷车、飙车、躲警察、做任务', '', true, '按任意键或点击开始')
    this.hud.attribution((src.attribution ?? []).join('\n'))
  }

  /** 画布与相机跟随窗口尺寸；每帧也会校验一次，防止漏掉 resize 事件 */
  private fitViewport() {
    const w = window.innerWidth, h = window.innerHeight
    if (w === this.viewW && h === this.viewH) return
    this.viewW = w; this.viewH = h
    this.renderer.setSize(w, h)
    this.cam.resize(w / h)
    this.postfx?.setSize(w, h)
  }

  /** 切换后期画质（手机设置 / 调试）：重建 PostFX；off = 直出 */
  setFx(q: FxQuality, persist = true) {
    if (this.postfx && this.postfx.quality === q) return
    this.postfx?.dispose()
    this.postfx = q === 'off' ? null : new PostFX(this.renderer, this.scene, this.cam.camera, q)
    this.settings.fx = q
    this.dayNight.hdrSky = this.postfx !== null
    if (persist) { saveSettings(this.settings); this.hud.toast(`画质：${q === 'high' ? '高' : q === 'low' ? '低' : '关（无后期）'}`) }
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
      if (v.driver !== 'player') return   // NPC 撞人不出声（之前全城车祸都会“嘭”）
      this.law.crime('hitPed', 1, this.ctx)
      this.audio.crash(Math.min(speed, 8))
    })
    this.events.on('vehicleHitVehicle', ({ a, b, impulse }) => {
      const mine = a.driver === 'player' ? a : b.driver === 'player' ? b : null
      if (!mine) return
      const other = mine === a ? b : a
      if (impulse > 12) this.player.damage((impulse - 12) * 0.8)
      // 被撞（对方更快地冲向玩家 / 警车追撞）只扣血不计罪；同一辆车 3 s 内只计一次
      if (!this.hitByPlayerFault) return
      other.lastHitByPlayer = this.time
      if (this.time - (this.crimeHitAt.get(other) ?? -100) < 3) return
      const tune = lawTuning(this.ctx)
      const mul = mine.kind === 'bus' ? tune.busImpulseMul : 1
      if (other.kind === 'police') {
        if (impulse > 3 * mul) { this.crimeHitAt.set(other, this.time); this.law.crime('hitPolice', 1, this.ctx) }
      } else if (impulse > 4 * mul) {
        this.crimeHitAt.set(other, this.time)
        this.law.crime('hitVehicle', tune.hitVehicleHeat, this.ctx)
        if (!this.role.systems.wanted || tune.wantedCollisionTicket) this.law.collision(this.ctx)
      }
    })
    this.events.on('vehicleHitStatic', ({ v, impulse }) => {
      if (v.driver === 'player' && impulse > 14) this.player.damage((impulse - 14) * 0.8)
    })
    this.events.on('vehicleWrecked', ({ byPlayer }) => { if (byPlayer) this.law.crime('wreck', 0.5, this.ctx) })
    this.events.on('carjack', ({ hadDriver }) => { if (hadDriver) this.law.crime('carjack', 0.5, this.ctx) })
    // 成长：升级 / 成就提示；的士小费升级（网约车 App）按倍率补发小费
    this.events.on('levelUp', ({ level }) => { this.hud.toast(`升级！Lv${level} ${this.progress.title}`, 3) })
    this.events.on('achievement', ({ id }) => { const a = ACHIEVEMENTS.find((x) => x.id === id); this.hud.achievement(`成就解锁 ★ ${a?.name ?? id}`) })
    this.events.on('jobDone', ({ job, amount, base }) => {
      const mul = this.assets.effects().taxiTipMul
      // 按标价算补发小费（taxiTip 属 job 类，earn 会再乘一次心情倍率）
      if (job === 'blue_taxi' && mul > 1) this.wallet.earn(Math.round((base ?? amount) * (mul - 1) * 100) / 100, 'taxiTip')
    })
    // 每次购买（商店 / 产业 / 升档 / 经理）后自动存档：同一步内多次购买只存一次
    this.events.on('purchased', () => { this.saveDue = true })
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
      if (!this.ready) { this.fitViewport(); return }   // 世界加载中：只显示覆盖层
      const hudEl = document.getElementById('hud')
      const uiOpen = !!this.creatorUi?.isOpen || this.state === 'activity' || this.state === 'arena'
      if (hudEl && (hudEl.style.visibility === 'hidden') !== uiOpen) hudEl.style.visibility = uiOpen ? 'hidden' : ''
      if (uiOpen && this.creatorUi) {
        // 建角色 / 衣柜：世界模拟暂停，HUD 隐藏，只更新并渲染界面（界面自己铺满底色）
        this.fitViewport()
        this.creatorUi.update(dt)
        this.creatorUi.render()
        this.input.takeMouse()
        this.input.endFrame()
        return
      }
      if (this.state === 'activity' || this.state === 'arena') { this.pausedFrame(dt); return }
      this.acc += dt
      let steps = 0
      while (this.acc >= FIXED_DT && steps < 5) {
        this.step(FIXED_DT); this.acc -= FIXED_DT; steps++
        // 按键边沿（justPressed / anyKeyPressed / clicked）只给本帧第一个物理步：
        // 一帧补跑多步时若每步都看到同一次按下，F 会先上客再下车、Tab 手机开了又关、Enter 全屏切两次。
        // 0 步帧（高刷新率下 acc 不足一步）不清除，边沿留给下一帧，避免丢键；render() 不读边沿。
        if (steps === 1) this.input.endFrame()
      }
      if (steps === 5) this.acc = 0
      this.render(dt)
    }
    requestAnimationFrame(loop)
  }

  /** 活动 / 竞技场帧：城市不模拟；活动按需推进时钟，背后渲染冻结的城市（opaque 活动不渲染） */
  private pausedFrame(dt: number) {
    this.fitViewport()
    if (this.state === 'arena') {
      const a = this.arena
      if (a) { a.update(dt, this.input); if (this.arena === a) a.render(dt) }
      else this.state = 'play'
      this.input.takeMouse(); this.input.endFrame()
      return
    }
    if (!this.activity.isOpen) { this.state = 'play'; return }
    if (this.activity.clockRuns) this.clock.advance(dt)
    const opaque = this.activity.opaque
    this.activity.update(dt, this.input)
    this.input.takeMouse(); this.input.endFrame()
    if (!opaque || !this.activity.isOpen) this.render(dt)
  }

  private beginPlay() {
    if (!this.ready) return
    if (this.needCreator && this.charLib) { void this.runCreator(this.charLib); return }
    this.state = 'play'
    this.unlockHintAt = this.time
    this.hud.hideOverlay()
    this.hud.attribution('')
    this.audio.setMusic(this.settings.music)
    this.audio.unlock()
    this.cam.snap(this.player.yaw)
    this.cam.camera.position.set(this.player.x - Math.sin(this.player.yaw) * 6, 3, this.player.z - Math.cos(this.player.yaw) * 6)
    this.hud.toast('E 进入地点 · Tab 手机 · F 上车 · 黄色标记接任务', 4)
  }

  /**
   * 开局建角色：确认后保存结果；身份与当前不同 → 写入设置、清旧存档、去掉 URL 里的 fresh/creator/role 后重新加载
   * （出生点/现金/枪/工作任务都按身份在 init 里构建，重载最可靠）；相同 → 换上外观直接开始。
   */
  private async runCreator(lib: CharacterLibrary) {
    if (this.creatorUi) return
    this.state = 'creator'
    this.hud.hideOverlay()
    this.hud.attribution('')
    if (document.pointerLockElement) document.exitPointerLock()
    const q = new URLSearchParams(location.search)
    const initial = q.has('creator') && this.creatorSaved ? this.creatorSaved : undefined
    const ui = new Creator({ renderer: this.renderer, lib, mode: 'new', container: this.uiLayer, initial })
    this.creatorUi = ui
    const r = await ui.open()
    ui.dispose()
    this.creatorUi = null
    this.input.endFrame()   // 确认用的 Enter 不再传给游戏（否则会触发全屏）
    if (!r) { this.state = 'intro'; this.hud.showOverlay('REA CITY', '', '', true, '按任意键或点击开始'); return }
    saveCreatorResult(r)
    this.creatorSaved = r
    this.playerName = r.name
    for (const k of ['fresh', 'creator', 'role']) q.delete(k)
    const url = location.pathname + (q.toString() ? `?${q}` : '') + location.hash
    const saved = Save.load()
    if (saved && saved.role !== r.role) Save.clear()
    if (r.role !== this.role.id) {
      this.settings.role = r.role
      saveSettings(this.settings)
      this.hud.showOverlay('REA CITY', `以${ROLES[r.role].title}身份进入新加坡…`, '', false, '')
      location.replace(url)
      return
    }
    history.replaceState(null, '', url)
    this.player.setSpec(r.spec)
    this.needCreator = false
    this.beginPlay()
  }

  /** 衣柜：只改外观（不能换身份）；期间 state='panel'，世界暂停。返回 false = 不可用 */
  openWardrobe(): boolean {
    const lib = this.charLib
    if (!lib || !this.player.char) return false
    if (this.creatorUi || (this.state !== 'play' && this.state !== 'panel')) return true
    this.panels.hide()
    this.interactions.current = null
    this.phone.set(false)
    if (document.pointerLockElement) document.exitPointerLock()
    this.state = 'panel'
    const ui = new Creator({ renderer: this.renderer, lib, mode: 'wardrobe', container: this.uiLayer, initial: { role: this.role.id, spec: this.player.char.spec, name: this.playerName || undefined } })
    this.creatorUi = ui
    void ui.open().then((r) => {
      ui.dispose()
      this.creatorUi = null
      this.input.endFrame()
      if (r) {
        this.player.setSpec(r.spec)
        this.playerName = r.name
        this.creatorSaved = { role: this.role.id, spec: r.spec, name: r.name }
        saveCreatorResult(this.creatorSaved)
        this.hud.toast('换装完成', 2)
      }
      this.state = 'play'
      this.unlockHintAt = this.time
    })
    return true
  }

  /** 在某个门口附近的车道上停一辆空车 */
  private parkCarNearDoor(x: number, z: number) {
    const g = this.graph
    const lane = g.nearestLane(x, z)
    const t = Math.max(6, Math.min(lane.edge.length - 6, lane.t + 8))
    const p = g.lanePoint(lane.edge, t, { x: 0, z: 0 })
    const d = g.dirAt(lane.edge, t, { x: 0, z: 0 })
    this.spawner.parkCarNear(this.ctx, p.x, p.z, Math.atan2(d.x, d.z))
  }

  // ---------- 交互面板 / 手机 / 存档 ----------
  openPanel(poi: Poi) {
    if (this.state !== 'play') return
    this.state = 'panel'
    this.phone.set(false)
    if (document.pointerLockElement) document.exitPointerLock()
    this.interactions.open(poi)
  }
  /**
   * 公开面板接口（插件用）：在 play / panel 状态弹出自定义面板（世界暂停）；按钮里关闭走 closePanel。
   * 返回 false = 当前状态不能弹（活动 / 竞技场 / 死亡等）。
   */
  showPanel(spec: PanelSpec): boolean {
    if (!this.ready || this.creatorUi || (this.state !== 'play' && this.state !== 'panel')) return false
    if (this.state === 'play') {
      this.state = 'panel'
      this.phone.set(false)
      if (document.pointerLockElement) document.exitPointerLock()
    }
    this.interactions.current = null
    this.panels.show(spec)
    return true
  }
  closePanel() {
    this.panels.hide()
    this.interactions.current = null
    if (this.state === 'panel') { this.state = 'play'; this.unlockHintAt = this.time }
  }

  /** 恢复成长 / 资产 / 产业（旧存档或新开局缺字段 → 默认值），并以当前已完成任务为基线 */
  private restorePhase8(d: Save.SaveData | null) {
    this.progress.restore(d?.progress); this.assets.restore(d?.assets); this.business.restore(d?.biz)
    restoreLedger(d?.wallet)
    this.pluginSaves = { ...(d?.plugins ?? {}) }
    for (const pl of this.plugins) pl.restore?.(this.pluginSaves[pl.id])
  }

  /** 注册娱乐插件：面板按钮 / 手机页立即接上；存档在 restorePhase8 / saveGame 统一处理 */
  addPlugin(pl: GamePlugin) {
    this.plugins.push(pl)
    if (pl.poiButtons) this.interactions.addProvider((p) => pl.poiButtons!(p))
    if (pl.app) { const a = pl.app; this.phone.registerView(a.name, a.title, () => a.view()) }
  }

  // ---------- P10 活动 / 竞技场 ----------
  /**
   * 打开全屏活动（小游戏）：只能在 play / panel 状态打开（从场馆面板按钮里调用最常见）。
   * 世界暂停、HUD 隐藏、手机收起、解除指针锁定；关闭后回到 play（spec.returnToPanel → 重开来源面板）。
   */
  openActivity(spec: ActivitySpec): boolean {
    if (!this.ready || (this.state !== 'play' && this.state !== 'panel') || this.creatorUi) return false
    this.activityPoi = this.state === 'panel' ? this.interactions.current : null
    if (this.state === 'panel') { this.panels.hide(); this.interactions.current = null }
    this.phone.set(false)
    if (document.pointerLockElement) document.exitPointerLock()
    const pending = this.hud.takeToast()   // 打开前刚弹的提示（如“已缴入场税”）转到活动提示条
    this.state = 'activity'
    this.activity.open(spec)
    if (pending && this.activity.isOpen && !this.activity.toastShowing) this.activity.toast(pending.text, pending.seconds)
    return this.state === 'activity' && this.activity.isOpen
  }
  closeActivity() { this.activity.close() }
  private afterActivity(spec: ActivitySpec) {
    if (this.state !== 'activity') return
    this.state = 'play'
    this.unlockHintAt = this.time
    // 不 needs.sync()：活动里 api.skipTime 跳过的小时要照常扣需求（下一步 Needs.update 结算）
    const poi = this.activityPoi
    this.activityPoi = null
    this.input.endFrame()   // 关闭用的 Esc / 点击不再传给世界
    if (spec.returnToPanel && poi) this.openPanel(poi)
  }
  /**
   * 进入竞技场（P10.D）：需要 arenaFactory；城市暂停，state='arena'，主循环改为跑 arena.update/render。
   * 返回 false = 未实现或当前不能进入。
   */
  enterArena(mode: string): boolean {
    if (!this.arenaFactory || this.arena || (this.state !== 'play' && this.state !== 'panel')) return false
    if (this.state === 'panel') { this.panels.hide(); this.interactions.current = null }
    this.phone.set(false)
    this.arena = this.arenaFactory(mode, this)
    this.state = 'arena'
    return true
  }
  /** 退出竞技场：释放会话、回到城市 play（P10.D 在这里恢复 PostFX 场景/相机） */
  exitArena() {
    const a = this.arena; if (!a) return
    this.arena = null
    try { a.dispose() } catch (e) { console.error('[REA] 竞技场释放出错：', e) }
    if (this.state === 'arena') { this.state = 'play'; this.unlockHintAt = this.time }
    this.input.endFrame()
  }

  private pluginSnapshot() {
    for (const pl of this.plugins) if (pl.serialize) this.pluginSaves[pl.id] = pl.serialize()
    return this.pluginSaves
  }

  saveGame(announce: boolean) {
    const ok = Save.save(this.ctx, { jobs: this.jobs.serialize(), quests: this.quests.serialize(), weather: this.weather.serialize(), progress: this.progress.serialize(), assets: this.assets.serialize(), biz: this.business.serialize(), wallet: serializeLedger(), plugins: this.pluginSnapshot() })
    if (announce) this.hud.toast(ok ? '已存档' : '存档失败（浏览器禁止本地存储）')
    return ok !== null
  }
  loadGame() {
    const d = Save.load()
    if (!d) { this.hud.toast('没有存档'); return false }
    if (d.role !== this.role.id) { this.hud.toast(`存档身份是 ${ROLES[d.role].title}，与当前不同`); return false }
    this.jobs.stop()
    Save.apply(this.ctx, d)
    this.jobs.restore(d.jobs); this.quests.init(d.quests); this.weather.restore(d.weather)
    this.restorePhase8(d)
    this.law.reset()
    this.cam.snap(this.player.yaw)
    this.hud.toast(`已读档 · 第${d.day}天 ${this.clock.hhmm}`)
    return true
  }

  /** 主住所门口（设了别的自有房产为主住所 → 它的门口，否则身份自带的家） */
  private homeSpawn() {
    const p = this.pois.byId(this.assets.primaryHome)
    return p ? { ...p.door } : { ...this.homeDoor }
  }
  /** 主住所是否为买下的房产（被捕 / 倒下后回那里而不是警署 / 医院） */
  private get ownHomeSpawn() { return this.assets.ownsHome(this.assets.primaryHome) }

  /** 精力归零：昏倒，次日 07:00 在家（主住所）门口醒来 */
  private faint() {
    if (this.player.vehicle) this.player.exit(this.world)
    this.hud.toast('体力透支，你昏倒了…', 4)
    this.clock.set(7, this.clock.day + 1)
    this.needs.sync()
    this.needs.set(this.needs.hunger, 60)
    const home = this.homeSpawn()
    this.player.place(home.x, home.z, home.yaw)
    this.law.reset()
    this.cam.snap(this.player.yaw)
    this.closePanel()
  }

  private step(dt: number) {
    this.time += dt
    this.ctx.time = this.time
    // 世界流式加载（区块随玩家位置增删）与 POI 名牌远近开关
    const wx = this.player.worldX, wz = this.player.worldZ
    this.source.update(wx, wz, dt)
    this.poiMarkers.update(wx, wz)
    this.ctx.pursuitLevel = this.law.chase ? this.law.pursuitLevel : 0
    this.signals.update(dt)
    // 时钟/天气/昼夜在任何状态下都推进（含开场与死亡）；面板暂停时不走时钟
    if (!worldPaused(this.state)) this.clock.advance(dt)
    this.weather.update(dt, this.ctx)
    this.dayNight.update(dt, this.ctx)
    this.clockHudTimer += dt
    if (this.clockHudTimer >= 1) { this.clockHudTimer = 0; this.hud.clock(`第${this.clock.day}天 ${this.clock.hhmm} · ${WEATHER_LABEL[this.weather.state]}`) }
    const input = this.input
    // 购买 / 重生后的自动存档（每步至多一次）
    if (this.saveDue && this.state !== 'intro' && this.state !== 'creator') { this.saveDue = false; this.saveGame(false) }

    if (this.state === 'intro') {
      if (input.anyKeyPressed || input.clicked) this.beginPlay()
      return
    }
    if (this.state === 'creator') return
    if (this.state === 'panel') {
      // 面板：世界暂停，只响应 Esc / 关闭按钮；数值变化仍刷新 HUD
      if (input.justPressed('Escape')) this.closePanel()
      input.takeMouse()
      this.updateHud(dt)
      return
    }
    if (input.justPressed('Tab') && (this.state === 'play' || this.state === 'won')) this.phone.toggle()
    if (this.state === 'won' && (input.anyKeyPressed || input.clicked) && this.stateTimer > 1) { this.state = 'play'; this.hud.hideOverlay() }
    const mouse = input.takeMouse()
    if (playingNow(this.state)) this.cam.applyMouse(mouse.dx, mouse.dy)
    if (this.state === 'dead' || this.state === 'busted') {
      this.stateTimer += dt
      if (this.stateTimer > 3) this.respawn()
    }
    this.stateTimer += this.state === 'won' ? dt : 0
    const playing = this.state === 'play'
    // 手机打开时屏蔽移动/射击/交互输入（游戏不暂停）
    const control = playing && !this.phone.open

    // 需求：按游戏小时推进；低需求减速 + 暗角；精力归零昏倒
    const fainted = this.needs.update(this.player.running)
    this.player.speedMul = this.needs.speedMul
    this.hud.vignette(this.needs.low)
    if (fainted && playing) { this.faint(); return }

    // 醉意（夜店插件经 law.drunkLevel 提供）：清醒 = 0；醉驾标准 2.5 单位约 0.36，6 单位以上 = 1
    const drunkLv = this.law.drunkLevel()
    this.player.drunk = drunkLv > 0.5 ? Math.min(1, (drunkLv - 0.5) / 5.5) : 0
    if (playing) this.updateDrunkPatrol(dt)

    // 玩家输入与上下车
    const gun = this.role.systems.gun
    this.player.aiming = control && gun && (input.locked || this.forceAim) && !this.player.inVehicle
    this.player.update(dt, input, this.cam.yaw, this.world, control)
    this.weapon.update(dt)
    if (control && gun && (input.mouseDown(0) || input.down('ControlLeft')) && this.weapon.ready) this.shoot()
    if (control && input.justPressed('KeyF') && !this.jobs.keyF(this.ctx)) this.toggleVehicle()
    this.interactions.update()
    if (control && input.justPressed('KeyH') && this.player.vehicle) this.audio.horn(true, this.player.vehicle.kind === 'bus')
    if (control && input.justPressed('KeyE') && this.interactions.near) { this.openPanel(this.interactions.near); return }
    if (playing && input.justPressed('KeyM')) this.hud.toast(this.quests.active ? `任务「${this.quests.active.title}」：${this.quests.stepLabel()}` : `任务 ${this.quests.completed}/${this.quests.defs.length} · 黄色标记接任务 · Tab 手机开工`, 3)
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
    this.jobs.update(dt, this.ctx)
    this.quests.update(dt)
    this.assets.update(dt)
    this.business.update(dt)
    this.progress.update(dt)
    for (const pl of this.plugins) pl.update?.(dt)

    if (playing) {
      if (this.player.health <= 0) this.enterState('dead')
      else if (this.law.policeStars > 0) {
        const pl = this.player
        const near = this.vehicles.some((v) => v.active && v.driver === 'police' && !v.wrecked && v.absSpeed < 8 && Math.hypot(v.x - pl.worldX, v.z - pl.worldZ) < (pl.inVehicle ? 6.5 : 3.4))
        if (!pl.inVehicle && near) this.enterState('busted')
        else if (pl.inVehicle && near && pl.vehicle!.absSpeed < 4) {
          // 在车里几乎不动且被警车贴住一段时间（宽松 4 s / real 2.5 s）→ 被拖下车逮捕
          this.bustTimer += dt
          if (this.bustTimer > lawTuning(this.ctx).bustTime) this.enterState('busted')
        } else this.bustTimer = Math.max(0, this.bustTimer - dt * 0.5)
      } else this.bustTimer = 0
      if (this.quests.allDone && !this.progress.storyShown) {
        this.progress.storyShown = true; this.saveDue = true; this.state = 'won'; this.stateTimer = 0
        this.hud.showOverlay('故事线完成 · 帝国目标已解锁', `${this.role.title}线故事任务全部完成 · 账户 $${this.player.money.toLocaleString()} · 打开手机「生意」经营你的产业帝国`, 'gold', false, '按任意键继续')
      } else if (this.state === 'play' && !this.progress.empireShown && this.quests.empireDone()) {
        this.progress.empireShown = true; this.saveDue = true
        this.state = 'won'; this.stateTimer = 0
        this.hud.showOverlay('帝国落成', this.empireSummary(), 'gold', false, '按任意键继续')
      }
    }

    // 相机与同步
    const target = this.player.vehicle ?? this.player
    const moving = this.player.inVehicle ? Math.abs(this.player.vehicle!.speed) > 1 : Math.hypot(this.player.vx, this.player.vz) > 0.5
    if (this.camShot) { this.cam.camera.position.fromArray(this.camShot, 0); this.cam.camera.lookAt(this.camShot[3], this.camShot[4], this.camShot[5]) }
    else this.cam.update(dt, this.player.inVehicle ? 'car' : 'foot', target, this.player.vehicle?.speed ?? 0, this.time, moving, this.state === 'play' && (this.input.locked || this.forceAim), this.player.vehicle?.halfLen ?? 2.3)
    this.player.sync()
    for (const v of this.vehicles) if (v.active) v.sync(this.time)
    this.jobs.sync(this.time); this.quests.sync(this.time, this.jobs.targetPoint !== null)
    this.updateHud(dt)
  }

  /** 酒驾路检：醉驾超标且附近没有警车时，每开 15–30 s 在前方约 90 m 的路边停一辆警车（被它看到 → Law 酒驾查处） */
  private drunkPatrol: Vehicle | null = null
  private drunkPatrolT = 0
  private updateDrunkPatrol(dt: number) {
    const pl = this.player, v = pl.vehicle
    const pv = this.drunkPatrol
    if (pv && pv.active && pv.driver === 'none' && Math.hypot(pv.x - pl.worldX, pv.z - pl.worldZ) > 300) { pv.deactivate() }
    if (!v || !this.law.drunk || this.law.trafficExempt || v.absSpeed < 5) { this.drunkPatrolT = 0; return }
    if (pv?.active && pv.driver === 'none') return
    if (this.law.policeDist(this.ctx) < 150) return
    this.drunkPatrolT += dt
    if (this.drunkPatrolT < 15) return
    const fx = Math.sin(v.yaw), fz = Math.cos(v.yaw)
    // 前方 90 / 60 / 40 m 依次找路：停在行驶侧路缘外（车道外缘 + 1 m），不挡车流；被小件道具（路灯 / 树）以外的静态体挡住就前后挪一挪
    for (const ahead of [90, 60, 40]) {
      const lane = this.graph.nearestLane(v.x + fx * ahead, v.z + fz * ahead, fx, fz)
      if (!(lane.dist <= 40)) continue
      const e = lane.edge, off = DRIVE_SIDE * (e.lanes * e.laneW + 1), back = DRIVE_SIDE * 0.5 * e.laneW
      for (const dt0 of [0, 12, -12, 24]) {
        const t = Math.max(4, Math.min(e.length - 4, lane.t + dt0))
        const c = this.graph.lanePoint(e, t, { x: 0, z: 0 }, 0), d = this.graph.dirAt(e, t, { x: 0, z: 0 })
        const x = c.x + d.z * back - d.z * off, z = c.z - d.x * back + d.x * off
        if (this.world.contains(x, z) || this.world.query(x, z, 1.4, tmpBoxes).some((b) => (b.maxX - b.minX >= 1.5 || b.maxZ - b.minZ >= 1.5) && circleBody(x, z, 1.4, b) !== null)) continue
        const car = this.spawner.spawnOwned(this.ctx, 'drunk_patrol', x, z, Math.atan2(d.x, d.z), { kind: 'police', color: 0xf4f4f4, model: 'sedan' })
        car.driver = 'none'; car.controls.handbrake = true
        this.drunkPatrol = car
        this.drunkPatrolT = -Math.random() * 15   // 下一次设卡至少再开 15–30 s
        return
      }
    }
    this.drunkPatrolT = 10   // 没找到地方停：5 s 后再试
  }

  /** 帝国总结：头衔、净资产、产业数、终身统计 */
  private empireSummary() {
    const st = this.progress.stats, usd = (n: number) => `$${Math.round(n).toLocaleString()}`
    return [
      `Lv${this.progress.level} ${this.progress.title} · 净资产 ${usd(this.wallet.netWorth())} · 产业 ${this.business.list().length} 个`,
      `累计收入 ${usd(st.earned)} · 产业收入 ${usd(st.bizIncome)} · 累计花费 ${usd(st.spent)} · 净资产峰值 ${usd(st.peakNetWorth)}`,
      `第 ${st.daysPlayed} 天 · 里程 ${st.distanceKm.toFixed(1)} km · 的士 ${st.trips} 趟 · 被捕 ${st.arrests} 次 · 成就 ${this.progress.achievements.size}/${ACHIEVEMENTS.length}`,
    ].join('\n')
  }

  private enterState(s: State) {
    this.state = s; this.stateTimer = 0
    this.jobs.onPlayerDown(); this.quests.onPlayerDown()
    if (s === 'dead') this.hud.showOverlay('WASTED', '你倒下了，正在送往医院…', 'red', false, '')
    else this.hud.showOverlay('BUSTED', '被捕了，罚金 10%…', 'red', false, '')
  }

  private respawn() {
    if (this.player.vehicle) this.player.exit(this.world)
    this.player.health = 100
    const fine = Math.ceil(Math.max(0, this.player.money) * 0.1)
    const busted = this.state === 'busted'
    if (busted) { this.law.fines += fine; this.law.arrests++ }
    charge(this.ctx, fine, busted ? 'fine:bust' : 'medical')
    this.needs.addMood(busted ? MOOD.busted : MOOD.dead)
    // 黑帮产业：被捕 / 倒下时各处钱柜被卷走
    this.business.onBustOrDeath()
    for (const pl of this.plugins) pl.onBustOrDeath?.()
    // 主住所是买下的房产 → 在那里醒来；否则倒下 → 医院门口，被捕 → 警署门口
    const ownHome = this.ownHomeSpawn
    const d = ownHome ? this.homeSpawn() : busted ? this.policeDoor : this.hospitalDoor
    this.player.place(d.x, d.z, d.yaw)
    this.law.reset()
    for (const v of this.vehicles) if (v.driver === 'police') { v.deactivate() }
    this.cam.snap(this.player.yaw)
    this.state = 'play'
    this.hud.hideOverlay()
    this.hud.toast(busted ? `交了罚金，被释放${ownHome ? ' · 回到主住所' : ''}` : ownHome ? '在主住所醒来' : '在医院醒来', 2)
    this.saveDue = true
  }

  private shoot() {
    this.player.onShoot()
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

  /** 当前这次 vehicleHitVehicle 里玩家是否肇事（resolveCollisions 发事件前写入，事件同步处理） */
  private hitByPlayerFault = true
  /** 对方车 → 上次因撞它计罪的时刻（3 s 冷却） */
  private crimeHitAt = new WeakMap<Vehicle, number>()

  /**
   * 肇事方判定（用碰撞前速度）：玩家车朝对方的接近速度 < 对方朝玩家的接近速度 → 玩家是被撞的一方；
   * 追撞模式（ram）的警车撞上来也不算玩家的错。
   */
  private playerAtFault(a: Vehicle, b: Vehicle, avx: number, avz: number, bvx: number, bvz: number) {
    const mineA = a.driver === 'player'
    const other = mineA ? b : a
    if (other.driver === 'police' && (other.ai as { mode?: string } | null)?.mode === 'ram') return false
    let nx = b.x - a.x, nz = b.z - a.z
    const d = Math.hypot(nx, nz) || 1
    nx /= d; nz /= d
    const aClose = avx * nx + avz * nz, bClose = -(bvx * nx + bvz * nz)   // 各自朝对方的速度分量
    return mineA ? aClose >= bClose : bClose >= aClose
  }

  private resolveCollisions() {
    const V = this.vehicles
    // 车 vs 静态：每辆车每帧只按最大冲量结算一次伤害/事件（多个碰撞圆同时擦到不重复计）
    for (const v of V) {
      if (!v.active || v.kinematic) continue
      let maxImp = 0
      for (let i = 0; i < v.circleCount; i++) {
        v.circle(i, c0)
        for (const b of this.world.query(c0.x, c0.z, v.radius, tmpBoxes)) {
          const c = circleBody(c0.x, c0.z, v.radius, b)
          if (!c) continue
          const imp = pushOut(v, c, 0.25)
          if (imp > maxImp) maxImp = imp
          // 撞墙后轻微转开，避免卡死（力度减半：擦到路灯不再明显甩头）
          v.yaw += (c.nx * Math.cos(v.yaw) - c.nz * Math.sin(v.yaw)) * 0.01 * (i === 0 ? 1 : -1)
          v.circle(i, c0)
        }
      }
      if (maxImp > 2.5) {
        this.hitVehicle(v, (maxImp - 2.5) * 2.2, false)
        this.events.emit('vehicleHitStatic', { v, impulse: maxImp })
        if (v.driver === 'player') this.audio.crash(maxImp)
      }
    }
    // 车 vs 车：物理响应逐圆对计算，伤害/事件每对车每帧只结算一次（取最大冲量；巴士 4 圆 × 4 圆不再多次计罪）
    for (let i = 0; i < V.length; i++) {
      const a = V[i]; if (!a.active) continue
      for (let j = i + 1; j < V.length; j++) {
        const b = V[j]; if (!b.active) continue
        const dx = a.x - b.x, dz = a.z - b.z
        if (dx * dx + dz * dz > (a.halfLen + b.halfLen + 2.4) ** 2) continue
        const avx = a.vx, avz = a.vz, bvx = b.vx, bvz = b.vz
        let maxImp = 0
        for (let ia = 0; ia < a.circleCount; ia++) for (let ib = 0; ib < b.circleCount; ib++) {
          a.circle(ia, c0); b.circle(ib, c1)
          const imp = circleCircle(a, a.radius, a.mass, b, b.radius, b.mass, 0.3, c0.x, c0.z, c1.x, c1.z)
          if (imp > maxImp) maxImp = imp
        }
        if (maxImp <= 2) continue
        const byPlayer = a.driver === 'player' || b.driver === 'player'
        const fault = byPlayer && this.playerAtFault(a, b, avx, avz, bvx, bvz)
        // 玩家车结实（1.2×），被玩家撞的车脆（3.5×），NPC 互撞伤害低（0.8×）避免车流自毁
        const scaleFor = (v: Vehicle) => (v.driver === 'player' ? 1.2 : byPlayer ? 3.5 : 0.8)
        this.hitVehicle(a, (maxImp - 2) * scaleFor(a), fault && b.driver === 'player')
        this.hitVehicle(b, (maxImp - 2) * scaleFor(b), fault && a.driver === 'player')
        this.hitByPlayerFault = fault
        this.events.emit('vehicleHitVehicle', { a, b, impulse: maxImp })
        this.hitByPlayerFault = true
        if (byPlayer) this.audio.crash(maxImp)
        // 被明显撞到的交通车改为物理滑行
        if (maxImp > 4) { if (a.driver === 'traffic') this.trafficAI.knock(a); if (b.driver === 'traffic') this.trafficAI.knock(b) }
      }
    }
    // 步行玩家 vs 车
    const pl = this.player
    if (!pl.inVehicle) {
      for (const v of V) {
        if (!v.active) continue
        const dx = v.x - pl.x, dz = v.z - pl.z
        if (dx * dx + dz * dz > (v.halfLen + 2.7) ** 2) continue
        for (let i = 0; i < v.circleCount; i++) {
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
    v.damage(amount * v.damageMul)
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
      if (this.phone.open) hint = null
      else if (!this.input.locked && this.time - this.unlockHintAt < 4) hint = '点击画面锁定鼠标，转动视角（Esc 解锁）'
      else if (this.jobs.canBoardTaxi) hint = '按 F 上客'
      else if (this.interactions.hint) hint = this.interactions.hint
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
    // 目标优先级：进行中的工作 > 任务 > 被动工作（打卡/投资 → 最近办公楼）
    const target = this.pluginTarget() ?? this.jobs.targetPoint ?? this.quests.targetPoint ?? this.business.navTarget ?? this.jobs.passiveTarget
    this.minimap.draw(pl.worldX, pl.worldZ, this.cam.yaw, target, this.quests.starts, police, this.quests.carPoint, this.hospital, this.pois.all, pl.health, this.business.points(), this.pluginPath())
    this.phoneTimer += dt
    if (this.phone.open && this.phoneTimer >= 0.25) {
      this.phoneTimer = 0
      const q = this.quests.active ? { title: this.quests.active.title, step: this.quests.stepLabel() } : null
      this.phone.update({ timeText: `第${this.clock.day}天 ${this.clock.hhmm} · ${WEATHER_LABEL[this.weather.state]}`, money: pl.money, roleTitle: this.role.title, lawText: lawParts.join(' · '), hunger: this.needs.hunger, energy: this.needs.energy, mood: this.needs.mood, timeSpeed: this.settings.timeSpeed, shadows: this.settings.shadows, music: this.settings.music, fx: this.settings.fx, brightness: this.settings.brightness, work: this.jobs.view(), quest: q })
    }
    const speedKmh = pl.vehicle ? pl.vehicle.speed * 3.6 : null
    const dbg = `${this.fps.toFixed(0)} fps · peds ${this.peds.activeCount} · cars ${this.vehicles.filter((v) => v.active).length} · draw ${this.renderer.info.render.calls}\n视口 ${window.innerWidth}×${window.innerHeight} @${window.devicePixelRatio.toFixed(2)} · 窗口 ${window.outerWidth}×${window.outerHeight} · 屏幕 ${screen.width}×${screen.height}${document.fullscreenElement ? ' · 全屏' : ''}${this.input.locked ? ' · 鼠标锁定' : ''}`
    this.hud.update(dt, pl.health, pl.money, this.law.stars, this.law.flash, speedKmh, this.missionCard(), dbg)
    this.hud.level(`Lv${this.progress.level} ${this.progress.title}`, this.progress.pct)
    this.hud.netWorth(this.wallet.netWorth())
    this.hud.mood(this.needs.mood, this.needs.moodMul)
    this.audio.update(this.time, pl.inVehicle, pl.vehicle?.speed ?? 0, pl.vehicle?.controls.throttle ?? 0, this.law.policeStars, policeDist)
    this.audio.ambient(this.ctx, dt)
  }

  private pluginTarget() {
    for (const pl of this.plugins) { const t = pl.navTarget?.(); if (t) return t }
    return null
  }
  /** 插件导航折线（赛道线）：第一个非空的 */
  private pluginPath() {
    for (const pl of this.plugins) { const p = pl.navPath?.(); if (p && p.length > 1) return p }
    return null
  }

  /** HUD 底部任务卡：进行中的工作优先，任务作为副行 */
  private missionCard() {
    for (const pl of this.plugins) { const c = pl.hudCard?.(); if (c) return c }
    const job = this.jobs.hudCard(), quest = this.quests.hudCard()
    if (job) return { ...job, sub: quest && this.quests.active ? `任务：${quest.desc}` : undefined }
    return quest
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
      this.jobs.sync(performance.now() / 1000); this.quests.sync(performance.now() / 1000)
      this.time += dt; this.ctx.time = this.time
    }
    this.frames++; this.fpsTimer += dt
    if (this.fpsTimer >= 0.5) { this.fps = this.frames / this.fpsTimer; this.frames = 0; this.fpsTimer = 0 }
    if (this.signalLights) this.signals.applyToMesh(this.signalLights.mesh, this.signalLights.edgeIds)
    // 骨骼动画按渲染帧推进（面板暂停时冻结）；行人 LOD 用相机位置与视锥
    if (!worldPaused(this.state)) {
      this.player.animate(dt)
      this.cam.camera.updateMatrixWorld()
      this.peds.animate(dt, this.cam.camera)
    }
    if (this.postfx) {
      this.postfx.setGrade(this.dayNight.grade)
      this.postfx.render(dt)
    } else this.renderer.render(this.scene, this.cam.camera)
  }

  private exposeDebug() {
    const self = this
    ;(window as unknown as { __game: unknown }).__game = {
      get ready() { return self.ready },
      get state() { return self.state },
      get stats() { return { fps: self.fps, peds: self.peds.activeCount, cars: self.vehicles.filter((v) => v.active).length, drawCalls: self.renderer.info.render.calls, triangles: self.renderer.info.render.triangles, time: self.time } },
      /** 骨骼角色：玩家当前动画 / 外观 / 行人 LOD 与动画分布 */
      get chars() {
        const pc = self.player.char
        const clips: Record<string, number> = {}
        for (const p of self.peds.peds) if (p.active && self.peds.chars[p.idx]) { const k = self.peds.chars[p.idx].current ?? '-'; clips[k] = (clips[k] ?? 0) + 1 }
        return {
          mode: self.charLib ? 'gltf' : 'box', playerClip: pc?.current ?? null, playerSpec: pc?.spec ?? null, playerVisible: self.player.group.visible,
          tint: pc ? (pc.mesh.material as THREE.MeshStandardMaterial).emissive.getHexString() : null,
          gunVisible: self.player.showGun, name: self.playerName, pedLod: { ...self.peds.lodStats }, pedClips: clips,
          pedSpecs: new Set(self.peds.chars.map((c) => c.spec.parts.body + c.spec.colors.top)).size,
        }
      },
      creator: {
        get open() { return !!self.creatorUi?.isOpen },
        get ui() { return self.creatorUi },
        state() { return self.creatorUi?.state() ?? null },
      },
      wardrobe() { return self.openWardrobe() },
      /** 测试：相机固定在玩家相对位置看向相对点；null 恢复 */
      camShot(rel: number[] | null) { self.camShotRel = rel },
      /** 测试：把所有活动行人挪到玩家 r 米内的人行道上（压测 LOD / 截图） */
      gatherPeds(r = 30) {
        const px = self.player.worldX, pz = self.player.worldZ, tmp = { x: 0, z: 0 }
        let n = 0
        for (const p of self.peds.peds) {
          if (!p.active || p.state === 'hail') continue
          for (let k = 0; k < 20; k++) {
            const e = self.graph.randomEdgeNear(px, pz, r)
            if (!e) break
            const t = Math.random() * e.length
            self.graph.sidewalkPoint(e, t, tmp)
            if (Math.hypot(tmp.x - px, tmp.z - pz) > r) continue
            p.x = tmp.x; p.z = tmp.z; p.edge = e; p.t = t; p.state = 'walk'; n++
            break
          }
        }
        return n
      },
      pedInfo(i: number) { const p = self.peds.peds[i], c = self.peds.chars[i]; return { active: p.active, state: p.state, x: p.x, z: p.z, clip: c?.current ?? null, visible: c?.group.visible ?? null } },
      /** 测试：哪些行人在招手 / 招手者的动画 */
      get hailing() { return self.peds.peds.filter((p) => p.active && p.state === 'hail').map((p) => ({ idx: p.idx, clip: self.peds.chars[p.idx]?.current ?? null, visible: self.peds.chars[p.idx]?.group.visible ?? null })) },
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
        /** 酒驾：醉意 / 是否超标 / 被查次数 / 玩家醉意系数 / 路检警车位置 */
        get drunk() { const p = self.drunkPatrol; return { level: self.law.drunkLevel(), over: self.law.drunk, tickets: self.law.drunkTickets, factor: self.player.drunk, patrol: p?.active ? { x: p.x, z: p.z, driver: p.driver } : null, patrolTimer: +self.drunkPatrolT.toFixed(2) } },
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
        /** 测试用：离 (x,z) 最近的车道点与行驶方向 */
        nearestLane(x: number, z: number) { const n = self.graph.nearestLane(x, z); const p = self.graph.lanePoint(n.edge, n.t, { x: 0, z: 0 }); const d = self.graph.dirAt(n.edge, n.t, { x: 0, z: 0 }); return { x: p.x, z: p.z, dx: d.x, dz: d.z, edge: n.edge.id, t: n.t } },
      },
      /** 兼容旧测试：映射到 quests */
      get missions() { return { active: self.quests.active?.id ?? null, completed: self.quests.completed, timer: self.quests.timer, progress: self.quests.progress } },
      jobs: {
        get list() { return self.jobs.view().jobs },
        start(id: string) { return self.jobs.start(id) },
        stop() { self.jobs.stop() },
        get active() { return self.jobs.active?.id ?? null },
        get state() { return { stats: self.jobs.stats, taxi: self.jobs.taxiState, lastTrip: self.jobs.lastTrip, stealTarget: self.jobs.stealTarget, target: self.jobs.targetPoint, passiveTarget: self.jobs.passiveTarget, canBoard: self.jobs.canBoardTaxi, hud: self.jobs.hudCard() } },
        buy(asset: AssetId, amount: number) { return self.jobs.buy(asset, amount) },
        sell(asset: AssetId) { return self.jobs.sell(asset) },
        fare(dist: number, wait: number, peak: boolean, rating: number) { return taxiFare(dist, wait, peak, rating) },
      },
      quests: {
        get list() { return self.quests.defs.map((q) => ({ id: q.id, title: q.title, giver: q.giver, steps: q.steps.length, done: self.quests.done.has(q.id) })) },
        get active() { return self.quests.active?.id ?? null },
        get step() { return self.quests.step },
        get stepLabel() { return self.quests.stepLabel() },
        get progress() { return self.quests.progress },
        get timer() { return self.quests.timer },
        get target() { return self.quests.targetPoint },
        get done() { return [...self.quests.done] },
        start(id: string) { const q = self.quests.byId(id); if (!q) return false; self.quests.begin(q); return true },
        /** 测试用：跳过当前步骤 */
        complete() { self.quests.advance() },
      },
      get police() { return self.vehicles.filter((v) => v.active && v.driver === 'police').map((v) => ({ x: v.x, z: v.z, mode: (v.ai as { mode: string } | null)?.mode })) },
      get cars() { return self.vehicles.filter((v) => v.active).map((v) => ({ kind: v.kind, driver: v.driver, speed: +v.speed.toFixed(1), health: v.health, wrecked: v.wrecked, x: +v.x.toFixed(1), z: +v.z.toFixed(1), yaw: +v.yaw.toFixed(2), vx: +v.vx.toFixed(1), vz: +v.vz.toFixed(1), stuck: (v.ai as { stuck?: number } | null)?.stuck ?? 0, dbg: (v.ai as { dbg?: string } | null)?.dbg ?? '' })) },
      get missionCar() { const m = self.quests.missionCar; return { active: m.active, x: m.x, z: m.z } },
      get missionDefs() { return self.quests.defs.map((d) => ({ id: d.id, giver: d.giver, done: self.quests.done.has(d.id) })) },
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
      /** 世界数据源：kind / 流式加载统计 / 边界；loadMs = 启动到 init 完成，firstLoadMs = 首个 5×5 区块全部构建 */
      get world() {
        const s = self.source
        return { kind: s.kind, stats: { ...s.stats, firstLoadMs: s.firstLoadMs ?? 0, loadMs: self.readyAt ? Math.round(self.readyAt - self.bootAt) : -1, labels: self.poiMarkers?.visibleLabels ?? 0 }, bounds: { ...s.bounds } }
      },
      /** 文字街景（sg 世界）：统计 + 按 key 前缀查激活招牌位置（截图定位用） */
      get signs() {
        const sg = (self.source as { signs?: import('../world/Signage').Signage | null }).signs
        return sg ? {
          stats: sg.stats,
          find: (prefix: string, limit?: number) => sg.find(prefix, limit),
          /** 站到第 i 块（key 前缀）招牌正前方 dist 米、面朝招牌 */
          view: (prefix: string, i = 0, dist = 9) => {
            const g = sg.find(prefix, i + 1)[i]; if (!g) return null
            const yaw = Math.atan2(-g.nx, -g.nz)
            self.player.place(g.x + g.nx * dist, g.z + g.nz * dist, yaw); self.cam.snap(yaw)
            return g
          },
        } : null
      },
      /** 传送到某 POI 门口（下车、面向门口朝向）；返回是否成功 */
      teleportTo(poiId: string) {
        const p = self.pois.byId(poiId); if (!p) return false
        if (self.player.vehicle) self.player.exit(self.world)
        self.player.place(p.door.x, p.door.z, p.door.yaw)
        self.cam.snap(p.door.yaw)
        return true
      },
      /** 测试：路网对象（只读调试用） */
      get graph() { return self.graph },
      /** 测试：点是否在某个静态体（建筑多边形等）内 */
      inside(x: number, z: number) { return self.world.contains(x, z) },
      get settings() { return self.settings },
      /** 后期画质：fx.set('high'|'low'|'off')；fx.grade 当前调色参数 */
      bright: { set(v: number) { self.settings.brightness = clampBrightness(v) }, get value() { return self.settings.brightness } },
      get nightLights() { return self.dayNight.nightLights.stats },
      fx: { set(q: FxQuality) { self.setFx(q) }, get quality() { return self.postfx?.quality ?? 'off' }, get grade() { return self.dayNight.grade }, get exposure() { return self.renderer.toneMappingExposure }, get envIntensity() { return self.scene.environmentIntensity } },
      audio: { get state() { return self.audio.state }, get musicMode() { return self.audio.musicMode }, get crashCount() { return self.audio.crashCount } },
      clock: {
        set(hour: number, day?: number) { self.clock.set(hour, day) },
        skip(hours: number) { self.clock.skip(hours) },
        get hour() { return self.clock.hour }, get day() { return self.clock.day },
        get hhmm() { return self.clock.hhmm }, get phase() { return self.clock.phase },
        get speed() { return self.clock.speed }, set speed(v: number) { self.clock.speed = v },
      },
      weather: {
        /** 调试：手动指定天气并锁定 lockHours 游戏小时（默认 3），调时钟/整点不会重掷 */
        set(s: 'clear' | 'cloudy' | 'storm', lockHours = 3) { self.weather.set(s, true, lockHours) },
        get state() { return self.weather.state }, get locked() { return self.weather.locked }, get gloom() { return self.weather.gloom }, get rain() { return self.weather.rainIntensity }, get wet() { return self.weather.wet }, get flash() { return self.dayNight.flash },
      },
      needs: {
        get hunger() { return self.needs.hunger }, get energy() { return self.needs.energy },
        set(h: number, e: number) { self.needs.set(h, e) },
        /** 心情 0–100（可写）；moodMul = XP / 工资倍率 */
        get mood() { return self.needs.mood }, set mood(v: number) { self.needs.mood = v },
        get moodMul() { return self.needs.moodMul },
      },
      /** P10 娱乐场馆：list（含门口 / 是否营业）、tp(id) 传送到门口、open(id) 直接打开面板 */
      venues: {
        list() {
          return VENUES.map((v) => { const p = self.pois.byId(v.id); return { id: v.id, type: v.type, name: v.name, hours: hoursText(v), open: venueOpen(v, self.clock.hour), door: p ? { ...p.door } : null } })
        },
        tp(id: string) {
          const p = self.pois.byId(id); if (!p || !venueOf(p)) return false
          if (self.state === 'panel') self.closePanel()
          if (self.player.vehicle) self.player.exit(self.world)
          self.player.place(p.door.x, p.door.z, p.door.yaw); self.cam.snap(p.door.yaw)
          return true
        },
      },
      /** P10 活动宿主：open(spec) / close() / state */
      activity: {
        open(spec: ActivitySpec) { if (self.state === 'intro') self['beginPlay'](); return self.openActivity(spec) },
        close() { self.closeActivity() },
        get isOpen() { return self.activity.isOpen },
        get id() { return self.activity.current?.id ?? null },
      },
      arena: { enter(mode: string) { return self.enterArena(mode) }, exit() { self.exitArena() }, get active() { return self.arena?.mode ?? null } },
      /** P10 钱包分类账：flow(cat, 'today'|'total')、ledger() 原始数据 */
      wallet: {
        flow(cat: Parameters<Wallet['flow']>[0], scope: 'today' | 'total' = 'today') { return self.wallet.flow(cat, scope) },
        ledger() { return serializeLedger() },
        spend(amt: number, why: string) { return self.wallet.spend(amt, why) },
        earn(amt: number, src: string) { return self.wallet.earn(amt, src) },
      },
      /** 测试：交互系统（addProvider 联调用） */
      get interactions() { return self.interactions },
      /** 测试：发一个游戏事件（P10 事件联调用） */
      emit(k: string, e: unknown) { self.events.emit(k as never, e as never) },
      pois: {
        list() { return self.pois.all.map((p) => ({ id: p.id, type: p.type, name: p.name, x: p.x, z: p.z, door: p.door })) },
        get near() { return self.interactions.near?.id ?? null },
      },
      interact(poiId: string) { const p = self.pois.byId(poiId); if (!p) return false; if (self.state === 'intro') self['beginPlay'](); if (self.state === 'panel') self.closePanel(); self.openPanel(p); return self.state === 'panel' },
      panel: {
        get open() { return self.panels.open },
        get labels() { return self.panels.labels },
        choose(index: number) { return self.panels.choose(index) },
        close() { self.closePanel() },
      },
      phone: { get open() { return self.phone.open }, get sub() { return self.phone.subPage }, toggle() { self.phone.toggle() }, show(sub: 'work' | 'map' | 'settings' | 'progress' | 'shop' | 'biz' | 'wallet' | null) { self.phone.set(true); self.phone.showSub(sub) } },
      /** 成长：等级 / XP / 头衔 / 终身统计 / 成就；addXp 测试加经验 */
      progress: {
        get level() { return self.progress.level }, get xp() { return self.progress.xp }, get need() { return self.progress.need },
        get title() { return self.progress.title }, get stats() { return self.progress.stats },
        get achievements() { return [...self.progress.achievements] },
        get empireShown() { return self.progress.empireShown }, get storyShown() { return self.progress.storyShown },
        addXp(n: number) { self.progress.addXp(n); return self.progress.level },
      },
      /** 测试：直接设置现金（不计入终身收支） */
      money(n: number) { self.player.money = n; self.progress.resync(); return n },
      get netWorth() { return self.wallet.netWorth() },
      /** 商店 / 资产：catalog, owned, buy, setHome, spawnCar, garage… */
      get shop() { return self.assets.debug },
      get biz() { return self.business.debugApi() },
      save() { return self.saveGame(false) },
      /** P10 插件测试钩子：__game.plug.casino / race / club / arena */
      get plug() { const o: Record<string, unknown> = {}; for (const pl of self.plugins) o[pl.id] = pl.debug?.() ?? pl; return o },
      load() { return self.loadGame() },
      get dayNight() { const d = self.dayNight; return { sunIntensity: d.sun.intensity, hemiIntensity: d.hemi.intensity, lights: d.lights, gloom: d.gloom, shadows: self.renderer.shadowMap.enabled, sunDir: d.sun.position.clone().sub(d.sun.target.position).normalize().toArray().map((n) => +n.toFixed(2)) } },
    }
  }
}
