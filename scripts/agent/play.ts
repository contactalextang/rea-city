// AI 试玩员入口（Phase QA）：npm run agent:play -- --role=gang|gold|white|blue|all [--goal=story] [--url=…] [--headed] [--max=900]
// --start=<POI id>：调试用，开局传送到该 POI 门口（记一次辅助），跳过前面的长途步行。
// 需要先 npm run dev（默认 http://127.0.0.1:5173）。每个身份一个全新浏览器上下文（空存档），
// 预写建角色结果跳过建角色界面，?fx=off&chars=box&music=0&lang=zh 降低无头渲染负担。
// 输出 data/agent-runs/<时间>/<身份>/{report.md,result.json,*.png}；data/agent-runs/last-<身份>.json 供下次对比；
// data/agent-runs/procedural.json 是跨运行的程序性记忆。任一身份失败 → 退出码 1。
import fs from 'node:fs'
import path from 'node:path'
import { chromium } from 'playwright'
import { isRoleId, type RoleId } from '../../src/data/roles.ts'
import { runHarness, type RunResult } from './harness.ts'
import { writeReport } from './report.ts'

const arg = (k: string, d = '') => process.argv.find((a) => a.startsWith(`--${k}=`))?.split('=').slice(1).join('=') ?? (process.argv.includes(`--${k}`) ? 'true' : d)
const roleArg = arg('role', 'all')
const roles: RoleId[] = roleArg === 'all' ? ['gang', 'gold', 'white', 'blue'] : roleArg.split(',').filter(isRoleId)
if (!roles.length) { console.error(`未知身份：${roleArg}`); process.exit(2) }
const goal = arg('goal', 'story')
if (goal !== 'story') { console.error(`暂只支持 --goal=story（帝国线需要的买产业 / 升级等子任务尚未实现）`); process.exit(2) }
const base = arg('url', 'http://127.0.0.1:5173')
const maxSec = Number(arg('max', '900'))
const headed = arg('headed') === 'true'
const startPoi = arg('start')

const root = path.resolve('data/agent-runs')
const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
const runDir = path.join(root, stamp)
fs.mkdirSync(runDir, { recursive: true })

try { const r = await fetch(base); if (!r.ok) throw new Error(String(r.status)) } catch (e) {
  console.error(`连不上 ${base}（${(e as Error).message}）：先 npm run dev`); process.exit(2)
}

const browser = await chromium.launch({ headless: !headed, args: ['--use-gl=angle', '--enable-unsafe-swiftshader'] })
const results: RunResult[] = []
for (const role of roles) {
  const dir = path.join(runDir, role)
  fs.mkdirSync(dir, { recursive: true })
  const ctx = await browser.newContext({ viewport: { width: 640, height: 360 } })
  await ctx.addInitScript((r) => { try { localStorage.setItem('rea.character', JSON.stringify({ role: r, name: 'QA' })) } catch { /* 忽略 */ } }, role)
  const page = await ctx.newPage()
  const pageErrors: string[] = []
  page.on('pageerror', (e) => pageErrors.push(e.message))
  page.on('console', (m) => { if (m.type() === 'error') pageErrors.push(`console: ${m.text()}`) })
  await page.goto(`${base}/?role=${role}&fx=off&chars=box&music=0&lang=zh&story=0`)
  await page.waitForFunction(() => (window as unknown as { __game?: { ready: boolean } }).__game?.ready, null, { timeout: 90000 })
  await page.keyboard.press('Enter')
  await page.waitForFunction(() => (window as unknown as { __game: { state: string } }).__game.state === 'play', null, { timeout: 10000 })
  const preAssists: string[] = []
  if (startPoi) {
    const ok = await page.evaluate((id) => (window as unknown as { __game: { teleportTo(id: string): boolean } }).__game.teleportTo(id), startPoi)
    if (!ok) { console.error(`没有 POI：${startPoi}`); process.exit(2) }
    preAssists.push(`开局传送到 ${startPoi}（--start）`)
  }
  console.log(`\n===== ${role} · 开始 =====`)
  const r = await runHarness(page, { role, goal: 'story', outDir: dir, maxSec, procFile: path.join(root, 'procedural.json'), pageErrors, preAssists })
  const lastFile = path.join(root, `last-${role}.json`)
  let prev: RunResult | null = null
  try { prev = JSON.parse(fs.readFileSync(lastFile, 'utf8')) as RunResult } catch { /* 第一次 */ }
  writeReport(dir, r, prev)
  fs.writeFileSync(lastFile, JSON.stringify(r, null, 2))
  console.log(`===== ${role} · ${r.ok ? '通关' : '失败'} · ${r.secs.toFixed(0)}s · ${r.reason} · 报告 ${path.join(dir, 'report.md')}`)
  results.push(r)
  await ctx.close()
}
await browser.close()

console.log('\n汇总')
for (const r of results) console.log(`  ${r.role.padEnd(6)} ${r.ok ? '✓' : '✗'} ${r.secs.toFixed(0).padStart(5)}s  卡住 ${r.exec.stuck}  辅助 ${r.exec.assists.length}  报错 ${r.pageErrors.length}  ${r.ok ? '' : r.reason}`)
console.log(`报告目录：${runDir}`)
process.exit(results.every((r) => r.ok) ? 0 : 1)
