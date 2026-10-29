# Harness² 核心迁移评估与 DSH 接入设计

状态：已实现（k=1 单步）；未验证学习收益。k≤4 的递归扩展已提供实验入口。日期：2026-10-28。

当前实现了单轮 `k=1` 编排、重复行为对照、k≤4 的 parallel/sequential 实验入口、隔离执行器、Codex/命令适配、作用域经验生命周期、DSH/MCP 工具面和离线/留出评测夹具。没有修改生产宿主配置，也没有把一次模型烟测描述成学习收益。

评估基线：

- DSH：`27c8fedcb93d0e09f6ac3019421e6d7216127b06`；检查时已有抓包模块的未提交修改，不属于本提案。
- Harness²：[`1cfe254e8d25b15f37048c3730134686abe60335`][upstream]。核心行为根据 `core/`、Demo 和实验指南核对。
- 当前运行环境的诊断不作为迁移完成证据；宿主会话接口、真实任务重放和部署兼容性仍需专项验证。

## 1. 结论与选型

可以复用其设计和许可允许的代码。建议用 Node ESM 实现一个小型、无宿主依赖的改进核心，接入 DSH 已有验证、任务和存储能力。Python 原实现保留为行为参考，不引入第二套常驻 Python 服务。

优先迁移五个能力：

1. 将任务、执行 Harness、候选改动、执行证据分别保存并关联。
2. 对同一任务提出候选、隔离试跑、比较行为、组合改动。
3. 让模型建议与确定性验证各司其职。
4. 按组件记录 `helped / hurt / no observed effect / confounded`，证据不足时不写长期经验。
5. 按项目与任务类型检索经验，指导下一次改进。

DSH 需要增加的主要是编排和候选生命周期；现有验证器、失败库、任务队列、记忆存储继续使用。第一版验证单轮流程，随后再决定是否值得增加递归预算和并行模式。

## 2. 上游哪些可以借鉴，哪些需要改造

所有上游路径相对固定版本的 [harness2/core][up-core]。

| 上游模块 | 已核实的职责 | DSH 的迁移决策 |
| --- | --- | --- |
| `spec.py` | 分离任务适配、可编辑组件、执行器、轨迹与产物读取 | 借鉴接口边界，改为显式注入的 JS 对象；不绑定某个模型服务 |
| `context.py` | 组织任务、源材料、轨迹、候选和历史经验；排除答案及评测输出 | 复用上下文分层；通过 DSH 证据引用建立有界、脱敏的上下文 |
| `recursion.py` | 并行与串行的 Propose–Probe–Compose | 第一版只做 `k=1`；无模型的受控执行器先验证状态转换 |
| `prompts.py` | 以执行差异支持修改；允许 `KEEP_BASE`、`NO_ENTRY`；强调常驻文本的成本 | 转化为短的阶段指令和结构化输出契约，保留逐项证据与不确定性 |
| `selection.py` | 匿名产物选择、采用后反思 | 保留匿名建议；加入基础结果与拒绝采用路径，以冻结的验证契约决定候选资格 |
| `library.py` | 同领域历史 Harness 和经验；只读取此前任务的记录 | 使用本仓存储原语与分作用域索引；增加经验状态、版本失效和撤回 |
| `schedule.py`、`runmark.py` | 调度、运行命名、缓存与恢复 | 复用 DSH 身份和任务服务；恢复元数据不等于重放未知副作用 |
| `proposer.py`、`substrate/` | 启动模型/CLI，安装候选 Harness，读取回复 | 接口思想可用；具体启动器、权限参数和环境配置重新适配 |
| `demo.py` | 用预设编辑器和真实 Python 执行演示流程 | 可参考其测试方式；预设成功不能作为模型学习收益 |

两处需要明确区别：上游最终选择池不包含原始执行结果，但组合阶段可以 `KEEP_BASE`。上游经验字段完整，也不代表其因果解释经过机器证明。DSH 不能直接将这两种结果提升为验证通过。

