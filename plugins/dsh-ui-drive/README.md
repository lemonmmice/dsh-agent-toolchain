# dsh-ui-drive

DSH（DeepSeek Harness）的 **UI 自验驱动插件**：通过 Windows UIA 程序化操作正在运行的桌面客户端并截图留证，
支撑「改完代码 → 启动/驱动客户端到目标页面 → 截图 → 视觉复核」的自验闭环。

## 能力

**Agent 工具（host 侧注册）**

| 工具 | 说明 |
| --- | --- |
| \`ui_status\` | 目标客户端进程/主窗口状态（只读） |
| \`ui_launch\` | 启动客户端并等待主窗口；**视觉即返**：完成后自动截图+视觉模型描述界面（返回 \`uiState.description\`） |
| \`ui_drive\` | 单步 UIA 操作：find / read / shot（只读），click / setvalue / key（副作用，需显式 \`allowSideEffects=true\`）；shot 加 \`describe=true\` 直接返回界面描述 |
| \`ui_tree\` | 进程内视觉树 dump（真实类型 + Name + AutomationId + DataContext 类型，只读深查） |
| \`ui_flow\` | 步骤序列自验：find/click/setvalue/key/read/shot/wait/expect 断言，统计 passed/failed，证据落盘 steps.json |

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
- 插件硬护栏：click / setvalue / key 必须显式 \`allowSideEffects=true\` 才执行
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

## 实现

- \`index.js\` — host 插件入口：工具注册 + systemPrompt 公告 + 证据路由
- \`lib/driver.mjs\` — PowerShell 进程封装（spawn/超时/杀进程树/输出解析）
- \`lib/vision.mjs\` — 界面截图视觉描述（复用 describe-image 配置）
- \`scripts/ui-drive.ps1\` — UIA 驱动（find/click/setvalue/key/read/shot/status）
- \`scripts/ui-probe.ps1\` + \`probe/UiProbe.cs\` — 进程内只读视觉树探针（复用 Snoop 注入器）
