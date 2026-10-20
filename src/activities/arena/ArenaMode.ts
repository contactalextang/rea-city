import * as THREE from 'three'
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js'
import type { Game, ArenaSession } from '../../core/Game'
import type { Input } from '../../core/Input'
import { LOOK } from '../../core/LookUniforms'
import { defaultGrade } from '../../core/PostFX'
import { earn } from '../../systems/Wallet'
import {
  WEAPONS, EQUIP, BUY_MENU, ECON, TIMES, MATCH, MODES, BOT_NAMES_T, BOT_NAMES_CT, GRENADE_NAMES, recoilAt,
  type ArenaModeId, type Difficulty, type Side,
} from '../../data/arena'
import { ArenaMap } from './ArenaMap'
import { Actor, WeaponState, STAND_H, CROUCH_H } from './Actor'
import { ActorVisual } from './Actor'
import { Effects, Viewmodel, traceShot, computeDamage, inaccuracy, shotDir, headCenter, chestPoint, type ShotResult } from './ArenaWeapons'
import { ArenaHud, type ScoreRow, type RadarDot, type BuyItem } from './ArenaHud'
import { ArenaSfx } from './ArenaSfx'
import { Grenades, type NadeKind } from './Grenades'
import { Bot, inSite, type BotWorld, type BotOut, type BombInfo, type SoundEvent } from './Bot'
import { SPAWNS, BUY_ZONES, HOLDS, toCell, type SiteId } from './layout'

export interface MatchResult {
  mode: ArenaModeId; won: boolean; draw: boolean; surrender: boolean
  kills: number; deaths: number; assists: number; headshots: number; mvps: number
  scoreUs: number; scoreThem: number; prize: number
}
export interface ArenaOptions {
  /** 敌方 5 个 bot 难度（1v1 取第一个） */
  enemyDiff: Difficulty[]
  mateDiff: Difficulty
  /** 结算回调：返回附加显示行（段位变化等） */
  onResult: (r: MatchResult) => string[]
}

type Phase = 'freeze' | 'live' | 'end' | 'over'
const D2R = Math.PI / 180
const SUB = 1 / 120
const _v = new THREE.Vector3(), _v2 = new THREE.Vector3(), _muz = new THREE.Vector3(), _sz = new THREE.Vector2()
const shot: ShotResult = { victim: null, group: null, point: new THREE.Vector3(), normal: new THREE.Vector3(), dist: 0, boxKind: '' }
const WNAME: Record<string, string> = { knife: '刀', glock: 'Glock', usp: 'USP-S', deagle: '沙鹰', mac10: 'MAC-10', mp9: 'MP9', nova: 'Nova', ak47: 'AK-47', m4a4: 'M4A4', awp: 'AWP', he: '手雷', c4: 'C4', world: '摔落' }

/**
 * 射击竞技会话：独立 Scene / 相机 / 碰撞体，Game 在 state='arena' 期间每帧调用 update + render。
 * 规则：MR12 缩短版（先赢 7，6 回合换边）；冻结 15 s → 1:55 → 下包 40 s / 拆包 10 s（钳子 5 s）→ 回合结束 5 s。
 */
export class ArenaMode implements ArenaSession, BotWorld {
  readonly mode: ArenaModeId
  readonly scene = new THREE.Scene()
  readonly camera: THREE.PerspectiveCamera
  map: ArenaMap
  actors: Actor[] = []
  bots: Bot[] = []
  player: Actor
  grenades: Grenades
  effects: Effects
  viewmodel: Viewmodel
  hud: ArenaHud
  sfx: ArenaSfx
  time = 0
  roundT = 0
  roundLeft: number = TIMES.round
  phase: Phase = 'freeze'
  phaseLeft: number = TIMES.freeze
  bomb: BombInfo = { state: 'none', pos: new THREE.Vector3(), site: null, carrier: null, defuser: null }
  bombLeft = 0
  sounds: SoundEvent[] = []
  command: 'free' | 'follow' | 'hold' = 'free'
  commandLook = new THREE.Vector3()
  contact: Record<string, { site: SiteId; t: number } | null> = { A: null, B: null }
  round = 0
  /** 队伍 A（玩家队）/ B 的比分、阵营、连败 */
  score = { A: 0, B: 0 }
  teamSide: Record<string, Side> = { A: 'T', B: 'CT' }
  lossStreak = { A: 0, B: 0 }
  private plantedThisRound = false
  private planter: Actor | null = null
  private defuser: Actor | null = null
  private paused = false
  private hadLock = false
  private expectUnlock = false
  private pauseAt = -9
  private sbOpen = false
  private buyStage = -1
  private scoped = 0
  private specIdx = 0
  private specTarget: Actor | null = null
  /** 滚轮累计（takeWheel，满一格切枪） */
  private wheelAcc = 0
  private lastMouse = { dx: 0, dy: 0 }
  private beepT = 0
  private respawnAt = new Map<Actor, number>()
  private reported = false
  private disposed = false
  private result: MatchResult | null = null
  private readonly saved: { exposure: number; toneMapping: THREE.ToneMapping; shadow: boolean; rim: number; rimColor: THREE.Color; autoClear: boolean }
  private envRT: THREE.WebGLRenderTarget | null = null
  private cityVolume = 1
  private sun: THREE.DirectionalLight
  private skyMat: THREE.ShaderMaterial
  private skyGeo: THREE.SphereGeometry
  private grade = defaultGrade()
  private keyHandler: (e: KeyboardEvent) => void
  private lockHandler: () => void
  private botOut: BotOut = { mx: 0, mz: 0, walk: false, jump: false, fire: false, aimYaw: 0, aimPitch: 0, reload: false, use: false }
  private outs = new Map<Actor, BotOut>()
  /** 测试：时间倍速 / 玩家自动驾驶 */
  timeScale = 1
  /** 测试：bot 原地不动不开火 */
  freezeBots = false
  autopilot: Bot | null = null
  fps = 0
  private fpsN = 0; private fpsT = 0
  private landY = new Map<Actor, number>()

  constructor(mode: ArenaModeId, readonly game: Game, readonly opts: ArenaOptions) {
    this.mode = mode
    const r = game.renderer
    this.saved = { exposure: r.toneMappingExposure, toneMapping: r.toneMapping, shadow: r.shadowMap.enabled, rim: LOOK.uRimStrength.value, rimColor: LOOK.uRimColor.value.clone(), autoClear: r.autoClear }
    const size = r.getSize(new THREE.Vector2())
    this.camera = new THREE.PerspectiveCamera(74, size.x / Math.max(1, size.y), 0.05, 700)
    this.camera.rotation.order = 'YXZ'
    this.scene.add(this.camera)

    // —— 灯光：午后室外（暖色斜阳 + 天光半球 + 室内环境图做反射），与城市隔离 ——
    this.scene.background = new THREE.Color(0x9cc4e8)
    this.scene.fog = new THREE.Fog(0xb9d3ea, 90, 420)
    const hemi = new THREE.HemisphereLight(0xd4e6ff, 0x9a8a72, 1.25)
    this.scene.add(hemi)
    this.sun = new THREE.DirectionalLight(0xfff0d8, 3.1)
    this.sun.position.set(-48, 80, 34); this.sun.target.position.set(0, 0, 0)
    this.sun.castShadow = r.shadowMap.enabled
    const sc = this.sun.shadow.camera
    sc.left = -70; sc.right = 70; sc.top = 70; sc.bottom = -70; sc.near = 10; sc.far = 220
    this.sun.shadow.mapSize.set(2048, 2048)
    this.sun.shadow.bias = -0.0004; this.sun.shadow.normalBias = 0.04
    this.scene.add(this.sun, this.sun.target)
    const pm = new THREE.PMREMGenerator(r)
    const room = new RoomEnvironment()
    this.envRT = pm.fromScene(room, 0.04)
    this.scene.environment = this.envRT.texture
    this.scene.environmentIntensity = 0.45
    room.traverse((o) => { const m = o as THREE.Mesh; if (m.isMesh) { m.geometry.dispose(); (m.material as THREE.Material).dispose() } })
    pm.dispose()
    // 天空渐变球
    this.skyGeo = new THREE.SphereGeometry(600, 24, 12)
    this.skyMat = new THREE.ShaderMaterial({
      side: THREE.BackSide, depthWrite: false, fog: false,
      uniforms: { top: { value: new THREE.Color(0x3d7fd1) }, mid: { value: new THREE.Color(0xa9cdf0) }, bot: { value: new THREE.Color(0xe8dcc4) } },
      vertexShader: 'varying vec3 vP; void main(){ vP = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }',
      fragmentShader: 'uniform vec3 top; uniform vec3 mid; uniform vec3 bot; varying vec3 vP; void main(){ float h = normalize(vP).y; vec3 c = h > 0.0 ? mix(mid, top, pow(h, 0.6)) : mix(mid, bot, min(1.0, -h * 4.0)); gl_FragColor = vec4(c, 1.0); }',
    })
    const sky = new THREE.Mesh(this.skyGeo, this.skyMat); sky.frustumCulled = false; sky.renderOrder = -1
    this.scene.add(sky)
    this.grade.contrast = 1.06; this.grade.saturation = 1.12; this.grade.vignette = 0.22; this.grade.grain = 0.015; this.grade.chroma = 0.4; this.grade.bloom = 0.12; this.grade.bloomThreshold = 1.4; this.grade.ao = 0.55
    this.grade.shadowTint.setRGB(0.85, 0.95, 1.1); this.grade.highlightTint.setRGB(1.1, 1.0, 0.88); this.grade.split = 0.25

    this.map = new ArenaMap()
    this.scene.add(this.map.group)
    this.effects = new Effects(); this.scene.add(this.effects.group)
    // 城市环境声 / 音乐静音（引擎、雨、车流），竞技场音效用进场前的总音量
    this.cityVolume = game.audio.masterVolume
    game.audio.setMasterVolume(0)
    this.sfx = new ArenaSfx(() => this.cityVolume)
    this.grenades = new Grenades(this.map, this.sfx); this.scene.add(this.grenades.group)
    this.grenades.onExplode = (k, p, o) => this.onNade(k, p, o)
    this.viewmodel = new Viewmodel(); this.camera.add(this.viewmodel.group)
    this.hud = new ArenaHud()

    // —— 选手 ——
    const lib = game.charLib
    const solo = mode === 'duel' || mode === 'dm'
    const myName = game.playerName || '你'
    this.player = new Actor(0, myName, 'A', 'T', true)
    this.actors.push(this.player)
    const mk = (name: string, team: string, side: Side, diff: Difficulty, i: number) => {
      const a = new Actor(this.actors.length, name, team, side, false, diff)
      a.variant = i
      this.actors.push(a)
      this.bots.push(new Bot(a, diff, this.actors.length))
      return a
    }
    if (mode === 'dm') {
      for (let i = 0; i < 7; i++) mk(i % 2 ? BOT_NAMES_T[i] : BOT_NAMES_CT[i], 'D' + i, i % 2 ? 'T' : 'CT', opts.enemyDiff[i % opts.enemyDiff.length], i)
    } else if (mode === 'duel') {
      mk(BOT_NAMES_CT[0], 'B', 'CT', opts.enemyDiff[0], 0)
    } else {
      for (let i = 0; i < 4; i++) mk(BOT_NAMES_T[i], 'A', 'T', opts.mateDiff, i)
      for (let i = 0; i < 5; i++) mk(BOT_NAMES_CT[i], 'B', 'CT', opts.enemyDiff[i], i)
    }
    // 随机开局阵营
    if (!solo && Math.random() < 0.5) { this.teamSide = { A: 'CT', B: 'T' } }
    if (mode === 'duel' && Math.random() < 0.5) this.teamSide = { A: 'CT', B: 'T' }
    for (const a of this.actors) { a.side = this.teamSide[a.team] ?? a.side; a.money = ECON.start; a.secondary = new WeaponState(WEAPONS[a.side === 'T' ? 'glock' : 'usp']); a.slot = 'secondary' }
    if (mode === 'dm') for (const a of this.actors) a.money = ECON.max
    for (const a of this.actors) if (!a.isPlayer) { a.visual = new ActorVisual(lib, a.side, a.variant); this.scene.add(a.visual.group) }
    this.viewmodel.setSide(this.player.side)

    // —— 渲染设置 ——
    r.toneMapping = THREE.AgXToneMapping
    LOOK.uRimStrength.value = 0.14; LOOK.uRimColor.value.setHex(0xbcd8ff)

    // —— 输入：Tab 不切焦点；指针锁丢失 → 暂停 ——
    this.keyHandler = (e: KeyboardEvent) => { if (e.code === 'Tab' || (e.ctrlKey && e.code !== 'KeyW') || e.code === 'Space') e.preventDefault() }
    window.addEventListener('keydown', this.keyHandler, true)
    this.lockHandler = () => {
      const locked = document.pointerLockElement === document.body
      if (locked) { this.hadLock = true; return }
      if (this.expectUnlock) { this.expectUnlock = false; return }
      if (this.hadLock && !this.hud.buyOpen && !this.hud.endOpen && !this.paused && !this.disposed) this.openPause()
    }
    document.addEventListener('pointerlockchange', this.lockHandler)
    this.requestLock()

    if (mode === 'dm') this.startDm(); else this.startRound()
    this.hud.center(`${MODES[mode].name}\n${mode === 'dm' ? '5 分钟 · 击杀最多者获胜' : mode === 'duel' ? `先赢 ${MATCH.duelWin} 回合` : `你是 ${this.player.side === 'T' ? 'T（进攻方）' : 'CT（防守方）'} · 先赢 ${MATCH.winRounds} 回合`}`, 4)
  }

