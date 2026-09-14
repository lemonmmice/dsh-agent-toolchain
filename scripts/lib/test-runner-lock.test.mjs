// scripts/run-tests.mjs 的**并发互斥**自测（2026-09-12，r29 实测教训）。
//
// 病：Codex 的 `npm run verify` 与我的测试套件同时跑 ⇒ 它那份红了 1 个
//     （`launch-force.test.mjs` 报"客户端 exe 不存在"），而我独占跑是 65/0 全绿。
//     两套并发会互相干扰（共享受害者进程名 / 共享状态目录 / CPU 争抢）⇒ 产出**看起来像产品缺陷的假红**。
//
// 本测试不靠"真的起两套慢测试"（那会拖慢套件且本身易碎），而是直接构造两种前提：
//   ① 预置一份**由活着进程持有**的锁（用本测试自己的 pid）→ 运行器必须判为 INCOMPLETE(2)，而不是跑起来；
//   ② 干净环境下正常跑一个最小筛选 → 退出码 0，且**跑完把锁删掉**（否则下一次全被 2 挡死）。
import { mkdtempSync, writeFileSync, existsSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'

let failures = 0
const ok = (n, c, extra = '') => { if (c) console.log('  ok   ' + n); else { failures++; console.log('  FAIL ' + n + (extra ? ' — ' + extra : '')) } }

const here = join(import.meta.dirname, '..', '..')
const runner = join(here, 'scripts', 'run-tests.mjs')
const work = mkdtempSync(join(tmpdir(), 'dsh-lock-'))
// ⚠ `DSH_TEST_LOCK` 是**目录**，锁文件固定叫 `.test-run.lock`（我第一次把它当成文件路径，四个断言全红）
const lockPath = join(work, '.test-run.lock')

// 只匹配一个很快的测试文件，避免自测拖慢套件（也让本文件不会匹配到自己）
const FAST_FILTER = join('dsh-hang-inspector', 'test', 'render.test')

const run = (env) => spawnSync(process.execPath, [runner, FAST_FILTER],
  { cwd: here, encoding: 'utf8', windowsHide: true, timeout: 120000, env: { ...process.env, DSH_TEST_LOCK: work, ...env } })

// ① 预置"被活着进程持有"的锁：pid 用本测试自己的（必然活着），时间戳新鲜
writeFileSync(lockPath, JSON.stringify({ pid: process.pid, startedAt: Date.now(), filter: 'fake' }), 'utf8')
{
  const r = run({})
  ok('★ 已有他人持锁时：退出码必须是 2（未执行），不是 1（断言失败）', r.status === 2, `exit=${r.status}`)
  ok('★ 说明里点出"并发会产出假红"与怎么绕过', /交叉|假红|互相干扰/.test(String(r.stderr)) && /DSH_TESTS_ALLOW_CONCURRENT/.test(String(r.stderr)),
    String(r.stderr).split('\n').slice(0, 2).join(' / '))
  ok('★ 被挡下时**不该**跑任何测试（不产出可信度不明的结果）', !/共 \d+ 个测试文件/.test(String(r.stdout)),
    String(r.stdout).slice(0, 120))
  ok('★ 被挡下时不去动别人的锁', existsSync(lockPath) && JSON.parse(readFileSync(lockPath, 'utf8')).pid === process.pid, '锁被误删/改写了')
}

// ② 陈旧锁（pid 已死）+ 明确允许并发 —— 两种都必须**不挡**
rmSync(lockPath, { force: true })
{
  writeFileSync(lockPath, JSON.stringify({ pid: 999999, startedAt: Date.now(), filter: 'dead' }), 'utf8')
  const r = run({})
  ok('pid 已死的**陈旧锁**不该挡住运行', r.status === 0, `exit=${r.status} stderr=${String(r.stderr).slice(0, 120)}`)
  ok('★ 跑完必须把锁删掉（否则后续全被挡）', !existsSync(lockPath), '锁文件仍存在')
}
{
  writeFileSync(lockPath, JSON.stringify({ pid: process.pid, startedAt: Date.now(), filter: 'fake' }), 'utf8')
  const r = run({ DSH_TESTS_ALLOW_CONCURRENT: '1' })
  ok('显式 DSH_TESTS_ALLOW_CONCURRENT=1 时放行（自行承担假红风险）', r.status === 0, `exit=${r.status}`)
}

rmSync(work, { recursive: true, force: true })
if (failures > 0) {
  console.error(`\nTEST-RUNNER LOCK TEST FAILED: ${failures} failure(s)`)
  process.exit(1)
}
console.log('\nTEST-RUNNER LOCK TEST PASSED')
