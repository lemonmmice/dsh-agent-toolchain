#!/usr/bin/env node
/**
 * 一键跑完仓库里所有测试（`npm test`）—— Codex 第八轮指出仓库**没有 npm test**，
 * 而在此之前"跑全套"只能靠我自己每次手打一段 PowerShell 循环：
 * 那种临时脚本无法被复核者复用，也容易漏掉新加的文件（我自己就漏过一次）。
 *
 * 用法：
 *   npm test                # 全部
 *   npm test -- ui-drive    # 只跑路径里含该子串的（大小写不敏感）
 *   npm test -- --json      # 机器可读摘要
 *
 * 约定：每个测试文件自己打印 PASS/FAIL 并设置退出码；本脚本只负责**并发地找齐、跑全、汇总**，
 * 并且**绝不把"没跑"当成"通过"**（找不到任何测试文件 → 退出码 2，报错而不是静默成功）。
 */
import { readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'

const root = join(fileURLToPath(import.meta.url), '..', '..')
const argv = process.argv.slice(2)
const jsonOut = argv.includes('--json')
const filter = argv.filter((a) => !a.startsWith('--'))[0] || ''

/**
 * 并发互斥（2026-09-12，r29 实测教训）。
 *
 * Codex 在跑 `npm run verify` 的同时，我这边也在跑同一套测试 —— 结果它那份**红了 1 个**
 * （`launch-force.test.mjs` 报"客户端 exe 不存在"），而我独占跑是 **65/0 全绿**。
 * 两套并发会互相干扰：共享的临时受害者进程名、共享的状态目录（`build-logs/last.json` 之类）、
 * 以及都是 CPU 密集型 —— 于是产出**看起来像产品缺陷的假红**。
 *
 * 这正是本清单第 8/12 类（"验证工具测的是环境，不是被测对象"）。与其让复核者去猜，
 * 不如**当场说清**：已有另一套在跑 → 退出码 **2（未执行）**，而不是 1（断言失败）。
 * 想故意并发：`DSH_TESTS_ALLOW_CONCURRENT=1`。
 */
const LOCK = join(process.env.DSH_TEST_LOCK || join(homedir(), '.dsh-agent-toolchain'), '.test-run.lock')
const allowConcurrent = process.env.DSH_TESTS_ALLOW_CONCURRENT === '1'
function lockHeldByOther() {
  try {
    const info = JSON.parse(readFileSync(LOCK, 'utf8'))
    if (!Number.isInteger(info.pid) || info.pid === process.pid) return null
    try { process.kill(info.pid, 0) } catch { return null }            // pid 已死 ⇒ 陈旧锁
    const ageMs = Date.now() - (Number(info.startedAt) || 0)
    if (!(ageMs < 30 * 60 * 1000)) return null                          // 超过 30 分钟 ⇒ 视为陈旧
    return { ...info, ageMs }
  } catch { return null }
}
if (!allowConcurrent) {
  const other = lockHeldByOther()
  if (other !== null) {
    console.error('INCOMPLETE: 另一个测试套件正在运行（pid ' + other.pid + '，已跑 '
      + Math.round(other.ageMs / 1000) + 's）。')
    console.error('  并发跑两套会互相干扰（共享受害者进程名 / 共享状态目录 / CPU 争抢），产出的红**不是产品缺陷**。')
    console.error('  请等它结束，或显式 DSH_TESTS_ALLOW_CONCURRENT=1（自行承担假红风险）。')
    process.exit(2)
  }
}
try {
  mkdirSync(join(LOCK, '..'), { recursive: true })
  writeFileSync(LOCK, JSON.stringify({ pid: process.pid, startedAt: Date.now(), filter }), 'utf8')
} catch { /* 锁写不进去不该阻止测试本身 */ }
const releaseLock = () => { try { rmSync(LOCK, { force: true }) } catch { /* ignore */ } }
process.on('exit', releaseLock)
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { releaseLock(); process.exit(2) })

/**
 * 递归收集 `*.test.mjs`。
 *
 * ⚠ 口径更正（2026-09-12 r35，@claude 复核发现）：这里**只**跳过 `node_modules` 和 `.git`，
 * **没有**跳过 `bench-runs`。旧注释写着"跳过 node_modules / .git / bench-runs 里的临时产物"——
 * 那半句是**假的**（代码里没有任何针对 bench-runs 的判断）。
 * 实测现状是无害的（`bench-runs` 下现在没有 `*.test.mjs`），但只要有人往那里放一个测试文件，
 * 它**会被收进来**，而注释会让人以为不会。
 * **注释也是断言** —— 所以这里改成与代码一致；真要排除 bench-runs，得先加代码。
 */
