// 调试：只跑一个步行子任务，每秒打印位置 / 当前路点 / 相机朝向（node --import ./scripts/lib/ts-resolve.mjs --experimental-transform-types --no-warnings scripts/agent/debug-walk.ts gang hawker_smith_street_blk_335_chinatown_complex_market）
import { chromium } from 'playwright'
import { observe, listPois } from './observe.ts'
import { Executor } from './executor.ts'
import { dist } from './schemas.ts'

const [role = 'gang', poiId = ''] = process.argv.slice(2)
const b = await chromium.launch({ args: ['--use-gl=angle', '--enable-unsafe-swiftshader'] })
const ctx = await b.newContext({ viewport: { width: 640, height: 360 } })
await ctx.addInitScript((r) => localStorage.setItem('rea.character', JSON.stringify({ role: r, name: 'QA' })), role)
const page = await ctx.newPage()
await page.goto(`http://127.0.0.1:5173/?role=${role}&fx=off&chars=box&music=0&lang=zh&story=0`)
await page.waitForFunction(() => (window as any).__game?.ready, null, { timeout: 90000 })
await page.keyboard.press('Enter'); await page.waitForTimeout(800)
const poi = (await listPois(page)).find((p) => p.id === poiId)!
const ex = new Executor(page, (m) => console.log(m))
let o = await observe(page)
ex.begin(o)
const t0 = Date.now(); let last = 0
while (Date.now() - t0 < 90000) {
  o = await observe(page)
  if (dist(o, poi.door) < 2.2) { console.log('到达', ((Date.now() - t0) / 1000).toFixed(1)); break }
  await ex.tick({ kind: 'travel', to: poi.door, radius: 2.2, mode: 'walk' }, o)
  if (Date.now() - last > 1000) {
    last = Date.now()
    const r = (ex as any).route as { x: number; z: number }[]
    console.log(`${((Date.now() - t0) / 1000).toFixed(0)}s pos(${o.x.toFixed(1)},${o.z.toFixed(1)}) fps ${o.fps.toFixed(0)} cam ${o.camYaw.toFixed(2)} wp ${r[0] ? `(${r[0].x.toFixed(1)},${r[0].z.toFixed(1)})` : '-'} left ${r.length} keys ${[...(ex as any).held].join('+')} d=${dist(o, poi.door).toFixed(0)}`)
  }
  await page.waitForTimeout(60)
}
await page.screenshot({ path: 'data/agent-runs/debug-walk.png' })
await b.close()
