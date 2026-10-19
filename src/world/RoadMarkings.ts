import * as THREE from 'three'
import type { ChunkMark } from './ChunkFormat'

/**
 * 路面标线：一个全局 InstancedMesh（单位盒 1×0.02×1，白色），按区块维护实例矩阵，
 * 区块增删后 flush() 整体重写。车道虚线 = len×0.15；斑马线 = 横跨 w 的多条 2.4×0.6 白条；停止线 = 0.4×w。
 * 路缘（kerb）暂不绘制。
 */
const MARK_Y = 0.012
const ZEBRA_PITCH = 1.1
const ZEBRA_STRIPE = 0.6
const tmpV = new THREE.Vector3(), tmpQ = new THREE.Quaternion(), tmpS = new THREE.Vector3()
const Y_AXIS = new THREE.Vector3(0, 1, 0)

export class RoadMarkings {
  mesh: THREE.InstancedMesh
  private chunks = new Map<string, THREE.Matrix4[]>()
  private dirty = false
  private geo = new THREE.BoxGeometry(1, 0.02, 1)
  private mat = new THREE.MeshBasicMaterial({ color: 0xe8e8e8 })

  constructor(capacity = 2048) {
    this.mesh = this.make(capacity)
  }

  private make(capacity: number) {
    const m = new THREE.InstancedMesh(this.geo, this.mat, capacity)
    m.count = 0
    m.frustumCulled = false
    m.name = 'roadMarkings'
    m.userData.castShadow = false
    return m
  }

  attach(scene: THREE.Scene) { scene.add(this.mesh) }

  addChunk(key: string, marks: ChunkMark[]) {
    if (this.chunks.has(key)) this.removeChunk(key)
    const list: THREE.Matrix4[] = []
    const put = (x: number, z: number, yaw: number, sx: number, sz: number, lx = 0) => {
      // 本地横向偏移 lx（沿 yaw 的右侧）：x' = lx cos, z' = −lx sin
      const c = Math.cos(yaw), s = Math.sin(yaw)
      tmpV.set(x + lx * c, MARK_Y, z - lx * s)
      tmpQ.setFromAxisAngle(Y_AXIS, yaw)
      tmpS.set(sx, 1, sz)
      list.push(new THREE.Matrix4().compose(tmpV, tmpQ, tmpS))
    }
    for (const m of marks) {
      switch (m.type) {
        case 0: put(m.x, m.z, m.yaw, 0.15, m.len); break
        case 1: {
          const n = Math.max(1, Math.floor(m.w / ZEBRA_PITCH))
          const start = -((n - 1) * ZEBRA_PITCH) / 2
          for (let k = 0; k < n; k++) put(m.x, m.z, m.yaw, ZEBRA_STRIPE, m.len, start + k * ZEBRA_PITCH)
          break
        }
        case 2: put(m.x, m.z, m.yaw, m.w, m.len); break
        default: break
      }
    }
    this.chunks.set(key, list)
    this.dirty = true
  }

  removeChunk(key: string) {
    if (this.chunks.delete(key)) this.dirty = true
  }

  flush() {
    if (!this.dirty) return
    this.dirty = false
    let n = 0
    for (const list of this.chunks.values()) n += list.length
    if (n > this.mesh.instanceMatrix.count) {
      let cap = this.mesh.instanceMatrix.count * 2
      while (cap < n) cap *= 2
      const old = this.mesh
      this.mesh = this.make(cap)
      old.parent?.add(this.mesh)
      old.removeFromParent(); old.dispose()
    }
    let k = 0
    for (const list of this.chunks.values()) for (const m of list) this.mesh.setMatrixAt(k++, m)
    this.mesh.count = n
    this.mesh.instanceMatrix.needsUpdate = true
  }

  get count() { return this.mesh.count }

  dispose() { this.mesh.dispose(); this.geo.dispose(); this.mat.dispose(); this.mesh.removeFromParent() }
}
