// 建角色界面：DOM 覆盖层（身份卡 / 外观表单）+ 自带 Scene 的 3D 转台预览。
// 与主游戏共用 renderer：render() 只在预览区域用 viewport/scissor 绘制，结束后恢复 viewport/scissor/clearColor/renderTarget。
import * as THREE from 'three'
import type { CharacterLibrary } from '../characters/CharacterLibrary'
import { CharacterInstance } from '../characters/CharacterInstance'
import type { CharacterSpec, Slot } from '../characters/CharacterSpec'
import { cloneSpec, validateSpec } from '../characters/CharacterSpec'
import { CLOTH_PALETTE, HAIR_PALETTE, SHOE_PALETTE, SKIN_PALETTE, identitySpec } from '../characters/presets'
import type { RoleId } from '../data/roles'
import { DEFAULT_ROLE, ROLES, isRoleId } from '../data/roles'

export interface CreatorResult { role: RoleId; spec: CharacterSpec; name: string }

export interface CreatorOptions {
  renderer: THREE.WebGLRenderer
  lib: CharacterLibrary
  container?: HTMLElement
  initial?: Partial<CreatorResult>
  /** new：先选身份再改外观；wardrobe：只改外观，不能换身份，可取消 */
  mode?: 'new' | 'wardrobe'
}

type ColorKey = 'skin' | 'hair' | 'top' | 'bottom' | 'shoes' | 'hat'

const STORAGE_KEY = 'rea.character'
const ROLE_ORDER: RoleId[] = ['gang', 'gold', 'white', 'blue']
const SLOTS: { slot: Slot; label: string }[] = [
  { slot: 'head', label: '头' }, { slot: 'body', label: '上衣' }, { slot: 'legs', label: '下装' }, { slot: 'feet', label: '鞋' }, { slot: 'hat', label: '帽子' },
]
const COLOR_ROWS: { key: ColorKey; label: string; palette: string[] }[] = [
  { key: 'skin', label: '肤色', palette: SKIN_PALETTE },
  { key: 'hair', label: '发色', palette: HAIR_PALETTE },
  { key: 'top', label: '上衣', palette: CLOTH_PALETTE },
  { key: 'bottom', label: '下装', palette: CLOTH_PALETTE },
  { key: 'shoes', label: '鞋', palette: SHOE_PALETTE },
  { key: 'hat', label: '帽色', palette: CLOTH_PALETTE },
]

/** 身份卡补充信息（家 = 中文地名；能做的事） */
const ROLE_INFO: Record<RoleId, { home: string; can: string[]; names: { m: string; f: string } }> = {
  gang: { home: '牛车水店屋', can: ['偷车', '收保护费', '街头破坏', '有枪 · 会被通缉'], names: { m: 'Ah Huat', f: 'Ah Lian' } },
  gold: { home: '滨海湾公寓', can: ['赶会议', '投资', '豪车'], names: { m: 'Marcus Tan', f: 'Rachel Tan' } },
  white: { home: '中峇鲁组屋', can: ['朝九晚五', '加班', 'MRT 通勤', '付房租'], names: { m: 'Jason Lim', f: 'Siti' } },
  blue: { home: '红山组屋', can: ['开的士', '送外卖', '工地', '体力消耗快'], names: { m: 'Raju', f: 'Kavitha' } },
}

const PREVIEW_BG = 0x1a2140
const HEX = /^#[0-9a-fA-F]{6}$/

const pick = <T>(arr: T[]): T => arr[Math.floor(Math.random() * arr.length) % arr.length]

/** 读取已保存的角色（localStorage['rea.character']），不合法返回 null；spec 经 validateSpec 兜底 */
export function loadCreatorResult(): CreatorResult | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return null
    const o = JSON.parse(raw) as Partial<CreatorResult>
    if (!o || !isRoleId(o.role)) return null
    const name = typeof o.name === 'string' && o.name.trim() ? o.name.trim().slice(0, 20) : ROLE_INFO[o.role].names.m
    return { role: o.role, spec: validateSpec(o.spec), name }
  } catch {
    return null
  }
}

export function saveCreatorResult(r: CreatorResult): void {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify({ role: r.role, spec: r.spec, name: r.name })) } catch { /* 隐私模式等：忽略 */ }
}

/** 样式只注入一次 */
function injectStyle() {
  if (document.getElementById('rea-creator-style')) return
  const s = document.createElement('style')
  s.id = 'rea-creator-style'
  s.textContent = CSS
  document.head.appendChild(s)
}

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] => {
  const e = document.createElement(tag)
  if (cls) e.className = cls
  if (text !== undefined) e.textContent = text
  return e
}

export class Creator {
  private readonly renderer: THREE.WebGLRenderer
  private readonly lib: CharacterLibrary
  private readonly container: HTMLElement
  readonly mode: 'new' | 'wardrobe'