  // ———————————————————— BotWorld ————————————————————
  isEnemy(a: Actor, b: Actor) { return a.team !== b.team }
  enemiesOf(a: Actor) { return this.actors.filter((b) => b.team !== a.team) }
  canSee(from: Actor, to: Actor): boolean { return this.visiblePart(from, to) !== null }
  /** 视线：头 / 胸 是否可见（地图遮挡 + 烟雾） */
  visiblePart(from: Actor, to: Actor): 'head' | 'chest' | 'both' | null {
    const ex = from.body.x, ey = from.eyeY, ez = from.body.z
    const h = headCenter(to, _v), c = chestPoint(to, _v2)
    const hv = !this.map.blocked(ex, ey, ez, h.x, h.y, h.z) && !this.grenades.smokeBlocks(ex, ey, ez, h.x, h.y, h.z)
    const cv = !this.map.blocked(ex, ey, ez, c.x, c.y, c.z) && !this.grenades.smokeBlocks(ex, ey, ez, c.x, c.y, c.z)
    return hv && cv ? 'both' : hv ? 'head' : cv ? 'chest' : null
  }
  buy(a: Actor, id: string): boolean {
    const w = WEAPONS[id], e = EQUIP[id]
    const free = this.mode === 'dm'
    const price = free ? 0 : (w?.price ?? e?.price ?? 0)
    const side = w?.side ?? e?.side
    if (side && side !== a.side) return false
    if (w) {
      if (w.slot === 'primary' && a.primary?.def.id === id) return false
      if (w.slot === 'secondary' && a.secondary?.def.id === id) return false
      if (a.money < price) return false
      a.money -= price
      if (w.slot === 'primary') { a.primary = new WeaponState(w); a.slot = 'primary' }
      else { a.secondary = new WeaponState(w); if (!a.primary) a.slot = 'secondary' }
      a.drawT = 0.5
      return true
    }
    if (!e) return false
    if (e.kind === 'armor') { if (a.armor >= 100 || a.money < price) return false; a.money -= price; a.armor = 100; return true }
    if (e.kind === 'helmet') {
      if (a.armor >= 100 && a.helmet) return false
      const cost = a.armor >= 100 ? (free ? 0 : 350) : price
      if (a.money < cost) return false
      a.money -= cost; a.armor = 100; a.helmet = true; return true
    }
    if (e.kind === 'kit') { if (a.kit || a.money < price) return false; a.money -= price; a.kit = true; return true }
    // 投掷物：每种最多 1 个（闪光 2 个），总数 ≤ 4
    const cnt = a.grenades.filter((g) => g === id).length
    if (a.grenades.length >= 4 || cnt >= (id === 'flash' ? 2 : 1) || a.money < price) return false
    a.money -= price; a.grenades.push(id); return true
  }
  throwNade(a: Actor, kind: NadeKind, lob: boolean) {
    const i = a.grenades.indexOf(kind); if (i < 0) return
    a.grenades.splice(i, 1)
    const f = a.forward(_v).clone()
    const from = new THREE.Vector3(a.body.x, a.eyeY - 0.1, a.body.z).addScaledVector(f, 0.4)
    const speed = lob ? 8 : 17
    const vel = f.multiplyScalar(speed).add(new THREE.Vector3(a.body.vx * 0.8, (lob ? 2 : 2.5), a.body.vz * 0.8))
    this.grenades.throw(a, kind, from, vel)
    this.sounds.push({ x: a.body.x, z: a.body.z, by: a, kind: 'nade', t: this.time })
    if (a.slot === 'grenade' && !a.grenades.length) a.slot = a.bestSlot()
  }

  // ———————————————————— 回合流程 ————————————————————
  private get bombMode() { return this.mode === 'casual' || this.mode === 'ranked' || this.mode === 'pro' }
  private sideOfTeam(team: string): Side { return this.teamSide[team] ?? 'T' }
  private teamOfSide(side: Side): string { return this.teamSide.A === side ? 'A' : 'B' }

  private startRound() {
    this.round++
    this.phase = 'freeze'; this.phaseLeft = TIMES.freeze; this.roundT = 0
    this.roundLeft = this.mode === 'duel' ? 60 : TIMES.round
    this.bomb = { state: 'none', pos: new THREE.Vector3(), site: null, carrier: null, defuser: null }
    this.plantedThisRound = false; this.planter = null; this.defuser = null
    this.contact = { A: null, B: null }
    this.grenades.clear(); this.effects.clearHoles(); this.removeBombMesh()
    this.sounds = []
    const spawnIdx: Record<Side, number> = { T: 0, CT: 0 }
    for (const a of this.actors) {
      if (!a.alive) a.stripOnDeath(a.side === 'T' ? 'glock' : 'usp')
      a.resetForRound()
      const sp = SPAWNS[a.side][spawnIdx[a.side]++ % SPAWNS[a.side].length]
      a.body.x = sp.x + (Math.random() - 0.5) * 0.6; a.body.z = sp.z + (Math.random() - 0.5) * 0.6; a.body.y = this.map.groundAt(sp.x, sp.z)
      a.yaw = a.side === 'T' ? 0 : Math.PI; a.pitch = 0
      a.slot = a.bestSlot()
      if (a.visual) { a.visual.revive(); a.visual.group.visible = true }
    }
    for (const b of this.bots) b.resetRound()
    if (this.autopilot) this.autopilot.resetRound()
    // bot 购买（半场首局 = 手枪局）
    const pistol = this.round === 1 || this.round === MATCH.half + 1
    const awpTeam = new Set<string>()
    for (const b of this.bots) {
      const had = !!b.a.primary
      b.buyRound(this, pistol, awpTeam.has(b.a.team))
      if (!had && b.a.primary?.def.id === 'awp') awpTeam.add(b.a.team)
      b.a.visual?.setGunColor(b.a.weapon().def.color)
    }
    if (this.autopilot) this.autopilot.buyRound(this, pistol, false)
    // C4
    for (const a of this.actors) a.hasC4 = false
    if (this.bombMode) {
      const ts = this.actors.filter((a) => a.side === 'T')
      const c = ts[Math.floor(Math.random() * ts.length)]
      c.hasC4 = true
      this.bomb.state = 'carried'; this.bomb.carrier = c
    }
    this.specTarget = null; this.hud.spectate(null)
    this.scoped = 0
    this.hud.clearFeed()
    if (this.round > 1) this.hud.center('', 0.01)
    if (this.mode !== 'dm' && !this.autopilot) this.openBuy()
    this.sfx.ui('round')
  }

