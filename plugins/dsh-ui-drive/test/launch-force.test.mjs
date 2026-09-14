// dsh-ui-drive ui_launch(force=true) 单测 —— 「卡死 → 重启」这条**合法流程**必须有出口
//
// 背景（Codex 第九轮证伪，成立）：我一版把"进程在跑但没窗口"一律拒绝 spawn（防重复实例），
// 但那样**卡死之后就无法重启** —— ui_launch 既不杀也不给 force，用户只能手工去关。
// 而"客户端卡死 → 重启 → 复现 → 取证"正是本工具链存在的意义。
// 现在开一条**显式**通道：只有 force=true 才动进程；杀谁/等多久/还剩谁，全部如实回报；
// 同名多实例且没配 exe 路径时**拒绝**（不误杀别人的会话）。
//
// 用**假客户端**跑（把 ping.exe 复制成 dshtestclient2.exe，用 -t 让它常驻），绝不碰真实客户端。
//
// 稳健性（在**并发**跑全套时抓到过真问题，都改了）：
//   · `taskkill` 是**异步**的 → 起新实例前必须**等到确认清空**，不能用固定 sleep
//     （实测：前一个 case 残留的 2 个 + 新起的 2 个 = 4 个，断言直接红）；
//   · 进程出现/消失一律用 **waitFor 轮询**，不用 `sleep(1000)` 赌机器不忙；
//   · 断言基于**本测试自己起的 PID**（增量），不受别的测试/别的会话的同名进程干扰；
//   · 退出钩子 + best-effort 删目录（清理失败不该推翻结论）。
import { makeDriver } from '../lib/driver.mjs'
import { launchText } from '../lib/render.mjs'
import { mkdtempSync, mkdirSync, copyFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { execFileSync, spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'

let failures = 0
function check(name, cond, extra = '') {
  if (cond) console.log('  ok   ' + name)
  else { failures++; console.log('  FAIL ' + name + (extra ? ' — ' + extra : '')) }
}

/**
 * 受害者进程名**每次运行都不同**。
 *
 * F-031（2026-09-12，r30）：固定名字（原来是 `dshtestclient2`）会让**两个同时跑的测试**互相看见对方的进程 ——
 * 实测：我跑整套的同时，复审者直接跑了同一个测试文件，于是「C 前置：两个同名实例在跑」变成 **4 个**、
 * 「起点干净」变成不干净。`run-tests.mjs` 的并发锁只挡得住"两套 runner"，**挡不住别人直接跑单个测试文件**。
 *
 * ⚠ 措辞按 @codex r32 的复核意见收严：这是**概率隔离，不是唯一性保证**。
 *   用 `crypto.randomUUID()`（**不是 `Math.random`**），取 10 位十六进制 = 40 bit ≈ 1.1e12 种；
 *   两运行相撞 ≈ 9e-13，10,000 次并发按生日近似 ≈ 4.5e-5。
 *   证据目录另由 `mkdtempSync` 隔离 —— 那是**另一层**，不要混为一谈。
 */
const EXE = 'dshtestlf' + randomUUID().replace(/-/g, '').slice(0, 10)
const work = mkdtempSync(join(tmpdir(), 'launch-force-'))
const dirA = join(work, 'a')
const dirB = join(work, 'b')
mkdirSync(dirA, { recursive: true })
mkdirSync(dirB, { recursive: true })
const exeA = join(dirA, EXE + '.exe')
const exeB = join(dirB, EXE + '.exe')
for (const p of [exeA, exeB]) copyFileSync(join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'ping.exe'), p)

process.env.DSH_UI_KILL_WAIT_MS = '8000'
const evidenceDir = mkdtempSync(join(tmpdir(), 'launch-force-evidence-'))

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/**
 * 同名实例列表。
 *
 * ⚠ F-029（2026-09-12，r29 整套并发跑时抓到）：旧写法把 `execFileSync` 的**任何失败**都
 * `catch { return [] }` —— 于是"tasklist 这次没读出来"被呈现成"**没有同名进程**"。
 * 实测后果：测试 B 的前置断言报 `[]`（而同一次运行稍后又看到 **2 个**残留实例），
 * 整条用例随机变红。**这正是本仓反复修的第 1 类缺陷「没读到 ≠ 没有」，只不过这次在测试辅助函数里。**
 * 现在：失败**重试 3 次**；仍失败就**抛错**（明确说"无法判定"），绝不静默返回空列表。
 */
function pidsOfOnce() {
  const out = execFileSync('tasklist', ['/FI', 'IMAGENAME eq ' + EXE + '.exe', '/FO', 'CSV', '/NH'], { encoding: 'utf8', windowsHide: true })
  return [...out.matchAll(new RegExp('"' + EXE + '\\.exe","(\\d+)"', 'g'))].map((m) => Number(m[1]))
}
function pidsOf() {
  let lastErr = null
  for (let i = 0; i < 3; i++) {
    try { return pidsOfOnce() } catch (e) { lastErr = e }
  }
  throw new Error('tasklist 连续 3 次失败，**无法判定**同名实例数：' + String(lastErr && lastErr.message)
    + '（不把"没读到"当成"没有"—— 见 F-029）')
}
function killAll() {
  for (const pid of pidsOf()) { try { spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true }) } catch { /* ignore */ } }
}
/** 轮询等待条件成立；超时返回 null（绝不靠固定 sleep 赌时序）。 */
async function waitFor(fn, timeout = 25000, interval = 200) {
  const t0 = Date.now()
  for (;;) {
    const v = fn()
    if (v) return v
    if (Date.now() - t0 > timeout) return null
    await sleep(interval)
  }
}
/** 杀掉全部并在**确认清空**之后返回（taskkill 是异步的 —— 这是本测试第一版翻车的根因）。 */
async function killAllAndWait() {
  killAll()
  const ok = await waitFor(() => pidsOf().length === 0, 20000)
  if (!ok) killAll()
  return ok
}
/** 起一个假客户端并等到它真的在进程表里出现，返回它的 PID。 */
async function startFakeAndWait(exe) {
  const p = spawn(exe, ['-t', '127.0.0.1'], { detached: true, stdio: 'ignore', windowsHide: true })
  p.unref()
  const seen = await waitFor(() => pidsOf().includes(p.pid), 20000, 150)
  if (!seen) console.log('  （waitFor 超时：新进程 ' + p.pid + ' 未在 20s 内出现；当前同名进程=' + JSON.stringify(pidsOf()) + '）')
  return seen ? p.pid : -1
}
function alive(pid) { return pidsOf().includes(pid) }

