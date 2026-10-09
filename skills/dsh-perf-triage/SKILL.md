---
name: dsh-perf-triage
description: 桌面客户端卡顿 / CPU 高 / 内存上涨的取证流程：perf_probe 量 UI 线程延迟 → perf_trace 采样 → perf_hotstacks / perf_flame 拿调用链 → perf_uifreeze 看冻结；内存用 perf_dump + perf_heap + perf_gcroot。Use when the UI stutters, CPU is high, memory grows, or a call chain is needed instead of a guess. Triggers：卡顿、掉帧、CPU 高、内存泄漏、性能分析、火焰图、为什么慢。
---

# 性能取证

先 `toolchain_status`：ETW 采样需要管理员权限；源码根决定能不能拿到 file:line；符号路径决定栈能不能解析。

## 卡顿 / CPU

1. `perf_probe(seconds, thresholdMs)`：只回答"卡不卡、多卡"（P50 / P95 / P99 和超阈值事件），**不给调用链**。
2. 要调用链：`perf_trace(action=start)` → 复现 → `perf_trace(action=stop)`（或 `action=run` 定时采样）。
3. `perf_hotstacks(etlPath, focus=可疑层的正则)`：最热函数 + 蝴蝶图（谁调它 / 它调谁）。第一行的未解析符号比例高时，先修符号再下结论。
4. `perf_flame` 出火焰图；`perf_allocflame` 看谁在制造 GC 压力；`perf_clrevents` 看 GC 次数与暂停；`perf_uifreeze` 看 UI 冻结的次数、时长和卡住的托管调用链。
5. 不带 PID 的 CLR 统计是全机汇总，结论要按目标进程过滤。

## 内存

1. `perf_dump`：抓一个完整 dump（会让客户端停顿几秒，先告诉用户）。单个 dump 只说明当前占用，**不能证明泄漏**。
2. `perf_heap` 看类型 Top；可疑类型用 `perf_gcroot(type=…)` 看"谁让它活着"。
3. 要证明泄漏：同一操作前后各取一次，对比增长。

## 收尾

- 证据文件很大（dump 几百 MB、ETL 可上 GB）：`perf_clean` 先干跑列出，确认后 `confirm=true` 删除。
- 报告里写清每个数字的口径（哪个进程、哪段时间、哪类事件），以及这种方法看不见什么。
