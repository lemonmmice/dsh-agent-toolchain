# dsh-perf

DSH（DeepSeek Harness）的**性能剖析插件**：与 dsh-hang-inspector（卡死）互补，覆盖 UI「卡顿」（500ms~数秒阻塞）与内存泄漏初筛，形成「卡死→卡顿→内存」完整性能诊断体系。

## 工具

| 工具 | 说明 |
| --- | --- |
| \`perf_probe\` | 卡顿监测：循环 SendMessageTimeout 实测窗口响应耗时，P50/P95/P99 + 卡顿事件列表；\`capture=shot\` 卡顿瞬间截图，\`capture=dump\` 首次卡顿抓全 dump |
| \`perf_report\` | 最近一次监测报告 |
| \`perf_dump\` | procdump 抓全 dump（挂起进程几秒）+ DumpStack 自动分析（UI 线程栈 + 锁热点线程） |
| \`perf_analyze\` | 对已有 dump 重分析 |
| \`perf_heap\` | 托管堆类型 Top N 统计（两次 dump 对比 = 泄漏初筛） |

## 原理

**卡顿测量**：\`SendMessageTimeout(hWnd, WM_NULL, timeout=8s)\` 是同步等待消息处理完——
窗口空闲时毫秒级返回，UI 线程忙则挂起到处理完，实测耗时 ≈ 当前 UI 线程忙碌程度。

**dump 分析**：procdump -ma 抓全 dump → DumpStack（ClrMD 4.0，本仓库 tools/dumpstack 已扩展）：
- 每线程托管栈 + \`uiLikely\` 标记（Dispatcher.PushFrame / Application.Run 特征）
- \`heapstats\` 子命令：托管堆按类型统计 Top N（对象数/总大小）
- 自动匹配本机 DAC（\`tools/dac\`）

## 环境变量

| 项目 | 说明 |
| --- | --- |
| \`DSH_UI_PROC_NAME\` / \`DSH_UI_WINDOW_NAME\` | 目标客户端进程名/主窗口标题 |
| \`DSH_PERF_EVIDENCE_DIR\` | 证据目录，默认 \`~/.dsh-agent-toolchain/perf-evidence\` |
| \`DSH_PERF_SRC_ROOT\` | 项目源码根（堆栈映射源码用） |
| \`DSH_PERF_PROCDUMP\` | procdump.exe 路径（默认 \`~/.dsh-agent-toolchain/tools/procdump.exe\`） |
| \`DSH_PERF_DUMPSTACK\` | DumpStack.exe 路径（默认 \`~/.dsh-agent-toolchain/tools/dumpstack/publish-x86/DumpStack.exe\`） |
| \`DSH_PERF_DAC_DIR\` | DAC 目录（默认 \`~/.dsh-agent-toolchain/tools/dac\`） |

## 安装

\`~/.dsh/profiles/web/cordis.patch.yml\` 追加：

\`\`\`yaml
- insert:
    - id: perf
      name: './plugins/dsh-perf/index.js'
\`\`\`

重启 DSH 生效。