const cleanup = () => { killAll() }
process.on('exit', cleanup)
process.on('uncaughtException', (e) => { cleanup(); console.error(e); process.exit(1) })
process.on('unhandledRejection', (e) => { cleanup(); console.error(e); process.exit(1) })

const mkDriver = (exe) => makeDriver({
  scriptsDir: join(import.meta.dirname, '..', 'scripts'),
  procName: EXE,
  windowName: 'no-such-window-title',
  clientExe: exe,
  evidenceDir,
})

try {
  await killAllAndWait()
  check('起点干净（没有同名残留进程）', pidsOf().length === 0, JSON.stringify(pidsOf()))

  // ---------------------------------------------- A. force=false + 无窗口 → 不 spawn 第二个
  {
    const d = mkDriver(exeA)
    const firstPid = await startFakeAndWait(exeA)
    check('假客户端已启动', firstPid > 0, String(firstPid))
    const r = await d.launch({ waitMs: 1200 })
    check('A 无窗口时不重复拉起（ok:false + partial + alreadyRunning）', r.ok === false && r.partial === true && r.alreadyRunning === true, JSON.stringify(r).slice(0, 240))
    check('A 实例数仍是 1（没有第二个实例）', pidsOf().length === 1, JSON.stringify(pidsOf()))
    check('A 仍指向原来那个 PID', pidsOf()[0] === firstPid, JSON.stringify({ firstPid, now: pidsOf() }))
    check('A hint 指向 force 作为"重启"的唯一出口', /force=true/.test(String(r.hint)) && /卡死/.test(String(r.hint)), String(r.hint).slice(0, 240))
    d.warmShutdown()
  }

  // ---------------------------------------------- B. force=true + 单实例 → 真的重启
  {
    const d = mkDriver(exeA)
    const before = pidsOf()
    check('B 前置：有一个实例在跑', before.length === 1, JSON.stringify(before))
    const r = await d.launch({ waitMs: 1500, force: true, extraArgs: '-t 127.0.0.1' })
    // ⚠ `JSON.stringify(undefined)` 返回 **undefined**（不是字符串）⇒ `.slice` 直接 TypeError，
    //   于是"前置没满足"被渲染成一个**看不出原因的崩溃**（真机实测：整条用例只留下一行 TypeError）。
    check('B forceKill 如实回报：killed + pids + waitedMs', !!r.forceKill && r.forceKill.killed === true && (r.forceKill.pids || []).length === 1 && Number(r.forceKill.waitedMs) >= 0, JSON.stringify(r.forceKill ?? null).slice(0, 240))
    check('B 杀掉的就是原来那个 PID', (r.forceKill.pids || [])[0] === before[0], JSON.stringify({ killed: r.forceKill.pids, before }))
    check('B 重试次数如实回报（retries 是显式字段，不是隐性行为）', typeof r.forceKill.retries === 'number' && r.forceKill.retries >= 0, JSON.stringify({ retries: r.forceKill.retries }))
    check('B 旧进程确实没了', !alive(before[0]), JSON.stringify(pidsOf()))
    const back = await waitFor(() => { const n = pidsOf(); return n.length === 1 && n[0] !== before[0] ? n : null }, 25000, 200)
    check('B 新进程起来了（重启完成，仍是 1 个实例）', !!back, JSON.stringify({ now: pidsOf(), before }))
    check('B 渲染文本里印出"重启"与"结束了谁"', /重启/.test(launchText(r)) && String(launchText(r)).includes(String(before[0])), launchText(r).slice(0, 200))
    d.warmShutdown()
  }

  // ---------------------------------------------- C. 多实例 + 未配 exe 路径 → 拒绝（不误杀）
  {
    check('C 前置清理完成', await killAllAndWait(), JSON.stringify(pidsOf()))
    const p1 = await startFakeAndWait(exeA)
    const p2 = await startFakeAndWait(exeB)
    check('C 前置：两个同名实例在跑', pidsOf().length === 2 && p1 > 0 && p2 > 0, JSON.stringify({ p1, p2, now: pidsOf() }))
    const d = mkDriver('') // 不配 clientExe = 无法判别
    const r = await d.launch({ waitMs: 800, force: true })
    check('C 拒绝执行（refused + ambiguous）', r.ok === false && r.forceKill && r.forceKill.refused === true && r.forceKill.scope === 'ambiguous', JSON.stringify(r).slice(0, 280))
    check('C 一个都没杀（红线：不误杀别人的会话）', alive(p1) && alive(p2) && pidsOf().length === 2, JSON.stringify({ p1, p2, now: pidsOf() }))
    check('C 错误里给了可执行的下一步（配 DSH_UI_CLIENT_EXE）', /DSH_UI_CLIENT_EXE/.test(String(r.error)), String(r.error).slice(0, 240))
    d.warmShutdown()
  }

  // ---------------------------------------------- D. 配了 exe 路径 → 只动匹配的那个
  {
    check('D 前置清理完成', await killAllAndWait(), JSON.stringify(pidsOf()))
    const pA = await startFakeAndWait(exeA)
    const pB = await startFakeAndWait(exeB)
    check('D 前置：两个实例就位', alive(pA) && alive(pB), JSON.stringify({ pA, pB, now: pidsOf() }))
    const d = mkDriver(exeB) // 指向 b
    const r = await d.launch({ waitMs: 1200, force: true, extraArgs: '-t 127.0.0.1' })
    const killed = (r.forceKill && r.forceKill.pids) || []
    check('D 配了 exe 路径 → scope=exe-path 且杀成功了', !!r.forceKill && r.forceKill.killed === true && r.forceKill.scope === 'exe-path', JSON.stringify(r.forceKill).slice(0, 240))
    check('D 精确命中 b（只杀了它）', killed.length === 1 && killed[0] === pB, JSON.stringify({ killed, pA, pB }))
    check('D 另一个会话的同名实例还活着（没误杀）', alive(pA) && !alive(pB), JSON.stringify({ pA, pB, now: pidsOf() }))
    d.warmShutdown()
  }
} finally {
  await killAllAndWait()
  await sleep(300)
  try { rmSync(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 }) } catch { /* best effort */ }
  try { rmSync(evidenceDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 }) } catch { /* best effort */ }
  console.log('  （清理后残留实例：' + pidsOf().length + '）')
}

console.log(failures === 0 ? '\nPASS: ui_launch(force=true) —— 卡死重启通道 + 不误杀' : '\nFAIL: ' + failures + ' check(s)')
process.exitCode = failures === 0 ? 0 : 1
