# Windows 独立安装

适用：Windows x64 上的 Claude Code、Claude Desktop、Codex 桌面版/CLI/IDE。Claude 和 Codex 自身需要先安装并登录。

## 给同事的操作

1. 在 GitHub Releases 下载 `dsh-agent-toolchain-win-x64.zip`，完整解压。
2. 双击 `setup.cmd`，默认选择“全部”。
3. 输入要操作的 EXE 和源码目录；没有具体项目时可以留空。这里填写同事机器自己的路径。
4. 等待“安装成功”，完全退出并重新打开客户端。
5. 发一句：**使用 DSH 的 toolchain_status 检查环境。**

ZIP 自带 Node 24、MCP 依赖、capture-store / memory-store / trace-fold 原生模块、终端检查辅助程序，以及自包含的 DumpStack、HeapRoots、UiFreezeStacks。普通安装无需管理员权限，也无需 Node、Git、Rust、Visual C++ 构建工具或 DeepSeek Harness。

原始源码 ZIP 与完整运行包不同：请认准上述资产名。旧的 v0.3.0 发布没有该 Windows 资产；新增打包工作流发布后才可使用下载入口。

## 安装做了什么

- 将完整包复制到 `%LOCALAPPDATA%\dsh-agent-toolchain\versions\<buildId>`。安装成功后可移走最初的解压目录。
- Claude Code：更新 `~/.claude.json` 的用户级 `mcpServers.dsh-agent-toolchain`；支持 `CLAUDE_CONFIG_DIR`。
- Claude Desktop：更新 `%APPDATA%\Claude\claude_desktop_config.json`。
- Codex：更新 `$CODEX_HOME/config.toml`，未配置该变量时使用 `~/.codex/config.toml`。只替换该服务的 TOML 表，保留其他表、注释和设置。
- Claude Code 技能放到 `~/.claude/skills/`，Codex 技能放到 `~/.agents/skills/`；已有同名技能保留，便于维护本机定制。
- 配置变更前生成同目录 `.dsh-backup-<id>` 备份。安装记录和真实握手结果保存在 `~/.dsh-agent-toolchain/installation.json` 与 `install-check.json`。
- 独立入口在读取本机配置前隔离继承的 DSH 目标变量，避免沿用另一项目的进程名。凭据仍从进程环境传递，不写进安装包。
- 不改变模型、账号、审批设置，不安装 DSH，不自动安装 hooks，不自动启动被测应用。

安装器先验证配置格式和 MCP 握手，再注册到客户端。配置中已有同名服务会更新为独立入口；重复安装保持单份注册。若此前使用 Claude marketplace 插件安装了同一套工具，请移除那份插件注册，避免两个命名空间各出现一套工具。

Codex 的内联 TOML 同名服务需要先改成常规 `[mcp_servers.dsh-agent-toolchain]` 表；安装器会明确报错并保留原文件。组织管理策略或客户端禁用本地 MCP 的设置仍由组织控制。

## 抓包无需 Harness

安装器设置 `DSH_CAPTURE_BACKEND=standalone`。首次调用抓包工具时，MCP 按需拉起隐藏的 `mcp/capture-service.mjs` 进程；默认只监听 `127.0.0.1:3081`，本机随机令牌保存在用户数据目录，浏览器跨站请求被拒绝。

Claude Code、Claude Desktop 和 Codex 共用这个进程，不分别创建日志读取器。服务继续运行，以便捕获跨会话请求；`capture_stop` 停止日志捕获。升级时安装器会请求关闭空闲服务；仍在抓包、代理或透明拦截时会拒绝升级，先停止对应功能再重试。

使用的是现有 capture/proxy 引擎和路由，所以 mock、规则、透明拦截、弱网模拟的语义保持一致。独立包提供 MCP 控制，没有 DSH 的侧边栏网页。日志捕获仍要求目标应用产出 System.Net trace；代理方式仍要求流量实际经过代理。安装成功不等于已经捕获到网络流量。

不要让旧 DSH 宿主和独立服务同时读取同一个日志/捕获库。两种部署共用 Windows 透明拦截资源，使用透明拦截时只启用一个后端。

