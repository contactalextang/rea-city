import { EN } from './en'

/**
 * 轻量 i18n：中文原文就是 key。t('罚款 {n}', { n }) 中文直接套变量，英文查 en/ 词典，查不到退回中文。
 * 语言在本模块加载时定下（URL ?lang= ← localStorage rea.settings.lang ← 浏览器语言），运行中不变；
 * 切换语言 = 存设置后重载页面（见 Game.setLang），所以数据文件可以在模块顶层直接调 t()。
 */
export type Lang = 'zh' | 'en'
export const LANGS: readonly Lang[] = ['zh', 'en']
export const LANG_LABEL: Record<Lang, string> = { zh: '中文', en: 'English' }
export const isLang = (v: unknown): v is Lang => v === 'zh' || v === 'en'

/** 浏览器语言：zh* → 中文，其它 → 英文；非浏览器环境中文 */
export function browserLang(): Lang {
  if (typeof document === 'undefined') return 'zh'   // node 跑模拟脚本：保持中文输出
  const n = navigator.language
  return /^zh/i.test(n) ? 'zh' : 'en'
}

export function detectLang(search = typeof location !== 'undefined' ? location.search : ''): Lang {
  const q = new URLSearchParams(search).get('lang')
  if (isLang(q)) return q
  try {
    const raw = typeof localStorage !== 'undefined' ? localStorage.getItem('rea.settings') : null
    const stored = raw ? (JSON.parse(raw) as { lang?: unknown }).lang : undefined
    if (isLang(stored)) return stored
  } catch { /* 隐私模式或数据损坏：忽略 */ }
  return browserLang()
}

export const lang: Lang = detectLang()
if (typeof document !== 'undefined') document.documentElement.lang = lang === 'zh' ? 'zh-CN' : 'en'

const dict: Record<string, string> | null = lang === 'en' ? EN : null
const missing = new Set<string>()

const fill = (s: string, vars?: Record<string, string | number>) =>
  vars ? s.replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? String(vars[k]) : m)) : s

/** 翻译：key 为中文原文，{name} 占位符由 vars 填 */
export function t(zh: string, vars?: Record<string, string | number>): string {
  if (!dict) return fill(zh, vars)
  const en = dict[zh]
  if (en === undefined) {
    if (import.meta.env?.DEV && !missing.has(zh)) { missing.add(zh); console.warn('[i18n] missing en:', zh) }
    return fill(zh, vars)
  }
  return fill(en, vars)
}

/** 开发调试：本次运行中查不到英文的中文 key */
export const missingKeys = () => [...missing]

/**
 * 翻译静态 HTML：data-i18n 的元素换 textContent（key 缺省取元素原文），
 * data-i18n-html 换 innerHTML，data-i18n-title 换 title。
 */
export function applyDom(root: ParentNode = document) {
  if (!dict) return
  for (const e of root.querySelectorAll<HTMLElement>('[data-i18n]')) e.textContent = t(e.dataset.i18n || e.textContent!.trim())
  for (const e of root.querySelectorAll<HTMLElement>('[data-i18n-html]')) e.innerHTML = t(e.dataset.i18nHtml || e.innerHTML.trim())
  for (const e of root.querySelectorAll<HTMLElement>('[data-i18n-title]')) e.title = t(e.dataset.i18nTitle || e.title)
}
