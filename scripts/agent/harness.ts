// AI 试玩员 · harness：规划 → 执行 → 检测 → 恢复 的闭环（HiSTEVE 编排层的无训练版）
// - 规划：schemas.nextSubtask 按当前任务步骤 + 观测挑一个适用的原子子任务
// - 执行：Executor 每 ~60 ms 一个控制周期，原生键鼠
// - 检测：模板 done() 连续两次成立才算完成（先提议、再确认，避免一帧抖动误判）；failed() / 超预算 → failure / interrupted
// - 恢复：同一步骤累计失败 / 中断次数到上限 → 截图并判这步卡死；否则重规划（坐地铁失败过就改走路）
// - 记忆：working（最近观测）/ episodic（每个子任务结果）/ procedural（跨运行：各步骤类型成功的子任务序列、地铁成败）/ world（POI、卡住地点）
import fs from 'node:fs'
import path from 'node:path'
import type { Page } from 'playwright'
import { QUESTS, type StepDef } from '../../src/data/quests.ts'
import type { RoleId } from '../../src/data/roles.ts'
import { type Obs, type Subtask, type Outcome, type PlanCtx, type PoiInfo, schemaOf, nextSubtask, describe, travelBudget } from './schemas.ts'
import { observe, listPois } from './observe.ts'
import { Executor, type ExecStats } from './executor.ts'

export interface Episode { quest: string; step: number; stepKind: string; sub: string; outcome: Outcome; secs: number; reason?: string }
export interface StepRecord { quest: string; step: number; kind: string; label: string; secs: number; ok: boolean; recoveries: number }
export interface Procedural { steps: Record<string, string[]>; mrt: { ok: number; fail: number } }
export interface RunResult {
  role: RoleId; goal: string; ok: boolean; secs: number; reason: string
  steps: StepRecord[]; episodes: Episode[]; exec: ExecStats
  pageErrors: string[]; screenshots: string[]; stuckSpots: { x: number; z: number }[]
  final: Pick<Obs, 'money' | 'level' | 'hour' | 'day' | 'netWorth' | 'stars'>
}

export interface HarnessOpts { role: RoleId; goal: 'story'; outDir: string; maxSec: number; procFile: string; pageErrors: string[]; /** 开跑前已做的辅助（如 --start 传送），计入报告 */ preAssists?: string[] }

const MAX_RECOVER = 5
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

export function loadProcedural(file: string): Procedural {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) as Procedural } catch { return { steps: {}, mrt: { ok: 0, fail: 0 } } }
}

/** 本身份的目标任务：story = 新手引导链 ob_<role> */
export function goalQuests(role: RoleId, goal: 'story'): string[] {
  void goal
  return QUESTS.filter((q) => q.id === `ob_${role}`).map((q) => q.id)
}

