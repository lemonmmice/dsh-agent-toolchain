// dsh-ui-drive 单测：**没配目标进程时必须立即失败**（不许走"起脚本 → 等超时 → 再重试"那条路）。
//
// 病（2026-09-12 实测）：没配 DSH_UI_PROC_NAME 时 `ui_windows` / `ui_observe(state)` 不会立刻失败 ——
//   它照常起 PowerShell 脚本、等脚本抛错；而脚本的参数检查在**进程启动/加锁之后**，于是：
//     · 一条纯配置错误要等**步超时**（默认 90s）才回；
//     · 只读动作还会**重试一次**（READ_ONLY_ACTIONS）→ 实测 180s 内没返回；
//     · 批量路径单次超时上限是 10 分钟。
//   对 agent 来说这就是"ui 驱动卡住了"，和用户报的卡死/卡顿混在一起，最难排查。
//   修法：配置类错误**前置判定、立即返回**（unconfiguredResult），并给出可执行说明。
//
// 本测试刻意包含**时间断言**：这类缺陷只有时长能暴露 —— "能返回"不代表"能及时返回"。
import { makeDriver } from '../lib/driver.mjs'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

let failures = 0
function check(name, cond, extra = '') {
  if (cond) console.log('  ok   ' + name)
  else { failures++; console.log('  FAIL ' + name + (extra ? ' — ' + extra : '')) }
}

// 清掉进程环境里的目标进程配置（模拟"机器上没配"，且不让注册表回退救场）
const saved = { DSH_UI_PROC_NAME: process.env.DSH_UI_PROC_NAME, DSH_UI_CLIENT_EXE: process.env.DSH_UI_CLIENT_EXE }
delete process.env.DSH_UI_PROC_NAME
delete process.env.DSH_UI_CLIENT_EXE
process.env.DSH_NO_ENV_FALLBACK = '1'

const work = mkdtempSync(join(tmpdir(), 'uidrv-unconf-'))
try {
  const d = makeDriver({
    scriptsDir: join(import.meta.dirname, '..', 'scripts'),
    procName: '', windowName: '', clientExe: '',
    evidenceDir: work,
  })

  for (const action of ['windows', 'state', 'read']) {
    const t0 = Date.now()
    const r = await d.drive({ action })
    const ms = Date.now() - t0
    check(action + '：立即失败（< 3000ms，修复前 >90000ms 且只读会重试到 180s）', ms < 3000, ms + 'ms')
    check(action + '：标记为 unconfigured（不冒充"未运行/窗口找不到"）', r && r.unconfigured === true, JSON.stringify(r).slice(0, 140))
    check(action + '：点名要设哪个环境变量（G1 可执行性）', /DSH_UI_PROC_NAME/.test(String(r.error || '')), String(r && r.error).slice(0, 160))
    check(action + '：带上 configHint（区分"没配过"与"配了没继承"）', typeof r.configHint === 'string' && r.configHint.length > 10, String(r && r.configHint).slice(0, 120))
    check(action + '：不出现 undefined/NaN', !/undefined|NaN/.test(JSON.stringify(r) + String(r.error || '')), JSON.stringify(r).slice(0, 160))
  }

  // 批量路径同样要前置（它的单次超时上限是 10 分钟，更不该进）
  {
    const t0 = Date.now()
    const b = await d.batch({ steps: [{ action: 'click', name: '确定' }] })
    const ms = Date.now() - t0
    check('batch：同样立即失败且标 unconfigured', ms < 3000 && b && b.unconfigured === true && /DSH_UI_PROC_NAME/.test(String(b.configHint || '')), ms + 'ms ' + JSON.stringify(b).slice(0, 140))
  }

  // 反向：**配了**目标进程时不得被这条前置判定挡住（否则就是把功能关掉了）
  {
    const d2 = makeDriver({
      scriptsDir: join(import.meta.dirname, '..', 'scripts'),
      procName: 'definitely-not-running-xyz', windowName: '', clientExe: '',
      evidenceDir: work,
    })
    const t0 = Date.now()
    const r = await d2.drive({ action: 'windows' })
    const ms = Date.now() - t0
    check('配了目标进程（哪怕它没在跑）→ 不会被前置判定拦下（应报"进程未运行"一类，而不是 unconfigured）',
      r && r.unconfigured !== true, JSON.stringify(r).slice(0, 200))
    check('该情形下错误信息说的是"进程未运行"（不是"未配置"）', /未运行|未找到|不存在/.test(JSON.stringify(r)), JSON.stringify(r).slice(0, 200))
    console.log('  （附：这一条耗时 ' + ms + 'ms —— 它确实起了脚本，说明前置判定没有把正常路径也短路掉）')
  }
} finally {
  for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v }
  delete process.env.DSH_NO_ENV_FALLBACK
  try { rmSync(work, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 }) } catch { /* ignore */ }
}

console.log(failures === 0
  ? 'PASS: ui-drive 未配置目标进程时立即失败（含时间断言）+ 不误伤正常路径'
  : 'FAIL: ' + failures + ' check(s)')
process.exit(failures === 0 ? 0 : 1)