  /** 冻结结束 → 进攻计划 / 守点分配 */
  private goLive() {
    this.phase = 'live'; this.roundT = 0
    if (this.mode === 'duel') { for (const b of this.bots) b.assignHunt(this); return }
    for (const team of ['A', 'B']) {
      const side = this.sideOfTeam(team)
      const bots = this.bots.filter((b) => b.a.team === team)
      if (side === 'T') {
        const site: SiteId = Math.random() < 0.5 ? 'A' : 'B'
        const r = Math.random()
        const exec = r < 0.25 ? 0 : r < 0.6 ? 18 + Math.random() * 12 : 38 + Math.random() * 14
        const route0 = Math.floor(Math.random() * 2)
        bots.forEach((b, i) => b.assignT(site, r < 0.25 ? route0 : route0 + i, exec))
      } else {
        const holds = [HOLDS.A[0], HOLDS.A[1], HOLDS.mid[0], HOLDS.B[0], HOLDS.B[1], HOLDS.A[2], HOLDS.B[2]]
        for (let i = holds.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [holds[i], holds[j]] = [holds[j], holds[i]] }
        bots.forEach((b, i) => b.assignHold(holds[i].at, holds[i].look))
      }
    }
    if (this.autopilot) {
      const side = this.player.side
      if (side === 'T') this.autopilot.assignT(Math.random() < 0.5 ? 'A' : 'B', 0, 0)
      else this.autopilot.assignHold(HOLDS.mid[0].at, HOLDS.mid[0].look)
    }
  }

  private endRound(winTeam: string | null, reason: string) {
    if (this.phase === 'end' || this.phase === 'over') return
    this.phase = 'end'; this.phaseLeft = TIMES.roundEnd
    this.closeBuy()
    if (winTeam) {
      this.score[winTeam as 'A' | 'B']++
      const lose = winTeam === 'A' ? 'B' : 'A'
      const bombWin = reason === 'bomb' || reason === 'defuse'
      for (const a of this.actors) {
        if (a.team === winTeam) a.money += bombWin ? ECON.winBomb : ECON.win
        else {
          let bonus = ECON.lossBonus[Math.min(this.lossStreak[lose as 'A' | 'B'], ECON.lossBonus.length - 1)]
          if (this.sideOfTeam(lose) === 'T' && this.plantedThisRound) bonus += ECON.plantBonusTeam
          a.money += bonus
        }
        a.money = Math.min(ECON.max, a.money)
      }
      this.lossStreak[winTeam as 'A' | 'B'] = Math.max(0, this.lossStreak[winTeam as 'A' | 'B'] - 1)
      this.lossStreak[lose as 'A' | 'B'] = Math.min(4, this.lossStreak[lose as 'A' | 'B'] + 1)
      // MVP
      let mvp: Actor | null = null
      for (const a of this.actors) if (a.team === winTeam && a.roundKills > 0 && (!mvp || a.roundKills > mvp.roundKills || (a.roundKills === mvp.roundKills && a.stats.dmg > mvp.stats.dmg))) mvp = a
      if (reason === 'bomb' && this.planter?.team === winTeam) mvp = this.planter
      if (reason === 'defuse' && this.defuser) mvp = this.defuser
      if (mvp) { mvp.stats.mvps++; mvp.stats.score += 2 }
      const side = this.sideOfTeam(winTeam)
      const why = reason === 'bomb' ? '炸弹爆炸' : reason === 'defuse' ? '炸弹已拆除' : reason === 'time' ? '时间耗尽' : '全歼对手'
      const mine = winTeam === this.player.team
      this.hud.center(`${side === 'T' ? '恐怖分子' : '反恐精英'} 获胜 · ${why}${mvp ? `\nMVP：${mvp.name}` : ''}`, TIMES.roundEnd)
      this.sfx.ui(mine ? 'win' : 'lose')
    } else this.hud.center('平局 · 时间耗尽', TIMES.roundEnd)
    const winN = this.mode === 'duel' ? MATCH.duelWin : MATCH.winRounds
    const maxRounds = this.mode === 'duel' ? MATCH.duelWin * 2 - 1 : MATCH.half * 2
    if (this.score.A >= winN || this.score.B >= winN || this.round >= maxRounds) this.matchOver(false)
  }

  private halftime() {
    this.teamSide = { A: this.teamSide.A === 'T' ? 'CT' : 'T', B: this.teamSide.B === 'T' ? 'CT' : 'T' }
    this.lossStreak = { A: 0, B: 0 }
    for (const a of this.actors) {
      a.side = this.sideOfTeam(a.team)
      a.primary = null; a.grenades = []; a.armor = 0; a.helmet = false; a.kit = false; a.hasC4 = false
      a.secondary = new WeaponState(WEAPONS[a.side === 'T' ? 'glock' : 'usp'])
      a.money = ECON.start
      if (a.visual) { a.visual.dispose(); a.visual = new ActorVisual(this.game.charLib, a.side, a.variant); this.scene.add(a.visual.group) }
    }
    this.viewmodel.setSide(this.player.side)
    this.hud.center(`半场换边\n你现在是 ${this.player.side === 'T' ? 'T（进攻方）' : 'CT（防守方）'}`, 4)
  }

  // ———————————————————— 死斗 ————————————————————
  private startDm() {
    this.phase = 'live'; this.round = 1; this.roundLeft = MATCH.dmTime
    for (const a of this.actors) {
      a.primary = new WeaponState(WEAPONS[a.side === 'T' ? 'ak47' : 'm4a4']); a.armor = 100; a.helmet = true
      a.visual?.setGunColor(a.primary.def.color)
      this.respawn(a)
    }
    for (const b of this.bots) b.assignHunt(this)
  }
  private respawn(a: Actor) {
    // 远离其他人的随机点
    let best = this.map.randomWalkable(), bestD = -1
    for (let i = 0; i < 12; i++) {
      const p = this.map.randomWalkable()
      let dmin = Infinity
      for (const o of this.actors) if (o !== a && o.alive) dmin = Math.min(dmin, Math.hypot(o.body.x - p.x, o.body.z - p.z))
      if (dmin > bestD) { bestD = dmin; best = p }
    }
    a.resetForRound()
    a.body.x = best.x; a.body.z = best.z; a.body.y = this.map.groundAt(best.x, best.z)
    a.yaw = Math.random() * Math.PI * 2
    for (const w of [a.primary, a.secondary]) if (w) { w.mag = w.def.mag; w.reserve = w.def.reserve }
    a.armor = 100; a.helmet = true
    a.slot = a.bestSlot()
    if (a.visual) { a.visual.revive(); a.visual.group.visible = true }
  }

  private matchOver(surrender: boolean) {
    if (this.phase === 'over' && this.result) return
    this.phase = 'over'
    const p = this.player
    let won = false, draw = false, us = this.score.A, them = this.score.B
    if (this.mode === 'dm') {
      const top = Math.max(...this.actors.map((a) => a.stats.kills))
      won = !surrender && p.stats.kills >= top && top > 0
      us = p.stats.kills; them = Math.max(...this.actors.filter((a) => a !== p).map((a) => a.stats.kills), 0)
    } else { won = !surrender && us > them; draw = !surrender && us === them }
    const m = MODES[this.mode]
    let prize = 0
    if (won) prize += m.prize
    if (!surrender && this.mode !== 'dm') prize += p.stats.kills * m.perKill + p.stats.mvps * m.perMvp
    if (draw) prize = Math.round(prize * 0.5)
    prize = Math.round(prize)
    if (prize > 0) earn(this.game.ctx, prize, 'arena:prize')
    const res: MatchResult = { mode: this.mode, won, draw, surrender, kills: p.stats.kills, deaths: p.stats.deaths, assists: p.stats.assists, headshots: p.stats.hs, mvps: p.stats.mvps, scoreUs: us, scoreThem: them, prize }
    this.result = res
    this.report()
    const extra = this.opts.onResult(res)
    if (surrender) return
    this.expectUnlock = !!document.pointerLockElement
    if (document.pointerLockElement) document.exitPointerLock()
    this.hud.scoreboard(false, [], '')
    const title = won ? '胜利！' : draw ? '平局' : '失败'
    const sub = this.mode === 'dm' ? `你的击杀 ${us} · 最高对手 ${them}` : `比分 ${us} : ${them}`
    const body = [`击杀 ${p.stats.kills} · 死亡 ${p.stats.deaths} · 助攻 ${p.stats.assists} · 爆头 ${p.stats.hs} · MVP ${p.stats.mvps}`, prize > 0 ? `奖金 +$${prize}` : '无奖金', ...extra]
    this.hud.showEnd(title, sub, this.scoreRows(), body, () => this.game.exitArena())
    this.hud.center('', 0.01)
  }
  /** 发 matchDone（只一次；投降 / 中途退出也算一场负） */
  private report() {
    if (this.reported) return
    this.reported = true
    const p = this.player
    const won = this.result?.won ?? false
    this.game.ctx.events.emit('matchDone', { mode: this.mode, won, kills: p.stats.kills, headshots: p.stats.hs })
  }
  surrender() {
    if (this.phase !== 'over') this.matchOver(true)
    this.game.exitArena()
  }

