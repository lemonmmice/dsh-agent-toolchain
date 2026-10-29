# Harness² 执行器边界

`lib/harness/executor.mjs` 提供两个可注入适配器：

- `createExecutor({ command | commandBuilder })` 在指定绝对工作区启动一个命令数组，限制工作目录、输出大小和时限，并返回 `completed`、`failed`、`unknown` 或 `unavailable`。取消、超时和输出超限都返回 `unknown/incomplete`，不会自动重放。
- `createImprover({ runner | command | commandBuilder })` 将阶段、任务、候选、经验和有界机器证据写入试验工作区的临时输入文件。阶段不会收到隐藏检查、答案或最终评分；结构化 JSON 才能产生候选 overlay 或反思记录。
- `createCodexExecutor({ command, model })` 是 Codex CLI 的可选适配器，使用 `--sandbox workspace-write`。当前环境找不到 CLI 时，适配器明确返回 `unavailable`，不假装完成模型试验。

命令子进程使用 DSH 的按 PID 树取消通路。执行器不会使用按进程名杀进程、跳过权限参数或共享工作目录。`trajectory` 只保留经过长度限制和敏感模式遮罩的摘要，完整 stdout/stderr 不作为长期轨迹保存。输出产物仅从任务声明的相对路径读取并计算 SHA-256；越界路径被忽略。

执行器本身不判断任务是否通过。调用方必须用冻结的 claims 调用 `verify_report`，再把验证报告交给 Harness² 核心的比较器。缺少模型 token/cost 时保存为 `null`，不是零。

离线验证：

```text
node lib/harness/executor.test.mjs
node bench/harness2/evaluate.test.mjs
```

这些测试证明执行边界、取消语义、结构化阶段输出和 equal-budget/held-out 报表逻辑；它们不证明当前机器已配置真实 Codex 会话，也不证明 Harness² 带来收益。

