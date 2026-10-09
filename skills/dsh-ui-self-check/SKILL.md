---
name: dsh-ui-self-check
description: 驱动正在运行的 Windows 桌面客户端做自验：ui_observe 观察 → ui_act 操作 → 读回 → 截图留证，包括 allowSideEffects 授权与 snapshotId 新鲜度门的正确用法、固定流程 ui_flow 与回放。Use when you need to click or type in the real desktop app, read what is on screen, or verify a UI change end to end. Triggers：点一下、看看界面、UI 自测、操作客户端、截图看看、界面有没有变。
---

# 桌面 UI 自验

## 先确认目标

- `ui_status` 看进程和窗口；没在运行就 `ui_launch`（已运行会直接返回现有进程）。
- 会话开始时如果提示"目标进程与当前仓库不一致"，先问用户再动手——UI 工具作用在配置的那个进程上。

## 循环：观察 → 决定 → 动作 → 再观察

1. `ui_observe(action=state)`：拿到可交互控件（`#index`、AutomationId、输入框的真实值）和 `snapshotId`。
2. 定位优先级：AutomationId > Name > `match` 正则 > `index`；同名多个时用 `inAid` / `inName` 限定容器。
3. 动作用 `ui_act`（或 `ui_drive`）：
   - 必须 `allowSideEffects=true`，并带上一步拿到的 `snapshotId`。界面在你读完之后刷新过，动作会被拒（staleSnapshot）——这是保护，重新 observe 就行，别去掉 snapshotId 硬点。
   - `setvalue` 适合有按键过滤的输入框；`type` 支持 `{ENTER}` / `{TAB}`；`pattern` 调用控件真正暴露的 UIA 模式（Expand / Toggle / Select …）。
4. 读回：`ui_observe(read / expecttext / waitfor)` 确认结果真的出现；需要证据时 `shot` 截图。

## 固定流程

- 步骤确定、中途不需要看画面做判断：`ui_flow`（一个进程跑完、带断言、产出 `replay.json`）。
- 后续动作取决于画面的：分步做，不要盲目预排。
- `ui_replay` 回放已有录制，会重新核对目标进程和授权。
- 需要连续看界面变化：`ui_live`（后台抓帧，不抢前台）。

## 安全

- `ui_status.controlPolicy` 显示可选控件策略状态；`control_policy_invalid` 时先修策略，不执行副作用。
- `control_denied` 按实际控件名称、AutomationId 和祖先容器判定，遵循返回的 reason / alternative；换定位参数不能绕过。
- flow / replay 在首步前预检全部目标；后续才出现的控件应拆成观察后逐步操作。坐标动作无法按控件名匹配。

- **下单、提交、删除、转账、发送**这类不可逆按钮：先向用户确认，再点。
- 焦点在密码 / 验证码 / token 框时，截图描述默认被拒；除非用户确认画面没有敏感内容，否则别用 `allowSensitive` 绕过。
- 动作超时后驱动不会重试：先用 find / read 复核状态，再决定是否重发。
- 定位连续失败三次就停下汇报，别盲试。