## 3. DSH 已有基础与真实缺口

| 能力 | 本仓依据 | 接入方式与边界 |
| --- | --- | --- |
| 声明与机器证据核对 | [`lib/verify/report.mjs`](../lib/verify/report.mjs) 的 `makeVerificationReport` | 使用 `verifiedVerdict` 和逐项 `evidenceLevel`；`manual` 只表达人为验收，不能替代独立验证 |
| 可追溯证据包 | [`lib/verify/bundle.mjs`](../lib/verify/bundle.mjs)、[证据包说明](evidence-bundle.md) | 引用已有 manifest、哈希、遗漏清单；证据包有大小上限，并非完整执行环境快照 |
| 失败样本与生产者来源 | [`lib/failure-corpus.mjs`](../lib/failure-corpus.mjs)、[`lib/failure-provenance.mjs`](../lib/failure-provenance.mjs) | 用于发现重复问题、关联运行；失败记录本身不证明改进有效，不增加新的失败分类 |
| 工具调用元数据 | [`lib/tool-trace.mjs`](../lib/tool-trace.mjs) | 记录工具、耗时、运行 ID、错误码；刻意不保存参数和输出，不能冒充完整 Agent 轨迹 |
| 后台任务与取消 | [`lib/task-service.mjs`](../lib/task-service.mjs)、[`lib/task-tool-support.mjs`](../lib/task-tool-support.mjs) | 沿用 job/attempt、deadline、资源锁、去重及 `unknown` 语义；增加工具仍需接入任务白名单 |
| 源码身份 | [`lib/source-manifest.mjs`](../lib/source-manifest.mjs)、[`lib/run-identity.mjs`](../lib/run-identity.mjs) | 基于现有内容指纹和 ID；另行绑定 Harness、输入材料、模型与验证契约版本 |
| 作用域记忆 | [`plugins/dsh-memory/lib/kv.mjs`](../plugins/dsh-memory/lib/kv.mjs) | 复用事务与存储，经现有校验/敏感内容过滤入口发布索引；不直接将模型反思写成全局 convention |
| 外部 Agent 试验 | [`bench/harness/bench.mjs`](../bench/harness/bench.mjs)、[bench 说明](../bench/README.md) | 已有 CLI、隔离 checkout、隐藏验证与成本记录的参考；尚非可注入的生产执行接口 |
| 多端接口 | [`lib/tool-registry.mjs`](../lib/tool-registry.mjs)、[Rust runtime](native-runtime.md) | 后续统一登记 JS/DSH/MCP 接口，更新原生目录快照；native-only 与兼容桥的能力分别报告 |

有三个实际缺口：

1. 需要可启动独立会话、注入候选 Harness、控制输出目录并返回产物的执行适配器。现有工具队列只调度工具，不等同于完整 Agent 调度。
2. 需要按任务采集、脱敏和关联的执行证据视图。不能简单开启全量参数/输出日志来填补轨迹缺口。
3. 需要冻结验收契约、管理候选资格和经验晋升的控制层。目前 `verify_report` 核验的是传入的 claims，不替调用方保证 claims 覆盖整个任务。

现有 bench 启动器包含跳过权限的参数，超时路径还使用按进程名结束进程的方式。其评测结构可参考，启动与清理代码不能原样用于共享桌面宿主。新执行器必须绑定本次进程身份并遵守宿主授权。

## 4. 目标结构

```text
宿主 Agent / 隔离试验 CLI
        │ 提出候选、解释证据
        ▼
DSH Harness 核心
  任务快照 → 候选校验 → 隔离试跑 → 验证与比较 → 经验记录
        │                    │                  │
        ▼                    ▼                  ▼
现有任务服务           verify_report       独立经验工件
与执行适配器           与 evidence bundle   + memory 索引
```

