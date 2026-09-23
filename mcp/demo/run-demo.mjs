/**
 * mcp/demo/run-demo.mjs — the whole loop, as one command.
 *
 * This is not demo-only code: it is a plain MCP client. It spawns
 * `mcp/server.mjs` over stdio and calls the same tools any MCP client
 * (Claude Code, Cursor, Cline, ...) would call — build → launch → drive → read
 * → adjudicate. If this script works, the MCP face works.
 *
 * Usage:
 *   node mcp/demo/run-demo.mjs                # build → drive → read → verify
 *   node mcp/demo/run-demo.mjs --with-perf    # + catch the deliberate UI freeze
 *   node mcp/demo/run-demo.mjs --keep-open    # leave the sample window open
 *
 * Everything it writes lands under .dsh-agent-toolchain/demo/ (gitignored), so a
 * demo run never pollutes the repo tree or the real failure corpus.
 */
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'

const here = dirname(fileURLToPath(import.meta.url))
const mcpDir = join(here, '..')
const root = join(mcpDir, '..')
const argv = process.argv.slice(2)
const withPerf = argv.includes('--with-perf')
const keepOpen = argv.includes('--keep-open')

const demoDir = join(root, '.dsh-agent-toolchain', 'demo')
const dirs = {
  uiEvidence: join(demoDir, 'ui-evidence'),
  buildLogs: join(demoDir, 'build-logs'),
  corpus: join(demoDir, 'failure-corpus'),
  verify: join(demoDir, 'verify-reports'),
}
for (const d of Object.values(dirs)) mkdirSync(d, { recursive: true })

const exePath = join(root, 'samples', 'DemoClient', 'bin', 'Release', 'net10.0-windows', 'DemoClient.exe')
const runId = 'demo'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const results = []
let transcript = ''
function log(line = '') {
  transcript += line + '\n'
  console.log(line)
}

