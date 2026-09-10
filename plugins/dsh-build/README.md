# dsh-build

DSH（DeepSeek Harness）的**编译验证闭环插件**：把 MSBuild 构建做成 agent 工具，
AI 改完代码 → 增量编译 → 结构化错误回填 → 修复 → 再编译。AI 的代码输出因此带上**硬校验**。

## 工具

| 工具 | 说明 |
| --- | --- |
| \`build_run\` | 运行构建：\`target=Build\`（增量快检，默认）/ \`Rebuild\`（全量结论）；\`engine=msbuild\`（默认，VS MSBuild）/ \`engine=dotnet\`（\`dotnet build\`，自动 restore，现代 SDK 仓库推荐）；\`project\` 可定向单工程/.sln；\`killClient\` 先结束占用输出目录的客户端；\`runId\` 写本次构建的凭证记录（见下）；返回结构化错误（file/line/col/code/message，环境错误与代码错误分开归类） |
| \`build_status\` | 最近一次构建结果（目标/耗时/错误数/日志路径） |
| \`build_errors\` | 从最近日志重解析错误/警告列表 |

### 证据链：`runId`

`build_run` 传了 `runId` 才会写 `run-<runId>.json`（落在构建日志目录），**而 `verify_report` 的
`build` 类 claim 正是读这个文件**。不传 `runId` 时只写 `last.json`——多个 agent 并发时互相覆盖，
`build` claim 就无法用于收尾裁决（只能退回人工判断）。建议统一用 `who-task-n` 形式，例如
`dsh-logon-fix-1`、`codex-etf-2`，一条任务链全程复用同一个 runId。

## msbuild 引擎的布局识别

msbuild 引擎不再硬编码 \`WholeSolution.sln\`/x86 默认值，而是按仓库布局自动解析
（逻辑在 \`lib/build-resolve.mjs\`，builder 与 MCP 共用）：

- **老客户端布局**：仓库根存在 \`WholeSolution.sln\` → 沿用老默认
  （默认目标 \`WholeSolution.sln\`、平台 \`x86\`），行为与以前完全一致；
- **普通仓库**：无 \`project\` 时自动探测 \`.sln\`/\`.slnx\`
  （根目录 → 一层子目录，跳过 bin/obj/.git/node_modules 等）；
  平台从解决方案文件本身读取（\`Any CPU\` 优先，其次 \`Mixed Platforms\`、\`x86\`，
  读不出则省略 \`/p:Platform\` 交给解决方案默认值）；
- **歧义即报错**：根目录或一层子目录里有多个解决方案时直接报错列出候选，
  要求用 \`project\` 显式指定——绝不猜测。

另外 msbuild 引擎总是带 \`/restore\`：MSBuild.exe 不像 \`dotnet build\` 那样隐式
restore，SDK 工程缺 restore 会以 NETSDK1004（找不到 assets 文件）失败；
对老式 packages.config 工程它是 no-op。

## 硬约束（systemPrompt 公告，agent 必须遵守）

- 改完代码必须 \`build_run\` 增量验证；错误未清零不得声称编译通过
- 只有 \`Rebuild\` 成功才能说 "Solution Rebuild passed"
- 增量 Build 通过只能说 incremental/targeted build passed
- 已知坑：legacy csproj 新增 .cs 必须手工加 \`<Compile Include>\`，否则"构建通过但文件没编译"

## 前置检查

构建前检测客户端进程（\`DSH_BUILD_CLIENT_PROC\` / \`DSH_UI_PROC_NAME\`）：运行中的客户端会锁定输出目录
（MSB3021/3027 文件锁风暴），插件直接拦截并提示——传 \`killClient=true\` 可先结束它再构建。
环境错误与代码错误分开归类，避免 AI 把文件锁误当代码错误瞎修。

## 实现

- \`lib/builder.mjs\` — MSBuild/dotnet spawn（超时杀进程树）、UTF-8/GBK 双解码（收敛到 \`lib/decode.mjs\`）、错误行正则解析（含无行列号的顶层 \`MSBUILD : error MSBxxxx\`、嵌入式 \`file : error : MSBxxxx:\`、NETSDKxxxx 六字母码前缀）、环境/代码错误分类（SDK 解析、NuGet 源不可达、文件锁归环境类）、运行记录
- \`lib/build-resolve.mjs\` — 默认解决方案/平台解析（老布局兼容 + 自动探测，见上节），builder 与 MCP 共用
- \`index.js\` — 工具注册 + systemPrompt 公告 + 回环路由（status/errors/log）
- 错误行格式：\`path(line,col): error CS1234: message\`（MSBuild \`/v:m\`）；顶层错误（MSB1009/MSB4126 等无行列号）以 \`file:(top-level)\` 进入结构化列表——\`ok:false\` 时 \`errors:[]\` 为空是 bug，不再是

## 环境变量

| 项目 | 说明 |
| --- | --- |
| \`DSH_BUILD_CLIENT_ROOT\` | 仓库根目录（旧名，与 \`DSH_BUILD_REPO_ROOT\` 二选一） |
| \`DSH_BUILD_REPO_ROOT\` | 仓库根目录（通用名，优先） |
| \`DSH_BUILD_PLATFORM\` | 覆盖自动解析的平台（如 \`x86\` / \`Any CPU\`） |
| \`DSH_BUILD_MSBUILD\` | MSBuild.exe 路径（默认 VS 自带，缺失时 vswhere 定位） |
| \`DSH_BUILD_ENGINE\` | 构建引擎 \`msbuild\`（默认）/ \`dotnet\`（SDK 仓库推荐） |
| \`DSH_BUILD_CLIENT_PROC\` | 输出目录会被锁定的客户端进程名（可选，缺省用 \`DSH_UI_PROC_NAME\`） |
| \`DSH_BUILD_LOGS_DIR\` | 日志目录，默认 \`~/.dsh-agent-toolchain/build-logs\` |

## 安装

\`~/.dsh/profiles/web/cordis.patch.yml\` 追加：

\`\`\`yaml
- insert:
    - id: build
      name: './plugins/dsh-build/index.js'
\`\`\`

重启 DSH 生效。
