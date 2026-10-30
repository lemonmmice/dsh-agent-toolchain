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

## 反复失败 → 自己发起自改进（不用等人开口）

收尾读 `failure_stats` 时，若 `topRecurring` 里有一条 `occurrences ≥ 3`、且属于**行为类**失败（`agent-misjudge`、反复踩同一个坑；**排除** `tool-error` 等基建/工具抖动——那不是改 skill 能防的），就**主动发起一次 `harness_trial` 把它沉淀成可复用的 skill / 工具指引**，不要等用户要求：

1. 用那条记录的 `task` / `sample` 还原一个可复现的最小案例，写成 trial 的 `task` + 冻结 `claims`——claims 必须是"这类错误已不再发生"的 `gate`，不是 `file` 存在。
2. **按领域归档**：给 trial 配 `scope.taskType` = 问题领域，从发现路径推断——`hang_*` / `perf_uifreeze` → `thread-hang`；`perf_*` → `perf`；`capture_*` / `http_request` → `api`；`build_*` / `compiled` → `build`；`ui_*` → `ui`；没有诊断工具路径的逻辑类误判 → `logic`。沉淀出的 skill 按领域归档，下次同领域问题由 harness 按 `scope` 召回。（失败库那套固定 7 类讲的是"**怎么**失败"；`taskType` 才是"**哪个领域**"——两套轴别混。）
3. 配 `editableSurface: "guidance"`：候选只能改 skill / 工具指引 / helper，改进器会优先小改一个 on-demand skill，且**绝不能写交付物或校验目标**（防止靠预置产物骗过裁决）。
4. 跑完若候选在冻结裁决下胜出，它落为 `proposed`。**到此为止是自动的。**
5. 复现不了、给不出 gate 的别硬凑——把这条反复失败和一句 trial 草案摆给用户，别假装已经沉淀。

**提升这条线别自动跨**：`proposed → validated` 必须由 `harness_experience action=validate` 带 ≥2 个独立任务的机器证据，模型不能自判 validated；把 skill 真正装进宿主 / 已装 Skills 更是另一步人工决定。这正是"经验不自动变成全局规则"的安全边界。
