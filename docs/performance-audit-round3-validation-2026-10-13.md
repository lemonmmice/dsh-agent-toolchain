# 第三轮性能清单验证与优化（2026-10-13）

输入：2026-10-12 两份审计清单（harness-audit、e0a0cd5-performance-audit）+ 上一会话列出的"剩余 7 组"。
基线：工作区 `feat/plugin-gate-annotations`（上一轮 ~60% 成果，未提交）；第二轮全量 187 个测试文件。
平台：Windows、Node v24.15.0。

**交付方式：全部留工作区、不提交**（本轮要求）。
**范围：全推进、分级交付** —— JS 可本机验证的真做真测过闸门；Windows 原生深水区（UIA / ETL / ClrMD / 真实采集流量）
做代码结构 + 单元测试骨架 + 诚实边界，**绝不假称真机验证通过**。

## 接手第一步：基线核对

- 工作区全量：**197 个测试文件 / 0 失败**；`check.mjs`、`plugin-load-smoke` 通过（Codex 在被喊停前已修完集成回归，工具计数门已到 56）。
- 唯一 red：`mcp/smoke` 的 `build_compile_check(src)` —— 环境/夹具问题，非产品缺陷：本机 `DSH_*_SRC_ROOT` 指向真实 PC 工程，
  heuristic 对带 11 个未求值 MSBuild 条件的旧式工程**诚实**返回 `conditions-not-evaluated`，被旧用例当成功路径（expect:ok）误判为失败。见 T0。

## 各组改动

### T0 稳住基线（前置）
`mcp/smoke.mjs`：`build_compile_check` 成功路径改用**确定性夹具**（临时 legacy `.csproj` + 显式 `<Compile Include="Program.cs" />`，必 `explicit-item`/`included=true`），与本机环境解耦；真实源码根探针降为 `expect:'any'`（真实工程返回 unknown 是诚实行为、不算失败）。→ `mcp/smoke` PASS。

### T1（F 组）输出预算 + 工具 profile + Jev
- `lib/jev-client.mjs`：①响应体有界读（`MAX_RESPONSE_BYTES`=2MiB，流式 `getReader` 累加，超限 `jev_response_too_large`；兼容测试 mock 回退 `json()`）；②无副作用请求 **single-flight**（相同 `model+timeout+state+questions` 去重搭车，带外部 signal 的调用不搭车）；③外部 **signal 贯穿**整段取消（区分 `jev_timeout` / `jev_cancelled`）。`mcp/server.mjs` 的 `jev_decide` 透传 `extra.signal`。
- `lib/tool-profiles.mjs`（新）：`DSH_TOOL_PROFILE` 按域（ui/build/perf/hang/memory/capture/failure + core）精简 `tools/list`；**默认全开**（不支持动态发现的客户端零影响，`mcp/smoke` 的 DECLARED 比对不受影响）。`mcp/server.mjs` 在 `server.tool` 单一 chokepoint 接 profile 过滤。
- 输出预算：核实 `makeOutputBudget` 已统一接到 chokepoint（默认关、零回归、保留机器字段）；大证据分页/artifact 由 `verify_report` bundle 覆盖。
- 测试：`jev-client.test`（+3 用例）、`tool-profiles.test`、`mcp/tool-profile.test`（`profile=ui` → 17 工具 core+ui）。

### T2（A 组）capture 解压背压
- `plugins/dsh-api-visualizer/lib/capture-engine.mjs`：`gzip/deflate/br` 解压全部加 `maxOutputLength`=8MiB（**解压炸弹防护**，zlib 在解压过程中拦截，不先解出巨量再检查）；`export decodeContent` 供测。
- 核实已由上一轮完成：查询主路径 worker 化 + runId 索引 + stable cursor + 排序复用 + 库字节裁剪（`MAX_STORE_BYTES` / `av03-byte-cap`）。
- 测试：`capture-decode-bound.test`。
- 边界：finalize **写入侧**解压的后台化收益需真实高频捕获流量真机验证（解压不在查询热路径）。

