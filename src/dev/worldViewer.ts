import * as THREE from 'three'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import { SgWorld } from '../world/SgWorld'
import { DayNight } from '../systems/DayNight'
import { DEFAULT_SETTINGS } from '../core/Settings'
import type { Ctx } from '../core/Context'
import { chunkKeyAt } from '../world/ChunkManager'
import { LANDMARK_SITES } from '../world/Landmarks'

/**
 * 真实世界独立查看页（不走 Game）：dev/world.html?x=0&z=0
 * 自建 renderer/scene，复用 DayNight 灯光（固定 14:00），OrbitControls 围绕可 WASD 平移的探针；
 * 每帧 world.update(px,pz) 驱动区块流式加载。调试钩子挂在 window.__viewer。
 */

const q = new URLSearchParams(location.search)
const hud = document.getElementById('hud')!
const errBox = document.getElementById('err')!

const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' })
renderer.setPixelRatio(Math.min(devicePixelRatio, 2))
renderer.setSize(innerWidth, innerHeight)
document.body.appendChild(renderer.domElement)
const scene = new THREE.Scene()
scene.background = new THREE.Color(0xa9c9e8)
scene.fog = new THREE.Fog(0xa9c9e8, 400, 1800)
const camera = new THREE.PerspectiveCamera(60, innerWidth / innerHeight, 0.5, 5000)
const controls = new OrbitControls(camera, renderer.domElement)
controls.enableDamping = true
controls.maxPolarAngle = Math.PI / 2 - 0.02
controls.enablePan = false
const dayNight = new DayNight(scene, renderer, { ...DEFAULT_SETTINGS, shadows: q.get('shadows') !== '0' })
const hour = Number(q.get('hour') ?? 14)

const probe = { x: Number(q.get('x') ?? NaN), z: Number(q.get('z') ?? NaN) }
const camOffset = new THREE.Vector3(-55, 28, 22)
let topView = false
const keys = new Set<string>()
addEventListener('keydown', (e) => { keys.add(e.key.toLowerCase()); onKey(e.key) })
addEventListener('keyup', (e) => keys.delete(e.key.toLowerCase()))
addEventListener('resize', () => { camera.aspect = innerWidth / innerHeight; camera.updateProjectionMatrix(); renderer.setSize(innerWidth, innerHeight) })

const world = new SgWorld(q.get('base') ?? '/world/sg/')
let ready = false
const fakeCtx = { clock: { hour }, player: { get worldX() { return probe.x }, get worldZ() { return probe.z } }, vehicles: [] } as unknown as Ctx

const TELEPORTS: Record<string, string> = { '1': 'home_gang', '2': 'home_gold', '3': 'home_white', '4': 'home_blue', '5': 'landmark_marina_bay_sands', '6': 'mrt_raffles_place' }
/** 地标跳转（直接到模型中心，镜头拉远）：7 Merlion、8 Esplanade、9 Flyer、0 Lau Pa Sat、g 超级树、p Pinnacle、m 牛车水寺庙 */
const SITE_KEYS: Record<string, { site: string; cam: [number, number, number] }> = {
  '7': { site: 'merlion', cam: [-30, 14, 20] },
  '8': { site: 'esplanade', cam: [-150, 70, 140] },
  '9': { site: 'flyer', cam: [-260, 90, 140] },
  '0': { site: 'laupasat', cam: [-70, 45, 60] },
  g: { site: 'supertrees', cam: [-120, 45, 90] },
  p: { site: 'pinnacle', cam: [-260, 140, 160] },
  m: { site: 'mariamman', cam: [80, 45, 90] },
}

function placeCamera() {
  // 顶视图：高 600 m + 窄视角 25°，减小高楼的透视外倾
  camera.fov = topView ? 25 : 60
  camera.updateProjectionMatrix()
  if (topView) camera.position.set(probe.x, 600, probe.z + 0.01)
  else camera.position.set(probe.x + camOffset.x, camOffset.y, probe.z + camOffset.z)
  controls.target.set(probe.x, 1.5, probe.z)
  controls.update()
}
function teleport(id: string): boolean {
  const p = world.pois.find((o) => o.id === id)
  if (!p) return false
  probe.x = p.door.x; probe.z = p.door.z
  placeCamera()
  return true
}
function setTopView(on: boolean) {
  if (!topView) { camOffset.copy(camera.position).sub(controls.target); camOffset.y = Math.max(8, camOffset.y) }
  topView = on
  placeCamera()
}
function onKey(k: string) {
  if (k === 't' || k === 'T') setTopView(!topView)
  const id = TELEPORTS[k]
  if (id) teleport(id)
  const sk = SITE_KEYS[k.toLowerCase()]
  if (sk) jumpSite(sk.site, ...sk.cam)
}
/** 跳到地标模型中心，并把镜头放在 (dx, dy, dz) 偏移处 */
function jumpSite(site: string, dx = -150, dy = 80, dz = 120): boolean {
  const s = LANDMARK_SITES[site]
  if (!s) return false
  probe.x = s.x; probe.z = s.z
  camOffset.set(dx, dy, dz); topView = false
  placeCamera()
  return true
}

