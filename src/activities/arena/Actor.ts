import * as THREE from 'three'
import type { CharacterLibrary } from '../../characters/CharacterLibrary'
import { CharacterInstance } from '../../characters/CharacterInstance'
import { specFromPreset } from '../../characters/CharacterSpec'
import { WEAPONS, type Side, type Slot, type WeaponDef, type Difficulty } from '../../data/arena'
import type { Body } from './ArenaMap'

export const STAND_H = 1.83, CROUCH_H = 1.37, EYE_STAND = 1.64, EYE_CROUCH = 1.2, BODY_R = 0.4

/** 一把枪的运行状态 */
export class WeaponState {
  mag: number
  reserve: number
  reloadT = 0
  nextFire = 0
  /** 连发序号（后坐力图案索引，停火后衰减） */
  shotIdx = 0
  bloom = 0
  lastFire = -9
  /** 开镜档 0/1/2 */
  scope = 0
  constructor(readonly def: WeaponDef) { this.mag = def.mag; this.reserve = def.reserve }
  get reloading() { return this.reloadT > 0 }
}

export interface ActorStats { kills: number; deaths: number; assists: number; hs: number; dmg: number; mvps: number; score: number }

const fwd = new THREE.Vector3()

/** 竞技场角色（玩家或 bot）：物理体 + 战斗状态 + 视觉 */
export class Actor {
  body: Body = { x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, onGround: true, h: STAND_H, r: BODY_R }
  /** 朝向：forward = (-sin yaw, -cos yaw)（与相机一致） */
  yaw = 0
  pitch = 0
  crouch = 0
  wantCrouch = false
  walking = false
  hp = 100
  armor = 0
  helmet = false
  kit = false
  alive = true
  money = 800
  primary: WeaponState | null = null
  secondary: WeaponState | null = null
  knife = new WeaponState(WEAPONS.knife)
  grenades: string[] = []
  hasC4 = false
  slot: Slot = 'secondary'
  /** 上一个武器槽（Q 切换） */
  lastSlot: Slot = 'knife'
  /** 切枪剩余时间 */
  drawT = 0
  stats: ActorStats = { kills: 0, deaths: 0, assists: 0, hs: 0, dmg: 0, mvps: 0, score: 0 }
  /** 本回合受到的伤害来源（助攻） */
  dmgFrom = new Map<Actor, number>()
  roundKills = 0
  /** 被闪白剩余时间 */
  blindT = 0
  /** 下包/拆包进度 */
  actionT = 0
  /** 上次发出脚步声 */
  stepAcc = 0
  /** 死亡时刻（尸体淡出等） */
  deadAt = 0
  visual: ActorVisual | null = null
  /** 外观变体序号 */
  variant = 0
  /** 最近一次被敌人看到（雷达显示） */
  spottedT = -9
  constructor(readonly id: number, public name: string, public team: string, public side: Side, readonly isPlayer: boolean, public diff: Difficulty = 6) {}

  get eyeY() { return this.body.y + EYE_STAND + (EYE_CROUCH - EYE_STAND) * this.crouch }
  get pos() { return this.body }
  weapon(): WeaponState {
    if (this.slot === 'primary' && this.primary) return this.primary
    if (this.slot === 'secondary' && this.secondary) return this.secondary
    return this.knife
  }
  hasSlot(s: Slot): boolean {
    return s === 'primary' ? !!this.primary : s === 'secondary' ? !!this.secondary : s === 'knife' ? true : s === 'grenade' ? this.grenades.length > 0 : this.hasC4
  }
  /** 当前最好的枪槽 */
  bestSlot(): Slot { return this.primary ? 'primary' : this.secondary ? 'secondary' : 'knife' }
  forward(out = fwd): THREE.Vector3 {
    const cp = Math.cos(this.pitch)
    return out.set(-Math.sin(this.yaw) * cp, Math.sin(this.pitch), -Math.cos(this.yaw) * cp)
  }
  /** 当前移动速度上限（持枪 / 静步 / 蹲） */
  maxSpeed(): number {
    const w = this.slot === 'grenade' ? WEAPONS.glock : this.slot === 'c4' ? WEAPONS.knife : this.weapon().def
    let s = w.speed
    if (w.kind === 'sniper' && this.weapon().scope > 0) s = 100 * 0.026
    if (this.walking) s *= 0.52
    if (this.crouch > 0.5) s *= 0.34
    return s
  }
  speed2() { return Math.hypot(this.body.vx, this.body.vz) }
  resetForRound() {
    this.hp = 100; this.alive = true; this.blindT = 0; this.actionT = 0; this.crouch = 0; this.wantCrouch = false
    this.body.vx = this.body.vy = this.body.vz = 0; this.body.onGround = true; this.body.h = STAND_H
    this.dmgFrom.clear(); this.roundKills = 0; this.drawT = 0
    for (const w of [this.primary, this.secondary]) if (w) { w.reloadT = 0; w.shotIdx = 0; w.bloom = 0; w.scope = 0 }
  }
  /** 死亡掉落：失去全部武器与装备（下回合默认手枪） */
  stripOnDeath(defaultPistol: string) {
    this.primary = null
    this.secondary = new WeaponState(WEAPONS[defaultPistol])
    this.grenades = []; this.armor = 0; this.helmet = false; this.kit = false; this.hasC4 = false
  }
}

