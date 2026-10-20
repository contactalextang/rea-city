// 建角色界面独立测试页：dev/creator.html。自建 renderer，new 模式建角色 → 存档；wardrobe 模式改已保存外观。
import * as THREE from 'three'
import { CharacterLibrary } from '../characters/CharacterLibrary'
import { Creator, loadCreatorResult, saveCreatorResult } from '../ui/Creator'
import type { CreatorResult } from '../ui/Creator'

const bar = document.getElementById('bar')!
const out = document.getElementById('out')!
const errBox = document.getElementById('err')!
const showErr = (e: unknown) => { errBox.style.display = 'block'; errBox.textContent = String(e); console.error(e) }
addEventListener('error', (e) => showErr(e.message))
addEventListener('unhandledrejection', (e) => showErr(e.reason))

const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true })
renderer.setPixelRatio(Math.min(devicePixelRatio, 2))
renderer.setSize(innerWidth, innerHeight)
renderer.setClearColor(0x0b1020, 1)
document.body.appendChild(renderer.domElement)
addEventListener('resize', () => renderer.setSize(innerWidth, innerHeight))

let creator: Creator | null = null
let lastResult: CreatorResult | null = null

const show = (title: string, r: CreatorResult | null) => {
  out.textContent = `${title}\n${r ? JSON.stringify(r, null, 2) : '（无）'}`
}

async function run(mode: 'new' | 'wardrobe', lib: CharacterLibrary) {
  if (creator?.isOpen) return
  const initial = mode === 'wardrobe' ? loadCreatorResult() ?? undefined : undefined
  creator?.dispose()
  creator = new Creator({ renderer, lib, mode, initial })
  bar.style.display = out.style.display = 'none'
  const r = await creator.open()
  bar.style.display = out.style.display = ''
  if (r) { saveCreatorResult(r); lastResult = r; show(`${mode === 'new' ? '新建' : '衣柜'}：已确认并保存到 localStorage['rea.character']`, r) }
  else show('已取消', loadCreatorResult())
}

async function main() {
  const lib = await CharacterLibrary.load()
  const btn = (t: string, fn: () => void) => { const b = document.createElement('button'); b.textContent = t; b.onclick = fn; bar.appendChild(b) }
  btn('新建角色', () => void run('new', lib))
  btn('衣柜（已保存）', () => void run('wardrobe', lib))
  show('已保存', loadCreatorResult())

  const timer = new THREE.Timer()
  renderer.setAnimationLoop(() => {
    timer.update()
    const dt = Math.min(timer.getDelta(), 0.05)
    if (creator?.isOpen) { creator.update(dt); creator.render() }
    else renderer.clear()
  })

  const need = () => { if (!creator) throw new Error('creator 未打开'); return creator }
  ;(window as unknown as { __creator: unknown }).__creator = {
    lib, renderer,
    open: (mode: 'new' | 'wardrobe' = 'new') => run(mode, lib),
    get creator() { return creator },
    selectRole: (id: Parameters<Creator['selectRole']>[0]) => need().selectRole(id),
    next: () => need().next(),
    back: () => need().back(),
    setGender: (g: 'm' | 'f') => need().setGender(g),
    setPart: (slot: Parameters<Creator['setPart']>[0], id: string | null) => need().setPart(slot, id),
    setColor: (key: Parameters<Creator['setColor']>[0], hex: string) => need().setColor(key, hex),
    setAnim: (a: Parameters<Creator['setAnim']>[0]) => need().setAnim(a),
    randomize: () => need().randomize(),
    confirm: () => need().confirm(),
    cancel: () => need().cancel(),
    state: () => ({ ...(creator?.state() ?? { isOpen: false }), geometries: renderer.info.memory.geometries, cached: lib.cachedGeometryCount, lastResult }),
    loadCreatorResult,
  }
  void run('new', lib)
}

main().catch(showErr)