  // ———————————————————— 输入 ————————————————————
  private requestLock() {
    try { const pr = document.body.requestPointerLock?.() as unknown as Promise<void> | undefined; pr?.catch?.(() => {}) } catch { /* 无指针锁环境 */ }
  }
  private openPause() {
    this.paused = true; this.pauseAt = performance.now()
    this.hud.showPause(true, () => this.closePause(), () => this.surrender())
  }
  private closePause() {
    this.paused = false
    this.hud.showPause(false)
    this.requestLock()
  }
  private inBuyZone(a: Actor) {
    if (this.mode === 'dm') return true
    const z = BUY_ZONES[a.side], cx = toCell(a.body.x), cz = toCell(a.body.z)
    return cx >= z.x0 && cx <= z.x1 && cz >= z.z0 && cz <= z.z1
  }
  private canBuy(a: Actor) {
    if (!a.alive) return false
    if (this.mode === 'dm') return true
    return (this.phase === 'freeze' || (this.phase === 'live' && this.roundT < TIMES.buyWindow)) && this.inBuyZone(a)
  }
  private buyGroups(): { title: string; items: BuyItem[] }[] {
    const p = this.player
    return BUY_MENU.map((g) => ({
      title: g.title,
      items: g.items.filter((id) => { const s = WEAPONS[id]?.side ?? EQUIP[id]?.side; return !s || s === p.side }).map((id) => {
        const w = WEAPONS[id], e = EQUIP[id]
        const price = this.mode === 'dm' ? 0 : (id === 'vesthelm' && p.armor >= 100 ? 350 : (w?.price ?? e!.price))
        const owned = w ? (p.primary?.def.id === id || p.secondary?.def.id === id) : id === 'vest' ? p.armor >= 100 : id === 'vesthelm' ? p.helmet && p.armor >= 100 : id === 'kit' ? p.kit : p.grenades.filter((x) => x === id).length >= (id === 'flash' ? 2 : 1)
        return { id, name: w?.name ?? e!.name, price, owned, disabled: owned || p.money < price }
      }),
    }))
  }
  openBuy() {
    if (!this.canBuy(this.player)) return
    this.buyStage = -1
    this.expectUnlock = !!document.pointerLockElement
    if (document.pointerLockElement) document.exitPointerLock()
    this.refreshBuy()
  }
  private refreshBuy() {
    const left = this.phase === 'freeze' ? `冻结 ${Math.ceil(this.phaseLeft)} s` : this.mode === 'dm' ? '死斗：免费' : `购买时间 ${Math.max(0, Math.ceil(TIMES.buyWindow - this.roundT))} s`
    this.hud.showBuy(true, this.buyGroups(), this.player.money, left, (id) => this.playerBuy(id), () => this.closeBuy(true))
  }
  closeBuy(relock = false) {
    if (!this.hud.buyOpen) return
    this.hud.showBuy(false)
    if (relock && !this.paused && this.phase !== 'over') this.requestLock()
  }
  playerBuy(id: string): boolean {
    if (!this.canBuy(this.player)) { this.sfx.ui('deny'); return false }
    const ok = this.buy(this.player, id)
    this.sfx.ui(ok ? 'buy' : 'deny')
    if (this.hud.buyOpen) this.refreshBuy()
    return ok
  }

  private selectSlot(a: Actor, s: typeof a.slot) {
    if (!a.hasSlot(s) || a.slot === s) return
    a.lastSlot = a.slot; a.slot = s; a.drawT = s === 'knife' ? 0.3 : 0.55
    this.scoped = 0
    const w = a.weapon(); w.reloadT = 0
  }

  private handlePlayerInput(input: Input, dt: number) {
    const p = this.player
    const m = input.takeMouse(); this.lastMouse = m
    // 开局 / 结束 / 暂停时只处理少量按键
    if (this.hud.endOpen) return
    if (input.justPressed('Escape')) {
      if (this.hud.buyOpen) { this.closeBuy(true); return }
      if (this.paused) { if (performance.now() - this.pauseAt > 300) this.closePause(); return }
      this.openPause(); this.expectUnlock = !!document.pointerLockElement; if (document.pointerLockElement) document.exitPointerLock(); return
    }
    if (this.paused) return
    this.sbOpen = input.down('Tab')
    if (input.justPressed('KeyB')) { if (this.hud.buyOpen) this.closeBuy(true); else this.openBuy() }
    if (this.hud.buyOpen) {
      if (!this.canBuy(p)) { this.closeBuy(true) }
      for (let n = 1; n <= 5; n++) if (input.justPressed('Digit' + n)) {
        if (this.buyStage < 0) this.buyStage = n - 1
        else { const g = this.buyGroups()[this.buyStage]; const it = g?.items[n - 1]; if (it) this.playerBuy(it.id); this.buyStage = -1 }
      }
      return
    }
    if (!p.alive) {
      // 观战切换
      if (input.mousePressed(0) || input.clicked) this.specIdx++
      return
    }
    if (this.autopilot) return
    // 视角
    const fovK = this.camera.fov / 74
    p.yaw -= m.dx * 0.0022 * fovK
    p.pitch = Math.max(-1.5, Math.min(1.5, p.pitch - m.dy * 0.0022 * fovK))
    // 换枪
    if (input.justPressed('Digit1')) this.selectSlot(p, 'primary')
    if (input.justPressed('Digit2')) this.selectSlot(p, 'secondary')
    if (input.justPressed('Digit3')) this.selectSlot(p, 'knife')
    if (input.justPressed('Digit4')) {
      if (p.slot === 'grenade' && p.grenades.length > 1) { p.grenades.push(p.grenades.shift()!); p.drawT = 0.3 }
      else this.selectSlot(p, 'grenade')
    }
    if (input.justPressed('Digit5')) this.selectSlot(p, 'c4')
    // 滚轮切枪（向下 = 下一把）：累计到一格（约 60）切一次，每帧最多一次
    this.wheelAcc += input.takeWheel()
    if (Math.abs(this.wheelAcc) >= 60) { this.cycleSlot(p, this.wheelAcc > 0 ? 1 : -1); this.wheelAcc = 0 }
    if (input.justPressed('KeyQ')) { const s = p.lastSlot; if (p.hasSlot(s)) this.selectSlot(p, s) }
    if (input.justPressed('KeyR')) this.startReload(p)
    if (input.justPressed('KeyZ') && this.mode !== 'dm' && this.mode !== 'duel') {
      this.command = this.command === 'free' ? 'follow' : this.command === 'follow' ? 'hold' : 'free'
      this.commandLook.set(p.body.x - Math.sin(p.yaw) * 12, 0, p.body.z - Math.cos(p.yaw) * 12)
      this.hud.center(this.command === 'follow' ? '队友：跟我！' : this.command === 'hold' ? '队友：守住这里！' : '队友：自由行动', 1.5)
    }
    // 开镜
    const w = p.weapon()
    if (input.mousePressed(2)) {
      if (w.def.scope) { this.scoped = (this.scoped + 1) % 3; w.scope = this.scoped }
      else if (w.def.kind === 'knife') this.melee(p, true)
    }
    // 开火（半自动 = 按下边沿；手雷 = 松开时投出）
    if (p.slot === 'grenade') {
      if (input.mouseReleased(0) && p.grenades.length) this.throwNade(p, p.grenades[0] as NadeKind, false)
    } else if (p.slot === 'c4') {
      // 左键 / E 按住下包
    } else if (w.def.auto ? input.mouseDown(0) : input.mousePressed(0)) this.tryFire(p)
  }

  /** 滚轮切枪：按 主武器 → 副武器 → 刀 → 手雷 → C4 的顺序循环，跳过没有的 */
  private cycleSlot(a: Actor, dir: 1 | -1) {
    const order = ['primary', 'secondary', 'knife', 'grenade', 'c4'] as const
    let i = Math.max(0, order.indexOf(a.slot as typeof order[number]))
    for (let k = 0; k < order.length; k++) {
      i = (i + dir + order.length) % order.length
      if (a.hasSlot(order[i])) { this.selectSlot(a, order[i]); return }
    }
  }

  // ———————————————————— 战斗 ————————————————————
  private startReload(a: Actor) {
    const w = a.weapon()
    if (w.def.kind === 'knife' || w.reloading || w.mag >= w.def.mag || w.reserve <= 0) return
    w.reloadT = w.def.reload
    w.scope = 0; if (a === this.player) this.scoped = 0
    this.sfx.reload(a === this.listener ? null : a.body.x, a === this.listener ? null : a.body.z, w.def.reload)
  }
  private get listener(): Actor { return this.player.alive || !this.specTarget ? this.player : this.specTarget }

  private melee(a: Actor, heavy: boolean): boolean {
    const w = a.knife
    if (this.time < w.nextFire || a.drawT > 0) return false
    w.nextFire = this.time + (heavy ? 1.0 : 0.4)
    const f = a.forward(_v)
    let hit = false
    for (const v of this.actors) {
      if (v === a || !v.alive || !this.isEnemy(a, v)) continue
      const dx = v.body.x - a.body.x, dz = v.body.z - a.body.z, d = Math.hypot(dx, dz)
      if (d > 1.9) continue
      if ((dx * f.x + dz * f.z) / (d || 1) < 0.6) continue
      if (this.map.blocked(a.body.x, a.eyeY, a.body.z, v.body.x, v.body.y + 1.2, v.body.z)) continue
      // 背刺
      const vf = v.forward(_v2)
      const back = (vf.x * dx + vf.z * dz) / (d || 1) > 0.3
      const dmg = heavy ? (back ? 180 : 65) : (back ? 90 : 40)
      const r = computeDamage({ ...WEAPONS.knife, damage: dmg }, 0, 'chest', v)
      this.damage(v, a, r.hp, r.armor, 'knife', false, f)
      hit = true
      break
    }
    this.sfx.knife(a === this.listener ? null : a.body.x, a === this.listener ? null : a.body.z, hit)
    if (a === this.player) this.viewmodel.fire(0.6)
    return hit
  }

