import type * as THREE from 'three'

/**
 * 外部道具模型（scripts/props/build.ts 产出的 props.glb，threejsassets.com 免费模型）。
 * 每个模型是一个单 mesh 节点，extras.id（即 userData.id）为模型 id，顶点色 + 法线、原点在树干底部、无纹理，可直接替换 PropMeshes 池的几何。
 * GLTFLoader 按需动态加载，不进首屏 chunk。
 */
export async function loadPropModels(url = '/assets/props/props.glb'): Promise<Map<string, THREE.BufferGeometry>> {
  const { GLTFLoader } = await import('three/addons/loaders/GLTFLoader.js')
  const gltf = await new GLTFLoader().loadAsync(url)
  const out = new Map<string, THREE.BufferGeometry>()
  gltf.scene.traverse((o) => {
    const mesh = o as THREE.Mesh
    if (!mesh.isMesh) return
    const id = mesh.userData.id as string | undefined
    if (id) out.set(id, mesh.geometry)
  })
  return out
}
