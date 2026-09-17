# 与 PerfView 的能力对照（2026-09-17 实测）

问题：**「我们的工具有没有 PerfView 这种效果？」**
结论：**只有 CPU 采样那一半；GC / 分配那一半当时没有，现已补上解析侧**。而且 CPU 那半在本机
对「客户端自己的代码」是瞎的 —— 原因见 §3，是本次实测查清的。

本文件里每一条都带可复跑的判据（调用 / 期望 / 实际 / 证据）。**没跑过的写「未验证」**。

---

## 1. 逐块对照

| PerfView 能力 | 我们 | 证据 |
| --- | --- | --- |
| CPU 采样 → 调用链、包含/独占、调用者/被调用者 | ✅ 有 | `perf_trace` + `perf_hotstacks`；`lib/trace.mjs` 的 `parseStackReport` 产出 `hotFunctions{inclusive,percent,exclusive}` + `butterfly{callers,callees}` + `modules` + `unknownRatio`；命令 `xperf -i etl -o hotstacks.html -a stack -butterfly <minHits>` |
| 符号解到**我们自己的代码**（JIT 托管方法名） | ✅ 有（2026-09-17 补，火焰图侧） | `perf_trace(jit=true)` 采 rundown 方法表 + `perf_flame` 自动 join：`"Unknown"!0xADDR` JIT 帧 → 真实托管方法名（`lib/jitmap.mjs`）。§4 的 join **实测通过**（devenv：`"Unknown"!0x…4e152e8b`→`VsHostExecutionContextManager.Revert`）。⚠ 目前只接进**火焰图**；`perf_hotstacks`（xperf HTML 报告那条）尚未接同一映射，见 §3/§4 |
| GC 停顿 / 各代 / 托管堆 / 锁争用 | ✅ 解析侧有（2026-09-17 补） | `perf_clrevents`；解析器 `lib/clr-events.mjs`；三态见 §2 |
| 分配调用栈（"谁分配的"） | ✅ 有（2026-09-17 补） | `perf_trace(alloc=true)` 采 `GCAllocationTick`(每~100KB、带类型+字节)**并附栈**（xperf 用户会话，provider 串带字面量 `:'stack'`）+ `perf_allocflame` 按**字节加权**折成分配火焰图 + Top 分配类型（对标 PerfView GC Heap Alloc Stacks）。复用 §4 JIT 映射解客户端分配路径。真机验过（devenv：`ExecutionContext`/`Task<int>`/`MultiplexingStream.ReadFrameAsync` 等分配大头）。⚠ 采样非精确、分配 ≠ 泄漏（答"谁造 GC 压力"）；⚠ 仅 .NET Framework 客户端能解 manifest |
| 堆 / 保留链 / GC root | ✅ 有（2026-09-17 补） | `perf_gcroot`：自建 ClrMD 分析器 `HeapRoots.exe`（源码 `plugins/dsh-perf/tools/heaproots/`，与 DumpStack 同目录、零新增配置）——托管堆 Top 类型 + 对指定类型的 **GC root → 对象 保留链**（root 种类 + 沿途类型）。对照 PerfView `!gcroot`。真机 ground-truth 验过（static List 诱饵：`StrongHandle → Object[] → List<LeakBait> → LeakBait[] → LeakBait`，x86/x64 均可）。⚠ 仍是**仅托管堆 + 单次快照**（非托管/工作集看不到；大 ≠ 泄漏），口径钉在 `renderGcRoot` |
| **UI Freeze / 等待时间分析（wall-clock）** | ✅ 有（2026-09-17 补，解析+合成验，**待真机端到端**） | `perf_uifreeze`：起 **CSwitch** 内核会话，线程切出→切回的时间差=阻塞时长、切换点栈=卡在哪，把 UI 线程整段时间轴按栈归因 → 「UI 冻结 N 秒，其中 M 秒卡在 `HttpGet`」。两段式 start/stop，UI 线程 tid 自动认（stop 抓瞬时 dump 取 uiThread.osId）。解析器 `lib/uifreeze.mjs`，agent 文本 `renderUiFreeze`。**这是用户那张 PerfView UI Freeze 截图（16205ms/98.5% waiting/CPU 0.2%/元凶 HttpUtility.HttpGet）的对口视图** —— perf_flame（CPU 采样）对 98% 在等的冻结几乎是空的、perf_dump（瞬间）抓分阶段短冻结会 race，都给不了这个。合成用例已验时长归因（8ms→`QuantitativePlatformView.Loaded→HttpUtility.HttpGet→HttpWebRequest.GetResponse`）；⚠ WaitTime 列的哨兵值 0xFFFFFF 不可信，改按相邻 CSwitch 时间戳差自算 |
| dump 分析 + 源码定位 | ✅ 有，**比 PerfView 顺手** | `perf_dump`/`perf_analyze`/`hang_analyze`：UI 线程栈（`uiLikely`）+ 锁热点线程 + `文件:行号`；PerfView 没有"哪条是 UI 线程"这个概念 |
| 交互式 GUI / 火焰图 | ✅ 有（2026-09-17 补） | `perf_flame`：`xperf -a dumper` 逐样本 + `Stack` 事件按 `(ts,tid)` join → **流式**折叠成 folded，产出**自包含可交互** `flame.html`（点击缩放/悬停/搜索/按模块着色，内联 SVG+JS 无外链）+ `flame.folded`（可拖进 speedscope.app）。解析/编排 `lib/flame.mjs`+`trace.mjs`，agent 文本 `renderFlame`。**实测**（ClientApp，248MB etl / 30s）：14962 采样折成 3208 唯一栈、340KB HTML、dumper 49s / 合计 78s、中间 CSV 2.28GB（流式读完自动删）；最热模块 ntdll/clr/`[unknown]`/mscorlib/WindowsBase/PresentationFramework/user32/wpfgfx——一条真实 WPF 画像。⚠ 那次实测**没带** `jit=true` ⇒ 客户端自己的方法聚成 `[unknown]`（JIT，见 §3）；带 `perf_trace(jit=true)` 后由 §4 的 join 解名 |

