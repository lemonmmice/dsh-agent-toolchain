#!/usr/bin/env node
/**
 * e0a0cd5→19b9734 复核清单 F01–F06 的**定向回归包**。
 *
 * 为什么单独做：全量 run-tests 含 ui-drive 等会**在并发负载下偶发假红**的环境敏感用例（它们 spawn
 * driver 子进程、计时敏感，run-tests.mjs 自己也为此加了并发锁）。本脚本只**顺序**跑 F01–F06 直接相关的
 * 纯计算用例，给出一个**确定性**的机器裁定（exit 0 = 全过，非 0 = 哪个挂了），适合喂给 verify_report 的 gate。
 * 单命令 `node scripts/verify-f01-f06.mjs` —— 不依赖 POSIX shell（gate 宿主是 cmd.exe，跑不了 for/&& 脚本）。
 */
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { join, dirname } from 'node:path'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const tests = [
  // F01 编译集缓存失效
  'lib/compile-membership-invalidate.test.mjs',
  'lib/compile-membership-cache.test.mjs',
  // F02 解压总预算
  'plugins/dsh-api-visualizer/test/capture-decode-total-budget.test.mjs',
  'plugins/dsh-api-visualizer/test/capture-decode-bound.test.mjs',
  // F03 failure 稳定排序快照 + 游标
  'lib/failure-corpus-order.test.mjs',
  'lib/failure-corpus-cursor.test.mjs',
  'lib/failure-corpus-incremental.test.mjs',
  // F04 任务完整性归一化 + 输出预算
  'lib/task-completeness.test.mjs',
  'lib/output-budget.test.mjs',
  'lib/output-budget-shared.test.mjs',
  'lib/task-service.test.mjs',
  'lib/task-tool-support.test.mjs',
  // F05 采样取消收尾（trace-parse 不入列：它依赖 Windows timeout.exe，属环境敏感，不是 F05 的定向回归）
  'plugins/dsh-perf/test/trace-cancel-cleanup.test.mjs',
  // F06 构建根解析一致 + 互斥
  'lib/build-root-mutex.test.mjs',
]

const env = { ...process.env, DSH_TEST: '1', DSH_NO_ENV_FALLBACK: '1' }
let failed = 0
for (const t of tests) {
  const r = spawnSync(process.execPath, [join(root, t)], { env, encoding: 'utf8' })
  const ok = r.status === 0
  if (!ok) failed++
  console.log((ok ? 'ok   ' : 'FAIL ') + t + (ok ? '' : ' (exit ' + r.status + ')'))
  if (!ok) { process.stdout.write(((r.stdout || '') + (r.stderr || '')).split('\n').slice(-6).join('\n') + '\n') }
}
console.log('\n' + (failed === 0 ? 'VERIFY-F01-F06 PASS: ' + tests.length + ' 个定向回归用例全部通过' : 'VERIFY-F01-F06 FAIL: ' + failed + '/' + tests.length + ' 个用例未通过'))
process.exit(failed === 0 ? 0 : 1)
