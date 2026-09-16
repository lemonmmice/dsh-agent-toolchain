// 采集通道的回归闸：**采集前自检**（R1-12）+ **通道路由与 xperf 合并**（R1-14）。
//
// 由来（2026-09-15 真机，完整复现）：本机 `wpr -start` 正常、`wpr -stop <file>` 报
//   `Cannot change thread mode after it is set. Profile Id: RunningProfile. Error code: 0x80010106`
//   且**不产出 etl**。这条链路**单点依赖 WPR** ⇒ 失败发生在**用户把问题复现完之后**才发现 ⇒ **白跑一轮**。
//
// ⚠ 口径更正（R1-14，同一天实测）：**不许再写"退出码恒为 0"** —— 实测那一发是
//   `$LASTEXITCODE = -2147417850`（= 0x80010106），是**响亮失败**。判据始终是"有没有 etl 文件"，
//   所以下面同时钉住两种退出码（0 与非 0），并断言**报出来的就是实测到的那个码**。
//
// R1-14 追加的事实（决定本文件后半段）：`xperf` 采集**不依赖 WPR 收尾**，这条路能救回被 WPR 卡住的场景；
//   但它**必须多做一步合并**。`xperf -help symbols` 原文："For symbol decoding, the trace must be ...
//   stopped and merged with `-d` or merged with `-merge` ... [xperf performs a special image identification
//   process during its custom trace merge.]" ⇒ 少了这步，报告**连模块名都没有**（实测 155 KB / 0 个模块名）。
//
// 本测试钉住（全部用**注入的 runExe** 离线验，不碰真 WPR/xperf、不真采 ETW）：
//   I1 健康时：start 前会探针，结果带 `preflight.ok=true`、**没有** warning，探针 etl 被清掉；
//   I2 坏 + engine=auto ⇒ **自动换 xperf 通道**（warning 说清"已自动改用"，且**不许**再说"白跑一轮"）；
//   I3 `skipPreflight:true` ⇒ **不探针**（不替调用方付代价），且不因自检缺失而改通道；
//   I4 显式 engine="wpr" + 坏 ⇒ warning 点名"很可能白跑"（这条正是 WPR 仍被强制时的真实后果）；
//   I5 真 stop 失败且没 etl ⇒ error 点名 WPR 收尾坏 + **回带实测退出码** + diagnosis + nextSteps + 顺手 -cancel；
//   I6 xperf 通道 start 的命令形状（LOADER 必须在、-stackwalk 必须给、-f 落原始 etl）；
//   I7 xperf 通道 stop ⇒ **先 -stop 再 -merge**（合并是模块归属的前提），成功时带 rawPath；
//   I8 merge 失败但原始 etl 还在 ⇒ 如实报"没合并成功"（**不许**读成"没采到"，也不许静默 ok:true）。
import { makeTrace } from '../lib/trace.mjs'
import { mkdtempSync, rmSync, existsSync, writeFileSync, readFileSync } from 'node:fs'
import { join, basename } from 'node:path'
import { tmpdir } from 'node:os'

let failures = 0
function check(name, cond, extra = '') {
  if (cond) console.log('  ok   ' + name)
  else { failures++; console.log('  FAIL ' + name + (extra ? ' — ' + extra : '')) }
}

const BROKEN_RAW = 'Cannot change thread mode after it is set.\r\n\tProfile Id: RunningProfile\r\n\tError code: 0x80010106\r\n'
/** 真机实测的退出码（R1-14）：0x80010106 以有符号 32 位返回。 */
const BROKEN_EXIT = -2147417850

/**
 * 假 wpr/xperf：只按参数决定返回，不碰系统。
 * `probeStopWorks` 决定"探针那次 stop"成功与否；`realStopWorks` 决定"真采样那次 stop"；
 * `mergeWorks` 决定 xperf 的 `-merge` 是否产出文件；`stopCode` 是 wpr -stop 失败时的退出码。
 */
