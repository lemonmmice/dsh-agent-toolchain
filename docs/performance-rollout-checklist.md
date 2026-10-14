# 性能清单持续落地状态

依据两份 2026-10-12 审计清单推进。候选方案须先验证；收益不成立时记录对照结论，不强行替换。此文件记录实施进度，不表示部署完成。

> 第三轮（2026-10-13，接手"剩余 7 组"）：标 `[x]` 的为本机已实现并单测/回归通过；带 `(真机待验)` 的是
> Windows 原生深水区（UIA / ETL / ClrMD / 真实采集流量），本环境（无真实客户端、dsh perf/ui 工具指向
> 另一进程）无法验证收益 —— 按分级交付做了纯逻辑骨架 + 单测 + 诚实边界，**绝不假称真机验证通过**。
> 详见 docs/performance-audit-round3-validation-2026-10-13.md。

> 第四轮（2026-10-14，按 e0a0cd5→19b9734 复核意见修 6 组正确性缺陷，均带回归用例）：
> - **F01** 编译集缓存失效：`collectItemSources` 改为按「已解析源 ∪ 探测点」的身份签名（dev/ino/size/mtime/ctime，
>   不存在记 `absent`），新建 `Directory.Build.props/.targets` 或原本解析不到的 import 目标出现即失效重算；缓存对象冻结后返回。
>   （原先只重查已解析源，会把"未编译"误判成"已编译"。）用例 `lib/compile-membership-invalidate.test.mjs`。
> - **F02** 解压总预算：gzip 多成员改为**整条响应共享**一个输出预算，任何成员超限返回 null（绝不返回部分正文）、
>   限成员数；代理路径 `proxy-engine` 复用同一有界解码器。用例 `plugins/dsh-api-visualizer/test/capture-decode-total-budget.test.mjs`。
> - **F03** failure 查询稳定排序：按 (ts,id) 全序的派生快照按版本构建一次并缓存，热查询不再每次复制 + 全量重排；游标改二分定位。
>   用例 `lib/failure-corpus-order.test.mjs`（叠加既有 `failure-corpus-cursor`）。
> - **F04** 任务完整性：完整性口径收敛到 `lib/result-completeness.mjs`（MCP 封套 + 纯对象都判）；输出预算上移到任务层之外，
>   落盘与裁决用未截断原始结果，预算封套保留 incomplete/stoppedBy/剩余量。用例 `lib/task-completeness.test.mjs`。
> - **F05** 采样取消收尾：`perf_trace` run 的等待响应 AbortSignal；收尾用独立有限期限信号运行，取消后仍发停止/取消命令并释放租约。
>   用例 `plugins/dsh-perf/test/trace-cancel-cleanup.test.mjs`。
> - **F06** 构建互斥：资源锁键与 builder 共用 `lib/build-root.mjs` 的根解析；builder 自带按根的文件锁，同步/后台/异步共用一把。
>   用例 `lib/build-root-mutex.test.mjs`。

