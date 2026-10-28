import type { ComicPanel } from '../data/storyComics'
import { t } from '../i18n'

/** 漫画图目录（public/assets/story，不入库；先 .webp 再 .png，都失败 → 文字格） */
const DIR = '/assets/story/'
const EXTS = ['webp', 'png']

interface Seq { panels: ComicPanel[]; done?: () => void }

export interface StoryCardHooks {
  /** 现在能否开播（Game：play / panel 状态、#overlay 已隐藏、不在建角色） */
  canShow: () => boolean
  /** 开播：暂停世界（Game 复用 panel 状态） */
  onOpen: () => void
  /** 全部播完（队列空）：恢复 */
  onClose: () => void
}

/**
 * 漫画剧情过场卡：全屏黑白漫画格，一格一屏。
 * 点击 / Enter / Space 翻页，Esc 跳过当前这段；多段排队依次播放，播完一段回调 done。
 * 由 Game 每帧 pump()：条件允许（#overlay 已隐藏等）才开播。
 */
export class StoryCard {
  private root: HTMLDivElement
  private page: HTMLDivElement
  private foot: HTMLSpanElement
  private num: HTMLSpanElement
  private osm: HTMLDivElement
  private queue: Seq[] = []
  private cur: Seq | null = null
  private idx = 0
  private open = false
  /** 换页中（等图片解析）：忽略翻页输入 */
  private token = 0
  private imgCache = new Map<string, Promise<string | null>>()

  constructor(private hooks: StoryCardHooks, public enabled = true) {
    const root = document.createElement('div')
    root.className = 'story'
    root.id = 'story'
    root.innerHTML = '<div class="sc-page"></div><div class="sc-foot"><span class="sc-hint"></span><span class="sc-num"></span></div><div class="sc-osm">© OpenStreetMap contributors</div>'
    document.body.appendChild(root)
    this.root = root
    this.page = root.querySelector('.sc-page')!
    this.foot = root.querySelector('.sc-hint')!
    this.num = root.querySelector('.sc-num')!
    this.osm = root.querySelector('.sc-osm')!
    // 触屏没有 Esc：只提示点击（Game 在建 StoryCard 前已给 body 加 .touch）
    this.foot.textContent = document.body.classList.contains('touch') ? t('点击继续') : t('点击继续 · Esc 跳过')
    // 不让点击冒泡到 body（会被 Input 当成「点击锁定鼠标 / 开火」）
    root.addEventListener('mousedown', (e) => e.stopPropagation())
    root.addEventListener('click', (e) => { e.stopPropagation(); if (this.open) this.next() })
    // 捕获阶段吞掉按键：Input 的 window 冒泡监听收不到（不会触发全屏 / 手机 / 关面板）
    window.addEventListener('keydown', (e) => {
      if (!this.open) return
      e.preventDefault(); e.stopPropagation()
      if (e.repeat) return
      if (e.code === 'Escape') this.skip()
      else if (e.code === 'Enter' || e.code === 'Space' || e.code === 'NumpadEnter') this.next()
    }, true)
  }

  get isOpen() { return this.open }
  /** 有正在播或排队中的过场 */
  get busy() { return this.open || this.queue.length > 0 }

  /**
   * 排队一段过场。返回 false = 不播（关闭 / 无数据），调用方照原逻辑走；
   * 返回 true = 播完（或跳过）后会调 done。
   */
  enqueue(panels: ComicPanel[] | undefined, done?: () => void): boolean {
    if (!this.enabled || !panels || panels.length === 0) return false
    this.queue.push({ panels, done })
    for (const p of panels) if (p.img) void this.resolveImg(p.img)   // 预加载
    return true
  }
  /** 调试：立即排队播放（不经 enabled 开关） */
  play(panels: ComicPanel[]) {
    if (!panels?.length) return false
    this.queue.push({ panels })
    this.pump()
    return true
  }

  /** 每帧调用：空闲且允许时开播队首 */
  pump() {
    if (this.cur || this.queue.length === 0 || !this.hooks.canShow()) return
    if (!this.open) {
      this.open = true
      this.root.classList.add('show')
      if (document.pointerLockElement) document.exitPointerLock()
      this.hooks.onOpen()
    }
    this.cur = this.queue.shift()!
    this.idx = 0
    void this.render()
  }

  next() {
    if (!this.cur) return
    if (this.idx + 1 < this.cur.panels.length) { this.idx++; void this.render() }
    else this.finishSeq()
  }
  /** 跳过当前这段（其余排队的段照常播） */
  skip() { if (this.cur) this.finishSeq() }

  private finishSeq() {
    const s = this.cur
    this.cur = null
    this.token++
    if (this.queue.length > 0 && this.hooks.canShow()) {
      s?.done?.()
      this.pump()
      return
    }
    this.open = false
    this.root.classList.remove('show')
    this.page.innerHTML = ''
    this.hooks.onClose()
    s?.done?.()
  }

  private resolveImg(id: string): Promise<string | null> {
    let p = this.imgCache.get(id)
    if (p) return p
    p = new Promise<string | null>((resolve) => {
      const tryExt = (i: number) => {
        if (i >= EXTS.length) { resolve(null); return }
        const url = `${DIR}${encodeURIComponent(id)}.${EXTS[i]}`
        const img = new Image()
        img.onload = () => resolve(url)
        img.onerror = () => tryExt(i + 1)
        img.src = url
      }
      tryExt(0)
    })
    this.imgCache.set(id, p)
    return p
  }

  private async render() {
    const seq = this.cur; if (!seq) return
    const tok = ++this.token
    const panel = seq.panels[this.idx]
    const total = seq.panels.length
    this.num.textContent = total > 1 ? `${this.idx + 1}/${total}` : ''
    const url = panel.img ? await this.resolveImg(panel.img) : null
    if (tok !== this.token) return
    const frame = document.createElement('div')
    frame.className = 'sc-frame' + (url ? '' : ' text')
    frame.style.setProperty('--tilt', `${this.idx % 2 ? 0.6 : -0.6}deg`)
    if (url) {
      const img = document.createElement('img')
      img.src = url; img.alt = ''; img.draggable = false
      frame.appendChild(img)
      if (panel.caption) frame.appendChild(el('div', 'sc-cap', panel.caption))
      ;(panel.bubbles ?? []).forEach((b, i) => {
        const bub = el('div', `sc-bub ${i % 2 ? 'r' : 'l'}${panel.caption ? '' : ' nocap'}`, '')
        bub.style.setProperty('--row', String(Math.floor(i / 2)))
        if (b.who) bub.appendChild(el('div', 'sc-who', b.who))
        bub.appendChild(el('div', 'sc-txt', b.text))
        frame.appendChild(bub)
      })
    } else {
      // 降级文字格：黑底白字，旁白大字 + 对白列表
      const box = el('div', 'sc-tbox', '')
      if (panel.caption) box.appendChild(el('div', 'sc-tcap', panel.caption))
      for (const b of panel.bubbles ?? []) {
        const line = el('div', 'sc-tline', '')
        if (b.who) line.appendChild(el('span', 'sc-twho', b.who))
        line.appendChild(el('span', 'sc-ttxt', b.text))
        box.appendChild(line)
      }
      frame.appendChild(box)
    }
    this.osm.style.display = url ? '' : 'none'
    this.page.innerHTML = ''
    this.page.appendChild(frame)
    // 重新触发入场动画
    this.page.classList.remove('in'); void this.page.offsetWidth; this.page.classList.add('in')
  }
}

function el(tag: string, cls: string, text: string) {
  const e = document.createElement(tag)
  e.className = cls
  if (text) e.textContent = text
  return e
}
