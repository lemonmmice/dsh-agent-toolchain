/**
 * dsh-perf — DSH 插件（host 侧）：性能剖析。
 * 与 hang-inspector（卡死）互补，覆盖「卡顿」（UI 线程 500ms~数秒阻塞）与内存泄漏初筛：
 *  - perf_probe：窗口消息延迟采样（SendMessageTimeout 实测耗时），P50/P95/P99 + 卡顿事件
 *  - perf_dump：procdump 抓全 dump → DumpStack(ClrMD) 自动分析 UI 线程栈 + 锁热点线程
 *  - perf_heap：托管堆类型统计 Top N（泄漏初筛）
 *  - perf_analyze：对已有 dump 重分析
 */
import { defineTool } from '@deepseek-ai/dsh-tools'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { basename, extname, join } from 'node:path'
import { homedir } from 'node:os'
import { makePerf } from './lib/perf.mjs'
import { makeTrace } from './lib/trace.mjs'
import { cleanEvidence, renderClean } from './lib/evidence-clean.mjs'
// 渲染层单独成模块：它是 agent 唯一看得见的契约，必须能离线单测（见 lib/render.mjs 顶部说明）。
import { renderProbe, renderReport, renderTrace, renderHotstacks, renderAnalysis } from './lib/render.mjs'
import { envOr } from '../../lib/env-fallback.mjs'

export const name = 'dsh-perf'

export const inject = ['tools', 'systemPrompt', 'webServer']

const SECTION_ORDER = 146
const API = '/api/dsh-perf'

const GUIDANCE =
  '本机已安装 dsh-perf 插件（DSH 的性能剖析面板）：与 hang-inspector（卡死分析）互补，覆盖 UI「卡顿」（500ms~数秒阻塞）与内存泄漏初筛。' +
  '工具：perf_probe(seconds, thresholdMs, capture=log|shot|dump) 循环给目标客户端主窗口发消息实测响应耗时（空闲毫秒级、UI 忙则同步挂起），统计 P50/P95/P99 并记录每次超过阈值的卡顿事件，capture=shot 时卡顿瞬间截图，capture=dump 时首次卡顿抓全 dump；' +
  '**注意它的测量口径（本机标定）**：只测 UI 线程消息泵 —— 非 UI 线程的卡顿（GC/IO/后台线程）测不到（后台阻塞 2000ms → 命中 0 次、max 8~9ms）；P50 恒为 0ms 是常态；「0 次卡顿」不等于客户端流畅；要抓 ≥500ms 卡顿请把阈值设成 200~300、采样 100~150ms；' +
  'perf_report 读最近一次监测报告；perf_dump(note) 按需 procdump 抓全 dump 并自动 DumpStack(ClrMD) 分析（UI 线程栈 + 锁热点线程）；' +
  'perf_analyze(dumpPath) 对已有 dump 重分析；perf_heap(dumpPath, topN) 托管堆类型统计 Top N（对象数/总大小，内存泄漏初筛）；' +
  'perf_trace(action, seconds, profile, tag, etlPath) + perf_hotstacks(etlPath, focus, process, topN, minHits) = **ETW 采样剖析**：' +
  '连续采样后可得到「最热函数排行」与「每个函数的调用者/被调用者（蝶形视图）」，即**完整调用链** —— ' +
  '这是"某串代码导致图表反复重绘、但不知道是哪一串"这类**间歇性**卡顿的正解（dump 只抓一个瞬间、抓不到就只能猜）。' +
  'perf_trace 需要 DSH 以管理员身份运行（ETW 内核会话），.etl 可能数百 MB；perf_hotstacks 支持 focus 正则聚焦，' +
  '并会在首行如实报告**符号未解析比例**（未解析多时先配 DSH_PERF_SYMBOL_PATH 再看结论）。' +
  '分工：偶发 500ms~2s 卡顿用 perf_probe/dump；完全无响应用 hang-inspector 的卡死流程；怀疑内存涨用 perf_dump + perf_heap 对比两次 dump。' +
  '注意：dump 文件较大（数百 MB，在 ~/.dsh-agent-toolchain/perf-evidence），分析完可让用户确认后删除；procdump 挂起进程几秒，用户界面会短暂冻结。' +
  '证据目录默认 ~/.dsh-agent-toolchain/perf-evidence（DSH_PERF_EVIDENCE_DIR 可覆盖），源码根由 DSH_PERF_SRC_ROOT 指定。' +
  '用户提到「性能剖析 / 卡顿分析 / 内存泄漏 / 抓 dump 分析 / 性能证据」时即指本插件，请据此协作。'