function fakeTools({ probeStopWorks = true, realStopWorks = false, mergeWorks = true, stopCode = BROKEN_EXIT } = {}) {
  const calls = []
  const fake = async (exe, args) => {
    const line = args.join(' ')
    calls.push(line)
    if (args.includes('-NoLogo') || args.includes('-Command')) return { code: 0, stdout: 'True', stderr: '' }  // isElevated 探针
    // ── xperf 通道 ───────────────────────────────────────────────────────
    if (args[0] === '-on') {                        // xperf -on <flags> -stackwalk <flags> -f <raw>
      const fi = args.indexOf('-f')
      if (fi >= 0) writeFileSync(args[fi + 1], 'fake raw etl', 'utf8')
      return { code: 0, stdout: '', stderr: '' }
    }
    if (args[0] === '-merge') {                     // xperf -merge <raw> <merged>
      if (mergeWorks) writeFileSync(args[2], 'fake merged etl', 'utf8')
      return { code: 0, stdout: mergeWorks ? 'Merged Etl: ' + args[2] : 'merge failed', stderr: '' }
    }
    // ── wpr 通道 ─────────────────────────────────────────────────────────
    if (args[0] === '-start') return { code: 0, stdout: '', stderr: '' }
    if (args[0] === '-stop' && args.length > 1) {   // wpr -stop <file>
      const target = args[1]
      const isProbe = String(target).includes('_wpr-preflight.etl')
      const works = isProbe ? probeStopWorks : realStopWorks
      if (!works) return { code: stopCode, stdout: BROKEN_RAW, stderr: '' }
      writeFileSync(target, 'fake etl content', 'utf8')
      return { code: 0, stdout: 'saved', stderr: '' }
    }
    return { code: 0, stdout: 'no trace profiles running', stderr: '' }   // -cancel / xperf -stop（无参）
  }
  return { fake, calls }
}

const TMP = mkdtempSync(join(tmpdir(), 'dsh-perf-preflight-'))
const mk = (opts) => {
  const { fake, calls } = fakeTools(opts)
  const evidenceDir = mkdtempSync(join(TMP, 'ev-'))
  const t = makeTrace({ evidenceDir, wpr: process.execPath, xperf: process.execPath, runExe: fake })
  return { t, calls, evidenceDir }
}
/** 探针的唯一可辨识特征：它 stop 到 `_wpr-preflight.etl`（工具自己的采样是 `-start CPU -start DotNet`，不能用前缀区分） */
const probed = (calls) => calls.some((c) => c.includes('_wpr-preflight.etl'))

