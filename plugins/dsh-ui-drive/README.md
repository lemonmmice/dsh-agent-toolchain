# dsh-ui-drive

DSH（DeepSeek Harness）的 **UI 自验驱动插件**：通过 Windows UIA 程序化操作正在运行的桌面客户端并截图留证，
支撑「改完代码 → 启动/驱动客户端到目标页面 → 截图 → 视觉复核」的自验闭环。

## 能力

**Agent 工具（host 侧注册）**

| 工具 | 说明 |
| --- | --- |
| \`ui_status\` | 目标客户端进程/主窗口状态（只读） |
| \`ui_launch\` | 启动客户端并等待主窗口；**视觉即返**：完成后自动截图+视觉模型描述界面（返回 \`uiState.description\`） |
| \`ui_observe\` | **只读观察（推荐入口）**：find / read（含输入框真实值）/ state（窗口+焦点+交互控件快照）/ windows / waitfor / expectwindow / expecttext / waitany / shot |
| \`ui_act\` | **真实操作**：click / setvalue / key / type / drag；\`observe=true\` 动作后附带界面快照；需 \`allowSideEffects=true\` |
| \`ui_windows\` | 列出该进程所有顶层窗口（登录窗口/弹窗/主窗口各自一行，只读） |
| \`ui_state\` | 界面快照：当前窗口 + 焦点元素 + 交互控件清单（只读） |
| \`ui_drive\` | 通用单步入口（等价 ui_observe + ui_act 的并集，保留兼容） |
| \`ui_tree\` | 进程内视觉树 dump（真实类型 + Name + AutomationId + DataContext 类型，只读深查） |
| \`ui_flow\` | 步骤序列自验：find/click/setvalue/key/type/drag/read/state/windows/shot/wait/waitfor/expect/expectwindow/expecttext/waitany，统计 passed/failed，证据落盘 steps.json |

**动态界面（登录、验证码、按界面情况分支）的正确用法**——不是预排固定点击序列，而是「看一步再做下一步」：

\`\`\`text
ui_observe(action="windows")                       # 现在是登录窗还是主窗？有哪些弹窗？
ui_observe(action="state", match="登录|验证码")      # 焦点在哪、按钮什么文案、输入框填了没
ui_act(action="setvalue", aid="phoneBox", value="138…", allowSideEffects=true)   # 受限输入框用 setvalue
ui_act(action="click", name="获取验证码", allowSideEffects=true, observe=true)   # 动作后直接带回界面快照
ui_observe(action="waitany", ms=30000, conds=[
  {kind:"window", titleRe:"主界面",   label:"success"},
  {kind:"text",   textRe:"密码错误|不能为空", label:"error"},
  {kind:"window", titleRe:"登录",     label:"still-here"}])                  # 一次押注三支，返回命中的那支
\`\`\`

跨窗口能力是关键：登录成功 = 登录窗关闭 + 主窗出现（本客户端**没有**成功弹窗），
所以 \`expectwindow\` / \`waitany(kind="window")\` 才是判定登录结果的唯一可靠信号。

**输入正确性（实测踩过的坑）**：本客户端登录页手机号框 \`PreviewKeyDown\` 只放行数字键，
\`key\` 的剪贴板粘贴会被静默吃掉——所以受限输入框用 \`setvalue\`（ValuePattern 绕开按键过滤），
且 \`key/type\` 写完会**回读校验**，值没进去直接 \`ok:false\`（不再假成功）。

**凭据**：用 \`${cred:name}\` 占位符，驱动进程从自己的环境变量 \`DSH_CRED_name\` 展开，
密码不经过模型上下文、不落证据；密码/验证码类控件的值在 read/state 里只回长度（\`<secret:12chars>\`）。

**硬护栏（驱动层强制，不是提示词）**：买入/卖出/下单/委托/支付/提现/申购/赎回类控件一律拒绝，
\`allowSideEffects=true\` 也解锁不了；副作用超时返回 \`unknown\` 且绝不重放。

**视觉闭环**：主模型不读图也能视觉复核——截图 → 插件内置视觉模型（复用 \`describe-image\` 配置）描述界面，
或截图复制到 \`<workspace>/.dsh-ui-evidence/\` 后用 \`describe_image\` 深度复核。

**Web 路由**（仅回环 127.0.0.1）：

- \`GET  /api/dsh-ui-drive/status\` — 插件/客户端状态
- \`GET  /api/dsh-ui-drive/evidence\` — 证据目录列表
- \`GET  /api/dsh-ui-drive/evidence/{id}\` — 某次自验的 steps.json
- \`GET  /api/dsh-ui-drive/evidence/{id}/files/{file}\` — 截图/日志原文
- \`POST /api/dsh-ui-drive/shot\` — 立即截图直出 PNG

## 安全边界

- 点击/输入 = 真实操作，可能落库
- 插件硬护栏：click / setvalue / key / type / drag 必须显式 \`allowSideEffects=true\` 才执行
- **驱动层硬拒绝**：买入/卖出/下单/委托/支付/提现/申购/赎回类控件（按控件名/AutomationId 匹配），传 true 也点不动
- **输入回读校验**：key/type/setvalue 写完回读控件真实值，不一致即 \`ok:false\`（防「假成功」）
- **凭据不落地**：\`${cred:name}\` 占位符 + 密码/验证码控件值只回长度；敏感值在输出/证据里打码
- **超时不重放**：副作用动作在常驻进程超时时返回 \`unknown\`，绝不自动重试（避免点两次/输两次）
- 软约束（systemPrompt 公告）：「保存/删除/清空/导出」点击前报按钮名给用户确认；
  「下单/交易」类入口一律不点；优先只读验证；定位卡住三步即停，不盲点轰炸

## 环境变量

| 项目 | 说明 |
| --- | --- |
| \`DSH_UI_PROC_NAME\` | 目标客户端进程名（如 \`MyClient\`），必配 |
| \`DSH_UI_WINDOW_NAME\` | 主窗口标题，必配 |
| \`DSH_UI_CLIENT_EXE\` | 客户端 exe 绝对路径（ui_launch 用），必配 |
| \`DSH_UI_EVIDENCE_DIR\` | 证据目录，默认 \`~/.dsh-agent-toolchain/ui-evidence\` |
| \`DSH_SNOOP_DIR\` | Snoop 注入器目录（ui_tree 探针用），必配 |
| \`DSH_UI_POWERSHELL\` | PowerShell 路径，默认 Windows PowerShell 5.1 |

## 安装

\`~/.dsh/profiles/web/cordis.patch.yml\` 追加：

\`\`\`yaml
- insert:
    - id: ui-drive
      name: './plugins/dsh-ui-drive/index.js'
\`\`\`

重启 DSH 生效。

## 实时性（2026-09 优化）

UI 驱动最早的瓶颈是「每个动作新起一个 PowerShell 进程」：进程启动 + 脚本解析 +
5 个 UIA 程序集加载 = 每步 ~900ms 固定成本，10 步的自验流程就要等 9 秒，
控件点击根本谈不上「实时」。现在分三层消除这份成本：

| 路径 | 做法 | 实测（本机，13 步流程 / 单动作） |
| --- | --- | --- |
| `ui_flow` 批量执行 | 整个步骤序列交给一个进程（`ui-drive-batch.ps1`），程序集只加载一次、主窗口只解析一次 | 13 步 **11.9s → 1.6s**（7.6x，~120ms/步） |
| `ui_drive` 常驻进程 | 插件内维护一个 serve 模式 PowerShell（`-Serve`，stdin/stdout JSON 协议），启动成本只付一次 | 单动作 p50 **886ms → 30ms**（~30x） |
| `ui_status` 快路径 | `-Status` 模式不加载 UIA，只用 Win32 取主窗口句柄/矩形 | ~1000ms → **~400ms** |

其他配套改动：

- 默认 `waitMs` 1200 → 250ms；`find`/`read`/`shot`/`expect` 步不再做无意义静默等待
- `find` 改用 UIA 原生 `FindAll` + `AndCondition`，不再手写遍历整棵树的循环
- 常驻进程空闲超时自动退出（`DSH_UI_SERVE_IDLE_MS`，默认 5 分钟），插件卸载时回收
- `DSH_UI_SERVE=0` 可关闭常驻进程，退回一次性进程路径（排查用）

## 实现

- `index.js` — host 插件入口：工具注册 + systemPrompt 公告 + 证据路由
- `lib/driver.mjs` — PowerShell 进程封装（常驻进程协议、批量执行、超时、杀进程树、输出解析）
- `lib/vision.mjs` — 界面截图视觉描述（复用 describe-image 配置）
- `scripts/ui-drive.ps1` — UIA 单步驱动（find/click/setvalue/key/read/shot/status）
- `scripts/ui-drive-batch.ps1` — 批量执行（`-StepsFile`）+ 常驻进程（`-Serve`）+ 快路径状态（`-Status`）
- `scripts/ui-probe.ps1` + `probe/UiProbe.cs` — 进程内只读视觉树探针（复用 Snoop 注入器）
- `test/flow-batch.test.mjs` — 批量引擎离线单测（护栏、降级、步骤文件规则）

## 环境变量（补充）

| 项目 | 说明 |
| --- | --- |
| `DSH_UI_SERVE` | `0` 关闭常驻进程（默认开启） |
| `DSH_UI_SERVE_IDLE_MS` | 常驻进程空闲回收毫秒，默认 300000 |