核心放在拟新增的 `lib/harness/`，保持与现有 `lib/` 相同的无宿主依赖约束。候选内容不负责定义自己的通过标准。

### 两个执行接口

| 拟定接口 | 输入 | 输出 |
| --- | --- | --- |
| `improver.runStage` | 阶段、只读证据视图、候选工作区、预算、取消信号 | 候选文件差异/结构化选择/反思，附逐项证据引用与用量 |
| `executor.runTask` | 冻结任务、输入快照、Harness 指纹、独立工作区、运行 ID、预算、取消信号 | 退出状态、产物引用、脱敏轨迹引用、实际模型身份、用量与完整性 |

两个接口均可注入确定性测试替身。真实宿主接入前，必须验证会话隔离、Harness 安装及读取、取消、工作目录限制与用量报告；缺少能力时返回明确的 unavailable，不能默认为可用。

模型产生的解释保存为建议。验证适配器根据冻结契约调用现有 `makeVerificationReport`，然后再执行比较策略。UI、性能等尚无专用 claim 类型的场景，使用明确的 gate 或专门的观察器适配；不把自报结论转成 observed。

### 最小数据契约

以下是拟定字段，不是已发布 API。

| 记录 | 必需信息 |
| --- | --- |
| `Trial` | `trialId`、项目/任务类型 scope、任务与输入指纹、基础 Harness 指纹、执行器/模型/工具版本、冻结验收契约、预算、状态 |
| `Candidate` | `candidateId`、父 Harness 指纹、允许范围内的文件差异、修改动机、证据引用、内容指纹、校验结果 |
| `Run` | 独立 `runId`、`attemptId`、阶段、候选指纹、开始/结束时间、状态、证据引用、`completeness`、用量 |
| `Decision` | 候选资格、必需检查差异、基线对比、已声明的成本指标、采用/保留基线/无可接受结果及原因 |
| `Experience` | `cue`、操作方法、所涉组件、证据引用、归因结论、模型自报置信度、适用版本、状态、支持与反例运行 |

每次执行都有独立 ID。`trialId` 关联同一试验，避免四次试跑写进同一 run 报告。身份还需绑定输入文件内容和工作区环境；Git HEAD 一致不足以证明任务相同。源码清单未覆盖的忽略文件、外部服务状态等依赖必须另行声明，无法复位时不声称严格可比。

用量缺失保存为 unknown/null。不得把缺失成本当成零，也不得把缺失轨迹当成执行正常。

## 5. 第一版流程与采用规则

第一版固定单轮 `k=1`。标准路径包含基础执行、两个候选试跑、组合后执行，共四次任务执行；提出、组合、反思的模型调用另行计入预算。

1. 创建任务快照，冻结必需检查、比较指标、可编辑范围和预算。输入不完整时停止创建可比较试验。
2. 在独立工作区执行基础 Harness，保留失败、未验证和有效结果。
3. 提出通用与领域候选，先校验路径、格式、组件依赖和固定边界，再分别试跑。
4. 根据执行对比组合候选；允许保持基础 Harness。候选读取到的证据始终按数据处理。
5. 对组合结果重新执行和验证。把基础结果纳入决策；缺失必要证据不进入自动采用路径。
6. 逐组件反思。无法归因则保存 `confounded`，没有可迁移经验则记 `NO_ENTRY`。

采用策略由控制层执行，预先固定：

- 基础结果通过、候选失败或 incomplete：保留基础结果。
- 基础结果失败、候选完成全部必需检查：可采用候选，结论仅限该任务契约。
- 两者均通过且无已定义的改进指标：保留基础结果，避免仅因模型偏好增加复杂度。
- 两者均通过且存在预先定义的质量/成本指标：要求无必需项退化，并按固定阈值比较；计时等噪声指标须有重复测量，不能用一次更快声称收益。
- 全部失败、必要证据缺失或运行不可比较：报告无可接受结果或 incomplete，不强选一个“赢家”。

