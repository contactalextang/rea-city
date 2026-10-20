import * as THREE from 'three'
import type { CharacterSpec, Role, Slot } from './CharacterSpec'
import { specKey } from './CharacterSpec'
import { CHAR_UNIFORMS, CharacterMaterial, createCharacterMaterial, matClassOf } from './CharacterMaterial'

/** 部件里按材质划分的顶点区间（合并后用于按 role 上色） */
export interface PartGroup { start: number; count: number; materialName: string; role: Role; defaultColor: string }

export interface PartDef {
  id: string
  slot: Slot
  gender: 'm' | 'f' | 'any'
  set: string
  label: string
  tris: number
  /** 该部件所有 primitive 合并后的几何（非交错：position/normal/skinIndex/skinWeight，无 uv） */
  geometry: THREE.BufferGeometry
  groups: PartGroup[]
}

export interface CatalogPreset {
  id: string
  label: string
  body: 'm' | 'f'
  parts: Partial<Record<Slot, string | null>>
  colors: Partial<Record<Role, string>>
  note?: string
}

interface CatalogPart {
  id: string; slot: Slot; gender: 'm' | 'f' | 'any'; set: string; label: string; node: string; nodeThree: string; tris: number
  materials: { name: string; role: Role; default: string }[]
}

interface Catalog {
  version: number
  file: string
  skeleton: { joints: string[]; jointsThree: string[]; head: string; hips: string; armature: string }
  slots: Slot[]
  parts: CatalogPart[]
  clips: Record<string, string>
  presets: CatalogPreset[]
}

const _identity = new THREE.Matrix4()

/**
 * 把多个蒙皮几何首尾拼接成一个（不改变顶点属性类型 / normalized，
 * 比 BufferGeometryUtils.mergeGeometries 少一次复制，并返回每段的顶点偏移）。
 */
function concatGeometries(geos: THREE.BufferGeometry[]): { geometry: THREE.BufferGeometry; offsets: number[] } {
  const first = geos[0]
  const names = Object.keys(first.attributes)
  let totalV = 0, totalI = 0
  const offsets: number[] = []
  for (const g of geos) {
    offsets.push(totalV)
    totalV += g.attributes.position.count
    totalI += g.index ? g.index.count : g.attributes.position.count
  }
  const out = new THREE.BufferGeometry()
  for (const name of names) {
    const a0 = first.getAttribute(name)
    const Ctor = a0.array.constructor as unknown as new (n: number) => THREE.TypedArray
    const arr = new Ctor(totalV * a0.itemSize)
    let off = 0
    for (const g of geos) {
      const a = g.getAttribute(name)
      if (a.itemSize !== a0.itemSize) throw new Error(`concatGeometries：属性 ${name} itemSize 不一致`)
      const ia = a as THREE.InterleavedBufferAttribute
      if (ia.isInterleavedBufferAttribute) {
        // glb 里 Int16×3 / Int8×3 的属性带 padding（byteStride），GLTFLoader 给出交错属性：
        // 必须按 stride 读原始整数（getComponent 会返回反归一化的浮点，写入整型数组就变 0）
        const src = ia.data.array, stride = ia.data.stride, base = ia.offset
        for (let i = 0; i < a.count; i++) for (let k = 0; k < a.itemSize; k++) arr[off + i * a.itemSize + k] = src[i * stride + base + k]
      } else {
        const src = (a as THREE.BufferAttribute).array
        arr.set(src.length === a.count * a.itemSize ? src : src.subarray(0, a.count * a.itemSize), off)
      }
      off += a.count * a0.itemSize
    }
    out.setAttribute(name, new THREE.BufferAttribute(arr, a0.itemSize, a0.normalized))
  }
  const index = totalV <= 65535 ? new Uint16Array(totalI) : new Uint32Array(totalI)
  let io = 0
  for (let gi = 0; gi < geos.length; gi++) {
    const g = geos[gi], base = offsets[gi]
    if (g.index) { const src = g.index.array; for (let i = 0; i < g.index.count; i++) index[io++] = src[i] + base }
    else { const n = g.attributes.position.count; for (let i = 0; i < n; i++) index[io++] = i + base }
  }
  out.setIndex(new THREE.BufferAttribute(index, 1))
  return { geometry: out, offsets }
}

/**
 * 角色资源库（单例）：加载 characters.glb + catalog.json，
 * 提供部件几何、骨骼模板、动画 clip、共享材质，以及按 spec 合成几何的引用计数缓存。
 */
export class CharacterLibrary {
  static instance: CharacterLibrary | null = null
  private static loading: Promise<CharacterLibrary> | null = null

  /** 加载（重复调用返回同一个 Promise） */
  static load(url = '/assets/characters/'): Promise<CharacterLibrary> {
    if (CharacterLibrary.instance) return Promise.resolve(CharacterLibrary.instance)
    if (!CharacterLibrary.loading) {
      CharacterLibrary.loading = CharacterLibrary.doLoad(url).then((lib) => { CharacterLibrary.instance = lib; return lib })
        .catch((e) => { CharacterLibrary.loading = null; throw e })
    }
    return CharacterLibrary.loading
  }

