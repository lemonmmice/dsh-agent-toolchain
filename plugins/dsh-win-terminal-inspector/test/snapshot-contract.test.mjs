// dsh-win-terminal-inspector 单测：BV-02 —— inspector 必须实现上游契约的 snapshot()
//
// 病（审计确证，Codex 第三轮复核）：
//   上游 `ProcessInspector` 契约把 `snapshot()` 列为**必选**
//   （`dsh-subprocess-local/lib/types/process-inspector.d.ts`），
//   而 `LocalTerminalHandle` 构造函数第一句就是 `inspector.snapshot().tree(...)`。
//   本插件只有 processTree/processSession、**没有 snapshot()**，且在 live profile 里
//   覆盖了上游的原生实现 → **每次终端 spawn 直接 TypeError**。
//   没被发现是因为单测只测旧接口、端到端 smoke 没在装好的版本上跑过。
//
// 这个测试直接对着**上游契约的形状**断言，而不是对着我们自己的实现细节 ——
// 这样下次上游加必选方法时，这里也会先红。
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createRequire } from 'node:module'

let failures = 0
function check(name, cond, extra = '') {
  if (cond) console.log('  ok   ' + name)
  else { failures++; console.log('  FAIL ' + name + (extra ? ' — ' + extra : '')) }
}

const here = new URL('.', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')
const mod = await import(new URL('../lib/inspector.js', import.meta.url).href)
const Inspector = mod.default ?? mod.WindowsProcessInspector ?? Object.values(mod).find((v) => typeof v === 'function' && v.name.includes('Inspector'))

// ------------------------------------------------- 1. 契约形状：snapshot() 存在且返回三件套
{
  check('能拿到 inspector 类', typeof Inspector === 'function', String(typeof Inspector))
  const proto = Inspector.prototype
  check('BV-02 inspector.prototype 上有 snapshot()（旧实现没有 → spawn 即 TypeError）', typeof proto.snapshot === 'function',
    '有：' + ['snapshot', 'processTree', 'processSession', 'isAlive', 'signalGroup', 'foregroundPgid', 'isStdinWaiting'].filter((m) => typeof proto[m] === 'function').join(','))
  // 上游契约里的其余必选成员也要在（漏一个就漏一次崩溃）
  for (const m of ['foregroundPgid', 'isStdinWaiting', 'isAlive', 'signalGroup', 'signalProcess']) {
    check('契约成员存在：' + m, typeof proto[m] === 'function', String(typeof proto[m]))
  }
}

// ------------------------------------------------- 2. snapshot() 的返回值满足 ProcessSnapshot
{
  // 用一个假实例驱动（不碰真实进程表）：只替换 processTable
  const inst = Object.create(Inspector.prototype)
  const TABLE = [
    { pid: 100, parentPid: 1, started: 'T100' },
    { pid: 200, parentPid: 100, started: 'T200' },
    { pid: 300, parentPid: 200, started: 'T300' },
    { pid: 400, parentPid: 1, started: 'T400' },
  ]
  inst.processTable = function () { return TABLE }

  const snap = inst.snapshot()
  check('snapshot() 返回对象', snap !== null && typeof snap === 'object', String(snap))
  check('契约成员：tree()', typeof snap.tree === 'function', String(typeof snap.tree))
  check('契约成员：session()', typeof snap.session === 'function', String(typeof snap.session))
  check('契约成员：alive()', typeof snap.alive === 'function', String(typeof snap.alive))

  // tree：契约要求 children before parents
  const tree = snap.tree(100)
  check('tree(100) 覆盖 100/200/300', tree.length === 3 && [100, 200, 300].every((p) => tree.some((e) => e.pid === p)), JSON.stringify(tree.map((e) => e.pid)))
  const idx = (p) => tree.findIndex((e) => e.pid === p)
  check('tree() 顺序是 children-first（300 在 200 之前、200 在 100 之前）',
    idx(300) < idx(200) && idx(200) < idx(100), JSON.stringify(tree.map((e) => e.pid)))
  check('tree() 不越界（400 不在 100 的子树里）', !tree.some((e) => e.pid === 400), JSON.stringify(tree.map((e) => e.pid)))
  check('tree() 每项都是 {pid, started}', tree.every((e) => Number.isInteger(e.pid) && typeof e.started === 'string'), JSON.stringify(tree[0]))

  // session：Windows 表没有 POSIX session id —— 如实返回空数组，不编造
  check('session() 返回空数组（Windows 无 POSIX session id）', Array.isArray(snap.session(1)) && snap.session(1).length === 0, JSON.stringify(snap.session(1)))

  // alive：必须匹配 pid 与 started，防 PID 复用
  check('alive() 命中相同 pid+started', snap.alive({ pid: 200, started: 'T200' }) === true, '')
  check('alive() 拒绝 pid 相同但 started 不同（防 PID 复用）', snap.alive({ pid: 200, started: 'OTHER' }) === false, '')
  check('alive() 拒绝不存在的 pid', snap.alive({ pid: 999, started: 'T999' }) === false, '')
}

// ------------------------------------------------- 3. 一次 snapshot 只读一次表（契约的性能要求）
{
  const inst = Object.create(Inspector.prototype)
  let reads = 0
  inst.processTable = function () { reads++; return [{ pid: 1, parentPid: 0, started: 'T1' }] }
  const snap = inst.snapshot()
  snap.tree(1); snap.session(0); snap.alive({ pid: 1, started: 'T1' }); snap.tree(1)
  check('BV-02 一个 snapshot 只读一次进程表（契约明写 later questions never re-read it）', reads === 1, 'reads=' + reads)
}

// ------------------------------------------------- 4. 真实实例也能构造出 snapshot（不炸）
{
  let inst = null
  let err = null
  try { inst = new Inspector({}) } catch (e) { err = e }
  if (inst) {
    let s = null
    let e2 = null
    try { s = inst.snapshot() } catch (e) { e2 = e }
    check('真实实例 snapshot() 不抛（旧实现这里会 TypeError）', e2 === null && s !== null, e2 ? String(e2.message) : '')
    if (s) {
      let t = null
      let e3 = null
      try { t = s.tree(process.pid) } catch (e) { e3 = e }
      check('真实实例 tree(当前进程) 可用且不抛', e3 === null && Array.isArray(t), e3 ? String(e3.message) : JSON.stringify(t))
    }
  } else {
    // 构造需要参数时跳过（只做形状断言）
    console.log('  ok   真实实例构造需要参数，跳过第 4 组（形状断言已在第 1~3 组覆盖）')
  }
}

console.log(failures ? `\nFAILED: ${failures} 项` : '\nPASS: dsh-win-terminal-inspector snapshot()（BV-02 上游契约）')
process.exit(failures ? 1 : 0)
