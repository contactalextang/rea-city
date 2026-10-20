import * as THREE from 'three'
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js'
import { GRID, BLOCK, ROAD, SIDEWALK, PITCH, HALF, CITY_MIN, CITY_MAX, rand, randInt, pick } from '../config'
import type { RoadGraph, P2 } from './RoadGraph'
import type { SignalLights } from '../systems/Signals'
import { StaticWorld, type AABB } from './Colliders'
import { makeRoadMaterial } from './RoadMaterial'

export interface Building { box: AABB; h: number; color: THREE.Color }
export interface BlockInfo { i: number; j: number; cx: number; cz: number; park: boolean }

const PALETTE = [0xd9c8b4, 0xb9b5ad, 0x8c9bb0, 0xc78f6d, 0xe0d7c6, 0x7d8a99, 0xa7b7a2, 0xd8a979, 0x6e7f9a, 0xbfa58a, 0x9fb3c8, 0xcf6f5a]

/** 程序生成整座城市的网格与静态碰撞体 */
export class CityGenerator {
  buildings: Building[] = []
  blocks: BlockInfo[] = []
  group = new THREE.Group()

  constructor(private scene: THREE.Scene, private graph: RoadGraph, private world: StaticWorld) {}

  build() {
    this.ground()
    this.blocksAndBuildings()
    this.roadMarkings()
    this.lampsAndTrees()
    this.signalLights()
    this.walls()
    this.scene.add(this.group)
  }

  private ground() {
    const grass = new THREE.Mesh(new THREE.PlaneGeometry(4000, 4000), new THREE.MeshLambertMaterial({ color: 0x4f7a3a }))
    grass.rotation.x = -Math.PI / 2; grass.position.y = -0.05
    grass.userData.castShadow = false
    this.group.add(grass)
    const size = CITY_MAX - CITY_MIN
    const asphaltMat = makeRoadMaterial()
    const asphalt = new THREE.Mesh(new THREE.PlaneGeometry(size, size), asphaltMat)
    asphalt.rotation.x = -Math.PI / 2; asphalt.position.y = 0
    asphalt.userData.castShadow = false
    this.group.add(asphalt)
    // 路面材质暴露给 Weather（雨天变深）；约定见 DayNight.ts 头注释
    this.scene.userData.roads = [asphaltMat]
  }

  private blocksAndBuildings() {
    // 人行道板：每个街区一块（含 3m 人行道）
    const slabSize = BLOCK + SIDEWALK * 2
    const slab = new THREE.InstancedMesh(new THREE.BoxGeometry(slabSize, 0.15, slabSize), new THREE.MeshLambertMaterial({ color: 0x9d9d98 }), GRID * GRID)
    slab.userData.castShadow = false
    const m = new THREE.Matrix4()
    const geoms: THREE.BufferGeometry[] = []
    const { map: windowTex, emissive: windowGlow } = makeWindowTexture()
    let idx = 0
    for (let j = 0; j < GRID; j++) for (let i = 0; i < GRID; i++) {
      const cx = i * PITCH - HALF + PITCH / 2, cz = j * PITCH - HALF + PITCH / 2
      m.makeTranslation(cx, 0.075, cz); slab.setMatrixAt(idx++, m)
      const distC = Math.hypot(cx, cz) / HALF
      const park = Math.random() < 0.08 && distC > 0.25
      this.blocks.push({ i, j, cx, cz, park })
      if (park) continue
      for (const fp of layoutLots(cx, cz)) {
        const centerFactor = 1 - Math.min(1, distC) * 0.75
        const h = Math.round(8 + rand(4, 55) * centerFactor * rand(0.6, 1.2))
        const color = new THREE.Color(pick(PALETTE)).offsetHSL(rand(-0.02, 0.02), rand(-0.05, 0.05), rand(-0.06, 0.06))
        const box: AABB = { minX: fp.x - fp.w / 2, maxX: fp.x + fp.w / 2, minZ: fp.z - fp.d / 2, maxZ: fp.z + fp.d / 2 }
        this.buildings.push({ box, h, color })
        this.world.add(box)
        geoms.push(buildingGeometry(fp.x, fp.z, fp.w, fp.d, h, color))
      }
    }
    slab.instanceMatrix.needsUpdate = true
    this.group.add(slab)
    // 外圈人行道：围墙与最外侧车道之间的 3m 条带
    const ringMat = new THREE.MeshLambertMaterial({ color: 0x9d9d98 })
    const span = CITY_MAX - CITY_MIN
    for (const [x, z, w, d] of [
      [0, CITY_MIN + SIDEWALK / 2, span, SIDEWALK], [0, CITY_MAX - SIDEWALK / 2, span, SIDEWALK],
      [CITY_MIN + SIDEWALK / 2, 0, SIDEWALK, span], [CITY_MAX - SIDEWALK / 2, 0, SIDEWALK, span],
    ]) {
      const ring = new THREE.Mesh(new THREE.BoxGeometry(w, 0.15, d), ringMat)
      ring.position.set(x, 0.075, z); ring.userData.castShadow = false; this.group.add(ring)
    }
    const merged = mergeGeometries(geoms, false)!
    // 窗户材质：夜间由 DayNight 驱动 emissiveIntensity 0→0.9（emissiveMap 只有窗格发光）
    const wallMat = new THREE.MeshLambertMaterial({ map: windowTex, vertexColors: true, emissive: 0xffd27a, emissiveMap: windowGlow, emissiveIntensity: 0 })
    const mesh = new THREE.Mesh(merged, wallMat)
    this.group.add(mesh)
    this.scene.userData.windows = [wallMat]
  }