另外一条**我们独有**：`perf_probe` 不挂剖析器、直接测 UI 消息泵响应耗时 —— PerfView 结构性给不了
「14:03:22 那一秒 UI 被卡了 2 秒」。口径限制照旧：只测 UI 线程，非 UI 线程的卡顿测不到。

> **未验证**：本机 **PerfView 未安装**（`C:\PerfView`、`Program Files`、`Program Files (x86)`、
> `%USERPROFILE%` 四处皆 False）。所以「PerfView 能解出客户端自己的方法名」是**按机制推断**，
> **没有在本机对客户端实测过**，不要当已证事实引用。

---

## 2. 本次补上的：`perf_clrevents` + `perf_trace(clr=true)`

### 为什么需要「独立会话」

本机 WPR **收不了尾**（`engine=auto` 会路由到 xperf），而 xperf 那条通道的参数
`PROC_THREAD+LOADER+PROFILE+CSWITCH` 是**纯内核 flag**。实测：279 MB 的 `trace.etl`
经 `tracerpt -summary` 汇总，**连 `e13c0d23` 都不在里面**（CLR provider 从没被打开过）。
⇒ 不额外起一条会话，就**永远拿不到 GC 数据**。

采集用 `logman` 起一条**只挂 CLR provider** 的用户态会话（不依赖坏掉的 WPR），与内核会话并行。
**交付的实现只挂 GC 那一个 provider**：

```
logman start dshperfclr -p Microsoft-Windows-DotNETRuntime 0x4001 0x5 -o <dir>\clr-events.etl -ets
```