  /** 开一枪（玩家与 bot 共用）：散布 + 后坐图案 + 射线命中 + 伤害 */
  tryFire(a: Actor): boolean {
    const w = a.weapon()
    if (!a.alive || a.drawT > 0 || w.reloading || this.time < w.nextFire) return false
    if (a.slot === 'grenade' || a.slot === 'c4') return false
    if (w.def.kind === 'knife') return this.melee(a, false)
    if (w.mag <= 0) { if (w.reserve > 0) this.startReload(a); else if (a === this.player) { this.sfx.dry(); w.nextFire = this.time + 0.25 } return false }
    w.mag--
    w.nextFire = this.time + 60 / w.def.rpm
    const bot = this.bots.find((b) => b.a === a) ?? (this.autopilot?.a === a ? this.autopilot : null)
    const comp = bot ? bot.d.recoilComp : 0
    const [ry, rp] = recoilAt(w.def, w.shotIdx)
    const inacc = inaccuracy(a, w)
    const pellets = w.def.pellets ?? 1
    const ox = a.body.x, oy = a.eyeY, oz = a.body.z
    // 枪口（曳光起点）
    if (a === this.player) { this.camera.updateMatrixWorld(); this.viewmodel.muzzleWorld(_muz) }
    else { const f = a.forward(_v2); _muz.set(ox + f.x * 0.7 + Math.cos(a.yaw) * 0.18, oy - 0.3 + f.y * 0.7, oz + f.z * 0.7 - Math.sin(a.yaw) * 0.18) }
    for (let i = 0; i < pellets; i++) {
      const d = shotDir(a.yaw, a.pitch, ry * (1 - comp), rp * (1 - comp), pellets > 1 ? Math.max(inacc, w.def.spread) : inacc, _v)
      traceShot(this.map, this.actors, a, ox, oy, oz, d, 250, shot)
      if (shot.victim && shot.group) {
        const r = computeDamage(w.def, shot.dist, shot.group, shot.victim)
        this.effects.bloodHit(shot.point, d, shot.group === 'head')
        this.damage(shot.victim, a, r.hp, r.armor, w.def.id, shot.group === 'head', d)
      } else if (shot.boxKind !== 'sky') this.effects.impact(shot.point, shot.normal, shot.boxKind === 'k' || shot.boxKind === 'K')
      if (i < 3) this.effects.tracer(_muz, shot.point)
    }
    w.shotIdx += 1
    w.bloom = Math.min(w.def.bloomMax, w.bloom + w.def.bloom)
    w.lastFire = this.time
    const L = this.listener
    this.sfx.gun(w.def, a === L ? null : a.body.x, a === L ? null : a.body.z)
    this.sounds.push({ x: ox, z: oz, by: a, kind: 'shot', t: this.time })
    if (a === this.player) { this.viewmodel.fire(w.def.kind === 'sniper' ? 1.5 : w.def.kind === 'pistol' ? 0.7 : 0.45); if (w.def.id !== 'usp') this.effects.muzzle(_muz, this.camera, 0.09) }
    else if (a !== L || this.player.alive) this.effects.muzzle(_muz, this.camera, 0.3)
    bot?.onShot()
    return true
  }

  damage(v: Actor, by: Actor | null, hp: number, armor: number, weapon: string, hs: boolean, dir: THREE.Vector3 | null) {
    if (!v.alive || this.phase === 'over') return
    // 休闲规则：无友军伤害（自己的手雷仍会伤到自己）
    if (by && by !== v && !this.isEnemy(by, v)) return
    hp = Math.max(0, hp)
    const real = Math.min(v.hp, hp)
    v.hp -= hp; v.armor = Math.max(0, v.armor - armor)
    if (by) { v.dmgFrom.set(by, (v.dmgFrom.get(by) ?? 0) + real); if (this.isEnemy(by, v)) by.stats.dmg += real }
    // 受击减速（tagging）
    v.body.vx *= 0.45; v.body.vz *= 0.45
    v.visual?.hit()
    if (v === this.player) { this.hud.damageFlash(Math.min(0.9, 0.25 + hp / 80)); this.sfx.hurt(); if (dir) { this.player.pitch += 0.008 * Math.min(3, hp / 20) } }
    if (by === this.player && v !== this.player) { this.hud.hitmarker(hs); this.sfx.hitmark(hs, v.hp <= 0) }
    // bot 被打：立刻注意攻击者
    if (by && v !== this.player) { const b = this.bots.find((x) => x.a === v); if (b && !b.target && this.isEnemy(by, v)) { b.target = by } }
    if (v.hp <= 0) this.kill(v, by, weapon, hs)
  }

  private kill(v: Actor, by: Actor | null, weapon: string, hs: boolean) {
    v.alive = false; v.hp = 0; v.deadAt = this.time
    v.stats.deaths++
    v.visual?.die()
    v.body.vx = v.body.vz = 0
    if (by && by !== v) {
      if (this.isEnemy(by, v)) {
        by.stats.kills++; by.roundKills++; by.stats.score += 2
        if (hs) by.stats.hs++
        if (this.mode !== 'dm') by.money = Math.min(ECON.max, by.money + (weapon === 'he' || weapon === 'c4' ? 300 : WEAPONS[weapon]?.killReward ?? 300))
      } else { by.stats.kills--; by.stats.score -= 2; by.money = Math.max(0, by.money - 300) }
    }
    for (const [a, d] of v.dmgFrom) if (a !== by && d >= 40 && this.isEnemy(a, v)) { a.stats.assists++; a.stats.score += 1 }
    const side = (a: Actor | null) => a ? (this.mode === 'dm' ? (a === this.player ? 't' : 'ct') : a.side.toLowerCase()) : 't'
    this.hud.feed({ killer: by ? by.name : '世界', ks: side(by), victim: v.name, vs: side(v), weapon: WNAME[weapon] ?? weapon, hs, me: by === this.player || v === this.player })
    // 炸弹掉落
    if (v.hasC4) { v.hasC4 = false; this.bomb.state = 'dropped'; this.bomb.carrier = null; this.bomb.pos.set(v.body.x, v.body.y, v.body.z); this.placeBombMesh() }
    if (this.bomb.defuser === v) this.bomb.defuser = null
    if (v === this.player) {
      this.scoped = 0
      if (this.mode !== 'dm') this.hud.center(`你被 ${by?.name ?? '世界'} 击杀${hs ? '（爆头）' : ''}`, 2.5)
    }
    if (this.mode === 'dm') this.respawnAt.set(v, this.time + 2)
  }

  private onNade(kind: NadeKind, p: THREE.Vector3, owner: Actor) {
    if (kind === 'he') {
      this.sounds.push({ x: p.x, z: p.z, by: owner, kind: 'shot', t: this.time })
      for (const a of this.actors) {
        if (!a.alive) continue
        const c = chestPoint(a, _v)
        const d = c.distanceTo(p)
        if (d > 9) continue
        if (this.map.blocked(p.x, p.y + 0.2, p.z, c.x, c.y, c.z)) continue
        const raw = 98 * Math.pow(1 - d / 9, 1.4)
        const hp = a.armor > 0 ? raw * 0.5 : raw, ar = a.armor > 0 ? raw * 0.25 : 0
        this.damage(a, owner, hp, ar, 'he', false, null)
      }
    } else if (kind === 'flash') {
      for (const a of this.actors) {
        if (!a.alive) continue
        const ex = a.body.x, ey = a.eyeY, ez = a.body.z
        const d = Math.hypot(p.x - ex, p.y - ey, p.z - ez)
        if (d > 32 || this.map.blocked(p.x, p.y + 0.1, p.z, ex, ey, ez) || this.grenades.smokeBlocks(p.x, p.y, p.z, ex, ey, ez)) continue
        const f = a.forward(_v)
        const dot = ((p.x - ex) * f.x + (p.y - ey) * f.y + (p.z - ez) * f.z) / (d || 1)
        const k = (1 - d / 32) * (dot > 0.5 ? 1 : dot > 0 ? 0.55 : 0.18)
        a.blindT = Math.max(a.blindT, k * 4.2)
      }
    }
  }

  // ———————————————————— 每帧 ————————————————————
  update(dt: number, input: Input) {
    if (this.disposed) return
    this.frameT0 = performance.now()
    this.fpsN++; this.fpsT += dt
    if (this.fpsT >= 0.5) { this.fps = this.fpsN / this.fpsT; this.fpsN = 0; this.fpsT = 0 }
    this.handlePlayerInput(input, dt)
    if (!this.paused && this.phase !== 'over') {
      const n = Math.max(1, Math.min(8, Math.round(this.timeScale)))
      for (let i = 0; i < n; i++) this.step(dt)
    }
    this.updateView(dt)
    this.updateHud(dt)
  }

