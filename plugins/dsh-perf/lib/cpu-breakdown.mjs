import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'

export const DEFAULT_CPU_GROUPS = [
  { name: 'XAML', patterns: ['WpfXamlLoader', 'Baml2006Reader'] },
  { name: 'WPF layout', patterns: ['ContextLayoutManager.UpdateLayout', 'FrameworkElement.MeasureCore', 'FrameworkElement.ArrangeCore'] },
  { name: 'SVG', patterns: ['SharpVectors'] },
  { name: 'GIF', patterns: ['WpfAnimatedGif', 'GifBitmapDecoder'] },
  { name: 'Charts', patterns: ['SciChart'] },
  { name: 'JIT', patterns: ['clrjit!', 'coreclrjit!'] },
]

export function normalizeCpuBreakdown(args) {
  if (typeof args.etlPath !== 'string' || !isAbsolute(args.etlPath) || !/\.(etlx|etl|etl\.zip)$/i.test(args.etlPath)) {
    throw new Error('etlPath must be an absolute .etlx, .etl or .etl.zip path')
  }
  const integer = (value, name, minimum, maximum) => {
    if (!Number.isSafeInteger(value) || value < minimum || value > maximum) throw new Error(`${name} must be an integer in ${minimum}..${maximum}`)
    return value
  }
  const pid = integer(args.pid, 'pid', 1, 2147483647)
  const tid = args.tid === undefined ? null : integer(args.tid, 'tid', 1, 2147483647)
  const startMs = args.startMs ?? 0
  const endMs = args.endMs ?? null
  if (!Number.isFinite(startMs) || startMs < 0 || (endMs !== null && (!Number.isFinite(endMs) || endMs <= startMs))) {
    throw new Error('Require finite 0 <= startMs < endMs; omit endMs for the rest of the trace')
  }
  const top = integer(args.top ?? 15, 'top', 1, 50)
  const binMs = integer(args.binMs ?? 100, 'binMs', 1, 60000)
  let groups = DEFAULT_CPU_GROUPS
  if (args.groupsJson !== undefined) {
    if (typeof args.groupsJson !== 'string' || args.groupsJson.length > 65536) throw new Error('groupsJson must be a JSON string of at most 65536 characters')
    try { groups = JSON.parse(args.groupsJson) } catch { throw new Error('groupsJson is not valid JSON') }
  }
  if (!Array.isArray(groups) || groups.length > 32) throw new Error('groupsJson must be an array of at most 32 groups')
  const names = new Set()
  groups = groups.map(group => {
    if (!group || typeof group.name !== 'string' || !group.name.trim() || group.name.length > 80) throw new Error('Each group needs a name of 1..80 characters')
    const name = group.name.trim()
    if (names.has(name.toLowerCase())) throw new Error('Group names must be unique')
    names.add(name.toLowerCase())
    if (!Array.isArray(group.patterns) || group.patterns.length < 1 || group.patterns.length > 16 || group.patterns.some(pattern => typeof pattern !== 'string' || !pattern.trim() || pattern.length > 256)) {
      throw new Error('Each group needs 1..16 nonempty literal substring patterns, at most 256 characters each')
    }
    return { name, patterns: [...new Set(group.patterns.map(pattern => pattern.trim()))] }
  })
  return { etlPath: resolve(args.etlPath), pid, tid, startMs, endMs, top, binMs, groups }
}

export async function analyzeCpuBreakdown(args, config, runExecutable) {
  let request
  try { request = normalizeCpuBreakdown(args) } catch (error) { return { ok: false, code: 'INVALID_ARGUMENT', error: error.message } }
  if (!existsSync(request.etlPath) || !statSync(request.etlPath).isFile()) return { ok: false, code: 'TRACE_NOT_FOUND', error: 'Trace file does not exist' }
  const inputIdentity = statSync(request.etlPath)
  if (!config.executable || !existsSync(config.executable)) return { ok: false, code: 'ANALYZER_NOT_FOUND', error: 'Build the analyzer with npm run build:perf-analysis, or configure DSH_PERF_UIFREEZE' }
  const directory = join(config.evidenceDir, 'cpu-breakdown', randomUUID())
  mkdirSync(directory, { recursive: true })
  const requestPath = join(directory, 'request.json')
  const reportPath = join(directory, 'report.json')
  const logPath = join(directory, 'analysis.log')
  writeFileSync(requestPath, JSON.stringify(request), 'utf8')
  const result = await runExecutable(config.executable, ['/cpu', requestPath, reportPath], 300000)
  writeFileSync(logPath, result.stderr || '', 'utf8')
  if (result.timedOut || result.code !== 0) return {
    ok: false, code: result.timedOut ? 'ANALYSIS_TIMEOUT' : 'ANALYSIS_FAILED',
    error: result.timedOut ? 'CPU analysis timed out; partial output is not evidence' : 'CPU analysis failed; verify the analyzer supports /cpu (npm run build:perf-analysis)',
    exitCode: result.code, logPath,
  }
  if (!existsSync(request.etlPath)) return { ok: false, code: 'TRACE_CHANGED', error: 'Trace disappeared during analysis', logPath }
  const after = statSync(request.etlPath)
  if (after.size !== inputIdentity.size || after.mtimeMs !== inputIdentity.mtimeMs || after.ino !== inputIdentity.ino) {
    return { ok: false, code: 'TRACE_CHANGED', error: 'Trace changed during analysis; results are not evidence', logPath }
  }
  let report
  try {
    if (statSync(reportPath).size > 4 * 1024 * 1024) throw new Error('Report exceeds 4 MiB')
    report = JSON.parse(readFileSync(reportPath, 'utf8'))
    if (report.version !== 1 || typeof report.ok !== 'boolean' || report.scope?.pid !== request.pid || report.scope?.tid !== request.tid
      || report.scope?.startMs !== request.startMs || !Number.isFinite(report.scope?.endMs) || report.scope.endMs <= request.startMs
      || (request.endMs !== null && report.scope.endMs > request.endMs)
      || !Number.isSafeInteger(report.sampleCount) || report.sampleCount < 0 || !Array.isArray(report.groups) || !Array.isArray(report.topFrames)) throw new Error('Invalid analyzer report')
  } catch (error) { return { ok: false, code: 'INVALID_REPORT', error: error.message, logPath } }
  const { timeline, groups, ...summary } = report
  const groupSummaries = groups.map(({ exampleStack, ...group }) => ({ ...group, exampleAvailable: !!exampleStack?.length }))
  return { ...summary, groups: groupSummaries, timelineBins: timeline?.length ?? 0, reportPath, logPath }
}

export function renderCpuBreakdown(value) {
  if (!value?.ok) return `CPU分析未完成：${value?.error || value?.code || '未知结果'}${value?.logPath ? '\n日志：' + value.logPath : ''}`
  const lines = [
    `CPU采样细分：PID ${value.scope.pid} / ${value.scope.tid === null ? '所有线程' : 'TID ' + value.scope.tid}`,
    `时间窗 ${value.scope.startMs}..${value.scope.endMs}ms；样本 ${value.sampleCount}，缺失调用栈 ${value.missingStackSamples}`,
    ...value.groups.map(group => `${group.name}: ${group.samples} 样本 (${group.percent}%)，首末样本跨度 ${group.sampleSpanMs ?? '--'}ms`),
    '分组是包含子调用的重叠统计，不能相加；样本数不是耗时，首末跨度不是执行时长，也不证明屏幕首帧。',
    `完整分桶时间线与调用栈示例：${value.reportPath}`,
  ]
  return lines.join('\n')
}
