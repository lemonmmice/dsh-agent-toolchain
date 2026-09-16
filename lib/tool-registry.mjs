/**
 * W1 —— 工具元数据**单一真源**（registry）。见 CODEX-STEAL-ANALYSIS-20260916.md「第二部分 W1」。
 *
 * 病：同一个工具在**两面**各声明一次 —— DSH 插件面（`defineTool({...})`，纯 JSON Schema）与
 * MCP 面（`server.tool(...)`，zod）。参数集/enum/描述靠 `toolface-*` 守卫**事后**兜漂移；每加一个
 * 参数都要手改两处（W4 加 `background` 就是两处各改一遍）。
 *
 * 解法（抄 Codex 的工具注册表）：把**共享元数据**收进这里一处 ——
 *   · 工具名（两面仍以**字面量**出现在各自 `server.tool('x'` / `defineTool({name:'x'})`，
 *     以满足守卫"名字必须是字面量、静态扫描要等于运行时"的硬约束）；
 *   · 参数**结构**（type / enum / default / optional / required）—— 两面由同一份生成，天然不漂移；
 *   · 描述文本：两面语言不同（DSH 中文、MCP 英文，这是既有的、守卫不校验的差异），
 *     所以**两种都存在这里、co-locate**，改一个工具时两种描述在同一处可一起审。
 *
 * 本文件**不 import zod**（DSH 插件运行在宿主里，走 @deepseek-ai/dsh-tools，不保证有 zod）。
 * MCP 侧的 zod 生成在 `mcp/registry-zod.mjs`，只在 MCP 进程里加载。
 *
 * 首个接入家族：build_*（4 个工具，非 ui、zod 简单，可用 toolface 守卫在任意平台验证）。
 * 其余家族逐个接入；ui_* 因带内联 enum 的专属守卫，接入时一并把那条守卫改成"从本表读 enum"。
 */

/**
 * 参数中性描述（neutral spec）。字段：
 *   name      参数名
 *   type      'string' | 'boolean'（enum 也用 'string'，另给 enum 数组 —— 与 DSH 现状一致）
 *   enum      可选，取值数组
 *   mcpDefault 可选，MCP 侧 zod 的 .default(x)（DSH 侧不表达默认值，仅写在描述里）
 *   required  可选，true = 必填（DSH 写进 property.required，MCP zod 不加 .optional()）
 *   optional  既非 required 也无 mcpDefault 时应为 true（MCP zod 加 .optional()）
 *   zh / en   两面各自的描述文本（en 为空串 = MCP 侧不调 .describe()）
 */

const P = {
  target: { name: 'target', type: 'string', enum: ['Build', 'Rebuild'], mcpDefault: 'Build',
    zh: 'Build（增量，默认）或 Rebuild（全量）', en: 'Build (incremental, fast) or Rebuild (full)' },
  project: { name: 'project', type: 'string', optional: true,
    zh: '可选：定向工程/.sln（相对仓库根）；空=自动探测默认解决方案（WholeSolution.sln 优先）',
    en: 'Optional csproj/sln path relative to the repo root; empty = auto-detected default solution (both engines; dotnet falls back to the cwd default when the repo has no solution)' },
  configuration: { name: 'configuration', type: 'string', mcpDefault: 'Debug',
    zh: '默认 Debug', en: '' },
  platform: { name: 'platform', type: 'string', optional: true,
    zh: '可选：默认按布局自动解析（老布局 x86 / 从 .sln 探测，Any CPU 优先）',
    en: 'msbuild engine: default auto (legacy x86 for the WholeSolution.sln layout, otherwise detected from the solution); dotnet engine: ignored' },
  engine: { name: 'engine', type: 'string', enum: ['msbuild', 'dotnet'], optional: true,
    zh: '可选：msbuild（默认，VS MSBuild）或 dotnet（dotnet build，现代 SDK 仓库推荐）',
    en: 'Build engine; env DSH_BUILD_ENGINE sets the default' },
  repoRoot: { name: 'repoRoot', type: 'string', optional: true,
    zh: '可选：仓库根目录（默认 DSH_BUILD_REPO_ROOT / DSH_BUILD_CLIENT_ROOT）',
    en: 'Repository root dir (env DSH_BUILD_REPO_ROOT)' },
  clientRoot: { name: 'clientRoot', type: 'string', optional: true,
    zh: '可选：客户端/解决方案根目录（等价于 repoRoot，优先于环境变量 DSH_BUILD_CLIENT_ROOT）',
    en: 'Solution root dir (env DSH_BUILD_CLIENT_ROOT)' },
  killClient: { name: 'killClient', type: 'boolean', optional: true,
    zh: '客户端在运行时强制结束它再构建（会打断用户界面，需先确认）。⚠ **与 ui_launch(force=true) 同样会销毁唯一现场**：客户端卡死/卡顿要先取证（perf_dump 抓快照、hang_run 挂监测），证据到手再杀；否则 dump/线程栈/证据包都没了',
    en: 'Kill the running client process before building (breaks the user UI — confirm first). WARNING: like ui_launch(force=true) this DESTROYS the only crime scene — if the client is hung or stuttering, capture evidence first (perf_dump / hang_run), otherwise the dump, thread stacks and evidence bundle are gone.' },
  runId: { name: 'runId', type: 'string', optional: true,
    zh: '可选：本次任务的 runId。传了才会写 run-<runId>.json 凭证记录（verify_report 的 build 类 claim 正是读这个文件；不传则只写 last.json，多 agent 并发时会互相覆盖）。建议用 who-task-n 形式，如 dsh-logon-fix-1',
    en: 'Optional run id: the build log and the per-run record (run-<runId>.json) are named with it — the evidence-pack spine' },
  background: { name: 'background', type: 'boolean', optional: true,
    zh: '可选：后台构建，**不阻塞**。true 时立即返回 jobId（=runId），真正的构建交给分离子进程去跑，用 build_status 轮询（state=running→done/crashed）。默认 false（同步，行为不变）。适合 Rebuild 这种 5-10 分钟的全量构建：先起后台，期间可继续观察客户端/干别的',
    en: 'Run the build in the BACKGROUND (non-blocking). true returns a jobId (= runId) immediately and runs build() in a detached child; poll with build_status (state=running→done/crashed). Default false (synchronous, unchanged). Use for a full Rebuild (5-10 min) so the agent can keep observing the client / do other work while it runs.' },
  // build_compile_check 专用
  ccFile: { name: 'file', type: 'string', required: true,
    zh: '源码文件路径（绝对路径，或相对 repoRoot/当前工作目录）。',
    en: 'Source file path (absolute, or relative to repoRoot/cwd)' },
  ccProject: { name: 'project', type: 'string', optional: true,
    zh: '可选：显式指定工程文件（*.csproj）。不给就从这个文件往上找；找到多个会**返回歧义**而不是随便挑一个。',
    en: 'Optional: the project file (*.csproj). Omitted = search upward from the file; several candidates return an ambiguity error instead of guessing' },
  ccRepoRoot: { name: 'repoRoot', type: 'string', optional: true,
    zh: '可选：向上查找工程的边界（默认 DSH_BUILD_CLIENT_ROOT / DSH_BUILD_REPO_ROOT / git 根）。',
    en: 'Optional boundary for the upward search (defaults to the build client/repo root)' },
}