try {
  // ── I1：健康 ────────────────────────────────────────────────────────────
  {
    const { t, calls, evidenceDir } = mk({ probeStopWorks: true, realStopWorks: true })
    const r = await t.trace({ action: 'start', skipPreflight: false })
    check('★ I1 健康时 start 成功且带 preflight 详情', r.ok === true && r.preflight && r.preflight.ok === true, JSON.stringify({ ok: r.ok, pf: r.preflight }))
    check('★ I1 自检确实跑过（stop 到 _wpr-preflight.etl 那一次）', probed(calls), JSON.stringify(calls))
    check('★ I1 健康时**不给** warning（不无病呻吟）', !r.warning, String(r.warning || ''))
    check('★ I1 健康时**不**改通道（仍走 WPR）', r.engine === 'wpr', String(r.engine))
    check('★ I1 探针留下的 etl **被清掉**（不能把探针产物留在证据目录里冒充证据）',
      !existsSync(join(evidenceDir, '_wpr-preflight.etl')), evidenceDir)
  }

  // ── I2：WPR 收尾坏了（本机真实故障）+ engine=auto ⇒ 自动换 xperf ─────────
  {
    const { t, calls } = mk({ probeStopWorks: false, realStopWorks: false })
    const r = await t.trace({ action: 'start' })
    check('★★ I2 自检能认出"坏"', r.preflight && r.preflight.ok === false, JSON.stringify(r.preflight))
    check('★★ I2 认出签名 0x80010106（RPC_E_CHANGED_MODE）', Boolean(r.preflight) && r.preflight.signature === 'RPC_E_CHANGED_MODE(0x80010106)', String(r.preflight && r.preflight.signature))
    check('★★ I2 auto 路由到 engine=xperf（本轮修法的核心）', r.engine === 'xperf', String(r.engine))
    check('★★ I2 warning 说清"已自动改用 xperf 通道"', /已自动改用 xperf 通道/.test(String(r.warning)), String(r.warning || '').slice(0, 240))
    check('★★ I2 换了通道后**不许**再讲"白跑一轮复现"（那句话的前提已经被消除）',
      !/白跑/.test(String(r.warning)), String(r.warning || '').slice(0, 240))
    check('★ I2 仍然允许 start（决定权在调用方，工具不擅自拦）', r.ok === true && r.started === true, JSON.stringify({ ok: r.ok, started: r.started }))
  }

  // ── I2b：显式 engine="xperf" + 坏 ⇒ **不许**冒充"已自动改用" ─────────────
  //   由来（r61 真机 E2E 抓到）：我显式传 engine="xperf"，输出却说"（engine=auto）已自动改用 xperf 通道" ——
  //   没人自动改，是调用方指定的。把"谁做的决定"说错，是这条口径里最不该犯的一种。
  {
    const { t } = mk({ probeStopWorks: false, realStopWorks: false })
    const r = await t.trace({ action: 'start', engine: 'xperf' })
    check('★★ I2b 显式指定 xperf 时 warning 不许冒充"自动改用"',
      /调用方显式指定/.test(String(r.warning)) && !/已自动改用/.test(String(r.warning)), String(r.warning || '').slice(0, 220))
    check('★ I2b 仍如实报"自检不通过"与通道', r.engine === 'xperf' && /采集前自检不通过/.test(String(r.warning)), JSON.stringify({ e: r.engine, w: String(r.warning || '').slice(0, 80) }))
  }

  // ── I3：skipPreflight ──────────────────────────────────────────────────
  {
    const { t, calls } = mk({ probeStopWorks: false, realStopWorks: false })
    const r = await t.trace({ action: 'start', skipPreflight: true })
    check('★★ I3 skipPreflight:true ⇒ 完全不探针（不给调用方强加 1~2 秒开销）',
      !probed(calls), JSON.stringify(calls))
    check('★ I3 不因"没有自检结论"而擅自改通道（按默认 WPR 走，行为可预期）',
      r.engine === 'wpr', String(r.engine))
    check('★ I3 也就不带 preflight/warning', !r.preflight && !r.warning, JSON.stringify({ pf: r.preflight, w: r.warning }))
  }

  // ── I4：显式 engine="wpr" + 坏 ⇒ 保留 R1-12 那条"很可能白跑"的警告 ───────
  {
    const { t, calls } = mk({ probeStopWorks: false, realStopWorks: false })
    const r = await t.trace({ action: 'start', engine: 'wpr' })
    check('★ I4 显式 wpr ⇒ 不换通道', r.engine === 'wpr', String(r.engine))
    check('★★ I4 强制 WPR 时警告要讲清后果（很可能白跑一轮复现）',
      /采集前自检不通过/.test(String(r.warning)) && /白跑/.test(String(r.warning)), String(r.warning || '').slice(0, 240))
    check('★ I4 强制 WPR 时**不**出现 xperf 的采集命令（别嘴上换、手上没换）',
      !calls.some((c) => c.startsWith('-on ')), JSON.stringify(calls))
  }

  // ── I5：真 stop 失败（没 etl）⇒ 定向诊断 + 回带实测退出码 + 清场 ─────────
  {
    const { t, calls } = mk({ probeStopWorks: true, realStopWorks: false })
    const s = await t.trace({ action: 'start', engine: 'wpr' })
    const r = await t.trace({ action: 'stop', etlPath: s.etlPath })
    check('★★ I5 没产出 etl ⇒ ok:false', r.ok === false, JSON.stringify({ ok: r.ok }))
    check('★★ I5 error 里**点名**是"WPR 收尾坏了"且带上签名（不是干巴巴一句"未生成 etl"）',
      /WPR 收尾坏了/.test(String(r.error)) && /0x80010106/.test(String(r.error)), String(r.error || '').slice(0, 200))
    check('★★ I5 error 回带**实测退出码**（' + BROKEN_EXIT + '）而不是替 wpr 断言"退出码 0"',
      String(r.error).includes(String(BROKEN_EXIT)) && !/退出码 0[,，\s）]/.test(String(r.error)), String(r.error || ''))
    check('★★ I5 给出 diagnosis（说清这不是"这次没问题"）', /不是"这次没问题"/.test(String(r.diagnosis)), String(r.diagnosis || '').slice(0, 160))
    check('★★ I5 给出 nextSteps（至少 3 条，含"换 xperf 通道"与"别读成没有热点"）',
      Array.isArray(r.nextSteps) && r.nextSteps.length >= 3 && r.nextSteps.some((x) => /xperf/.test(x)) && r.nextSteps.some((x) => /没有热点/.test(x)),
      JSON.stringify(r.nextSteps))
    check('★ I5 顺手 -cancel 清场（不留会话），并如实带出 cleanedUp',
      calls.includes('-cancel') && r.cleanedUp !== undefined, JSON.stringify({ cancel: calls.filter((c) => c === '-cancel'), cleanedUp: r.cleanedUp }))
  }

  // ── I6：xperf 通道的**采集命令形状** ────────────────────────────────────
  {
    const { t, calls, evidenceDir } = mk({})
    const r = await t.trace({ action: 'start', engine: 'xperf' })
    const onLine = calls.find((c) => c.startsWith('-on ')) || ''
    check('★★ I6 显式 xperf ⇒ engine 如实回报', r.engine === 'xperf' && r.ok === true, JSON.stringify({ e: r.engine, ok: r.ok }))
    check('★★ I6 采集带全 PROC_THREAD+LOADER+PROFILE+CSWITCH（LOADER = 镜像事件来源；原文：Kernel and user mode Image Load/Unload events）',
      onLine.includes('PROC_THREAD+LOADER+PROFILE+CSWITCH'), onLine)
    check('★★ I6 显式给 -stackwalk PROFILE+CSWITCH（不给就只有采样点、没有栈）',
      /-stackwalk PROFILE\+CSWITCH/.test(onLine), onLine)
    check('★ I6 -f 落到 **raw**（未合并）路径，且与 etlPath 不是一个文件',
      /-f .*trace-raw\.etl/.test(onLine) && r.rawPath && r.rawPath !== r.etlPath, JSON.stringify({ onLine, raw: r.rawPath, etl: r.etlPath }))
    check('★ I6 会话标记里记了 engine 与 rawPath（否则 stop 不知道找谁收尾、也找不到合并源）', (() => {
      // ⚠ 标记固定在**证据目录根**（R1-04 的约定），不在 runDir 里 —— 第一版这里写成 join(etlPath,'..') 就假红了。
      const marker = join(evidenceDir, 'trace-session.json')
      try {
        const s = JSON.parse(readFileSync(marker, 'utf8'))
        return s.engine === 'xperf' && String(s.rawPath || '').endsWith('trace-raw.etl')
      } catch { return false }
    })(), String(r.etlPath))
  }

  // ── I7：xperf 通道 stop ⇒ 先 -stop、再 -merge ───────────────────────────
  {
    const { t, calls } = mk({})
    const s = await t.trace({ action: 'start', engine: 'xperf' })
    const r = await t.trace({ action: 'stop', etlPath: s.etlPath })
    check('★★ I7 xperf 通道 stop 成功且带 engine/rawPath',
      r.ok === true && r.engine === 'xperf' && Boolean(r.rawPath), JSON.stringify({ ok: r.ok, e: r.engine, raw: r.rawPath }))
    check('★★ I7 **真的调了 `-merge`**（模块归属只在合并那步产生 —— 省了它报告全是 ***unknown***）',
      calls.some((c) => c.startsWith('-merge ')), JSON.stringify(calls))
    check('★ I7 合并源是 raw、目标是 etlPath', calls.some((c) => c.startsWith('-merge ') && c.includes('trace-raw.etl') && c.includes(basename(r.etlPath))),
      JSON.stringify(calls.filter((c) => c.startsWith('-merge '))))
    check('★ I7 run 也复用同一条（带 -merge）的收尾路径', await (async () => {
      const { t: t2, calls: c2 } = mk({})
      const rr = await t2.trace({ action: 'run', engine: 'xperf', seconds: 3 })
      return rr.ok === true && c2.some((c) => c.startsWith('-merge '))
    })(), '')
  }

  // ── I8：merge 失败但原始 etl 还在 ⇒ 如实报"没合并成功" ──────────────────
  {
    const { t } = mk({ mergeWorks: false })
    const s = await t.trace({ action: 'start', engine: 'xperf' })
    const r = await t.trace({ action: 'stop', etlPath: s.etlPath })
    check('★★ I8 没产出 etl ⇒ ok:false（不能静默成功）', r.ok === false, JSON.stringify({ ok: r.ok }))
    check('★★ I8 说的是"**已采到、但合并没成**"（与"整个没采到"是两回事）',
      /没产出合并文件/.test(String(r.error)) && /已采到/.test(String(r.error)), String(r.error || '').slice(0, 200))
    check('★ I8 保留 rawPath 并给出可救的下一步（手工 xperf -merge）',
      Boolean(r.rawPath) && /xperf -merge/.test(String(r.hint)), JSON.stringify({ raw: r.rawPath, hint: r.hint }))
  }
} finally {
  try { rmSync(TMP, { recursive: true, force: true }) } catch { /* ignore */ }
}

if (failures) { console.log(`\nFAILED: ${failures} 项`); process.exit(1) }
console.log('\nPASS: 采集通道（自检 + auto 路由 + xperf -merge）（R1-12/R1-14：别让用户复现完才发现产不出 etl）')
