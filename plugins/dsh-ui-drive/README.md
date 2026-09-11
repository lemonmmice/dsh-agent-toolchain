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
| \`ui_live\` | **实时看见（agent 专用）**：\`action=start\|stop\|status\|frame\|wait\` 后台循环抓「窗口内容」帧（默认 1500ms，不抢前台、不恢复最小化）；\`frame\` 返回 latest.png 路径 + 帧 hash + 控件状态摘要，\`wait\` 可阻塞等画面变化；敏感帧（焦点=密码/验证码）默认不出 path（\`allowSensitive=true\` 才给） |

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
| `DSH_UI_LIVE_DIR` | `ui_live` 帧目录，默认 `~/.dsh-agent-toolchain/ui-live`（可指向大盘/独立卷） |
| `DSH_UI_LOCK` | 客户端进程级锁开关，`0` 关闭（默认开启，防多 agent 同时驱动同一客户端） |
| `DSH_UI_LOCK_STALE_MS` | 锁的过期毫秒（持有者崩溃后自动失效），默认 120000 |
| `DSH_UI_LOCK_WAIT_MS` | 抢锁等待上限毫秒，默认 30000 |

## 行为变更与修复（2026-09-10）

本轮回灌把长期只存在于本机运行副本里的修复同步进仓库，逐条如下：

1. **`read` 不再偶发返回 0 行（可靠性根因修复）**
   `Get-ControlTypeName` 原先直接 `$el.Current.ControlType.ProgrammaticName.Replace(...)`：
   界面重绘/切页瞬间 UIA 会枚举到 `ControlType=null` 的**瞬时元素**，`.Replace()` 打在 null 上抛
   「不能对 Null 值表达式调用方法」，**整次枚举崩掉 → 0 行**（会被误读成「客户端没响应」）。
   现在：该函数全程 try/catch 降级为 `Unknown`；`read` 分支逐元素 try/catch 并缓存 `$cur` 快照；
   带 `match` 却读到 0 行时自动重试一次（返回字段新增 `attempts`）。
2. **`read` 输出新增 `help="…"` 与控件尺寸 `WxH`，且 `match` 同时命中 Name 与 HelpText**
   WPF 在 `AutomationProperties.HelpText` 为空时会回落 `ToolTip`，所以只显示图标的按钮
   （Name 为空、语义只在 ToolTip）现在可以直接按 help 读到。**注意**：`click`/`find` 的 `match`
   目前仍只匹配 Name（见下「已知缺口」）。
3. **只读动作不再改变窗口状态**
   旧实现每次调用都无条件 `ShowWindow(hwnd, SW_RESTORE)`：对已最大化窗口等价于「还原成浮窗」
   （用户肉眼可见，也是坐标漂移的根因）。现在用 `IsIconic` 门控：只有真的最小化才恢复；
   只有输入/截图类动作才抢前台。
4. **截图只写证据目录**
   `shot`/`capture` 一律写 `DSH_UI_EVIDENCE_DIR`（默认 `~/.dsh-agent-toolchain/ui-evidence`），
   不再往 workspace/仓库复制副本——仓库只放代码证据。
5. **新增 `ui_live` 模块**（`lib/live.mjs`）
   后台循环抓帧 + `wait` 等变化；`warmSend` 的 `killOnTimeout=false` 语义保证后台循环超时
   不会误杀常驻进程；插件卸载时先停 live 循环再回收常驻进程（顺序固定，避免双 timer/孤儿进程）。

### 2026-09-10 第二批修复

- **`click`/`find`/`waitfor` 的 `match` 现在同时匹配 Name 与 HelpText**（新增 `Test-MatchText` 助手，
  逐元素 try/catch 保护）→ 空 Name、语义只在 ToolTip 的图标按钮（放大/缩小/筹码…）现在可以直接
  `click match="放大"`，不必再退化成坐标点击。
- **工具层补齐坐标类动作文档**：`ui_drive`/`ui_act` 现列出 `clickat`/`doubleclick`/`move`/`wheel`，
  `ui_observe` 列出 `move`/`wheel`/`capture`/`state-live`。此前脚本层已支持这些动作，但工具描述里
  没写，agent 无从知道，只能绕到自带 harness 里发坐标点击——这是「能用但没人知道」型的缺口。
  文档同时标注：坐标类动作**脆弱**（窗口一移动就失效），优先用 `find`/`click` + `match`。

### 2026-09-10 第三批修复：观测完整性必须报数（B-1）

**问题**：上一批把 `read` 的假空真凶（`Get-ControlTypeName` 在 `ControlType=null` 上抛异常 → 整次枚举
崩成 0 行）改成了逐元素 `try/catch` + `continue`。但**静默 `continue` 是新一轮假空**：调用方拿到一份
「变少了的控件清单」，却不知道少了几行、为什么少 —— 「观测不完整」和「界面真的没有」分不开。

**现在**：

- `read` / `state` 结果**恒带 `skipped=N`**：本次枚举里「读不到元素状态」而被跳过的数量
  （元素失效 `Item` 抛异常 / `Current` 抛异常 / 元素与状态为 null）。
  类型白名单、`IsOffscreen`、`match` 过滤、同名去重这些**正常过滤一律不计数**——报数只报真正的观测失败。
- `skipped > 0` 时同结果附带 `warn`（`⚠ 跳过 N 个读不到状态的元素，本次清单不完整（原因…）——不要把
  「没读到」当成「界面上没有」），由 `lib/render.mjs` 渲染进 `ui_drive`/`ui_observe`/`ui_state` 的可见文本；
  `ui_flow` 的每一步 transcript 同样带 `skipped`/`warn`，步进日志会打印「（跳过 N 个…）」。
