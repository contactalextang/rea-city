// 角色库独立测试页：dev/chars.html。4×4 排列 14 个预设 + 2 个随机行人，验证 draw call / 三角数 / 泄漏 / LOD。
import * as THREE from 'three'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import { CharacterLibrary } from '../characters/CharacterLibrary'
import { CharacterInstance } from '../characters/CharacterInstance'
import { specFromPreset } from '../characters/CharacterSpec'
import { presetIds, randomPedSpec } from '../characters/presets'

const hud = document.getElementById('hud')!
const bar = document.getElementById('bar')!
const errBox = document.getElementById('err')!
const showErr = (e: unknown) => { errBox.style.display = 'block'; errBox.textContent = String(e); console.error(e) }
addEventListener('error', (e) => showErr(e.message))
addEventListener('unhandledrejection', (e) => showErr(e.reason))

const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true })
renderer.setPixelRatio(Math.min(devicePixelRatio, 2))
renderer.setSize(innerWidth, innerHeight)
renderer.shadowMap.enabled = true
renderer.shadowMap.type = THREE.PCFShadowMap
document.body.appendChild(renderer.domElement)

const scene = new THREE.Scene()
scene.background = new THREE.Color(0x2d3140)
const camera = new THREE.PerspectiveCamera(40, innerWidth / innerHeight, 0.1, 200)
camera.position.set(4.5, 4.2, 9.5)
const controls = new OrbitControls(camera, renderer.domElement)
controls.target.set(0, 1, 0)
controls.update()

scene.add(new THREE.HemisphereLight(0xffffff, 0x3a4256, 1.1))
const sun = new THREE.DirectionalLight(0xffffff, 2.2)
sun.position.set(6, 10, 5)
sun.castShadow = true
sun.shadow.mapSize.set(2048, 2048)
sun.shadow.camera.left = -8; sun.shadow.camera.right = 8; sun.shadow.camera.top = 8; sun.shadow.camera.bottom = -8
sun.shadow.camera.near = 1; sun.shadow.camera.far = 30
scene.add(sun)
const ground = new THREE.Mesh(new THREE.PlaneGeometry(40, 40), new THREE.MeshLambertMaterial({ color: 0x3b4152 }))
ground.rotation.x = -Math.PI / 2
ground.receiveShadow = true
scene.add(ground)
scene.add(new THREE.GridHelper(16, 16, 0x6b7390, 0x4a5068))

const COLS = 4, SPACING = 1.7
const DEMO_CLIPS = ['Idle', 'Walk', 'Run', 'Aim', 'Shoot', 'Wave', 'Death', 'Hit', 'Punch', 'Kick', 'Roll', 'Interact', 'RunShoot', 'AimIdle', 'RunBack', 'IdleNeutral']

interface Slot { inst: CharacterInstance; label: string; random: boolean; clip: string }
const slots: Slot[] = []
let lod: 0 | 1 | 2 = 0
let lib: CharacterLibrary

function place(i: number, g: THREE.Group) {
  const r = Math.floor(i / COLS), c = i % COLS
  g.position.set((c - (COLS - 1) / 2) * SPACING, 0, (r - 1.5) * SPACING)
}

function createAt(i: number, random: boolean, presetId?: string) {
  const spec = random ? randomPedSpec() : specFromPreset(presetId!)
  const inst = new CharacterInstance(lib, spec)
  inst.setShadow(true)
  place(i, inst.group)
  scene.add(inst.group)
  const clip = DEMO_CLIPS[i % DEMO_CLIPS.length]
  inst.play(clip, { loop: clip !== 'Death' })
  const label = random ? `random#${i}` : presetId!
  const s: Slot = { inst, label, random, clip }
  if (slots[i]) { slots[i].inst.dispose() }
  slots[i] = s
  return s
}

/** 随机重生成：把两个随机行人槽位（以及可选全部）销毁后重建 */
function regen(all = false) {
  for (let i = 0; i < slots.length; i++) {
    if (!slots[i].random && !all) continue
    createAt(i, true)
  }
}

function playAll(alias: string) {
  for (const s of slots) { s.inst.play(alias, { loop: alias !== 'Death' }); s.clip = alias }
}

function button(text: string, fn: () => void) {
  const b = document.createElement('button'); b.textContent = text; b.onclick = fn; bar.appendChild(b)
}

// 统计
let fps = 0, frames = 0, fpsT = performance.now()
let tintT = 0

async function main() {
  lib = await CharacterLibrary.load()
  const ids = presetIds()
  for (let i = 0; i < 14 && i < ids.length; i++) createAt(i, false, ids[i])
  createAt(14, true); createAt(15, true)

  for (const a of ['Idle', 'Walk', 'Run', 'Wave', 'Death', 'Aim', 'Shoot']) button(`全部 ${a}`, () => playAll(a))
  button('各播不同', () => slots.forEach((s, i) => { s.clip = DEMO_CLIPS[i % DEMO_CLIPS.length]; s.inst.play(s.clip, { loop: s.clip !== 'Death' }) }))
  button('随机重生成（2 个行人）', () => regen(false))
  button('全部随机重生成', () => regen(true))
  button('LOD 0/1/2', () => { lod = ((lod + 1) % 3) as 0 | 1 | 2 })
  button('受击闪红', () => { tintT = 0.3; slots.forEach((s) => s.inst.setTint(0xff2a2a)) })

  const timer = new THREE.Timer()
  const headV = new THREE.Vector3()
  renderer.setAnimationLoop(() => {
    timer.update()
    const dt = Math.min(timer.getDelta(), 0.05)
    for (const s of slots) s.inst.update(dt, lod)
    if (tintT > 0) { tintT -= dt; if (tintT <= 0) slots.forEach((s) => s.inst.setTint(null)) }
    renderer.render(scene, camera)
    frames++
    const now = performance.now()
    if (now - fpsT >= 500) { fps = (frames * 1000) / (now - fpsT); frames = 0; fpsT = now }
    const info = renderer.info
    slots[0]?.inst.headPosition(headV)
    hud.textContent = [
      `角色 ${slots.length}  draw calls ${info.render.calls}  三角 ${info.render.triangles.toLocaleString()}  fps ${fps.toFixed(0)}`,
      `geometries ${info.memory.geometries}  textures ${info.memory.textures}  programs ${info.programs?.length ?? 0}  缓存几何 ${lib.cachedGeometryCount}`,
      `LOD ${lod}  ${slots[0]?.label} head y=${headV.y.toFixed(2)} 动作=${slots[0]?.inst.current}`,
      slots.map((s, i) => `${i.toString().padStart(2)} ${s.label.padEnd(16)} ${s.clip}`).join('\n'),
    ].join('\n')
  })

  // 自动化测试钩子
  ;(window as unknown as { __chars: unknown }).__chars = {
    lib, slots, scene, renderer, camera,
    regen, playAll, setLod: (l: 0 | 1 | 2) => { lod = l }, getLod: () => lod,
    stats: () => ({ calls: renderer.info.render.calls, triangles: renderer.info.render.triangles, geometries: renderer.info.memory.geometries, fps, cached: lib.cachedGeometryCount }),
    headY: (i: number) => { const v = new THREE.Vector3(); slots[i].inst.headPosition(v); return v.y },
  }
}

addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight; camera.updateProjectionMatrix()
  renderer.setSize(innerWidth, innerHeight)
})

main().catch(showErr)
