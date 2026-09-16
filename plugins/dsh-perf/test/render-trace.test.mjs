// r54 单测：`perf_trace` 的渲染层必须与生产者的 **action 分支**对齐。
//
// 这一关是为 F-049 钉的回归 —— 2026-09-14 宿主重启复验时在现网实测抓到：
//   r48 给 `lib/trace.mjs` 加了 `status`（第 224 行）与 `cancel`（第 250 行）两个分支，
//   **渲染层没跟上**，于是这两条 `ok:true` 但"什么都没采"的结果双双掉进"trace 完成"那句：
//     status → `trace 完成：<此刻的 etl 路径>（0MB，预设 ）`   ← sizeBytes=null 被算成 0
//              紧接着又打「没有进行中的采样（按标记），也没有找到 etl。」 ← **同一条结果自相矛盾**
//     cancel → `trace 完成：undefined（NaNMB，预设 ）`          ← 连 etlPath 都没有
//
// **为什么它能活到现网**：`renderTrace` 此前**一条断言都没有**
//   （`grep renderTrace plugins/dsh-perf/test` 为空 —— 上一轮我自己写过"渲染文本是 agent 唯一看得见的契约"，
//     却没给它写测试，而 dsh-build / dsh-hang-inspector 都已有同类测试）。
//
// 所以本测试不去逐句比对文案，而是**从生产者读 enum**（不手抄，避免两处漂移）驱动两条不变量：
//   I1 每个声明的 action 都必须有明确的渲染期望（新增 action 立刻变红，逼人补渲染分支）；
//   I2 渲染文本里不许出现"编造的量"（`undefined` / `NaN` / 给不存在的文件报 `0MB`）。
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { renderTrace } from '../lib/render.mjs'

let failures = 0
function check(name, cond, extra = '') {
  if (cond) console.log('  ok   ' + name)
  else { failures++; console.log('  FAIL ' + name + (extra ? ' — ' + extra : '')) }
}

const HERE = dirname(fileURLToPath(import.meta.url))
const INDEX = readFileSync(join(HERE, '..', 'index.js'), 'utf8')

// ---------------------------------------------------------------- 生产者的 action enum

/** 从 `index.js` 的 `perf_trace` 工具块里读 `action` 的 enum（**不手抄**：两边抄一份必然漂移）。 */
function perfTraceActionEnum() {
  const at = INDEX.indexOf("name: 'perf_trace'")
  if (at < 0) return null
  const seg = INDEX.slice(at, at + 4000)
  const m = seg.match(/action:\s*\{[^}]*enum:\s*\[([^\]]+)\]/)
  if (!m) return null
  return m[1].split(',').map((s) => s.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean)
}

const ACTIONS = perfTraceActionEnum()
// ⚠ 先证明"确实读到了"：正则失效时若直接空跑，这一关就会变成**空断言**（本仓第 19/44 类）。
check('★ 从生产者读到了 perf_trace 的 action enum（正则失效会让本测试变成空断言）',
  Array.isArray(ACTIONS) && ACTIONS.length >= 5, JSON.stringify(ACTIONS))

const HAS_ETL = { etlPath: 'C:\\ev\\trace.etl', sizeBytes: 3 * 1024 * 1024, profile: 'cpu', profiles: ['CPU', 'DotNet'] }

/**
 * 每个 action 的**真实返回形状** + 渲染期望。
 * 形状取自 `lib/trace.mjs` 的 return 语句（status 第 230 行 / cancel 第 250 行 / stop 第 253 行 /
 * start 第 272 行 / run 第 281 行），**不是我想象的**。
 */