  private roadMarkings() {
    // 黄色中线虚线 + 白色斑马线，统一用 InstancedMesh
    const dashes: THREE.Matrix4[] = [], stripes: THREE.Matrix4[] = []
    const N = GRID + 1
    const pos = (k: number) => k * PITCH - HALF
    for (let a = 0; a < N; a++) for (let b = 0; b < GRID; b++) {
      // 路段：固定坐标 pos(a)，沿另一轴从 pos(b)+ROAD/2 到 pos(b+1)-ROAD/2
      const s = pos(b) + ROAD / 2 + 4, e = pos(b + 1) - ROAD / 2 - 4
      for (let t = s; t < e; t += 6) {
        dashes.push(new THREE.Matrix4().compose(new THREE.Vector3(pos(a), 0.012, t + 1.5), new THREE.Quaternion(), new THREE.Vector3(0.18, 1, 3)))
        dashes.push(new THREE.Matrix4().compose(new THREE.Vector3(t + 1.5, 0.012, pos(a)), new THREE.Quaternion(), new THREE.Vector3(3, 1, 0.18)))
      }
    }
    for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
      const x = pos(i), z = pos(j)
      // 四个方向的斑马线：位于路口外侧 ROAD/2 ~ ROAD/2+2.4 处，横跨 10m 车行道
      for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
        if (i + dx < 0 || i + dx >= N || j + dz < 0 || j + dz >= N) continue
        const bx = x + dx * (ROAD / 2 + 1.4), bz = z + dz * (ROAD / 2 + 1.4)
        for (let k = -4; k <= 4; k++) {
          const off = k * 1.1
          const px = bx + (dx === 0 ? off : 0), pz = bz + (dz === 0 ? off : 0)
          const sx = dx === 0 ? 0.6 : 2.4, sz = dz === 0 ? 0.6 : 2.4
          stripes.push(new THREE.Matrix4().compose(new THREE.Vector3(px, 0.012, pz), new THREE.Quaternion(), new THREE.Vector3(sx, 1, sz)))
        }
      }
    }
    const unit = new THREE.BoxGeometry(1, 0.02, 1)
    const dashMesh = new THREE.InstancedMesh(unit, new THREE.MeshBasicMaterial({ color: 0xe6c84a }), dashes.length)
    dashes.forEach((mm, k) => dashMesh.setMatrixAt(k, mm))
    const stripeMesh = new THREE.InstancedMesh(unit, new THREE.MeshBasicMaterial({ color: 0xe8e8e8 }), stripes.length)
    stripes.forEach((mm, k) => stripeMesh.setMatrixAt(k, mm))
    this.group.add(dashMesh, stripeMesh)
  }

  private lampsAndTrees() {
    const lampGeo = mergeGeometries([
      new THREE.CylinderGeometry(0.1, 0.14, 5.5, 6).translate(0, 2.75, 0),
      new THREE.BoxGeometry(0.5, 0.25, 1.2).translate(0, 5.6, 0.5),
    ], false)!
    const lampMats: THREE.Matrix4[] = []
    const trunkMats: THREE.Matrix4[] = [], crownMats: THREE.Matrix4[] = []
    const curb = BLOCK / 2 + SIDEWALK - 0.6   // 距街区中心：人行道外缘向内 0.6m
    for (const b of this.blocks) {
      // 路灯放在每条边的中段（避开路口转弯轨迹），每边两盏
      for (const [sx, sz] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
        for (const along of [-11, 11]) {
          const x = b.cx + sx * curb + sz * along, z = b.cz + sz * curb + sx * along
          lampMats.push(new THREE.Matrix4().makeTranslation(x, 0.15, z))
          this.world.add({ minX: x - 0.2, maxX: x + 0.2, minZ: z - 0.2, maxZ: z + 0.2 })
        }
      }
      const treeAt = (x: number, z: number) => {
        const s = rand(0.8, 1.3)
        trunkMats.push(new THREE.Matrix4().compose(new THREE.Vector3(x, 0.15, z), new THREE.Quaternion(), new THREE.Vector3(s, s, s)))
        crownMats.push(new THREE.Matrix4().compose(new THREE.Vector3(x, 0.15, z), new THREE.Quaternion(), new THREE.Vector3(s, s, s)))
        this.world.add({ minX: x - 0.35, maxX: x + 0.35, minZ: z - 0.35, maxZ: z + 0.35 })
      }
      if (b.park) {
        for (let k = 0; k < 14; k++) treeAt(b.cx + rand(-16, 16), b.cz + rand(-16, 16))
      } else {
        // 沿人行道随机种 0~3 棵（位于人行道靠楼一侧，不挡行人线）
        const n = randInt(0, 3)
        for (let k = 0; k < n; k++) {
          const side = pick([[1, 0], [-1, 0], [0, 1], [0, -1]] as const)
          const along = rand(-14, 14)
          const d = BLOCK / 2 - 0.9
          treeAt(b.cx + side[0] * d + side[1] * along, b.cz + side[1] * d + side[0] * along)
        }
      }
    }
    const lamps = new THREE.InstancedMesh(lampGeo, new THREE.MeshLambertMaterial({ color: 0x4a4f57 }), lampMats.length)
    lampMats.forEach((mm, k) => lamps.setMatrixAt(k, mm))
    const trunks = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.18, 0.25, 2.2, 6).translate(0, 1.1, 0), new THREE.MeshLambertMaterial({ color: 0x6b4a2b }), trunkMats.length)
    trunkMats.forEach((mm, k) => trunks.setMatrixAt(k, mm))
    const crowns = new THREE.InstancedMesh(new THREE.ConeGeometry(2.2, 4.5, 7).translate(0, 4.2, 0), new THREE.MeshLambertMaterial({ color: 0x3f7a2e }), crownMats.length)
    crownMats.forEach((mm, k) => crowns.setMatrixAt(k, mm))
    this.group.add(lamps, trunks, crowns)
    // 路灯实例与灯头偏移暴露给 DayNight（夜间光晕）
    this.scene.userData.lamps = lamps
    this.scene.userData.lampHead = new THREE.Vector3(0, 5.45, 0.5)
  }

  /** 红绿灯灯柱：每个信号灯路口的每条入边在停止线旁（行驶侧人行道）放一根；灯头颜色由 Signals.applyToMesh 每帧刷新 */
  private signalLights() {
    const edgeIds: number[] = []
    const mats: THREE.Matrix4[] = []
    const p: P2 = { x: 0, z: 0 }
    for (const e of this.graph.edges) {
      if (!e.to.signal) continue
      this.graph.sidewalkPoint(e, e.length - e.to.jr - 0.8, p)
      edgeIds.push(e.id)
      mats.push(new THREE.Matrix4().makeTranslation(p.x, 0.15, p.z))
      this.world.add({ minX: p.x - 0.15, maxX: p.x + 0.15, minZ: p.z - 0.15, maxZ: p.z + 0.15 })
    }
    if (!mats.length) return
    const poleGeo = mergeGeometries([
      new THREE.CylinderGeometry(0.07, 0.09, 3.6, 6).translate(0, 1.8, 0),
      new THREE.BoxGeometry(0.44, 1.3, 0.44).translate(0, 3.9, 0),
    ], false)!
    const poles = new THREE.InstancedMesh(poleGeo, new THREE.MeshLambertMaterial({ color: 0x2b2f36 }), mats.length)
    // 灯头：自发光方块，instanceColor 表示当前相位（不受昼夜影响）
    const heads = new THREE.InstancedMesh(new THREE.BoxGeometry(0.5, 0.42, 0.5).translate(0, 3.9, 0), new THREE.MeshBasicMaterial({ color: 0xffffff }), mats.length)
    heads.userData.castShadow = false
    const red = new THREE.Color(0xff2b2b)
    mats.forEach((mm, k) => { poles.setMatrixAt(k, mm); heads.setMatrixAt(k, mm); heads.setColorAt(k, red) })
    this.group.add(poles, heads)
    this.scene.userData.signalLights = { mesh: heads, edgeIds } satisfies SignalLights
  }

  private walls() {
    const mat = new THREE.MeshLambertMaterial({ color: 0x8a8a86 })
    const size = CITY_MAX - CITY_MIN + 2
    const mk = (x: number, z: number, w: number, d: number) => {
      const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, 1.3, d), mat)
      mesh.position.set(x, 0.65, z); this.group.add(mesh)
      // 碰撞体只取墙本身（1m 厚足以挡住每步 <0.6m 的位移）
      this.world.add({ minX: x - w / 2, maxX: x + w / 2, minZ: z - d / 2, maxZ: z + d / 2 })
    }
    mk(0, CITY_MIN - 0.5, size, 1)
    mk(0, CITY_MAX + 0.5, size, 1)
    mk(CITY_MIN - 0.5, 0, 1, size)
    mk(CITY_MAX + 0.5, 0, 1, size)
  }
}