> ⚠ `logman start` **不接受第二个 `-p`**。实测（2026-09-17）：
> `logman start x -p A 0x18 0x5 -p B 0x18 0x5 -o f.etl -ets` → `Argument 'p' has been defined too
> many times.`，退出码 `0x80070057`。要挂多个 provider 就得起**多条会话**（spike v2 正是如此：
> 两条会话各挂一个 provider、各自成 etl）。**我的第一版实现就踩了这个坑**（`CLR_PROVIDERS` 里放了
> 三个 provider ⇒ 拼出多条 `-p`），写下这段记录的同一个小时里被抓出来。
>
> `0x18`（Loader|JIT）与 `...Rundown` 的产出是给 §4 那条地址→方法 join 用的 —— 它已由**另一条独立会话**
> （`perf_trace(jit=true)`，`Microsoft-Windows-DotNETRuntimeRundown 0x118`）承接，产 `jit-methods.etl`。
> 所以 `clr=true` 这条**故意只挂 GC**：白挂 0x18 只会多付磁盘与未测量的开销，而 join 要的是 rundown-at-stop 那条。

### 三态（这个工具真正的价值）

| 事实 | 必须说的话 | 绝不许说 |
| --- | --- | --- |
| etl 里没有 `e13c0d23` / `a669021c` | 「**没采**」+ 列出实际有哪些 provider | 「GC 共 0 次」 |
| provider 在、窗口内 0 条 `GC/Start` | 「这段窗口确实没发生 GC」（与"没采"是两回事） | —— |
| 解码失败 / 超时 / 体积超限 | 「**未知，不是 0**」 | 「0 次」 |

漂移的后果是具体的：agent 会拿那个 0 去回答「客户端有没有 GC 停顿」。

### 便宜闸门

`tracerpt <etl> -summary <txt> -y`（**不带 `-o`**）不生成 XML。实测 79.5 MB 的 etl **14 秒**出摘要，
足够回答前置问题；不带这道闸，解码体积实测是 etl 的 **4~6×**（303 KB→1.80 MB、2.9 MB→12.7 MB、
13.4 MB→53.7 MB），几百 MB 的系统 trace 会变成 GB 级。

### 三个实测细节（都是踩出来的）

**① 摘要里可能有**两张**表 —— 全加会得到恰好 2 倍的数字。**
第一张按 `(Event Name, Task, Opcode, Version, Guid)`，第二张按 `(Event Name, Event ID, Version, Guid)`；
**同一个事件在两张表里各出现一次**。CLR fixture 第一张表 CLR 行合计 **1548**，两张一起加就是 **3096**。
这种错法特别毒：数字看起来完全合理，而 "Σ provider 行 == Total Events Processed" 这条自洽检查
在**只有一张表**的 etl 上（79.5 MB 的 `r61-dumped.etl` 就只印了一张）**照样通过**。
⇒ 只统计含 `Opcode` 列的那张；两份 fixture 都要跑那条不变量。
发现方式：真机 e2e 里摘要说 `runtime 940 条`、而同一份 etl 解码后只解析出 470 条 —— **恰好 2 倍**。

**② provider 名要从 etl 自己的摘要表取，不要反查注册表。**
第一版走 `logman query providers` 反查 GUID→名字，真机实测**内核那几个 GUID 在注册表里查不到**：
167 MB 的 xperf trace 里 10 个 provider **全部**落成「(未收录)」。改从摘要表的 Event Name 列取
（`Thread` / `StackWalk` / `PerfInfo` / `Image` / `Process` / `SystemConfig` / `EventTrace`）之后就正确了。
⚠ 有几行第二列是 `0`（未知/经典事件）—— 那是**没有名字**，判为 null 并列成「(未收录)」，不编名字。

**③ `tracerpt` 把 `SystemTime` 的时区渲染成 `+07:59`**，而本机是 `+08:00`（fixture 里 **1550/1550** 条
都是 `+07:59`）⇒ **绝对时刻有约 1 分钟系统性偏差**；停顿时长是**差值**，不受影响。渲染层已如实标注。

