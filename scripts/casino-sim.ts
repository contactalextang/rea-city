// 赌场赔率模拟（P10.B）：node scripts/casino-sim.ts [每项局数=100000]（npm run casino:sim）
// 直接调用 src/activities/casino/rules.ts 的纯函数规则引擎（与游戏 UI 同一份代码），每个游戏 / 下注方式跑 N 局，
// 打印 RTP、庄家优势、标准误与理论值，断言 |模拟 − 理论| < 4 个标准误，以及理论值落在规定区间。
// src 里的相对导入不带扩展名（vite 风格），这里先注册一个解析钩子补 .ts，再动态导入。
import { register } from 'node:module'

const hook = `
export async function resolve(spec, ctx, next) {
  if ((spec.startsWith('./') || spec.startsWith('../')) && !/\\.[cm]?[jt]s$/.test(spec)) {
    try { return await next(spec + '.ts', ctx) } catch {}
  }
  return next(spec, ctx)
}`
register('data:text/javascript,' + encodeURIComponent(hook), import.meta.url)

const { simulate, SIM_STRATEGIES } = await import('../src/activities/casino/sim.ts')
const { slotTheoryRtp } = await import('../src/activities/casino/rules.ts')
const { gameName } = await import('../src/data/casino.ts')

const N = Math.max(1000, Number(process.argv[2]) || 100_000)
/** 各游戏主注理论区间（任务验收口径） */
const BANDS: Record<string, [number, number]> = {
  'blackjack/basic': [0.994, 0.997],
  'roulette/red': [0.9729, 0.9731],
  'baccarat/banker': [0.9893, 0.9895],
  'baccarat/player': [0.9875, 0.9877],
  'sicbo/big': [0.9721, 0.9723],
  'slots/5lines': [0.935, 0.945],
}

const pct = (x: number, d = 2) => `${(x * 100).toFixed(d)}%`
let fail = 0
const t0 = Date.now()
console.log(`赌场赔率模拟：每项 ${N.toLocaleString()} 局（Math.random，非固定种子）\n`)
console.log('游戏                下注          模拟 RTP   理论 RTP   庄家优势   标准误    偏差/SE  结果')
for (const [game, strats] of Object.entries(SIM_STRATEGIES)) {
  for (const s of strats) {
    const r = simulate(game as never, N, s)
    const z = (r.rtp - r.theory) / r.se
    const band = BANDS[`${game}/${s}`]
    const inBand = !band || (r.theory >= band[0] && r.theory <= band[1])
    // 4σ 统计容差；21 点 mimic 的理论值是近似（≈94.5%），放宽到 ±1.5%
    const okSim = s === 'mimic' ? Math.abs(r.rtp - r.theory) < 0.015 : Math.abs(z) < 4
    const ok = okSim && inBand
    if (!ok) fail++
    console.log(`${game.padEnd(9)} ${gameName(game).padEnd(4, '　')}  ${s.padEnd(12)}  ${pct(r.rtp).padStart(8)}  ${pct(r.theory).padStart(8)}  ${pct(r.edge).padStart(8)}  ${pct(r.se, 3).padStart(7)}  ${z.toFixed(2).padStart(6)}   ${ok ? 'PASS' : 'FAIL'}${inBand ? '' : '（理论值越界）'}`)
  }
}
console.log(`\n老虎机精确 RTP（枚举 32³ 停位）：${pct(slotTheoryRtp(), 3)}`)
console.log(`用时 ${((Date.now() - t0) / 1000).toFixed(1)} s`)
if (fail) { console.error(`\n${fail} 项断言失败`); process.exit(1) }
console.log('\n全部断言通过')