  /** 已加载的库；未加载时抛错 */
  static get(): CharacterLibrary {
    if (!CharacterLibrary.instance) throw new Error('CharacterLibrary 尚未加载，先 await CharacterLibrary.load()')
    return CharacterLibrary.instance
  }

  private static async doLoad(url: string): Promise<CharacterLibrary> {
    const base = url.endsWith('/') ? url : url + '/'
    // GLTFLoader 按需动态加载：只有走骨骼角色时才下载，不进首屏 chunk
    const [catalog, gltf] = await Promise.all([
      fetch(base + 'catalog.json').then((r) => { if (!r.ok) throw new Error(`catalog.json HTTP ${r.status}`); return r.json() as Promise<Catalog> }),
      import('three/addons/loaders/GLTFLoader.js').then(({ GLTFLoader }) => new GLTFLoader().loadAsync(base + 'characters.glb')),
    ])
    return new CharacterLibrary(catalog, gltf.scene, gltf.animations)
  }

  readonly parts = new Map<string, PartDef>()
  readonly presets = new Map<string, CatalogPreset>()
  readonly clips = new Map<string, THREE.AnimationClip>()
  /** 共享材质模板（实例各自 clone 一份以支持受击着色；shader program 仍共享，见 CharacterMaterial） */
  readonly material: CharacterMaterial
  readonly headBoneName: string
  readonly hipsBoneName: string
  /** 骨骼模板：只含 Bone 的层级 */
  private readonly armature: THREE.Object3D
  private readonly templateBones: THREE.Bone[]
  private readonly boneInverses: THREE.Matrix4[]
  private readonly geomCache = new Map<string, { geometry: THREE.BufferGeometry; refs: number }>()
  private readonly keyOf = new WeakMap<THREE.BufferGeometry, string>()

  private constructor(readonly catalog: Catalog, scene: THREE.Group, animations: THREE.AnimationClip[]) {
    this.headBoneName = catalog.skeleton.head
    this.hipsBoneName = catalog.skeleton.hips
    this.material = createCharacterMaterial()

    // 1) 收集部件节点（extras.part → userData.part）；单图元节点本身就是 SkinnedMesh，多图元是 Group 下多个 SkinnedMesh
    const partNodes: THREE.Object3D[] = []
    scene.traverse((o) => { if (o.userData.part) partNodes.push(o) })
    let skeleton: THREE.Skeleton | null = null
    const byId = new Map(catalog.parts.map((p) => [p.id, p]))
    for (const node of partNodes) {
      const id = node.userData.part as string
      const def = byId.get(id)
      if (!def) { console.warn(`[CharacterLibrary] glb 里的部件 ${id} 不在 catalog 中，跳过`); continue }
      const meshes: THREE.SkinnedMesh[] = []
      node.traverse((c) => { if ((c as THREE.SkinnedMesh).isSkinnedMesh) meshes.push(c as THREE.SkinnedMesh) })
      if (!meshes.length) continue
      skeleton ??= meshes[0].skeleton
      const { geometry, offsets } = concatGeometries(meshes.map((m) => m.geometry))
      const groups: PartGroup[] = meshes.map((m, i) => {
        const mat = m.material as THREE.MeshStandardMaterial
        const info = def.materials.find((x) => x.name === mat.name)
        if (!info) console.warn(`[CharacterLibrary] 部件 ${id} 的材质 ${mat.name} 不在 catalog 中，按 fixed 处理`)
        return { start: offsets[i], count: m.geometry.attributes.position.count, materialName: mat.name, role: info?.role ?? 'fixed', defaultColor: info?.default ?? '#' + mat.color.getHexString() }
      })
      this.parts.set(id, { id, slot: def.slot, gender: def.gender, set: def.set, label: def.label, tris: def.tris, geometry, groups })
    }
    if (!skeleton) throw new Error('characters.glb 里没有蒙皮部件')
    for (const def of catalog.parts) if (!this.parts.has(def.id)) console.warn(`[CharacterLibrary] catalog 部件 ${def.id} 在 glb 里找不到`)

    // 2) 骨骼模板：从场景里摘掉部件节点，只留 Bone 层级
    for (const n of partNodes) n.parent?.remove(n)
    const armature = scene.getObjectByName(catalog.skeleton.armature) ?? skeleton.bones[0].parent ?? skeleton.bones[0]
    armature.removeFromParent()
    armature.position.set(0, 0, 0); armature.quaternion.identity(); armature.scale.set(1, 1, 1)
    this.armature = armature
    this.templateBones = skeleton.bones
    this.boneInverses = skeleton.boneInverses
    // 量化位置 → 米：scene 量化体积是等比缩放，绑定姿态下 bone.matrixWorld × boneInverse = 反量化矩阵
    armature.updateMatrixWorld(true)
    const dequant = new THREE.Matrix4().multiplyMatrices(skeleton.bones[0].matrixWorld, skeleton.boneInverses[0])
    CHAR_UNIFORMS.uObjScale.value = dequant.getMaxScaleOnAxis()

    // 3) 动画别名
    for (const [alias, raw] of Object.entries(catalog.clips)) {
      const clip = animations.find((a) => a.name === raw)
      if (clip) this.clips.set(alias, clip)
      else console.warn(`[CharacterLibrary] 动画 ${alias} → ${raw} 不在 glb 中`)
    }
    for (const p of catalog.presets) this.presets.set(p.id, p)
  }

