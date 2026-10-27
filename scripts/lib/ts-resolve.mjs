// node 跑 src 代码用的解析钩子：src 里的相对导入不带扩展名（vite 风格），依次试 X.ts、X/index.ts。
// 用法：node --import ./scripts/lib/ts-resolve.mjs xxx.ts，或在脚本里先 await import('./lib/ts-resolve.mjs') 再动态导入 src。
import { register } from 'node:module'

const hook = `
export async function resolve(spec, ctx, next) {
  if ((spec.startsWith('./') || spec.startsWith('../')) && !/\\.[cm]?[jt]s$/.test(spec)) {
    for (const s of [spec + '.ts', spec + '/index.ts']) { try { return await next(s, ctx) } catch {} }
  }
  return next(spec, ctx)
}`
register('data:text/javascript,' + encodeURIComponent(hook), import.meta.url)