  // 状态
  private role: RoleId
  private spec: CharacterSpec
  private name: string
  private nameEdited = false
  private step: 1 | 2
  private anim: 'Idle' | 'Walk' | 'Run' | 'Aim' = 'Idle'
  private _isOpen = false
  private resolveFn: ((r: CreatorResult | null) => void) | null = null
  private pending: Promise<CreatorResult | null> | null = null

  // 3D
  private readonly scene = new THREE.Scene()
  private readonly camera = new THREE.PerspectiveCamera(32, 1, 0.1, 50)
  private readonly turntable = new THREE.Group()
  private readonly staticGeos: THREE.BufferGeometry[] = []
  private readonly staticMats: THREE.Material[] = []
  private inst: CharacterInstance | null = null
  private yaw = 0.35
  private dragging = false
  private dragX = 0
  private idleT = 0
  private waveT = -1

  // DOM
  private root: HTMLDivElement | null = null
  private preview: HTMLDivElement | null = null
  private cards = new Map<RoleId, HTMLDivElement>()
  private partLabels = new Map<Slot, HTMLSpanElement>()
  private swatchRows = new Map<ColorKey, { sw: HTMLButtonElement[]; input: HTMLInputElement }>()
  private genderBtns: Record<'m' | 'f', HTMLButtonElement> | null = null
  private animBtns = new Map<string, HTMLButtonElement>()
  private nameInput: HTMLInputElement | null = null
  private roleTag: HTMLDivElement | null = null
  private backBtn: HTMLButtonElement | null = null
  private okBtn: HTMLButtonElement | null = null

  // 渲染状态保存（复用，避免每帧分配）
  private readonly _vp = new THREE.Vector4()
  private readonly _sc = new THREE.Vector4()
  private readonly _col = new THREE.Color()
  private readonly _size = new THREE.Vector2()

  constructor(opts: CreatorOptions) {
    this.renderer = opts.renderer
    this.lib = opts.lib
    this.container = opts.container ?? document.body
    this.mode = opts.mode ?? 'new'
    const ini = opts.initial ?? {}
    this.role = isRoleId(ini.role) ? ini.role : DEFAULT_ROLE
    this.spec = ini.spec ? validateSpec(ini.spec) : identitySpec(this.role)
    this.name = typeof ini.name === 'string' && ini.name.trim() ? ini.name.trim().slice(0, 20) : this.defaultName()
    this.nameEdited = !!ini.name
    this.step = this.mode === 'wardrobe' ? 2 : 1
    this.buildScene()
  }

  get isOpen() { return this._isOpen }

  /** 打开界面；确认 resolve 结果，取消（仅 wardrobe）resolve null。已打开时返回同一个 Promise */
  open(): Promise<CreatorResult | null> {
    if (this._isOpen && this.pending) return this.pending
    injectStyle()
    this._isOpen = true
    this.step = this.mode === 'wardrobe' ? 2 : 1
    this.inst = new CharacterInstance(this.lib, this.spec)
    this.turntable.add(this.inst.group)
    this.buildDom()
    this.refreshAll()
    this.greet()
    addEventListener('keydown', this.onKey)
    this.pending = new Promise((res) => { this.resolveFn = res })
    return this.pending
  }

  /** 关闭并清理 DOM 与角色实例（不 resolve；需要结果请走 confirm/cancel） */
  close(): void {
    if (!this._isOpen) return
    this._isOpen = false
    removeEventListener('keydown', this.onKey)
    this.root?.remove()
    this.root = null; this.preview = null; this.nameInput = null; this.roleTag = null; this.backBtn = null; this.okBtn = null; this.genderBtns = null
    this.cards.clear(); this.partLabels.clear(); this.swatchRows.clear(); this.animBtns.clear()
    this.inst?.dispose()
    this.inst = null
    const res = this.resolveFn
    this.resolveFn = null; this.pending = null
    res?.(null) // 外部直接 close 视为取消；confirm/cancel 已先置空 resolveFn
  }

  /** 释放预览场景的静态资源（不再使用 Creator 时调用） */
  dispose(): void {
    this.close()
    for (const g of this.staticGeos) g.dispose()
    for (const m of this.staticMats) m.dispose()
  }

  // ───────────── 每帧 ─────────────

  update(dt: number): void {
    if (!this._isOpen || !this.inst) return
    if (!this.dragging) {
      this.idleT += dt
      if (this.idleT > 1.5) this.yaw += dt * 0.45
    }
    this.turntable.rotation.y = this.yaw
    if (this.waveT >= 0) {
      this.waveT -= dt
      if (this.waveT < 0) this.inst.play('Wave', { loop: false, fade: 0.2 })
    } else if (this.inst.current === 'Wave' && this.inst.finished) {
      this.inst.play(this.anim, { fade: 0.3 })
    }
    this.inst.update(dt)
  }

