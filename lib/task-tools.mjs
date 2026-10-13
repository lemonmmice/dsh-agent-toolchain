export const TASK_TOOLS = new Set([
  'build_run', 'memory_index', 'ui_launch', 'ui_tree', 'ui_flow', 'ui_replay', 'ui_jev',
  'perf_probe', 'perf_dump', 'perf_analyze', 'perf_heap', 'perf_gcroot', 'perf_trace',
  'perf_hotstacks', 'perf_flame', 'perf_allocflame', 'perf_clrevents', 'perf_uifreeze', 'perf_clean',
  'hang_analyze', 'hang_delete',
])

export const TASK_PARAMETERS = [
  { name: 'asyncJob', type: 'boolean', zh: 'true 先返回 queued 任务；用 toolchain_job 查询结果或取消。默认保持原同步调用。', en: 'Accept a background task and return queued. Use toolchain_job for status/result/cancel. Default keeps the normal response.' },
  { name: 'requestKey', type: 'string', zh: 'asyncJob 的去重键；相同参数返回同一任务，不重复执行。参数变化时拒绝复用。', en: 'Optional deduplication key for asyncJob. The same key and arguments reuse the original task, including an unknown outcome.' },
  { name: 'jobTimeoutMs', type: 'integer', minimum: 1, maximum: 86400000, zh: '含排队的任务期限，默认 300000ms；超时不自动重放副作用，结果可能 unknown。', en: 'Whole task deadline including queueing, default 300000ms. Effects are never replayed after a timeout; completion can be unknown.' },
]