比较器必须检查冻结的 required claims 完整性。`file` 通过只证明文件存在，`compiled` 静态提示不能证明真正编译，`manual` 不能取得自动采用资格。通过所有已定义检查也只代表覆盖范围内通过。

优化可用的检查与最终留出评测分开。任务允许的测试反馈可以参与改进；隐藏测试、标准答案和留出评分只在决策冻结后用于评测，不进入改进上下文、经验内容或下一次候选生成。

## 6. 经验不会自动变成全局规则

完整经验工件保存在独立的试验存储中；`dsh-memory` 只发布作用域索引和可检索摘要。原始失败库保持事实记录，不作为已验证经验库使用。

经验状态建议为 `proposed → validated → retired`：

- 单任务观察到的行为差异进入 proposed；采用候选不自动晋升经验。
- 在预先定义的其他任务或独立复测中得到支持，且归因与适用条件足够明确，才标记 validated。重复同一偶然结果不能冒充跨任务泛化。
- 反例、组件版本变化或检查策略变化可令经验退役；检索时必须带 scope、版本和状态过滤。

proposed 可以供改进器参考，但必须连同不确定性呈现；validated 仍是有边界的参考，不是不可违反的命令。没有适用经验时返回空结果。

优先生成按需加载的 Skill、工具指导或确定性 helper。常驻提示词只承载短且普适的内容，并记录增量成本。第一版只写试验目录内的候选 overlay，不自动修改用户全局规范、已安装 Skills 或宿主配置。

这条偏好已落为可编辑面的具名预设：`editableSurface: "guidance"` 展开为 `skills/**`、`tool-guidance/**`、`guidance/**`、`AGENTS.md`、`helpers/**` 等组件路径（见 `lib/harness/core.mjs` 的 `EDITABLE_SURFACE_PRESETS`）。该面随阶段输入下发给改进器（`.harness-stage-input.json` 的 `editableSurface` 字段），并在改进器提示中声明"只改该组件面、优先小改 Skill/工具指导、常驻文本从短、绝不写交付物"。它是**可选**的：不设则维持原无限制行为；设错的预设名在试验创建前即以明确错误拒绝。越界或触碰交付物/校验目标仍由可编辑面 allowlist 与 protected-path 守卫双重拦下（候选不能靠预置产物骗过冻结裁决）。仍只写试验目录内 overlay，不动已安装 Skills 或宿主配置。

## 7. 执行、存储与宿主接入

拟定落盘位置为配置的 `DSH_HARNESS_DIR`；默认跟随 toolchain home 下的 `harness/`。离线开发工件放入现有被忽略的 `.dsh-agent-toolchain/harness/`，不将真实任务材料提交到仓库。

```text
harness/
  trials/<trialId>/
    manifest.json
    candidates/<candidateId>/
    runs/<runId>/
    decision.json
    experience.json
  library/<scopeId>/index.json
```

复用现有事务、报告发布与 source manifest 原语。哈希用于绑定内容和发现变化，不构成防恶意篡改凭证；同一操作系统账号下的目录隔离也不等于安全沙箱。固定验证工件需处在候选不可修改的执行边界，实际能力以执行器为准。

试验先使用可复位的本地任务和受控服务。对共享桌面、外部写接口、长驻进程等，必须有已验证的目标身份、复位机制及授权，不能将一次操作授权扩展为任意候选重放。UI 试跑串行使用既有桌面锁；不同工作区仍可能共享进程和服务。

遇到超时、取消或崩溃，沿用 DSH 的 unknown/incomplete 表达。恢复读取已落盘状态，未知副作用不自动重放。各阶段共用总 deadline，并在下一阶段开始前核对剩余预算。

接口发布放在核心验证之后，建议：