// ———————————————————— 视觉：骨骼角色 / 方块回退 ————————————————————
const gunGeo = () => {
  const g = new THREE.BoxGeometry(0.06, 0.09, 0.55); g.translate(0, 0, 0.18); return g
}

/** bot 外观：CharacterLibrary 可用时为 Quaternius 骨骼角色，否则方块人 */
export class ActorVisual {
  readonly group = new THREE.Group()
  char: CharacterInstance | null = null
  private boxRoot: THREE.Group | null = null
  private gun: THREE.Mesh
  private gunMat: THREE.MeshStandardMaterial
  private disposables: { dispose(): void }[] = []
  private chest: THREE.Bone | null = null
  private dead = false
  private hitT = 0
  private flashT = 0
  anim = ''
  constructor(lib: CharacterLibrary | null, side: Side, variant: number) {
    this.gunMat = new THREE.MeshStandardMaterial({ color: 0x222428, roughness: 0.45, metalness: 0.6 })
    const gg = gunGeo()
    this.gun = new THREE.Mesh(gg, this.gunMat)
    this.gun.castShadow = true
    this.disposables.push(this.gunMat, gg)
    if (lib) {
      const presetsT = ['ped_worker', 'ped_rider', 'ped_student', 'default_gang', 'ped_punk_f']
      const presetsCT = ['ped_office_m', 'default_white', 'default_gold', 'ped_tourist', 'ped_office_f']
      const spec = specFromPreset((side === 'T' ? presetsT : presetsCT)[variant % 5])
      if (side === 'T') { spec.colors.top = ['#8a5a2b', '#6b4f2a', '#7a3b2a', '#5a5a3a', '#8c6239'][variant % 5]; spec.colors.bottom = '#3a3328'; spec.colors.hat = '#4a3b2a' }
      else { spec.colors.top = ['#1f2a44', '#22324f', '#2b3a55', '#1b2a3a', '#26314a'][variant % 5]; spec.colors.bottom = '#20252e'; spec.colors.hat = '#1a2233' }
      spec.parts.hat = side === 'T' ? (variant % 2 ? 'cap' : null) : (variant % 3 === 0 ? 'cap' : null)
      const ci = new CharacterInstance(lib, spec)
      ci.setShadow(true, true)
      this.char = ci
      this.group.add(ci.group)
      ci.group.rotation.y = Math.PI   // 模型 +Z 为正面，角色 forward = -Z
      // 枪挂右手腕
      const wrist = ci.skeleton.bones.find((b) => b.name === 'WristR')
      this.chest = ci.skeleton.bones.find((b) => b.name === 'Chest') ?? null
      if (wrist) {
        // 骨骼空间为量化单位，按世界尺度反缩放
        wrist.updateWorldMatrix(true, false)
        const s = new THREE.Vector3(); wrist.getWorldScale(s)
        this.gun.scale.setScalar(1 / Math.max(1e-6, s.x))
        this.gun.rotation.set(0, 0, 0)
        this.gunHolder = new THREE.Group()
        this.gunHolder.add(this.gun)
        wrist.add(this.gunHolder)
      } else this.group.add(this.gun)
      ci.play('AimIdle')
      this.anim = 'AimIdle'
    } else {
      const root = new THREE.Group()
      const col = side === 'T' ? 0x8a5a2b : 0x24344f
      const mBody = new THREE.MeshStandardMaterial({ color: col, roughness: 0.8 })
      const mSkin = new THREE.MeshStandardMaterial({ color: 0xd9a56f, roughness: 0.7 })
      const mLeg = new THREE.MeshStandardMaterial({ color: 0x2a2a2a, roughness: 0.9 })
      const gT = new THREE.BoxGeometry(0.5, 0.65, 0.3), gH = new THREE.BoxGeometry(0.26, 0.28, 0.26), gL = new THREE.BoxGeometry(0.42, 0.85, 0.26)
      this.disposables.push(mBody, mSkin, mLeg, gT, gH, gL)
      const torso = new THREE.Mesh(gT, mBody); torso.position.y = 1.2
      const head = new THREE.Mesh(gH, mSkin); head.position.y = 1.68
      const legs = new THREE.Mesh(gL, mLeg); legs.position.y = 0.43
      for (const m of [torso, head, legs]) { m.castShadow = true; root.add(m) }
      this.gun.position.set(0.18, 1.3, -0.2); this.gun.rotation.y = Math.PI
      root.add(this.gun)
      this.boxRoot = root
      this.group.add(root)
    }
  }
  private gunHolder: THREE.Group | null = null
  private calibrated = false
  /** 首帧（持枪待机姿势）按手腕世界朝向校准枪的局部旋转：枪管对准角色正前方、枪身水平 */
  private calibrateGun() {
    this.calibrated = true
    const h = this.gunHolder, ci = this.char
    if (!h || !ci) return
    ci.group.updateWorldMatrix(true, true)
    const qW = new THREE.Quaternion(), qG = new THREE.Quaternion()
    h.parent!.getWorldQuaternion(qW)
    ci.group.getWorldQuaternion(qG)
    h.quaternion.copy(qW.invert().multiply(qG))
  }