  private step(dt: number) {
    this.time += dt
    // —— 阶段计时 ——
    if (this.phase === 'freeze') {
      this.phaseLeft -= dt
      if (this.phaseLeft <= 0) this.goLive()
    } else if (this.phase === 'live') {
      this.roundT += dt
      if (this.bomb.state === 'planted') {
        this.bombLeft -= dt
        this.beepT -= dt
        if (this.beepT <= 0) { this.sfx.beep(this.bomb.pos.x, this.bomb.pos.z, this.bombLeft < 10); this.beepT = Math.max(0.12, this.bombLeft / TIMES.bomb * 1.0) }
        if (this.bombLeft <= 0) this.explodeBomb()
      } else {
        this.roundLeft -= dt
        if (this.roundLeft <= 0) {
          if (this.mode === 'dm') { this.matchOver(false); return }
          if (this.mode === 'duel') this.endRound(null, 'time')
          else this.endRound(this.teamOfSide('CT'), 'time')
        }
      }
    } else if (this.phase === 'end') {
      this.phaseLeft -= dt
      if (this.phaseLeft <= 0) {
        if (this.round === MATCH.half && this.mode !== 'duel') this.halftime()
        this.startRound()
      }
    }
    if (this.phase === 'over') return
    // —— 死斗复活 ——
    if (this.mode === 'dm') for (const [a, t] of this.respawnAt) if (this.time >= t) { this.respawnAt.delete(a); this.respawn(a) }
    // —— bot 思考 ——
    for (const b of this.bots) {
      let o = this.outs.get(b.a); if (!o) { o = { ...this.botOut }; this.outs.set(b.a, o) }
      if (this.freezeBots) { o.mx = o.mz = 0; o.fire = o.jump = o.use = o.reload = false; o.aimYaw = b.a.yaw; o.aimPitch = b.a.pitch; continue }
      b.update(this, dt, o)
    }
    if (this.autopilot && this.player.alive) {
      let o = this.outs.get(this.player); if (!o) { o = { ...this.botOut }; this.outs.set(this.player, o) }
      this.autopilot.update(this, dt, o)
    }
    // —— 移动（细分步） ——
    const frozen = this.phase === 'freeze'
    for (const a of this.actors) {
      if (!a.alive) continue
      let mx = 0, mz = 0, jump = false
      if (a === this.player && !this.autopilot) {
        const inp = this.game.input
        const ui = this.hud.buyOpen || this.paused
        const f = ui ? 0 : inp.axis('KeyS', 'KeyW'), s = ui ? 0 : inp.axis('KeyA', 'KeyD')
        const fx = -Math.sin(a.yaw), fz = -Math.cos(a.yaw), rx = Math.cos(a.yaw), rz = -Math.sin(a.yaw)
        mx = fx * f + rx * s; mz = fz * f + rz * s
        a.walking = !ui && (inp.down('ShiftLeft') || inp.down('ShiftRight'))
        a.wantCrouch = !ui && inp.down('KeyC')   // 只用 C（Ctrl 会和 Ctrl+W 关标签页冲突）
        jump = !ui && inp.justPressed('Space')
        // 按住 E（或拿 C4 时左键）：下包 / 拆包
        const use = !ui && (inp.down('KeyE') || (a.slot === 'c4' && inp.mouseDown(0)))
        this.useAction(a, use, dt)
      } else {
        const o = this.outs.get(a)!
        if (!o) continue
        mx = o.mx; mz = o.mz; jump = o.jump; a.walking = o.walk; a.wantCrouch = false
        a.yaw = o.aimYaw; a.pitch = o.aimPitch
        if (o.reload) this.startReload(a)
        this.useAction(a, o.use, dt)
        if (o.fire && !frozen) this.tryFire(a)
      }
      if (frozen || a.actionT > 0) { mx = 0; mz = 0; jump = false }
      this.moveActor(a, mx, mz, jump, dt)
    }
    // —— 角色互相推开（软碰撞，避免叠在一起）——
    for (let i = 0; i < this.actors.length; i++) {
      const a = this.actors[i]; if (!a.alive) continue
      for (let j = i + 1; j < this.actors.length; j++) {
        const b = this.actors[j]; if (!b.alive) continue
        const dx = b.body.x - a.body.x, dz = b.body.z - a.body.z, d = Math.hypot(dx, dz)
        if (d >= 0.7 || Math.abs(a.body.y - b.body.y) > 1.5) continue
        const push = (0.7 - d) * 0.5, nx = d > 1e-4 ? dx / d : 1, nz = d > 1e-4 ? dz / d : 0
        if (!this.map.overlap(a.body.x - nx * push, a.body.y, a.body.z - nz * push, a.body.h, a.body.r)) { a.body.x -= nx * push; a.body.z -= nz * push }
        if (!this.map.overlap(b.body.x + nx * push, b.body.y, b.body.z + nz * push, b.body.h, b.body.r)) { b.body.x += nx * push; b.body.z += nz * push }
      }
    }
    // —— 武器状态 ——
    for (const a of this.actors) {
      a.drawT = Math.max(0, a.drawT - dt)
      a.blindT = Math.max(0, a.blindT - dt)
      for (const w of [a.primary, a.secondary]) {
        if (!w) continue
        if (w.reloadT > 0) {
          if (a.weapon() !== w) w.reloadT = 0
          else { w.reloadT -= dt; if (w.reloadT <= 0) { const need = w.def.mag - w.mag, take = Math.min(need, w.reserve); w.mag += take; w.reserve -= take; w.reloadT = 0 } }
        }
        if (this.time - w.lastFire > 60 / w.def.rpm + 0.06) w.shotIdx = Math.max(0, w.shotIdx - dt * (w.def.kind === 'rifle' ? 22 : 16))
        w.bloom *= Math.exp(-dt / 0.2)
      }
    }
    // —— 炸弹拾取 ——
    if (this.bomb.state === 'dropped') {
      for (const a of this.actors) if (a.alive && a.side === 'T' && Math.hypot(a.body.x - this.bomb.pos.x, a.body.z - this.bomb.pos.z) < 1.3) {
        a.hasC4 = true; this.bomb.state = 'carried'; this.bomb.carrier = a
        this.removeBombMesh()
        if (a === this.player) this.hud.center('你捡起了 C4', 1.5)
        break
      }
    }
    // —— 脚步声 ——
    const L = this.listener
    for (const a of this.actors) {
      if (!a.alive || !a.body.onGround) continue
      const sp = a.speed2()
      if (a.walking || a.crouch > 0.5 || sp < 3.0) { a.stepAcc = 0; continue }
      a.stepAcc += sp * dt
      if (a.stepAcc > 2.1) {
        a.stepAcc = 0
        const metal = (this.map.layout.floor[toCell(a.body.z)]?.[toCell(a.body.x)] ?? 0) > 0
        if (a === L) this.sfx.step(null, null, 0.25, metal)
        else this.sfx.step(a.body.x, a.body.z, 1, metal)
        this.sounds.push({ x: a.body.x, z: a.body.z, by: a, kind: 'step', t: this.time })
      }
    }
    if (this.sounds.length > 40) this.sounds = this.sounds.filter((s) => this.time - s.t < 0.6)
    this.grenades.update(dt)
    this.effects.update(dt)
    for (const a of this.actors) if (a.visual) a.visual.update(a, dt, a.alive && this.time - a.weapon().lastFire < 0.15, !!this.bots.find((b) => b.a === a)?.target)
    // —— 胜负 ——
    if (this.phase === 'live') this.checkWin()
  }

  private checkWin() {
    if (this.mode === 'dm') return
    const aliveA = this.actors.some((a) => a.team === 'A' && a.alive), aliveB = this.actors.some((a) => a.team === 'B' && a.alive)
    if (this.mode === 'duel') {
      if (!aliveA) this.endRound('B', 'elim'); else if (!aliveB) this.endRound('A', 'elim')
      return
    }
    const tTeam = this.teamOfSide('T'), ctTeam = this.teamOfSide('CT')
    const tAlive = tTeam === 'A' ? aliveA : aliveB, ctAlive = ctTeam === 'A' ? aliveA : aliveB
    if (!ctAlive) this.endRound(tTeam, 'elim')
    else if (!tAlive && this.bomb.state !== 'planted') this.endRound(ctTeam, 'elim')
  }

  private useAction(a: Actor, use: boolean, dt: number) {
    if (!this.bombMode || this.phase !== 'live' || !a.alive) { a.actionT = 0; return }
    const b = this.bomb
    // 下包
    if (a.side === 'T' && a.hasC4 && b.state === 'carried' && use && a.slot === 'c4' && a.body.onGround) {
      const site = inSite(a.body.x, a.body.z)
      if (site) {
        if (a.actionT === 0 && a === this.player) this.sfx.plantTick()
        const before = Math.floor(a.actionT * 3)
        a.actionT += dt
        if (Math.floor(a.actionT * 3) !== before) { this.sfx.plantTick(); this.sounds.push({ x: a.body.x, z: a.body.z, by: a, kind: 'plant', t: this.time }) }
        if (a.actionT >= TIMES.plant) {
          a.actionT = 0; a.hasC4 = false
          b.state = 'planted'; b.site = site; b.carrier = null; b.pos.set(a.body.x, a.body.y, a.body.z)
          this.bombLeft = TIMES.bomb; this.beepT = 0
          this.plantedThisRound = true; this.planter = a
          a.money = Math.min(ECON.max, a.money + ECON.plantPlayer); a.stats.score += 2
          this.hud.center('C4 已安放！', 2)
          this.placeBombMesh()
          a.slot = a.bestSlot()
        }
        return
      }
    }
    // 拆包
    if (a.side === 'CT' && b.state === 'planted' && use && Math.hypot(a.body.x - b.pos.x, a.body.z - b.pos.z) < 1.6 && Math.abs(a.body.y - b.pos.y) < 1.5) {
      if (b.defuser && b.defuser !== a && b.defuser.alive && b.defuser.actionT > 0) { a.actionT = 0; return }
      b.defuser = a
      const before = Math.floor(a.actionT * 2)
      a.actionT += dt
      if (Math.floor(a.actionT * 2) !== before) { this.sfx.defuseTick(b.pos.x, b.pos.z); this.sounds.push({ x: b.pos.x, z: b.pos.z, by: a, kind: 'defuse', t: this.time }) }
      if (a.actionT >= (a.kit ? TIMES.defuseKit : TIMES.defuse)) {
        a.actionT = 0
        b.state = 'defused'; this.defuser = a
        a.money = Math.min(ECON.max, a.money + ECON.defusePlayer); a.stats.score += 2
        this.removeBombMesh()
        this.endRound(a.team, 'defuse')
      }
      return
    }
    if (b.defuser === a) b.defuser = null
    a.actionT = 0
  }

  private bombMesh: THREE.Mesh | null = null
  private bombMat: THREE.MeshStandardMaterial | null = null
  private bombGeo: THREE.BoxGeometry | null = null
  private placeBombMesh() {
    this.removeBombMesh()
    this.bombGeo = new THREE.BoxGeometry(0.34, 0.12, 0.24)
    this.bombMat = new THREE.MeshStandardMaterial({ color: 0x4a5a3a, roughness: 0.6, emissive: 0xff2010, emissiveIntensity: 0 })
    this.bombMesh = new THREE.Mesh(this.bombGeo, this.bombMat)
    this.bombMesh.position.copy(this.bomb.pos).setY(this.bomb.pos.y + 0.06)
    this.bombMesh.castShadow = true
    this.scene.add(this.bombMesh)
  }
  private removeBombMesh() {
    if (!this.bombMesh) return
    this.bombMesh.removeFromParent(); this.bombGeo?.dispose(); this.bombMat?.dispose()
    this.bombMesh = null; this.bombGeo = null; this.bombMat = null
  }
  private explodeBomb() {
    const p = this.bomb.pos
    this.bomb.state = 'exploded'
    this.removeBombMesh()
    this.grenades.boom(p, 22, 1.2); this.grenades.boom(p.clone().setY(p.y + 2), 14, 1.6)
    this.sfx.explosion(p.x, p.z, true)
    for (const a of this.actors) {
      if (!a.alive) continue
      const d = Math.hypot(a.body.x - p.x, a.body.y - p.y, a.body.z - p.z)
      const raw = 500 * Math.exp(-(d * d) / (2 * 11 * 11))
      if (raw < 1) continue
      this.damage(a, null, a.armor > 0 ? raw * 0.5 : raw, a.armor > 0 ? raw * 0.25 : 0, 'c4', false, null)
    }
    this.endRound(this.teamOfSide('T'), 'bomb')
  }