---

## 3. 本次查清的：为什么客户端自己的方法名解不出来

**根因：客户端自己的程序集是运行时 JIT 的**，代码不在 PE 镜像的静态地址上，dbghelp 拿到采样地址
认不出是哪个方法 —— 所以**光加 pdb 目录没用**（`DSH_PERF_SYMBOL_PATH` 里其实已经把客户端
`产物目录` 加进去了）。F-043 的实测：客户端 pid 26868、6 秒、100% 采样落在该进程，
报告里 20 个模块有名字、**客户端自己的模块/方法出现 0 次**。

试过一次的 `clr-rundown.wprp` 既**失败**又**污染测量**（同 8 秒：内置 CPU 档 28833 次独占命中，
rundown 档只有 539 次；46% 的包含命中落在 ETW 投递帧上，对照组一条都没有）—— 那份记录保留在
`lib/clr-rundown.wprp` 的注释里，免得下一个人重做同一个实验。

---

## 4. 追平 PerfView 的那条路：代码级证据（**已落地，火焰图侧**）

PerfView 解 JIT 代码靠的是消费 CLR 的 JIT/MethodLoad（+ rundown）事件自建"地址→方法"映射表，
再回填 CPU 采样点。本次把这条路的两半都实测过了：

### 4.1 地址→方法映射表：**有**（spike v4，2026-09-17）

用 `csc.exe` 编一个**真·磁盘程序集**，在活会话下调用它：

```
csc /target:library /out:DshProbe4.dll Probe4.cs      # 方法带 [MethodImpl(MethodImplOptions.NoInlining)]
logman start dshrt4 -p Microsoft-Windows-DotNETRuntime 0x18 0x5 -o v4.etl -ets
… 调用 …
tracerpt v4.etl -o v4.xml -of XML -y
```

结果：`MethodNoInline` **出现 4 次**；`<MethodJittingStarted` 426 条、`<MethodLoadUnloadVerbose` 426 条。
事件载荷带齐 join 需要的全部字段：

```xml
<MethodLoadUnloadVerbose_V1>
  <MethodID>0x7FFACD98B750</MethodID>  <ModuleID>0x7FFACCF38178</ModuleID>
  <MethodStartAddress>0x7FFACCDA7840</MethodStartAddress>  <MethodSize>0x66</MethodSize>
  <MethodNamespace>dynamicClass</MethodNamespace>  <MethodName>lambda_method77</MethodName>
</MethodLoadUnloadVerbose_V1>
```

> ⚠⚠ **第一版探针给出了假阴性，务必记住**：最初的探针是 `x * 11 + 5` 这种一行叶子方法 ——
> 被 JIT **内联**掉了，于是**一个 MethodLoad 都没有**（`DshProbe` 只在 `<AssemblyLoadUnload_V1>` 里
> 出现过，12 个有方法记录的 ModuleID 里没有它）。加了 `NoInlining` 立刻就有了。
> **内联的方法本来就不该有独立 MethodLoad**（它的代码在调用者体内）—— 这不是缺陷，是机制；
> 但用玩具方法做探针时会把它误读成"机制不行"。

> ⚠ 另一个**踩过的测量陷阱**：统计 XML 命中数时我用了 `Select-String -SimpleMatch -AllMatches`
> 再取 `$_.Matches.Count` —— 两个开关一起用时 `Matches` 是**空的**，于是**所有计数都印成 0**，
> 我差点据此得出"映射表不覆盖应用程序集"的错误结论。改用
> `[regex]::Matches($text, $pat).Count` 才是真值。**"0" 必须先证明计数器本身没坏。**

### 4.2 CPU 采样点：**有，而且未解析的帧直接印地址**

`xperf -i <etl> -o out.csv -a dumper` 每行样例（真采样，79.5 MB 的 `r61-dumped.etl`）：