- `skipped=null` = 该路径**没有回报**（未知），**不等于 0**：绝不把「不知道」伪装成「观测完整」。
- **`state` 路径顺带补齐逐元素容错**：`Get-InteractiveLines` 原先裸取 `$el.Current`，界面重绘瞬间会被
  单个坏元素打断成 0 行（与 `read` 那处根因同源）。现在同样逐元素容错并计 skipped。
- **一次性回退脚本 `ui-drive.ps1` 的 `read` 同步修**：它的 `Current.ControlType.ProgrammaticName.Replace(...)`
  还是旧写法（同样能崩成 0 行），现在逐元素容错并输出协议行 `SKIPPED <n>`（+ 最多一条 `SKIPREASON <text>`），
  driver 侧解析成 `skipped`/`skippedReasons`。
- 渲染层（`renderDrive`/`renderState`）抽到 `lib/render.mjs`：渲染文本是 agent 唯一看得见的契约，必须能离线单测
  （`index.js` 依赖宿主 `@deepseek-ai/dsh-tools`，普通 node 进程 import 不到）。顺带修好
  `ui_observe(action=state)` 过去因 `renderDrive` 没有 `state` 分支而回落成「完成」不显示清单的问题。

**单测**：`test/read-skips.test.mjs`（离线，不需要客户端/不启动 PowerShell，已进 CI 11 → 12 道闸门），
覆盖「报数 / 零值不误报 / 未回报为 null / flow 每步透传 / 渲染可见 / 回退脚本 SKIPPED 协议行」21 项断言。

**现场验证**（脚本层真路径，非单测）：`test/read-skips-live.ps1` 起一个自建 WPF 窗口，分两阶段跑
`scripts/ui-drive-batch.ps1` 的 `read`/`state`：

- **阶段 A（窗口静止）**：清单必须非空（`count>0`）——证明正常路径没被改坏、`skipped` 不是假警报；
- **阶段 B（窗口高频变动：虚拟化列表滚动 + 尾部控件拆建）**：必须回报 `skipped>=1`，
  并给出原因（实测最稳定的瞬态形态是「整次枚举失败：目标元素的对应 UI 不再可用」）——
  这正是 B-1 的核心：**读不到的元素要报数**，而不是静默少几行；
- 任何一轮 `ok!=true` 都算失败（异常必须显式暴露，不能被当成「界面为空」）。

