import { makeDriver } from '../plugins/dsh-ui-drive/lib/driver.mjs'
import { envOr } from '../lib/env-fallback.mjs'

// 目标进程/窗口**不写死在脚本里**：makeDriver 会按 DSH_UI_PROC_NAME / DSH_UI_WINDOW_NAME 解析
// （进程环境优先，缺失时回退用户级注册表）。写死客户端标识会把 repo gate 的 sanity 检查打红
// —— 那条 gate 就是用来防止客户端身份进公开仓库的。
const driver = makeDriver({ evidenceDir: envOr('DSH_UI_EVIDENCE_DIR') })
try {
  const status = await driver.status()
  const state = await driver.drive({ action: 'state', procId: status.pid, winHandle: status.handle, max: 400, timeoutMs: 10000 })
  const windows = await driver.drive({ action: 'windows', procId: status.pid, timeoutMs: 10000 })
  const menus = state.controls?.filter(control => control.type === 'MenuItem') || []
  const probes = []
  for (const control of menus.filter(control => control.name.startsWith('指数'))) {
    for (const selector of [{ name: control.name }, { name: control.name.split(/\r?\n/)[0] }, { match: '^指数(?:\\r?\\n|$)' }]) {
      const result = await driver.drive({ action: 'find', ...selector, index: 0, procId: status.pid, winHandle: status.handle, timeoutMs: 10000 })
      probes.push({ selector, ok: result.ok, found: result.found, count: result.count, error: result.error })
    }
  }
  console.log(JSON.stringify({ status: { pid: status.pid, handle: status.handle }, windows: windows.lines, menus, probes }, null, 2))
} finally {
  await driver.warmShutdown()
  driver.releaseLock()
}