  render(): void {
    if (!this._isOpen || !this.preview) return
    const r = this.renderer
    const canvas = r.domElement
    const cr = canvas.getBoundingClientRect()
    const pr = this.preview.getBoundingClientRect()
    r.getSize(this._size)
    const sx = cr.width > 0 ? this._size.x / cr.width : 1
    const sy = cr.height > 0 ? this._size.y / cr.height : 1
    const x = (pr.left - cr.left) * sx, w = pr.width * sx
    const y = (cr.bottom - pr.bottom) * sy, h = pr.height * sy
    // 保存
    r.getViewport(this._vp); r.getScissor(this._sc)
    const scTest = r.getScissorTest()
    r.getClearColor(this._col)
    const clearA = r.getClearAlpha()
    const target = r.getRenderTarget()
    const autoClear = r.autoClear
    // 全屏铺底色（模态界面盖住游戏画面），再只在预览区域渲染角色
    r.setRenderTarget(null)
    r.setScissorTest(false)
    r.setViewport(0, 0, this._size.x, this._size.y)
    r.setClearColor(PREVIEW_BG, 1)
    r.clear(true, true, false)
    if (w > 2 && h > 2) {
      this.camera.aspect = w / h
      this.fitCamera()
      r.setViewport(x, y, w, h)
      r.setScissor(x, y, w, h)
      r.setScissorTest(true)
      r.autoClear = true
      r.render(this.scene, this.camera)
    }
    // 恢复
    r.autoClear = autoClear
    r.setClearColor(this._col, clearA)
    r.setViewport(this._vp); r.setScissor(this._sc); r.setScissorTest(scTest)
    r.setRenderTarget(target)
  }

  // ───────────── 操作（UI 与测试钩子共用） ─────────────

  selectRole(id: RoleId) {
    if (this.mode === 'wardrobe' || !isRoleId(id)) return
    this.role = id
    this.spec = identitySpec(id)
    if (!this.nameEdited) this.name = this.defaultName()
    if (id !== 'gang' && this.anim === 'Aim') this.anim = 'Idle'
    this.applySpec()
    this.greet()
    this.refreshAll()
  }

  next() { if (this.step === 1) { this.step = 2; this.inst?.play(this.anim); this.waveT = -1; this.refreshAll() } }
  back() { if (this.step === 2 && this.mode === 'new') { this.step = 1; this.refreshAll() } }

  setGender(g: 'm' | 'f') {
    if (this.spec.body === g) return
    const s = cloneSpec(this.spec)
    s.body = g
    for (const slot of ['head', 'body', 'legs', 'feet'] as const) s.parts[slot] = this.lib.partsFor(slot, g)[0]?.id ?? s.parts[slot]
    // 名字未手改且是另一性别的默认名 → 换成该性别默认名
    const other = g === 'm' ? 'f' : 'm'
    if (!this.nameEdited && this.name === ROLE_INFO[this.role].names[other]) this.name = ROLE_INFO[this.role].names[g]
    this.spec = s
    this.applySpec(); this.refreshAll()
  }

  /** 设置部件（hat 可为 null）；连衣裙上下身自动成套 */
  setPart(slot: Slot, id: string | null) {
    const s = cloneSpec(this.spec)
    if (slot === 'hat') s.parts.hat = id
    else if (id) s.parts[slot] = id
    const pairs: Partial<Record<Slot, [Slot, string]>> = { body: ['legs', 'f_formal_legs'], legs: ['body', 'f_formal_body'] }
    const pair = pairs[slot]
    if (pair) {
      const [other, otherFormal] = pair
      const otherKey = other as 'body' | 'legs'
      if (id === `f_formal_${slot}`) s.parts[otherKey] = otherFormal
      else if (s.parts[otherKey] === otherFormal) s.parts[otherKey] = this.lib.partsFor(other, s.body).find((p) => !p.id.startsWith('f_formal'))?.id ?? s.parts[otherKey]
    }
    this.spec = validateSpec(s)
    this.applySpec(); this.refreshForm()
  }

  cyclePart(slot: Slot, dir: 1 | -1) {
    const opts: (string | null)[] = this.lib.partsFor(slot, this.spec.body).map((p) => p.id)
    if (slot === 'hat') opts.unshift(null)
    if (!opts.length) return
    const cur = Math.max(0, opts.indexOf(this.spec.parts[slot]))
    this.setPart(slot, opts[(cur + dir + opts.length) % opts.length])
  }

  setColor(key: ColorKey, hex: string) {
    if (!HEX.test(hex) || !(key in this.spec.colors)) return
    const s = cloneSpec(this.spec)
    s.colors[key] = hex.toLowerCase()
    this.spec = s
    this.applySpec(); this.refreshForm()
  }

  setName(name: string) {
    this.name = name.slice(0, 20)
    this.nameEdited = true
    if (this.nameInput && this.nameInput.value !== this.name) this.nameInput.value = this.name
  }

  setAnim(a: 'Idle' | 'Walk' | 'Run' | 'Aim') {
    if (a === 'Aim' && this.role !== 'gang') return
    this.anim = a
    this.waveT = -1
    this.inst?.play(a, { fade: 0.25 })
    this.refreshForm()
  }

