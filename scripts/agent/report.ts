// AI 试玩员 · 报告：每个身份一份 report.md + result.json，并和上一次同身份运行对比（回退提示）
import fs from 'node:fs'
import path from 'node:path'
import type { RunResult } from './harness.ts'

const f1 = (n: number) => n.toFixed(1)

export function compare(cur: RunResult, prev: RunResult | null): string[] {
  if (!prev) return ['（没有上次运行可比）']
  const out: string[] = []
  if (prev.ok && !cur.ok) out.push(`⚠ 回退：上次通关，这次失败（${cur.reason}）`)
  if (!prev.ok && cur.ok) out.push('✓ 修复：上次失败，这次通关')
  if (cur.ok && prev.ok) {
    const d = cur.secs - prev.secs
    out.push(`总耗时 ${f1(cur.secs)}s（上次 ${f1(prev.secs)}s，${d >= 0 ? '+' : ''}${f1(d)}s）`)
    if (cur.secs > prev.secs * 1.5 && d > 30) out.push('⚠ 耗时明显变长')
  }
  const pe = cur.pageErrors.length - prev.pageErrors.length
  if (pe > 0) out.push(`⚠ 页面报错多了 ${pe} 条`)
  if (cur.exec.stuck > prev.exec.stuck + 2) out.push(`⚠ 卡住次数 ${prev.exec.stuck} → ${cur.exec.stuck}`)
  if (cur.exec.assists.length > prev.exec.assists.length) out.push(`⚠ 辅助次数 ${prev.exec.assists.length} → ${cur.exec.assists.length}`)
  return out
}

export function writeReport(dir: string, r: RunResult, prev: RunResult | null): string {
  const L: string[] = []
  L.push(`# AI 试玩员报告 · ${r.role} · ${r.goal}`, '')
  L.push(`- 结果：**${r.ok ? '通关' : '失败'}** · ${r.reason}`)
  L.push(`- 总耗时 ${f1(r.secs)} s · 按键 ${r.exec.keyPresses} · 点击 ${r.exec.clicks} · 卡住 ${r.exec.stuck} 次 · 辅助 ${r.exec.assists.length} 次`)
  L.push(`- 结束时：第 ${r.final.day} 天 ${f1(r.final.hour)} 时 · 现金 $${r.final.money.toFixed(0)} · Lv${r.final.level} · 净资产 $${r.final.netWorth.toFixed(0)} · 通缉 ${r.final.stars}`)
  L.push(`- 页面报错 ${r.pageErrors.length} 条`, '')
  L.push('## 与上次对比', '', ...compare(r, prev).map((s) => `- ${s}`), '')
  L.push('## 步骤', '', '| 任务 | 步 | 类型 | 说明 | 耗时 s | 恢复 | 结果 |', '|---|---|---|---|---|---|---|')
  for (const s of r.steps) L.push(`| ${s.quest} | ${s.step + 1} | ${s.kind} | ${s.label} | ${f1(s.secs)} | ${s.recoveries} | ${s.ok ? '✓' : '✗'} |`)
  L.push('', '## 子任务（episodic 记忆）', '', '| 步骤 | 子任务 | 结果 | 耗时 s | 原因 |', '|---|---|---|---|---|')
  for (const e of r.episodes) L.push(`| ${e.quest}#${e.step + 1} ${e.stepKind} | ${e.sub} | ${e.outcome} | ${f1(e.secs)} | ${e.reason ?? ''} |`)
  if (r.exec.assists.length) L.push('', '## 辅助（非原生输入）', '', ...r.exec.assists.map((a) => `- ${a}`))
  if (r.stuckSpots.length) L.push('', '## 卡住 / 中断地点', '', ...r.stuckSpots.map((p) => `- (${p.x}, ${p.z})`))
  if (r.pageErrors.length) L.push('', '## 页面报错', '', ...r.pageErrors.slice(0, 30).map((e) => '- `' + e.replace(/`/g, "'").slice(0, 300) + '`'))
  if (r.screenshots.length) L.push('', '## 截图', '', ...r.screenshots.map((s) => `- ![${s}](${s})`))
  const md = L.join('\n') + '\n'
  fs.writeFileSync(path.join(dir, 'report.md'), md)
  fs.writeFileSync(path.join(dir, 'result.json'), JSON.stringify(r, null, 2))
  return md
}