/** Call a tool and record one inspectable step. `pass` decides ok/failed. */
async function step(label, name, args, pass) {
  const started = Date.now()
  let raw = ''
  let parsed = null
  let isError = false
  try {
    const res = await client.callTool({ name, arguments: args })
    isError = res.isError === true
    raw = (res.content ?? []).filter((c) => c.type === 'text').map((c) => c.text).join('\n')
    try {
      parsed = JSON.parse(raw)
    } catch {
      parsed = null
    }
  } catch (e) {
    raw = 'call failed: ' + (e && e.message ? e.message : String(e))
    isError = true
  }
  const ok = !isError && (pass ? pass(parsed, raw) : true)
  results.push({ label, tool: name, ok, ms: Date.now() - started })
  log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}  (${name}, ${Date.now() - started} ms)`)
  if (!ok) {
    const tail = raw.replace(/\s+/g, ' ').slice(0, 400)
    log('       ↳ ' + (tail || '(no text content)'))
  }
  return { ok, raw, parsed }
}

const env = {
  ...process.env,
  // Point every driver at the sample window — never at a real desktop client.
  DSH_UI_PROC_NAME: 'DemoClient',
  DSH_UI_WINDOW_NAME: 'Demo Client',
  DSH_UI_CLIENT_EXE: exePath,
  DSH_UI_EVIDENCE_DIR: dirs.uiEvidence,
  DSH_BUILD_REPO_ROOT: root,
  DSH_BUILD_CLIENT_ROOT: root,
  DSH_BUILD_LOGS_DIR: dirs.buildLogs,
  // A demo run must not scatter its artifacts across the real evidence dirs.
  DSH_PERF_EVIDENCE_DIR: join(demoDir, 'perf-evidence'),
  DSH_HANG_EVIDENCE_DIR: join(demoDir, 'hang-evidence'),
  // A demo is allowed to fail loudly; keep its records out of the real corpus.
  DSH_FAILURE_CORPUS_DIR: dirs.corpus,
  DSH_VERIFY_DIR: dirs.verify,
}

const client = new Client({ name: 'dsh-agent-toolchain-demo', version: '0.1.0' })
let exitCode = 0

try {
  log('dsh-agent-toolchain demo — one loop, driven over MCP stdio')
  log('  server : mcp/server.mjs')
  log('  target : samples/DemoClient (net10.0-windows WPF)')
  log('  output : ' + demoDir)
  log('')

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [join(mcpDir, 'server.mjs')],
    env,
    cwd: root,
    stderr: 'inherit',
  })
  await client.connect(transport)

  log('1. environment self-check')
  await step('toolchain_status reports what is configured', 'toolchain_status', { deep: false }, (p) => p !== null)

  log('')
  log('2. build the sample app (and bind the result to a runId)')
  await step(
    'build_run → 0 errors',
    'build_run',
    {
      target: 'Build',
      engine: 'dotnet',
      configuration: 'Release',
      project: 'samples/DemoClient/DemoClient.csproj',
      repoRoot: root,
      runId,
    },
    (p) => p !== null && p.errorCount === 0,
  )
  if (!existsSync(exePath)) throw new Error('build produced no exe at ' + exePath)

  log('')
  log('3. launch and look at the real window')
  await step('ui_launch brings the window up', 'ui_launch', { waitMs: 60000 }, (p) => p === null || p.ok !== false)
  const state = await step(
    'ui_observe(state) sees the controls',
    'ui_observe',
    { action: 'state', max: 40 },
    (p, raw) => /Greet/.test(raw) && /Input/.test(raw),
  )
  const snapshotId = state.parsed && typeof state.parsed.snapshotId === 'string' ? state.parsed.snapshotId : undefined

  log('')
  log('4. drive it — this is the part a code-reading agent cannot do')
  // Addressed by AutomationId, not by Name: a WPF TextBox has no UIA Name of its
  // own (only a labelled one would), while a Button's Name is its content.
  await step(
    'type into the Input box',
    'ui_drive',
    { action: 'setvalue', aid: 'Input', value: 'toolchain', allowSideEffects: true, ...(snapshotId ? { snapshotId } : {}) },
    (p) => p === null || p.ok !== false,
  )
  await step(
    'click Greet',
    'ui_drive',
    { action: 'click', aid: 'Greet', allowSideEffects: true, ...(snapshotId ? { snapshotId } : {}) },
    (p) => p === null || p.ok !== false,
  )
  await sleep(300)
  const read = await step(
    'read the result back out of the UI',
    'ui_observe',
    { action: 'read', match: 'Hello|Result|toolchain' },
    (_p, raw) => /Hello,\s*toolchain/i.test(raw),
  )
  const readBackOk = /Hello,\s*toolchain/i.test(read.raw)
  const shot = await step(
    'capture a screenshot as evidence',
    'ui_observe',
    { action: 'shot', label: 'after-greet' },
    (_p, raw) => /\.png/i.test(raw),
  )
  const shotPath = shot.parsed && typeof shot.parsed.path === 'string' ? shot.parsed.path : null

  if (withPerf) {
    log('')
    log('5. catch a real UI freeze (--with-perf)')
    // The probe has to be running while the UI actually blocks, so the click is
    // fired from here while the probe request is still in flight.
    const probe = client.callTool({
      name: 'perf_probe',
      arguments: { seconds: 8, thresholdMs: 300, intervalMs: 100 },
    })
    await sleep(1500)
    const freezeClick = client.callTool({
      name: 'ui_drive',
      arguments: { action: 'click', aid: 'Freeze', allowSideEffects: true },
    })
    await sleep(1500)
    await freezeClick
    const probeRes = await probe
    const probeText = (probeRes.content ?? []).filter((c) => c.type === 'text').map((c) => c.text).join('\n')
    log('       probe payload: ' + probeText.replace(/\s+/g, ' ').slice(0, 600))
    let probeJson = null
    try { probeJson = JSON.parse(probeText) } catch { probeJson = null }
    // Field naming is the probe's business, not this script's: accept any counter
    // that reports at least one over-threshold stall, and say which one was used.
    let stutters = null
    let field = ''
    for (const key of ['stutterCount', 'stutters', 'stutterEvents', 'hits', 'overThreshold', 'events']) {
      if (probeJson && typeof probeJson[key] === 'number') { stutters = probeJson[key]; field = key; break }
      if (probeJson && Array.isArray(probeJson[key])) { stutters = probeJson[key].length; field = key + '.length'; break }
    }
    const caught = stutters !== null && stutters > 0
    results.push({ label: 'perf_probe catches the 1500 ms freeze', tool: 'perf_probe', ok: caught })
    log(`  ${caught ? 'ok  ' : 'FAIL'} perf_probe catches the 1500 ms freeze (${field || 'no counter field found'}=${stutters})`)
  }

  log('')
  log(withPerf ? '6. adjudicate: claims vs evidence' : '5. adjudicate: claims vs evidence')
  const claims = [
    { statement: 'the sample app builds with 0 errors', kind: 'build', runId },
    {
      // Self-assessed on purpose: the UI read-back is the one claim no other
      // machine here can check, so it must say outright whether it held.
      statement: 'the driven UI shows "Hello, toolchain"',
      kind: 'manual',
      status: readBackOk ? 'pass' : 'fail',
      evidence: read.raw.replace(/\s+/g, ' ').slice(0, 300),
    },
  ]
  if (shotPath) claims.push({ statement: 'a screenshot was captured', kind: 'file', path: shotPath })
  const verdict = await step(
    'verify_report returns a verdict',
    'verify_report',
    { runId, task: 'demo: build → drive → read → adjudicate', claims },
    (p) => p !== null && typeof p.verdict === 'string',
  )
  const verdictValue = verdict.parsed ? verdict.parsed.verdict : 'unknown'
  log('')
  log('verdict: ' + verdictValue + (verdict.parsed && verdict.parsed.reportPath ? '  (' + verdict.parsed.reportPath + ')' : ''))

  const failed = results.filter((r) => !r.ok)
  log('')
  log(`steps: ${results.length - failed.length}/${results.length} ok`)
  exitCode = failed.length === 0 && verdictValue === 'pass' ? 0 : 1
} catch (e) {
  log('')
  log('demo aborted: ' + (e && e.message ? e.message : String(e)))
  exitCode = 1
} finally {
  try { await client.close() } catch { /* transport already gone */ }
  if (!keepOpen) spawnSync('taskkill', ['/IM', 'DemoClient.exe', '/F'], { stdio: 'ignore' })
}

process.exit(exitCode)
