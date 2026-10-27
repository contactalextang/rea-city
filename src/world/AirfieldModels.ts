import * as THREE from 'three'
import type { GLTF } from 'three/addons/loaders/GLTFLoader.js'

/**
 * 机场套件模型（scripts/airfield/build.ts 产出的 airfield.glb，threejsassets.com「Airfield」免费套件）。
 *
 * 文件格式：EXT_meshopt_compression + KHR_mesh_quantization（不是 Draco），需要 three 自带的 MeshoptDecoder（几 KB，随加载器一起动态 import）。
 * 每个模型一个节点，userData.id = 模型 id；顶点色 + 法线、无纹理，统一 1 单位 = 1 m、Y 上、正面/机头朝 +Z。
 * 这里把量化修正矩阵烘焙回 float 位置，返回的几何直接是「模型原点坐标系」下的米制坐标，可以直接进 InstancedMesh / mergeGeometries。
 *
 * 属性：position / normal（float）、color（归一化整型，vertexColors 直接用）；
 *       _glow（float 0/1，夜间发光掩码：塔台玻璃舱、灯罩、标牌字样、航行灯）、_paint（float 0/1，仅 Cessna 漆面条纹色）。
 * 原点：建筑 / 道具 / 砖块在底面中心（y=0 为最低点）；Cessna 在主轮接地点正下方（y=0 为轮胎底）。
 * 子节点：Cessna 的螺旋桨 'cessna-prop'，几何原点在桨毂，绕局部 +Z 旋转；position 是桨毂相对机身原点的位置。
 */
export interface AirfieldPart {
  id: string
  geometry: THREE.BufferGeometry
  /** 相对父模型原点的位置（m） */
  position: THREE.Vector3
  /** 旋转轴（局部坐标），螺旋桨为 +Z */
  axis?: THREE.Vector3
  extras: Record<string, unknown>
}
export interface AirfieldModel {
  id: string
  geometry: THREE.BufferGeometry
  /** 包围盒尺寸（m） */
  size: THREE.Vector3
  /** 构建期写入的元数据：kind / srcSize / scale / origin / paint{stripe,body,hue} / surfaceY 等 */
  extras: Record<string, unknown>
  children: Map<string, AirfieldPart>
}

/** GLTFLoader + MeshoptDecoder 按需动态加载，不进首屏 chunk */
export async function loadAirfieldModels(url = '/assets/airfield/airfield.glb'): Promise<Map<string, AirfieldModel>> {
  const [{ GLTFLoader }, { MeshoptDecoder }] = await Promise.all([
    import('three/addons/loaders/GLTFLoader.js'),
    import('three/addons/libs/meshopt_decoder.module.js'),
  ])
  const gltf = await new GLTFLoader().setMeshoptDecoder(MeshoptDecoder).loadAsync(url)
  return parseAirfieldModels(gltf)
}

/** 从已加载的 gltf 取出模型表（node 校验脚本也直接调它） */
export function parseAirfieldModels(gltf: GLTF): Map<string, AirfieldModel> {
  const root = gltf.scene
  root.updateMatrixWorld(true)
  const out = new Map<string, AirfieldModel>()
  const idOf = (o: THREE.Object3D) => o.userData.id as string | undefined
  for (const node of root.children) {
    const id = idOf(node)
    if (!id) continue
    // 模型坐标系 = 场景根坐标系（构建期顶层节点不带变换）。不能用 node.matrixWorld：
    // 无子节点的 mesh 节点上，KHR_mesh_quantization 的修正矩阵就乘在节点自己身上
    const inv = new THREE.Matrix4().copy(root.matrixWorld).invert()
    const children = new Map<string, AirfieldPart>()
    node.traverse((o) => {
      if (o === node || !idOf(o)) return
      const pivot = (o.userData.pivot as number[] | undefined) ?? [0, 0, 0]
      // 子件几何：先烘到父模型坐标系，再平移到以 pivot 为原点
      const m = new THREE.Matrix4().makeTranslation(-pivot[0], -pivot[1], -pivot[2]).multiply(inv)
      const axis = o.userData.axis as number[] | undefined
      children.set(idOf(o)!, {
        id: idOf(o)!,
        geometry: bakeMeshes(o, m, idOf),
        position: new THREE.Vector3().fromArray(pivot),
        axis: axis ? new THREE.Vector3().fromArray(axis) : undefined,
        extras: o.userData,
      })
    })
    const geometry = bakeMeshes(node, inv, idOf)
    out.set(id, { id, geometry, size: geometry.boundingBox!.getSize(new THREE.Vector3()), extras: node.userData, children })
  }
  return out
}

/** 合并 owner 节点自身及其下属（不跨进别的 id 节点）的 mesh，应用 rel·matrixWorld，位置 / 法线转 float */
function bakeMeshes(owner: THREE.Object3D, rel: THREE.Matrix4, idOf: (o: THREE.Object3D) => string | undefined): THREE.BufferGeometry {
  const meshes: THREE.Mesh[] = []
  const walk = (o: THREE.Object3D) => {
    if ((o as THREE.Mesh).isMesh) meshes.push(o as THREE.Mesh)
    for (const c of o.children) if (!idOf(c)) walk(c)
  }
  walk(owner)
  if (meshes.length !== 1) throw new Error(`airfield.glb：${idOf(owner)} 应有 1 个 mesh，实际 ${meshes.length}`)
  const mesh = meshes[0]
  const m = new THREE.Matrix4().multiplyMatrices(rel, mesh.matrixWorld)
  const nm = new THREE.Matrix3().getNormalMatrix(m)
  const src = mesh.geometry
  const geo = src.clone()
  const v = new THREE.Vector3()
  const p = src.getAttribute('position')
  const pos = new Float32Array(p.count * 3)
  for (let i = 0; i < p.count; i++) v.fromBufferAttribute(p, i).applyMatrix4(m).toArray(pos, i * 3)
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3))
  const n = src.getAttribute('normal')
  if (n) {
    const nrm = new Float32Array(n.count * 3)
    for (let i = 0; i < n.count; i++) v.fromBufferAttribute(n, i).applyMatrix3(nm).normalize().toArray(nrm, i * 3)
    geo.setAttribute('normal', new THREE.BufferAttribute(nrm, 3))
  }
  geo.computeBoundingBox()
  geo.computeBoundingSphere()
  return geo
}