  /** CS 式地面加速 / 摩擦 / 空中控制 + 蹲伏 + AABB 碰撞 */
  private moveActor(a: Actor, mx: number, mz: number, jump: boolean, dt: number) {
    const b = a.body
    // 蹲伏（站起需头顶空间）
    if (a.wantCrouch) a.crouch = Math.min(1, a.crouch + dt * 8)
    else if (a.crouch > 0) {
      if (!this.map.overlap(b.x, b.y, b.z, STAND_H, b.r)) a.crouch = Math.max(0, a.crouch - dt * 8)
    }
    b.h = STAND_H + (CROUCH_H - STAND_H) * a.crouch
    const len = Math.hypot(mx, mz)
    if (len > 1) { mx /= len; mz /= len }
    const wish = len > 0.01 ? a.maxSpeed() : 0
    let t = dt
    const wasAir = !b.onGround
    if (wasAir) this.landY.set(a, Math.max(this.landY.get(a) ?? b.y, b.y))
    while (t > 1e-6) {
      const h = Math.min(SUB, t); t -= h
      if (b.onGround) {
        // 摩擦
        const sp = Math.hypot(b.vx, b.vz)
        if (sp > 0) {
          const control = Math.max(sp, 2.1)
          const drop = control * 5.2 * h
          const ns = Math.max(0, sp - drop) / sp
          b.vx *= ns; b.vz *= ns
        }
        if (wish > 0) {
          const cur = b.vx * mx + b.vz * mz
          const add = wish - cur
          if (add > 0) { const acc = Math.min(5.5 * wish * h, add); b.vx += mx * acc; b.vz += mz * acc }
        }
        if (jump) { b.vy = 7.3; b.onGround = false; jump = false }
      } else if (wish > 0) {
        const ws = Math.min(wish, 0.78)
        const cur = b.vx * mx + b.vz * mz
        const add = ws - cur
        if (add > 0) { const acc = Math.min(12 * wish * h, add); b.vx += mx * acc; b.vz += mz * acc }
      }
      // 超速（换枪变慢）时缓降
      this.map.moveBody(b, h)
    }
    if (wasAir && b.onGround) {
      const fall = (this.landY.get(a) ?? b.y) - b.y
      this.landY.delete(a)
      if (fall > 0.6) { const L = this.listener; this.sfx.land(a === L ? null : b.x, a === L ? null : b.z) }
      if (fall > 3.8) { const dmg = (fall - 3.8) * 22; this.damage(a, null, dmg, 0, 'world', false, null) }
    }
  }

  // ———————————————————— 视图 / HUD ————————————————————
  private updateView(dt: number) {
    const p = this.player
    // 观战目标
    let view: Actor = p
    if (!p.alive && this.mode !== 'dm') {
      const mates = this.actors.filter((a) => a.alive && a.team === p.team && a !== p)
      const pool = mates.length ? mates : this.actors.filter((a) => a.alive)
      if (pool.length) {
        const t = pool[((this.specIdx % pool.length) + pool.length) % pool.length]
        if (this.specTarget !== t) { if (this.specTarget?.visual) this.specTarget.visual.group.visible = true; this.specTarget = t; if (t.visual) t.visual.group.visible = false }
        view = t
      }
      this.hud.spectate(view !== p ? view.name : null)
    } else if (this.specTarget) { if (this.specTarget.visual) this.specTarget.visual.group.visible = true; this.specTarget = null; this.hud.spectate(null) }
    const b = view.body
    const w = view.weapon()
    // 视角后坐（子弹偏移的一半）
    const [ry, rp] = recoilAt(w.def, w.shotIdx)
    const k = view === p ? 0.5 : 0.25
    this.camera.position.set(b.x, view.eyeY, b.z)
    this.camera.rotation.set(view.pitch + rp * k * D2R, view.yaw - ry * k * D2R, 0)
    // 开镜
    const scopeFov = w.def.scope && w.scope > 0 && view === p ? w.def.scope[w.scope - 1] : 74
    if (Math.abs(this.camera.fov - scopeFov) > 0.01) { this.camera.fov = scopeFov; this.camera.updateProjectionMatrix() }
    const sz = this.game.renderer.getSize(_sz)
    const aspect = sz.x / Math.max(1, sz.y)
    if (Math.abs(this.camera.aspect - aspect) > 1e-3) { this.camera.aspect = aspect; this.camera.updateProjectionMatrix() }
    // 枪模
    const vm = this.viewmodel
    const showVm = view === p && p.alive && scopeFov === 74
    vm.group.visible = showVm
    if (showVm) {
      if (p.slot === 'grenade') vm.showItem('grenade', p.grenades[0] ?? 'he')
      else if (p.slot === 'c4') vm.showItem('c4')
      else vm.show(w.def.id)
      const reload01 = w.reloadT > 0 ? 1 - w.reloadT / w.def.reload : 0
      vm.update(dt, p.speed2(), p.body.onGround, reload01, Math.min(1, p.drawT / 0.5), this.lastMouse.dx, this.lastMouse.dy, p.crouch)
    }
    // 听者
    this.sfx.lx = b.x; this.sfx.lz = b.z; this.sfx.lyaw = view.yaw
    // 炸弹灯闪
    if (this.bombMat) this.bombMat.emissiveIntensity = this.bomb.state === 'planted' && this.beepT < 0.08 ? 3 : 0.2
  }

  private scoreRows(): ScoreRow[] {
    const rows = this.actors.map((a) => ({ name: a.name + (a.isPlayer ? '（你）' : a.diff === 'pro' ? ' ★' : ''), side: this.mode === 'dm' ? (a.isPlayer ? 'T' : 'CT') : a.side, k: a.stats.kills, d: a.stats.deaths, a: a.stats.assists, hs: a.stats.hs, mvp: a.stats.mvps, money: a.money, alive: a.alive, me: a.isPlayer, score: a.stats.score + a.stats.kills * 0 }))
    rows.sort((x, y) => (x.side === y.side ? y.score - x.score || y.k - x.k : x.side < y.side ? 1 : -1))
    return rows
  }

  private updateHud(dt: number) {
    const h = this.hud, p = this.player
    h.update(dt)
    const tTeam = this.teamOfSide('T')
    const cnt = (team: string) => this.actors.filter((a) => a.team === team && a.alive).length
    const tot = (team: string) => this.actors.filter((a) => a.team === team).length
    const fmt = (s: number) => `${Math.floor(Math.max(0, s) / 60)}:${String(Math.floor(Math.max(0, s) % 60)).padStart(2, '0')}`
    let timer: string, red = false
    if (this.phase === 'freeze') timer = fmt(this.phaseLeft)
    else if (this.bomb.state === 'planted') { timer = 'C4 ' + Math.ceil(this.bombLeft); red = true }
    else timer = fmt(this.phase === 'end' ? 0 : this.roundLeft)
    if (this.mode === 'dm') h.setTop(p.stats.kills, Math.max(0, ...this.actors.filter((a) => a !== p).map((a) => a.stats.kills)), fmt(this.roundLeft), this.roundLeft < 30, 1, 0, 1, 0)
    else {
      const ctTeam = tTeam === 'A' ? 'B' : 'A'
      h.setTop(this.score[tTeam as 'A' | 'B'], this.score[ctTeam as 'A' | 'B'], timer, red, cnt(tTeam), cnt(ctTeam), tot(tTeam), tot(ctTeam))
    }
    const view = this.specTarget ?? p
    h.setVitals(view.hp, view.armor, view.helmet, p.money, this.map.zoneAt(view.body.x, view.body.z))
    const w = view.weapon()
    if (view.slot === 'grenade') h.setAmmo(GRENADE_NAMES[view.grenades[0]] ?? '投掷物', String(view.grenades.length), ' 个', '')
    else if (view.slot === 'c4') h.setAmmo('C4 炸药', '', '', '在包点按住左键 / E 安放')
    else h.setAmmo(w.def.name, w.def.kind === 'knife' ? '—' : String(w.mag), w.def.kind === 'knife' ? '' : ` / ${w.reserve}`, [...view.grenades.map((g) => GRENADE_NAMES[g]), view.hasC4 ? 'C4' : '', view.kit ? '拆弹器' : ''].filter(Boolean).join(' · '))
    h.setVisibleCore(!h.endOpen)
    // 准星：散布 → 像素
    const scoped = view === p && w.def.scope && w.scope > 0
    h.scope(!!scoped)
    const sz = this.game.renderer.getSize(_sz)
    const pxPerRad = sz.y / 2 / Math.tan(this.camera.fov * D2R / 2)
    const inacc = view.alive ? inaccuracy(view, w) : 0
    h.crosshair(Math.max(3, inacc * pxPerRad * 0.9), view.alive && !scoped && w.def.kind !== 'sniper' && !h.buyOpen)
    h.blind(view.blindT > 0 ? Math.min(1, view.blindT / 1.5) : 0)
    // 进度条
    if (view.actionT > 0) h.progress(view.side === 'T' ? '正在安放 C4…' : view.kit ? '拆弹中（拆弹器）…' : '拆弹中…', view.actionT / (view.side === 'T' ? TIMES.plant : view.kit ? TIMES.defuseKit : TIMES.defuse))
    else h.progress(null)
    h.bomb(this.bomb.state === 'planted' ? `● C4 已安放于 ${this.bomb.site} 点` : this.bomb.state === 'dropped' ? '○ C4 掉落' : null)
    // 提示
    let hint: string | null = null
    if (p.alive && this.bombMode && this.phase === 'live') {
      if (p.hasC4 && inSite(p.body.x, p.body.z)) hint = p.slot === 'c4' ? '按住左键 / E 安放 C4' : '按 5 拿出 C4 安放'
      else if (p.side === 'CT' && this.bomb.state === 'planted' && Math.hypot(p.body.x - this.bomb.pos.x, p.body.z - this.bomb.pos.z) < 1.6) hint = '按住 E 拆除 C4'
    }
    if (this.phase === 'freeze' && !h.buyOpen && this.round > 0) hint = `购买阶段 ${Math.ceil(this.phaseLeft)} s · B 打开购买菜单`
    if (!document.pointerLockElement && !h.buyOpen && !h.endOpen && !this.paused && p.alive && !this.autopilot) hint = '点击画面锁定鼠标'
    h.hint(hint)
    h.scoreboard(this.sbOpen && !h.endOpen, this.scoreRows(), this.mode === 'dm' ? '死斗' : `回合 ${this.round} · ${this.score.A} : ${this.score.B}`)
    if (h.buyOpen && Math.floor(this.time * 2) !== Math.floor((this.time - dt) * 2)) this.refreshBuy()
    // 雷达
    const dots: RadarDot[] = []
    for (const a of this.actors) {
      if (a === view) continue
      if (!a.alive) { if (a.team === p.team && this.mode !== 'dm') dots.push({ x: a.body.x, z: a.body.z, kind: 'dead' }); continue }
      if (this.mode !== 'dm' && a.team === p.team) dots.push({ x: a.body.x, z: a.body.z, kind: 'mate', yaw: a.yaw })
      else if (this.time - a.spottedT < 1.5 || (p.alive && this.time - a.spottedT < 1.5)) dots.push({ x: a.body.x, z: a.body.z, kind: 'enemy' })
    }
    if (this.bomb.state === 'dropped' || this.bomb.state === 'planted') { if (p.side === 'T' || this.bomb.state === 'planted') dots.push({ x: this.bomb.pos.x, z: this.bomb.pos.z, kind: 'bomb' }) }
    else if (this.bomb.carrier && this.bomb.carrier !== view && p.side === 'T') dots.push({ x: this.bomb.carrier.body.x + 1.5, z: this.bomb.carrier.body.z, kind: 'bomb' })
    dots.push({ x: view.body.x, z: view.body.z, kind: 'me', yaw: view.yaw })
    h.radar(this.map.radarCanvas, view.body.x, view.body.z, view.yaw, dots)
  }