### T3（B 组）failure 稳定游标
- `lib/failure-corpus.mjs`：`query` 加 keyset `(ts,id)` **全序** + cursor 分页（返回 `nextCursor`/`hasMore`）；**修复真 bug**：`queryAsync` 的 worker 参数白名单漏了 cursor（MCP/异步路径原本收不到 cursor，分页失效）。`lib/tool-registry.mjs` 的 `failure_query` 加 `cursor` 参数（DSH/MCP 两面从 registry 派生、自动同步）。
- 测试：`failure-corpus-cursor.test`（翻页不重不漏、顶部新增稳定、坏游标兜底）。
- 边界：按分类/runId/指纹的**持久倒排索引**在超大库才显收益，需真机大数据度量；现有分片增量解析 + `statsCache` 已覆盖常见规模。

### T4（B 组）manifest 接线 + 项目 XML 缓存
- 核实：持久 `source-manifest` 已接 `build-evidence`（`sha256-git-file-hashes-v2` 新算法标识 + 持久 `cacheDir` + `forceFull` 全量回退，不冒充 v1）。
- `lib/compile-membership.mjs`：`collectItemSources` 按已解析源文件的 `(mtime,size)` 签名缓存（`build_compile_check` 是 PostToolUse hook 热路径，重复读 `.csproj`+`Directory.Build.*`+imports）；任一相关文件变更即失效。
- 测试：`compile-membership-cache.test`（命中返回同一对象、`.csproj` 变更失效重算）。
- 后续：memory 查询向量 single-flight / 紧凑存储对照（embedding 已有 endpoint+model+text 缓存 + `index-process` 已存在）。

### T5（C 组）任务服务 + perf 阶段分离 + hang 分页
- 核实已完成：通用任务服务（`task-service` + `toolchain_job` + `mcp/task-jobs` 测试）、dump `analyze=false` 拆分、perf 取消（`process-cancellation` 接入 `runPerfExecutable`/`runPs1`）。
- `plugins/dsh-hang-inspector/lib/hang.mjs`：`listPacks` 加 `limit`（只列**最新 N 个** + 先轻量 stat 目录排序、只对选中页取完整元数据，审计"列表只读元数据"）；`registry` 的 `hang_packs` 加 `limit`；两面 handler 透传、返回结构不变。
- 测试：`packs-limit.test`。
- 后续：`hang_pack` 的 fields/maxBytes 选择性读取、`hang_delete` 异步分批（已有 512KB 文本截断兜底）。

### T6（E 组）ETL/JIT/DAC 分析缓存（分级交付）
- 核实已有：符号缓存（`DSH_PERF_SYMBOL_CACHE`）、ETL→XML reuse（trace `reuse=true` + manifest）、hang dump 指纹缓存（`sameDump` + 缓存优先/refresh）、perf attempt 独立输出（防串结果）。
- `lib/analysis-cache-key.mjs`（新）：审计 L07 的"**按输入指纹而非路径**"分析缓存键（含工具版本/PID/provider/符号策略/JIT/参数；缺维度用 `none` 占位，参数顺序无关）+ 单测。
- 边界（真机待验）：ETL/JIT 解码结果跨调用**共享缓存**与阶段耗时度量、DAC/ClrMD 只读会话复用、C# TraceEvent 直接 ETL 对照 —— 需 Windows 真机 + 真实 ETL/dump，本环境不验证收益。