export async function runHarness(page: Page, opts: HarnessOpts): Promise<RunResult> {
  const t0 = Date.now()
  const log = (m: string) => console.log(`[${opts.role} ${((Date.now() - t0) / 1000).toFixed(0).padStart(4)}s] ${m}`)
  const ex = new Executor(page, log)
  ex.stats.assists.push(...(opts.preAssists ?? []))
  const pois: PoiInfo[] = await listPois(page)
  const proc = loadProcedural(opts.procFile)
  const ctx: PlanCtx = { pois, role: opts.role, mrtMin: 900, avoidMrt: proc.mrt.fail >= 2 && proc.mrt.fail > proc.mrt.ok }
  const episodes: Episode[] = [], steps: StepRecord[] = [], screenshots: string[] = [], stuckSpots: { x: number; z: number }[] = []
  const goals = goalQuests(opts.role, opts.goal)
  let stepKey = '', stepStart = Date.now(), recover = 0, stepSubs: string[] = [], idleSince = 0
  /** 同一子任务连续「成功」却没推进步骤的次数（规划器原地打转检测） */
  let lastDesc = '', repeat = 0, repeatSince = 0, lastToast = ''
  let reason = '', ok = false
  let working: Obs = await observe(page)

  const shot = async (tag: string) => {
    const f = path.join(opts.outDir, `${String(screenshots.length + 1).padStart(2, '0')}-${tag}.png`)
    await page.screenshot({ path: f }).catch(() => {})
    screenshots.push(path.basename(f))
  }
  const closeStep = (o: Obs, done: boolean) => {
    if (!stepKey) return
    const [quest, s] = stepKey.split('#')
    const def = QUESTS.find((q) => q.id === quest)?.steps[Number(s)]
    steps.push({ quest, step: Number(s), kind: def?.kind ?? '?', label: working.quest.label, secs: (Date.now() - stepStart) / 1000, ok: done, recoveries: recover })
    if (done && def) proc.steps[def.kind] = stepSubs
    void o
  }

  // dev 服务器热更新会整页刷新（另一个人在改 src）：游戏重开，本次运行作废，干净地报告而不是崩溃
  let reloaded = false
  page.on('load', () => { reloaded = true })

  try {
    while (true) {
      const o = await observe(page)
      if (Date.now() - t0 > opts.maxSec * 1000) { reason = `超出总时限 ${opts.maxSec}s`; await shot('timeout'); break }
      if (goals.every((g) => o.quest.done.includes(g))) { closeStep(o, true); ok = true; reason = '目标任务全部完成'; break }
      // 结算遮罩 / 死亡 / 被捕：按键关掉或等它自己恢复
      if (o.state === 'won') { await ex.tap('KeyM'); await sleep(300); continue }
      if (o.state === 'dead' || o.state === 'busted') { log(`状态 ${o.state}，等待恢复`); await ex.release(); await sleep(1000); continue }

      const key = `${o.quest.id}#${o.quest.step}`
      if (key !== stepKey) {
        if (stepKey) { closeStep(o, true); log(`✔ 步骤完成：${working.quest.label}`) }
        stepKey = key; stepStart = Date.now(); recover = 0; stepSubs = []; lastDesc = ''; repeat = 0
        if (o.quest.id) log(`▶ 任务 ${o.quest.id} 第 ${o.quest.step + 1} 步：${o.quest.label}`)
      }
      working = o
      const def: StepDef | undefined = o.quest.id ? QUESTS.find((q) => q.id === o.quest.id)?.steps[o.quest.step] : undefined
      if (!def) { await sleep(500); if (!idleSince) idleSince = Date.now(); if (Date.now() - idleSince > 20000) { reason = '没有进行中的任务'; break } continue }
      idleSince = 0

      const sub = nextSubtask(def, o, ctx)
      if (o.state === 'panel' && sub?.kind !== 'interact' && sub?.kind !== 'mrt') {
        // 残留面板（当前子任务用不到）：Esc 关掉
        await ex.closePanel(); await sleep(200); continue
      }
      if (!sub) {
        await ex.release(); await sleep(500)
        if (Date.now() - stepStart > 120000) { reason = `步骤「${o.quest.label}」规划器无可用子任务`; await shot('noplan'); closeStep(o, false); break }
        continue
      }
      const sc = schemaOf(sub as never) as { applicable(o: Obs, s: Subtask): boolean; done(o: Obs, s: Subtask, st: Obs): boolean; failed(o: Obs, s: Subtask, st: Obs): string | null; budget(o: Obs, s: Subtask): number }
      if (!sc.applicable(o, sub)) { log(`子任务暂不适用：${describe(sub)}`); await sleep(400); recover++; if (recover > MAX_RECOVER * 4) { reason = `步骤「${o.quest.label}」卡在不适用的子任务：${describe(sub)}`; await shot('inapplicable'); closeStep(o, false); break } continue }

      // ---- 执行一个子任务 ----
      const desc = describe(sub)
      log(`  → ${desc}`)
      const start = o, ts = Date.now()
      let budget = sc.budget(o, sub), sized = false
      ex.begin(o)
      let outcome: Outcome = 'interrupted', why = '超出预算', confirm = 0
      while (true) {
        const cur = await observe(page)
        if (cur.toast && cur.toast !== lastToast) log(`  [提示] ${cur.toast}`)
        lastToast = cur.toast ?? ''
        if (sc.done(cur, sub, start)) { if (++confirm >= 2) { outcome = 'success'; why = ''; break } } else confirm = 0
        const f = sc.failed(cur, sub, start)
        if (f) { outcome = 'failure'; why = f; break }
        if ((Date.now() - ts) / 1000 > budget) break
        // 工作目标换了（乘客等不及走了、换了一位）：中断交回规划器重新规划，不算失败
        const jt = cur.job.target, st0 = start.job.target
        if (sub.kind === 'travel' && jt && st0 && Math.hypot(jt.x - st0.x, jt.z - st0.z) > 5) { outcome = 'success'; why = '工作目标已变'; break }
        // 任务步骤在执行途中变了（比如路过就触发了完成）：中断交回规划器
        if (cur.quest.step !== start.quest.step || cur.quest.id !== start.quest.id) { outcome = 'success'; why = '步骤已推进'; break }
        await ex.tick(sub, cur)
        // 预算按直线距离估；路线建好后按实际路线长度放宽（绕河 / 绕快速路时直线距离会严重低估）
        if (!sized && sub.kind === 'travel') {
          const len = ex.routeRemaining(cur.car ?? cur)
          if (len > 0) { sized = true; budget = Math.max(budget, travelBudget(len, sub.mode) + (Date.now() - ts) / 1000) }
        }
        await sleep(60)
      }
      await ex.release()
      if (sub.kind === 'waitNeeds') await ex.restoreSpeed()
      const secs = (Date.now() - ts) / 1000
      episodes.push({ quest: o.quest.id ?? '-', step: o.quest.step, stepKind: def.kind, sub: desc, outcome, secs, reason: why || undefined })
      log(`  ${outcome === 'success' ? '✓' : outcome === 'failure' ? '✗' : '⏸'} ${desc}（${secs.toFixed(1)}s${why ? ' · ' + why : ''}）`)
      if (sub.kind === 'interact' && outcome === 'success' && pois.find((p) => p.id === sub.poi)?.type === 'taxi') ctx.rentedDay = o.day
      if (sub.kind === 'mrt') { if (outcome === 'success') proc.mrt.ok++; else { proc.mrt.fail++; ctx.avoidMrt = true } }
      if (outcome === 'success') {
        stepSubs.push(sub.kind === 'travel' ? `travel:${sub.mode}` : sub.kind)
        if (desc !== lastDesc) repeatSince = Date.now()
        repeat = desc === lastDesc ? repeat + 1 : 0
        lastDesc = desc
        // 到达瞬间任务步骤往往要晚几百 ms 才推进：重复成功还得累计超过 8 s 才算打转
        if (repeat < 3 || Date.now() - repeatSince < 8000) { if (secs < 0.5) await sleep(300); continue }
        // 原地打转：同一子任务连成功 4 次步骤还没动 → 当失败处理；涉及地铁就本次运行改走路
        outcome = 'failure'; why = '原地打转'; repeat = 0
        if (sub.kind === 'mrt' || (sub.kind === 'travel' && sub.poi?.startsWith('mrt_'))) { ctx.avoidMrt = true; proc.mrt.fail++ }
        log(`  ✗ ${desc} 连续成功但步骤不推进，判原地打转`)
      }

      // ---- 恢复 ----
      recover++
      const here = await observe(page)
      if (sub.kind === 'travel') stuckSpots.push({ x: Math.round(here.x), z: Math.round(here.z) })
      if (recover >= MAX_RECOVER) {
        reason = `步骤「${o.quest.label}」连续 ${recover} 次未能完成（最后：${desc} · ${why}）`
        await shot('blocked'); closeStep(here, false); break
      }
      if (recover === 2) await shot(`recover-${o.quest.id}-${o.quest.step}`)
    }
  } catch (e) {
    // load 事件可能晚于报错：上下文被销毁 / __game 消失也视为整页刷新
    if (!reloaded && !/context was destroyed|reading 'player'|__game/.test(String((e as Error).message))) throw e
    reloaded = true
    ok = false; reason = `页面中途被重新加载（dev 服务器热更新？），本次运行作废：${(e as Error).message.split('\n')[0]}`
    log(reason)
  }

  await ex.release().catch(() => {})
  fs.writeFileSync(opts.procFile, JSON.stringify(proc, null, 2))
  const f = reloaded ? working : await observe(page)
  return {
    role: opts.role, goal: opts.goal, ok, secs: (Date.now() - t0) / 1000, reason,
    steps, episodes, exec: ex.stats, pageErrors: opts.pageErrors, screenshots, stuckSpots,
    final: { money: f.money, level: f.level, hour: f.hour, day: f.day, netWorth: f.netWorth, stars: f.stars },
  }
}
