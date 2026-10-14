// F04 回归：任务完整性归一化 + 落盘未截断 + 输出预算保留完整性标志。
//   覆盖审查要求的四类：小预算 / 部分成功 / unknown / cancelled，MCP content 封套与纯对象两条分支都测。
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import assert from 'node:assert/strict'
import { classifyResult, classifyPayload } from './result-completeness.mjs'
import { attachBudget } from './output-budget.mjs'

const taskDir = mkdtempSync(join(tmpdir(), 'tc-'))
process.env.DSH_TASK_DIR = join(taskDir, 'tasks')
process.env.DSH_NO_ENV_FALLBACK = '1'
const { runTaskTool, taskControl } = await import('./task-tool-support.mjs')

let failures = 0
const check = (name, cond, extra = '') => { if (cond) console.log('  ok   ' + name); else { failures++; console.log('  FAIL ' + name + (extra ? ' — ' + extra : '')) } }
const wait = (ms) => new Promise((r) => setTimeout(r, ms))
const mcp = (obj) => ({ content: [{ type: 'text', text: JSON.stringify(obj) }] })
async function runJob(payload) {
  const a = await runTaskTool('memory_index', { asyncJob: true, path: taskDir }, async () => payload, {})
  for (let i = 0; i < 400; i++) {
    const s = await taskControl({ jobId: a.jobId })
    if (['done', 'failed', 'cancelled', 'unknown'].includes(s.state)) return s
    await wait(5)
  }
  throw new Error('task wait expired')
}

try {
  // ---- A. 统一完整性口径（纯对象 / MCP 封套都判）----
  check('纯对象 stoppedBy=budget + remainingFiles>0 ⇒ incomplete', classifyPayload({ indexed: 1, stoppedBy: 'budget', remainingFiles: 5 }).incomplete === true)
  check('纯对象 failedFiles 非空 ⇒ incomplete', classifyPayload({ ok: true, failedFiles: [{ file: 'A.cs' }] }).incomplete === true)
  check('纯对象 deferred=true ⇒ incomplete', classifyPayload({ deferred: true }).incomplete === true)
  check('纯对象 stoppedBy=done、无剩余 ⇒ complete（"进程正常结束" ≠ "没做完"）', classifyPayload({ ok: true, stoppedBy: 'done' }).incomplete === false)
  check('纯对象 unknown=true ⇒ unknown', classifyPayload({ unknown: true }).unknown === true)
  check('纯对象 cancelled=true ⇒ cancelled', classifyPayload({ cancelled: true }).cancelled === true)
  const mcpFlags = classifyResult(mcp({ ok: true, incomplete: true, stoppedBy: 'budget', failedFiles: [{ file: 'A.cs' }] }))
  check('MCP 封套 incomplete 透过第一段 text JSON 判出', mcpFlags.incomplete === true && mcpFlags.ok === true)
  check('MCP isError=true ⇒ ok:false', classifyResult({ isError: true, content: [{ type: 'text', text: '{"ok":true}' }] }).ok === false)

  // ---- B. 任务路径：部分成功落盘要是**未截断**的原文，裁决为 incomplete（不是 complete）----
  const partialMcp = await runJob(mcp({ ok: true, incomplete: true, stoppedBy: 'budget', indexed: 1, failedFiles: [{ file: 'A.cs', error: 'x' }] }))
  check('部分成功(MCP)：state=done', partialMcp.state === 'done', partialMcp.state)
  check('★ 部分成功(MCP)：completeness=incomplete（不是 complete）', partialMcp.completeness === 'incomplete', partialMcp.completeness)
  const artifact = JSON.parse(readFileSync(partialMcp.result.path, 'utf8'))
  const persisted = JSON.parse(artifact.content[0].text)
  check('★ 落盘结果是未截断原文（仍带 incomplete/stoppedBy/failedFiles）', persisted.incomplete === true && persisted.stoppedBy === 'budget' && persisted.failedFiles.length === 1, JSON.stringify(persisted).slice(0, 120))

  // ---- B2. DSH 纯对象分支：stoppedBy/remainingFiles 也要判出 incomplete（原先直接返回、当成 complete）----
  const partialPlain = await runJob({ indexed: 1, stoppedBy: 'budget', remainingFiles: 5, failedFiles: [] })
  check('★ 部分成功(纯对象)：completeness=incomplete', partialPlain.completeness === 'incomplete', partialPlain.completeness)

  // ---- B3. unknown / cancelled / complete 三态 ----
  check('unknown ⇒ state=unknown', (await runJob({ unknown: true })).state === 'unknown')
  check('cancelled ⇒ state=cancelled', (await runJob({ cancelled: true })).state === 'cancelled')
  const done = await runJob({ ok: true, indexed: 3, stoppedBy: 'done' })
  check('全部完成 ⇒ state=done + completeness=complete', done.state === 'done' && done.completeness === 'complete', done.state + '/' + done.completeness)

  // ---- C. 输出预算（展示层）：截断**不得**把未完成抹成完成 —— incomplete/stoppedBy 要保留，ok/complete 仍最小化 ----
  const big = 'x'.repeat(6000)
  const partialJson = JSON.stringify({ ok: true, incomplete: true, stoppedBy: 'budget', remainingFiles: 7, complete: true, blob: big })
  const budgeted = attachBudget({ content: [{ type: 'text', text: partialJson }] }, { maxTokens: 120 })
  const env = JSON.parse(budgeted.content[0].text)
  check('截断封套保留 incomplete=true', env.incomplete === true, JSON.stringify(env).slice(0, 160))
  check('截断封套保留 stoppedBy', env.stoppedBy === 'budget')
  check('截断封套保留 remainingFiles', env.remainingFiles === 7)
  check('截断封套仍不塞 ok/complete（最小机器集契约）', !Object.hasOwn(env, 'ok') && !Object.hasOwn(env, 'complete'))
  const completeJson = JSON.stringify({ ok: true, indexed: 9, blob: big })
  const env2 = JSON.parse(attachBudget({ content: [{ type: 'text', text: completeJson }] }, { maxTokens: 120 }).content[0].text)
  check('完整结果被截断时不会被硬塞 incomplete', !Object.hasOwn(env2, 'incomplete'))
} finally {
  rmSync(taskDir, { recursive: true, force: true })
}

if (failures) { console.log('\nFAILED: ' + failures + ' 项'); process.exit(1) }
console.log('PASS: task completeness (unified classify, untruncated persistence/verdict, budget preserves incomplete)')