  /** 某槽位、某性别可用的部件（含 gender=any） */
  partsFor(slot: Slot, gender: 'm' | 'f'): PartDef[] {
    const out: PartDef[] = []
    for (const p of this.parts.values()) if (p.slot === slot && (p.gender === 'any' || p.gender === gender)) out.push(p)
    return out
  }

  /** 克隆一套骨骼：返回骨根节点（加到角色 group 里）与 Skeleton（共享 boneInverses，只读） */
  createSkeleton(): { root: THREE.Object3D; skeleton: THREE.Skeleton; bones: THREE.Bone[] } {
    const root = this.armature.clone(true)
    const byName = new Map<string, THREE.Bone>()
    root.traverse((o) => { if ((o as THREE.Bone).isBone) byName.set(o.name, o as THREE.Bone) })
    const bones = this.templateBones.map((b) => {
      const c = byName.get(b.name)
      if (!c) throw new Error(`createSkeleton：克隆后找不到骨骼 ${b.name}`)
      return c
    })
    const skeleton = new THREE.Skeleton(bones, this.boneInverses)
    return { root, skeleton, bones }
  }

  /** 取得按 spec 合成并写好顶点色的几何（引用计数，同 spec 共享）；用完必须 releaseGeometry */
  acquireGeometry(spec: CharacterSpec): THREE.BufferGeometry {
    const key = specKey(spec)
    const hit = this.geomCache.get(key)
    if (hit) { hit.refs++; return hit.geometry }
    const geometry = this.buildGeometry(spec)
    this.geomCache.set(key, { geometry, refs: 1 })
    this.keyOf.set(geometry, key)
    return geometry
  }

  releaseGeometry(geometry: THREE.BufferGeometry) {
    const key = this.keyOf.get(geometry)
    const entry = key !== undefined ? this.geomCache.get(key) : undefined
    if (!entry) { geometry.dispose(); return }
    if (--entry.refs <= 0) { this.geomCache.delete(key!); this.keyOf.delete(geometry); geometry.dispose() }
  }

  get cachedGeometryCount() { return this.geomCache.size }

  private buildGeometry(spec: CharacterSpec): THREE.BufferGeometry {
    const ids: string[] = [spec.parts.head, spec.parts.body, spec.parts.legs, spec.parts.feet]
    if (spec.parts.hat) ids.push(spec.parts.hat)
    const parts: PartDef[] = []
    for (const id of ids) {
      const p = this.parts.get(id)
      if (p) parts.push(p); else console.warn(`[CharacterLibrary] 部件 ${id} 不存在，跳过`)
    }
    if (!parts.length) throw new Error('buildGeometry：没有任何有效部件')
    const { geometry, offsets } = concatGeometries(parts.map((p) => p.geometry))
    const n = geometry.attributes.position.count
    const color = new Float32Array(n * 3)
    const mat = new Uint8Array(n)   // 着色分区（CharacterMaterial：0 皮肤 1 布料 2 皮革 3 头发 4 饰品）
    const c = new THREE.Color()
    const colors = spec.colors as Record<string, string | undefined>
    parts.forEach((p, pi) => {
      const base = offsets[pi]
      for (const g of p.groups) {
        const hex = g.role === 'fixed' ? g.defaultColor : (colors[g.role] ?? g.defaultColor)
        c.set(hex)
        const m = matClassOf(g.role, g.materialName)
        for (let i = base + g.start, e = base + g.start + g.count; i < e; i++) { color[i * 3] = c.r; color[i * 3 + 1] = c.g; color[i * 3 + 2] = c.b; mat[i] = m }
      }
    })
    geometry.setAttribute('color', new THREE.BufferAttribute(color, 3))
    geometry.setAttribute('aMat', new THREE.BufferAttribute(mat, 1))
    // 顶点在量化空间，bbox 无意义；包围球由 CharacterInstance 在骨骼空间手动给出
    geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 0.95, 0), 1.5)
    geometry.boundingBox = new THREE.Box3(new THREE.Vector3(-1.2, -0.1, -1.2), new THREE.Vector3(1.2, 2.1, 1.2))
    return geometry
  }

  /** 单位矩阵（SkinnedMesh.bind 用） */
  get identity() { return _identity }
}
