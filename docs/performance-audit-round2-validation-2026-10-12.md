# 第二轮性能清单验证与优化

输入：`dsh-agent-toolchain-e0a0cd5-performance-audit-2026-10-12.md`。
工作基线：`7ae1ec4`；清单基线：`e0a0cd5`。Windows、Node v24.15.0。
本轮包括隔离夹具、stdio MCP 和已登录 PC 客户端的真实验证。没有修改 PC 客户端业务代码，没有交易、保存业务数据、提交或推送。

## ui_launch 实际等待原因

用户观察到客户端已出现并完成登录，工具仍等待。附着连接的 MCP 进程在当天 10:17 启动，`build_status` 返回 `codeStale=true`；其工具 schema 缺少 `includeScreenshot`、`describe`。旧调用在窗口就绪后继续截图和远程视觉描述，启动阶段 `waitedMs=3517`，整个工具调用超过 30 秒。

当前工作树的两个入口默认均不截图、不调用视觉模型。新启动 stdio MCP 对真实客户端冷启动约 3554 ms，后续已运行实例最近三次为 471.90 / 471.56 / 457.04 ms，均 `started=false`、`alreadyRunning=true`、`readiness=window-ready`，没有 `uiState`。这证明新实现的窗口 readiness 路径正常，不能据此声称旧连接已更新。

补充了启动返回的 `runtime.pid`、`runtime.processStartedAt` 与代码新鲜度字段；纠正共享诊断中“MCP 必然是新代码”的错误说明。MCP 连接也可以长时间存在，磁盘更新后需要重新连接。当前聊天附着连接尚未重启；后续真实验证通过新 stdio 连接执行。

## 已实施的优化

| 路径 | 改动 | 边界 |
| --- | --- | --- |
| 源码证据 | 小文件有界并发，大文件流式；保持原排序和 SHA-256 字节输入；扫描后复核身份与 Git 清单；取消、期限、工作量字段 | 仍全量读取，没有持久 manifest/USN；前后检查不能证明期间从未短暂变动 |
| build_errors | 复用 worker 流式解析；四路径身份缓存；MCP/DSH/HTTP 异步接线；不完整和排队耗时可见 | 首次解析仍有成本，没有构建期旁路诊断索引 |
| failure_query/stats | worker 隔离；32 等待请求上限和 60 秒含排队期限；分片复用；变动分片验证前缀后增量解析新增行 | 变动分片仍全文读字节，派生排序/统计仍扫描；同步内部 API 保留 |
| KV | 原子提交后保留独立快照和 Map，避免写后立即再解析；调用者不能修改缓存 | 保存仍全量序列化/备份，仍同步 |
| hang_status/run/stop | 日志尾读上限 256 KiB；异步查询身份和停止进程；启停互斥；迟到结果不能覆盖新监测 | 单次身份查询仍约秒级；未知身份和 PID 复用仍拒绝停止 |
| ui_live | start 立即受理，后台采集首帧；明确 starting/firstFrameReady；停止/重启代际隔离 | 首帧仍受 UIA 与截图耗时影响；没有宣称观测本身为毫秒级 |
| perf_dump | analyze=false 拆开采集与分析；异步查询进程，拒绝多实例；UUID 采集目录；完整性字段 | 默认仍等待采集及分析；尚无通用任务管理 API |
| 原生命令输出 | 共享解码支持 BOM 或明显 NUL 分布的 UTF-16，stdout/stderr 一并处理 | 无 BOM 编码识别是启发式，UTF-8/GBK 路径保留 |

只读 worker 不自动重放退出/超时的任务，旧 worker 退出前不创建替代者。工具总数保持 55。

## 真实客户端验证

客户端主窗口包含约 1787–1868 个 UIA 后代，已完成登录并显示行情面板。截图已用图像工具查看，内容可读。

- `ui_live.start` 首次 3.33 ms 受理，约 3295 ms 首帧；并行回归负载下复测 5.27 ms 受理、6163 ms 首帧，截图部分 345 ms。stop 正常。
- 敏感焦点保护第一次拒绝了带 `code` 的焦点；未绕过保护。在已观察到的“主力资金”控件上执行 Focus 后采集成功。
- UIA 全树 CacheRequest 原型并未稳定加速：max=40 原实现约 2.4–3.5 秒，缓存原型约 3.2–3.7 秒；可见交互控件过滤把枚举量降至约 495，也没有稳定时间收益，且动态虚拟化页面的输出存在差异。未替换生产 UIA 路径。
- 真正调用 ProcDump 得到 714326220 字节 dump，输出明确完成，但退出码为 1；旧的“所有非零退出码都失败”判断误报失败。修复后仅对退出码 1、完整输出标记和有效 minidump 头同时成立的情况接受完成，仍保留退出码；超时、其他失败码、坏头均拒绝。
- 已复用上述 dump 单独执行 `perf_analyze`，1069.97 ms 返回 70 个线程和 UI 消息泵线程。没有为了分析再次冻结客户端。修复后的 ProcDump 判定另有成功/部分文件/超时回归；未对真实客户端重复抓取验证这一分支。
- `hang` 真实监测启动 68.72 ms，状态查询 1627.56 ms，停止并核对退出 3137.28 ms。日志有 `HANG_MONITOR_READY`、正确 PID/窗口。使用隔离目录、NoDump、不存在的网络日志和探针路径，测试后监测已停止，客户端继续运行。