interface Lot { x: number; z: number; w: number; d: number }

/** 把一个 40×40 街区切成 1~4 个楼房地块（留 2m 退距与楼间距） */
function layoutLots(cx: number, cz: number): Lot[] {
  const r = Math.random()
  const M = 2.2        // 退距
  const half = BLOCK / 2 - M
  const lots: Lot[] = []
  if (r < 0.25) {
    const w = rand(24, half * 2), d = rand(24, half * 2)
    lots.push({ x: cx + rand(-(half - w / 2), half - w / 2), z: cz + rand(-(half - d / 2), half - d / 2), w, d })
  } else if (r < 0.6) {
    const horizontal = Math.random() < 0.5
    const split = rand(0.4, 0.6)
    const total = half * 2 - 2
    const a = total * split, b = total - a
    if (horizontal) {
      lots.push({ x: cx - half + a / 2, z: cz, w: a, d: rand(26, half * 2) })
      lots.push({ x: cx + half - b / 2, z: cz, w: b, d: rand(26, half * 2) })
    } else {
      lots.push({ x: cx, z: cz - half + a / 2, w: rand(26, half * 2), d: a })
      lots.push({ x: cx, z: cz + half - b / 2, w: rand(26, half * 2), d: b })
    }
  } else {
    const q = half - 1
    for (const [sx, sz] of [[1, 1], [1, -1], [-1, 1], [-1, -1]] as const) {
      if (lots.length === 3 && Math.random() < 0.5) break
      const w = rand(q * 0.75, q), d = rand(q * 0.75, q)
      lots.push({ x: cx + sx * (half - w / 2), z: cz + sz * (half - d / 2), w, d })
    }
  }
  return lots
}

