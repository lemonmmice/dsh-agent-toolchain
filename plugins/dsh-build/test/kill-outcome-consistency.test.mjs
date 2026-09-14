// dsh-build 单测：强杀终态**不许自相矛盾**（F-038，2026-09-12 r34，@claude 独立复核查出）。
//
// 病（@claude 在负载下抓到的真机原文，不是构造的）：
//   {"killed":false,"pids":[33108],"remaining":[33108],
//    "remainingDetail":[{"pid":33108,"owner":null,
//                        "note":"该 pid 当前不存在（判活与判占用之间发生了变化）"}],
//    "waitedMs":20416,"note":"等待 10000ms 后目标进程仍在（见 remainingDetail）。"}
//
//   **同一份返回值一边说"目标还在"，一边说"这个 pid 不存在"。**
//   成因：等待循环的最后一次判活、与 `remainingDetail` 里那次 `pidOwner()` 之间有**时间差**，
//   进程刚好在这两者之间退出。旧实现只处理了 `owner !== null`（pid 被**别人**占用）那一支，
//   **"号彻底没了"这一支没处理** ⇒ 它仍留在 `remaining` 里 ⇒ `killed:false`。
//   危害不是文案：**负载下会把"已经停掉的客户端"报成"没停掉"**，而 `killed` 会一路带进
//   构建结果与渲染文本（`clientKill.killed` / `clientWasKilled`），让用户以为"客户端还在跑、
//   所以构建可能不可信" —— 正是本项目一直在打的那类反模式：**把做成的事报成没做成**。
//
// 修法：判决抽成**纯函数** `killOutcome()`（本来埋在 `killClientProcess()` 里、要靠真进程才能构造 ⇒
//   **竞态窗口没法单测** ⇒ 活到 r34）。现在判决**只从 `remainingDetail` 这一份证据推导**，
//   于是"判决"与"它引用的证据"在结构上就不可能互相矛盾。
import { killOutcome } from '../lib/builder.mjs'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

let failures = 0
function check(name, cond, extra = '') {
  if (cond) console.log('  ok   ' + name)
  else { failures++; console.log('  FAIL ' + name + (extra ? ' — ' + extra : '')) }
}

// ── 自检：断言器不能恒真（本仓反复踩过的空断言坑）──
{
  let sawFail = false
  const probe = (c) => { if (!c) sawFail = true }
  probe(false)
  console.log((sawFail ? '  ok   ' : '  FAIL ') + '（自检）断言器有效 —— 否则本文件后面的绿都是假的')
  if (!sawFail) failures++
}

const OUR = 'dshtestrace.exe'   // 「我们的」进程镜像名
const OTHER = 'svchost.exe'     // 别人的进程（= pid 被复用）

// ---------------------------------------------------------------------------
// 1. ★★ @claude 抓到的那个窗口：判活时"还在"，判占用时"号没了"
// ---------------------------------------------------------------------------
{
  const detail = [{ pid: 33108, owner: null, note: '该 pid 当前不存在' }]
  const o = killOutcome({ detail, isReused: () => false, waitMs: 10000 })
  check('★★ 号已消失时 **killed 必须为 true**（旧实现报 false，把做成的事说成没做成）',
    o.killed === true, JSON.stringify(o))
  check('★ 且该 pid **不再出现在 remaining 里**', o.remaining.length === 0 && !o.remaining.includes(33108),
    JSON.stringify(o.remaining))
  check('★ 但也不静默丢：单独记进 goneWhileChecking 供人核对',
    o.goneWhileChecking.length === 1 && o.goneWhileChecking[0] === 33108, JSON.stringify(o.goneWhileChecking))
  check('★ note 说明"是已结束"，不写"仍在"', /已结束/.test(String(o.note)) && !/仍在/.test(String(o.note)),
    String(o.note))
}

// ---------------------------------------------------------------------------
// 2. 反向：进程真的赖着不走 ⇒ 必须如实报 killed:false
//    （修 F-038 不能把"真的没杀掉"也一起说成成功 —— 那比原缺陷更糟）
// ---------------------------------------------------------------------------
{
  const detail = [{ pid: 1000, owner: OUR, note: 'pid 仍被占用' }]
  const o = killOutcome({ detail, isReused: () => false, waitMs: 15000 })
  check('★ 进程真在 ⇒ killed=false 且 remaining 含它（不许为了"好看"而谎报成功）',
    o.killed === false && o.remaining.includes(1000), JSON.stringify(o))
  check('★ note 明说"仍在"并指向 remainingDetail', /仍在/.test(String(o.note)) && /remainingDetail/.test(String(o.note)),
    String(o.note))
  check('★ 且带出 waitedMs（用户要知道等了多久）', /15000ms/.test(String(o.note)), String(o.note))
}