> 第五轮（2026-10-14，按 474134c 复核意见收口 R1–R6 的边界遗漏/回归，均补反例）：
> - **R1**（F01 续）编译缓存：`collectItemSources` 把 import 的**所有**候选路径（含未命中的）登记为探测点，
>   不再只在 `!hit` 时登记——否则「备用候选命中后、更高优先候选出现」签名不变、缓存沿用备用结论。
> - **R2**（F05 续）采集启动取消：从租约/标记写下起整段 start 包 try/catch，抛出（主任务取消）时在独立信号下
>   逐个停已起的 kernel/CLR/JIT/alloc 会话并校验 attempt 后释放租约，不再依赖「最终 running 标记」才知道要清什么。
> - **R3**（F05 续）取消失败不谎报：`trace.run` 仅当收尾命令确实成功才声明 `cancelled`；失败/不确定落
>   `unknown+incomplete`、保留租约、给恢复入口（任务层据此裁为 unknown 而非 cancelled）。
> - **R4**（F06 续）锁位置：构建互斥锁父目录改为机器共享锁根 `~/.dsh-agent-toolchain/build-locks`（`DSH_BUILD_LOCK_DIR` 仅测试隔离），
>   与 `logsDir` 脱钩——否则不同 `DSH_BUILD_LOGS_DIR` 的宿主会拿到不同锁、同仓库并发构建。
> - **R5**（F02 续）gzip 解码：首选 `gunzipSync` 一次解整条流（真解码器，不被 payload 内 `1F 8B 08` 误判边界），
>   仅在其抛错时才回退到成员切分；代理路径随之受益。修「合法多成员被当边界、代理丢正文」。
> - **R6**（F06 续）根优先级：`resolveBuildRoot(opts, cfg)` 新增 cfg 形参，顺序 opts > cfg > env，
>   恢复「显式 `makeBuilder({repoRoot})` 优先于全局环境变量」的原语义。
>   用例：`trace-cancel-cleanup`（S2/S3）、`build-root-mutex`（R4/R6）、`compile-membership-invalidate`（R1）、`capture-decode-total-budget`（R5）。

## A 轻请求与观测

- [x] build_errors worker、流式解析、身份缓存和并发 MCP 验证。
- [x] failure 只读 worker、队列上限、超时、不完整语义。
- [x] hang 日志限额、异步身份/启停、并发与 PID 复用验证。
- [x] 诊断 worker 复用、过期快照后台刷新、fast/deep 分离缓存。
- [x] memory 状态聚合、向量计数元数据、读取与检索 worker。
- [x] capture 工具查询 worker、排序复用、同快照元数据；主表追加不再重建所有引用。
- [x] capture 后台解压背压：gzip/deflate/br 解压加 `maxOutputLength` 上限（解压炸弹防护，解压过程中拦截，不先解出巨量再检查），
      查询主路径已 worker 化 + runId 索引 + stable cursor。(finalize 写入侧解压的后台化收益需真实高频捕获流量真机验证)
- [x] 终端共享快照新鲜度骨架 `snapshot-freshness`（fresh/stale/unknown + ageMs + 「显示缓存≠动作授权」硬边界）+ 单测。
      (真机待验：终端 inspector 的同步 snapshot 源接入共享刷新 worker；破坏性动作前实时重验身份)
- [x] 配置前缀快照由诊断 worker 后台刷新（已覆盖）；非关键 trace 写入默认关（DSH_TOOL_TRACE），收益边际。

## B 索引与数据布局

- [x] 源码哈希有界并发，保持旧算法；并发修改、删除、链接等回归。
- [x] failure 分片复用、追加解析和前缀验证。
- [x] KV 提交后缓存所有权修复。
- [x] 持久源码 manifest 与验证内共享（build-evidence 接 `sha256-git-file-hashes-v2`，明确新算法标识 + 持久 cacheDir + forceFull 全量回退）。
- [x] KV SQLite 点写/点删、迁移恢复、旧写入者拒绝和四进程竞争；JSONL 写入也通过独立进程排队。真实库未切换，需所有旧读写者先停用。
- [x] failure stable cursor（keyset `(ts,id)` 全序，翻页不重不漏、顶部新增稳定；两面参数证到，修复 queryAsync 漏传 cursor）。
      (超大库待验：按分类/runId/指纹的持久倒排索引 —— 现有 shardCache/parsedShards 增量解析 + statsCache 已覆盖常见规模)
- [x] capture 方法/来源/安全条件下的 runId 索引、stable cursor、按页/正文投影；MCP 与面板读取进入 worker。
- [x] 项目 XML/依赖身份缓存（`collectItemSources` 按「已解析源 ∪ 探测点」的身份签名缓存——dev/ino/size/mtime/ctime + 不存在态，
      hook 热路径重复读合并；`.csproj` 改写、或新建 props/targets/import 目标**都**失效重算；结果冻结。F01）。
      (后续：memory 查询向量单飞行 / 紧凑存储对照 —— embedding 已有 endpoint+model+text 缓存 + index-process 已存在)