## 基准

同机、相同规模夹具。最新基准单独运行，没有与全量回归同时执行；未清 OS 文件缓存，样本数小，不能作为生产 SLO。

| 场景 | 修改前 | 最新修改后 |
| --- | --- | --- |
| 10000 个 544 字节源码文件 | 中位数 2764.99 ms | 中位数 932.31 ms，摘要相同；早一轮 728.15 ms |
| 64 MiB 构建日志 | 5 ms 心跳约 296 ms 才执行 | 冷解析 347.24 ms，心跳 8.31 ms；缓存读 1.47 / 1.80 ms |
| 50000 条 failure 写后统计 | 同步约 248 ms 并阻塞心跳 | worker 热读中位数 104.12 ms，心跳 12.87–19.80 ms；冷 worker 408.81 ms |
| 50000 条 KV save+recall | 中位数 62.76 ms | 中位数 49.45 ms；早一轮 34.66 ms，仍阻塞主线程 |

真实 stdio MCP 中大日志与 failure 重任务同时执行时，轻量 `build_status` 在 1/4/8 并发下 p95 为 1.79 / 4.60 / 6.13 ms，分别 24/96/192 个样本，全部在重任务结束前完成。此项验证请求争用，不代表 UIA 延迟。

## 验证记录与复现

本地忽略目录 `.dsh-agent-toolchain/` 保存以下原始证据：

- `audit-round2-before.json`、`audit-round2-after-final.json`、`audit-round2-mcp.json`：基准与争用结果。
- `audit-live-launch.json`、`audit-live-ui.json`、`audit-live-monitor.json`、`audit-live-dump.json`：真实工具结果。
- `audit-uia-cache.json`、`audit-uia-filter-cache.json`：UIA 候选方案对照。
- `audit-round2-tests-final3.json`：187 文件，186 通过；唯一失败是异步包装器的静态返回字段检查遗漏内部实现。已保留包装转发断言并合并内部实现字段，定向复跑通过。

可复现命令：

```powershell
node scripts/bench-audit-round2.mjs .dsh-agent-toolchain/audit-round2-after-final.json
node mcp/performance-contention.test.mjs .dsh-agent-toolchain/audit-round2-mcp.json
node scripts/run-tests.mjs --all --json
node scripts/check.mjs
node scripts/plugin-load-smoke.mjs
node mcp/smoke.mjs
```

新增/扩展回归覆盖：源码身份与并发变动；日志流式解析、换行、轮转与缓存隔离；failure 增量解析、损坏和撤回；worker 排队/超时/退出；KV 缓存所有权；hang 字节预算、身份未知/复用、并发启停和迟到回调；live 首帧延迟与代际隔离；launch 默认不观察以及已运行实例；ProcDump 输出编码和完成判定。

## 清单中尚未落地的架构建议

真实客户端条件已用于启动、UIA、截图、dump 和监测验收。以下仍是未实施的独立架构工作，不能用本轮局部收益替代验收：

| 项目 | 当前结论 |
| --- | --- |
| 持久源码 manifest、KV 点写、failure/capture 查询索引 | 未迁移持久格式；本轮保持原证据与并发语义 |
| capture 全量扫描、向量冷读与终端同步快照 | 仍有同步路径；终端上游接口要求同步 snapshot，不能仅改成 Promise |
| 通用 job/status/cancel、资源锁、崩溃恢复 | 未建立；读 worker 和 ui_live 后台采集不能冒充通用任务服务 |
| UIA 批量缓存、独立观测队列、provider 隔离 | 缓存原型已真机测试，未证实收益；队列拆分尚未实施 |
| 直接 ETL、共享 DAC/ClrMD/JIT 缓存、向量存储 | 尚未实施；没有用单次 dump 分析推断缓存收益 |
| tools/list profile、统一默认输出预算 | 尚未更改接口契约 |

当前工作树结果需要新 MCP 进程加载；已经连接的旧进程和 DSH 宿主没有自动更新。
