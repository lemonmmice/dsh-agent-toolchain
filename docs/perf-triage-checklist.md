# 性能排查清单：卡顿与输入拖滞

> 2026-11-20 新增。来源：2026-11-19 分析客户端「登录后鼠标拖不动」的 ETL 时，只盯目标进程、
> 没做全进程排名，漏掉了 `DesktopAssistant`；关掉它后症状消失（2026-11-20 用户确认）。
> 这份清单是那次漏判的复盘，不是新工具说明。

## 0. 适用

- 症状：界面一顿一顿、鼠标/输入发涩、拖拽不跟手、登录/切页后卡。
- 输入：PerfView / WPR 的 `.etl`，或准备现场抓。
- 先跑 `toolchain_status` 确认符号、管理员、dump 三件套与证据目录。

## 1. 先全进程排名，再钻目标进程（30 秒）

- 有栈样本按**进程**聚合，再看**单线程**排名；内核侧单独看 `fltmgr.sys` / `ntfs.sys` /
  `win32k*` 与输入相关驱动的占比。
- 判据：目标进程之外是否还有人占 5% 以上；有没有第三方进程**持续**跑在内核路径里。
- 反例：2026-11-19 只对目标客户端做线程/模块归因，漏掉 `DesktopAssistant`
  （4,001 samples / 6.45%，进程第 3；单线程 TID 15352 = 3,445 ms，全 trace 第 2 热）。

## 2. 输入类症状：先列全局钩子嫌疑，做 A/B

- 候选：输入法、桌面助手/管家（联想 DesktopAssistant、搜狗桌面助手等）、远程协助、
  录屏/自动化测试、安全软件。
- 做法：托盘退出或结束进程 → **同机、同版本、同场景**复测 → 对比。
- 判据：关掉后症状消失即可锁定嫌疑；但「消失」不等于「知道机制」，还需补 hook/win32k 证据。
- 特征提示：桌面助手常见「窗口命中测试」（`IsCompositionInputWindowForHitTest`、
  `xxxDCEWindowHitTestIndirect`、`RealGetProp`）与高频文件扫描，可能是全局钩子，也可能是
  win32k/USER 锁争用。

## 3. CPU 采样回答不了「延迟」，必须补 Thread Time / hook 事件

- `WH_MOUSE_LL` 钩子每次回调只跑几十微秒，1 ms 采样基本抓不到；但每一帧鼠标移动都要过它。
- CPU 采样只能回答「谁在烧 CPU」，回答不了「谁在加延迟」；阻塞/等待要看 CSwitch 的
  Ready/Blocked，或 hook / WinEvent / UIA provider 事件。
- 可用入口：PerfView `/threadTime`；DSH `perf_uifreeze`（start → 复现 → stop）；
  `perf_trace` + `perf_hotstacks`（CPU 侧）。
- 判据：不能因为「目标进程 UI 线程忙」就结案；也不能因为「采样里看不到」就说没问题。

## 4. 本案数据（可复核）

| 项 | 值 |
| --- | --- |
| DesktopAssistant | PID 7048，`C:\ProgramData\Lenovo\devicecenter\extends\modules\desktopmainframe\DesktopAssistant.exe --from=tray`，Chromium 内核 |
| CPU | 4,001 samples = 6.45%（进程第 3）；单线程 TID 15352 = 3,445 ms（全 trace 第 2 热） |
| 栈特征 | `IsCompositionInputWindowForHitTest` / `xxxDCEWindowHitTestIndirect` / `RealGetProp` + fltmgr/ntfs 持续扫描；77% 在 `KiExpandKernelStackAndCalloutSwitchStack`（高频内核调用） |
| 客户端侧 | UI 线程 11,881 ms / 22.8 s；14–19 s 有 65% 在 `xxxFlushDeferredWindowEvents`（当时误读为「客户端自己刷窗口」，更像被外部高频 win32k/命中测试争用拖慢） |
| 结论 | 关掉 DesktopAssistant 后症状消失（用户确认）；**具体机制（钩子延迟 vs win32k 争用）未取证** |

证据：本机 perf 证据目录 `pvd-20261119`（未入库；含 `stack-desktopassistant.htm`、
`stack-r1..r4.htm`、`uithread-sym.log`、`EtlProbe` 探针源码）。

## 5. 诚实边界

- 该 ETL 无 CSwitch/ThreadTime、无 hook/WinEvent/UIA 事件 ⇒ **延迟类根因结构性不可见**。
- 客户端自己的 PDB 与测试包签名不匹配 ⇒ 只能解析到 WPF/CLR/内核函数，点不到业务方法。
- 只覆盖客户端启动后约 23 秒；更长时间的卡顿需要另抓。