let perf = null
function prf() {
  if (!perf) {
    // 配置统一走 env-fallback（进程环境 → 用户级注册表 → 机器级）：DSH 宿主是长活进程，
    // 用户后来设置的用户级变量在它的环境块里**看不到** —— 直接读 process.env 会把"用户已经配好"
    // 读成"没配置"，于是 perf_dump/perf_trace 找不到目标进程，而报错还教用户去设置（他已经设过了）。
    // 同批插件里 ui-drive/perf 的 lib 层早就用了 envOr；这里是 DSH 面的**配置入口**，漏了同样会中招。
    perf = makePerf({
      scriptsDir: join(import.meta.dirname, 'scripts'),
      procName: envOr('DSH_UI_PROC_NAME'),
      windowName: envOr('DSH_UI_WINDOW_NAME'),
      evidenceDir: envOr('DSH_PERF_EVIDENCE_DIR') || join(homedir(), '.dsh-agent-toolchain', 'perf-evidence'),
      srcRoot: envOr('DSH_PERF_SRC_ROOT'),
    })
  }
  return perf
}

let tracer = null
function trc() {
  if (!tracer) {
    tracer = makeTrace({
      evidenceDir: envOr('DSH_PERF_EVIDENCE_DIR') || join(homedir(), '.dsh-agent-toolchain', 'perf-evidence'),
      procName: envOr('DSH_UI_PROC_NAME'),
    })
  }
  return tracer
}

const OBJECT = { type: 'object', additionalProperties: true }