/** build_* 家族（首个接入注册表的家族）。 */
export const REGISTRY = {
  build_run: {
    name: 'build_run',
    descZh: '运行 MSBuild 构建并结构化解析错误。默认增量 Build（快检，秒级~2分钟）；最终结论用 Rebuild（全量，5-10分钟）；project 可定向单工程/.sln（相对仓库根），**空=自动探测默认解决方案**（可能探测到**不含你改动**的那个 .sln，而"0 错误"照旧成立 ⇒ 请核对返回的目标与日志路径）。⚠ **错误数 0 ≠ 你新加的文件进了编译**（legacy .csproj 要手工 <Compile Include>，漏加时构建通过但文件根本没编）—— 要证这件事得自己验编译项或产物，本工具不替你证。返回错误列表（file/line/col/code/message）+ 日志路径。Triggers: 编译验证 / 增量编译 / 帮我编译 / 构建验证 / build.',
    descEn: 'Run a build (incremental Build or full Rebuild) and return structured errors. ' +
      'Use after changing code to verify it compiles. WARNING: zero errors does NOT prove that a newly added file was actually compiled (a legacy .csproj needs an explicit <Compile Include>; the build passes while the file is never compiled), and an empty project argument auto-detects a solution that may not contain your change — always check the returned target / log path. Requires DSH_BUILD_CLIENT_ROOT/DSH_BUILD_REPO_ROOT (solution dir) or the clientRoot/repoRoot argument. ' +
      'Both engines auto-detect the default solution when project is empty: a repo containing WholeSolution.sln keeps the legacy client defaults (WholeSolution.sln + platform x86); otherwise the .sln/.slnx is detected (repo root, then one level deep) and the platform comes from the solution (Any CPU preferred) — ambiguity is an explicit error asking for project. engine=msbuild (default) uses VS MSBuild; engine=dotnet builds with `dotnet build` (restores by default) — prefer it for modern .NET repos. (dotnet only: a repo with no solution at all falls back to the cwd default.)',
    // 顺序沿用 DSH 面（守卫比的是集合，顺序不影响；保持可读）
    params: [P.target, P.project, P.configuration, P.platform, P.engine, P.repoRoot, P.clientRoot, P.killClient, P.runId, P.background],
  },
  build_status: {
    name: 'build_status',
    descZh: '查最近一次构建结果（目标/耗时/错误数/日志路径）。Triggers: 上次编译结果 / build status.',
    descEn: 'Status of the most recent build: target, configuration, duration, error/warning counts and the ' +
      'log path. Use it to re-read a build result without re-running the build.',
    params: [],
  },
  build_errors: {
    name: 'build_errors',
    descZh: '从**最近一次**构建日志重新解析错误/警告列表（结构化 file/line/col/code/message）。⚠ 它读的是"最近一次日志"、**不保证是本次 run**（多 agent 并发时会读到别人的）：空 ≠ 没有错误，先看返回值里的日志路径/时间是不是你要的那次；要绑定本次请用 build_run 的 runId + verify_report(kind="build")。Triggers: 解析编译错误 / 查看编译错误.',
    descEn: 'Re-parse the structured error/warning list (file / line / column / code / message) out of the ' +
      'last build log. Use after build_run reports errors, or to re-read them later without rebuilding. ' +
      'WARNING: it reads the LAST log, which is not guaranteed to be from YOUR run (a concurrent agent may have overwritten it) - an empty list is NOT proof there were no errors.',
    params: [],
  },
  build_compile_check: {
    name: 'build_compile_check',
    descZh:
      '核对**一个源码文件到底进没进编译**（只读）—— 回答"编译 0 错误"答不出的那个问题。' +
      '⚠ 本仓已知陷阱：**legacy .csproj 不会自动包含 .cs**，新增文件漏写 `<Compile Include>` 时' +
      '**构建通过、文件根本没编**；而 `verify_report(kind="file")` 只验"文件存在"，会给**假 pass**（G1 黑盒 agent 原话）。' +
      '本工具按工程风格判定：legacy ⇒ 必须有显式编译项（含通配符）；SDK ⇒ 默认 glob 包含，除非显式关掉 `EnableDefaultCompileItems`；' +
      '`<Compile Remove>` 优先于 Include。**三态**：能证明"在"才说在、能证明"不在"才说不在、**读不到（文件/工程不存在、同层多工程、解析不了）一律 ok:false + 原因**，绝不说成"不在"。' +
      '不数 = 不求值 MSBuild `Condition`，条数会如实带出。Triggers: 新文件进没进编译 / 文件被编译了吗 / Compile Include / compiled?.',
    descEn: 'Check whether ONE source file is actually part of a project\'s compile set (read-only) - the question "zero build errors" cannot answer. ' +
      'KNOWN TRAP: a legacy .csproj does NOT auto-include .cs files, so a newly added file without a <Compile Include> builds fine while never being compiled ' +
      '("zero errors" and "my change is in" are different claims). verdict=(kind="file") only proves the file EXISTS and can give a false pass. ' +
      'Rules: legacy project requires an explicit compile item (wildcards supported); SDK-style includes .cs by default unless EnableDefaultCompileItems is false; <Compile Remove> beats Include. ' +
      'THREE-STATE HONESTY: it says "included" only when provable, "not included" only when provable, and returns ok:false with the reason when it cannot tell ' +
      '(file/project missing, several projects in one directory, unparsable) - never silently "not included". MSBuild Condition attributes are NOT evaluated, and the count is reported.',
    params: [P.ccFile, P.ccProject, P.ccRepoRoot],
  },
  "memory_forget": {
    "name": "memory_forget",
    "descZh": "删除一条 KV 记忆。Triggers: 忘掉之前的约定 / forget memory.",
    "descEn": "Delete one KV memory entry. Use when a stored convention no longer applies, so a later session does not act on a stale decision.",
    "params": [
      {
        "name": "key",
        "type": "string",
        "required": true,
        "zh": "记忆键名",
        "en": "Memory key to delete"
      },
      {
        "name": "scope",
        "type": "string",
        "zh": "作用域，默认 global",
        "en": "Scope (default global)"
      }
    ]
  },
  "memory_index": {
    "name": "memory_index",
    "descZh": "把本地目录索引进长期记忆向量库（增量：按文件 mtime 跳过未变更文件）。之后可用 memory_search 语义检索。隐私：数据落在本地 ~/.dsh/memory/，**但 embedding 可能出本机** —— 配置了 MiniMax key 时文件分块会发到远程 api.minimax.chat；未配置 key 时是本地 bigram、不出本机。要确认走哪条路请调 memory_status 看 embedEndpoint/note；**不要向用户承诺\"不外传\"**。Triggers: 记住这个项目 / 索引代码库 / index the repo.",
    "descEn": "Index a local directory into the long-term memory vector store (incremental: skips unchanged files by mtime; skips bin/obj/node_modules). BOUNDED: each call stops at a time budget (budgetMs, default 60000) and reports how many files remain — call it again with the same path to continue (finished files are skipped by mtime, so nothing is redone). A file is indexed all-or-nothing: if the budget runs out mid-file the partial chunks are rolled back, so a half-indexed file can never silently disappear from search. PRIVACY: when a MiniMax API key is configured, file chunks are embedded via the REMOTE api.minimax.chat endpoint — indexed content leaves this machine. Fail-closed: files containing tokens/secrets are skipped before embedding and counted as sensitiveSkipped. Multiple roots coexist; indexing one directory never deletes another directory's chunks.",
    "params": [
      {
        "name": "path",
        "type": "string",
        "required": true,
        "zh": "要索引的目录绝对路径",
        "en": "Absolute directory to index"
      },
      {
        "name": "budgetMs",
        "type": "number",
        "zh": "本次索引的时间预算（毫秒，默认 60000）。到点就停并把\"还剩多少\"如实返回；再调一次即可接着做（增量跳过已完成的文件）。",
        "en": "Time budget for this call in ms (default 60000). When it runs out the call stops and reports the remaining files; call again to continue."
      }
    ]
  },
  "memory_recall": {
    "name": "memory_recall",
    "descZh": "读取一条 KV 记忆（跨会话）。Triggers: 之前说过的约定 / recall memory.",
    "descEn": "Read a saved key-value memory.",
    "params": [
      {
        "name": "key",
        "type": "string",
        "required": true,
        "zh": "记忆键名",
        "en": ""
      },
      {
        "name": "scope",
        "type": "string",
        "mcpDefault": "global",
        "zh": "作用域，默认 global",
        "en": ""
      }
    ]
  },
  "memory_save": {
    "name": "memory_save",
    "descZh": "保存一条跨会话 KV 记忆（如项目约定、用户偏好、历史决策）。同一 key+scope 会覆盖。Triggers: 记住这个约定 / save memory.",
    "descEn": "Save a cross-session key-value memory (per scope, e.g. a project name). Same key+scope overwrites. Fail-closed: values containing tokens/API keys/secrets are rejected.",
    "params": [
      {
        "name": "key",
        "type": "string",
        "required": true,
        "zh": "记忆键名，如 \"项目约定\" 或 \"用户偏好\"",
        "en": ""
      },
      {
        "name": "value",
        "type": "string",
        "required": true,
        "zh": "记忆内容",
        "en": ""
      },
      {
        "name": "scope",
        "type": "string",
        "mcpDefault": "global",
        "zh": "作用域（如项目名），默认 global",
        "en": ""
      }
    ]
  },
  "memory_search": {
    "name": "memory_search",
    "descZh": "语义检索长期记忆（索引过的文档/代码内容）。返回最相关片段及来源文件。Triggers: 项目里怎么做的 / 检索记忆 / 查一下之前 / search memory.",
    "descEn": "Semantic search over indexed documents/code. Returns relevant snippets with source files. PRIVACY: queries are embedded via the configured backend — remote (api.minimax.chat) when a MiniMax API key is set, local bigram otherwise.",
    "params": [
      {
        "name": "query",
        "type": "string",
        "required": true,
        "zh": "检索问题或关键词",
        "en": ""
      },
      {
        "name": "k",
        "type": "number",
        "mcpDefault": 5,
        "zh": "返回条数，默认 5，最大 10",
        "en": "Results count, max 10"
      }
    ]
  },
  "memory_status": {
    "name": "memory_status",
    "descZh": "查看长期记忆状态（索引分块数、KV 条数、embedding 后端）。Triggers: 记忆状态 / memory status.",
    "descEn": "Memory store status: chunk count, KV entries, data dir, embedding backend.",
    "params": []
  },
  "hang_run": {
    "name": "hang_run",
    "descZh": "启动卡死**监测**（不是\"抓一次现场\"）。分两种情形：**客户端此刻已经卡死** → 先 `perf_dump` 把现场固定下来（进程一旦被重启，现场就没了）；**卡死不定期复现** → 用本工具挂监测、让用户照常操作。只监视目标客户端**主窗口响应性，绝不自动点击** —— 让用户按平常方式操作复现卡死，检测到无响应时自动收集证据包（冻结截图/时间线/进程信息/net-trace 尾部/探针与 procdump 日志/完整 dump）。立即返回，随后用 hang_status / hang_packs 轮询。maxSeconds>0 时自动停止（0=不限，用 hang_stop 结束）。Triggers: 抓卡死 / 启动卡死监测 / hang.",
    "descEn": "Start the hang MONITOR — this does NOT capture a freeze that already happened: if the client is frozen RIGHT NOW call perf_dump first (restarting destroys the scene); this tool is for intermittent freezes you still have to reproduce. It watches the target client main-window responsiveness WITHOUT clicking anything — the user reproduces the freeze and the monitor collects an evidence pack on detection (frozen screenshot, timeline, process info, net-trace tail, probe/procdump logs, full dump). Returns immediately; poll hang_status / hang_packs. Set maxSeconds>0 to auto-stop (0 = run until hang_stop or the script exits).",
    "params": [
      {
        "name": "maxSeconds",
        "type": "number",
        "zh": "多少秒后自动停止（0=不限，最大 86400），默认 0",
        "en": "Auto-stop after N seconds (0 = unlimited, max 86400)"
      }
    ]
  },
  "hang_status": {
    "name": "hang_status",
    "descZh": "卡死监测状态（只读）：监测进程是否在跑、pid/退出码、日志尾部。证据包用 hang_packs 列。Triggers: 卡死监测在跑吗 / hang status.",
    "descEn": "Hang-inspector status (read-only): whether the hang monitor is running, its pid/exit code, and the last 150 log lines. Evidence packs live in DSH_HANG_EVIDENCE_DIR (default ~/.dsh-agent-toolchain/hang-evidence); list them with hang_packs.",
    "params": []
  },
  "hang_stop": {
    "name": "hang_stop",
    "descZh": "停止卡死监测（结束其进程树）。**已收集的证据包会保留**。Triggers: 停卡死监测 / hang stop.",
    "descEn": "Stop the hang monitor (kills its process tree). Evidence packs already collected are kept.",
    "params": []
  },
  "hang_packs": {
    "name": "hang_packs",
    "descZh": "**列表**（只给元信息，不给正文；读正文用 hang_pack）。列出已收集的卡死证据包（新的在前）：id、时间、文件清单、dump 大小、是否有冻结截图、分析状态、summary 首行。读全文证据用 hang_pack，跑分析用 hang_analyze。**注意年龄**：几小时前的包不能用来解释刚发生的卡死。Triggers: 卡死证据包 / 有哪些 dump / hang packs.",
    "descEn": "List collected hang evidence packs, newest first: id, timestamp, file list, dump size, screenshot presence, analysis status, and the first line of summary.txt / process-info.txt. Use hang_pack for the full text evidence.",
    "params": []
  },
  "hang_pack": {
    "name": "hang_pack",
    "descZh": "读**一个**卡死证据包的全文证据（**单体**：先 hang_packs 拿 id，再读它；本工具不吃路径、只吃 id）：summary / process-info / net-trace 尾部 / 探针与 procdump 日志（各截断 512KB）+ 文件清单 + 缓存的 analysis.json。冻结截图是包目录里的 frozen-screen.png，需要看图时把该路径交给视觉工具。Triggers: 看卡死证据 / 证据包内容 / hang pack.",
    "descEn": "Read one evidence pack in full (read-only): every text evidence file (summary / process-info / net-trace tail / probe + procdump logs, each capped at 512KB), the file list, and the cached analysis.json. The frozen screenshot is a PNG on disk inside the pack dir (frozen-screen.png) — pass that path to an image-reading tool to look at it.",
    "params": [
      {
        "name": "id",
        "type": "string",
        "required": true,
        "zh": "证据包 id（来自 hang_packs）",
        "en": "Pack id from hang_packs"
      }
    ]
  },
  "hang_analyze": {
    "name": "hang_analyze",
    "descZh": "对证据包的 frozen.dmp 跑 ClrMD(DumpStack) 分析：托管线程栈、嫌疑/UI 线程、诊断结论，并把嫌疑方法映射到项目源码（DSH_HANG_SRC_ROOT）。这是\"到底哪一行代码卡住了\"的答案。**已完成的分析会被复用**（不重算），除非传 refresh=true —— 只有在你刚改了 DSH_HANG_SRC_ROOT 或证据包变了才需要重算（重算会用**当前**配置覆盖旧结果，配置更差时会把好结果顶掉）。wait=true（默认）阻塞到分析完成并返回报告；wait=false 立即返回、稍后用 hang_packs 看状态。Triggers: 分析卡死 / 卡死线程栈 / 映射源码 / hang analyze.",
    "descEn": "Run the ClrMD (DumpStack) analysis on a pack frozen.dmp: managed thread stacks, the suspect/UI thread, a diagnosis line, and the suspect method mapped to project source (DSH_HANG_SRC_ROOT) with line numbers. wait=true blocks until the analysis finishes (up to waitMs) and returns the report — the usual choice for an agent; wait=false returns immediately and the panel/poller reads the cached analysis. A finished analysis is REUSED (not recomputed) unless refresh=true — so passing refresh=true only when you just changed DSH_HANG_SRC_ROOT or the pack changed; re-running with a worse config used to silently overwrite a good result.",
    "params": [
      {
        "name": "id",
        "type": "string",
        "required": true,
        "zh": "证据包 id（来自 hang_packs，必须含 frozen.dmp）",
        "en": "Pack id from hang_packs (must contain frozen.dmp)"
      },
      {
        "name": "wait",
        "type": "boolean",
        "zh": "是否等分析完成，默认 true",
        "en": "Wait for the analysis to finish (default true)"
      },
      {
        "name": "waitMs",
        "type": "number",
        "zh": "wait=true 时最长等待毫秒，默认 300000",
        "en": "Max wait in ms when wait=true (default 300000)"
      },
      {
        "name": "refresh",
        "type": "boolean",
        "zh": "已缓存完成结果时是否强制重算（改了 DSH_HANG_SRC_ROOT 后用）",
        "en": "Re-run even if a finished analysis is cached (use after changing DSH_HANG_SRC_ROOT)"
      }
    ]
  },
  "hang_delete": {
    "name": "hang_delete",
    "descZh": "删除卡死证据包（**本地删除、不可恢复**；dump 有数百 MB）。**必须显式 confirm=true**。给 id 删一个，或 all=true 清空全部。Triggers: 删证据包 / 清空卡死证据 / hang delete.",
    "descEn": "Delete hang evidence packs (LOCAL, irreversible — dumps are hundreds of MB). confirm=true is required. Give id to delete one pack, or all=true to clear every pack.",
    "params": [
      {
        "name": "id",
        "type": "string",
        "zh": "要删除的证据包 id",
        "en": "Pack id to delete"
      },
      {
        "name": "all",
        "type": "boolean",
        "zh": "true = 清空证据目录里全部证据包",
        "en": "Delete every pack in the evidence dir"
      },
      {
        "name": "confirm",
        "type": "boolean",
        "required": true,
        "zh": "必须为 true —— 删除不可恢复",
        "en": "Must be true — deletion is irreversible"
      }
    ]
  },
  "perf_probe": {
    "name": "perf_probe",
    "descZh": "**UI 线程卡顿「检测器」（不出调用链）。** 要回答「**是哪串代码 / 哪个调用链**导致的卡顿」，**不要用本工具**，直接 `perf_trace` → `perf_hotstacks`。本工具只做一件事：循环测客户端主窗口消息响应耗时（空闲毫秒级、UI 忙则同步挂起），统计 P50/P95/P99、记录每次超过阈值的卡顿事件，capture=shot 时卡顿瞬间截图，capture=dump 时首次卡顿自动抓全 dump。返回报告 JSON 与证据目录。**测量口径（2026-09-11 本机标定，必读）**：只测 **UI 线程消息泵** —— ①非 UI 线程的卡顿（GC/IO/worker/后台线程）**结构性测不到**（标定：后台线程每 3s 阻塞 2000ms → 110~191 个样本命中 0 次、max 仅 8~9ms，与空闲无异）；②阻塞若完全落在两次采样之间会整段错过（120ms 阻塞在 100ms 采样下只中 1/5）；③**P50 恒为 0ms** 是常态（周期性卡顿下多数采样落在空闲期），判断卡顿看 max 与命中数；④「0 次卡顿」只说明 UI 线程没有超过阈值的阻塞，**不等于客户端流畅** —— **不要拿它下\"客户端不卡\"的结论**。调参：找 ≥500ms 卡顿用 thresholdMs 200~300（别正好取 500 —— 实测 500ms 阻塞测得 492ms 会被阈值挡掉）、intervalMs 100~150；非 UI 线程的卡顿请改用 `perf_trace`/`perf_hotstacks`（调用链）或 `perf_dump`。Triggers: 卡顿分析（**仅限 UI 线程阻塞**）/ 测卡顿 / 性能监测 / UI stutter.",
    "descEn": "**UI-thread stutter DETECTOR (produces no call chain).** To answer \"**which code / which call chain** causes the stutter\", do NOT use this tool — go straight to `perf_trace` then `perf_hotstacks`. What this tool does: loops a window-message round trip against the target client main window, reports P50/P95/P99 and every event over the threshold. capture=log (default) only records; capture=shot screenshots the stall; capture=dump grabs a full dump on the first stall (hundreds of MB). MEASUREMENT SCOPE (calibrated on this machine 2026-09-11 — read before concluding): it only measures the UI-thread message pump, so (a) non-UI-thread stalls (GC / IO / worker / background threads) are structurally invisible (calibration: background thread blocked 2000ms every 3s -> 0 hits over 110-191 samples, max 8-9ms, indistinguishable from idle); (b) a block falling entirely between two samples is missed (120ms block with 100ms sampling -> 1/5 hits); (c) P50 is normally 0ms even while stalling - judge by max and hit count; (d) \"0 stutters\" only means no UI-thread block above the threshold, NOT that the client is smooth. Tuning: to catch >=500ms stalls use thresholdMs 200-300 (a 500ms block measures ~492ms, so a 500 threshold can reject it) and intervalMs 100-150. The JSON result carries measurementScope with these limits.",
    "params": [
      {
        "name": "seconds",
        "type": "number",
        "mcpDefault": 60,
        "zh": "监测时长秒数，默认 60（建议用户操作复现卡顿的操作场景）",
        "en": "Sampling duration in seconds"
      },
      {
        "name": "thresholdMs",
        "type": "number",
        "mcpDefault": 500,
        "zh": "卡顿判定阈值毫秒，默认 500。注意：阈值取 500 时，恰好 500ms 的阻塞（实测 492~513ms）会被判不出 —— 要抓这类卡顿请用 200~300",
        "en": "Stutter threshold in ms. 500 can miss a ~500ms block (measures 492-513ms) - use 200-300 to catch those"
      },
      {
        "name": "capture",
        "type": "string",
        "enum": [
          "log",
          "shot",
          "dump"
        ],
        "mcpDefault": "log",
        "zh": "log（默认，只记录）| shot（卡顿时截图）| dump（首次卡顿抓全 dump，数百 MB）",
        "en": ""
      },
      {
        "name": "intervalMs",
        "type": "number",
        "mcpDefault": 300,
        "zh": "采样间隔毫秒，默认 300。阻塞时长与采样间隔同量级时命中率骤降（120ms 阻塞 + 100ms 采样 → 1/5），要抓短卡顿请调小",
        "en": "Sampling interval in ms. Hit rate collapses when the block is the same order as the interval (120ms block + 100ms sampling -> 1/5)"
      }
    ]
  },
  "perf_report": {
    "name": "perf_report",
    "descZh": "读**最近一次** perf_probe 的监测报告（P50/P95/P99/卡顿事件列表）。它读的是\"上一次\"、不保证是刚才 —— 返回里带报告时间与陈旧告警，**先看它再下结论**。Triggers: 上次卡顿结果 / 性能报告.",
    "descEn": "Read the most recent perf_probe report (P50/P95/P99 + stall events).",
    "params": []
  },
  "perf_dump": {
    "name": "perf_dump",
    "descZh": "抓**此刻**的现场快照（procdump -ma，会挂起进程几秒）并自动分析：UI 线程托管栈 + 锁热点线程 Top 5；**返回 dumpPath**（可直接喂 perf_analyze / perf_heap）。⚠ 它只回答\"**此刻谁在栈上**\"，**不回答**\"谁在反复调用它\" —— 间歇性卡顿/重绘风暴请用 perf_trace → perf_hotstacks；客户端已经卡死时**先用它取证**，不要先 ui_launch(force=true) 把现场杀掉。**代码级证据（行号）走这条通路**：dump 分析会顺带做**源码映射**（配了 DSH_PERF_SRC_ROOT 时给出 `← 相对路径:行号`）——\"到底哪一行\"从这里拿；而 ETW 那条（perf_hotstacks）**只到 `模块!类型.方法`，不做源码映射**，别指望它给行号。Triggers: 抓 dump / 抓内存快照 / dump 分析 / 卡死现场取证.",
    "descEn": "Capture a full memory dump of the running client (procdump -ma — this SUSPENDS the process for a few seconds, so the user sees a brief freeze) and immediately analyse it: UI thread managed stack + top lock-holding threads, and returns dumpPath (absolute dump path — feed it to perf_analyze / perf_heap). It answers only \"who is on the stack RIGHT NOW\", NOT \"who keeps calling it\": for intermittent freezes / repaint storms use perf_trace then perf_hotstacks; if the client is frozen right now, capture BEFORE ui_launch(force=true) destroys the scene. Dumps are hundreds of MB and land in the perf evidence dir; ask the user before deleting. SOURCE LINES come from THIS path: dump analysis also maps frames to source (with DSH_PERF_SRC_ROOT configured it prints \"← relative/path.cs:line\") — that is where a file:line answer comes from. The ETW path (perf_hotstacks) resolves symbols to module!type.method only and does NOT map to source lines.",
    "params": [
      {
        "name": "note",
        "type": "string",
        "zh": "场景备注（写入证据目录 note.txt）",
        "en": "Scenario note written alongside the evidence"
      }
    ]
  },
  "perf_analyze": {
    "name": "perf_analyze",
    "descZh": "对**已有** dump 文件跑 DumpStack(ClrMD) 分析：UI 线程栈 + 锁热点线程。dump 从哪来：perf_dump 返回的 `dumpPath`（或 perf_probe(capture=\"dump\") / hang 证据包里的 frozen.dmp）。Triggers: 分析 dump / 重新分析 dump.",
    "descEn": "Re-run the ClrMD analysis (UI thread stack + hot lock threads) on an existing dump file.",
    "params": [
      {
        "name": "dumpPath",
        "type": "string",
        "required": true,
        "zh": "dump 文件绝对路径",
        "en": "Absolute path to the .dmp file"
      }
    ]
  },
  "perf_heap": {
    "name": "perf_heap",
    "descZh": "**托管堆**类型统计 Top N（对象数/总字节），内存泄漏初筛——两次 dump 对比同一类型的对象数增长即泄漏嫌疑。⚠ **测量口径（先读再下结论）**：① 只统计**托管堆**；WPF 客户端的内存大头常常是**非托管**（位图/字体句柄/COM/native 缓冲）与**地址空间碎片**，这些**结构性测不到** —— 所以「托管堆没涨」**不能**推出「没有泄漏」；② 两次采样之间的**未回收垃圾**会被读成增长（对比时请让用户先静置/触发一次 GC，或把间隔拉长）；③ 输出只有**类型 + 字节数**，**没有保留链 / GC root 路径** ⇒ 它能告诉你「哪个类型在涨」，**答不了**「哪段代码泄漏」；④ 用户说的「内存」多半是**任务管理器的工作集**，与本工具的托管堆口径**不是一回事**，收尾时请分开报。Triggers: 堆统计 / 内存泄漏 / heap stats / 托管堆.",
    "descEn": "**Managed** heap type census (object count / total bytes per type, Top N) — the first cut of a memory leak hunt: take two dumps and compare the same type across them. MEASUREMENT SCOPE (read before concluding): (a) MANAGED heap only — a WPF client's growth is often UNMANAGED (bitmaps, font handles, COM, native buffers) or address-space fragmentation, none of which this can see, so \"the managed heap did not grow\" does NOT prove \"no leak\"; (b) garbage not yet collected between the two samples reads as growth (let the client settle / force a GC, or widen the interval); (c) the output has types and byte counts only — NO retention paths / GC roots — so it cannot answer \"which code leaks\"; (d) when the user says \"memory\", they usually mean the working set in Task Manager, which is a different measurement — report both separately.",
    "params": [
      {
        "name": "dumpPath",
        "type": "string",
        "required": true,
        "zh": "dump 文件绝对路径",
        "en": "Absolute path to the .dmp file"
      },
      {
        "name": "topN",
        "type": "number",
        "zh": "Top N 类型，默认 30",
        "en": "Top N types (default 30)"
      }
    ]
  },
  "perf_trace": {
    "name": "perf_trace",
    "descZh": "ETW 采样剖析（**要\"从卡顿走到完整调用链\"就用它**，别靠猜）。action=start 起采样 → 你复现问题 → action=stop 产出 .etl（或 action=run 限时自动停）。与 dump 的分工：perf_dump 是**一个瞬间**的快照，只能回答\"此刻谁在栈上\"；本工具连续采样，能回答\"**谁在反复调用它、它又调用了谁**\"，因此对间歇性卡顿/重绘风暴才有效。采集同时启用 CPU 与 DotNet 预设（少了 DotNet 就解不出托管方法名）。要求：**DSH 需以管理员身份运行**（ETW 内核会话），且 .etl 可能数百 MB。跑完用 perf_hotstacks 出调用链。Triggers: 抓 trace / 调用链 / 重绘卡顿定位 / ETW 采样.",
    "descEn": "ETW sampling profiler — **use this to get from \"the UI stutters\" to a full call chain** instead of guessing. action=start begins sampling (you reproduce the problem), action=stop produces the .etl, action=run does start→wait seconds→stop. Difference from perf_dump: a dump is ONE instant and can only say \"who was on the stack\"; this samples continuously, so it can say **who keeps calling what** — which is what intermittent stutter / repaint storms need. Captures CPU + DotNet presets together (without DotNet, managed method names will not resolve). Requires DSH to run as ADMIN (ETW kernel session). The .etl can be hundreds of MB. Then call perf_hotstacks on the .etl to get the chains.",
    "params": [
      {
        "name": "action",
        "type": "string",
        "enum": [
          "start",
          "stop",
          "run",
          "cancel",
          "status"
        ],
        "zh": "start（起采样，等你复现）| stop（停并产出 etl）| run（默认：起→等 seconds 秒→停）| cancel（放弃）| status（**查采样在不在跑**：running / 已跑多久 / 当前 etl 大小；running 的依据是我们 start 时写的会话标记，不是查询 xperf —— 另有 samplerProcessFound 作旁证，null = 查不到）",
        "en": "start | stop | run (default) | cancel | status = is a session running (running comes from our own session marker, not from querying xperf; samplerProcessFound is corroborating and null means unknown)"
      },
      {
        "name": "seconds",
        "type": "number",
        "zh": "action=run 时的采集秒数，默认 20（建议够你复现一次问题）",
        "en": "For action=run: how long to sample (default 20)"
      },
      {
        "name": "profile",
        "type": "string",
        "enum": [
          "cpu",
          "dotnet",
          "general"
        ],
        "zh": "cpu（默认，= CPU+DotNet，能解托管名）| dotnet | general",
        "en": "cpu (default: CPU+DotNet, resolves managed names) | dotnet | general"
      },
      {
        "name": "tag",
        "type": "string",
        "zh": "证据目录后缀标签，便于归档（如 repaint-storm）",
        "en": "Evidence-dir suffix tag, e.g. repaint-storm"
      },
      {
        "name": "etlPath",
        "type": "string",
        "zh": "action=stop 时指定要停到哪个 .etl（填 start 返回的 etlPath）",
        "en": "For action=stop: which .etl to stop into (the etlPath returned by start)"
      },
      {
        "name": "engine",
        "type": "string",
        "enum": [
          "auto",
          "wpr",
          "xperf"
        ],
        "zh": "采集通道（默认 auto）：auto = 自检说\"这台机器的 WPR 收不了尾\"就自动改用 xperf，否则走 WPR；wpr = 强制 WPR；xperf = 强制 xperf。xperf 通道收尾时会自动多做一步 `xperf -merge` —— **模块归属只在合并那一步产生**（不合并的报告连模块名都是 ***unknown***）",
        "en": "Capture engine (default auto): auto = use WPR unless the pre-start self-check says WPR cannot finish a trace on this machine, in which case it switches to xperf; wpr = force WPR; xperf = force xperf. The xperf path does an extra `xperf -merge` on stop BECAUSE module attribution is only produced during that merge (an unmerged trace reports nothing but ***unknown***, not even module names)."
      },
      {
        "name": "skipPreflight",
        "type": "boolean",
        "zh": "true = 跳过\"采集前自检\"（默认 false）。自检会用 1~2 秒起一个极小 WPR 会话并立刻收尾，验证**这台机器的 WPR 能不能收尾**；engine=auto 时它同时决定走哪条通道；显式 engine=\"wpr\" 且自检不通过时，start 仍会执行但返回值带 warning（告诉你这次很可能产不出 etl）",
        "en": "Skip the pre-start self-check (default false). The check starts a tiny WPR session and immediately stops it to verify that WPR on this machine can finish a trace; with engine=auto its verdict ALSO routes the capture channel (broken WPR -> xperf); with an explicit engine=\"wpr\" start still runs but the result carries a warning (the etl will most likely never appear)."
      }
    ]
  },
  "perf_hotstacks": {
    "name": "perf_hotstacks",
    "descZh": "从 .etl 出**调用链**：最热函数排行（谁占 CPU）+ 蝶形视图（每个函数的**调用者 <-- 与 --> 被调用者**，带命中数）。focus 可只保留名字匹配该正则的函数（例如 focus=\"SciChart|KLine|你怀疑的那层\"），把几 MB 的报告压成一条可读的因果链。注意：**符号未解析的比例会在结果首行如实给出** —— 若显示大量未解析，先确认符号路径（DSH_PERF_SYMBOL_PATH）再看结论，否则\"没解析出来\"会被误当成\"没有这段代码\"。出报告耗时的关键是**符号**：符号缓存跨运行共享（默认 evidenceDir/symbol-cache，DSH_PERF_SYMBOL_CACHE 可覆盖），所以同一个 etl 重跑通常快很多；首次分析某台机器会从微软公网下载 pdb（实测可达 1GB+、几十分钟）。若超时，症状是 xperf 长时间 ~0% CPU 且报告 0 字节 —— 这时**别调小 timeoutMs**，改为：加 process 过滤、用 focus 收窄、或先 offline:true 只拿原生帧。Triggers: 出调用链 / 热点栈 / 谁调用了它 / hotstacks.",
    "descEn": "Turn a .etl into a **call chain**: hottest-function ranking (who burns CPU) + butterfly view (each function's **callers <-- and --> callees**, with hit counts). focus keeps only functions whose name matches the regex (e.g. \"SciChart|KLine|<your suspect layer>\"), compressing a multi-MB report into one readable causal chain. NOTE: the **unresolved-symbol ratio is reported on the first line** — if it is high, fix symbols (DSH_PERF_SYMBOL_PATH) before drawing conclusions, otherwise \"symbols did not resolve\" gets misread as \"that code was never called\".",
    "params": [
      {
        "name": "etlPath",
        "type": "string",
        "required": true,
        "zh": "perf_trace 产出的 .etl 绝对路径",
        "en": "Absolute path to the .etl produced by perf_trace"
      },
      {
        "name": "focus",
        "type": "string",
        "zh": "正则：只保留名字匹配的函数（模块名或方法名片段，如 SciChart|OnRender|你的 VM 名）",
        "en": "Regex: keep only matching functions (module or method fragment)"
      },
      {
        "name": "process",
        "type": "string",
        "zh": "进程名正则（**建议填**：默认用 DSH_UI_PROC_NAME；不填=报告含全系统栈，统计更杂）。注意：它只筛选**统计口径**，不会减少符号解码量",
        "en": "Process name regex (recommended; defaults to DSH_UI_PROC_NAME)"
      },
      {
        "name": "topN",
        "type": "number",
        "zh": "排行/链条数，默认 15",
        "en": "Ranking/chain count, default 15"
      },
      {
        "name": "minHits",
        "type": "number",
        "zh": "蝶形视图最小命中数，默认 5（调大更聚焦、调小更全）",
        "en": "Butterfly-view minimum hits, default 5"
      },
      {
        "name": "offline",
        "type": "boolean",
        "zh": "true = 不配符号服务器（快，但原生帧多为 unknown）",
        "en": "true = skip the symbol server (fast, but native frames stay unknown)"
      },
      {
        "name": "timeoutMs",
        "type": "number",
        "zh": "出报告超时毫秒，默认 900000；系统级 trace 需要调大或改用 process 过滤",
        "en": "Report timeout in ms, default 900000"
      },
      {
        "name": "debugSymbols",
        "type": "boolean",
        "zh": "true = 让 xperf 打印符号查找细节（结果在 xperfRaw，成功/失败都有）。仅当怀疑「卡在符号解码」时用：症状是 xperf 长时间 ~0% CPU 且报告一直 0 字节",
        "en": "true = let xperf print symbol-lookup details (returned in xperfRaw on success and failure alike)"
      }
    ]
  },
  "perf_clean": {
    "name": "perf_clean",
    "descZh": "清理 **perf 证据目录**里的证据大件（.dmp / .etl）—— G1 黑盒点名的缺口：做完一次内存/性能排查会留下几百 MB，而工具链里**没有任何一个能删**。行为：**默认只看不删**（先列出命中的文件与总字节数），确认后才传 confirm=true；只删自己能认出来的扩展名（.dmp/.etl），**绝不递归、绝不删目录本身**；**采样进行中不删 etl**（trace-session.json 在盘上时跳过，那可能正是它在写的文件）。参数：what=dumps|etls|all（默认 all）、keepDays=N（只删 N 天前的，默认不限）。Triggers: 清理证据 / perf 目录太大 / 删 dump / 删 etl / clean evidence.",
    "descEn": "Clean the perf evidence dir (the .dmp / .etl heavy files). Why it exists: a memory or perf investigation leaves hundreds of MB and nothing in the toolchain could remove them (G1 black-box finding). DRY-RUN by default (it lists what would go and the total bytes) and only deletes when confirm=true; only .dmp/.etl are touched, never recursively, never the directory itself; while a trace session marker (trace-session.json) is present it skips .etl because that may be the file being written. what=dumps|etls|all (default all), keepDays=N keeps anything newer than N days.",
    "params": [
      {
        "name": "confirm",
        "type": "boolean",
        "zh": "**必须显式传 true 才会真的删**。不传（或 false）= 只列出将要删除的文件与总字节数（dry-run）。删除不可恢复。",
        "en": "REQUIRED true to actually delete. Omit/false = list only (dry run). Deletion is not recoverable"
      },
      {
        "name": "what",
        "type": "string",
        "enum": [
          "dumps",
          "etls",
          "all"
        ],
        "zh": "删哪一类：dumps=只删 .dmp；etls=只删 .etl；all=两者（默认）",
        "en": "Which files: dumps = .dmp only, etls = .etl only, all = both (default)"
      },
      {
        "name": "keepDays",
        "type": "number",
        "zh": "只删**修改时间早于** N 天的文件（默认不限 ⇒ 命中全部）。想让最近一次排查的证据留着就传它。",
        "en": "Only delete files older than N days (default: no age filter)"
      }
    ]
  },
}

/**
 * DSH 插件面参数（纯 JSON Schema 的"裸 map"，与 defineTool 现状一致）：
 *   { paramName: { type, enum?, required?, description(zh) } }
 */
export function dshParameters(toolName) {
  const entry = REGISTRY[toolName]
  if (!entry) throw new Error('tool-registry: 未知工具 ' + toolName)
  const out = {}
  for (const p of entry.params) {
    out[p.name] = {
      type: p.type,
      ...(p.enum ? { enum: p.enum } : {}),
      ...(p.required ? { required: true } : {}),
      description: p.zh,
    }
  }
  return out
}

/** DSH 面描述（中文）。 */
export function dshDescription(toolName) {
  const entry = REGISTRY[toolName]
  if (!entry) throw new Error('tool-registry: 未知工具 ' + toolName)
  return entry.descZh
}

/** MCP 面描述（英文）。 */
export function mcpDescription(toolName) {
  const entry = REGISTRY[toolName]
  if (!entry) throw new Error('tool-registry: 未知工具 ' + toolName)
  return entry.descEn
}
