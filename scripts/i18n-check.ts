/**
 * i18n 漏网检查：npm run i18n:check
 * 1. src 下（不含 dev/、i18n/）没被 t('…') 包住的中文字符串字面量；不算：注释、console.* / Error( 所在行、
 *    GLSL 着色器模板、带 i18n-ignore 的行、含 i18n-ignore-file 的文件（如招牌上的实景中文店名）
 * 2. index.html <body> 里没标 data-i18n* 的中文
 * 3. t('…') 用到但 src/i18n/en/*.ts 没有的 key；en 里有但没人用的 key（只提示）；en 里同 key 不同译文
 * 有漏网或缺 key 时退出码 1
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

const ROOT = new URL('..', import.meta.url).pathname
const SRC = join(ROOT, 'src')
const CJK = /[㐀-鿿！-～　-〿]/
const HAN = /[㐀-鿿]/
/** 着色器源码（中文只在 GLSL 注释里） */
const GLSL = /#include|\/\* glsl \*\/|\bvec[234]\b|\bfloat\b|\buniform\b|\bvarying\b|gl_|;\s*(\/\/|$)/m

function walk(dir: string, out: string[] = []) {
  for (const f of readdirSync(dir)) {
    const p = join(dir, f)
    if (statSync(p).isDirectory()) { if (f !== 'dev' && f !== 'i18n') walk(p, out) } else if (/\.ts$/.test(f)) out.push(p)
  }
  return out
}

interface Lit { text: string; line: number; start: number; tpl: boolean }
/** 扫出字符串字面量（跳过注释；模板字符串的 ${} 内部递归扫） */
function literals(src: string): Lit[] {
  const out: Lit[] = []
  let i = 0, line = 1
  const n = src.length
  // 模板 ${ 嵌套栈：记录当前 {} 深度
  const tplStack: number[] = []
  let depth = 0
  const readString = (q: string) => {
    const start = i, l0 = line
    i++
    let text = ''
    while (i < n) {
      const c = src[i]
      if (c === '\\') { text += src.slice(i, i + 2); if (src[i + 1] === '\n') line++; i += 2; continue }
      if (c === '\n') line++
      if (c === q) { i++; break }
      if (q === '`' && c === '$' && src[i + 1] === '{') {
        out.push({ text, line: l0, start, tpl: true }); text = ''
        i += 2; tplStack.push(depth); depth++
        return false
      }
      text += c; i++
    }
    out.push({ text, line: l0, start, tpl: q === '`' })
    return true
  }
  while (i < n) {
    const c = src[i]
    if (c === '\n') { line++; i++; continue }
    if (c === '/' && src[i + 1] === '/') { while (i < n && src[i] !== '\n') i++; continue }
    if (c === '/' && src[i + 1] === '*') { const e = src.indexOf('*/', i + 2); for (let k = i; k < e; k++) if (src[k] === '\n') line++; i = e + 2; continue }
    if (c === '"' || c === "'" || c === '`') { readString(c); continue }
    if (c === '{') { depth++; i++; continue }
    if (c === '}') {
      depth--
      if (tplStack.length && tplStack[tplStack.length - 1] === depth) { tplStack.pop(); readString('`'); continue }
      i++; continue
    }
    // 正则字面量：粗判（前一个非空字符是 ( , = : [ ! & | ? { } ; 或行首）
    if (c === '/') {
      let k = i - 1; while (k >= 0 && /\s/.test(src[k])) k--
      if (k < 0 || /[(,=:[!&|?{};]/.test(src[k])) {
        i++; let cls = false
        while (i < n && src[i] !== '\n') { const d = src[i]; if (d === '\\') { i += 2; continue } if (d === '[') cls = true; else if (d === ']') cls = false; else if (d === '/' && !cls) break; i++ }
        i++; continue
      }
    }
    i++
  }
  return out
}

const lineOf = (src: string, idx: number) => { const a = src.lastIndexOf('\n', idx - 1) + 1, b = src.indexOf('\n', idx); return src.slice(a, b < 0 ? undefined : b) }
const unesc = (s: string) => s.replace(/\\(['"`\\])/g, '$1').replace(/\\n/g, '\n')

const leaks: string[] = []
const used = new Map<string, string>()   // key → 首个出处
for (const f of walk(SRC)) {
  const src = readFileSync(f, 'utf8')
  const rel = relative(ROOT, f)
  if (src.includes('i18n-ignore-file')) continue
  for (const L of literals(src)) {
    if (!CJK.test(L.text) || !HAN.test(L.text)) continue
    const ln = lineOf(src, L.start)
    const before = src.slice(Math.max(0, L.start - 40), L.start)
    const wrapped = /\bt\(\s*$/.test(before) && !L.tpl
    if (wrapped) { const k = unesc(L.text); if (!used.has(k)) used.set(k, `${rel}:${L.line}`); continue }
    if (/i18n-ignore|console\.(log|warn|error|info|debug)|Error\(/.test(ln)) continue
    if (L.tpl && (GLSL.test(L.text) || /\/\* glsl \*\/\s*$/.test(before))) continue
    leaks.push(`${rel}:${L.line}  ${L.tpl ? '`' : "'"}${L.text.slice(0, 60)}`)
  }
}

// index.html：<body> 内带中文、却没有 data-i18n* 的行
const html = readFileSync(join(ROOT, 'index.html'), 'utf8')
const body = html.slice(html.indexOf('<body'))
body.split('\n').forEach((ln, k) => {
  const plain = ln.replace(/<!--.*?-->/g, '')
  if (HAN.test(plain) && !/data-i18n|i18n-ignore/.test(plain)) leaks.push(`index.html:${html.slice(0, html.indexOf('<body')).split('\n').length + k}  ${plain.trim().slice(0, 70)}`)
})

// 英文词典
const enDir = join(SRC, 'i18n', 'en')
const en = new Map<string, { v: string; f: string }>()
const conflicts: string[] = []
for (const f of readdirSync(enDir).filter((f) => f !== 'index.ts')) {
  const mod = (await import(join(enDir, f))) as { default: Record<string, string> }
  for (const [k, v] of Object.entries(mod.default)) {
    const prev = en.get(k)
    if (prev && prev.v !== v) conflicts.push(`${k}  →  ${prev.f}: "${prev.v}" / ${f}: "${v}"`)
    en.set(k, { v, f })
  }
}
const missing = [...used].filter(([k]) => !en.has(k))
const unused = [...en.keys()].filter((k) => !used.has(k))
const phBad = [...used.keys()].filter((k) => en.has(k)).filter((k) => {
  const ph = (s: string) => (s.match(/\{\w+\}/g) ?? []).sort().join()
  return ph(k) !== ph(en.get(k)!.v)
})

const sec = (title: string, xs: string[], max = process.argv.includes('--all') ? Infinity : 400) => { if (xs.length) console.log(`\n## ${title}（${xs.length}）\n` + xs.slice(0, max).join('\n') + (xs.length > max ? `\n… 还有 ${xs.length - max} 条` : '')) }
sec('未包 t() 的中文', leaks)
sec('en 缺 key', missing.map(([k, w]) => `${w}  ${k}`))
sec('占位符不一致', phBad)
sec('同 key 译文冲突', conflicts)
if (process.argv.includes('--unused')) sec('en 中未使用的 key', unused)
console.log(`\n漏网 ${leaks.length} · 缺 key ${missing.length} · 占位符不一致 ${phBad.length} · 冲突 ${conflicts.length} · 未使用 ${unused.length} · 已用 key ${used.size}`)
process.exit(leaks.length || missing.length || phBad.length || conflicts.length ? 1 : 0)