/** 带窗格 UV 与顶点色的楼房盒子 */
function buildingGeometry(x: number, z: number, w: number, d: number, h: number, color: THREE.Color) {
  const g = new THREE.BoxGeometry(w, h, d)
  const uv = g.attributes.uv as THREE.BufferAttribute
  const colors = new Float32Array(24 * 3)
  const roof = color.clone().multiplyScalar(0.72)
  // BoxGeometry 面顺序：+x -x +y -y +z -z，每面 4 个顶点
  for (let f = 0; f < 6; f++) {
    const span = f < 2 ? d : w
    for (let v = 0; v < 4; v++) {
      const k = f * 4 + v
      const c = f === 2 || f === 3 ? roof : color
      colors[k * 3] = c.r; colors[k * 3 + 1] = c.g; colors[k * 3 + 2] = c.b
      if (f === 2 || f === 3) { uv.setXY(k, 0.03, 0.03) }
      else { uv.setXY(k, uv.getX(k) * span / (3.2 * PANES), uv.getY(k) * h / (3.2 * PANES)) }
    }
  }
  g.setAttribute('color', new THREE.BufferAttribute(colors, 3))
  g.translate(x, h / 2, z)
  return g
}

/** 贴图每边窗格数：漫反射每格相同，自发光图随机点亮约 55% 的窗格 */
const PANES = 4

function makeWindowTexture() {
  const size = 64 * PANES
  const mk = () => { const c = document.createElement('canvas'); c.width = c.height = size; return c }
  const diff = mk(), glow = mk()
  const d = diff.getContext('2d')!, g = glow.getContext('2d')!
  d.fillStyle = '#ffffff'; d.fillRect(0, 0, size, size)
  g.fillStyle = '#000000'; g.fillRect(0, 0, size, size)
  for (let j = 0; j < PANES; j++) for (let i = 0; i < PANES; i++) {
    const ox = i * 64, oy = j * 64
    d.fillStyle = '#3a4a66'; d.fillRect(ox + 16, oy + 14, 32, 36)
    d.fillStyle = '#7f94b8'; d.fillRect(ox + 18, oy + 16, 12, 14)
    if (Math.random() < 0.55) {
      const v = Math.floor(rand(150, 255))
      g.fillStyle = `rgb(${v},${Math.floor(v * 0.86)},${Math.floor(v * 0.6)})`; g.fillRect(ox + 16, oy + 14, 32, 36)
    }
  }
  const tex = (c: HTMLCanvasElement) => {
    const t = new THREE.CanvasTexture(c)
    t.wrapS = t.wrapT = THREE.RepeatWrapping
    t.magFilter = THREE.NearestFilter
    t.colorSpace = THREE.SRGBColorSpace
    return t
  }
  return { map: tex(diff), emissive: tex(glow) }
}