  /** 随机：当前性别内随机部件 + 色板随机色 */
  randomize() {
    const g = this.spec.body
    const s = cloneSpec(this.spec)
    for (const slot of ['head', 'body', 'legs', 'feet'] as const) {
      const opts = this.lib.partsFor(slot, g)
      if (opts.length) s.parts[slot] = pick(opts).id
    }
    const dressTop = s.parts.body === 'f_formal_body', dressBottom = s.parts.legs === 'f_formal_legs'
    if (dressTop !== dressBottom) { s.parts.body = 'f_formal_body'; s.parts.legs = 'f_formal_legs' }
    const workerHead = s.parts.head.endsWith('_worker_head')
    s.parts.hat = workerHead ? null : Math.random() < 0.3 ? pick(this.lib.partsFor('hat', g)).id : null
    s.colors.skin = pick(SKIN_PALETTE)
    s.colors.hair = pick(HAIR_PALETTE)
    s.colors.top = pick(CLOTH_PALETTE)
    s.colors.bottom = pick(CLOTH_PALETTE)
    s.colors.shoes = pick(SHOE_PALETTE)
    s.colors.hat = workerHead || s.parts.hat === 'helmet' ? '#f5c400' : pick(CLOTH_PALETTE)
    if ((dressTop || dressBottom) || (s.parts.body === 'm_suit_body' && s.parts.legs === 'm_suit_legs')) s.colors.bottom = s.colors.top
    this.spec = validateSpec(s)
    this.applySpec(); this.refreshForm()
  }

  /** 恢复当前身份的默认外观（名字不变） */
  resetToRole() {
    this.spec = identitySpec(this.role)
    this.applySpec(); this.refreshAll()
  }

  /** 确认并 resolve 结果 */
  confirm() {
    if (!this._isOpen) return
    const result: CreatorResult = { role: this.role, spec: validateSpec(this.spec), name: this.name.trim() || this.defaultName() }
    const res = this.resolveFn
    this.resolveFn = null
    this.close()
    res?.(result)
  }

  /** 取消（仅 wardrobe）resolve null；new 模式第二步等于上一步 */
  cancel() {
    if (!this._isOpen) return
    if (this.mode === 'new') { this.back(); return }
    this.close()
  }

  state() {
    return {
      isOpen: this._isOpen, mode: this.mode, step: this.step, role: this.role, name: this.name,
      spec: cloneSpec(this.spec), anim: this.inst?.current ?? null,
    }
  }

  // ───────────── 内部 ─────────────

  private defaultName() { return ROLE_INFO[this.role].names[this.spec?.body ?? 'm'] }

  private applySpec() { this.inst?.setSpec(this.spec) }

  /** 身份切换时：Idle → 0.6 s 后 Wave → 回到当前动画 */
  private greet() {
    if (!this.inst) return
    this.inst.play(this.step === 1 ? 'Idle' : this.anim, { fade: 0.15 })
    this.waveT = this.step === 1 ? 0.6 : -1
  }