const tools = () => [
  defineTool({
    name: 'perf_probe',
    description:
      // ★ F-041（2026-09-12 r35，**由 G1 黑盒测试抓出**）：
      //   黑盒测试的原话：「三题里**唯一**"按名字与 Triggers 选、但会选错"的工具，而且误用**不报错** ——
      //   它会一本正经地返回"0 次卡顿"，让我拿着**假阴性**去告诉用户"客户端不卡"。」
      //   原因：Triggers 写的是「卡顿分析 / 测卡顿」，于是"界面一顿一顿、要哪串代码"的第一反应就是它；
      //   而**那条真正的路由句**（"要调用链请用 perf_trace/perf_hotstacks"）埋在**第四段末尾**，
      //   按触发词选工具的人根本读不到。
      //   修法：把这句**提到第一句**，并同步改 Triggers 限定作用域。
      //   判据：**"我该用哪个工具"不能只写在描述的后半段** —— 第一句就要能拦住误用。
      '**UI 线程卡顿「检测器」（不出调用链）。** 要回答「**是哪串代码 / 哪个调用链**导致的卡顿」，**不要用本工具**，' +
      '直接 `perf_trace` → `perf_hotstacks`。本工具只做一件事：循环测客户端主窗口消息响应耗时（空闲毫秒级、UI 忙则同步挂起），' +
      '统计 P50/P95/P99、记录每次超过阈值的卡顿事件，capture=shot 时卡顿瞬间截图，capture=dump 时首次卡顿自动抓全 dump。返回报告 JSON 与证据目录。' +
      '**测量口径（2026-09-11 本机标定，必读）**：只测 **UI 线程消息泵** —— ①非 UI 线程的卡顿（GC/IO/worker/后台线程）**结构性测不到**（标定：后台线程每 3s 阻塞 2000ms → 110~191 个样本命中 0 次、max 仅 8~9ms，与空闲无异）；' +
      '②阻塞若完全落在两次采样之间会整段错过（120ms 阻塞在 100ms 采样下只中 1/5）；③**P50 恒为 0ms** 是常态（周期性卡顿下多数采样落在空闲期），判断卡顿看 max 与命中数；' +
      '④「0 次卡顿」只说明 UI 线程没有超过阈值的阻塞，**不等于客户端流畅** —— **不要拿它下"客户端不卡"的结论**。调参：找 ≥500ms 卡顿用 thresholdMs 200~300（别正好取 500 —— 实测 500ms 阻塞测得 492ms 会被阈值挡掉）、intervalMs 100~150；' +
      '非 UI 线程的卡顿请改用 `perf_trace`/`perf_hotstacks`（调用链）或 `perf_dump`。Triggers: 卡顿分析（**仅限 UI 线程阻塞**）/ 测卡顿 / 性能监测 / UI stutter.',
    parameters: {
      seconds: { type: 'number', description: '监测时长秒数，默认 60（建议用户操作复现卡顿的操作场景）' },
      thresholdMs: { type: 'number', description: '卡顿判定阈值毫秒，默认 500。注意：阈值取 500 时，恰好 500ms 的阻塞（实测 492~513ms）会被判不出 —— 要抓这类卡顿请用 200~300' },
      capture: { type: 'string', enum: ['log', 'shot', 'dump'], description: 'log（默认，只记录）| shot（卡顿时截图）| dump（首次卡顿抓全 dump，数百 MB）' },
      intervalMs: { type: 'number', description: '采样间隔毫秒，默认 300。阻塞时长与采样间隔同量级时命中率骤降（120ms 阻塞 + 100ms 采样 → 1/5），要抓短卡顿请调小' },
    },
    output: { schema: OBJECT, render: (_a, v) => [{ type: 'text', text: renderProbe(v) }] },
    timeoutMs: 62 * 60 * 1000,
    async execute(args) {
      return await prf().probe(args)
    },
  }),
  defineTool({
    name: 'perf_report',
    description: '读**最近一次** perf_probe 的监测报告（P50/P95/P99/卡顿事件列表）。它读的是"上一次"、不保证是刚才 —— 返回里带报告时间与陈旧告警，**先看它再下结论**。Triggers: 上次卡顿结果 / 性能报告.',
    parameters: {},
    output: { schema: OBJECT, render: (_a, v) => [{ type: 'text', text: renderReport(v) }] },
    async execute() {
      return prf().report()
    },
  }),
  defineTool({
    name: 'perf_dump',
    description: '抓**此刻**的现场快照（procdump -ma，会挂起进程几秒）并自动分析：UI 线程托管栈 + 锁热点线程 Top 5；**返回 dumpPath**（可直接喂 perf_analyze / perf_heap）。⚠ 它只回答"**此刻谁在栈上**"，**不回答**"谁在反复调用它" —— 间歇性卡顿/重绘风暴请用 perf_trace → perf_hotstacks；客户端已经卡死时**先用它取证**，不要先 ui_launch(force=true) 把现场杀掉。' +
      '**代码级证据（行号）走这条通路**：dump 分析会顺带做**源码映射**（配了 DSH_PERF_SRC_ROOT 时给出 `← 相对路径:行号`）——"到底哪一行"从这里拿；' +
      '而 ETW 那条（perf_hotstacks）**只到 `模块!类型.方法`，不做源码映射**，别指望它给行号。Triggers: 抓 dump / 抓内存快照 / dump 分析 / 卡死现场取证.',
    parameters: {
      note: { type: 'string', description: '场景备注（写入证据目录 note.txt）' },
    },
    output: { schema: OBJECT, render: (_a, v) => [{ type: 'text', text: v.ok ? ('dump: ' + v.dumpPath + '（' + (v.sizeBytes / 1024 / 1024).toFixed(0) + 'MB，' + (v.durationMs / 1000).toFixed(1) + 's）\n' + renderAnalysis(v.analysis)) : ('失败：' + v.error) }] },
    timeoutMs: 6 * 60 * 1000,
    async execute(args) {
      return await prf().dump(args)
    },
  }),
  defineTool({
    name: 'perf_analyze',
    description: '对**已有** dump 文件跑 DumpStack(ClrMD) 分析：UI 线程栈 + 锁热点线程。dump 从哪来：perf_dump 返回的 `dumpPath`（或 perf_probe(capture="dump") / hang 证据包里的 frozen.dmp）。Triggers: 分析 dump / 重新分析 dump.',
    parameters: {
      dumpPath: { type: 'string', required: true, description: 'dump 文件绝对路径' },
    },
    output: { schema: OBJECT, render: (_a, v) => [{ type: 'text', text: v.ok ? renderAnalysis(v) : ('失败：' + v.error) }] },
    timeoutMs: 6 * 60 * 1000,
    async execute(args) {
      return await prf().analyzeDump(args.dumpPath)
    },
  }),
  defineTool({
    name: 'perf_heap',
    description: '**托管堆**类型统计 Top N（对象数/总字节），内存泄漏初筛——两次 dump 对比同一类型的对象数增长即泄漏嫌疑。' +
      '⚠ **测量口径（先读再下结论）**：① 只统计**托管堆**；WPF 客户端的内存大头常常是**非托管**（位图/字体句柄/COM/native 缓冲）' +
      '与**地址空间碎片**，这些**结构性测不到** —— 所以「托管堆没涨」**不能**推出「没有泄漏」；② 两次采样之间的**未回收垃圾**会被读成增长' +
      '（对比时请让用户先静置/触发一次 GC，或把间隔拉长）；③ 输出只有**类型 + 字节数**，**没有保留链 / GC root 路径** ⇒ 它能告诉你' +
      '「哪个类型在涨」，**答不了**「哪段代码泄漏」；④ 用户说的「内存」多半是**任务管理器的工作集**，与本工具的托管堆口径**不是一回事**，' +
      '收尾时请分开报。Triggers: 堆统计 / 内存泄漏 / heap stats / 托管堆.',
    parameters: {
      dumpPath: { type: 'string', required: true, description: 'dump 文件绝对路径' },
      topN: { type: 'number', description: 'Top N 类型，默认 30' },
    },
    output: { schema: OBJECT, render: (_a, v) => [{ type: 'text', text: v.ok ? ('堆对象总数 ' + v.totalObjects + ' / ' + (v.totalSizeBytes / 1024 / 1024).toFixed(1) + 'MB，Top 类型（按占用）：\n' + (v.top || []).slice(0, 15).map((t) => t.type + ' x' + t.count + ' = ' + (t.sizeBytes / 1024 / 1024).toFixed(1) + 'MB').join('\n')) : ('失败：' + v.error) }] },
    timeoutMs: 6 * 60 * 1000,
    async execute(args) {
      return await prf().heapStats(args.dumpPath, args.topN)
    },
  }),
  defineTool({
    name: 'perf_trace',
    description: 'ETW 采样剖析（**要"从卡顿走到完整调用链"就用它**，别靠猜）。action=start 起采样 → 你复现问题 → action=stop 产出 .etl（或 action=run 限时自动停）。' +
      '与 dump 的分工：perf_dump 是**一个瞬间**的快照，只能回答"此刻谁在栈上"；本工具连续采样，能回答"**谁在反复调用它、它又调用了谁**"，因此对间歇性卡顿/重绘风暴才有效。' +
      '采集同时启用 CPU 与 DotNet 预设（少了 DotNet 就解不出托管方法名）。要求：**DSH 需以管理员身份运行**（ETW 内核会话），且 .etl 可能数百 MB。' +
      '跑完用 perf_hotstacks 出调用链。Triggers: 抓 trace / 调用链 / 重绘卡顿定位 / ETW 采样.',
    parameters: {
      action: { type: 'string', enum: ['start', 'stop', 'run', 'cancel', 'status'], description: 'start（起采样，等你复现）| stop（停并产出 etl）| run（默认：起→等 seconds 秒→停）| cancel（放弃）| status（**查采样在不在跑**：running / 已跑多久 / 当前 etl 大小；running 的依据是我们 start 时写的会话标记，不是查询 xperf —— 另有 samplerProcessFound 作旁证，null = 查不到）' },
      seconds: { type: 'number', description: 'action=run 时的采集秒数，默认 20（建议够你复现一次问题）' },
      profile: { type: 'string', enum: ['cpu', 'dotnet', 'general'], description: 'cpu（默认，= CPU+DotNet，能解托管名）| dotnet | general' },
      tag: { type: 'string', description: '证据目录后缀标签，便于归档（如 repaint-storm）' },
      etlPath: { type: 'string', description: 'action=stop 时指定要停到哪个 .etl（填 start 返回的 etlPath）' },
      // ★ R1-12：采集**单点依赖 WPR**，而 WPR 的 `-stop` 会坏（本机 2026-09-15 实测：start 正常、stop 报
      //   0x80010106 且**不产出 etl**；注意实测**退出码是 -2147417850，不是 0** —— 判据始终是"有没有 etl 文件"）
      //   ⇒ 失败点落在"用户已经复现完"之后，**白跑一轮**。所以 start 前先用 1~2 秒探针问清楚。
      //   ★ R1-14：auto 还会拿这个结论**自动换 xperf 通道**（xperf 采集不依赖 WPR 收尾）。
      engine: { type: 'string', enum: ['auto', 'wpr', 'xperf'], description: '采集通道（默认 auto）：auto = 自检说"这台机器的 WPR 收不了尾"就自动改用 xperf，否则走 WPR；wpr = 强制 WPR；xperf = 强制 xperf。xperf 通道收尾时会自动多做一步 `xperf -merge` —— **模块归属只在合并那一步产生**（不合并的报告连模块名都是 ***unknown***）' },
      skipPreflight: { type: 'boolean', description: 'true = 跳过"采集前自检"（默认 false）。自检会用 1~2 秒起一个极小 WPR 会话并立刻收尾，验证**这台机器的 WPR 能不能收尾**；engine=auto 时它同时决定走哪条通道；显式 engine="wpr" 且自检不通过时，start 仍会执行但返回值带 warning（告诉你这次很可能产不出 etl）' },
    },
    output: { schema: OBJECT, render: (_a, v) => [{ type: 'text', text: renderTrace(v) }] },
    timeoutMs: 20 * 60 * 1000,
    async execute(args) {
      return await trc().trace(args)
    },
  }),
  defineTool({
    name: 'perf_clean',
    description: '清理 **perf 证据目录**里的证据大件（.dmp / .etl）—— G1 黑盒点名的缺口：做完一次内存/性能排查会留下几百 MB，而工具链里**没有任何一个能删**。' +
      '行为：**默认只看不删**（先列出命中的文件与总字节数），确认后才传 confirm=true；只删自己能认出来的扩展名（.dmp/.etl），**绝不递归、绝不删目录本身**；' +
      '**采样进行中不删 etl**（trace-session.json 在盘上时跳过，那可能正是它在写的文件）。' +
      '参数：what=dumps|etls|all（默认 all）、keepDays=N（只删 N 天前的，默认不限）。Triggers: 清理证据 / perf 目录太大 / 删 dump / 删 etl / clean evidence.',
    parameters: {
      confirm: { type: 'boolean', description: '**必须显式传 true 才会真的删**。不传（或 false）= 只列出将要删除的文件与总字节数（dry-run）。删除不可恢复。' },
      what: { type: 'string', enum: ['dumps', 'etls', 'all'], description: '删哪一类：dumps=只删 .dmp；etls=只删 .etl；all=两者（默认）' },
      keepDays: { type: 'number', description: '只删**修改时间早于** N 天的文件（默认不限 ⇒ 命中全部）。想让最近一次排查的证据留着就传它。' },
    },
    output: { schema: OBJECT, render: (_a, v) => [{ type: 'text', text: renderClean(v) }] },
    async execute(args) {
      return cleanEvidence({ dir: prf().evidenceDir(), confirm: args.confirm === true, what: args.what, keepDays: args.keepDays })
    },
  }),
  defineTool({
    name: 'perf_hotstacks',
    description: '从 .etl 出**调用链**：最热函数排行（谁占 CPU）+ 蝶形视图（每个函数的**调用者 <-- 与 --> 被调用者**，带命中数）。' +
      'focus 可只保留名字匹配该正则的函数（例如 focus="SciChart|KLine|你怀疑的那层"），把几 MB 的报告压成一条可读的因果链。' +
      '注意：**符号未解析的比例会在结果首行如实给出** —— 若显示大量未解析，先确认符号路径（DSH_PERF_SYMBOL_PATH）再看结论，否则"没解析出来"会被误当成"没有这段代码"。' +
      '出报告耗时的关键是**符号**：符号缓存跨运行共享（默认 evidenceDir/symbol-cache，DSH_PERF_SYMBOL_CACHE 可覆盖），所以同一个 etl 重跑通常快很多；' +
      '首次分析某台机器会从微软公网下载 pdb（实测可达 1GB+、几十分钟）。若超时，症状是 xperf 长时间 ~0% CPU 且报告 0 字节 —— 这时**别调小 timeoutMs**，改为：加 process 过滤、用 focus 收窄、或先 offline:true 只拿原生帧。' +
      'Triggers: 出调用链 / 热点栈 / 谁调用了它 / hotstacks.',
    parameters: {
      etlPath: { type: 'string', required: true, description: 'perf_trace 产出的 .etl 绝对路径' },
      focus: { type: 'string', description: '正则：只保留名字匹配的函数（模块名或方法名片段，如 SciChart|OnRender|你的 VM 名）' },
      process: { type: 'string', description: '进程名正则（**建议填**：默认用 DSH_UI_PROC_NAME；不填=报告含全系统栈，统计更杂）。注意：它只筛选**统计口径**，不会减少符号解码量' },
      topN: { type: 'number', description: '排行/链条数，默认 15' },
      minHits: { type: 'number', description: '蝶形视图最小命中数，默认 5（调大更聚焦、调小更全）' },
      offline: { type: 'boolean', description: 'true = 不配符号服务器（快，但原生帧多为 unknown）' },
      timeoutMs: { type: 'number', description: '出报告超时毫秒，默认 900000；系统级 trace 需要调大或改用 process 过滤' },
      debugSymbols: { type: 'boolean', description: 'true = 让 xperf 打印符号查找细节（结果在 xperfRaw，成功/失败都有）。仅当怀疑「卡在符号解码」时用：症状是 xperf 长时间 ~0% CPU 且报告一直 0 字节' },
    },
    output: { schema: OBJECT, render: (_a, v) => [{ type: 'text', text: renderHotstacks(v) }] },
    timeoutMs: 30 * 60 * 1000,
    async execute(args) {
      return await trc().hotstacks(args)
    },
  }),
]