function collect(dir, out = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) {
      if (e.name === 'node_modules' || e.name === '.git') continue
      collect(join(dir, e.name), out)
    } else if (/\.test\.mjs$/i.test(e.name)) {
      out.push(join(dir, e.name))
    }
  }
  return out
}

let files = []
try {
  files = collect(root)
} catch (e) {
  console.error('收集测试文件失败：' + e.message)
  process.exit(2)
}
if (filter) files = files.filter((f) => f.toLowerCase().includes(filter.toLowerCase()))
files.sort()
if (files.length === 0) {
  console.error(filter ? '没有匹配的测试文件：' + filter : '没找到任何 *.test.mjs —— 这不该发生，退出码 2（绝不把"没跑"当成"通过"）')
  process.exit(2)
}

const results = []
const started = Date.now()

function runOne(file) {
  return new Promise((resolve) => {
    const t0 = Date.now()
    const child = spawn(process.execPath, [file], {
      cwd: root,
      stdio: ['ignore', 'pipe', 'pipe'],
      // 测试硬闸（2026-09-11 事故后加）：让所有测试进程对"本机注册表里真配了什么"完全失明。
      // 起因：env 回退上线后，某个用 `delete process.env.X` 模拟"未配置"的测试拿到了真客户端的
      // 可执行路径，于是 build(killClient=true) **把用户正在跑的客户端杀掉了**。
      // 测试永远不该能驱动/结束真实目标进程；要测回退逻辑本身，就显式注入 env/exec（见 lib/env-fallback.test.mjs）。
      env: { ...process.env, DSH_NO_ENV_FALLBACK: '1' },
    })
    let out = ''
    child.stdout.on('data', (d) => { out += d.toString('utf8') })
    child.stderr.on('data', (d) => { out += d.toString('utf8') })
    child.on('close', (code) => {
      const lines = out.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)
      const summary = lines.filter((l) => /^(PASS|FAIL|SKIPPED|PASSED|FAILED)/.test(l)).pop() || ''
      const failed = lines.filter((l) => /^\s*FAIL\b/.test(l)).slice(0, 3)
      const rec = { file: relative(root, file), code: code ?? 1, ms: Date.now() - t0, summary, failed, tail: lines.slice(-3), log: null }
      // 失败的测试：把**完整输出**落盘。
      // 起因（r29）：`launch-force.test.mjs` 在全套里**偶发**红了一次，而我只看了输出末尾几行，
      // 真因就被丢掉了 —— 间歇性失败最怕"证据只剩三行"。现在失败必留全文，路径随结果一起打印。
      if (rec.code !== 0) {
        try {
          const dir = process.env.DSH_TEST_LOG_DIR || join(homedir(), '.dsh-agent-toolchain', 'test-logs')
          mkdirSync(dir, { recursive: true })
          const p = join(dir, rec.file.replace(/[\\/]/g, '__').replace(/\.test\.mjs$/, '') + '.log')
          writeFileSync(p, `# ${rec.file}\nexit=${rec.code}  ms=${rec.ms}\n\n` + out, 'utf8')
          rec.log = p
        } catch { /* 日记写不进去不该改变测试结论 */ }
      }
      resolve(rec)
    })
  })
}

// 并发 4：这些测试多数是纯计算 + 少数起子进程，串行会慢一倍以上。
const queue = [...files]
const workers = Array.from({ length: Math.min(4, queue.length) }, async () => {
  while (queue.length) {
    const f = queue.shift()
    const r = await runOne(f)
    results.push(r)
    if (!jsonOut) {
      const tag = r.code === 0 ? 'ok  ' : 'FAIL'
      console.log(`${tag} ${r.file.padEnd(58)} ${String(r.ms).padStart(6)}ms  ${r.summary}`)
      for (const l of r.failed) console.log('       ' + l)
      if (r.log) console.log('       ↳ 完整输出: ' + r.log)
    }
  }
})
await Promise.all(workers)

results.sort((a, b) => a.file.localeCompare(b.file))
const bad = results.filter((r) => r.code !== 0)
const elapsed = Date.now() - started

if (jsonOut) {
  console.log(JSON.stringify({ total: results.length, failed: bad.length, elapsedMs: elapsed, results }, null, 2))
} else {
  console.log('\n' + '─'.repeat(72))
  console.log(`共 ${results.length} 个测试文件，失败 ${bad.length}，耗时 ${(elapsed / 1000).toFixed(1)}s`)
  for (const b of bad) {
    console.log(`  ✗ ${b.file}（exit=${b.code}） ${b.summary || b.tail.join(' / ')}`)
  }
  if (bad.length === 0) console.log('全部通过')
}
process.exit(bad.length === 0 ? 0 : 1)