```
SampledProfile, 29516, svchost.exe (5396), 7180, 0xfffff8002a83f846, 0,
                Svchost.dll!0x00007fff1fc5c8b4, ntoskrnl.exe!0xfffff8002a83f846, 1, Unbatched
SampledProfile, 29608, copilot-language-server.exe (32528), 2004, 0x00007ff6295421ce, 8,
                ...   "Unknown"!0x00007ff6295421ce,     1, Unbatched
```

- 列里有 **`PrgrmCtr` = 指令指针**；
- **未解析的帧直接把地址印出来**（`"Unknown"!0x…`）—— 这正是 join 的输入。
- 该 etl 的 `PerfInfo/SampleProf` = **37,974** 条，与 CSV 里 **37,976** 行 `SampledProfile` 吻合。

### 4.3 成本（这是这条路真正的代价）

| 项 | 实测 |
| --- | --- |
| `xperf -a dumper` 于 79.5 MB etl | **585 MB CSV / 15 秒**（×7.36） |
| 同一 etl 的 `tracerpt -summary` | 9 KB / **14 秒** |
| 解码 XML 相对 etl | **×4~6** |

⇒ 客户端跑 5 分钟（约 275 MB etl）会得到 **~2 GB CSV**。**必须在流式解析里按进程名过滤**，
不能整份读进内存。

### 4.4 观测污染（2026-09-17 **已测，通过**）

`clr-rundown.wprp` 那次证明**采集本身会污染被观测进程**（46% 的命中落在 ETW 投递帧上）。
本次 `perf_trace(jit=true)` 的 JIT 会话与那次的**本质区别**：它挂的是 rundown provider、keyword `0x118`
**不含 StartRundown**，DCEnd 只在**会话停止那一刻**触发 ⇒ 采样窗口内它基本不产事件。
实测（e2e-jit，devenv 992 采样）：折叠后**ETW 投递帧（Etwp*/EtwWrite）占比 0.00%**（对照那次 46%）
⇒ **rundown-at-stop 这条通道对采样窗口的污染可忽略**。这与"独立第二条会话 + 只在 stop 吐"的机制一致。
（口径：这是"投递帧占比"这一个代理指标，不是开/不开的完整 A/B；但机制 + 该指标一起足以支持"低污染"的结论。）

---

## 5. 现在的状态

- **已交付**：`perf_clrevents`（DSH + MCP 两面）+ `perf_trace(clr=true)`；解析器与渲染层单测；
  三态渲染的判据钉在 `plugins/dsh-perf/test/clrevents-render.test.mjs`。
- **已交付（2026-09-17，§1 那条「分配调用栈」）**：`perf_trace(alloc=true)` + `perf_allocflame`（DSH + MCP 两面）——
  `GCAllocationTick`(GC keyword 0x1, Verbose, 每~100KB 一次) 配 xperf 用户会话的字面量 `:'stack'` 附调用栈，
  按 (ts,tid) join、**按字节加权**折叠（`lib/flame.mjs` 的 `foldAllocCsv`），产分配火焰图 + Top 分配类型。
  复用 §4 JIT 映射解客户端分配路径。渲染 `renderAllocFlame`，单测 `test/allocflame.test.mjs`（TypeName 引号提取）。
  · ⚠ 实测踩坑：分配是 xperf **用户会话**，事件进程名是 `"Unknown"(PID)` ⇒ 折叠按 **PID** 过滤（live 查 tasklist / 传 pid），不能按名。
  · ⚠ 实测踩坑：`:'stack'` 的单引号是**字面量**（spawn 不过 shell 才能原样传）；且只对 manifest 能解的 CLR 有效
    （.NET Framework 客户端 ✓；.NET Core/5+ 落成 UnknownEvent/Crimson —— 我们的目标客户端是前者）。