// ---------------------------------------------------------------------------
// 3. pid 复用（F-028 原有语义必须保留）：号被**别人**占着 ⇒ 不算没杀掉
// ---------------------------------------------------------------------------
{
  const detail = [{ pid: 2000, owner: OTHER, note: 'pid 仍被占用，占用者镜像=' + OTHER }]
  const o = killOutcome({ detail, isReused: (pid) => pid === 2000, waitMs: 15000 })
  check('★ pid 被别的进程占用 ⇒ killed=true（原 F-028 语义未被破坏）', o.killed === true, JSON.stringify(o))
  check('★ 记入 pidReused（供"其实已经成功了"的判读）', o.pidReused.includes(2000), JSON.stringify(o.pidReused))
  check('★ 不记入 goneWhileChecking（号还在，只是换了人）', !o.goneWhileChecking.includes(2000),
    JSON.stringify(o.goneWhileChecking))
}

// ---------------------------------------------------------------------------
// 4. 混合场景：一个赖着 + 一个号没了 + 一个被别人占了
// ---------------------------------------------------------------------------
{
  const detail = [
    { pid: 1, owner: OUR, note: '' },
    { pid: 2, owner: null, note: '' },
    { pid: 3, owner: OTHER, note: '' },
  ]
  const o = killOutcome({ detail, isReused: (pid) => pid === 3, waitMs: 15000 })
  check('混合：只有"仍是我们的那个"算 remaining', JSON.stringify(o.remaining) === '[1]', JSON.stringify(o.remaining))
  check('混合：另两类各自归类', JSON.stringify(o.goneWhileChecking) === '[2]' && JSON.stringify(o.pidReused) === '[3]',
    JSON.stringify({ g: o.goneWhileChecking, r: o.pidReused }))
  check('混合：还有没杀掉的 ⇒ killed=false', o.killed === false, JSON.stringify(o))
}

// ---------------------------------------------------------------------------
// 5. ★★ 不变量：判决**不可能**与它引用的证据矛盾（这才是这条修复的本质）
// ---------------------------------------------------------------------------
{
  const cases = [
    [],
    [{ pid: 1, owner: OUR }],
    [{ pid: 1, owner: null }],
    [{ pid: 1, owner: OTHER }],
    [{ pid: 1, owner: OUR }, { pid: 2, owner: null }, { pid: 3, owner: OTHER }, { pid: 4, owner: OUR }],
  ]
  let violated = []
  for (const detail of cases) {
    const o = killOutcome({ detail, isReused: (pid) => detail.find((d) => d.pid === pid)?.owner === OTHER, waitMs: 1000 })
    // ① killed === false ⟺ remaining 非空
    if ((o.killed === false) !== (o.remaining.length > 0)) violated.push({ detail, why: 'killed 与 remaining 不一致' })
    // ② 凡是被判为 remaining 的，其证据里 owner 必须非 null（即"确认真实存在"）
    for (const pid of o.remaining) {
      const row = detail.find((d) => d.pid === pid)
      if (!row || row.owner === null) violated.push({ detail, why: 'remaining 里混进了 owner=null 的 pid' })
    }
    // ③ 三类必须互斥且并集 = 明细里的全部 pid
    const all = detail.map((d) => d.pid).sort((a, b) => a - b)
    const union = [...o.remaining, ...o.pidReused, ...o.goneWhileChecking].sort((a, b) => a - b)
    if (JSON.stringify(all) !== JSON.stringify(union)) violated.push({ detail, why: '三类并集 ≠ 全部明细' })
  }
  check('★★ 不变量：killed 与 remaining 四处场景全部自洽；remaining 里的 pid 一律"证据上真实存在"；三类互斥且全覆盖',
    violated.length === 0, JSON.stringify(violated).slice(0, 300))
}

// ---------------------------------------------------------------------------
// 6. 源码守卫：判决必须**从明细推导**，不许再用更早那次判活的快照
// ---------------------------------------------------------------------------
{
  const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'lib', 'builder.mjs'), 'utf8')
  check('★ `killed` 不再直接由早先的 `remaining` 快照决定',
    !/killed:\s*remaining\.length\s*===\s*0/.test(src), '旧写法回来了')
  check('★ killClient 走纯函数 killOutcome', /const outcome = killOutcome\(\{/.test(src), '')
  check('★ 纯函数已导出（可单测 —— 这是它能被单测到的前提）', /export function killOutcome\(/.test(src), '')
  check('★ 返回值仍带 remainingDetail / pidReused（既有消费方不受影响）',
    /remainingDetail,/.test(src) && /pidReused: outcome\.pidReused/.test(src), '')
  check('★ 新增 goneWhileChecking 如实带出"等待期间消失"的那批', /goneWhileChecking: outcome\.goneWhileChecking/.test(src), '')
}

console.log(failures
  ? `\nFAILED: ${failures} 项`
  : '\nPASS: dsh-build 强杀终态一致性（F-038：判决不许与它引用的证据矛盾）')
process.exit(failures ? 1 : 0)
