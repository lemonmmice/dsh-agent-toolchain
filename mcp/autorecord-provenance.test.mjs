// 自动失败记录的端到端回归（真 MCP 往返，失败库指向临时目录）：node mcp/autorecord-provenance.test.mjs
//
// 钉住 2026-10 真库复盘查到的根因：plugins/dsh-ui-drive/test/mcp-snapshot-gate.test.mjs 每跑一次，
// 就经 MCP 往真库写 3 条 tool-error —— 两条"未知 snapshotId 拒绝" + 一条"未配置目标进程"。
// 真库 811 条 tool-error 里约 94% 是这三种（248 组「3 条 / 2 秒」的突发）。这里原样重放那三个调用，
// 断言它们**一条都不进**失败库；再断言真故障照记、重复发生被折叠、来源字段齐全。
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { createServer } from 'node:net'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'

const scratch = mkdtempSync(join(tmpdir(), 'dsh-autorecord-'))
const corpusDir = join(scratch, 'failure')
const client = new Client({ name: 'autorecord-test', version: '9.9.9' })
const json = (r) => JSON.parse(r.content[0].text)
const turnMeta = { 'x-codex-turn-metadata': { session_id: 'sess-1', thread_id: 'thr-1', turn_id: 'turn-1' } }

/** 一个**确定**拒绝连接的本机端口：先监听拿到端口，再关掉。 */
async function closedPort() {
  const srv = createServer()
  await new Promise((done) => srv.listen(0, '127.0.0.1', done))
  const { port } = srv.address()
  await new Promise((done) => srv.close(done))
  return port
}

try {
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('DSH_')))
  await client.connect(new StdioClientTransport({
    command: process.execPath,
    args: [join(dirname(fileURLToPath(import.meta.url)), 'server.mjs')],
    env: { ...env, DSH_NO_ENV_FALLBACK: '1', DSH_TEST: '1', DSH_FAILURE_CORPUS_DIR: corpusDir, DSH_VERIFY_DIR: join(scratch, 'verify'), DSH_MEMORY_DIR: join(scratch, 'memory') },
    stderr: 'pipe',
  }))

  // ---- ① 原样重放 mcp-snapshot-gate 那三个调用：闸门拒绝 / 未配置，都不是工具失灵
  const bogus = 'not-a-real-snapshot'
  const a = await client.callTool({ name: 'ui_drive', arguments: { action: 'click', name: 'x', allowSideEffects: true, snapshotId: bogus } })
  const b = await client.callTool({ name: 'ui_act', arguments: { action: 'click', name: 'x', allowSideEffects: true, snapshotId: bogus } })
  const f = await client.callTool({ name: 'ui_drive', arguments: { action: 'find', name: 'x' } })
  for (const [label, r] of [['ui_drive click', a], ['ui_act click', b], ['ui_drive find', f]]) {
    assert.equal(json(r).ok, false, label + ' 应当被拒绝/失败（前提）')
  }
  let stats = json(await client.callTool({ name: 'failure_stats', arguments: {} }))
  assert.equal(stats.total, 0, '闸门拒绝与"未配置"不得写进失败库（这正是真库 94% 噪声的来源）')
  console.log('  ok   重放 snapshot-gate 三连：失败库 0 条')

  // ---- ② 真故障照记；同一种失败第二次折叠成 recurrence；来源字段齐全（含 Codex 回合 id）
  const port = await closedPort()
  for (let i = 0; i < 2; i++) {
    const r = await client.callTool({ name: 'http_request', arguments: { url: `http://127.0.0.1:${port}/x`, timeoutMs: 5000 }, _meta: turnMeta })
    assert.equal(json(r).ok, false, 'http_request 打关闭的端口应当失败（前提）')
  }
  stats = json(await client.callTool({ name: 'failure_stats', arguments: {} }))
  assert.equal(stats.total, 1, '同一种真故障只记一条全量记录')
  assert.equal(stats.recurrences, 1, '第二次发生折叠成 1 次 recurrence（计数不丢）')
  const rows = json(await client.callTool({ name: 'failure_query', arguments: { tag: 'http_request' } })).rows
  assert.equal(rows.length, 1)
  const rec = rows[0]
  assert.equal(rec.recurrences, 1, 'query 上挂着 recurrences')
  assert.match(rec.fingerprint, /^[0-9a-f]{16}$/)
  assert.equal(rec.producer.runtime, 'mcp')
  assert.equal(rec.producer.client.name, 'autorecord-test', 'producer 带 MCP clientInfo')
  assert.equal(rec.producer.client.version, '9.9.9')
  assert.equal(rec.producer.test, true, 'DSH_TEST=1 的记录自带 test 标记')
  assert.deepEqual(rec.producer.agentTurn, { host: 'codex', sessionId: 'sess-1', threadId: 'thr-1', turnId: 'turn-1' }, 'producer 带 Codex 回合 id（来自 _meta）')
  assert.equal(typeof rec.producer.toolchain.version, 'string')
  console.log('  ok   真故障：1 条全量 + 1 次 recurrence，producer 齐全')

  // ---- ③ verify_report：报告与它自动记的 agent-misjudge 都带 producer
  const v = json(await client.callTool({
    name: 'verify_report',
    arguments: { runId: 'autorecord-1', task: 'provenance check', claims: [{ statement: 'gate passes', kind: 'gate', cmd: 'node -e "process.exit(3)"' }] },
    _meta: turnMeta,
  }))
  assert.equal(v.verdict, 'fail', '退出码 3 的 gate 判 fail（前提）')
  const report = JSON.parse(readFileSync(v.reportPath, 'utf8'))
  assert.equal(report.producer?.agentTurn?.turnId, 'turn-1', '报告里记着是哪个宿主回合裁决的')
  const misjudge = json(await client.callTool({ name: 'failure_query', arguments: { failureClass: 'agent-misjudge' } })).rows
  assert.equal(misjudge.length, 1)
  assert.equal(misjudge[0].producer?.client?.name, 'autorecord-test', 'agent-misjudge 带 producer（裁决器有缺陷时可按版本批量撤回）')
  console.log('  ok   verify_report：报告与 agent-misjudge 都带 producer')

  console.log('\nPASS: auto-record provenance + refusal filter + dedupe (MCP round trip)')
} catch (e) {
  console.log('FAIL ' + (e && e.stack || e))
  process.exitCode = 1
} finally {
  await client.close().catch(() => {})
  rmSync(scratch, { recursive: true, force: true })
}
