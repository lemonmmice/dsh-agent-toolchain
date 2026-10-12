# Harness 清单验证与优化记录

日期：2026-10-12（新加坡时间）。工作基线：`4c15eff8499cef6f214fccb3b425634ad55db2e0`。
输入清单的基线为 `31b571ea973ad7f796f31cab8cf3bf379ab5796c`；本轮先比对新版本，再用隔离用例复现，随后修改。
环境：Windows、Node v24.15.0。所有破坏性分支使用临时目录、测试子进程或注入执行器；没有对真实客户端点击、授权、复位、抓 dump、开 ETW、构建或删除真实证据。

本轮落实已证实的正确性问题和可局部验证的响应优化。清单中统一任务服务、独立运维身份、真实编译输入等设计仍未完成，不能把本记录理解成整份路线图全部验收。

## 实测结果

| 项目 | 修复前证据 | 修复后证据 |
| --- | --- | --- |
| UI 锁冲突 | 配置等待 30ms，实际 1001.85ms；10ms 心跳 1001.93ms 才执行 | 立即返回 `UI_LOCK_BUSY`；约 1.5–1.7ms，心跳约 21–25ms；不删除其他持有者的锁 |
| gate 阻塞 | 350ms 受控命令使 20ms 心跳延迟约 488ms | 异步执行、超时/取消；真实 stdio MCP 的长 gate 期间状态查询约 8–12ms |
| 环境诊断阻塞 | 心跳延迟 348ms；连续诊断约 301ms | worker 隔离；专项心跳约 11–19ms；带年龄的本地缓存读取低于 1ms |
| 验证误判 | manual、2000 年构建记录、注释 Compile、父条件和 SDK 文本文件、ID 等初始 10 项复现失败 | 15 项验证/构建审计用例通过；手工/导入/静态提示不能替独立证据通过 |
| 失败 dump 分析 | 注入退出码 1，仍返回旧 `OLD`、线程 42 和 `ok=true` | 非零退出拒绝；UUID 独立产物，校验 JSON 结构，不取旧文件 |
| KV 并发 | 4 进程共 200 条，基线剩 54 条 | 完整读改写事务；200 次 save 加 100 次 forget 后记录完整；争用未写且可重试 |
| 清理越界 | 真 Windows junction 把隔离根外 `.dmp` 列为候选 | 子级链接拒绝；配置根 junction 可用；`planId` 绑定清单，变更/活动/未知状态不删 |
| WPR 预检 | start 失败仍执行 cancel | start 失败不 cancel；唯一附属会话、租约及 stop 阶段记录；不停止无归属会话 |
| memory 分块/失效 | 短段后 20000 字长段突破 800 上限；仅 mtime 跳过 | 分块上界、内容/模型/维度/chunker 指纹失效；远程 embedding 剩余 deadline |
| failure 并发/读取 | 不可读分片静默遗漏，追加/轮转无整段互斥 | 160 record + 80 retract、100 次去重为 1+99；坏行/不可读/读中变化均 incomplete |
| 输出预算 | 超限 JSON 丢 state/ID；structuredContent 绕过 | 文本及结构化结果保留关键机器字段；structured-only 也受限；重复大 JSON 缩为引用 |

最终 MCP 并发基准：受控 gate 等待 1500ms，150ms 后按 1/4/8 并发执行 16 批 `build_status(runId=missing-fixture)`。
使用独立空测试存储，耗时包括本机 stdio 往返；测试运行时机器还有回归负载，不是所有真实业务工具的服务等级保证。

| 并发 | 样本数 | p50 ms | p95 ms | p99 ms |
| --- | ---: | ---: | ---: | ---: |
| 1 | 16 | 1.26 | 1.83 | 1.83 |
| 4 | 64 | 4.53 | 6.66 | 8.04 |
| 8 | 128 | 9.93 | 16.83 | 17.15 |

诊断冷调用在该次样本中为 136.54ms，后四次缓存调用 0.95–1.43ms。冷诊断仍需执行实际检查，不能承诺 100ms 内完成。
工具目录仍为 55 个；新增参数与证据说明会改变目录大小，未实施动态 profile 加载。

## 清单逐项结论

