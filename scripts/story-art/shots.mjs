// 用无头 Chromium 驱动 どこでもロケハン 批量导出线稿 PNG
// node scripts/story-art/shots.mjs scripts/story-art/shots.json [id 过滤正则]；FORCE=1 覆盖已存在的图。说明见 docs/STORY-ART.md
import { chromium } from 'playwright'
import fs from 'node:fs'
const ROOT = new URL('../../public/assets/', import.meta.url).pathname
const shots = JSON.parse(fs.readFileSync(process.argv[2], 'utf8')).filter(s => !process.argv[3] || new RegExp(process.argv[3]).test(s.id))
const browser = await chromium.launch({ args: ['--use-gl=angle', '--enable-unsafe-swiftshader'] })
const ctx = await browser.newContext({ viewport: { width: 1600, height: 900 }, acceptDownloads: true, locale: 'zh-CN' })
const page = await ctx.newPage()
const sleep = (ms) => page.waitForTimeout(ms)
const camOpts = () => page.$$eval('#cams option', os => os.map(o => o.value + ':' + o.text))
let prevKey = ''
async function one(s) {
  const key = `${s.lat},${s.lng},${s.size ?? 300}`, same = key === prevKey; prevKey = key
  const t0 = Date.now()
  const before = (await camOpts().catch(() => [])).join('|')
  await page.goto('about:blank')
  await page.goto(`https://tools.oyasumi-gamedev.com/rokehan/#ll=${s.lat.toFixed(6)}%2C${s.lng.toFixed(6)}&s=${s.size ?? 300}&tod=${s.tod}&far=2`, { waitUntil: 'domcontentloaded', timeout: 90000 })
  await page.waitForSelector('#cams')
  // 等到镜头列表换成新地点（路口名变化）且「加载中」消失
  for (let i = 0; i < 90; i++) {
    await sleep(1000)
    const now = (await camOpts()).join('|')
    const busy = await page.evaluate(() => /加载中|読み込み中/.test(document.body.innerText.slice(0, 4000)))
    if ((same ? i >= 5 : now !== before) && /ix0|center/.test(now) && !busy) break
  }
  const opts = await camOpts()
  const cam = opts.some(o => o.startsWith(s.cam + ':')) ? s.cam : 'center'
  await page.selectOption('#tod', s.tod)
  await sleep(1500)
  await page.selectOption('#cams', cam)
  await sleep(s.settle ?? 7000)
  // 导出对话框：设长边，点「PNG（当前画面）」
  await page.getByRole('button', { name: /^⇪/ }).click()
  await sleep(500)
  const long = String(s.long ?? 2400)
  await page.evaluate((v) => { const sel = [...document.querySelectorAll('select')].find(x => [...x.options].some(o => o.value === v || o.text.startsWith(v))); if (sel) { const o = [...sel.options].find(o => o.value === v || o.text.startsWith(v)); sel.value = o.value; sel.dispatchEvent(new Event('change', { bubbles: true })) } }, long)
  const dl = page.waitForEvent('download', { timeout: 120000 })
  await page.getByRole('button', { name: /PNG（当前画面）/ }).click()
  const d = await dl
  await d.saveAs(ROOT + s.dest)
  await page.keyboard.press('Escape')
  const names = opts.filter(o => /^(ix0|center:)/.test(o)).map(o => o.split(':')[1]).join(' / ')
  console.log(`${s.id}\t${cam}\t${((Date.now() - t0) / 1000).toFixed(0)}s\t${names}`)
}
for (const s of shots) {
  if (fs.existsSync(ROOT + s.dest) && !process.env.FORCE) { console.log(`${s.id}\tskip（已存在）`); continue }
  for (let k = 1; k <= 3; k++) {
    try { await one(s); break } catch (e) { prevKey = ''; console.log(`${s.id}\t第 ${k} 次失败：${String(e.message).split('\n')[0]}`) }
  }
}
await browser.close()