- 一个拟新增的 `harness_trial` 入口负责受控试验，长任务返回现有 job；状态/结果/取消复用 `toolchain_job`。
- 一个拟新增的 `harness_experience` 入口负责查询与有记录的状态转换；模型不能传入 `validated=true` 绕过证据检查。
- 通过 `lib/tool-registry.mjs` 声明参数与副作用，再接 DSH plugin 和 MCP。遵守已有[失败工具端面差异](failure-tools-scope.md)，不顺带暴露其他写入口。
- 原生兼容模式通过现有桥调用 JS 核心，并更新生成工具目录；native-only 的支持范围独立说明，不直接宣称支持新增能力。

## 8. 最小实现拆分与验收

| 阶段 | 交付 | 完成依据 |
| --- | --- | --- |
| A：可测试核心 | 拟新增 `lib/harness/` 的数据契约、候选校验、单轮调度、比较与经验状态；受控执行器 | 离线测试证明状态与证据处理，不声称模型自我改进 |
| B：一个真实执行器 | 从现有 bench 分离适配边界，接一个能安装候选并回收证据的执行器 | 独立工作区、实际模型/工具身份、产物/用量、超时取消均有证据 |
| C：DSH/MCP 接入 | 工具注册、plugin 外壳、后台任务、展示和经验索引 | 两端 schema/结果一致；部署后新宿主实测；native-only/兼容桥分别核验 |
| D：收益评测 | 同预算固定 Harness 对照、单轮改进、带经验的后续任务 | 留出任务、重复运行、成功率与成本均披露；据此决定是否增加 `k` 和并行探索 |

### 已落地范围

- 阶段 A：`lib/harness/core.mjs` 固定四组任务执行（base、general、domain、composed，默认每组重复 2 次），生成 contrast/evidenceDigest，冻结 claim、隔离工作区、身份指纹、composer 决策否决器、采用规则和 `unknown/incomplete` 状态；可编辑面 allowlist（含 `guidance` 具名预设，随阶段输入下发改进器）与 protected-path 守卫、候选拒绝单次反馈重试、候选多样性（line-Jaccard）观测；`lib/harness/core.test.mjs` 覆盖基线保留、改进采用、对照重复、k=2 selector、空契约、取消、交付物防作弊、越界/预设面拒绝、重试与多样性塌缩。
- 阶段 B：`lib/harness/executor.mjs` 提供有界子进程执行器和 Codex `exec --json --ephemeral --sandbox workspace-write` 适配。默认只保留脱敏摘要、产物哈希和协议用量；CLI 不存在、取消、超时和副作用未知时如实返回 unavailable/unknown。真实 Codex 烟测只证明适配器可观察到一次完成响应，不证明 Harness² 学习收益。
- 阶段 C：`harness_trial` 与 `harness_experience` 已由共享注册表接入 DSH/MCP；长任务沿用 JS task service、requestKey 指纹、取消和 `toolchain_job`，原生运行时明确保持 hybrid-only，不把未实现的 Rust 能力列为 native-only。
- 阶段 D：`bench/harness2/evaluate.mjs` 和 `bench/harness2/core-evaluation.test.mjs` 使用相同预算、重复执行和留出任务比较固定基线与单轮流程；缺失 cost 仍为 `null`，合成夹具通过不等于真实任务收益。

仍未完成的是面向具体业务 Agent 的长期部署与统计评测：需要一个获授权的真实执行配置、冻结任务/隐藏评测边界和足够的重复样本，才能报告成功率、成本或泛化提升。

### 与论文的偏离

1. 真值门：论文前提是没有 ground-truth verifier；本实现要求任务预置冻结 claims，且机器验证通过、行为对照一致后才允许 adopt。这是有 verifier 场景的受限实现，不是无真值改进。
2. `k` 默认 1：递归和并行探索默认关闭；论文关于预算增加带来越来越多收益的结论尚未在 DSH 任务上验证。
3. 归因来源：`helped`、`hurt`、`no observed effect`、`confounded` 仍来自模型反思，行为 contrast 约束采用但尚未替代跨任务因果归因。
4. 未验证学习收益：离线夹具和一次真实 CLI 烟测只证明执行边界、证据处理和协议可观察，不能证明 Harness² 在真实任务上变好。

