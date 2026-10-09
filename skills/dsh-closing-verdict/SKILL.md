---
name: dsh-closing-verdict
description: 收尾裁决：宣布任务完成之前，把完成声明写成 claims 交给 verify_report 做机器裁决（gate / build / compiled / api / git / file / manual），并如实汇报 pass / incomplete / fail；也包括失败库（failure_*）的查询与记录。Use before declaring a coding task done, when asked to verify a change, or when the Stop hook asks for verify_report. Triggers：收尾、验证一下、确认改好了、完成了吗、verify、done。
---

# 收尾裁决（verify_report）

完成 = 机器证据裁决通过，不是"我觉得好了"。插件的 Stop 钩子会在本回合改了代码、却没调用 verify_report 时拦一次。

## 步骤

1. **定一个 runId**（如 `fix-login-1`），本任务里的 build_run / capture_append / verify_report 原样复用它。
2. **把"完成"拆成可验证的 claims**，按证据强弱选 kind：

   | 想证明 | kind | 要点 |
   | --- | --- | --- |
   | 测试 / lint / 脚本通过 | `gate` | `cmd` 退出码 0 才算过；0 个测试匹配也判失败 |
   | 编译通过 | `build` | 先 `build_run(runId=同一个)`；只认本 run 的构建记录 |
   | 新文件真的被编译 | `compiled` | legacy .csproj 不会自动包含新 .cs；`file` 只验存在 |
   | 接口在本次被调用过 | `api` | 只认带本 runId 的抓包记录（先 `capture_append({runId})`） |
   | 已提交 / 已推送 | `git` | `check=clean` / `pushed` |
   | 文件存在 | `file` | 最弱：只验存在 |
   | 机器验证不了的 | `manual` | 写明 `status` 与 `evidence`；属于自评，报告里会标出来 |

3. 调 `verify_report(runId, task, claims)`。
   需要交接原始证据时加 `bundle=true`；`context.repoRoot` 可附 Git 差异和 HEAD。
   `bundleError` 只表示打包失败，不改变裁决；查看 manifest 的 omitted 后再描述证据完整性。
4. **汇报时先报 verdict**（pass / incomplete / fail）和每条 claim 的状态，再写总结。incomplete 和 fail 都不是"完成"。

## 规则

- 能用 `gate` 就别用 `manual`；不要为了拿 pass 降级 claim。
- 判 fail 的 claim 会自动记进失败库（agent-misjudge）——这是数据，不是惩罚，照实汇报。
- 不拿别的 run 的构建或抓包冒充本次证据。
- 裁决工具本身出错时，用 `failure_record`（class=tool-error）记下来并告诉用户，不要绕过。

## 失败库

- 动手排查之前，`failure_stats` 的 `topRecurring` 与 `failure_query(q=…)` 能告诉你同一个问题以前出现过多少次、怎么解决的。
- 系统看不见的失败（需要人接手、工具行为异常）用 `failure_record` 手工记：记事实，不记责任。
- 记错了用 `failure_retract`（必须写理由；原文保留）。