const fwd = new THREE.Vector3(), right = new THREE.Vector3()
function moveProbe(dt: number) {
  let mx = 0, mz = 0
  if (keys.has('w')) mz += 1
  if (keys.has('s')) mz -= 1
  if (keys.has('d')) mx += 1
  if (keys.has('a')) mx -= 1
  if (!mx && !mz) return
  camera.getWorldDirection(fwd); fwd.y = 0
  if (fwd.lengthSq() < 1e-4) fwd.set(0, 0, 1)
  fwd.normalize()
  right.set(-fwd.z, 0, fwd.x)
  const speed = (keys.has('shift') ? 80 : 20) * dt
  const dx = (fwd.x * mz + right.x * mx) * speed, dz = (fwd.z * mz + right.z * mx) * speed
  probe.x += dx; probe.z += dz
  camera.position.x += dx; camera.position.z += dz
  controls.target.x += dx; controls.target.z += dz
}

function nearestPoi() {
  let best = null as null | { name: string; d: number; id: string }
  for (const p of world.pois) {
    const d = Math.hypot(p.door.x - probe.x, p.door.z - probe.z)
    if (!best || d < best.d) best = { name: p.name, d, id: p.id }
  }
  return best
}

let last = performance.now(), fps = 0, frames = 0, fpsAcc = 0
let triangles = 0
function frame() {
  requestAnimationFrame(frame)
  const now = performance.now()
  const dt = Math.min(0.1, (now - last) / 1000); last = now
  fpsAcc += dt; frames++
  if (fpsAcc >= 0.5) { fps = frames / fpsAcc; frames = 0; fpsAcc = 0 }
  if (!ready) return
  moveProbe(dt)
  world.update(probe.x, probe.z, dt)
  dayNight.update(dt, fakeCtx)
  const fog = scene.fog as THREE.Fog
  fog.near = 400; fog.far = 1800   // 查看页放远雾以便看天际线（游戏内由 DayNight 控制）
  controls.update()
  renderer.render(scene, camera)
  triangles = renderer.info.render.triangles
  const s = world.stats
  const poi = nearestPoi()
  hud.textContent =
    `probe (${probe.x.toFixed(0)}, ${probe.z.toFixed(0)}) chunk ${chunkKeyAt(probe.x, probe.z, world.manifest.grid)}\n` +
    `loaded ${s.loaded}  pending ${s.pending}  failed ${s.failed}\n` +
    `drawCalls ${renderer.info.render.calls}  tris ${triangles}  fps ${fps.toFixed(0)}\n` +
    `buildings ${s.buildings}  props ${s.props}  marks ${s.marks}  geoms ${renderer.info.memory.geometries}\n` +
    `firstLoad ${world.firstLoadMs} ms  nearest: ${poi ? `${poi.name} (${poi.d.toFixed(0)} m)` : '-'}`
}

world.ready.then(() => {
  if (!Number.isFinite(probe.x) || !Number.isFinite(probe.z)) { probe.x = world.spawn.x; probe.z = world.spawn.z }
  world.attach(scene)
  dayNight.attachWorld()
  placeCamera()
  ready = true
}).catch((e: Error) => {
  errBox.style.display = 'block'
  errBox.textContent = String(e?.message ?? e)
  console.error(e)
})

;(window as unknown as { __viewer: unknown }).__viewer = {
  get ready() { return ready },
  get idle() { return ready && world.chunks.idle },
  get stats() {
    return { ...world.stats, drawCalls: renderer.info.render.calls, triangles, fps: +fps.toFixed(1), geometries: renderer.info.memory.geometries, textures: renderer.info.memory.textures, firstLoadMs: world.firstLoadMs, propPools: world.props.stats.pools }
  },
  get probe() { return { ...probe } },
  setProbe(x: number, z: number) { probe.x = x; probe.z = z; placeCamera() },
  teleport,
  jumpSite,
  /** 镜头看向 (tx, ty, tz)，相机放在世界坐标 (cx, cy, cz)；探针（区块加载中心）设到 (px, pz) */
  look(px: number, pz: number, cx: number, cy: number, cz: number, tx: number, ty: number, tz: number) {
    probe.x = px; probe.z = pz; topView = false
    camera.fov = 60; camera.updateProjectionMatrix()
    camera.position.set(cx, cy, cz); controls.target.set(tx, ty, tz); controls.update()
  },
  get landmarks() { return world.landmarks?.stats },
  get replaced() { return world.chunks.replaced },
  get skylineDropped() { return world.skylineDropped },
  topView(on: boolean) { setTopView(on) },
  setCamera(dx: number, dy: number, dz: number) { camOffset.set(dx, dy, dz); topView = false; placeCamera() },
  nearestPoi,
  get spawn() { return world.spawn },
  get bounds() { return world.bounds },
  get signalLights() { const s = scene.userData.signalLights as { edgeIds: number[] }; return s.edgeIds.length },
  get world() { return world },
}
frame()
