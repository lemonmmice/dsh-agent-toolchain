import { join } from 'node:path'
import { homedir } from 'node:os'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { createTaskService } from './task-service.mjs'
import { TASK_TOOLS, TASK_PARAMETERS } from './task-tools.mjs'
import { dshParameters } from './tool-registry.mjs'
import { envOr } from './env-fallback.mjs'
import { resolveBuildRoot, canonicalPath } from './build-root.mjs'
import { classifyResult } from './result-completeness.mjs'
import { nativeCall, nativeEnabled, unwrapNativeResult } from './native-runtime.mjs'

let service, selectedDirectory
function tasks() {
  const directory = envOr('DSH_TASK_DIR') || join(homedir(), '.dsh-agent-toolchain', 'tasks')
  if (service && directory !== selectedDirectory) throw new Error('Task directory changed while the service is active; reconnect before changing it')
  if (!service) { service = createTaskService({ directory }); selectedDirectory = directory }
  return service
}
function taskResources(name, args) {
  if (name.startsWith('ui_')) return ['ui-desktop']
  // F06：构建锁键与 builder 用**同一套**根解析（resolveBuildRoot，含 args.clientRoot / DSH_BUILD_REPO_ROOT），
  //   否则 implicit/explicit 指向同一目录时会算出不同锁键、绕过互斥；都没配时退回 cwd 以仍能串行化同目录调用。
  if (name === 'build_run') return ['build:' + canonicalPath(resolveBuildRoot(args) || process.cwd())]
  if (name === 'perf_dump') return ['dump:' + (envOr('DSH_UI_PROC_NAME') || 'default')]
  if (['perf_trace', 'perf_uifreeze'].includes(name)) return ['etw-kernel']
  if (args.dumpPath || args.etlPath) return ['analysis:' + canonicalPath(args.dumpPath || args.etlPath)]
  if (name === 'memory_index') return ['memory-index:' + canonicalPath(envOr('DSH_MEMORY_DIR') || join(homedir(), '.dsh', 'memory'))]
  if (name === 'harness_trial') return ['harness:' + canonicalPath(envOr('DSH_HARNESS_DIR') || join(homedir(), '.dsh-agent-toolchain', 'harness'))]
  if (name === 'hang_delete') return ['hang-evidence']
  return []
}
// F04：把业务结果归一化到统一完整性口径（MCP content 封套 + 纯对象都判 ok/unknown/incomplete/cancelled）。
//   裁决与落盘用的是**未经输出预算截断**的原始结果（预算已上移到任务层之外，见 mcp/server.mjs）。
function outcome(value) {
  const flags = classifyResult(value)
  if (value && typeof value === 'object' && !Array.isArray(value)) return { ...value, ...flags }
  return value
}
export async function runTaskTool(name, args, execute, extra) {
  if (!TASK_TOOLS.has(name) || args?.asyncJob !== true) return execute(args, extra)
  if (nativeEnabled('task') && name !== 'harness_trial') return unwrapNativeResult(await nativeCall('dsh/task', { name, arguments: args }, { signal: extra?.signal }))
  const { asyncJob, requestKey, jobTimeoutMs, ...parameters } = args
  let harnessConfigFingerprint
  if (name === 'harness_trial' && typeof parameters.configPath === 'string') {
    const configPath = parameters.configPath
    if (!configPath || !requireAbsolute(configPath) || !existsSync(configPath) || !statSync(configPath).isFile()) throw new Error('harness_trial configPath must be an existing absolute file')
    const bytes = readFileSync(configPath)
    if (bytes.length > 4 * 1024 * 1024) throw new Error('harness_trial configPath exceeds 4 MiB')
    harnessConfigFingerprint = createHash('sha256').update(bytes).digest('hex')
  }
  if (jobTimeoutMs !== undefined && (!Number.isSafeInteger(jobTimeoutMs) || jobTimeoutMs < 1 || jobTimeoutMs > 86400000)) throw new Error('jobTimeoutMs must be an integer between 1 and 86400000')
  if (requestKey !== undefined && (typeof requestKey !== 'string' || !requestKey || requestKey.length > 256)) throw new Error('requestKey must contain 1..256 characters')
  if (name === 'build_run' && parameters.background === true) throw new Error('asyncJob and build background cannot be combined')
  const sideEffects = !['perf_analyze', 'perf_heap', 'perf_gcroot', 'perf_hotstacks', 'perf_flame', 'perf_allocflame', 'perf_clrevents', 'ui_tree', 'hang_analyze'].includes(name)
  const identityParameters = harnessConfigFingerprint ? { ...parameters, configFingerprint: harnessConfigFingerprint } : parameters
  return { taskJob: true, ...await tasks().submit({ tool: name, runId: parameters.runId || '', requestKey,
    argsIdentity: JSON.stringify(identityParameters), resources: taskResources(name, parameters), sideEffects,
    timeoutMs: jobTimeoutMs, execute: async signal => outcome(await execute(parameters, { ...extra, signal, harnessConfigFingerprint })),
  }) }
}

function requireAbsolute(value) {
  return /^[A-Za-z]:[\\/]/.test(value) || value.startsWith('\\\\') || value.startsWith('/')
}
export async function taskControl({ action = 'status', jobId } = {}) {
  if (!['status', 'result', 'cancel'].includes(action)) throw new Error('Unknown task control action')
  if (nativeEnabled('task')) return { taskJob: true, ...await nativeCall('dsh/task-control', { action, jobId }) }
  return { taskJob: true, ...await tasks()[action](jobId) }
}
export function renderTaskJob(_args, value = {}) {
  const id = typeof value?.jobId === 'string' ? value.jobId : '未知'
  const state = ['queued', 'running', 'cancelling', 'cancelled', 'done', 'failed', 'unknown'].includes(value?.state) ? value.state : 'unknown'
  const detail = state === 'done' ? '执行已结束，请查看结果产物。' : state === 'unknown' ? '执行结果未知；不要自动重试副作用。' : state === 'cancelled' ? '任务已取消；不能作为完成证据。' : '受理或取消请求不等于执行完成。'
  const artifact = typeof value?.result?.path === 'string' ? '\n结果：' + value.result.path : ''
  const error = typeof value?.error === 'string' ? '\n原因：' + value.error : ''
  return [{ type: 'text', text: `任务 ${id}：${state}。${detail}${artifact}${error}` }]
}
export function wrapTaskDefinition(definition) {
  if (!TASK_TOOLS.has(definition.name)) return definition
  const execute = definition.execute
  const render = definition.output?.render
  const shape = dshParameters(definition.name)
  const taskParameters = Object.fromEntries(TASK_PARAMETERS.map(parameter => [parameter.name, shape[parameter.name]]))
  return { ...definition, parameters: { ...definition.parameters, ...taskParameters }, execute: (args, extra) => runTaskTool(definition.name, args, execute, extra),
    output: definition.output ? { ...definition.output, render: (args, value) => value?.taskJob
      ? renderTaskJob(args, value)
      : render ? render(args, value) : [{ type: 'text', text: JSON.stringify(value) }] } : definition.output }
}
