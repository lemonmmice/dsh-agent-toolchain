# dsh-build

DSH（DeepSeek Harness）的**编译验证闭环插件**：把 MSBuild 构建做成 agent 工具，
AI 改完代码 → 增量编译 → 结构化错误回填 → 修复 → 再编译。AI 的代码输出因此带上**硬校验**。

## 工具

| 工具 | 说明 |
| --- | --- |
| \`build_run\` | 运行构建：\`target=Build\`（增量快检，默认）/ \`Rebuild\`（全量结论）；\`engine=msbuild\`（默认，VS MSBuild，x86/WholeSolution 老客户端布局）/ \`engine=dotnet\`（\`dotnet build\`，自动 restore、Any CPU——现代 SDK 仓库请用它）；\`project\` 可定向单工程；\`killClient\` 先结束占用输出目录的客户端；返回结构化错误（file/line/col/code/message） |
| \`build_status\` | 最近一次构建结果（目标/耗时/错误数/日志路径） |
| \`build_errors\` | 从最近日志重解析错误/警告列表 |

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

- \`lib/builder.mjs\` — MSBuild/dotnet spawn（超时杀进程树）、UTF-8/GBK 双解码（收敛到 \`lib/decode.mjs\`）、错误行正则解析（含无行列号的顶层 \`MSBUILD : error MSBxxxx\`）、运行记录
- \`index.js\` — 工具注册 + systemPrompt 公告 + 回环路由（status/errors/log）
- 错误行格式：\`path(line,col): error CS1234: message\`（MSBuild \`/v:m\`）；顶层错误（MSB1009/MSB4126 等无行列号）以 \`file:(top-level)\` 进入结构化列表——\`ok:false\` 时 \`errors:[]\` 为空是 bug，不再是

## 环境变量

| 项目 | 说明 |
| --- | --- |
| \`DSH_BUILD_CLIENT_ROOT\` | 解决方案根目录（必配） |
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