## 按能力补充依赖

| 功能 | 完整包安装后 |
| --- | --- |
| MCP、HTTP 调试、规则配置、记忆存储/索引 | 可用；网络访问仍取决于本机网络 |
| Windows UI 观察/操作、窗口消息卡顿探针 | 需要配置 EXE/进程并启动应用；操作沿用工具自身授权规则 |
| 编译应用 | 使用项目要求的 .NET SDK 或 Visual Studio/MSBuild，安装器不更改编译工具链 |
| 离线 ETL CPU 分析 | 自带 UiFreezeStacks；需有效 ETL 和符号，未解析符号会影响归因 |
| DumpStack / HeapRoots 离线分析 | 自带 x86 分析器，适合 32 位 .NET 客户端；匹配 DAC 及可选 dbgeng 仍按目标版本准备 |
| 实时 dump、卡死现场采集 | 另需 [ProcDump](https://learn.microsoft.com/sysinternals/downloads/procdump)，配置 `DSH_PERF_PROCDUMP` / `DSH_HANG_PROCDUMP` |
| 实时 ETW、xperf 热点/火焰图 | 另需 Windows Performance Toolkit 和管理员权限 |
| PerfView Thread Time 采集 | 另需 [PerfView](https://github.com/microsoft/perfview/releases)，配置 `DSH_PERF_PERFVIEW` |
| 透明拦截、HTTPS 解密 | 用户明确调用后按现有工具流程处理 UAC、证书和 hosts |
| 可选 dev_* 外部服务、远程语义/视觉能力 | 对应后端与密钥另配；未配会明确报告不可用 |

这些是目标能力的前置条件，`toolchain_status` 会报告已配置、缺失或未知；“MCP 握手通过”不作为“所有诊断能力均就绪”的结论。

## 更新与移除

更新：下载新包后再次运行 `setup.cmd`。新版本安装到独立目录，原配置先备份，数据和旧版本保留；已有技能按安装提示核对后自行更新。

停止伴随服务：先在 Agent 中执行 `capture_stop`，并停止已开启的代理/拦截，然后使用安装记录中的 Node 和入口执行：

```text
<安装目录>/runtime/node.exe <安装目录>/mcp/standalone.mjs --stop-capture-service
```

移除：先停止伴随服务，再从三个客户端配置中删掉 `dsh-agent-toolchain` 服务；删除需要移除的五个 `dsh-*` 技能。安装目录可以删除；`~/.dsh-agent-toolchain` 包含历史证据，是否保留由使用者决定。没有注册开机启动项或 Windows 服务。

## 发布者打包

在装有 Node 24、Git、Rust MSVC 工具链、Visual C++ 构建工具和 .NET 10 SDK 的 Windows x64 开发机运行：

```powershell
npm run package:windows
npm run check
npm run check:install
```

打包脚本构建原生模块和自包含分析器，从 Node 官方下载运行时并校验 SHA256。输出到 `.dsh-agent-toolchain/dist/`，含 ZIP 与 `.sha256` 文件；不包含用户配置、凭据、证据目录或公司工程。

`.github/workflows/release-windows.yml` 可手动运行并下载 artifact；推送版本 tag 时将 ZIP 与校验文件附加到对应 Release。请把这两个文件作为同一批资产发布。

已有完整发布资产后，也可以下载仓库根目录的 `install-mcp.ps1` 执行安装，它会校验 Release 的 SHA256 后解压并启动同一安装器：

```powershell
powershell -NoProfile -File .\install-mcp.ps1
```

源码开发者可先安装根目录与 `mcp/` 的 npm 依赖，用 `node scripts/install-client.mjs --in-place` 接入当前 checkout；原生组件仍按各 build 脚本准备。此选项不用于普通同事安装。

配置格式依据：[Codex 官方 MCP 文档](https://learn.chatgpt.com/docs/extend/mcp#configure-with-configtoml)、[Claude Code MCP 文档](https://code.claude.com/docs/en/mcp)、[Claude Desktop 本地 MCP 指南](https://modelcontextprotocol.io/quickstart/user)。