用法：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File test\read-skips-live.ps1
# 退出码 0 = 两阶段都通过；1 = 条件未满足；2 = 环境问题（窗口起不来）
```

> 实测记录（2026-09-10 夜）：阶段 A `count=320`；阶段 B 3/8 轮 `skipped=1`（含原因），无异常轮。

### 2026-09-11 补完 B-1 的另一半：0 行必须永远有解释（空枚举）

**问题**（2026-09-11 上午实测，用自建重绘窗口压 `read`/`state`）：UIA 在界面重绘/最小化瞬间
**会返回空集合**——`FindAll(Descendants)` 连续 4 次返回 **0 个元素**，**既不抛异常、也没有元素被过滤**。
旧实现于是回报「读到 0 个控件」，调用方只能读成「界面上没有控件」——**这正是摩擦清单 #1
「read 偶发返回 0 行，把整晚判据都污染了」的真身之一**：`skipped` 只覆盖异常路径，覆盖不到这种静默空。

**现在**：

- `read`/`state` 新增 **`scanned=`**（本次枚举扫到多少个元素）与 **`offscreen=`**（其中因不可见被过滤的数量）。
  于是「0 行」永远解释得清：`scanned=0` = 这次没看到；`scanned>0 且 offscreen=scanned` = 元素在但都不可见；
  `skipped>0` = 有元素读不到状态。
- **枚举为 0 时自动重试**（最多 3 次、间隔 200ms）：重绘通常一两帧就恢复，重试把假空消灭在源头；
  带 `match` 却 0 行的旧重试逻辑保留。
- 重试后仍是 0 元素 → driver 生成 warn：
  `⚠ 本次枚举返回 0 个元素（UIA 给了空集合，通常是界面正在重绘或窗口刚切换）：这不等于「界面上没有控件」…`。
- 现场验证脚本新增**硬判据**：任何一轮只要 `count=0`，必须满足「有 skipped / scanned=0 / offscreen>0」之一，
  否则记为 `unexplainedRounds` 并判失败——**静默 0 行不再可能蒙混过关**。

### 2026-09-10 第四批修复：重启类调用不再挂死（B-2）

**问题**：昨夜整晚卡在「客户端重启调用」里 **2.5 小时**，只靠日志时间戳才发现。根因形态是：
常驻进程**不会退出、也不会报错**，只是把请求吞掉 —— 只看退出码的看门狗等于没有看门狗。

**现在**：

- **僵死看门狗（定位已澄清，见 2026-09-11 复核节）**：判据是「**最近一次成功响应的时间**」
  （`warm.lastOkAt` 由每个成功响应刷新），不是退出码；阈值取
  **`max(DSH_UI_STALL_MS, 最老排队请求自己的超时)`** —— 它只可能比请求自己的超时**更晚**动手。
  也就是说：**卡住请求的主防线是「请求自身超时 + 只读重试」**，看门狗是「Node 侧定时器丢失」时的兜底，
  并对外提供诊断（`stalls` / `lastStallReason` / `lateResponses`）。之所以不保留「固定阈值抢杀」，
  是因为复核指出那会误杀合法长动作（例如调用方给了 180s 超时的截图）。
- **失败重试（只读动作）**：`read`/`find`/`state`/`windows` 等只读动作超时后**自动重试一次**
  （新进程 + ready 握手 + 重新解析窗口）；**只有重试这一腿**受 20s 上限约束，整次调用最坏
  仍是「首次超时（默认 90s）+ 握手（≤15s）+ 重试（≤20s）」。只读重放无副作用，重试是安全的。
- **副作用动作绝不重放**：`click`/`setvalue`/`key`/`type`/`drag` 在看门狗重启或请求超时时，
  一律返回 `{ok:false, unknown:true}` 并提示「先复核控件状态再决定」，绝不走回退路径重跑。
- **`status` 超时 ≠ 未运行**：状态查询超时改为返回 `{running:false, unknown:true, error:'status 超时…'}`，
  `ui_status` 渲染成「客户端状态未知」——把「查询卡住」误报成「客户端没起来」会导致反复重启客户端（踩过）。
- **启动/重启调用有硬上限**：`ui_launch` 的整段调用受 `waitMs` 硬上限约束（最小 3s），
  **每次轮询都把剩余预算传给 `status()`**，任何一次卡住的状态查询都拖不垮整个调用；
  返回里带 `polls`/`statusTimeouts` 心跳，便于区分「客户端真没起来」与「轮询自身被拖慢」。
- 诊断出口：`warmStatus()` 现在带 `lastOkAt` / `stalls` / `lastStallAt` / `lastStallReason`。

**环境变量**：`DSH_UI_STALL_MS`（僵死判定阈值，默认 90000ms）。

**单测**：`test/restart-watchdog.test.mjs`（离线，假 serve 进程模拟「活着但不回请求」），
15 项断言覆盖「看门狗判僵死 + 只读重试 + 副作用不重放 + status 未知语义 + launch 硬上限」。

### 2026-09-11 跨模型独立复核修正（Codex + Claude 各出一份报告）

两份独立复核报告（`reviews/review-codex-20260911.md` / `reviews/review-claude-20260911.md`，
存于本机工作区、不随仓库分发）
对 `354d65f`/`a8adb6f`/`7d03bef` 做只读复核后，确认成立并已修的项：

1. **`truncated` 硬编码 `false`**（两方都判「对调用方撒谎」）→ 如实透传 `res.truncated`，
   并在截断时补 `returned=`（实际返回行数）。补了零覆盖的单测。
2. **看门狗固定阈值会误杀合法长动作** → 阈值改为 `max(DSH_UI_STALL_MS, 最老请求自身超时)`；
   同时把 README/注释里「看门狗判僵死」的定位改准（主防线是请求超时 + 重试）。
3. **`launch` 的 `Math.max(3000, waitMs)` 覆盖调用方显式值** → 改为只挡非法值（≤0/NaN），下限 500ms；
   显式 `waitMs=1000` 现在就是 1s（有单测）。
4. **read 的 `$cur.*` 属性访问未全包 try/catch**（异常会整步失败而不是记 skipped）→ 逐元素函数体
   全包 try/catch，异常计入 `skipped` 并带原因；与 `state` 路径口径一致。
5. **空枚举修复在**一次性回退路径（`DSH_UI_SERVE=0`）**缺失**（Claude 的 N3）→ `ui-drive.ps1` 的 read
   补齐「缓冲输出 + 空枚举重试 ≤3 次 + 回报 `SCANNED n`」，driver 侧解析 `SCANNED` → 回退路径
   同样会给出空枚举 warn（补了单测）。
6. **两条路径对同一坏元素口径不一**（Claude 的 N4）→ `ControlType` 为 null 的瞬时元素在两条路径
   都按「类型未知 → 白名单过滤」处理，**不计 skipped**。
7. **重试的 `killOnTimeout` 与首次不一致** → 重试保持与首次相同的 `killOnTimeout`（避免把
   「宁可放弃这一帧也不杀进程」偷偷变成「延迟若干秒后照杀」）。
8. **注释把「重试腿 20s」写成「总时长 20s」**（Claude 的 N2）→ 措辞改正，并把「整次调用最坏时长」
   的构成写清。

复核中**未被采纳**的两条（附我的反证）：

- Codex「`/T` 会连带杀 MSBuild/驱动」：Claude 给出反证并被我核实 —— `killClientProcess` 在
  MSBuild `spawn` **之前** `await` 完成，且 MSBuild / UI 驱动 PowerShell 都不是客户端的子进程，
  `/T` 够不到它们。红线命中点只有「按镜像名误杀同名实例」这一条（已修）。
- Claude 的 N1「`capture` 会走 warm 路径并被重试破坏 `killOnTimeout:false` 护栏」：**路径不成立** ——
  `capture` 在 `BATCH_ONLY_ACTIONS` 里（`lib/driver.mjs`），根本不走 warm 路径（实测 `seq` 不增长、
  结果来自批量路径）。不过该条促成的第 7 项修正仍然保留（万一路由变化也不会踩）。

### 已知缺口（尚未修复，欢迎 PR）

- 证据目录无按会话聚合与上限，长跑会堆积大量时间戳目录。
- `read`/`state` 的 `skipped` 只在批量/常驻引擎路径有值；一次性回退路径解析老脚本时可能为 `null`（未知）。
