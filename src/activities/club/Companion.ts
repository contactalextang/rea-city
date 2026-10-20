import * as THREE from 'three'
import type { CharacterLibrary } from '../../characters/CharacterLibrary'
import { CharacterInstance } from '../../characters/CharacterInstance'
import { validateSpec, type CharacterSpec } from '../../characters/CharacterSpec'
import type { NpcDef } from '../../data/dates'
import type { Player } from '../../entities/Player'

/** NPC 外观：性别取 npc.gender，部件与颜色取 npc.look（与立绘同一套颜色） */
export function npcSpec(npc: NpcDef): CharacterSpec {
  const L = npc.look
  return validateSpec({
    v: 1, body: npc.gender,
    parts: { head: L.head, body: L.body, legs: L.legs, feet: L.feet, hat: L.hat },
    colors: { skin: L.skin, hair: L.hair, top: L.top, bottom: L.bottom, shoes: L.shoes, hat: L.hatColor ?? L.top, accent: L.accent ?? '#ffffff' },
  })
}

const FOLLOW_GAP = 1.7
/**
 * 约会同伴：一个独立角色实例（骨骼角色库可用时用 CharacterInstance，?chars=box 时用彩色方块人），
 * 先在约会地点门口等候（Idle + 招手），玩家走近后跟在身后；玩家上车时“上车”隐藏、下车后出现在身边。
 */
export class Companion {
  readonly group = new THREE.Group()
  private char: CharacterInstance | null = null
  x: number; z: number; yaw: number
  /** 'wait' = 门口等候；'follow' = 跟随玩家 */
  mode: 'wait' | 'follow' = 'wait'
  private anim = ''

  constructor(readonly npc: NpcDef, private scene: THREE.Scene, lib: CharacterLibrary | null, x: number, z: number, yaw: number) {
    this.x = x; this.z = z; this.yaw = yaw
    if (lib) {
      this.char = new CharacterInstance(lib, npcSpec(npc))
      this.char.mesh.name = 'companion'
      this.group.add(this.char.group)
      this.play('Idle')
    } else {
      const L = npc.look
      const mk = (w: number, h: number, d: number, y: number, c: string) => { const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), new THREE.MeshLambertMaterial({ color: c })); m.position.y = y; m.castShadow = true; return m }
      const f = npc.gender === 'f'
      this.group.add(mk(f ? 0.36 : 0.4, 0.78, 0.26, 0.39, L.bottom), mk(f ? 0.4 : 0.48, 0.6, 0.28, 1.08, L.top), mk(0.28, 0.3, 0.28, 1.55, L.skin), mk(0.3, 0.1, 0.3, 1.74, L.hair))
      if (f) this.group.add(mk(0.3, 0.42, 0.1, 1.5, L.hair).translateZ(-0.16))   // 长发
      if (L.hat) this.group.add(mk(0.32, 0.1, 0.36, 1.8, L.hatColor ?? L.top))
    }
    this.group.name = `companion_${npc.id}`
    this.sync()
    scene.add(this.group)
  }

  private play(a: string) {
    if (!this.char || this.anim === a) return
    this.anim = a
    this.char.play(a, { fade: 0.25 })
  }

  /** 每帧：等候时招手（玩家 25 m 内），玩家 6 m 内转为跟随 */
  update(dt: number, pl: Player) {
    const px = pl.worldX, pz = pl.worldZ
    const dx = px - this.x, dz = pz - this.z, d = Math.hypot(dx, dz)
    if (this.mode === 'wait') {
      if (d < 25) this.yaw = Math.atan2(dx, dz)
      this.play(d < 25 && d > 4 ? 'Wave' : 'Idle')
      if (d < 6) this.mode = 'follow'
    } else if (pl.inVehicle) {
      // 一起坐车：藏起来，跟着车走
      this.group.visible = false
      this.x = px; this.z = pz
      this.char?.update(dt, 2)
      return
    } else {
      if (!this.group.visible) {
        // 刚下车：出现在玩家右后方
        this.group.visible = true
        this.x = pl.x - Math.sin(pl.yaw) * FOLLOW_GAP + Math.cos(pl.yaw) * 0.9
        this.z = pl.z - Math.cos(pl.yaw) * FOLLOW_GAP - Math.sin(pl.yaw) * 0.9
      }
      // 目标点：玩家身后偏右
      const tx = pl.x - Math.sin(pl.yaw) * FOLLOW_GAP + Math.cos(pl.yaw) * 0.7
      const tz = pl.z - Math.cos(pl.yaw) * FOLLOW_GAP - Math.sin(pl.yaw) * 0.7
      const ex = tx - this.x, ez = tz - this.z, e = Math.hypot(ex, ez)
      if (d > 30) { this.x = tx; this.z = tz }
      else if (e > 0.25) {
        const sp = e > 4 ? 6 : e > 1.2 ? 3.2 : 1.6
        const step = Math.min(e, sp * dt)
        this.x += (ex / e) * step; this.z += (ez / e) * step
        this.yaw = dampYaw(this.yaw, Math.atan2(ex, ez), 10 * dt)
        this.play(sp >= 6 ? 'Run' : 'Walk')
      } else {
        if (d > 0.5) this.yaw = dampYaw(this.yaw, Math.atan2(dx, dz), 4 * dt)
        this.play('Idle')
      }
    }
    this.sync()
    this.char?.update(dt, 0)
  }

  /** 玩家到这里的距离（步行 / 车里都按世界坐标） */
  dist(pl: Player) { return Math.hypot(pl.worldX - this.x, pl.worldZ - this.z) }
  get visible() { return this.group.visible }

  private sync() { this.group.position.set(this.x, 0, this.z); this.group.rotation.y = this.yaw }

  dispose() {
    this.scene.remove(this.group)
    if (this.char) this.char.dispose()
    else this.group.traverse((o) => { const m = o as THREE.Mesh; if (m.isMesh) { m.geometry.dispose(); (m.material as THREE.Material).dispose() } })
  }
}

function dampYaw(a: number, b: number, k: number) {
  let d = b - a
  while (d > Math.PI) d -= Math.PI * 2
  while (d < -Math.PI) d += Math.PI * 2
  return a + d * Math.min(1, k)
}