const CASES = {
  start: {
    result: { ok: true, started: true, profile: 'cpu', profiles: ['CPU', 'DotNet'], etlPath: HAS_ETL.etlPath, hint: 'h' },
    mustMatch: [/已开始采集/],
    mustNotMatch: [/trace 完成/, /NaN/, /undefined/],
  },
  run: {
    result: { ok: true, ...HAS_ETL, seconds: 20, hint: 'h' },
    mustMatch: [/trace 完成/, /3MB/],
    mustNotMatch: [/NaN/, /undefined/, /大小未知/],
  },
  stop: {
    result: { ok: true, ...HAS_ETL, hint: 'h' },
    mustMatch: [/trace 完成/, /3MB/],
    mustNotMatch: [/NaN/, /undefined/],
  },
  cancel: {
    // 生产者：`{ ok: r.code === 0, cancelled: true, raw }` —— **没有 etlPath、没有 profiles**
    result: { ok: true, cancelled: true, raw: 'wpr -cancel ok' },
    mustMatch: [/已取消/, /没有产出 etl/],
    mustNotMatch: [/trace 完成/, /undefined/, /NaN/, /预设 \s*）/],
  },
  status: {
    // 生产者：`{ ok:true, action:'status', running, runningBasis, elapsedMs, etlPath, sizeBytes, profile, samplerProcessFound, hint }`
    result: {
      ok: true, action: 'status', running: false,
      runningBasis: 'start 时写的会话标记文件（<evidence>/trace-session.json），stop/cancel 时删除',
      elapsedMs: null, etlPath: HAS_ETL.etlPath, sizeBytes: null, profile: null,
      samplerProcessFound: null, hint: '没有进行中的采样（按标记），也没有找到 etl。',
    },
    mustMatch: [/采样状态/, /只读/, /是否在跑：否/, /文件不存在/],
    mustNotMatch: [/trace 完成/, /0MB/, /NaN/, /undefined/],
  },
}

// ---- I1：每个声明的 action 都要有渲染期望（新增 action 必须同时补这两样）----
{
  const missing = (ACTIONS || []).filter((a) => !Object.prototype.hasOwnProperty.call(CASES, a))
  const extra = Object.keys(CASES).filter((a) => !(ACTIONS || []).includes(a))
  check('★★ 生产者声明的每个 action 都有渲染期望（新增分支而不补渲染 ⇒ 这里立刻红）',
    missing.length === 0, '缺渲染期望：' + missing.join(', '))
  check('★ 期望表里没有生产者已删掉的 action（只许同步，不许留下僵尸项）',
    extra.length === 0, '僵尸项：' + extra.join(', '))
}

// ---- I2：逐 action 渲染 ----
for (const [action, c] of Object.entries(CASES)) {
  const out = renderTrace(c.result)
  const bad = c.mustMatch.filter((r) => !r.test(out))
  const bad2 = c.mustNotMatch.filter((r) => r.test(out))
  check('★ action=' + action + ' 渲染符合期望' + (bad.length ? '（缺少：' + bad.map(String).join(' / ') + '）' : '') +
    (bad2.length ? '（不该出现：' + bad2.map(String).join(' / ') + '）' : ''),
    bad.length === 0 && bad2.length === 0, JSON.stringify(out))
}