  private buildScene() {
    this.scene.background = null
    this.scene.add(new THREE.HemisphereLight(0xdfe8ff, 0x2a2f45, 1.6))
    const sun = new THREE.DirectionalLight(0xffffff, 2.0)
    sun.position.set(2.5, 4, 3)
    this.scene.add(sun)
    const rim = new THREE.DirectionalLight(0x8fb4ff, 0.9)
    rim.position.set(-3, 2.5, -3)
    this.scene.add(rim)
    // 地面圆盘 + 外圈高亮 + 假阴影（不依赖 renderer.shadowMap，避免改动主游戏阴影设置）
    const discGeo = new THREE.CylinderGeometry(1.05, 1.1, 0.08, 64)
    const discMat = new THREE.MeshLambertMaterial({ color: 0x2b3560 })
    const disc = new THREE.Mesh(discGeo, discMat)
    disc.position.y = -0.04
    const ringGeo = new THREE.RingGeometry(1.03, 1.1, 64)
    const ringMat = new THREE.MeshBasicMaterial({ color: 0xffd33d, transparent: true, opacity: 0.55 })
    const ring = new THREE.Mesh(ringGeo, ringMat)
    ring.rotation.x = -Math.PI / 2; ring.position.y = 0.002
    const blobGeo = new THREE.CircleGeometry(0.42, 32)
    const blobMat = new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.35, depthWrite: false })
    const blob = new THREE.Mesh(blobGeo, blobMat)
    blob.rotation.x = -Math.PI / 2; blob.position.y = 0.004
    this.staticGeos.push(discGeo, ringGeo, blobGeo)
    this.staticMats.push(discMat, ringMat, blobMat)
    this.turntable.add(disc, ring, blob)
    this.scene.add(this.turntable)
  }

  /** 按宽高比调整相机距离：竖屏拉远保证全身入镜 */
  private fitCamera() {
    const fovV = THREE.MathUtils.degToRad(this.camera.fov)
    const halfH = 1.3, halfW = 1.3
    const dV = halfH / Math.tan(fovV / 2)
    const dH = halfW / (Math.tan(fovV / 2) * this.camera.aspect)
    const d = Math.max(dV, dH) + 0.4
    this.camera.position.set(0, 1.55, d)
    this.camera.lookAt(0, 0.92, 0)
    this.camera.updateProjectionMatrix()
  }

  private onKey = (e: KeyboardEvent) => {
    if (!this._isOpen) return
    if (e.key === 'Enter') {
      e.preventDefault()
      if (this.step === 1) this.next(); else this.confirm()
    } else if (e.key === 'Escape') {
      e.preventDefault()
      this.cancel()
    }
  }

  private buildDom() {
    const root = el('div', 'cr-root')
    // 焦点在界面内时 keydown 不冒泡到游戏（输入框打字不触发游戏按键），但 Enter/Esc 在这里直接处理，
    // 否则点过身份卡/按钮后焦点留在 root 内，window 上的 onKey 收不到，「Enter 确认」失效
    root.addEventListener('keydown', (e) => {
      e.stopPropagation()
      if (e.isComposing || e.repeat) return   // 输入法选词的 Enter / 长按连发不算确认
      const inText = e.target === this.nameInput
      if (e.key === 'Enter') {
        // preventDefault 阻止按钮自身的 Enter 激活（click），避免与这里的确认双重触发
        e.preventDefault()
        if (inText) this.nameInput?.blur()   // 名字框：先失焦（提交输入）再确认
        this.onKey(e)
      } else if (e.key === 'Escape' && !inText) {
        e.preventDefault()
        this.onKey(e)
      }
    })
    const panel = el('div', 'cr-panel')
    const head = el('div', 'cr-head')
    head.append(el('h2', '', this.mode === 'wardrobe' ? '衣柜' : '创建角色'))
    if (this.mode === 'new') {
      const steps = el('div', 'cr-steps')
      steps.append(el('span', 's1', '① 选择身份'), el('span', 'sep', '›'), el('span', 's2', '② 外观'))
      head.append(steps)
    }
    const body = el('div', 'cr-body')
    if (this.mode === 'new') body.append(this.buildStep1())
    body.append(this.buildStep2())
    const foot = el('div', 'cr-foot')
    const back = el('button', 'cr-btn', this.mode === 'wardrobe' ? '取消' : '上一步')
    back.onclick = () => this.mode === 'wardrobe' ? this.cancel() : this.back()
    const hint = el('span', 'cr-hint')
    hint.innerHTML = this.mode === 'wardrobe' ? '<kbd>Enter</kbd> 保存 · <kbd>Esc</kbd> 取消' : '<kbd>Enter</kbd> 确认'
    const ok = el('button', 'cr-btn primary')
    ok.onclick = () => this.step === 1 ? this.next() : this.confirm()
    foot.append(back, hint, ok)
    panel.append(head, body, foot)

    const stage = el('div', 'cr-stage')
    const preview = el('div', 'cr-preview')
    preview.addEventListener('pointerdown', (e) => {
      this.dragging = true; this.dragX = e.clientX; this.idleT = 0
      preview.setPointerCapture(e.pointerId)
    })
    preview.addEventListener('pointermove', (e) => {
      if (!this.dragging) return
      this.yaw += (e.clientX - this.dragX) * 0.012
      this.dragX = e.clientX
    })
    const end = (e: PointerEvent) => { this.dragging = false; this.idleT = 0; if (preview.hasPointerCapture(e.pointerId)) preview.releasePointerCapture(e.pointerId) }
    preview.addEventListener('pointerup', end)
    preview.addEventListener('pointercancel', end)
    const tag = el('div', 'cr-roletag')
    preview.append(tag, el('div', 'cr-drag', '拖拽旋转'))
    const anims = el('div', 'cr-anims')
    for (const [a, label] of [['Idle', '站立'], ['Walk', '走路'], ['Run', '跑步'], ['Aim', '持枪']] as const) {
      const b = el('button', 'cr-chip', label)
      b.onclick = () => this.setAnim(a)
      this.animBtns.set(a, b)
      anims.append(b)
    }
    stage.append(preview, anims)
    root.append(panel, stage)
    this.container.append(root)
    this.root = root; this.preview = preview; this.roleTag = tag; this.backBtn = back; this.okBtn = ok
  }

  private buildStep1(): HTMLElement {
    const sec = el('section', 'cr-s1')
    sec.append(el('p', 'cr-sub', '选择你在这座城市的身份：决定起始资金、住处和能做的事。'))
    const row = el('div', 'cr-cards')
    for (const id of ROLE_ORDER) {
      const def = ROLES[id], info = ROLE_INFO[id]
      const card = el('div', 'cr-card')
      card.tabIndex = 0
      card.dataset.role = id
      const t = el('div', 'ct')
      t.append(el('b', '', def.title))
      if (id === DEFAULT_ROLE) t.append(el('span', 'cr-badge', '默认'))
      card.append(t, el('div', 'cd', def.desc))
      const meta = el('div', 'cm')
      const home = el('div', '', '家 '); home.append(el('b', '', info.home))
      const cash = el('div', '', '起始现金 '); cash.append(el('b', 'cash', `S$ ${def.cash.toLocaleString('en-SG')}`))
      meta.append(home, cash)
      const ul = el('ul', 'cc')
      for (const c of info.can) ul.append(el('li', '', c))
      card.append(meta, ul)
      card.onclick = () => this.selectRole(id)
      card.ondblclick = () => { this.selectRole(id); this.next() }
      this.cards.set(id, card)
      row.append(card)
    }
    sec.append(row)
    return sec
  }

  private buildStep2(): HTMLElement {
    const sec = el('section', 'cr-s2')
    // 名字
    const nameRow = el('div', 'cr-row')
    nameRow.append(el('label', 'cr-lab', '名字'))
    const input = el('input', 'cr-name')
    input.type = 'text'; input.maxLength = 20; input.value = this.name; input.placeholder = this.defaultName()
    input.oninput = () => this.setName(input.value)
    nameRow.append(input)
    this.nameInput = input
    // 性别
    const gRow = el('div', 'cr-row')
    gRow.append(el('label', 'cr-lab', '性别'))
    const seg = el('div', 'cr-seg')
    const bm = el('button', 'cr-chip', '男'), bf = el('button', 'cr-chip', '女')
    bm.onclick = () => this.setGender('m'); bf.onclick = () => this.setGender('f')
    seg.append(bm, bf); gRow.append(seg)
    this.genderBtns = { m: bm, f: bf }
    sec.append(nameRow, gRow)
    // 部件
    const partsBox = el('div', 'cr-group')
    partsBox.append(el('div', 'cr-gt', '部件'))
    for (const { slot, label } of SLOTS) {
      const r = el('div', 'cr-row')
      r.append(el('label', 'cr-lab', label))
      const ctl = el('div', 'cr-arrow')
      const l = el('button', 'cr-ab', '‹'), rr = el('button', 'cr-ab', '›')
      l.onclick = () => this.cyclePart(slot, -1); rr.onclick = () => this.cyclePart(slot, 1)
      const lab = el('span', 'cr-pl')
      ctl.append(l, lab, rr)
      r.append(ctl)
      this.partLabels.set(slot, lab)
      partsBox.append(r)
    }
    sec.append(partsBox)
    // 颜色
    const colBox = el('div', 'cr-group')
    colBox.append(el('div', 'cr-gt', '颜色'))
    for (const { key, label, palette } of COLOR_ROWS) {
      const r = el('div', 'cr-row top')
      r.append(el('label', 'cr-lab', label))
      const sw = el('div', 'cr-sw')
      const btns: HTMLButtonElement[] = []
      for (const hex of [...new Set(palette)]) {
        const b = el('button', 'cr-dot')
        b.style.background = hex; b.title = hex; b.dataset.hex = hex
        b.onclick = () => this.setColor(key, hex)
        btns.push(b); sw.append(b)
      }
      const custom = el('input', 'cr-custom')
      custom.type = 'color'; custom.title = '自定义颜色'
      custom.oninput = () => this.setColor(key, custom.value)
      sw.append(custom)
      r.append(sw)
      this.swatchRows.set(key, { sw: btns, input: custom })
      colBox.append(r)
    }
    sec.append(colBox)
    // 随机 / 恢复
    const acts = el('div', 'cr-acts')
    const rnd = el('button', 'cr-btn', '🎲 随机'), rst = el('button', 'cr-btn', '恢复身份默认')
    rnd.onclick = () => this.randomize(); rst.onclick = () => this.resetToRole()
    acts.append(rnd, rst)
    sec.append(acts)
    return sec
  }

  private refreshAll() {
    if (!this.root) return
    this.root.dataset.step = String(this.step)
    this.root.dataset.mode = this.mode
    for (const [id, card] of this.cards) card.classList.toggle('on', id === this.role)
    const steps = this.root.querySelector('.cr-steps')
    steps?.querySelector('.s1')?.classList.toggle('on', this.step === 1)
    steps?.querySelector('.s2')?.classList.toggle('on', this.step === 2)
    if (this.backBtn) this.backBtn.style.visibility = this.mode === 'new' && this.step === 1 ? 'hidden' : 'visible'
    if (this.okBtn) this.okBtn.textContent = this.mode === 'wardrobe' ? '保存' : this.step === 1 ? '下一步 ›' : '开始游戏'
    if (this.roleTag) this.roleTag.textContent = ROLES[this.role].title
    if (this.nameInput) { this.nameInput.value = this.name; this.nameInput.placeholder = this.defaultName() }
    this.refreshForm()
  }

  private refreshForm() {
    if (!this.root) return
    if (this.genderBtns) { this.genderBtns.m.classList.toggle('on', this.spec.body === 'm'); this.genderBtns.f.classList.toggle('on', this.spec.body === 'f') }
    for (const [slot, lab] of this.partLabels) {
      const id = this.spec.parts[slot]
      lab.textContent = id ? this.lib.parts.get(id)?.label ?? id : '无'
    }
    const colors = this.spec.colors as Record<string, string>
    for (const [key, row] of this.swatchRows) {
      const cur = colors[key]
      for (const b of row.sw) b.classList.toggle('on', b.dataset.hex === cur)
      if (row.input.value !== cur) row.input.value = cur
      row.input.classList.toggle('on', !row.sw.some((b) => b.dataset.hex === cur))
    }
    for (const [a, b] of this.animBtns) {
      b.classList.toggle('on', a === this.anim)
      b.style.display = a === 'Aim' && this.role !== 'gang' ? 'none' : ''
    }
  }
}

