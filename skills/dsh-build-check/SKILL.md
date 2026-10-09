---
name: dsh-build-check
description: 用 dsh 构建与编译集检查验证 .NET / WPF 改动：build_run（带 runId、可后台）→ build_errors / build_status → build_compile_check 确认新文件真的进了编译集（legacy .csproj 不会自动包含新 .cs）。Use after changing C# / XAML code to confirm it compiles and that new files are actually compiled. Triggers：编译一下、构建、能不能编过、新文件没生效、MSBuild 报错。
---

# 构建与编译集

1. `build_run`：
   - 带 `runId`（与收尾裁决用同一个），否则只写 `last.json`，多个 agent 并发时会互相覆盖；
   - 迭代时用增量 Build，最终结论用 Rebuild；长构建用 `background=true`，再查 `build_status`；
   - 核对返回里的 target 和日志路径——不传 project 时会自动挑解决方案，未必包含你的改动；
   - 客户端正在运行会锁文件（MSB3027 / MSB3021，结果标 `blockedByEnvironment`）：**不要自己传 `killClient=true`**，先问用户。
2. `build_errors`：结构化错误（file / line / col / code）。它读的是"最近一次"日志，未必是你的那次——看日志路径和时间。
3. 新增的 .cs：`build_compile_check(file)`，三种结果：在编译集 / 能证明不在 / 判不了。"0 错误"和"我的文件被编译了"是两回事。插件的 PostToolUse 钩子在写入 .cs 后会自动核一次，提醒了就去补 `<Compile Include>`。
4. SDK 解析类错误（MSB4236 / MSB4276 / NETSDK1004）属于环境问题，不是代码问题，照实汇报。
5. 收尾：`verify_report` 用 `kind=build`（同一 runId）和 `kind=compiled`。