  setGunColor(hex: number) { this.gunMat.color.setHex(hex) }

  /** 每帧：位置、朝向、动画（按移动方向选 Run/RunLeft/RunRight/RunBack） */
  update(a: Actor, dt: number, shooting: boolean, aiming: boolean) {
    const b = a.body
    this.group.position.set(b.x, b.y, b.z)
    if (this.dead) {
      if (this.char) this.char.update(dt)
      else if (this.boxRoot) this.boxRoot.rotation.x = Math.max(-Math.PI / 2, this.boxRoot.rotation.x - dt * 5)
      return
    }
    this.group.rotation.y = a.yaw
    this.hitT -= dt; this.flashT -= dt
    const sp = Math.hypot(b.vx, b.vz)
    let clip: string
    if (sp > 0.6) {
      // 相对朝向的移动方向
      const fx = -Math.sin(a.yaw), fz = -Math.cos(a.yaw)
      const f = (b.vx * fx + b.vz * fz) / sp, r = (b.vx * -fz + b.vz * fx) / sp
      if (shooting) clip = 'RunShoot'
      else if (f > 0.6) clip = sp < 3 ? 'Walk' : 'Run'
      else if (f < -0.6) clip = 'RunBack'
      else clip = r > 0 ? 'RunRight' : 'RunLeft'
    } else clip = shooting ? 'AimShoot' : aiming ? 'Aim' : 'AimIdle'
    if (this.hitT > 0 && !shooting && sp < 0.6) clip = 'Hit'
    if (this.char) {
      if (clip !== this.anim) { this.char.play(clip, { fade: 0.12, loop: clip !== 'Hit', timeScale: clip.startsWith('Run') ? Math.max(0.6, Math.min(1.3, sp / 5.5)) : 1 }); this.anim = clip }
      this.char.update(dt)
      if (!this.calibrated) this.calibrateGun()
      // 上身俯仰（瞄准高低）
      if (this.chest) this.chest.rotateX(-a.pitch * 0.8)
      this.char.setTint(this.flashT > 0 ? 0xff3030 : null, 0.3)
    } else if (this.boxRoot) {
      this.boxRoot.rotation.x = 0
      this.boxRoot.position.y = sp > 0.6 ? Math.abs(Math.sin(performance.now() / 120)) * 0.05 : 0
    }
  }
  hit() { this.hitT = 0.25; this.flashT = 0.08 }
  die() {
    if (this.dead) return
    this.dead = true
    if (this.char) { this.char.play('Death', { loop: false, fade: 0.08 }); this.char.setTint(null) }
    this.gun.visible = false
  }
  revive() {
    this.dead = false; this.gun.visible = true
    if (this.char) { this.char.play('AimIdle', { fade: 0 }); this.anim = 'AimIdle' }
    if (this.boxRoot) this.boxRoot.rotation.x = 0
  }
  dispose() {
    this.char?.dispose()
    for (const d of this.disposables) d.dispose()
    this.group.removeFromParent()
  }
}
