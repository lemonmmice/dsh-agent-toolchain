# Jev UI 控制

`ui_jev` 把 Jev 放在 UI 驱动的“决策层”，不把它当成能直接点击桌面的聊天模型：

1. 读取当前客户端的 UIA 状态和可操作控件。
2. 生成有限的候选动作（点击、写入已提供的值、上下滚动、完成、暂缓）。
3. 把脱敏后的状态和候选动作发送给 Jev，Jev 只返回一个候选 ID。
4. 由现有 `dsh-ui-drive` 执行该动作，并继续检查 `allowSideEffects`、`snapshotId`、应用授权、急停和策略表。
5. 读取新状态，重复上述过程，直到完成、低置信度、歧义或达到步数上限。

这对应 TypeSafe 官方推荐的模式：代码拥有控制流和副作用，Jev 只回答窄范围的类型化问题。Jev 不读截图、不生成任意文本输入，也不会绕过 UI 授权。

## MCP 示例

先用 dry-run 查看 Jev 会选择什么，不执行点击：

```json
{
  "goal": "刷新新闻列表",
  "allowRemoteData": true,
  "allowSideEffects": false
}
```

确认目标后才执行：

```json
{
  "goal": "刷新新闻列表",
  "allowRemoteData": true,
  "allowSideEffects": true,
  "confidenceThreshold": 0.85,
  "maxSteps": 6
}
```

如果目标需要输入值，值由调用方提供，Jev 只选择输入控件：

```json
{
  "goal": "在股票搜索框中输入 600519",
  "inputValue": "600519",
  "allowRemoteData": true,
  "allowSideEffects": true
}
```

`inputValue` 不会发送给 Jev 的 state；输入动作仍由 UIA 的 `setvalue` 执行并回读校验。密码、验证码、token 和客户数据不应放入远程 state；不确定时保持 `allowRemoteData=false`。

## 限制

- UIA 没有暴露稳定控件的画面仍需现有视觉兜底；Jev 本身不理解像素。
- 低于 `confidenceThreshold`、选择 `defer`、动作超时或结果未知时立即停止，不自动重试。
- `allowRemoteData=true` 只代表允许发送脱敏 UI 状态，不代表允许执行动作。
- `allowSideEffects=true` 仍不能绕过应用授权、急停、deny 策略或快照新鲜度。

## 动作前的两道门（都在**执行之前**拒绝，动作一次都不执行）

`ui_jev` 的节奏是「观察 → 决策 1~2 s → 动作」，而动作自己还要解析约 0.9~2.2 s。
这 3~4 s 里界面可能已经变了，而解析只按 name/aid 找，**分辨不出"同名同 aid 但已不是同一个控件"**。
所以两道门并进了那一次调用（省掉一整轮扫描，且比"先查后点"更安全 —— 判定与执行之间不会被插队）：

- `requireUnique`：要求**恰好 1 个**匹配；0 个或多个都拒（`ambiguous=true`，带 `count`）。
  返回里的停止原因是 `target_not_unique`。
- `expectedRect` + `expectedWindowHandle`：窗口句柄不同直接拒；元素**位移超过自身边长**也拒
  （判据刻意宽松，只抓"真的换了东西"，不抓 1 px 抖动）。返回 `drift=true` 与 `movedBy`/`rect`，
  停止原因是 `target_drifted`。

两个字段都由 `ui_jev` 显式传入 ⇒ **其它调用方零回归**（没有任何既有调用方设置它们）。

## 实测（2026-09-23，单机；复跑见下）

- **每步耗时与页面强相关**：整窗 `state` 实测 2.4~6.6 s（元素数 1214~2799），定向查找 0.85~2.2 s，
  Jev 决策 1.09~1.58 s。所以别引用单一数字，**先量当前页面**。
- **菜单展开不产生新窗口**（已验证）：顶层窗口始终只有主窗口一个，弹出的子菜单是主窗口树里的
  **嵌套 MenuItem**，同一个 `winHandle` 就能读到 ⇒ 单窗口假设成立。
  复跑：`pattern Expand` 展开菜单 → `ui_windows` → `pattern Collapse` 收起。
- **`unlocatable` 要看清**：本机一页 252 个交互控件里有 **40 个既无 name 也无 aid** ⇒ 永远进不了
  候选集。`ui_jev` 每次返回都带这个数 —— 它是"我够不到"，不是"界面上没有"。同样如实回报 `skipped`。

### 试过并且**不成立**的省时路子（别再试）

- **缩小 `max` / `maxControls`**：`state` 的成本与 `max` 几乎无关（40 行也要 5.4 s）——
  贵在**走完整棵树**，不在返回多少行。
- **给 `FindAll` 加条件**（类型白名单 / 控件视图）与 **`CacheRequest`**：实测 0.93~1.03×，
  `CacheRequest` 更慢（5.0 s vs 4.8 s）且控件数对不上（414 vs 254）。
- **用 `inAid`/`inName` 限定观察范围**：子树枚举确实与规模成正比（47 元素 **152 ms** vs 整窗 **5852 ms**），
  但**便宜的小子树恰好全是匿名的**（`aid=(无 aid)`），唯一可寻址的容器装着 **88%** 的树 ⇒
  在这类客户端上落不了地。要复跑：`scripts/uia-enum-probe.ps1`。
- **去掉动作里那次解析**：`AutomationElement` **不能跨进程传递**，执行器必须自己定位；
  任何 `Descendants` 查找都要付一次 provider 遍历。唯一可行方向是**常驻进程侧缓存元素引用**（尚未实现）。

### 复跑用到的脚本

```
node scripts/bench-jev-ui.mjs --repeat 4            # 每步分段时间归因（status/state/find）
node scripts/bench-jev-ui.mjs --jev-only --repeat 5 # 只量远端决策往返
node scripts/jev-ui-verify.mjs --gate               # 真机验证两道门（只会跑零风险探针）
node scripts/jev-ui-verify.mjs --dry "<目标>"        # 真 Jev 跑一个决策周期，不执行动作
pwsh -File scripts/uia-enum-probe.ps1 -ProcName <进程名> -WindowName <窗口名>   # 枚举成本归因
```

`--dry` 与 `--gate` 都不会产生副作用：`--dry` 用 `allowSideEffects=false`；`--gate` 的探针
刻意选成"门即使失效也点不到东西"（0 匹配的目标、或注定失败且无副作用的 `pattern`）。