const CSS = `
.cr-root { position: fixed; inset: 0; z-index: 50; display: flex; color: #fff; font-family: -apple-system, "PingFang SC", "Helvetica Neue", Arial, sans-serif; user-select: none; }
.cr-root button { font-family: inherit; }
.cr-panel { position: relative; display: flex; flex-direction: column; width: min(440px, 44vw); margin: 16px 0 16px 16px; background: rgba(5,8,20,.82); border: 1px solid rgba(255,255,255,.1); border-radius: 14px; box-shadow: 0 10px 40px rgba(0,0,0,.45); overflow: hidden; transition: width .25s; }
.cr-root[data-step="1"] .cr-panel { width: min(860px, 64vw); align-self: center; max-height: calc(100% - 32px); }
.cr-root[data-step="1"] .cr-body { flex: none; }
.cr-head { display: flex; align-items: baseline; gap: 16px; padding: 16px 20px 6px; flex-wrap: wrap; }
.cr-head h2 { margin: 0; font-size: 24px; letter-spacing: 2px; color: #ffd33d; }
.cr-steps { font-size: 13px; opacity: .65; display: flex; gap: 8px; }
.cr-steps .on { color: #7ee787; opacity: 1; font-weight: 700; }
.cr-body { flex: 1; min-height: 0; overflow-y: auto; padding: 6px 20px 12px; }
.cr-root[data-step="1"] .cr-s2, .cr-root[data-step="2"] .cr-s1 { display: none; }
.cr-sub { margin: 4px 0 14px; font-size: 14px; opacity: .8; }
.cr-cards { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 12px; }
.cr-card { position: relative; padding: 14px 13px; border-radius: 12px; background: rgba(255,255,255,.05); border: 2px solid rgba(255,255,255,.12); cursor: pointer; transition: border-color .15s, background .15s, transform .15s; outline: none; }
.cr-card:hover { background: rgba(255,255,255,.09); transform: translateY(-2px); }
.cr-card.on { border-color: #7ee787; background: rgba(126,231,135,.12); }
.cr-card .ct { display: flex; align-items: center; gap: 8px; font-size: 19px; margin-bottom: 6px; }
.cr-card .cd { font-size: 13px; line-height: 1.5; opacity: .85; min-height: 39px; }
.cr-card .cm { margin: 10px 0 8px; font-size: 13px; line-height: 1.7; opacity: .9; }
.cr-card .cm b { font-weight: 600; }
.cr-card .cash { color: #7ee787; }
.cr-card .cc { margin: 0; padding-left: 0; list-style: none; font-size: 12.5px; line-height: 1.65; opacity: .8; }
.cr-card .cc li::before { content: '· '; color: #7ee787; font-weight: 700; }
.cr-badge { font-size: 11px; padding: 1px 6px; border-radius: 4px; background: #ffd33d; color: #0b1020; font-weight: 700; }
.cr-row { display: flex; align-items: center; gap: 10px; margin: 8px 0; }
.cr-row.top { align-items: flex-start; }
.cr-lab { width: 44px; flex: none; font-size: 13px; opacity: .75; }
.cr-row.top .cr-lab { padding-top: 4px; }
.cr-name { flex: 1; min-width: 0; font: inherit; font-size: 15px; color: #fff; background: rgba(0,0,0,.35); border: 1px solid rgba(255,255,255,.25); border-radius: 6px; padding: 7px 10px; user-select: text; }
.cr-name:focus { outline: none; border-color: #7ee787; }
.cr-group { margin-top: 14px; padding: 8px 12px 6px; border-radius: 10px; background: rgba(255,255,255,.04); }
.cr-gt { font-size: 12px; letter-spacing: 2px; opacity: .55; margin-bottom: 2px; }
.cr-seg { display: flex; gap: 6px; }
.cr-chip, .cr-btn, .cr-ab { color: #fff; background: rgba(255,255,255,.08); border: 1px solid rgba(255,255,255,.25); border-radius: 6px; cursor: pointer; font-size: 13px; padding: 6px 14px; }
.cr-chip:hover, .cr-btn:hover, .cr-ab:hover { background: rgba(126,231,135,.18); border-color: #7ee787; }
.cr-chip.on { background: rgba(126,231,135,.3); border-color: #7ee787; }
.cr-arrow { flex: 1; display: flex; align-items: center; gap: 6px; }
.cr-ab { width: 32px; padding: 4px 0; font-size: 18px; line-height: 1; }
.cr-pl { flex: 1; text-align: center; font-size: 14px; background: rgba(0,0,0,.25); border-radius: 6px; padding: 6px 4px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.cr-sw { flex: 1; display: flex; flex-wrap: wrap; gap: 4px; align-items: center; }
.cr-dot { width: 19px; height: 19px; padding: 0; border-radius: 50%; border: 2px solid rgba(255,255,255,.25); cursor: pointer; }
.cr-dot.on { border-color: #ffd33d; box-shadow: 0 0 0 2px rgba(255,211,61,.45); }
.cr-custom { width: 28px; height: 22px; padding: 0; border: 1px dashed rgba(255,255,255,.5); border-radius: 5px; background: none; cursor: pointer; }
.cr-custom.on { border: 2px solid #ffd33d; }
.cr-acts { display: flex; gap: 8px; margin: 14px 0 4px; }
.cr-foot { display: flex; align-items: center; gap: 10px; padding: 12px 20px; border-top: 1px solid rgba(255,255,255,.08); background: rgba(0,0,0,.25); }
.cr-hint { flex: 1; text-align: center; font-size: 12px; opacity: .6; }
.cr-hint kbd { display: inline-block; padding: 1px 6px; border: 1px solid rgba(255,255,255,.6); border-radius: 4px; background: rgba(0,0,0,.4); font-family: inherit; font-size: 11px; }
.cr-btn.primary { background: rgba(126,231,135,.25); border-color: #7ee787; color: #7ee787; font-weight: 700; font-size: 15px; padding: 8px 22px; }
.cr-btn.primary:hover { background: rgba(126,231,135,.4); color: #fff; }
.cr-stage { flex: 1; min-width: 0; display: flex; flex-direction: column; padding: 16px; }
.cr-preview { position: relative; flex: 1; min-height: 0; border-radius: 14px; cursor: grab; touch-action: none; background: radial-gradient(ellipse at 50% 38%, rgba(140,170,255,.10), rgba(0,0,0,0) 62%); }
.cr-preview:active { cursor: grabbing; }
.cr-roletag { position: absolute; left: 50%; top: 10px; transform: translateX(-50%); font-size: 15px; font-weight: 700; color: #ffd33d; background: rgba(0,0,0,.35); padding: 4px 14px; border-radius: 20px; pointer-events: none; }
.cr-drag { position: absolute; right: 12px; bottom: 10px; font-size: 11px; opacity: .45; pointer-events: none; }
.cr-anims { display: flex; justify-content: center; gap: 8px; padding-top: 10px; }
.cr-root[data-step="1"] .cr-anims { visibility: hidden; }
@media (max-width: 760px) {
  .cr-root { flex-direction: column; }
  .cr-stage { order: -1; flex: none; height: 38vh; padding: 8px 10px 0; }
  .cr-root[data-step="1"] .cr-stage { height: 30vh; }
  .cr-anims { padding-top: 6px; }
  .cr-panel, .cr-root[data-step="1"] .cr-panel { width: auto; flex: 1; min-height: 0; max-height: none; align-self: stretch; margin: 8px 10px 10px; }
  .cr-root[data-step="1"] .cr-body { flex: 1; }
  .cr-head { padding: 12px 14px 4px; }
  .cr-head h2 { font-size: 20px; }
  .cr-body { padding: 4px 14px 10px; }
  .cr-cards { grid-template-columns: 1fr; gap: 8px; }
  .cr-card { padding: 10px 12px; }
  .cr-card .cd { min-height: 0; }
  .cr-card .cm { display: flex; gap: 14px; margin: 6px 0 4px; }
  .cr-card .cc { display: flex; flex-wrap: wrap; gap: 2px 14px; }
  .cr-foot { padding: 10px 14px; }
  .cr-hint { display: none; }
  .cr-foot .cr-btn:last-child { margin-left: auto; }
}
/* 横屏手机等矮屏：第一步正文改为可滚动，底栏按钮始终可见 */
@media (max-height: 520px) {
  .cr-panel, .cr-root[data-step="1"] .cr-panel { margin: 8px 0 8px 8px; max-height: calc(100% - 16px); }
  .cr-root[data-step="1"] .cr-body { flex: 1; }
  .cr-head { padding: 10px 14px 2px; }
  .cr-head h2 { font-size: 19px; }
  .cr-sub { margin: 2px 0 8px; font-size: 13px; }
  .cr-foot { padding: 8px 14px; }
  .cr-stage { padding: 8px; }
}
`