### T7（D 组 + 终端）UIA / 终端快照（分级交付）
- `lib/snapshot-freshness.mjs`（新）：共享只读快照新鲜度判定（`fresh`/`stale`/`unknown` + `ageMs`，时钟回拨兜底、无 TTL 不判 stale）+ 硬边界 `canAuthorizeDestructiveAction()`≡false（审计反复强调「显示缓存 ≠ 动作授权」，破坏性动作必须实时重验身份）+ 单测。
- 核实已有：`ui_launch` 旧连接根因 + 冷/热启动身份回报、全树 CacheRequest 真机对照（未证实收益、未替换）、`ui_live` 首帧受理。
- 边界（真机待验）：UIA 独立管理/观察通道与 provider 卡死独立恢复、UI tree 显式 UIA/注入模式与节点/时间预算、逐动作等待/flow 取消（未知动作不重放）、最小化/DPI/多实例/provider 无响应矩阵、终端 inspector 同步 snapshot 源接入共享刷新 worker —— 需真机 + 真实客户端。

## 新增 / 修改文件

**新增（10）**：`lib/tool-profiles.mjs`(+`.test`)、`mcp/tool-profile.test.mjs`、`plugins/dsh-api-visualizer/test/capture-decode-bound.test.mjs`、`lib/failure-corpus-cursor.test.mjs`、`lib/compile-membership-cache.test.mjs`、`plugins/dsh-hang-inspector/test/packs-limit.test.mjs`、`lib/analysis-cache-key.mjs`(+`.test`)、`lib/snapshot-freshness.mjs`(+`.test`)、`docs/performance-audit-round3-validation-2026-10-13.md`（本文）。

**修改（≈8）**：`mcp/smoke.mjs`、`lib/jev-client.mjs`(+`.test`)、`mcp/server.mjs`、`plugins/dsh-api-visualizer/lib/capture-engine.mjs`、`lib/failure-corpus.mjs`、`lib/tool-registry.mjs`、`lib/compile-membership.mjs`、`plugins/dsh-hang-inspector/lib/hang.mjs`(+`lib/index.js`)、`docs/performance-rollout-checklist.md`。

## 验证记录

- **连续两轮独立全量**（干净无并发环境）：第一轮 `round3-full-a.json` total=205 failed=0 tier=all（EXIT=0）；第二轮 `round3-full-b.json` total=205 failed=0 tier=all（EXIT=0）。较第二轮基线 187 新增约 8 个测试文件。
- `node scripts/check.mjs`：CHECK PASSED（禁用词/语法/tool-schema DSL/ps1 BOM）。
- `node scripts/plugin-load-smoke.mjs`：11 个插件全部装载。
- `node mcp/smoke.mjs`：SMOKE PASS 56 工具 + 19 个只读 execute（`build_compile_check` 夹具走 ok、真实工程探针走 any）。
- `toolface-params` 两面参数证到 9/9（含新增 `failure_query.cursor`、`hang_packs.limit`）；`toolface-parity` 两面工具名一致。
- **verify_report 裁决**（runId=round3-perf-rollout-20261013b）：**verdict=incomplete**（pass=4 / fail=0 / unverified=1，recorded=0）。`check` 为独立 gate（observed，exit 0）；全量两轮 / 冒烟 / F·A·B·C 组为 pass；E/D 组 Windows 原生如实 **unverified**（真机待验，未假称通过）。报告：`~/.dsh-agent-toolchain/verify-reports/round3-perf-rollout-20261013b.json`。
  - 注：verify_report **内置**的全量 gate（首次 runId 去掉 b 后缀那次）因它**并行**跑多个 gate 的负载，使重型测试（windows-boundary / launch-force 类）偶发超时报 exit 1 —— 这是原清单 T1 已文档化的"只在全量并发负载下偶发"现象，非代码缺陷；故全量以上面两轮**独立运行**的 0 失败为准。

## 真机待验清单（诚实边界）

以下为本环境无法验证、需 Windows 真机 + 真实客户端/ETL/dump 的项，**未声称通过**：
D 组全部（UIA provider 隔离 / UI tree 模式 / flow 取消 / DPI 矩阵）；E 组 ETL/JIT 解码共享缓存与 DAC/ClrMD 只读会话复用、TraceEvent 直接 ETL；A 组终端同步 snapshot 源接入；capture finalize 写入侧解压后台化；failure 持久倒排索引（超大库收益）。
