import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, readFileSync, rmSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname, basename } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { analyzeCpuBreakdown, normalizeCpuBreakdown, renderCpuBreakdown } from '../plugins/dsh-perf/lib/cpu-breakdown.mjs'
import { REGISTRY, dshParameters } from '../lib/tool-registry.mjs'
import { mcpShape } from '../mcp/registry-zod.mjs'
import { TASK_TOOLS } from '../lib/task-tools.mjs'

const temporary = mkdtempSync(join(tmpdir(), 'dsh-cpu-check-'))
try {
  const etlPath = join(temporary, 'input.etlx')
  const executable = join(temporary, 'analyzer.exe')
  writeFileSync(etlPath, 'fixture')
  writeFileSync(executable, '')
  const parameters = { etlPath, pid: 42, tid: 9, startMs: 10, endMs: 30 }
  const config = { executable, evidenceDir: temporary }
  const normalized = normalizeCpuBreakdown(parameters)
  assert.equal(normalized.groups.length, 6)
  assert.deepEqual(normalizeCpuBreakdown({ ...parameters, groupsJson: '[]' }).groups, [])
  for (const invalid of [{ pid: 0 }, { tid: -1 }, { startMs: NaN }, { endMs: 10 }, { top: 51 }, { binMs: 0 }, { groupsJson: '{}' }, { groupsJson: '[' }, { groupsJson: '[{"name":"bad","patterns":[""]}]' }, { groupsJson: '[{"name":"same","patterns":["a"]},{"name":"SAME","patterns":["b"]}]' }]) {
    assert.throws(() => normalizeCpuBreakdown({ ...parameters, ...invalid }))
  }
  const createReport = (request, overrides = {}) => ({
    version: 1, ok: true, scope: { pid: request.pid, tid: request.tid, startMs: request.startMs, endMs: request.endMs },
    sampleCount: 4, missingStackSamples: 1,
    groups: [{ name: 'Views', samples: 3, percent: 75, sampleSpanMs: 10, exampleStack: ['View..ctor'] }], topFrames: [],
    timeline: [{ startMs: 10, samples: 4 }], ...overrides,
  })
  const fakeRunner = async (program, args, timeout) => {
    assert.equal(program, executable)
    assert.equal(args[0], '/cpu')
    assert.equal(timeout, 300000)
    const request = JSON.parse(readFileSync(args[1], 'utf8'))
    writeFileSync(args[2], JSON.stringify(createReport(request)))
    return { code: 0, stderr: '', timedOut: false }
  }
  const first = await analyzeCpuBreakdown(parameters, config, fakeRunner)
  const second = await analyzeCpuBreakdown(parameters, config, fakeRunner)
  assert.equal(first.ok, true)
  assert.notEqual(first.reportPath, second.reportPath)
  assert.equal(first.timeline, undefined)
  assert.equal(first.timelineBins, 1)
  assert.equal(first.groups[0].exampleStack, undefined)
  assert.equal(first.groups[0].exampleAvailable, true)
  assert.match(renderCpuBreakdown(first), /不能相加/)
  assert.match(renderCpuBreakdown(first), /不是耗时/)
  const failed = await analyzeCpuBreakdown(parameters, config, async (program, args) => {
    writeFileSync(args[2], JSON.stringify(createReport(normalized)))
    return { code: 1, stderr: 'failed', timedOut: false }
  })
  assert.equal(failed.code, 'ANALYSIS_FAILED')
  assert.equal(failed.reportPath, undefined)
  const timeout = await analyzeCpuBreakdown(parameters, config, async () => ({ code: null, timedOut: true, stderr: '' }))
  assert.equal(timeout.code, 'ANALYSIS_TIMEOUT')
  const wrongScope = await analyzeCpuBreakdown(parameters, config, async (program, args) => {
    writeFileSync(args[2], JSON.stringify(createReport(normalized, { scope: { pid: 1, tid: 9 } })))
    return { code: 0, stderr: '' }
  })
  assert.equal(wrongScope.code, 'INVALID_REPORT')
  const changed = await analyzeCpuBreakdown(parameters, config, async (program, args, deadline) => {
    const result = await fakeRunner(program, args, deadline)
    writeFileSync(etlPath, 'changed fixture input')
    return result
  })
  assert.equal(changed.code, 'TRACE_CHANGED')
  const absent = await analyzeCpuBreakdown({ ...parameters, etlPath: join(temporary, 'missing.etlx') }, config, fakeRunner)
  assert.equal(absent.code, 'TRACE_NOT_FOUND')
  assert.equal((await analyzeCpuBreakdown(parameters, { ...config, executable: '' }, fakeRunner)).code, 'ANALYZER_NOT_FOUND')
  assert.deepEqual(Object.keys(mcpShape('perf_breakdown')).sort(), REGISTRY.perf_breakdown.params.map(parameter => parameter.name).sort())
  assert.deepEqual(Object.keys(dshParameters('perf_breakdown')).sort(), Object.keys(mcpShape('perf_breakdown')).sort())
  assert(TASK_TOOLS.has('perf_breakdown'))
  console.log('CPU breakdown wrapper, schema and failure checks passed')
} finally {
  assert.equal(dirname(realpathSync(temporary)), realpathSync(tmpdir()))
  assert(basename(temporary).startsWith('dsh-cpu-check-'))
  rmSync(temporary, { recursive: true, force: true })
}
const project = fileURLToPath(new URL('../bench/perf-breakdown/CpuBreakdownChecks.csproj', import.meta.url))
const result = spawnSync('dotnet', ['run', '--project', project, '-c', 'Release'], { stdio: 'inherit', windowsHide: true })
if (result.error) throw result.error
if (result.status !== 0) process.exit(result.status ?? 1)
