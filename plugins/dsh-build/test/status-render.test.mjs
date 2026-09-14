// dsh-build 单测：build_status 的渲染（BV-05 / CL-7 / CL-3）
//
// 病：
//   BV-05：早返回**不写 last.json** → 被挡下的那次构建之后，build_status 报的是**上一次成功**
//          （agent 自己刚触发的失败被藏起来了）。
//   CL-7 ：`warningCount`（本工具解析去重后）与 `summaryLine`（MSBuild 自报）口径不同，实测 15 vs 32，
//          并排显示会让人以为其中一个是错的。
//   CL-3 ："最近构建"不说"多久以前" → 昨天的成功被当成当前状态。
//   另外两个渲染崩溃/难看点：`durationMs` 为 null 时打出"耗时 NaN s"；早返回时 `target` 为 null。
import { renderStatus } from '../lib/render.mjs'

let failures = 0
function check(name, cond, extra = '') {
  if (cond) console.log('  ok   ' + name)
  else { failures++; console.log('  FAIL ' + name + (extra ? ' — ' + extra : '')) }
}

const NOW = Date.parse('2026-09-11T20:00:00Z')
const ago = (min) => new Date(NOW - min * 60000).toISOString()

// ------------------------------------------------- 1. 无记录
{
  check('无记录 → 明说还没有记录并给下一步', /还没有构建记录/.test(renderStatus({ hasRun: false }, NOW)), '')
  check('null/undefined 不炸', /还没有构建记录/.test(renderStatus(null, NOW)) && /还没有构建记录/.test(renderStatus(undefined, NOW)), '')
}

// ------------------------------------------------- 2. BV-05：早返回（根本没跑）不得摆出一串 null/NaN
{
  const early = { hasRun: true, ok: false, didNotRun: true, error: '仓库根目录不存在：(未配置)', target: 'Build', durationMs: null, errorCount: 0, warningCount: 0, logPath: null, runId: 'auto-1', at: ago(1) }
  const t = renderStatus(early, NOW)
  check('BV-05 早返回 → 明说"没有执行"（而不是"最近构建：null 失败"）', /没有执行/.test(t), t.slice(0, 200))
  check('BV-05 保留原始原因', /仓库根目录不存在/.test(t), t.slice(0, 200))
  check('BV-05 不出现 NaN', !/NaN/.test(t), t.slice(0, 200))
  check('BV-05 不出现裸的 null', !/：null/.test(t), t.slice(0, 200))
  check('BV-05 带 runId（便于串 verify_report）', /auto-1/.test(t), t.slice(0, 240))
}

// ------------------------------------------------- 3. CL-3：年龄必须自曝
{
  const old = { hasRun: true, ok: true, target: 'Rebuild', durationMs: 12900, errorCount: 0, warningCount: 3, logPath: 'L.log', at: ago(90) }
  const t = renderStatus(old, NOW)
  check('CL-3 显示年龄', /小时前/.test(t), t.slice(0, 200))
  check('CL-3 陈旧时明说"不能证明此刻的代码能编译"', /不能证明/.test(t), t.slice(0, 300))
  check('CL-3 给出下一步（重新 build_run）', /重新 build_run/.test(t), t.slice(0, 300))
  const fresh = { ...old, at: ago(1) }
  check('CL-3 新鲜时不报陈旧警告', !/不能证明/.test(renderStatus(fresh, NOW)), renderStatus(fresh, NOW).slice(0, 200))
}

// ------------------------------------------------- 4. CL-7：两种计数口径必须被解释
{
  const t = renderStatus({ hasRun: true, ok: true, target: 'Build', durationMs: 12000, errorCount: 0, warningCount: 15, summaryLine: '0 error(s), 32 warning(s)', logPath: 'L.log', at: ago(5) }, NOW)
  check('CL-7 两个口径不同时给出解释', /口径不同/.test(t), t.slice(0, 300))
  check('CL-7 解释里同时出现两个数', /15/.test(t) && /32/.test(t), t.slice(0, 320))
  check('CL-7 明说"都不是错的"（避免让人以为其中一个坏了）', /都不是错的/.test(t), t.slice(0, 360))
  // 一致时不该刷这条解释
  const same = renderStatus({ hasRun: true, ok: true, target: 'Build', durationMs: 1, errorCount: 0, warningCount: 32, summaryLine: '0 error(s), 32 warning(s)', logPath: 'L.log', at: ago(5) }, NOW)
  check('CL-7 两数一致时不出现解释（不刷噪音）', !/口径不同/.test(same), same.slice(0, 240))
}