- **已交付（2026-09-17，§1 那条「堆/保留链/GC root」）**：`perf_gcroot`（DSH + MCP 两面）——
  自建 ClrMD 分析器 `HeapRoots.exe`（源码 `plugins/dsh-perf/tools/heaproots/`，net10.0 + ClrMD 4.0.732401，
  发布为 win-x86 与 DumpStack 同目录，perf.mjs 从 DumpStack 路径**自动派生**、零新增配置）。托管堆 Top 类型 +
  对指定类型对象的 **GC root → 对象 保留链**（自实现有界 BFS：只用 EnumerateRoots + EnumerateReferences）。
  ground-truth 真机验过（static List 诱饵，x86/x64 dump 都读得了）；渲染层单测 `test/gcroot-render.test.mjs`。
  口径（钉在 renderGcRoot）：**仅托管堆 + 单次快照**，大 ≠ 泄漏、非托管/工作集看不到。
- **已交付（2026-09-17，§1 那条「交互式 GUI/火焰图」）**：`perf_flame`（DSH + MCP 两面）——
  `xperf -a dumper` 逐样本 + `Stack` 事件按 `(ts,tid)` join 出完整栈，**流式折叠 + 按进程过滤**（正合 §4.3
  「必须流式、按进程名过滤，不能整份读进内存」），产出自包含可交互 `flame.html` + `flame.folded`。
  解析/编排 `plugins/dsh-perf/lib/flame.mjs` + `trace.mjs`，agent 文本 `renderFlame`。真机实测数字见 §1。
  · ⚠ 一个把 §4.2 说法**收窄**的实测：完整调用栈**不在** `SampledProfile` 行里（那行只有 ThreadStart + 叶子
    两帧），而在**独立的 `Stack` 事件**里（每行一帧，同 `(ts,tid)` 连成一栈）——火焰图折叠的是后者。
  · 客户端自己的方法在模块模式下聚成 `[unknown]` 带（JIT，见 §3）——带 `perf_trace(jit=true)` 后由 §4 的 join 解名。
- **已交付（2026-09-17，§4 地址→方法 join，火焰图侧）**：`perf_trace(jit=true)` 采 rundown 方法表
  （`jit-methods.etl`，`Microsoft-Windows-DotNETRuntimeRundown 0x118`，stop 时 DCEnd 吐、低污染见 §4.4）+
  `perf_flame` **自动发现并 join**：`lib/jitmap.mjs`（tracerpt 解码 → 按 pid 分桶的「地址区间→方法名」表 + 二分），
  折叠端按帧所属线程的 pid 查表把 `"Unknown"!0xADDR` 解成真名。单测 `test/jitmap.test.mjs`（对真 fixture）。
  实测：真工具路径 `perf_trace(jit=true)`→`perf_flame` 端到端，客户端 JIT 帧解名成功、污染 0.00%。
  · ⚠ **只接进了 `perf_flame`**（folded/html）。`perf_hotstacks`（xperf 自出的 HTML 蝶形报告）**还没接**同一映射
    ——那条路的符号解析在 xperf 进程内、要接得改喂 xperf 自定义符号或改走我们自建的解析，属下一步。
- **未接线**：`perf_hotstacks` 的 JIT 解名（见上）。§4.3 的成本（dumper CSV ~7×）由 `perf_flame` 的流式管线已消化。
  （注：`perf_flame` 已经把 §4.3 要求的「流式 + 按进程过滤」这条路铺好了，join 落地时可直接在同一条折叠管线上加地址回填。）
- **未做**：`perf_hotstacks` 那条 xperf 自出 HTML 报告里的 JIT 解名（符号解析在 xperf 进程内，要接得改喂自定义符号或改走自建解析）；
  以及 `perf_uifreeze` 的**真机端到端**（目前只有合成用例验过时长归因，见 §1 该行）。
- **未验证**：PerfView 本机没装，§1 里关于 PerfView 的描述来自其机制，不是本机测量。