// 渲染函数已抽到 ./lib/render.mjs（可离线单测；F-001 的回归测试钉在那里）。

// ---------------------------------------------------------------- Web 路由（仅回环）

function isLoopbackRequest(request) {
  const address = request.socket.remoteAddress
  if (address !== '127.0.0.1' && address !== '::1' && address !== '::ffff:127.0.0.1') return false
  const host = request.headers.host
  if (typeof host !== 'string') return false
  let hostUrl
  try { hostUrl = new URL('http://' + host) } catch { return false }
  if (hostUrl.hostname !== '127.0.0.1' && hostUrl.hostname !== 'localhost' && hostUrl.hostname !== '[::1]') return false
  if (request.headers['sec-fetch-site'] === 'cross-site') return false
  const origin = request.headers.origin
  if (origin === undefined) return true
  try { return new URL(origin).host === hostUrl.host } catch { return false }
}

function writeJson(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'referrer-policy': 'no-referrer' })
  res.end(JSON.stringify(body))
}

const MIME = { '.png': 'image/png', '.json': 'application/json; charset=utf-8', '.txt': 'text/plain; charset=utf-8' }

function makeRoutes() {
  return [
    {
      kind: 'prefix',
      path: API,
      handler: async (req, res) => {
        if (!isLoopbackRequest(req)) { writeJson(res, 403, { error: 'forbidden: loopback-only' }); return }
        const method = req.method || 'GET'
        const rest = (req.url || '').split('?')[0].slice(API.length) || '/'

        if (method === 'GET' && rest === '/status') {
          writeJson(res, 200, {
            plugin: 'dsh-perf',
            evidenceDir: prf().evidenceDir(),
            dumpstackOk: existsSync(prf().config.dumpstack),
            procdumpOk: existsSync(prf().config.procdump),
            probeScriptOk: existsSync(join(prf().config.scriptsDir, 'perf-probe.ps1')),
          })
          return
        }
        if (method === 'GET' && rest === '/evidence') {
          writeJson(res, 200, { root: prf().evidenceDir(), dirs: prf().listEvidence(50) })
          return
        }
        const evMatch = rest.match(/^\/evidence\/([^/]+)$/)
        if (method === 'GET' && evMatch !== null) {
          const id = decodeURIComponent(evMatch[1])
          if (id.includes('..') || id.includes('\\')) { writeJson(res, 400, { error: 'bad id' }); return }
          const p = join(prf().evidenceDir(), id, 'report.json')
          if (!existsSync(p)) { writeJson(res, 404, { error: 'report.json not found' }); return }
          try { writeJson(res, 200, JSON.parse(readFileSync(p, 'utf8'))) } catch { writeJson(res, 500, { error: 'parse failed' }) }
          return
        }
        const fileMatch = rest.match(/^\/evidence\/([^/]+)\/files\/([^/]+)$/)
        if (method === 'GET' && fileMatch !== null) {
          const id = decodeURIComponent(fileMatch[1])
          const file = decodeURIComponent(fileMatch[2])
          if (id.includes('..') || id.includes('\\') || file.includes('..') || file.includes('\\') || file.includes('/')) { writeJson(res, 400, { error: 'bad path' }); return }
          const p = join(prf().evidenceDir(), id, file)
          if (!existsSync(p)) { writeJson(res, 404, { error: 'file not found' }); return }
          const ct = MIME[extname(file).toLowerCase()] || 'application/octet-stream'
          res.writeHead(200, { 'content-type': ct, 'referrer-policy': 'no-referrer', 'content-length': statSync(p).size })
          res.end(readFileSync(p))
          return
        }
        writeJson(res, 404, { error: 'not found' })
      },
    },
  ]
}

export function apply(ctx) {
  ctx.effect(
    () => {
      const disposers = []
      for (const tool of tools()) disposers.push(ctx.tools.register(tool))
      const routeDisposers = makeRoutes().map((route) => ctx.webServer.register(route))
      const disposeSection = ctx.systemPrompt.section({ name: 'plugin:dsh-perf', order: SECTION_ORDER, text: GUIDANCE })
      return () => {
        for (const d of disposers) d()
        for (const d of routeDisposers) d()
        disposeSection()
      }
    },
    'dsh-perf: tools+routes',
  )
}