// ---- I2 的具体化：不许编造任何量 ----
{
  // ① status：不存在的文件**不许报尺寸**（这正是真机那句「0MB」的来源：null/1024/1024 = 0）
  const out = renderTrace({
    ok: true, action: 'status', running: false, etlPath: 'C:\\ev\\trace.etl', sizeBytes: null,
    elapsedMs: null, profile: null, samplerProcessFound: null,
    hint: '没有进行中的采样（按标记），也没有找到 etl。',
  })
  check('★★ status 对**不存在**的 etl 不报尺寸（不把 null 算成 0MB）',
    /文件不存在/.test(out) && !/\d+MB/.test(out) && !/0MB/.test(out), JSON.stringify(out))
  check('★ 真机原话不再出现："trace 完成 …（0MB，预设 ）"（自相矛盾的两句话）',
    !/trace 完成/.test(out), JSON.stringify(out))

  // ② status：在跑 + 文件已有大小 ⇒ 说清依据与真实字节数
  const running = renderTrace({
    ok: true, action: 'status', running: true,
    runningBasis: 'start 时写的会话标记文件', elapsedMs: 125000,
    etlPath: 'C:\\ev\\trace.etl', sizeBytes: 2 * 1024 * 1024, profile: 'cpu',
    samplerProcessFound: true, hint: '复现完成后调 stop',
  })
  check('★ status(running) 说"是"+依据+已跑秒数+真实字节数',
    /是否在跑：\*\*是\*\*/.test(running) && /依据：/.test(running) && /125 秒/.test(running) &&
      /2MB/.test(running) && /2097152 字节/.test(running) && /找到采样进程/.test(running), JSON.stringify(running))

  // ③ samplerProcessFound=null ⇒ "查不到" **不等于**没在跑（三态诚实，同 r48 的口径）
  const unknownSampler = renderTrace({
    ok: true, action: 'status', running: false, etlPath: 'C:\\ev\\trace.etl',
    sizeBytes: null, elapsedMs: null, profile: null, samplerProcessFound: null,
  })
  check('★ samplerProcessFound=null 说成"查不到（不等于没在跑）"，不冒充否定结论',
    /旁证 samplerProcessFound：查不到（\*\*不等于没在跑\*\*）/.test(unknownSampler), JSON.stringify(unknownSampler))
  check('★ samplerProcessFound=false 才说"没找到采样进程"（三态不许塌成两态）',
    /旁证 samplerProcessFound：没找到采样进程/.test(renderTrace({
      ok: true, action: 'status', running: false, etlPath: 'x', sizeBytes: null, samplerProcessFound: false,
    })))

  // ④ 完成路径缺 sizeBytes ⇒ 说"大小未知"，不许 NaN
  const noSize = renderTrace({ ok: true, etlPath: 'C:\\ev\\trace.etl', profile: 'cpu', profiles: ['CPU'] })
  check('★ 完成路径拿不到 sizeBytes ⇒ 说"大小未知"（不许 NaN / 不许编 0MB）',
    /大小未知/.test(noSize) && !/NaN/.test(noSize) && !/0MB/.test(noSize), JSON.stringify(noSize))

  // ⑤ 失败态仍然说原因（回归：别为了修这条把失败态弄丢）
  const fail = renderTrace({ ok: false, error: 'wpr -start 失败', raw: 'boom' })
  check('★ 失败态仍报原因 + 原始输出（本次改动不碰失败态）',
    /采集失败：wpr -start 失败/.test(fail) && /boom/.test(fail), JSON.stringify(fail))
  check('★ 提权失败带出"需要管理员"（回归）',
    /需要管理员权限/.test(renderTrace({ ok: false, error: 'x', needsElevation: true })))

  // ⑥ ★★ R1-12：**start 成功也可能是个陷阱** —— 自检发现这台机器的 WPR 收不了尾时，
  //    渲染层必须把那句警告印出来（否则 agent 只看到"请复现问题"，用户就白跑一轮复现）。
  //    ⚠ 这条正是"算出来了没印出来"的钉子：生产者早就给了 `warning`，是渲染层把它丢了。
  {
    const warnText = '⚠ **采集前自检不通过**：这台机器的 `wpr -stop` **收不了尾**（RPC_E_CHANGED_MODE(0x80010106)）…**这次采样很可能白跑一轮复现**。'
    const started = renderTrace({
      ok: true, started: true, profiles: ['CPU', 'DotNet'], etlPath: 'C:\\ev\\trace.etl',
      preflight: { ok: false, signature: 'RPC_E_CHANGED_MODE(0x80010106)', elapsedMs: 1234 },
      warning: warnText,
    })
    check('★★ start 成功但自检不通过 ⇒ **必须**把警告印出来（不许只印"请复现问题"）',
      started.includes('采集前自检不通过') && /白跑/.test(started), JSON.stringify(started.slice(0, 240)))
    check('★ 并带出签名与自检耗时（可核对）',
      /RPC_E_CHANGED_MODE\(0x80010106\)/.test(started) && /1234ms/.test(started), JSON.stringify(started.slice(0, 240)))
    const healthy = renderTrace({
      ok: true, started: true, profiles: ['CPU'], etlPath: 'C:\\ev\\t.etl',
      preflight: { ok: true, elapsedMs: 900 },
    })
    check('★ 自检通过时说"通过"（不制造假警报），且没有 warning 就不加戏',
      /采集前自检：通过/.test(healthy) && !/不通过/.test(healthy) && !/白跑/.test(healthy), JSON.stringify(healthy.slice(0, 200)))
  }

  // ⑦ ★★ R1-12：`wpr -stop` 失败时的**定向诊断**必须出现在 DSH 面的渲染文本里
  //    （生产者给了 diagnosis/nextSteps，而旧渲染只印 raw —— 又是"只有外壳面中招"）
  {
    const failed = renderTrace({
      ok: false, error: '停止后未生成 etl（**这台机器的 WPR 收尾坏了**：RPC_E_CHANGED_MODE(0x80010106)）',
      raw: 'Cannot change thread mode after it is set.',
      diagnosis: '**采集通道失败，不是"这次没问题"**：wpr -start 正常、wpr -stop 收不了尾 ⇒ 本次采样没有 etl。',
      nextSteps: ['① 重启机器（最可能恢复）', '② 改用别的采集手段', '③ 别把这次失败读成"这段时间客户端没有热点"。'],
      cleanedUp: 'no trace profiles running',
    })
    check('★★ stop 失败 ⇒ 渲染里必须带 diagnosis（说清不是"这次没问题"）',
      /诊断：/.test(failed) && /不是"这次没问题"/.test(failed), JSON.stringify(failed.slice(0, 240)))
    check('★★ 也必须带 nextSteps（含"别读成没有热点"这条 —— 它是防止下游误判的关键一句）',
      /下一步：/.test(failed) && /没有热点/.test(failed) && /重启机器/.test(failed), JSON.stringify(failed.slice(0, 300)))
    check('★ 清场结果也印出来（清场了要说，没清场不能假装清了）', /wpr -cancel/.test(failed), JSON.stringify(failed.slice(0, 300)))
  }
}

