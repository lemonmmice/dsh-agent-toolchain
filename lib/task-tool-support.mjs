import { join, resolve } from 'node:path'
import { homedir } from 'node:os'
import { realpathSync } from 'node:fs'
import { createTaskService } from './task-service.mjs'
import { TASK_TOOLS, TASK_PARAMETERS } from './task-tools.mjs'
import { dshParameters } from './tool-registry.mjs'
import { envOr } from './env-fallback.mjs'

let service, selectedDirectory
function tasks() {
  const directory = envOr('DSH_TASK_DIR') || join(homedir(), '.dsh-agent-toolchain', 'tasks')
  if (service && directory !== selectedDirectory) throw new Error('Task directory changed while the service is active; reconnect before changing it')
  if (!service) { service = createTaskService({ directory }); selectedDirectory = directory }
  return service
}
const canonical = value => {
  let path = resolve(value)
  try { path = realpathSync.native(path) } catch (error) { if (error.code !== 'ENOENT') throw error }
  return process.platform === 'win32' ? path.toLowerCase() : path
}
function taskResources(name, args) {
  if (name.startsWith('ui_')) return ['ui-desktop']
  if (name === 'build_run') return ['build:' + canonical(args.repoRoot || envOr('DSH_BUILD_CLIENT_ROOT') || process.cwd())]
  if (name === 'perf_dump') return ['dump:' + (envOr('DSH_UI_PROC_NAME') || 'default')]
  if (['perf_trace', 'perf_uifreeze'].includes(name)) return ['etw-kernel']
  if (args.dumpPath || args.etlPath) return ['analysis:' + canonical(args.dumpPath || args.etlPath)]
  if (name === 'memory_index') return ['memory-index:' + canonical(envOr('DSH_MEMORY_DIR') || join(homedir(), '.dsh', 'memory'))]
  if (name === 'hang_delete') return ['hang-evidence']
  return []
}
function outcome(value) {
  if (!Array.isArray(value?.content)) return value
  let payload
  try { payload = JSON.parse(value.content.find(block => block.type === 'text')?.text || 'null') } catch { payload = null }
  return { ...value, ok: value.isError !== true && payload?.ok !== false, unknown: payload?.unknown === true,
    incomplete: payload?.incomplete === true || payload?.stoppedBy === 'budget' || payload?.failedFiles?.length > 0, cancelled: payload?.cancelled === true }
}
export async function runTaskTool(name, args, execute, extra) {
  if (!TASK_TOOLS.has(name) || args?.asyncJob !== true) return execute(args, extra)
  const { asyncJob, requestKey, jobTimeoutMs, ...parameters } = args
  if (jobTimeoutMs !== undefined && (!Number.isSafeInteger(jobTimeoutMs) || jobTimeoutMs < 1 || jobTimeoutMs > 86400000)) throw new Error('jobTimeoutMs must be an integer between 1 and 86400000')
  if (requestKey !== undefined && (typeof requestKey !== 'string' || !requestKey || requestKey.length > 256)) throw new Error('requestKey must contain 1..256 characters')
  if (name === 'build_run' && parameters.background === true) throw new Error('asyncJob and build background cannot be combined')
  const sideEffects = !['perf_analyze', 'perf_heap', 'perf_gcroot', 'perf_hotstacks', 'perf_flame', 'perf_allocflame', 'perf_clrevents', 'ui_tree', 'hang_analyze'].includes(name)
  return { taskJob: true, ...await tasks().submit({ tool: name, runId: parameters.runId || '', requestKey,
    argsIdentity: JSON.stringify(parameters), resources: taskResources(name, parameters), sideEffects,
    timeoutMs: jobTimeoutMs, execute: async signal => outcome(await execute(parameters, { ...extra, signal })),
  }) }
}
export async function taskControl({ action = 'status', jobId } = {}) {
  if (!['status', 'result', 'cancel'].includes(action)) throw new Error('Unknown task control action')
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