## C 长任务

- [x] dump 采集/分析可拆分；真实 ProcDump 编码/完成判定和已有 dump 分析验证。
- [x] ui_live 立即受理与首帧状态、代际隔离。
- [x] 共用任务接受/状态/取消、资源并发、去重、崩溃恢复与 unknown（task-service + toolchain_job + mcp/task-jobs 测试）。
- [x] probe/trace 采集与分析阶段分离（dump `analyze=false` 拆分）；取消信号传到子进程（process-cancellation 接入 runPerfExecutable / runPs1）。
- [x] hang 包 `limit`（只列最新 N 个 + 轻量优先排序，只对选中页取完整元数据）。
      (后续：hang_pack fields/maxBytes 选择性读取、hang_delete 异步分批 —— 已有 512KB 文本截断兜底)

## D UI（Windows 原生，真机待验）

- [x] ui_launch 旧 MCP 连接根因确认；真实冷/热启动测试与运行进程身份回报。
- [x] 全树 CacheRequest 和类型过滤已真机对照，未证实稳定收益，未替换。
- [ ] 独立管理/观察通道，UIA provider 卡死可独立恢复。(真机：需真实 UIA provider + 客户端)
- [ ] UI tree 显式 UIA/注入模式、节点/时间预算。(真机)
- [ ] 逐动作等待/条件确认与 flow 取消，保留未知动作不重放。(真机 + 真实 UI 树)
- [ ] 最小化、DPI、多实例与 provider 无响应矩阵。(真机矩阵)

## E 分析服务（Windows 原生，真机待验）

- [x] dump 指纹缓存（hang_analyze `sameDump` + 缓存优先/refresh）、perf attempt 独立输出（防串结果）。
      (真机：DAC/ClrMD 只读会话复用、派生索引复用、内存回收)
- [x] 符号缓存（DSH_PERF_SYMBOL_CACHE）、ETL→XML reuse（trace `reuse=true` + manifest）；分析缓存键骨架
      `analysis-cache-key`（审计 L07：按输入指纹而非路径，含工具版本/PID/provider/符号策略/参数）+ 单测。
      (真机：ETL/JIT 解码结果跨调用共享缓存与阶段耗时度量)
- [ ] 现有 C# TraceEvent 直接 ETL 对照与在线聚合、完整性统计。(真机 + 真实 ETL)
- [ ] 同 ETL/dump 的语义/权重/缺失信息对照与资源测量。(真机)

## F 交互成本与收尾

- [x] 工具 profile（`DSH_TOOL_PROFILE` 按域 ui/build/perf/hang/memory/capture/failure + core 精简 tools/list；默认全开，smoke 的 DECLARED 比对不受影响）、精简发现。
      (首用/冷加载 token 收益度量待真机 MCP 客户端)
- [x] 默认输出预算与关键机器字段（`makeOutputBudget` 统一 chokepoint，默认关零回归，保留机器字段）；大证据分页/artifact 由 verify_report bundle 覆盖。
- [x] Jev 响应体上限（2MiB 有界读）、无副作用请求单飞行（相同输入去重）、整段取消/期限（外部 signal 贯穿）。
- [x] 全量回归、当前代码 MCP/DSH 冒烟、verify_report 收口（见 docs/performance-audit-round3-validation-2026-10-13.md）。

已有第二轮全量基线：187 个测试文件通过。第三轮在其上新增单测（jev 有界读/单飞行/取消、tool-profiles、tool-profile 集成、capture 解压背压、failure stable cursor、compile-membership XML 缓存、hang_packs limit、analysis-cache-key、snapshot-freshness），全量回归继续通过。附着的旧 MCP 连接不会自动更新；当前代码真机验证使用新 stdio MCP 进程。
