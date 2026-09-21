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
    "descZh": "分析证据包 frozen.dmp 的托管线程栈、嫌疑/UI 线程，并把嫌疑方法映射到源码（DSH_HANG_SRC_ROOT）。行号是方法声明位置，不代表实际阻塞语句；单次 dump 未必能确定等待对象或根因。已完成结果默认复用；仅在源码配置或证据变化时用 refresh=true 重算。wait=true 默认等待至完成或 waitMs 到期；仍在运行时会如实返回 running，wait=false 立即返回。用 hang_packs 看状态。Triggers: 分析卡死 / 托管线程栈 / 映射源码.",
    "descEn": "Analyze a pack frozen.dmp with ClrMD: managed thread stacks, suspect/UI thread and source method declarations (DSH_HANG_SRC_ROOT). Source line numbers identify declarations, not the blocking statement; one dump may not establish the wait object or root cause. Completed results are reused unless refresh=true; refresh only after source configuration or evidence changes. wait=true waits up to waitMs and may return running; wait=false returns immediately. Check hang_packs for state.",
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
  "perf_gcroot": {
    "name": "perf_gcroot",
    "descZh": "**堆 GC root / 保留链**（补 perf_heap 答不了的那半：「**谁 keep 住了这个对象**」）。走自建 ClrMD 分析器 HeapRoots：无 `type` 时给托管堆 Top 类型（同 perf_heap 口径）；给 `type`（类型名子串）时，额外对该类型的对象做 **GC root → 对象** 的最短保留链（root 种类 + 沿途每一层的类型名）——把链上的持有者断开，对象才能被回收。这正是 PerfView「!gcroot」那类能力。⚠ 口径（必须转达）：① 只看**托管堆**，非托管（位图/字体句柄/COM/native 缓冲）与工作集看不到；② **单次快照**，count/bytes 大 ≠ 泄漏（泄漏要同一类型跨时间增长，隔段时间再抓一份对比）；③ 保留链是有界 BFS 的**最短一条**，不是全部引用者。先用 perf_dump 抓 dump（或已有 dump）再喂它。Triggers: gcroot / 保留链 / 谁持有对象 / 谁 keep 住 / 引用链 / 内存泄漏定位 / retention path.",
    "descEn": "**Heap GC roots / retention chains** — the half perf_heap cannot answer: \"**what keeps this object alive**\". Uses a self-built ClrMD analyzer (HeapRoots): without `type` it gives the managed-heap Top types (same as perf_heap); with `type` (a type-name substring) it additionally finds, for objects of that type, the shortest **GC root → object** retention chain (root kind + the type name at each hop) — break a holder on that chain and the object becomes collectable. This is PerfView's `!gcroot`-style capability. SCOPE (must relay): (a) MANAGED heap only — unmanaged (bitmaps/font handles/COM/native buffers) and working set are invisible; (b) SINGLE snapshot — large count/bytes is NOT a leak (a leak is the same type growing over time; take a second dump later and compare); (c) the chain is the SHORTEST one from a bounded BFS, not every referrer. Take a dump first with perf_dump (or reuse one).",
    "params": [
      {
        "name": "dumpPath",
        "type": "string",
        "required": true,
        "zh": "dump 文件绝对路径（perf_dump 抓的，或已有的 .dmp）。",
        "en": "Absolute path to the .dmp (from perf_dump, or an existing one)."
      },
      {
        "name": "type",
        "type": "string",
        "zh": "类型名**子串**（如 `MainViewModel` / `Bitmap` / `EventHandler`）。给了才算保留链；不给只出 Top 类型。",
        "en": "Type-name SUBSTRING (e.g. MainViewModel / Bitmap / EventHandler). Retention chains are computed only when given; otherwise Top types only."
      },
      {
        "name": "top",
        "type": "number",
        "zh": "Top 类型数，默认 30（5~100）。",
        "en": "Top type count, default 30 (5-100)."
      },
      {
        "name": "paths",
        "type": "number",
        "zh": "最多回溯几条保留链，默认 5（1~50）。堆很大时别调太高。",
        "en": "Max retention chains to return, default 5 (1-50). Keep it modest on big heaps."
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
      },
      {
        "name": "clr",
        "type": "boolean",
        "zh": "true = **并行再起一条 CLR 会话**（默认关），采 `Microsoft-Windows-DotNETRuntime`(GC 0x4001 + Loader|JIT 0x18) 与 `...Rundown`(0x18)，产出同目录的 `clr-events.etl`。它与内核会话是**两条独立会话**（本机 WPR 收不了尾，走 xperf 时那些参数是**纯内核 flag**，实测 276 MB 的 trace.etl 里连 e13c0d23 都没有 ⇒ 不额外起这条就**永远拿不到 GC 数据**）。停采样时会自动停掉它（stop 分支有 6 条早返回，漏停会留下一个**一直在写盘的孤儿会话**）。⚠ 它起不来**不会**推翻主采集 —— 主采集照常可用，返回值带 `clrWarning` 并写明「没有 GC 数据 ≠ 没有 GC 停顿」。跑完用 `perf_clrevents(clrEtlPath)` 出 GC 汇总。",
        "en": "true = also start a PARALLEL CLR session (default off), capturing Microsoft-Windows-DotNETRuntime (GC 0x4001 + Loader|JIT 0x18) and ...Rundown (0x18) into clr-events.etl next to the trace. It is a SECOND, independent session on purpose: WPR cannot finish a trace on this machine, and the xperf fallback uses kernel-only flags — a measured 276 MB trace.etl had no e13c0d23 at all, so without this session GC data is never collected. Stopping the capture stops this session too (the stop path has six early returns; a missed stop would leave an orphan session writing to disk forever). If it fails to start it does NOT invalidate the main capture — you get clrWarning saying \"no GC data\" is not \"no GC pauses\". Then run perf_clrevents(clrEtlPath)."
      },
      {
        "name": "jit",
        "type": "boolean",
        "zh": "true = **并行再起一条 CLR 方法/rundown 会话**（默认关），产出同目录的 `jit-methods.etl`，给 perf_flame 的「地址→方法」映射供数据 —— 这样火焰图里**客户端自己的方法能显真名**（不再是 [unknown]）。挂 `Microsoft-Windows-DotNETRuntimeRundown 0x118`：DCEnd 在**停止那一刻**触发、枚举当前所有已 JIT 方法（含窗口内新 JIT 的）⇒ 采样窗口内**低污染**（不含 StartRundown，几乎不产采样期事件）。停采样时自动停掉它（否则留孤儿会话）。⚠ 起不来不推翻主采集，带 `jitWarning` 写明「没采映射 ≠ 没有客户端代码」。停完 `perf_flame` 会**自动**发现并使用它。想抓客户端卡顿/热点的调用链就带上它。",
        "en": "true = also start a PARALLEL CLR method/rundown session (default off), producing jit-methods.etl next to the trace, feeding perf_flame's address->method map so the flame graph shows the CLIENT's OWN method names (not [unknown]). It enables Microsoft-Windows-DotNETRuntimeRundown 0x118: DCEnd fires at STOP and enumerates all currently-jitted methods (including those jitted during the window) => LOW pollution during the sampling window (no StartRundown, almost no events while sampling). Stopped automatically with the capture (else an orphan session). If it fails to start it does NOT invalidate the main capture (jitWarning: 'no method map' is not 'no client code'). perf_flame auto-discovers and uses it afterwards. Include it when you want a call chain for client-side stutter/hotspots."
      },
      {
        "name": "alloc",
        "type": "boolean",
        "zh": "true = **并行再起一条分配采样会话**（默认关），采 `GCAllocationTick`(每分配约 100KB 一次，带类型+字节) **并附调用栈**，产出同目录的 `alloc-events.etl`，给 perf_allocflame 出「**谁在分配/制造 GC 压力**」的分配火焰图（对标 PerfView 的 GC Heap Alloc Stacks）。这是 WPF 卡顿的一大常见成因（分配多 → GC 频繁 → UI 停顿）。用 xperf 命名用户会话（provider 串带字面量 `:'stack'`）。停采样时自动停掉并 `-merge`。⚠ 只对**能解 manifest 的 CLR** 有效——本机 .NET Framework 客户端正常；.NET Core/5+ 会落成 UnknownEvent。起不来不推翻主采集，带 allocWarning。建议与 jit=true 一起开（分配路径才有客户端方法名）。",
        "en": "true = also start a PARALLEL allocation-sampling session (default off), capturing GCAllocationTick (one sample per ~100KB allocated, with type + bytes) WITH call stacks into alloc-events.etl next to the trace, feeding perf_allocflame's 'who is allocating / making GC pressure' flame graph (PerfView's GC Heap Alloc Stacks). Allocation churn is a major cause of WPF stutter (alloc -> frequent GC -> UI pauses). Uses an xperf named user session (provider spec ends with the literal :'stack'). Stopped and -merged automatically. WARNING only works for a CLR whose manifest resolves — this box's .NET Framework client is fine; .NET Core/5+ falls to UnknownEvent. If it fails it does NOT invalidate the main capture (allocWarning). Best paired with jit=true so the allocation paths carry client method names."
      }
    ]
  },
  "perf_allocflame": {
    "name": "perf_allocflame",
    "descZh": "从**分配采样** etl（perf_trace(alloc=true) 的 alloc-events.etl）出**分配火焰图**——回答「**谁在分配内存 / 制造 GC 压力**」（对标 PerfView 的 GC Heap Alloc Stacks）。把 `GCAllocationTick` 事件（每~100KB 一次，带 TypeName+字节）按 (时间戳,线程) join 上调用栈，**按字节加权**折叠成自包含可交互 `alloc-flame.html` + `alloc-flame.folded`，并给出**分配大头类型 Top N**。自动复用同目录 `jit-methods.etl`（若 perf_trace(jit=true) 采了）把客户端分配路径解成真实方法名。⚠ 口径：AllocationTick 是**采样**（每~100KB 一次），权重是字节近似；**分配多 ≠ 泄漏**（多数很快被回收）——它答的是「谁在 churn / 造 GC 压力」（WPF 卡顿常见成因），查泄漏用 perf_gcroot。⚠ 分配会话是 xperf **用户会话**，事件里进程名多为 `\"Unknown\"(PID)` ⇒ 默认按目标进程名 live 查 PID 过滤（进程已退可传 pid）。Triggers: 分配火焰图 / 谁在分配 / GC 压力 / alloc / churn / 内存分配热点.",
    "descEn": "Turn an **allocation-sampling** etl (perf_trace(alloc=true)'s alloc-events.etl) into an **allocation flame graph** — answering \"**who allocates / makes GC pressure**\" (PerfView's GC Heap Alloc Stacks). It joins GCAllocationTick events (one per ~100KB, carrying TypeName+bytes) to call stacks by (timestamp,thread), folds them BYTE-WEIGHTED into a self-contained interactive alloc-flame.html + alloc-flame.folded, and lists the Top allocating types. Auto-reuses a sibling jit-methods.etl (if perf_trace(jit=true) captured one) to resolve client allocation paths to real method names. SCOPE: AllocationTick is SAMPLED (~1 per 100KB), weight is an approximation in bytes; allocating a lot is NOT a leak (most is collected fast) — it answers 'who churns / makes GC pressure' (a common WPF-stutter cause); for leaks use perf_gcroot. NOTE the alloc session is an xperf USER session whose event process names are mostly \"Unknown\"(PID), so it filters by resolving the target process name to PIDs live (pass pid if the process already exited).",
    "params": [
      {
        "name": "etlPath",
        "type": "string",
        "required": true,
        "zh": "perf_trace(alloc=true) 产出的 alloc-events.etl 绝对路径。",
        "en": "Absolute path to alloc-events.etl produced by perf_trace(alloc=true)."
      },
      {
        "name": "process",
        "type": "string",
        "zh": "目标进程名（默认 DSH_UI_PROC_NAME）。用来 live 查 PID 过滤（分配事件按 PID 认，见上）。",
        "en": "Target process name (default DSH_UI_PROC_NAME). Used to resolve PIDs live for filtering (alloc events are matched by PID)."
      },
      {
        "name": "pid",
        "type": "string",
        "zh": "直接指定目标 PID（逗号分隔多个）。进程**已退出**、tasklist 查不到名字时用它。",
        "en": "Target PID(s) directly (comma-separated). Use when the process has EXITED and tasklist can't resolve the name."
      },
      {
        "name": "symbols",
        "type": "boolean",
        "zh": "true = dumper 带 -symbols 解原生/框架帧函数名（慢）；默认 false 模块级。客户端 JIT 方法名靠 jit-methods.etl，与此无关。",
        "en": "true = dumper with -symbols to resolve native/framework frame names (slow); default module level. Client JIT method names come from jit-methods.etl, independent of this."
      },
      {
        "name": "noJit",
        "type": "boolean",
        "zh": "true = 即便同目录有 jit-methods.etl 也不用（客户端分配路径会聚成 [unknown]）。",
        "en": "true = don't use a sibling jit-methods.etl even if present (client alloc paths collapse to [unknown])."
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
  "perf_clrevents": {
    "name": "perf_clrevents",
    "descZh": "从带 CLR provider 的 .etl 汇总 GC 次数/停顿、托管堆和锁争用。默认 scope=machine-wide，统计整份 ETL 的全部进程，不能归因目标客户端；传 pid 只统计单个目标进程，并返回过滤前后事件数。无 CLR provider、目标 PID 没有 runtime 事件、解码失败/超时/超限均报告未知而不是 GC 0 次；目标无事件时 state=not-captured-for-target。用 perf_trace(clr=true) 采 CLR 数据，纯内核 ETL 不含这些事件。暂停按同一 PID 与 CLR 实例的 SuspendEEStart→RestartEEStop 配对；整机模式的合计是各进程暂停之和，不是整机共同冻结时长。topPauses 与 heapProcessId 标明归属；tracerpt 绝对时刻可能有约一分钟偏移，时长差值不受影响。Triggers: GC 停顿 / GC 次数 / 托管堆 / 锁争用 / CLR 事件.",
    "descEn": "Summarize CLR GC counts/pauses, managed heap and contention from an ETL containing the CLR provider. Defaults to scope=machine-wide across ALL processes; these totals are not attributable to the target client. Pass pid to select one process; original and filtered event counts are returned. Missing CLR provider, no runtime events for the selected PID, decode failure, timeout or size limit mean unknown, not zero GC; an absent target returns state=not-captured-for-target. Capture with perf_trace(clr=true); kernel-only ETLs lack CLR events. Pause pairs require the same PID and CLR instance (SuspendEEStart to RestartEEStop). Machine-wide pause totals sum individual process pauses, not simultaneous machine suspension. topPauses and heapProcessId identify owners. Tracerpt absolute times may have a roughly one-minute offset; duration differences are unaffected.",
    "params": [
      {
        "name": "etlPath",
        "type": "string",
        "required": true,
        "zh": ".etl 绝对路径。**内核通道采出来的 etl 会报「没采」**（里面没有 CLR provider）—— 要 GC 数据请先用 perf_trace(clr=true) 采。",
        "en": "Absolute .etl path. An etl from the kernel channel reports \"never captured\" because it has no CLR provider — capture with perf_trace(clr=true) to get GC data."
      },
      {
        "name": "pid",
        "type": "string",
        "zh": "可选，单个 Windows PID（如 32412）。不传时 scope=machine-wide，统计全部进程；传入后仅统计该 PID，没有对应 CLR runtime 事件时报告未采集到目标，不能解释为 GC 0 次。",
        "en": "Optional single Windows PID, e.g. 32412. Omit for machine-wide totals. When supplied, only that PID is summarized; no matching CLR runtime events means not captured for this target, not zero GC."
      },
      {
        "name": "xmlPath",
        "type": "string",
        "zh": "解码出来的 XML 写到哪（默认与 etl 同目录的 <名字>.clr.xml）。已解过一份时传它可直接复用，省掉几分钟解码。",
        "en": "Where to write the decoded XML (default: <stem>.clr.xml next to the etl). Pass an existing one to reuse it and skip decoding."
      },
      {
        "name": "maxXmlMb",
        "type": "number",
        "zh": "解码体积上限（MB，默认 2048）。解码体积实测是 etl 的 4~6×，几百 MB 的系统 trace 会变成 GB 级 —— 超了**不解码**并如实报估算值与「未知，不是 0」，而不是默默生成一个 GB 文件。",
        "en": "Decoded-size ceiling in MB (default 2048). Decoding measured 4-6x the etl, so a few-hundred-MB system trace becomes gigabytes; above the ceiling it does NOT decode and reports the estimate plus \"unknown, not 0\" instead of silently writing a GB file."
      },
      {
        "name": "timeoutMs",
        "type": "number",
        "zh": "tracerpt 每步超时毫秒（默认 900000）；读摘要那步实测 79.5 MB 的 etl 约 14 秒。",
        "en": "Per-step tracerpt timeout in ms (default 900000). The summary pass measured ~14s on a 79.5 MB etl."
      }
    ]
  },
  "perf_flame": {
    "name": "perf_flame",
    "descZh": "从一个 .etl 出 **CPU 火焰图**（从根到叶的整棵 CPU 时间树）—— 补 perf_hotstacks 给不了的那半：hotstacks 是**文本**蝶形（调用者/被调用者对），本工具是**可点开、可缩放、可搜索**的图（对标 PerfView 的招牌视图）。走 `xperf -a dumper`（逐样本 + 每帧一行的 Stack 事件，按 (时间戳,线程) join 出完整栈），**流式折叠 + 按进程过滤**成 folded stacks。产物两个：`flame.html`（**自包含**、内联 SVG+JS、浏览器直接打开、无需联网）与 `flame.folded`（可直接拖进 https://speedscope.app，或喂 flamegraph.pl）。默认 **模块模式**（快）：每帧塌到模块级 —— 一眼看出 SciChart / WPF / clr / 客户端各占多少 CPU；⚠ **客户端自己的方法名解不出**（客户端程序集是 JIT 的、dbghelp 认地址认不出方法，见 docs/perfview-parity.md §3），会聚成一条 `[unknown]` 带（那多半就是客户端代码，**不是「未知开销」**；§4 的地址→方法映射接线后会显出真名）。symbols=true 才连符号服务器解**原生/框架**帧的函数名（慢）。成本：dumper 的 CSV 是 etl 的 ~7×（几百 MB etl → 1~2GB CSV），本工具流式读、按进程过滤、读完默认删（keepCsv 可留、csvPath 可复用）。Triggers: 火焰图 / flamegraph / CPU 调用树 / 谁在烧 CPU / 可视化热点 / speedscope.",
    "descEn": "Turn a .etl into a **CPU flame graph** (the whole root-to-leaf CPU-time tree) — the half perf_hotstacks cannot give: hotstacks is a TEXT butterfly (caller/callee pairs), this is a clickable / zoomable / searchable graph (PerfView's signature view). It runs `xperf -a dumper` (per-sample events + one-frame-per-row Stack events joined by (timestamp,thread) into full stacks) and folds them into collapsed stacks, STREAMING + filtered to one process. Two artifacts: flame.html (SELF-CONTAINED inline SVG+JS, opens in any browser, no network) and flame.folded (drag onto https://speedscope.app, or feed flamegraph.pl). Default MODULE mode (fast): each frame collapses to its module — you instantly see how much CPU is in SciChart vs WPF vs clr vs the client; WARNING the client's OWN methods do NOT resolve (its assemblies are JIT-compiled; dbghelp cannot name a JIT address, see docs/perfview-parity.md §3) and collapse into an `[unknown]` band (that band is mostly the client's own code, NOT 'unknown overhead'; §4's address->method map will name it). symbols=true resolves native/framework frame names via the symbol server (slow). Cost: the dumper CSV is ~7x the etl (a few-hundred-MB etl -> 1-2GB CSV); this tool stream-reads it filtered to the process and deletes it afterwards by default (keepCsv to keep, csvPath to reuse).",
    "params": [
      {
        "name": "etlPath",
        "type": "string",
        "required": true,
        "zh": "perf_trace 产出的 .etl 绝对路径（必填）。",
        "en": "Absolute path to the .etl produced by perf_trace."
      },
      {
        "name": "process",
        "type": "string",
        "zh": "只折叠该进程名（正则，默认 DSH_UI_PROC_NAME）。火焰图**必须按进程折叠**，否则整机所有进程的栈会混成一锅（dumper 是系统级的）。",
        "en": "Fold only this process (regex; defaults to DSH_UI_PROC_NAME). A flame graph MUST be per-process, otherwise all processes' stacks mix together (dumper is machine-wide)."
      },
      {
        "name": "symbols",
        "type": "boolean",
        "zh": "true = dumper 带 -symbols 解析**原生/框架**帧的函数名（慢，走符号服务器）；默认 false = 模块级（快）。⚠ 客户端自己的 JIT 方法名**两种模式都解不出**（见 §3/§4）。",
        "en": "true = run dumper with -symbols to resolve native/framework frame names (slow, hits the symbol server); default false = module level (fast). NOTE the client's own JIT'd method names resolve in NEITHER mode (see §3/§4)."
      },
      {
        "name": "csvPath",
        "type": "string",
        "zh": "复用一份已生成的 dumper CSV（跳过重新解码，省几分钟 + 省 1~2GB 重复落盘）。",
        "en": "Reuse an already-generated dumper CSV (skip re-decoding; saves minutes and 1-2GB of rewrite)."
      },
      {
        "name": "keepCsv",
        "type": "boolean",
        "zh": "true = 折叠后保留那份 GB 级 dumper CSV（默认删；folded/html 已经落好）。",
        "en": "true = keep the GB-scale dumper CSV after folding (default deletes it; folded/html are already written)."
      },
      {
        "name": "jitEtl",
        "type": "string",
        "zh": "CLR 方法/rundown 会话产出的 etl（perf_trace(jit=true) 的 jit-methods.etl）。**默认自动发现** kernel etl 同目录的 `jit-methods.etl`，无需手传；传了就用指定的那份。有它，客户端自己的 `\"Unknown\"` JIT 帧会解成**真实托管方法名**（§4，本机实测 join 成立）。",
        "en": "The etl from the CLR method/rundown session (perf_trace(jit=true)'s jit-methods.etl). AUTO-DISCOVERED next to the kernel etl by default — no need to pass it; pass to override. With it, the client's own `\"Unknown\"` JIT frames resolve to REAL managed method names (§4, join proven on this box)."
      },
      {
        "name": "noJit",
        "type": "boolean",
        "zh": "true = 即便同目录有 jit-methods.etl 也**不用**（只要模块级火焰图，省一次 tracerpt 解码）。",
        "en": "true = do NOT use a sibling jit-methods.etl even if present (module-level flame only; skips a tracerpt decode)."
      },
      {
        "name": "timeoutMs",
        "type": "number",
        "zh": "dumper 解码超时毫秒（默认 900000）。dumper 的 CSV 是 etl 的 ~7×，大 etl 很慢。",
        "en": "dumper decode timeout ms (default 900000). The dumper CSV is ~7x the etl; large etls are slow."
      }
    ]
  },
  "perf_uifreeze": {
    "name": "perf_uifreeze",
    "descZh": "**UI 冻结分析**——复刻 dotTrace/PerfView 的「UI Freeze」视图，回答「UI 线程冻了几次、每次多久、卡在哪条调用链」（比如同步 HTTP 卡在 `HttpUtility.HttpGet`）。后端是**真 PerfView.exe 采集**（`/threadTime` 线程时间）+ 自研 TraceEvent 提取器 `UiFreezeStacks`（PerfView 的 `ThreadTimeStackComputer` 引擎）。**判据用 dotTrace 的标准**：UI 冻结 = 主 UI 线程的**消息泵间隙 > 200ms**（「窗口消息 >200ms 没被泵」或「单条消息处理 >200ms」）——所以一直在泵消息的空闲**不算**卡顿（这点是关键，纯看线程 blocked 时长会把空闲当卡顿）。自动认主 UI 线程（取泵消息最多的那条）；WOW64 栈自动拼接、托管方法名靠 etl 里的 CLR rundown（**不连 msdl**）、内核/user32 符号只用本地缓存。**两段式**：action=start 起采集 → 你手动复现卡顿（如冷启点进那个页面/按钮）→ 页面一出来就 action=stop 停并分析。输出每次冻结的时长 + **托管主因调用链**。⚠ 采集是系统级 ETW（需管理员），窗口越短解析越快越干净——复现完尽快 stop。Triggers: UI 冻结 / 卡在等什么 / 同步接口卡 UI / wall clock / UI Freeze / 界面卡死几秒 / 为什么加载慢 / dotTrace.",
    "descEn": "**UI-freeze analysis** — replicates dotTrace/PerfView's \"UI Freeze\" view: how many times the UI thread froze, for how long each, and the call chain it was stuck in (e.g. a synchronous HTTP in HttpUtility.HttpGet). Backend is the REAL PerfView.exe capture (/threadTime) + an in-house TraceEvent extractor (UiFreezeStacks, built on PerfView's ThreadTimeStackComputer). Uses dotTrace's exact criterion: a UI freeze = a message-pump gap > 200 ms on the main UI thread (window messages not pumped for >200 ms, OR one message taking >200 ms) — so a thread that keeps pumping (idle-waiting for input) is NOT a freeze (crucial: raw blocked-time would count idle as freeze). Auto-detects the main UI thread (the one that pumps the most); WOW64 stacks auto-stitched; managed names come from the CLR rundown in the etl (no msdl); kernel/user32 symbols from local cache only. TWO-STEP: action=start begins capture → you reproduce the freeze (cold-click into the view/button) → action=stop as soon as it loads. Output: each freeze's duration + the managed root-cause chain. WARNING system-wide ETW (needs admin); shorter window = faster/cleaner — stop promptly.",
    "params": [
      {
        "name": "action",
        "type": "string",
        "enum": ["start", "stop"],
        "zh": "start = 起 PerfView /threadTime 采集（之后你去复现卡顿）；stop = 停并分析出 UI 冻结段。",
        "en": "start = begin PerfView /threadTime capture (then reproduce the freeze); stop = stop and analyze the UI-freeze spans."
      },
      {
        "name": "process",
        "type": "string",
        "zh": "目标进程名（默认 DSH_UI_PROC_NAME）。用它把分析范围锁到目标进程、并自动查 pid。",
        "en": "Target process name (default DSH_UI_PROC_NAME). Scopes analysis to it and auto-resolves its pid."
      },
      {
        "name": "tid",
        "type": "string",
        "zh": "目标 UI 线程 os id。**通常不用传**——自动取「泵消息最多」的线程为主 UI 线程。多 UI 线程想指定某条时才传。",
        "en": "Target UI-thread os id. Usually NOT needed — the thread that pumps the most is auto-picked. Pass only to override on multi-UI-thread apps."
      },
      {
        "name": "symbols",
        "type": "string",
        "enum": ["cached", "off", "full"],
        "zh": "符号模式：cached（默认，只用本地符号缓存、不连 msdl——托管帧靠 rundown 不受影响，区分空闲/卡顿要的 user32/win32u 已缓存）；off（不解 native，最快，仍出托管 HttpGet 名）；full（连 msdl 补内核/native，本机 msdl 极慢、可能超时，慎用）。",
        "en": "Symbol mode: cached (default — local cache only, no msdl; managed frames come from rundown regardless, and the user32/win32u needed to split idle-vs-freeze are cached); off (no native resolve, fastest, still gets managed HttpGet names); full (hit msdl for kernel/native — msdl is very slow on this box and may time out, use sparingly)."
      },
      {
        "name": "top",
        "type": "number",
        "zh": "最多列出几段冻结（默认 15）。",
        "en": "Max number of freeze spans to list (default 15)."
      },
      {
        "name": "keepEtl",
        "type": "boolean",
        "zh": "false = 分析完删掉 etl.zip 证据（默认 true=保留，便于复查/换符号模式重跑）。",
        "en": "false = delete the etl.zip evidence after analysis (default true = keep, for re-inspection / re-running with a different symbol mode)."
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
  "capture_append": {
    "name": "capture_append",
    "descZh": "Append captured API-call records to the dsh-api-visualizer store (local records.jsonl); they appear live in the GUI 「接口捕获」 panel. Use after capturing interfaces from the client process (e.g. ETW trace, proxy log, client log parsing). Triggers: 抓接口 / 接口可视化 / 上报接口记录 / record captured APIs.",
    "descEn": "Append captured API-call records into the local API-capture store (the same store the capture panel reads; appears live in the GUI).",
    "params": [
      {
        "name": "runId",
        "type": "string",
        "zh": "可选：给这一批**所有**缺 runId 的记录补上同一个 runId（证据链绑定）。已有 runId 的记录不受影响。",
        "en": "Attach this run id to every appended record (evidence-pack spine)"
      }
    ]
  },
  "capture_query": {
    "name": "capture_query",
    "descZh": "Query records stored by the dsh-api-visualizer capture panel (local records store). Returns method/url/status/duration plus caller attribution (which ViewModel/API fired each request). Use to analyze captured client traffic: slow calls, errors, a specific host, or requests fired by one ViewModel. **注意新鲜度**：返回里带 freshness（最新记录年龄 + 捕获引擎是否在跑）——引擎未启动时你看到的是**历史数据**，不是当前状态。**要抓「现在正在发生」的流量：先调 api_capture_start**（它会在日志不存在时当场告诉你\"读不到任何数据\"，而不是让你以为在抓）。**空结果有两种成因**：① 真的没有；② 记录**缺**被过滤的那个字段（durationMs/bytesRes/status 都是可选的）。后者会被计入返回里的 `excludedNoField`（去掉过滤条件再查一次，两次条数之差就是它们的数量）—— 别把空结果直接读成\"没有慢接口/没有重复请求\"。Triggers: 查询接口记录 / 分析捕获 / 哪些接口慢 / 接口报错分析 / query captured APIs.",
    "descEn": "Query the local API-capture store (the same day-shard JSONL the dsh-api-visualizer capture panel writes): method/url/status/duration plus caller attribution (which ViewModel/API fired each request). Use to analyze captured client traffic: slow calls, errors, one host, or requests fired by one ViewModel. ALWAYS read the accompanying honesty fields: `freshness` (captureRunning / newestAgeMs / engineNote) tells you whether the capture engine is live or you are looking at HISTORICAL data, and `callerAttribution` tells you whether caller data exists AT ALL - when it is unavailable the reason is stated there (today the client-side producer does not exist, so \"no caller\" must NOT be read as \"no caller happened\"). Both are also summarized in `freshnessNote` / `callerAttributionNote`.",
    "params": [
      {
        "name": "limit",
        "type": "integer",
        "zh": "Max records to return (default 50, max 500).",
        "en": "Max records (default 50, max 500)"
      },
      {
        "name": "offset",
        "type": "integer",
        "zh": "Skip the newest N matching records (default 0).",
        "en": ""
      },
      {
        "name": "q",
        "type": "string",
        "zh": "Substring match against url/note.",
        "en": "Substring match against url/note"
      },
      {
        "name": "method",
        "type": "string",
        "zh": "HTTP method filter (GET/POST/...).",
        "en": "HTTP method filter (GET/POST/...)"
      },
      {
        "name": "source",
        "type": "string",
        "zh": "Capture source: realtime / proxy / agent / etw.",
        "en": "Capture source: realtime / proxy / agent / etw"
      },
      {
        "name": "status",
        "type": "string",
        "zh": "Status filter: exact code or 2xx/3xx/4xx/5xx.",
        "en": "Exact code or 2xx/3xx/4xx/5xx"
      },
      {
        "name": "host",
        "type": "string",
        "zh": "Hostname filter (comma-separated list).",
        "en": "Comma-separated hostnames"
      },
      {
        "name": "minDurationMs",
        "type": "number",
        "zh": "Only records at least this slow (ms).",
        "en": "Only records at least this slow (ms)"
      },
      {
        "name": "minBytes",
        "type": "number",
        "zh": "Min response bytes.",
        "en": ""
      },
      {
        "name": "maxBytes",
        "type": "number",
        "zh": "Max response bytes.",
        "en": ""
      },
      {
        "name": "fromTs",
        "type": "number",
        "zh": "Earliest record timestamp (epoch ms).",
        "en": "Earliest record ts (epoch ms)"
      },
      {
        "name": "toTs",
        "type": "number",
        "zh": "Latest record timestamp (epoch ms).",
        "en": ""
      },
      {
        "name": "sessionId",
        "type": "string",
        "zh": "Session key filter.",
        "en": ""
      },
      {
        "name": "traceId",
        "type": "string",
        "zh": "Distributed trace id filter.",
        "en": ""
      },
      {
        "name": "runId",
        "type": "string",
        "zh": "Evidence-pack run id filter（与 api_capture_append 的 runId 配套：查\"这一次 run 的流量\"）。注意：实时/代理捕获的真实流量默认没有 runId，只有显式绑过或被 append 注入过 runId 的记录才有。",
        "en": "Filter by the run id carried on records (evidence-pack spine)"
      },
      {
        "name": "errors",
        "type": "boolean",
        "zh": "Only HTTP 4xx/5xx records.",
        "en": "Only HTTP 4xx/5xx records"
      },
      {
        "name": "noNoise",
        "type": "boolean",
        "zh": "Hide static-resource/heartbeat noise. ⚠ 找\"重复请求/定时器风暴\"时**别开**它 —— 心跳/轮询正是你要看的那类请求，开了等于把证据滤掉。",
        "en": "Hide static-resource/heartbeat noise"
      },
      {
        "name": "bodyQ",
        "type": "string",
        "zh": "Substring match inside request/response bodies/headers.",
        "en": "Substring inside request/response bodies/headers"
      },
      {
        "name": "caller",
        "type": "string",
        "zh": "Match caller attribution (viewModel / apiMethod / stack frame substring).",
        "en": "Caller attribution substring (viewModel / apiMethod / stack frame)"
      },
      {
        "name": "includeBody",
        "type": "boolean",
        "zh": "Include request/response bodies (off by default to keep output small). ⚠ **body 与请求头里常常带真实 token / Cookie / 身份信息** —— 打开它意味着这些明文进入你的上下文（以及后续的报告/截图）；只在确实需要看报文时打开。",
        "en": "Include bodies (off by default). WARNING: bodies and headers routinely carry real tokens / cookies / identity data — enabling this pulls that plaintext into your context (and into anything you write afterwards)."
      }
    ]
  },
  "capture_start": {
    "name": "capture_start",
    "descZh": "启动**实时捕获**（等于面板上那个「开始实时捕获」按钮）：tail 客户端的 System.Net 跟踪日志并实时入库。**要在\"现在正在发生的流量\"上做分析，必须先起它**（否则 api_capture_query 看到的只是历史数据）。⚠ 两个前提会**当场**告诉你而不是让你以为在抓：① 跟踪日志不存在（多半是客户端没重启过、system.diagnostics 没生效）⇒ 返回里带 `warnings` 明说\"读不到任何数据\"；② 调用方归因旁路日志不存在 ⇒ 明说\"归因不可用\"，看到 caller 为空时不要读成\"没有调用方\"。③ **跟踪日志不会在运行中自动轮转，且默认落在 %TEMP%（C 盘）**（R1-02/F-056）⇒ 每次 start 都会回一条 `warnings` 说明当前大小与该怎么做（要清走 POST /capture/rotate）。Triggers: 开始实时捕获 / 起捕获 / 抓当前流量 / start capture.",
    "descEn": "Start LIVE capture (the same thing the panel's \"开始实时捕获\" button does): tail the client's System.Net trace log and ingest records into the store. Use the capture_start tool (do NOT hand-roll a POST) before analysing \"traffic happening right now\" - otherwise capture_query only sees historical data. The host process owns the engine, so this goes through the loopback route (http://127.0.0.1:3080/api/dsh-api-visualizer/capture/start). The result carries `warnings` when the trace log does not exist (capture would read nothing) or when the caller-attribution side log is missing (caller will then be empty - that does NOT mean \"no caller happened\").",
    "params": [
      {
        "name": "logPath",
        "type": "string",
        "zh": "可选：改用这个跟踪日志路径（**捕获运行中改路径会被拒绝**并给出下一步）。默认 %TEMP%\\uiprobe-net-trace.log（**在 C 盘**，且运行中不会自动轮转）。",
        "en": "Optional: switch to this trace-log path (REJECTED while capture is running, with the next step)."
      },
      {
        "name": "replay",
        "type": "boolean",
        "zh": "true = 从头重放整个日志（用于把历史日志灌进库）；默认 false = 只 tail 新增内容。",
        "en": "true = re-read the whole log from the start (to backfill history); default false = only new lines"
      }
    ]
  },
  "capture_status": {
    "name": "capture_status",
    "descZh": "查实时捕获引擎的**当前状态**（只读）：在不在跑、跟踪日志在不在/多大、本次已解析多少条、以及**调用方归因旁路日志在不在**（它不在时 caller 必然为空，但那**不等于**\"没有调用方\"）。拿不准\"现在到底能不能抓到东西\"就先查它。**重复写入自检**：返回里的 `integrity` 比较\"引擎自己数到的条数\"与\"库里同一时间段的条数\" —— 比值 ≥1.5 说明**面板里的调用次数被放大了**（\"重复请求/定时器风暴\"这类结论在修好前不能按现有倍数下）。宿主是旧版本（拿不到同区间基准）时可传 `sampleSeconds`（如 90）：本工具在**同一窗口**里采两次再比。Triggers: 捕获状态 / 抓包在跑吗 / capture status.",
    "descEn": "Read the live-capture engine state (read-only): running?, trace log present and how big, how many records parsed this session, and whether the caller-attribution side log exists (when it does not, caller is empty - that does NOT mean no caller happened). Ask this first when unsure whether capture can actually see anything right now. DOUBLE-WRITE SELF-CHECK: the returned `integrity` compares what the engine says it emitted against how many realtime rows the store gained - a ratio >= 1.5 means every call count you read in the panel is inflated (do NOT draw \"repeated request / timer storm\" conclusions from those numbers until it is fixed). Against an older host that cannot supply a same-interval basis, pass sampleSeconds (e.g. 90) to sample twice in the SAME window; it blocks for that long.",
    "params": [
      {
        "name": "sampleSeconds",
        "type": "number",
        "zh": "可选：>0 时在同一窗口里采两次（间隔这么多秒）再算比值 —— 用于旧宿主下判定重复写入；会阻塞这么久（5~600 秒）。",
        "en": "When > 0, sample twice this many seconds apart in the SAME window and compare the deltas (needed against an older host). Blocks for that long (max 600)."
      }
    ]
  },
  "capture_stop": {
    "name": "capture_stop",
    "descZh": "停止实时捕获（等于面板上的「停止」）。停止后 `api_capture_query` 看到的又变成历史数据 —— 这一点会在返回的 summary 里写明。Triggers: 停止捕获 / 停实时抓包 / stop capture.",
    "descEn": "Stop LIVE capture (the panel's stop button). After this, capture_query sees historical data again - the summary says so explicitly.",
    "params": []
  },
  "verify_report": {
    "name": "verify_report",
    "descZh": "把任务收尾的完成声明交给机器裁决：claims 每条 {statement, kind}，kind=build 读 build 记录、kind=api 查 API 捕获库、kind=file 验证据文件存在、kind=gate 跑一条命令（退出码 0 才算过）、kind=manual 显式人工判断。**api claim 会自动绑到本次 runId**（BV-01：不允许别的 run 的流量冒充本次证据）—— 所以 `filter` 里不写 runId 时它仍只找本 run 的记录；要声明\"本次确实跑过接口\"，先用 `api_capture_append({runId})` 落一条带该 runId 的记录，否则会（正确地）判 fail 并提示\"库里有多少条\"。（MCP 面上这个工具叫 `capture_append`；本面叫 `api_capture_append` —— 两面名字不同，本描述已按**本面**写。）只读/看现状的声明用 kind=gate 更硬（真跑命令），想不出命令再用 manual 并给证据。返回 verdict（pass/incomplete/fail）+ 报告路径；被证据反驳的 claim 自动记入失败样本库（agent-misjudge）。Triggers: 收尾裁决 / 验证报告 / verify / 证据复核.",
    "descEn": "Assemble the verification report for one runId and adjudicate each claim FROM EVIDENCE, not self-rating: kind=build reads the per-run build record (run-<runId>.json); kind=api queries the **dsh-api-visualizer capture store** (NOT the dsh-postman panel history — two different stores); kind=file checks path existence (⚠ existence only — a file nobody compiles still passes), kind=compiled checks project compile membership, kind=gate runs a command (exit 0 = pass), kind=git checks repo state, kind=manual is an explicit agent-supplied status (SELF-RATING: verdict=pass means the claim matched the status you supplied, NOT that the fact was independently verified). Per-kind fields: build {statement, runId?} / api {statement, filter?, expect?} / file {statement, path} / compiled {statement, path, project?, repoRoot?} / gate {statement, cmd, cwd?} / git {statement, ref?, gitConfig?} / manual {statement, evidence?}. Pick ONE runId first and reuse it verbatim in build_run / capture_append / verify_report — a mismatch fails the claim and is recorded as agent-misjudge. An api claim is automatically bound to this runId (BV-01: another run traffic must not certify this one), so filter alone still only matches THIS run; to claim \"interfaces were exercised\", record evidence first with capture_append({runId}). Prefer kind=gate (a real command) whenever one exists. Verdict: pass / incomplete / fail. Evidence-contradicted claims auto-record as agent-misjudge in the failure corpus. This is the physical carrier of \"evidence over claims\" — call it before declaring a task done.",
    "params": [
      {
        "name": "runId",
        "type": "string",
        "required": true,
        "zh": "本次任务唯一 id（如 task-2-toolchain-1）",
        "en": "Unique run id (e.g. task-2-toolchain-1)"
      },
      {
        "name": "task",
        "type": "string",
        "required": true,
        "zh": "一行任务名",
        "en": "One-line task name"
      }
    ]
  },
  "toolchain_status": {
    "name": "toolchain_status",
    "descZh": "**先跑这个**：一次问清「现在到底能不能拿到代码级证据」，以及每个前置条件缺什么、下一步怎么补。检查项：目标客户端是否在跑（pid）/ 源码根（`DSH_HANG_SRC_ROOT`、`DSH_PERF_SRC_ROOT` —— 决定能不能给到 `文件:行号`）/ dump 三件套（procdump + DumpStack + DAC —— 决定\"卡死能不能拿到线程栈\"）/ 符号路径 / **管理员权限**（ETW 采样前提）/ 证据目录。每个值都带**来源**（进程环境 / 用户级注册表 / 未配置）—— 所以\"配了但没继承\"与\"没配过\"是**两句话**，不会混为一谈；检查不到的项会**明说检查不到**，不假装通过。⚠ 典型用途：`hang_analyze` 只给了方法名、给不出行号时，先跑它看是不是源码根没配 —— **不要靠反复试错去猜**。Triggers: 环境自检 / 前置条件 / 为什么拿不到行号 / doctor / toolchain status.",
    "descEn": "**Run this first.** One call that answers \"can I actually get code-level evidence right now?\", and tells you what each missing precondition is and how to fix it. Checks: is the target client running (pid) / source roots (DSH_HANG_SRC_ROOT, DSH_PERF_SRC_ROOT — these decide whether you get `file:line`) / the dump trio (procdump + DumpStack + DAC — decides whether a hang yields a thread stack) / symbol path / **admin rights** (required for ETW sampling) / evidence dirs. Every value carries its **source** (process env / user registry / not configured), so \"configured but not inherited\" and \"never configured\" are two different statements; anything that cannot be checked says so instead of pretending to pass. Typical use: when hang_analyze gives you a method name but no line number, check here for a missing source root — do not guess by trial and error.",
    "params": [
      {
        "name": "deep",
        "type": "boolean",
        "zh": "true = 多做一点重活（数源码根里的 .cs、数证据目录条目数）。默认 false 只查存在性，秒回",
        "en": "true = also do the heavier work (count .cs files under the source root, count evidence-dir entries). Default false: existence checks only, returns immediately."
      }
    ]
  },
  "failure_query": {
    "name": "failure_query",
    "descZh": "查询本地**失败样本库**（JSONL，仅本机，从不上传）：按 q（task/description/resolution 子串）、failureClass、tag、时间范围过滤，返回最新在前。**已被撤回的记录默认排除**（看返回里的 `retractedExcluded`）；要看它们并带撤回理由传 includeRetracted=true。**读全部历史分片**（活动 + 归档）。返回的**记录正文会被渲染出来**（类别 / task / description / resolution）。Triggers: 查失败样本库 / 之前记过什么失败 / failure query.",
    "descEn": "Query the local failure corpus: substring q (task/description/resolution), failureClass, tag, time range. Returns newest-first records. Records that were later shown to be recorded wrongly are EXCLUDED by default (see `retractedExcluded` in the response); pass includeRetracted=true to see them with their retraction reason. Reads ALL shards (active + rotated archives).",
    "params": [
      {
        "name": "q",
        "type": "string",
        "zh": "子串匹配 task/description/resolution",
        "en": ""
      },
      {
        "name": "failureClass",
        "type": "string",
        "enum": [
          "verification-failure",
          "agent-misjudge",
          "human-handoff",
          "tool-error",
          "flaky",
          "doc-gap",
          "design-flaw"
        ],
        "zh": "按失败类别过滤",
        "en": ""
      },
      {
        "name": "tag",
        "type": "string",
        "zh": "按标签过滤",
        "en": ""
      },
      {
        "name": "fromTs",
        "type": "number",
        "zh": "最早 ts（epoch ms）",
        "en": "Earliest ts (epoch ms)"
      },
      {
        "name": "toTs",
        "type": "number",
        "zh": "最晚 ts（epoch ms）",
        "en": "Latest ts (epoch ms)"
      },
      {
        "name": "limit",
        "type": "number",
        "zh": "最多返回条数，默认 50，上限 500",
        "en": "Max records, default 50, max 500"
      },
      {
        "name": "offset",
        "type": "number",
        "zh": "跳过最新的 N 条",
        "en": ""
      },
      {
        "name": "includeRetracted",
        "type": "boolean",
        "zh": "把被撤回的记录也带出来（各带 retractedReason）。默认 false",
        "en": "Include records that were retracted (each carries retractedReason). Default false."
      }
    ]
  },
  "failure_stats": {
    "name": "failure_stats",
    "descZh": "失败样本库统计：total / 近 7-30 天 / 按类别计数（**活动分片口径**，这是库的契约），另外给 totalAllShards / archivedRecords / filesScanned ——这样\"total 变小了\"是可解释的（轮转归档），而不是看起来像数据丢了；还有 `retracted`，让被撤回的记录**可见**而不是被静默丢弃。⚠ 要看\"当前到底多少条\"就用它 —— 别把条数写进文档（每轮都在变）。Triggers: 失败样本库统计 / 库里多少条 / failure stats.",
    "descEn": "Failure corpus stats: total/last 7-30 days/per-class counts (ACTIVE shard only — the corpus contract), plus totalAllShards / archivedRecords / filesScanned so a shrinking `total` is explainable, and `retracted` so withdrawn records are visible rather than silently dropped.",
    "params": []
  },
  "failure_record": {
    "name": "failure_record",
    "descZh": "往本地失败样本库里**手工记一条**（仅本机、不上传）。每当：任务失败、验证结论与声明不一致、某个工具失灵、或需要人来接手时都该记。**记事实，不记责任。**多数情况下你不需要手工记 —— `verify_report` 判定为 fail 的 claim 会自动入库（class=agent-misjudge）；这个工具用于它覆盖不到的场景（如工具自身失灵）。Triggers: 记一条失败 / 记录这次失败 / failure record.",
    "descEn": "Record one failure / human-handoff event into the local failure corpus (JSONL, local-only, never uploaded). Call this every time a task fails, verification disagrees with a claim, a tool malfunctions, or a human had to take over. Facts, not blame.",
    "params": [
      {
        "name": "task",
        "type": "string",
        "required": true,
        "zh": "一行任务名",
        "en": "One-line task name"
      },
      {
        "name": "failureClass",
        "type": "string",
        "enum": [
          "verification-failure",
          "agent-misjudge",
          "human-handoff",
          "tool-error",
          "flaky",
          "doc-gap",
          "design-flaw"
        ],
        "required": true,
        "zh": "失败类别（固定 taxonomy）",
        "en": "Failure class from the fixed taxonomy: verification-failure | agent-misjudge | human-handoff | tool-error | flaky | doc-gap | design-flaw"
      },
      {
        "name": "description",
        "type": "string",
        "required": true,
        "zh": "出了什么问题",
        "en": "What went wrong"
      },
      {
        "name": "resolution",
        "type": "string",
        "zh": "后来怎么解开的",
        "en": "How it was unblocked"
      },
      {
        "name": "costMs",
        "type": "number",
        "zh": "大约浪费了多少毫秒",
        "en": "Approximate time wasted in ms"
      }
    ]
  },
  "failure_retract": {
    "name": "failure_retract",
    "descZh": "把一条失败样本库记录标成**记错了**（追加式：原文仍在盘上、可审计；之后 query/stats 不再计入它）。用在\"事后证据表明这条失败本身就是误判\"时（例如一个验证工具把**真话**判成了谎话）。**必须给理由** —— 没有理由的撤回不可审计。撤回一个不存在的 id 会被拒绝（并列出候选）。Triggers: 撤回失败记录 / 这条记错了 / failure retract.",
    "descEn": "Mark a failure-corpus record as WRONGLY recorded (append-only: the original line stays on disk for audit; query/stats then stop counting it). Use when evidence later proves a recorded failure was itself a false positive (e.g. a verification tool that misjudged a true claim). A reason is REQUIRED. Retracting a non-existent id is refused.",
    "params": [
      {
        "name": "id",
        "type": "string",
        "required": true,
        "zh": "要撤回的记录 id，如 fc-20260911-5729",
        "en": "The record id to retract, e.g. fc-20260911-5729"
      },
      {
        "name": "reason",
        "type": "string",
        "required": true,
        "zh": "为什么这条是错的。**必填** —— 没有理由的撤回不可审计",
        "en": "Why this record is wrong. Required — a retraction without a reason is not auditable."
      },
      {
        "name": "by",
        "type": "string",
        "zh": "谁撤回的（自由文本）",
        "en": "Who retracts it (free text)."
      }
    ]
  },
  "http_request": {
    "name": "http_request",
    "descZh": "Send an HTTP request from the host (Postman-style, server-side so no browser CORS) and return the response (status / statusText / headers / body / duration). The call is also logged to the dsh-postman 「接口调试」 panel history. A non-2xx status is a normal result (ok:true); ok:false means the request could not be made (bad url / connection / timeout). **本机回环路由**：插件各自注册了 `/api/dsh-<插件名>` 前缀（已核：dsh-ui-drive / dsh-perf / dsh-api-visualizer / dsh-hang-inspector / dsh-postman / dsh-build —— 子路径见各插件自己的面板/文档，本工具**不列**未核实的子路径），这些路由在**回环上无鉴权**，面板能做而工具面没暴露的操作就得靠它打（例如抓包启停、契约基线、源码定位）。⚠ 两条纪律：① 它们是**真实的副作用入口**（可能启停捕获、复位护栏、改本机状态），按副作用对待；② 只能打 `127.0.0.1`，别把它当外网请求工具。Triggers: 发请求 / 调接口 / 接口测试 / http request / call an API.",
    "descEn": "Send an HTTP request from the host (server-side, no browser CORS) and return status / headers / body. A non-2xx status is a normal result; ok:false means the request could not be made. LOOPBACK ROUTES: each plugin also exposes a `/api/dsh-<plugin>` prefix (verified prefixes: dsh-ui-drive, dsh-perf, dsh-api-visualizer, dsh-hang-inspector, dsh-postman, dsh-build — sub-paths live in each plugin, this tool does NOT list unverified sub-paths). These routes have NO auth on loopback, and panel-only capabilities (capture start/stop, contract baselines, source locate) are reachable only that way. Treat them as REAL side effects, and only ever call 127.0.0.1. Redirects are followed automatically, so read redirected/finalUrl/requestedUrl in the result: a 302 to a login page otherwise looks exactly like a 200 from the API you asked for (status/headers/body all belong to the FINAL url).",
    "params": [
      {
        "name": "method",
        "type": "string",
        "mcpDefault": "GET",
        "zh": "HTTP method（省略时按 GET 发，与实现一致）, e.g. GET/POST/PUT/DELETE/PATCH.",
        "en": "HTTP method"
      },
      {
        "name": "url",
        "type": "string",
        "required": true,
        "zh": "Absolute request URL (http/https).",
        "en": "Absolute http(s) URL"
      },
      {
        "name": "body",
        "type": "string",
        "zh": "Request body (ignored for GET/HEAD). For JSON, set content-type and pass a JSON string.",
        "en": "Request body (ignored for GET/HEAD)"
      },
      {
        "name": "timeoutMs",
        "type": "number",
        "zh": "Timeout in ms (default 30000, max 120000).",
        "en": ""
      }
    ]
  },
  "ui_status": {
    "name": "ui_status",
    "descZh": "只报**进程与窗口的存在性**（是否运行/PID/窗口标题/位置大小）——**它不反映界面里有什么、也不反映是否卡死**；要看界面内容/焦点请用 ui_state 或 ui_observe(action=\"state\")。只读。未运行时用 ui_launch 拉起。Triggers: 客户端状态 / 客户端开着吗 / client status.",
    "descEn": "Report ONLY the existence/geometry of the target client process and main window (running? PID? title? bounds?) — read-only. It does NOT show what is on screen and does NOT tell whether the client is hung; for content/focus use ui_state or ui_observe(action=\"state\"). Configure the client via DSH_UI_PROC_NAME / DSH_UI_WINDOW_NAME / DSH_UI_CLIENT_EXE.",
    "params": [
      {
        "name": "procId",
        "type": "number",
        "zh": "指定进程 PID（多实例消歧；默认自动找）",
        "en": "Target process PID (disambiguate when several instances are running)"
      }
    ]
  },
  "ui_windows": {
    "name": "ui_windows",
    "descZh": "列出目标客户端进程的所有顶层窗口（类型/标题/handle/位置/是否离屏），**以及主窗口内部的嵌套窗口元素**（登录窗/许可协议/模态对话框常常是这种形态，它们不出现在顶层清单里却会遮住下面的控件）。只读。动态界面（登录、切页、弹窗）第一步先看这个，再决定在哪操作。Triggers: 有哪些窗口 / 登录窗口 / 弹窗在哪 / list windows.",
    "descEn": "List every top-level window of the target client process (type / title / handle / position / offscreen) **plus nested window elements inside the main window** (a login pane / licence dialog / modal is usually nested and does NOT show up as a top-level window). Read-only. Check this first when driving a dynamic UI, then decide where to act.",
    "params": [
      {
        "name": "procId",
        "type": "number",
        "zh": "指定进程 PID（多实例消歧；默认自动找）",
        "en": "Target process PID (disambiguate when several instances are running)"
      }
    ]
  },
  "ui_state": {
    "name": "ui_state",
    "descZh": "界面快照（只读，一步看清「现在是什么状态」）：当前主窗口名 + 当前焦点元素 + 交互型控件清单（按钮/输入框/页签/勾选/列表项，带 #序号、aid、enabled、真实输入值）。动态界面每做一步之后先看它，比反复 read 省上下文（read 会连文本一起返回几百行）。match 可按控件名正则过滤，max 限制条数（默认 40）。结果恒带 skipped=N：本次枚举里读不到状态而被跳过的元素数，>0 时附 warn 明说「清单不完整」。Triggers: 现在什么界面 / 界面状态 / 焦点在哪 / ui state.",
    "descEn": "UI snapshot (read-only, one step to see \"what is on screen right now\"): current main window + focused element + the interactive control list (buttons/edits/tabs/checkboxes/list items with #index, aid, enabled and the real input value). Prefer this over repeated read (which returns hundreds of text lines). match filters by control name regex; max caps the list (default 40).",
    "params": [
      {
        "name": "match",
        "type": "string",
        "zh": "按控件名正则过滤（如 登录|验证码）",
        "en": "Regex filter on control names (e.g. 登录|验证码)"
      },
      {
        "name": "max",
        "type": "number",
        "zh": "最多返回几条，默认 40",
        "en": "Max controls returned, default 40"
      },
      {
        "name": "procId",
        "type": "number",
        "zh": "指定进程 PID（多实例消歧；默认自动找）",
        "en": "Target process PID (disambiguate when several instances are running)"
      },
      {
        "name": "winHandle",
        "type": "number",
        "zh": "按顶层窗口 handle 定位（ui_windows 返回的 handle 直接用）——跨窗口读状态时比 winTitle 稳",
        "en": "Target a specific top-level window by handle (from ui_windows)"
      }
    ]
  },
  "ui_tree": {
    "name": "ui_tree",
    "descZh": "进程内视觉树 dump：注入只读探针进客户端进程，输出真实控件类型 + Name + AutomationId + DataContext 类型（比 UIA 信息全，深度定位绑定/模板问题）。只读，不弹窗。**注入不可用时自动降级为 UIA 层级树**（本机实测：Snoop 注入器不存在/DSH_SNOOP_DIR 未配置时就是这条路），此时返回 `source:'uia'` 且只有 类型/Name/aid/enabled/offscreen/位置尺寸/层级 —— **没有** DataContext 与 WPF 真实类型，别把它当成最全的那份树；要 DataContext 需配置 DSH_SNOOP_DIR 指向 Snoop 安装目录。两个隐性上限（maxDepth 切断、节点数上限）与正文截断**都会如实回报**（truncated/depthLimited/nodeCapHit）。Triggers: 视觉树 / 控件结构 / dump-tree.",
    "descEn": "Dump the in-process visual tree: a read-only probe is injected into the target client and reports real control types + Name + AutomationId + DataContext type. Richer than UIA, for diagnosing bindings / templates. Read-only, no popups. Prefer ui_observe for ordinary interaction - use this only when UIA detail is insufficient. When the injector is unavailable (no Snoop / DSH_SNOOP_DIR unset) it AUTOMATICALLY FALLS BACK to a UIA hierarchy tree and returns source:\"uia\" - that one has types/Name/AutomationId/enabled/offscreen/bounds/hierarchy but NO DataContext and NO real WPF type names, so do not treat it as the richest tree. Both hidden caps (maxDepth cut-off, node-count cap) and body truncation are reported explicitly (truncated/depthLimited/nodeCapHit) - a maxDepth value does NOT mean you got the whole tree.",
    "params": [
      {
        "name": "maxDepth",
        "type": "number",
        "zh": "最大深度，默认 8，上限 20。被它切断时会返回 depthLimited=true（**不是完整的树**）",
        "en": "Maximum depth (default 8, capped at 20). When it cuts the tree off the result carries depthLimited=true - that is NOT a complete tree"
      },
      {
        "name": "inAid",
        "type": "string",
        "zh": "限定到某个容器（AutomationId），只 dump 它内部的子树。**大树的正文会撞 14000 字符上限** —— 先 ui_observe(read/state) 找到容器 aid，再带 inAid 深挖，是拿到完整子树的唯一办法（树会回报 narrowed/scope）。注意：指定范围时走 UIA 路径（注入探针不支持范围限定）。",
        "en": "Scope the dump to one container (AutomationId): only its subtree is returned. The whole-window tree blows past the 14000-char body cap - narrowing first (ui_observe read/state to find a container aid, then ui_tree inAid=...) is the only way to get a COMPLETE subtree. The result reports narrowed/scope. Note: with a scope the UIA path is used (the injector cannot scope)."
      },
      {
        "name": "inName",
        "type": "string",
        "zh": "限定到某个容器（Name），同 inAid",
        "en": "Scope the dump to one container by Name (same as inAid)"
      }
    ]
  },
  "ui_launch": {
    "name": "ui_launch",
    "descZh": "启动目标桌面客户端（构建产物（DSH_UI_CLIENT_EXE 指定））并等待主窗口出现；已运行则直接返回现有进程。⚠ **客户端刚卡死时先别用 force**：`force=true` 会**杀掉进程、销毁唯一现场**（dump / 线程栈 / 证据包都没了）。正确顺序是先取证（`perf_dump` 抓快照，或 `hang_run` 挂监测等复现）→ 证据到手 → 再 `force=true` 重启。extraArgs 可传额外启动参数（如 --remote-debugging-port=9222 --remote-allow-origins=* 用于 CEF 内嵌页调试）。**force=true 是唯一的\"重启\"通道**：先结束正在运行的目标进程再启动，会如实回报杀了哪些 PID、等了多久；同名进程有多个且未配 DSH_UI_CLIENT_EXE 时**拒绝执行**（不误杀）。Triggers: 启动客户端 / 重启客户端 / launch client.",
    "descEn": "Start the target desktop client (the exe named by DSH_UI_CLIENT_EXE) and wait for its main window; if it is already running the existing process is returned. extraArgs passes extra command-line arguments (e.g. --remote-debugging-port=9222 for CEF debugging). WARNING: if the client has just hung, do NOT reach for force first - force=true kills the process and destroys the only crime scene (no dump / no thread stacks / no evidence bundle). Capture evidence FIRST (perf_dump for a snapshot, or hang_run to watch for a recurrence), then force=true to restart. force=true is the ONLY restart path: it kills the running target process first and reports exactly which PIDs were killed and how long it waited; it REFUSES when several same-named processes exist and DSH_UI_CLIENT_EXE does not disambiguate (never kills the wrong session). Use this when ui_status reports the client is not running - every other ui_* tool needs a live window.",
    "params": [
      {
        "name": "extraArgs",
        "type": "string",
        "zh": "额外启动参数（空格分隔），可为空",
        "en": "Extra command-line arguments, space separated"
      },
      {
        "name": "waitMs",
        "type": "number",
        "zh": "等待主窗口超时毫秒，默认 60000",
        "en": "How long to wait for the main window (default 60000)"
      },
      {
        "name": "force",
        "type": "boolean",
        "zh": "true = 先结束正在运行的目标客户端再启动（卡死重启用）。破坏性操作：会真的杀掉客户端进程，先跟用户确认。",
        "en": "DESTRUCTIVE: kill the running target client first, then start it (restart a hung client). Confirm with the user before using."
      },
      {
        "name": "allowSensitive",
        "type": "boolean",
        "zh": "启动后那张界面截图默认会做视觉描述；若焦点在密码/验证码控件上则**默认拒绝**描述（像素无法脱敏），需要时传 true",
        "en": "The post-launch screenshot is described by a vision model; if the focused control is a password/captcha field the description is refused by default — set true to override"
      }
    ]
  },
  "ui_live": {
    "name": "ui_live",
    "descZh": "agent 实时看见客户端界面：后台循环持续抓「窗口内容」帧（不抢前台、不恢复最小化），随时取最新一帧截图 + 控件状态摘要 + 帧变化感知。action：start（启动后台循环，intervalMs 默认 1500ms；幂等）/ stop / status（当前快照）/ frame（取最新帧信息，fresh=true 强制新抓一帧；未启动时退化为一次性捕获）/ wait（阻塞到帧变化，fromHash 为基线 hash，timeoutMs 默认 30000）。拿到 frame 后 read_image(frame.pathAbs) 即「看见」客户端当前画面（**pathAbs 才是绝对路径**；frame.path 只是文件名，直接喂给 read_image 会在当前工作目录里找、必然失败。截图只在 E 盘证据目录）。wait 返回 changed=true 时 hash 变了=画面变了（行情动画也会触发，多看一眼无害；要语义结论时对 pathAbs 按需做视觉描述——循环内绝不自动调视觉模型）。敏感帧：焦点在密码/验证码/token 控件时 frame.secretFocused=true，默认不返回任何路径（path 与 pathAbs 都为 null，像素无法脱敏），需显式 allowSensitive=true 才给。图形/脚本消费：/api/dsh-ui-drive/live/start|stop|status|frame|frame.png（回环）。Triggers: 实时看见 / 实时视图 / 看现在的界面 / 等界面变化 / live view.",
    "descEn": "Watch the running client continuously: a background loop grabs \"window content\" frames without stealing the foreground or restoring a minimized window. action=start (idempotent; intervalMs default 1500) / stop / status (current snapshot, no new capture) / frame (latest frame info: path + hash + control summary; fresh=true forces a new capture; degrades to a one-shot capture when not started) / wait (block until the frame hash changes; fromHash is the baseline, timeoutMs default 30000). Read the returned path with a vision-capable model to actually see the screen. Frames whose focus is a password/captcha/token control do NOT return a path unless allowSensitive=true - pixels cannot be redacted. Only start the loop when you need to watch changes over time; for a single look use frame.",
    "params": [
      {
        "name": "action",
        "type": "string",
        "enum": [
          "start",
          "stop",
          "status",
          "frame",
          "wait"
        ],
        "required": true,
        "zh": "start | stop | status | frame | wait",
        "en": ""
      },
      {
        "name": "intervalMs",
        "type": "number",
        "zh": "截图间隔毫秒，默认 1500",
        "en": "Frame interval ms (default 1500)"
      },
      {
        "name": "stateIntervalMs",
        "type": "number",
        "zh": "控件状态采集间隔毫秒，默认 3000",
        "en": "Control-state sampling interval ms (default 3000)"
      },
      {
        "name": "maxControls",
        "type": "number",
        "zh": "state 最多返回控件数，默认 40",
        "en": "Max controls in the state summary (default 40)"
      },
      {
        "name": "fresh",
        "type": "boolean",
        "zh": "frame 时强制新抓一帧",
        "en": "frame: force a new capture"
      },
      {
        "name": "fromHash",
        "type": "string",
        "zh": "wait：基线帧 hash（区间的起点）",
        "en": "wait: baseline frame hash"
      },
      {
        "name": "timeoutMs",
        "type": "number",
        "zh": "wait：最大等待毫秒，默认 30000",
        "en": "wait: max wait ms (default 30000)"
      },
      {
        "name": "allowSensitive",
        "type": "boolean",
        "zh": "敏感帧（焦点=密码/验证码）也返回 path（默认拒出）",
        "en": "Return a frame path even when a password/captcha control has focus"
      }
    ]
  },
  "ui_drive": {
    "name": "ui_drive",
    "descZh": "对正在运行的目标客户端执行单步 UIA 操作（实时、有状态）。动作：find 定位控件；read 读可见控件（含输入框真实 value 与 #序号，序号可当 index 复用）；windows 列出该进程所有顶层窗口（**顶层窗口**各自一行；⚠ 登录窗/许可协议/模态框常常是主窗口**内部的嵌套窗口元素**、**不在顶层清单里** —— 那种情况用 ui_windows，它会额外列出来）；shot 截主窗口 PNG（describe=true 直接返回视觉描述）；waitfor 等条件成立（state=appear|gone|enabled|disabled）；click 点击；setvalue ValuePattern 写值；key 键盘输入（中文走剪贴板粘贴）；type 键盘序列（{ENTER}/{TAB}/{ESC}/{DOWN}/^a 等，用于回车提交、Tab 跳转、下拉选择）；drag 鼠标拖拽（滑块验证码）。read/state 结果恒带 skipped=N（读不到状态被跳过的元素数），>0 时附 warn 提示「清单不完整」。动态界面三件套：waitFor={ms,interval,state,match,index} 让 click/setvalue/key/type/find/expect/read/state 先等条件成立再动手（不再靠猜 sleep）；index 取同名控件的第 N 个；inAid/inName 把查找限定在某个容器内（read/state 同样生效，结果会标 范围=…，**没标就是整个窗口**）。。注意：点击/输入是真实副作用操作（可能落库），必须先报按钮名给用户确认再执行；「按名硬拒」名单默认为空（未配 DSH_UI_DENY_RE 时什么都不拦），别拿它当兜底；运维若配了急停（DSH_UI_ESTOP_FILE）或策略表（DSH_UI_APP_POLICY），被拦时返回带 policyCode，复位走运维路径 /api/dsh-ui-drive/estop/reset。click/setvalue/key/type/drag/clickat/doubleclick 必须传 allowSideEffects=true 才执行。截图一律写入证据目录（DSH_UI_EVIDENCE_DIR），不写仓库；需要视觉复核时用 `describe_image` 读返回的 path（该工具由宿主提供、**本面不一定有**；没有它就 `read_image`）。Triggers: 驱动客户端 / 点一下 / 输入 / 截图验证 / UI self-verify.",
    "descEn": "Drive the running desktop client via Windows UIA (real-time, stateful). Actions: find (locate a control) / read (visible controls, with the real input value and a #index reusable as `index`) / windows (all top-level windows) / shot (PNG; describe=true returns a vision description) / waitfor (block until a condition holds: state=appear|gone|enabled|disabled) / click / setvalue (ValuePattern) / key (clipboard paste for CJK) / type (SendKeys sequence: {ENTER} {TAB} {ESC} {DOWN} ^a …) / drag (mouse drag, e.g. a slider captcha). For dynamic UIs: pass waitFor={ms,interval,state,match,index} on click/setvalue/key/type/find to wait for the condition BEFORE acting (no more guessing sleeps); use index for the Nth same-named control and inAid/inName to scope the search to a container. read/state also honour inAid/inName (container scope), winTitle (cross-window) and waitFor (wait for the list to render before reading); a scoped listing is labelled narrowed+scope — an unlabelled listing covers the whole window. find / read / windows / shot / waitfor are read-only; click / setvalue / key / type / drag are real side effects and REQUIRE allowSideEffects=true.",
    "params": []
  },
  "ui_observe": {
    "name": "ui_observe",
    "descZh": "只读观察（推荐入口，无需 allowSideEffects）：find 定位 / read 读控件与真实输入值 / state 界面快照（窗口+焦点+交互控件）/ windows 顶层窗口 / waitfor 等条件成立 / expectwindow 窗口出现或消失 / expecttext 文本出现 / waitany 多条件竞速 / shot 截图。read/state 结果恒带 skipped=N（本次枚举里读不到状态被跳过的元素数），>0 时附 warn 明说「清单不完整」——「没读到」不等于「界面上没有」。动态界面（登录、验证码、按界面情况分支）的循环就是：ui_observe 看现状 → 决定 → ui_act 动手 → 再 ui_observe 确认。范围与等待（UD-04）：read/state 也认 inAid/inName（限定容器）与 winTitle（跨窗口），以及 waitFor（等条件成立再读，最常用于「等列表刷出来再读」）；被限定过的清单会标 narrowed+scope，**没标就是整个窗口**。waitany 是判定登录结果的关键：一次同时押注「主窗口出现」「错误文本出现」「登录窗口还在」三支，返回命中的那支。Triggers: 看界面 / 等条件 / 判断登录结果 / observe.",
    "descEn": "Read-only UI observation (recommended entry point; no allowSideEffects needed). Actions: find / read (controls + real input values) / state (snapshot: window + focus + interactive controls) / windows / waitfor / expectwindow / expecttext / waitany / shot. The dynamic-UI loop is: ui_observe -> decide -> ui_act -> ui_observe. read/state also honour inAid/inName (container scope), winTitle (cross-window) and waitFor (e.g. wait for a list to render before reading); a scoped listing is labelled narrowed+scope — an unlabelled listing covers the whole window. waitany is how you adjudicate a login: bet on \"main window appeared\", \"error text appeared\" and \"login window still there\" at once and get back which one hit (with stableCount confirmation to avoid transient states).",
    "params": []
  },
  "ui_act": {
    "name": "ui_act",
    "descZh": "真实操作客户端（副作用，必须 allowSideEffects=true）：click 点击 / setvalue 写值（受限输入框如手机号框走它，绕开按键过滤）/ key 键盘输入（中文走剪贴板）/ type 键盘序列（{ENTER}/{TAB}/{ESC}，回车提交、Tab 跳转）/ drag 鼠标拖拽（滑块验证码）。写输入后驱动会回读校验，值没进去直接报错（不再假成功）；密码/验证码类控件的值不回显、不落证据；「按名硬拒」名单**只在运维显式配置 DSH_UI_DENY_RE 后才生效**——默认为空（什么都不拦），所以\"能点得动\"不等于\"该点\"，别把它当护栏。observe=true 时动作后直接附带界面快照（窗口+焦点+交互控件），省一次往返。凭据用 ${cred:name} 占位符（驱动进程从环境变量 DSH_CRED_name 展开，模型看不到明文）。。注意：点击/输入是真实副作用操作（可能落库），必须先报按钮名给用户确认再执行；「按名硬拒」名单默认为空（未配 DSH_UI_DENY_RE 时什么都不拦），别拿它当兜底；运维若配了急停（DSH_UI_ESTOP_FILE）或策略表（DSH_UI_APP_POLICY），被拦时返回带 policyCode，复位走运维路径 /api/dsh-ui-drive/estop/reset。Triggers: 点一下 / 输入 / 登录 / 拖滑块 / ui act.",
    "descEn": "Real UI action (side effects; allowSideEffects=true required): click / setvalue (use this for key-filtered fields such as a phone box) / key / type ({ENTER} {TAB} sequences) / drag (slider captcha) / clickat (client-area coordinates, for table rows or chart points where UIA cannot give a stable element - fragile, invalidated when the window moves) / doubleclick (element-level) / pattern (invoke a UIA pattern the element actually exposes; put the action name in value, e.g. Expand|Collapse|Increment|Decrement|Select|AddToSelection|RemoveFromSelection|ScrollIntoView|Toggle|Invoke|Focus|Close|Minimize|Maximize|Restore; unsupported patterns report an error instead of falling back to a click) / scroll (semantic ScrollPattern: direction in value, pages in count) / selecttext (TextPattern selection: text in value, prefix in match, suffix in expectValue, selectionType in state). Input is read back and verified — a value that did not land is ok:false, never a silent success. Password/captcha fields are never echoed. A name-based hard-deny list is enforced in the driver and allowSideEffects cannot unlock it: any control whose name/AutomationId matches DSH_UI_DENY_RE is refused. The list is EMPTY by default (nothing is denied unless the operator configures it), so the refusal always names the control, prints the active list, and says how to fix a false positive. observe=true attaches a UI snapshot after the action. Credentials: pass ${cred:name}; the driver expands DSH_CRED_name from its own environment, so the secret never enters the model context or the evidence files.",
    "params": []
  },
  "ui_replay": {
    "name": "ui_replay",
    "descZh": "执行 ui_flow 生成的 replay.json，复用同一套动作/观测协议与证据目录；含副作用时仍需 allowSideEffects=true，并可传 approvalId 绑定应用身份和授权生命周期。",
    "descEn": "Replay a replay.json produced by ui_flow using the same action/observation protocol and evidence ledger. Side-effect steps still require allowSideEffects=true and may be bound to an approvalId.",
    "params": [
      { name: 'replayPath', type: 'string', required: true, zh: 'ui_flow 生成的 replay.json 绝对路径', en: 'Absolute path to replay.json produced by ui_flow' },
      { name: 'allowSideEffects', type: 'boolean', zh: '回放含副作用步骤时必须显式传 true', en: 'REQUIRED true when replay contains side-effect steps' },
      { name: 'failFast', type: 'boolean', zh: '失败后停止，默认 true', en: 'Stop after the first failure; default true' },
      { name: 'tag', type: 'string', zh: '本次回放证据标签', en: 'Evidence label for this replay' },
      { name: 'approvalId', type: 'string', zh: '回放授权 ID', en: 'Application-bound approval ID for this replay' },
      { name: 'sessionId', type: 'string', zh: '授权会话 ID', en: 'Session owning the approval' },
    ]
  },
  "ui_flow": {
    "name": "ui_flow",
    "descZh": "按步骤序列驱动客户端并收集自验证据：steps 数组每步 {action: find|click|setvalue|key|type|drag|read|windows|shot|wait|waitfor|expect, name?, aid?, value?, keys?, ascii?, match?, index?, inAid?, inName?, waitFor?, state?, fromX?/fromY?/toX?/toY?, waitMs?, label?, expectEnabled?, expectMatch?}；expect/waitfor 步做断言并计入 passed/failed（waitfor 等条件成立：state=appear|gone|enabled|disabled）；waitFor 可挂在任意动作上（先等再动，替代固定 sleep）；index 取同名控件第 N 个，inAid/inName 限定容器。每步输出+截图写入证据目录 steps.json，返回 transcript。默认只读（find/read/windows/shot/wait/waitfor/expect），含 click/setvalue/key/type/drag 必须传 allowSideEffects=true。failFast=true 时断言失败即停。整段序列在一个 PowerShell 进程里批量执行（步间无进程启动开销），waitMs 只在动作需要静默时传（默认 250ms，find/read/shot/expect/windows 不等待）。需要「看一步再做下一步」的复杂流程（登录、验证码、按界面情况分支）用 ui_drive 逐步走，别用 ui_flow 预排。Triggers: UI 自验 / 自动验证流程 / 端到端验证 / ui flow.",
    "descEn": "Run a UI verification sequence and collect steps.json/replay.json evidence. find/read/windows/shot/wait/waitfor/expect are read-only; effect actions require allowSideEffects=true. Steps support selectors, index/container scope, waitFor conditions and coordinate endpoints. expect/waitfor contribute to passed/failed counts. Ordinary flows batch in one PowerShell process; approval-bound and visual-fallback flows reauthorize each step. Runtime depends on waits, identity checks and the target UI. Use ui_drive stepwise when later actions depend on observing earlier results.",
    "params": []
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

/**
 * P1-1c（并发标记）单一真源。**纯只读**工具集 —— 不起子进程、不写状态、不冻结/删除。
 * 判据（严格 deny-first，拿不准就当**非**只读）：
 *   · 只读现状/读既有产物：build_status/errors/compile_check、ui_status/state/windows/tree/observe、
 *     perf_report/heap/analyze/gcroot（读已存在的 dump；gcroot 起 HeapRoots.exe 只读、不落盘）、hang_status/packs/pack、memory_search/recall/status、
 *     failure_query/stats、capture_query/status（sampleSeconds 只轮询、不改库）、toolchain_status。
 *   · **不**列入（有副作用/起进程/改状态）：build_run、ui_act/drive/flow/launch/live、
 *     perf_probe/dump/trace/hotstacks/flame/clean（起采样器/冻屏/删证据；flame 起 xperf dumper + 落 folded/html/CSV）、
 *     **perf_clrevents（起 tracerpt 子进程 + 落一份 XML 到盘上 —— 按"拿不准就当非只读"归此）**、
 *     hang_run/stop/analyze/delete
 *     （analyze 起 DumpStack；run/stop 改监测状态）、memory_index/save/forget、failure_record/retract、
 *     capture_start/stop/append、http_request（openWorld 外部副作用）、verify_report（落盘报告 + 记语料库）。
 * 两面各取所需：MCP 面 → `readOnlyHint`（客户端可并行分发只读工具）；DSH 面 → `isConcurrencySafe`
 * （宿主 executionMode 缺省即串行，见 @deepseek-ai/dsh-tools）。同一份集合驱动，不漂移。
 */
const READ_ONLY = new Set([
  'build_status', 'build_errors', 'build_compile_check',
  'ui_status', 'ui_state', 'ui_windows', 'ui_tree', 'ui_observe',
  'perf_report', 'perf_heap', 'perf_analyze', 'perf_gcroot',
  'hang_status', 'hang_packs', 'hang_pack',
  'memory_search', 'memory_recall', 'memory_status',
  'failure_query', 'failure_stats',
  'capture_query', 'capture_status',
  'toolchain_status',
])

/** 该工具是否**纯只读**（可并行/无副作用）。未知工具按**非**只读处理（fail-closed）。 */
export function isReadOnly(toolName) {
  return READ_ONLY.has(toolName)
}

/**
 * MCP 面工具注解：只读工具回 `{ readOnlyHint: true }`，否则回 undefined（不注解）。
 * 供 server.tool 作第 4 个实参插入；SDK 已验证支持 tool(name,desc,shape,annotations,cb) 且注解原样进 tools/list。
 */
export function mcpAnnotations(toolName) {
  return isReadOnly(toolName) ? { readOnlyHint: true } : undefined
}
