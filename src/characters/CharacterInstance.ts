import * as THREE from 'three'
import type { CharacterLibrary } from './CharacterLibrary'
import type { CharacterSpec } from './CharacterSpec'
import { validateSpec } from './CharacterSpec'

export interface PlayOptions { fade?: number; loop?: boolean; timeScale?: number }

const _tmpColor = new THREE.Color()

/**
 * 一个角色实例：自己的骨骼 + 一个合并后的 SkinnedMesh（1 draw call）+ AnimationMixer。
 * group 原点在脚底，+Z 为正面；身高约 1.86 m。
 */
export class CharacterInstance {
  readonly group = new THREE.Group()
  mesh: THREE.SkinnedMesh
  readonly mixer: THREE.AnimationMixer
  spec: CharacterSpec
  readonly skeleton: THREE.Skeleton
  readonly root: THREE.Object3D
  readonly headBone: THREE.Bone
  readonly hipsBone: THREE.Bone
  /** 当前动画别名 */
  current: string | null = null
  private currentAction: THREE.AnimationAction | null = null
  private readonly material: THREE.MeshLambertMaterial
  private lodAcc = 0
  private lodTick = 0
  private disposed = false

  constructor(readonly lib: CharacterLibrary, spec: CharacterSpec) {
    this.spec = validateSpec(spec)
    const { root, skeleton, bones } = lib.createSkeleton()
    this.root = root; this.skeleton = skeleton
    this.headBone = bones.find((b) => b.name === lib.headBoneName) ?? bones[0]
    this.hipsBone = bones.find((b) => b.name === lib.hipsBoneName) ?? bones[0]
    this.material = lib.material.clone()
    this.mesh = new THREE.SkinnedMesh(lib.acquireGeometry(this.spec), this.material)
    this.mesh.name = 'character'
    // 自带包围球（骨骼空间，脚底原点）：几何本身是量化坐标，不能用来算
    this.mesh.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 0.95, 0), 1.5)
    this.mesh.boundingBox = new THREE.Box3(new THREE.Vector3(-1.2, -0.1, -1.2), new THREE.Vector3(1.2, 2.1, 1.2))
    this.mesh.bind(skeleton, lib.identity)
    root.add(this.mesh)
    this.group.add(root)
    this.mixer = new THREE.AnimationMixer(root)
  }

  /** 换装：按新 spec 重建几何，动画状态不变 */
  setSpec(spec: CharacterSpec) {
    if (this.disposed) return
    const next = validateSpec(spec)
    const old = this.mesh.geometry
    const geometry = this.lib.acquireGeometry(next)
    if (geometry !== old) {
      this.mesh.geometry = geometry
      this.lib.releaseGeometry(old)
    }
    this.spec = next
  }

  /**
   * 播放动画。loop=true 且已在播同一动作 → 不打断；loop=false → 每次从头播并定格最后一帧（clampWhenFinished）。
   * 返回 action 便于监听 mixer 'finished'。
   */
  play(alias: string, opts: PlayOptions = {}): THREE.AnimationAction | null {
    const { fade = 0.15, loop = true, timeScale = 1 } = opts
    const clip = this.lib.clips.get(alias)
    if (!clip) { console.warn(`[CharacterInstance] 没有动画 ${alias}`); return null }
    const action = this.mixer.clipAction(clip)
    const prev = this.currentAction
    if (prev === action) {
      action.timeScale = timeScale
      if (loop && action.isRunning()) return action
      if (loop) { action.setLoop(THREE.LoopRepeat, Infinity); action.clampWhenFinished = false; action.paused = false; action.enabled = true; action.setEffectiveWeight(1); action.play(); return action }
      action.reset(); action.setLoop(THREE.LoopOnce, 1); action.clampWhenFinished = true; action.setEffectiveWeight(1); action.play()
      return action
    }
    action.reset()
    action.setLoop(loop ? THREE.LoopRepeat : THREE.LoopOnce, loop ? Infinity : 1)
    action.clampWhenFinished = !loop
    action.enabled = true
    action.setEffectiveTimeScale(timeScale)
    action.setEffectiveWeight(1)
    action.play()
    if (prev) {
      if (fade > 0) action.crossFadeFrom(prev, fade, false)
      else prev.stop()
    }
    this.currentAction = action
    this.current = alias
    return action
  }

  /** 当前动作是否已播完（一次性动画定格后为 true） */
  get finished() {
    const a = this.currentAction
    return !!a && a.loop === THREE.LoopOnce && !a.isRunning() && a.time >= a.getClip().duration - 1e-4
  }

  /** 受击闪红等：null 取消。用 emissive 实现，不影响顶点色 */
  setTint(color: THREE.ColorRepresentation | null, intensity = 0.55) {
    if (color === null) { this.material.emissive.set(0x000000); this.material.emissiveIntensity = 1; return }
    this.material.emissive.copy(_tmpColor.set(color))
    this.material.emissiveIntensity = intensity
  }

  /** lod 0 全速；1 半频（累计两帧的 dt 再推进）；2 冻结 */
  update(dt: number, lod: 0 | 1 | 2 = 0) {
    if (lod === 2) return
    this.lodAcc += dt
    if (lod === 1 && (this.lodTick ^= 1) === 1) return
    const step = this.lodAcc
    this.lodAcc = 0
    this.mixer.update(step)
  }

  setShadow(cast: boolean, receive = cast) { this.mesh.castShadow = cast; this.mesh.receiveShadow = receive }

  /** Head 骨世界坐标（会刷新父链矩阵） */
  headPosition(out: THREE.Vector3): THREE.Vector3 { return this.headBone.getWorldPosition(out) }

  /** Hips 骨世界坐标 */
  hipsPosition(out: THREE.Vector3): THREE.Vector3 { return this.hipsBone.getWorldPosition(out) }

  dispose() {
    if (this.disposed) return
    this.disposed = true
    this.mixer.stopAllAction()
    this.mixer.uncacheRoot(this.root)
    this.lib.releaseGeometry(this.mesh.geometry)
    this.material.dispose()
    this.skeleton.dispose()
    this.group.removeFromParent()
    this.currentAction = null
    this.current = null
  }
}