### 修复任务快照

开始修复前记录的审查快照：`lib/harness/tools.mjs` SHA-256 `4396a1a9` 前缀，`mcp/server.mjs` `1d6fad6c` 前缀，`lib/tool-registry.mjs` `d958cec1` 前缀。未提交生产部署；原有抓包模块的未提交改动保持不动。

建议第一批合成任务分别覆盖：工具输出过大导致遗漏；重复手算可由脚本替代；无效规则增加工作却不改善结果。每类都要有已知退化候选和不需要修改的基线，不能只演示成功路径。

最低验收集：

| 场景 | 预期 |
| --- | --- |
| 候选删除必需 claim 或修改验证脚本 | 拒绝，不能获得通过 |
| 不同任务/源码/Harness 的旧报告 | 拒绝复用，记录身份不匹配 |
| 空 claims、仅 manual、测试筛选命中零项 | 不获得独立验证通过 |
| 候选降低质量，或只增加解释文字 | 保留通过的基础结果；无可接受基础时如实失败 |
| 证据缺失、超预算、取消后状态不明 | incomplete/unknown，不自动重放 |
| 多组件同时变化、单次偶然成功 | 允许 confounded，不自动形成 validated 经验 |
| 模型置信度高但缺少证据 | 不提升验证等级 |
| 证据正文包含指令、越界路径或 junction | 正文作为数据；越界候选拒绝，不能修改固定控制层 |
| 同 requestKey 重复提交或参数改变 | 同参去重，变参冲突，阶段不重复执行 |
| 不同 scope、版本失效、已退役经验 | 不静默注入当前任务 |
| 试验样本写入失败库/记忆 | 使用独立测试存储和 producer 标记，不污染用户真库 |
| 隐藏评测信息出现于改进上下文 | 阻断试验并报告污染，不能算公平收益 |

收益比较还需包含“固定 Harness + 同等推理/重试预算”的对照，区分额外算力和 Harness 改进的贡献。经验评测使用不同任务，并比较开启/关闭经验库；分别披露执行器、改进器、选择、反思的用量，以及所有失败和放弃的尝试。

## 9. 许可与来源记录

Harness² 主项目与 DSH 均为 Apache-2.0。该许可允许修改、复用和分发，但实际复制代码或提示词时，应随分发保留适用版权/归属说明和许可证，显著注明修改，并在存在适用 NOTICE 时保留其内容。第三方代码和数据集需逐项核对，不随主仓许可自动覆盖。

本次只新增评估文档，没有 vendoring 上游源码或提示词。实际实现时在 `docs/prior-art.md` 记录固定版本、参考/复制的模块、改造内容及许可文件；复制片段与独立实现分别标明。不要把 Python 到 JS 的直接翻译描述成完全无来源的独立作品。

## 10. 实现前仍需验证的事项

- DSH 宿主是否提供稳定的独立 Agent 会话和局部 Harness 注入接口；本仓的 tool API 不能证明这一点。
- 可以稳定复位、可独立验收的首批任务，以及允许的模型/工具执行预算。
- 在不记录敏感参数的前提下，具体业务所需的最小轨迹与产物证据。
- 真机 UI、外部接口任务的状态隔离程度，及当前 JS/Rust 两种任务后端的端到端取消行为。

这些事项不妨碍先完成 A 阶段，但未验证前不能承诺“安装后自动持续学习”或给出性能提升比例。

[upstream]: https://github.com/google-research/harness2/tree/1cfe254e8d25b15f37048c3730134686abe60335
[up-core]: https://github.com/google-research/harness2/tree/1cfe254e8d25b15f37048c3730134686abe60335/harness2/core
