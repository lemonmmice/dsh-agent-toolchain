import { makeBuilder } from '../lib/builder.mjs'
const b = makeBuilder({})
const mode = process.argv[2] || 'block'
if (mode === 'block') {
  const r = await b.build({ target: 'Build' })
  console.log(JSON.stringify({ ok: r.ok, clientRunning: r.clientRunning, clientPid: r.clientPid, error: r.error }, null, 1))
} else if (mode === 'kill') {
  const r = await b.build({ target: 'Build', killClient: true })
  console.log(JSON.stringify({
    ok: r.ok, exitCode: r.exitCode, durationMs: r.durationMs,
    errorCount: r.errorCount, codeErrorCount: r.codeErrorCount, envErrorCount: r.envErrorCount,
    warningCount: r.warningCount, clientWasKilled: r.clientWasKilled,
    summaryLine: r.summaryLine, errors: (r.errors || []).slice(0, 5),
  }, null, 1))
}
