---
name: dsh-hang-triage
description: 桌面客户端卡死 / 无响应的取证：正在卡就先 perf_dump 保留现场（不要先重启）；偶发卡死用 hang_run 监测并自动收证据包；再用 hang_packs / hang_pack / hang_analyze 看线程栈并映射到源码。Use when the desktop client freezes, stops responding, or a hang dump needs analysis. Triggers：卡死、无响应、假死、界面不动了、hang、分析 dump。
---

# 卡死取证

## 现在就卡着

1. **不要** `ui_launch(force=true)`，也不要重启——那会毁掉唯一的现场。
2. `perf_dump(note=…)` 立刻抓 dump；它会顺带分析 UI 线程托管栈和持锁线程。
3. 原生帧不全时，看 `toolchain_status` 里的 dump 工具与符号配置。

## 偶发卡死

1. `hang_run(maxSeconds)`：只监测、从不点击。让用户复现；检测到卡死会自动收证据包（冻结截图、时间线、进程信息、网络 trace 尾部、dump）。
2. `hang_status` 看监测状态；结束用 `hang_stop`（已收的包保留）。

## 分析证据包

1. `hang_packs`：列出证据包（新的在前）。注意时间——几小时前的包解释不了刚发生的卡死。
2. `hang_pack(id)`：读全部文本证据；冻结截图在包目录的 `frozen-screen.png`。
3. `hang_analyze(id, wait=true)`：托管线程栈、嫌疑线程 / UI 线程、源码方法声明位置（需要 `DSH_HANG_SRC_ROOT`）。
4. 结论边界：源码行号是**方法声明**位置，不是阻塞语句；单个 dump 未必能确定等待对象或根因——写成"嫌疑"，不要写成"根因已证明"。

## 清理

- `hang_delete` 删除证据包不可恢复，需要 `confirm=true`；先确认用户不再需要。