// ------------------------------------------------- 5. 其余渲染健壮性
{
  const t = renderStatus({ hasRun: true, ok: false, target: 'Build', durationMs: 5000, errorCount: 2, warningCount: 0, logPath: 'L.log', at: ago(2) }, NOW)
  check('失败构建正常渲染（含错误数）', /失败/.test(t) && /2 错误/.test(t), t.slice(0, 200))
  const noDur = renderStatus({ hasRun: true, ok: true, target: 'Build', durationMs: null, errorCount: 0, warningCount: 0, logPath: 'L.log', at: ago(2) }, NOW)
  check('durationMs 缺失 → 耗时显示 ?（不是 NaN）', /耗时 \?/.test(noDur) && !/NaN/.test(noDur), noDur.slice(0, 200))
  const ev = renderStatus({ hasRun: true, ok: true, target: 'Build', durationMs: 1, errorCount: 0, warningCount: 0, logPath: 'L.log', at: ago(2), evidenceWriteError: 'per-run 记录写入失败：磁盘满' }, NOW)
  check('证据写入失败必须显式暴露', /⚠/.test(ev) && /写入失败/.test(ev), ev.slice(0, 300))
  const noAt = renderStatus({ hasRun: true, ok: true, target: 'Build', durationMs: 1, errorCount: 0, warningCount: 0, logPath: 'L.log' }, NOW)
  check('缺 at 时不炸且不误报年龄', /最近构建/.test(noAt) && !/小时前/.test(noAt), noAt.slice(0, 200))
}

// ================================================================
// 6. ★★ 失败记录必须**把错误条目印出来**（2026-09-14，载荷探针抓出来的）
//
// 病：`renderStatus` 只印 `head`，而 head 里只有**计数**。实况原话：
//     「最近构建：Build 失败(2 错误)，耗时 5.7s，日志 C:\…（2.8 天前）」
// 那 2 条错误**到底写了什么**，当时 DSH 面**一个工具都看不到**：
//   `build_errors` 也只印计数，`build_run` 那份才印 —— 但它只在**当场失败**时印。
// ⇒ 与 F-052（`memory_search` 只印"找到 N 条"）同一族：**算出来了、也返回了，渲染层把它丢了**。
{
  const failed = renderStatus({
    hasRun: true, ok: false, target: 'Build', durationMs: 5700, errorCount: 2, warningCount: 15,
    logPath: 'C:\\logs\\b.log', at: ago(2),
    errors: [
      { file: 'KLineMultiGroupViewModel.cs', line: 412, col: 7, code: 'CS0103', message: '当前上下文中不存在名称"Foo"' },
      { file: 'Bar.cs', line: 9, col: 1, code: 'CS1002', message: '应输入 ;' },
    ],
  }, NOW)
  check('★ 失败时**列出**错误条目（file(line,col): code: message）—— 只有计数等于把原因藏起来',
    /KLineMultiGroupViewModel\.cs\(412,7\): CS0103:/.test(failed) && /Bar\.cs\(9,1\): CS1002:/.test(failed), failed.slice(0, 400))
  check('★ 依然保留计数与日志路径（旧行为不许丢）',
    /失败\(2 错误\)/.test(failed) && /C:\\logs\\b\.log/.test(failed), failed.slice(0, 240))

  const okNoErr = renderStatus({ hasRun: true, ok: true, target: 'Build', durationMs: 1, errorCount: 0, warningCount: 0, logPath: 'L.log', at: ago(2) }, NOW)
  check('★ 通过且没有错误时**不**凭空多出一段"关键错误"（旧行为一字未变）', !/关键错误/.test(okNoErr), okNoErr.slice(0, 200))

  const many = renderStatus({
    hasRun: true, ok: false, target: 'Build', durationMs: 1, errorCount: 40, warningCount: 0, logPath: 'L.log', at: ago(2),
    errors: Array.from({ length: 40 }, (_, i) => ({ file: 'F' + i + '.cs', line: i, col: 1, code: 'CS1', message: 'm' + i })),
  }, NOW)
  check('★ 错误多于上限时**截断并说出来**（不许默默只给前 10 条）',
    (many.match(/F\d+\.cs\(/g) || []).length === 10 && /只列前 10 条/.test(many), many.slice(-280))

  const weird = renderStatus({ hasRun: true, ok: false, target: 'Build', durationMs: 1, errorCount: 2, warningCount: 0, logPath: 'L.log', at: ago(2), errors: [null, 'raw string'] }, NOW)
  check('★ 条目形状残缺时不炸（渲染层永远不能抛）', typeof weird === 'string' && weird.length > 0, weird.slice(0, 200))
}

console.log(failures ? `\nFAILED: ${failures} 项` : '\nPASS: dsh-build build_status 渲染（BV-05 / CL-7 / CL-3）')
process.exit(failures ? 1 : 0)