| 项目 | 状态 | 本轮落实及剩余边界 |
| --- | --- | --- |
| L01 事件循环阻塞 | 部分完成 | UI fail-fast；gate/git/bundle Git 异步；toolchain worker；dump DAC 异步；hang、其他 perf、冷文件解析和 terminal helper 仍有同步路径 |
| L02 常驻 UI 热路径 | 新基线已有，回归保留 | 新版已接 warm status、动态目标和身份；既有 warm-status/warm-queue 等回归执行。凭据配置快照和更多队列拆分未改 |
| L03 状态轻量化 | 部分完成 | build 按 run/job 直达，后台最新指针；freshness 一秒缓存并对部署戳变化失效；toolchain 两秒完成缓存带 observedAt/completedAt/ageMs。增量错误索引、有界 hang tail 未做 |
| L04 附带昂贵工作 | 部分完成 | ui_launch 默认只返回 readiness，截图/describe 显式开启；capture_query 不必等待宿主，fresh=true 才等待刷新。perf_dump 自动分析和 ui_live 首帧等待仍保留 |
| L05 统一长任务模型 | 未实施 | 修复已有后台 build 的 starting/running/crashed、job/attempt 身份；未增加通用 job_status/result/cancel、队列、崩溃恢复与所有业务取消 |
| L06 大数据查询 | 部分完成 | KV Map+文件身份缓存，failure 分片/聚合缓存与读取版本复核，memory 清扫去重；冷载全量、持久索引、稳定 cursor、capture 下推、目录续传未做 |
| L07 分析复用 | 部分完成 | 分析输出隔离；CLR reuse 校验 ETL/解码器/产物指纹，流式事件解析、PID 过滤、实际体积与内存限额。统一 DAC/JIT/ETL 缓存和分阶段符号未做 |
| L08 上下文与返回值 | 部分完成 | MCP integer/范围校验；截断保留机器字段、结构化预算；修正部分过时描述。文本和 structuredContent 分别预算，非整个返回总 cap；未引入 profiles/工件分页 |
| C01 独立运维授权 | 仅入口防护 | HTTP 工具阻断审批/撤销/急停复位写端点及重定向。宿主回环路由本身未建立独立身份；同账号 shell/文件仍可越过，独立 broker/Windows 身份待部署设计 |
| C02 证据等级 | 部分完成 | verifiedVerdict/acceptance 分开；capture 导入强制 imported，内部采集 observed；缺匹配不编造 fail；构建核对源码/日志摘要。未实施受控必需 claims 与完整签名证据链 |
| C03 编译成员 | 误判路径修复，真实求值待做 | 注释/父条件/语言扩展名修复，结果 evaluation=heuristic，compiled claim 降为 unverified。未接 MSBuild -getItem/导出 target/binlog |
| C04 运行身份 | 部分完成 | UUID run/attempt/job、统一规范化、原子记录、按 ID 查询；后台启动失败可见。仍保留用户 run 标签 alias，未统一全工具 host 身份、同仓输出资源锁 |
| C05 旧分析污染 | 已修复并验证 | 失败不读旧文件、独立 attempt 输出及结构验证；缺少完整 analyzer/DAC/source 通用缓存指纹 |
| C06 KV 丢记录 | 已修复并验证 | 跨进程事务覆盖完整读改写；快失败 busy、明确未写；真实并发和持锁进程退出恢复通过 |
| C07 清理路径 | 已加固并验证 | Windows junction、realpath、清单 ID、删前身份/会话检查。Node 路径检查仍不是 Windows 句柄级原子删除 |
| C08 ETW 归属 | 已加固，真实采集待验 | 唯一附属会话、用户级独占租约、stop 串行/阶段落盘；异常保留锁需核实。外部采集器不遵守文件租约，未做真实并存 ETW 验收 |
| C09 memory | 主要缺陷修复 | chunk 上界、索引身份、deadline、root/截断 metadata；local-fast/semantic 显式模式与查询维度跨历史库迁移仍待设计 |
| C10 失败与观测 | 部分完成 | 分片 incomplete、事务、ts 消歧、trace 真实 run/errorCode、全尝试成本定义。自动失败分类和完整阶段遥测未统一 |

## 契约变化

- `ui_launch`：默认不截图、不调用视觉服务；`includeScreenshot=true` 截图，`describe=true` 截图并描述。
- `build_status` / `build_errors`：接受 `runId` / `jobId`；`verify_report` build claim 支持 `attemptId`。
- `verify_report`：manual-only 不再独立 pass；旧构建凭证、导入 API 和静态 compiled 提示可能变为 incomplete。
- `perf_clean`：先 dry-run，删除必须附同一 `planId`。`perf_clrevents`：`reuse=true` 且 manifest 匹配才复用 XML。
- `memory_forget`：返回实际 `deleted`，未找到时 `forgotten=false`。事务冲突返回可重试 busy，`writesApplied=false`。
- `capture_query`：宿主状态缓存标注年龄和刷新状态；控制成功后失效，旧请求不得覆盖新一代状态。
- UI 互斥锁不再忙等或按年龄抢占；异常终止的遗留锁须确认持有者结束后清理。
- DSH schema 不支持的 minimum/maximum/数组 required 改用合法 DSL；动作执行层和 MCP 的范围检查继续保留。

## 验证与复跑

命令：`node scripts/run-tests.mjs --json`、`node scripts/check.mjs`、`node mcp/smoke.mjs`、`node scripts/bench-mcp.mjs --output <local-json>`。
定向审计覆盖：verify 15 项、perf 安全 9 项、CLR reuse、KV/failure 并发、failure 读中变化、MCP gate 并发/来源/锁忙、两端 launch 可选视觉、缓存失效、输出预算、后台启动错误。

MCP 冒烟：55 个工具与声明集合匹配；实际执行 17 个只读入口，13 个返回结论，4 个诚实返回缺配置/无证据（不算完整成功）；真实 UI 与真实编译输入没有由这次冒烟证明。
仓库 check 已通过语法、敏感引用、DSL 和 PowerShell 编码检查。

全套最新结果在本地 `.dsh-agent-toolchain/audit-test-final.json`，MCP 基准在 `.dsh-agent-toolchain/audit-benchmark-final.json`。
最终全套：177 个测试文件，176 个退出码为 0，1 个非零，耗时 283981ms。部分退出 0 的测试有环境 skip，不能写成 176 项 Windows 集成全部通过。
全套启动后补充的 `lib/code-freshness-cache.test.mjs` 另行通过，验证缓存年龄、部署戳立即失效与非法时钟拒绝。
`render-trace.test.mjs` 的两个 `ui_flow` 断言已在隔离导出的 HEAD 重现，是嵌套 action 被当作顶层的已有测试问题，未修改该扫描器。

未提交、未推送、未部署或重启宿主。当前长活 MCP/DSH 进程不会自动加载磁盘修改；本轮执行验证启动的是仓库新进程。
隔离 HEAD 副本的递归清理由自动执行策略拒绝（blocked by policy），临时副本保留，没有绕过拒绝；这不影响源码或测试结果。