  /** 玩家视线下敌人被“看见”（雷达）：由 bot 感知相反方向，玩家队伍的 bot 看到的敌人也会标记 */
  render(dt: number) {
    if (this.disposed) return
    // 玩家自己看到的敌人也上雷达（每 0.2 s）
    if (this.player.alive && Math.floor(this.time * 5) !== Math.floor((this.time - dt) * 5)) {
      for (const a of this.actors) if (a.alive && this.isEnemy(this.player, a) && this.canSee(this.player, a)) {
        const f = this.player.forward(_v), dx = a.body.x - this.player.body.x, dz = a.body.z - this.player.body.z, d = Math.hypot(dx, dz)
        if ((dx * f.x + dz * f.z) / (d || 1) > 0.3) a.spottedT = this.time
      }
    }
    const r = this.game.renderer
    r.toneMapping = THREE.AgXToneMapping
    r.toneMappingExposure = 1.0 * (this.game.settings.brightness ?? 1)
    const fx = this.game.postfx
    if (fx) { fx.setScene(this.scene, this.camera); fx.setGrade(this.grade); fx.render(dt) }
    else r.render(this.scene, this.camera)
    // CPU 帧耗时（模拟 + 提交渲染命令；GPU 异步不计）
    this.cpuMs += (performance.now() - this.frameT0 - this.cpuMs) * 0.05
  }
  private frameT0 = 0
  cpuMs = 0

  dispose() {
    if (this.disposed) return
    // 中途离开 = 投降（记一场负，天梯扣分）
    if (this.phase !== 'over') { try { this.matchOver(true) } catch (e) { console.error(e) } }
    if (!this.reported) this.report()
    this.disposed = true
    window.removeEventListener('keydown', this.keyHandler, true)
    document.removeEventListener('pointerlockchange', this.lockHandler)
    if (document.pointerLockElement) document.exitPointerLock()
    for (const a of this.actors) a.visual?.dispose()
    this.removeBombMesh()
    this.grenades.dispose(); this.effects.dispose(); this.viewmodel.dispose(); this.map.dispose()
    this.hud.dispose(); this.sfx.dispose()
    this.skyGeo.dispose(); this.skyMat.dispose()
    this.sun.dispose()
    this.envRT?.dispose(); this.envRT = null
    this.scene.environment = null
    this.scene.clear()
    const r = this.game.renderer
    r.toneMappingExposure = this.saved.exposure; r.toneMapping = this.saved.toneMapping; r.shadowMap.enabled = this.saved.shadow; r.autoClear = this.saved.autoClear
    LOOK.uRimStrength.value = this.saved.rim; LOOK.uRimColor.value.copy(this.saved.rimColor)
    this.game.postfx?.resetScene()
    this.game.audio.setMasterVolume(this.cityVolume)
  }

  // ———————————————————— 调试 ————————————————————
  debugState() {
    const p = this.player
    return {
      mode: this.mode, phase: this.phase, round: this.round, score: { ...this.score }, sides: { ...this.teamSide }, timer: +(this.phase === 'freeze' ? this.phaseLeft : this.roundLeft).toFixed(1),
      bomb: { state: this.bomb.state, site: this.bomb.site, left: +this.bombLeft.toFixed(1), carrier: this.bomb.carrier?.name ?? null, pos: [+this.bomb.pos.x.toFixed(1), +this.bomb.pos.z.toFixed(1)] },
      player: { hp: Math.ceil(p.hp), armor: p.armor, helmet: p.helmet, money: p.money, weapon: p.weapon().def.id, slot: p.slot, mag: p.weapon().mag, alive: p.alive, side: p.side, pos: [+p.body.x.toFixed(2), +p.body.y.toFixed(2), +p.body.z.toFixed(2)], yaw: +p.yaw.toFixed(3), pitch: +p.pitch.toFixed(3), stats: { ...p.stats }, grenades: [...p.grenades], hasC4: p.hasC4 },
      bots: this.bots.map((b) => ({ name: b.a.name, team: b.a.team, side: b.a.side, diff: b.a.diff, alive: b.a.alive, hp: Math.ceil(b.a.hp), pos: [+b.a.body.x.toFixed(1), +b.a.body.y.toFixed(2), +b.a.body.z.toFixed(1)], state: b.state, goal: b.goal.k, target: b.target?.name ?? null, weapon: b.a.weapon().def.id, money: b.a.money, stats: { ...b.a.stats }, anim: b.a.visual?.anim ?? '' })),
      autopilot: this.autopilot ? { state: this.autopilot.state, target: this.autopilot.target?.name ?? null } : null,
      fps: Math.round(this.fps), cpuMs: +this.cpuMs.toFixed(2), paused: this.paused, buyOpen: this.hud.buyOpen, endOpen: this.hud.endOpen, result: this.result,
    }
  }
  debugTeleport(x: number, z: number) { const b = this.player.body; b.x = x; b.z = z; b.y = this.map.support(x, 20, z, b.r, 0); b.vx = b.vz = b.vy = 0 }
  debugAimAt(i: number, part: 'head' | 'chest' = 'head') {
    const t = this.bots[i]?.a; if (!t) return false
    const p = part === 'head' ? headCenter(t, _v) : chestPoint(t, _v)
    const dx = p.x - this.player.body.x, dy = p.y - this.player.eyeY, dz = p.z - this.player.body.z
    this.player.yaw = Math.atan2(-dx, -dz); this.player.pitch = Math.atan2(dy, Math.hypot(dx, dz))
    return true
  }
  debugFire() {
    const w = this.player.weapon()
    this.player.drawT = 0; w.nextFire = 0; w.reloadT = 0; w.shotIdx = 0; w.bloom = 0
    const hp = this.actors.map((a) => a.hp)
    const ok = this.tryFire(this.player)
    return { fired: ok, damaged: this.actors.map((a, i) => ({ name: a.name, before: Math.ceil(hp[i]), after: Math.ceil(a.hp), alive: a.alive })).filter((x) => x.before !== x.after) }
  }
  debugGiveC4() {
    for (const a of this.actors) a.hasC4 = false
    this.player.hasC4 = true; this.bomb.state = 'carried'; this.bomb.carrier = this.player
  }
  debugSelect(slot: 'primary' | 'secondary' | 'knife' | 'grenade' | 'c4') { this.selectSlot(this.player, slot); this.player.drawT = 0 }
  debugKillAll(side: Side) { for (const a of this.actors) if (a.alive && a.side === side) this.damage(a, null, 999, 0, 'world', false, null) }
  debugSkipRound() {
    if (this.phase === 'freeze') { this.phaseLeft = 0.01; return }
    if (this.phase === 'live') { this.debugKillAll(this.player.side === 'T' ? 'CT' : 'T'); return }
    if (this.phase === 'end') this.phaseLeft = 0.01
  }
  debugForceEnd(won: boolean) {
    const winN = this.mode === 'duel' ? MATCH.duelWin : MATCH.winRounds
    if (this.mode === 'dm') { this.player.stats.kills = won ? 99 : 0; this.matchOver(false); return }
    this.score = won ? { A: winN, B: Math.min(this.score.B, winN - 1) } : { A: Math.min(this.score.A, winN - 1), B: winN }
    this.matchOver(false)
  }
  setDifficulty(d: Difficulty) { for (const b of this.bots) if (b.a.team !== this.player.team) b.setDifficulty(d) }
  setAutopilot(on: boolean, diff: Difficulty = 'pro') {
    if (on && this.autopilot) this.autopilot.setDifficulty(diff)
    if (on && !this.autopilot) { this.autopilot = new Bot(this.player, diff, 0); this.autopilot.resetRound(); if (this.phase === 'live') this.autopilot.assignHunt(this) }
    else if (!on) this.autopilot = null
  }
}