// ---------------------------------------------------------------- 覆盖面登记（只许缩小）
//
// 同族风险不止 perf_trace 一个：**任何声明了 `action` enum 的工具，只要渲染层新增/改动分支就可能踩同一个坑**。
// 这一节把"DSH 面声明 action enum 的工具"和"已按本测试方式核过渲染层的工具"对齐：
//   `COVERED` 只许**变大**；`KNOWN_UNCOVERED` 只许**变小**（钉子钉住当前值）。
//   ⚠ 未覆盖 **不等于** 有问题 —— 它就是"未查"（本仓第 35 类：窗口内没有 ≠ 不存在）。
{
  // ⚠ 2026-09-14 夜（D.1）：那四个工具**已经核过了** —— `plugins/dsh-ui-drive/test/render-actions.test.mjs`
  //   用同一套做法（从生产者读 enum + 手写真实返回形状 + 不许出现编造的量）把它们核了一遍，
  //   并且**一核就抓到 5 处**（capture / expectwindow / expecttext / waitany 掉进 default 渲染成「完成」，
  //   结构化数据被吞）。所以钉子按"只许缩短"的规矩拔掉 —— 这四个工具现在必须在 COVERED 里。
  const COVERED = new Set(['perf_trace', 'ui_drive', 'ui_observe', 'ui_act', 'ui_live'])
  const KNOWN_UNCOVERED = []   // 钉子：只许缩短（已空；新工具带 action enum 就会立刻红）
  const enumTools = []
  {
    const { readdirSync, existsSync } = await import('node:fs')
    for (const d of readdirSync(join(HERE, '..', '..'))) {
      const p = join(HERE, '..', '..', d, 'index.js')
      if (!existsSync(p)) continue
      const src = readFileSync(p, 'utf8')
      const re = /defineTool\(\s*\{/g
      let m
      while ((m = re.exec(src))) {
        // 大括号配平取整个工具块（简易但足够：源文件是定型的）
        let i = re.lastIndex - 1, depth = 0, j = i
        for (; j < src.length; j++) { const c = src[j]; if (c === '{') depth++; else if (c === '}') { depth--; if (depth === 0) break } }
        const block = src.slice(i, j + 1)
        const nm = block.match(/name:\s*'([^']+)'/)
        if (nm && /action:\s*\{[^}]*enum:\s*\[/.test(block)) enumTools.push(nm[1])
      }
    }
  }
  check('★ 扫到了声明 action enum 的工具（读到 0 个 = 本节的守卫已失效 ⇒ 空断言）',
    enumTools.length >= 5, JSON.stringify(enumTools))
  const uncovered = enumTools.filter((t) => !COVERED.has(t))
  const newlyUncovered = uncovered.filter((t) => !KNOWN_UNCOVERED.includes(t))
  check('★★ 新出现的"声明 action enum 但渲染层未核"的工具（新工具带 action 就要一起核渲染）',
    newlyUncovered.length === 0, '新增未覆盖：' + newlyUncovered.join(', '))
  check('★ 未覆盖清单只许缩小：现在 ' + uncovered.length + ' 个（钉子 ' + KNOWN_UNCOVERED.length + '）',
    uncovered.length <= KNOWN_UNCOVERED.length, '实际：' + uncovered.join(', '))
  // 哨兵：已覆盖的列表不许出现僵尸（登记了但工具没了）
  const zombies = [...COVERED].filter((t) => !enumTools.includes(t))
  check('★ 已覆盖清单没有僵尸项', zombies.length === 0, zombies.join(', '))
  console.log('       （action enum 工具：' + enumTools.join(', ') + '；已核渲染：' + [...COVERED].join(', ') +
    '；**未查（不等于有问题）**：' + uncovered.join(', ') + '）')
}

// ── ⑧ R1-14：**通道（engine）必须印出来** ─────────────────────────────────────────
//   由来（r61 真机冒烟）：第一版把 engine 放进**返回值**、**没放进渲染** ⇒ 调用方从 "trace 完成…" 里
//   读不出这次走的是 WPR 还是 xperf，而两者后果不同（xperf 要靠 `-merge` 才有模块归属）。
//   与 R1-06「渲染层吞掉结构化结果」同源：**结构化字段进了返回值 ≠ 进了人话**。
{
  const runXperf = renderTrace({ ok: true, etlPath: 'D:\\ev\\trace.etl', sizeBytes: 173 * 1024 * 1024, seconds: 5, profiles: ['CPU', 'DotNet'], engine: 'xperf' })
  check('★★ 完成行里印出通道（xperf）', /通道 xperf/.test(runXperf), runXperf.slice(0, 150))
  check('★★ xperf 通道要连带说明"模块归属来自 -merge"（否则用户不知道为什么要合并）',
    /-merge/.test(runXperf) && /模块归属/.test(runXperf), runXperf.slice(0, 200))
  const runWpr = renderTrace({ ok: true, etlPath: 'D:\\ev\\trace.etl', sizeBytes: 173 * 1024 * 1024, seconds: 5, profiles: ['CPU', 'DotNet'], engine: 'wpr' })
  check('★ WPR 通道也印，且不误导成"需要 merge"', /通道 wpr/.test(runWpr) && !/-merge/.test(runWpr), runWpr.slice(0, 160))
  const started = renderTrace({ ok: true, started: true, etlPath: 'D:\\ev\\trace.etl', profiles: ['CPU', 'DotNet'], engine: 'xperf' })
  check('★ start 的"已开始采集"也要带通道（不然复现完才发现走错通道）', /通道 xperf/.test(started), started.slice(0, 160))
  const legacy = renderTrace({ ok: true, etlPath: 'D:\\ev\\trace.etl', sizeBytes: 1024, seconds: 5, profiles: ['CPU'] })
  check('★★ 值里**没有** engine 时不许臆造通道，如实写"未回报"',
    /通道未回报/.test(legacy) && !/通道 wpr/.test(legacy) && !/通道 xperf/.test(legacy), legacy.slice(0, 160))
  check('★ 缺 engine 时其余文案不变（零回归）', /trace 完成/.test(legacy) && /预设 CPU/.test(legacy), legacy.slice(0, 160))
}

if (failures) { console.log(`\nFAILED: ${failures} 项`); process.exit(1) }
console.log('\nPASS: perf_trace 渲染层与生产者的 action 分支对齐（含"不给不存在的文件编尺寸"、通道必须印出来、新增 action 的哨兵）')
