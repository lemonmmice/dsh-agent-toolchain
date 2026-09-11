# UI 驱动的安全边界矩阵（dsh-ui-drive）

> 目的：一页看清"**哪些边界真的实现了、拿什么证明、哪些没覆盖**"。
> 判据：每一行都要能追到一份可运行的测试或一个明确标注的取舍；**没有证据的行不得写成"已实现"**。
>
> 对照依据：Codex 的 CUA/Guardian 机制调研（见仓库外调研记录），
> 采纳的核心思想是"**策略与执行分离** + **证据有界且绝不静默截断** + **未知一律按危险处理**"。

---

## 1. 三道门的顺序（唯一写侧单点）

```
动作
 └─ classifyAction(action) ── read/input ──▶ 直接放行（不进门）
                             └─ effect/coord-effect
                                 └─ 门 1：allowSideEffects === true
                                     └─ 门 2：新鲜度（snapshotId：seq ∧ gen ∧ windowHandle）
                                         └─ 门 3：policy（规则表 deny-first）+ 急停（全局总闸）
                                             └─ 执行
```

- **单点**：单步动作在 `checkSideEffectGate`；序列驱动（flow）在 flow 开头**逐步**判定后整段执行/整段拒绝。
- **未知动作按副作用**（`classifyAction` 默认 `effect`）——不靠动作名推断"只读"。

---

## 2. 边界矩阵

| # | 边界 | 状态 | 证据（可运行） | 限制 / 未覆盖 |
|---|---|---|---|---|
| 1 | 「按名硬拒」名单（驱动层，与授权无关；名单可用 `DSH_UI_DENY_RE` 覆盖） | ✅ 已实现 | `test/deny-choke-point.test.mjs`（27 断言） | 按**控件名/AutomationId**匹配；坐标动作无名，由 4/5 兜 |
| 2 | 硬拒下沉到**每个致效汇聚点**（点击/双击/写值/键盘/输入） | ✅ 已实现 | 同上（结构不变量：五个函数入口都必须有守卫） | 新增致效路径时须同步加守卫，测试会打红 |
| 3 | `allowSideEffects` 门（含坐标动作 `clickat`/`drag`/`doubleclick`） | ✅ 已实现 | `test/deny-choke-point.test.mjs` | 传 `allowSideEffects` 只过一次门，不等于任何授权 |
| 4 | 快照新鲜度门（`seq ∧ gen ∧ windowHandle`，opt-in） | ✅ 已实现 | `test/read-diff.test.mjs` | **不传 snapshotId 则放行**（零回归）；跨窗口合法复用未覆盖（落安全侧，多拒→重读） |
| 5 | 逐窗分桶（消除跨窗口 false-stale） | ⬜ 未实现（v2） | — | 现为全局 seq；代价是"读了弹窗后仍用主窗旧快照"会被拒 |
| 6 | policy 规则表（按规范化 exe 路径 + 可选窗口/aid）deny-first | ✅ 已实现 | `test/policy.test.mjs`（四份反事实矩阵 + 执行器计数） | **未配置时门视为未启用**（见 §4 取舍）；规则冲突一律拒（**无特异性排序**，见 §4） |
| 7 | 急停全局总闸（哨兵文件在盘上 → 任何 session 任何路径都拒） | ✅ 已实现 | `test/estop.test.mjs`（跨 session/无 session/模型参数不可复位） | 复位需**显式调用**且限定会话；删文件**不构成**复位 |
| 8 | 序列驱动（flow）不绕过 policy/急停；逐步判定 | ✅ 已实现 | `test/policy-gate-e2e.test.mjs`（含"第一步获准、第二步该拒"用例） | flow **无逐步新鲜度门**（预排序列没有逐步 snapshotId），列 v2 |
| 9 | 执行器调用计数可证（"没被执行"可数） | ✅ 已实现 | `test/policy-gate-e2e.test.mjs` 哨兵文件 + 两条自检对照组 | 哨兵计"进程被调用次数"，**不区分是哪一步** |
| 10 | 审查证据包（版本化/定长/可哈希） | ✅ 已实现 | `test/evidence.test.mjs`（33 断言）+ `test/policy-gate-e2e.test.mjs`（接线） | 界面快照本身未入包（只留指纹字段，尚未填充） |
| 11 | 裁剪记账、required 超限即失败（绝不静默截断） | ✅ 已实现 | `test/evidence.test.mjs` | — |
| 12 | 凭据不进模型、且不进证据 | ✅ 已实现 | `test/policy-gate-e2e.test.mjs`（`[redacted]` 断言） | 非占位符形式的明文值不在保护范围（调用方须用占位符） |
| 13 | 观测完整性（`skipped/scanned/offscreen`，空枚举重试） | ✅ 已实现 | `test/read-skips.test.mjs`（34 断言） | — |
| 14 | 观测增量（`read(diff=true)`），不完整读抑制 diff | ✅ 已实现 | `test/read-diff.test.mjs` | **opt-in**，非默认；"默认开"未做 |
| 15 | 输入原语：`pattern`（调用元素真实暴露的 pattern）/ `scroll`（语义滚动）/ `selecttext`（精确选区） | ✅ 已实现并放行 | `test/input-primitives.test.mjs`（35 断言） | 元素不支持该 pattern 时**明确报错**，不回退成盲点击 |
| 16 | 剪贴板不被破坏（中文输入/paste 用完还原） | ✅ 已实现 | `test/clipboard-restore.test.mjs`（真机往返） | 非文本剪贴板（图片/文件）**不碰**（无法保证还原） |
| 17 | Browser / Tab 一等公民（同一 Target 接口） | ⬜ **明确未覆盖** | — | 我方目标为 WPF 应用；Web 内容需另走调试端口，不在本插件范围 |
| 18 | 动作后自动 settle（内部等待，禁止模型 sleep） | ⬜ 未实现 | — | 现由 `waitFor`（可断言 appear/gone/enabled/disabled）+ `waitMs` 承担 |
| 19 | 观察即输出默认开（`observe`） | ⬜ 未实现（仍是显式开关） | — | — |
| 20 | 审查者（第二个模型）自动裁决 | ⬜ 未实现（**刻意不做**） | — | 可执行的安全边界不依赖另一个模型的可用性；策略文本只作解释 |

**状态约定**：✅ 已实现且有可运行证据；⬜ 未实现或明确未覆盖。任何"✅"都必须能在上表右列找到测试。

---

## 3. 未覆盖项（明确声明，别当成已覆盖）

1. **浏览器 / 内嵌 Web 内容**：不在本插件范围。
2. **flow 的逐步新鲜度**：flow 是预排序列，没有逐步 `snapshotId`；只有"整段过门"。
3. **规则特异性**：`allow exe` + `deny aid=x` 会命中两条相反规则 → 判为 `policy_conflict`（偏安全），
   但"宽 allow + 窄 deny"这种自然写法**当前用不了**。
4. **规则按 aid 时的"实际目标"复核**：门用的是**调用方传入**的 `aid`，未在解析出真实控件后复核；
   "点 A 控件却传 B 的 aid"门看不出来。
5. **坐标动作的语义授权**：`clickat`/`drag` 无名，只能靠 `allowSideEffects` + 快照门 + 急停；
   **不提供**"这个坐标是安全的"这种判断。
6. **`move`/`wheel` 不受急停**：归 `input` 类（不改数据），也不进门。
7. **裸引擎 `batch()`**：不过任何门的底层引擎（仅供内部过门之后调用），其定义处已加护栏注释。

---

## 4. 已知取舍（显式记录，不是隐式行为）

| 取舍 | 选择 | 理由 |
|---|---|---|
| 规则表未配置时 | **门视为未启用**（保持既有行为；急停仍然始终生效） | 日常驱动没有策略文件；若"未配置即全拒"则插件不可用。**代价**：未配置的部署没有 per-app 白名单 |
| 规则冲突 | 一律拒绝（`policy_conflict`） | "无证据 ≠ 放行"；特异性排序列后续 |
| 快照门 | opt-in（传了才校验） | 零回归；要求调用方显式绑定"我这次是按哪一版界面在动" |
| 身份缓存 | 30s TTL **且**绑定重启世代（gen） | 身份是授权主键，重启后必须重解析；纯 TTL 会留下"重启后 30s 内用旧身份授权"的窗口 |
| 急停复位 | 显式调用 + 限定会话 | 删哨兵文件**不等于**复位（粘性语义），避免"顺手 rm 一下就当恢复了" |
| 证据写入失败 | 不影响驱动，但结果里带 `evidenceError` | 证据是旁路，不能让它把驱动搞挂；但失败必须可见，不得静默 |

---

## 5. 测试索引（证据从哪来）

| 测试 | 覆盖 |
|---|---|
| `test/deny-choke-point.test.mjs` | 硬拒汇聚点、坐标动作进门、执行器计数 = 0 |
| `test/policy.test.mjs` | 规则表、四份反事实矩阵、身份规范化、软/硬分层、执行器计数（assert 式，23 条） |
| `test/estop.test.mjs` | 急停锁存、跨 session 全网拦截、按会话复位、模型参数不可复位（assert 式） |
| `test/policy-gate-e2e.test.mjs`（57） | **端到端**：驱动全链路 × 哨兵计数（deny/allow/无匹配/冲突/解析失败/急停/flow/逐步判定/身份缓存/新动词/证据接线） |
| `test/evidence.test.mjs` | 证据包：定长、版本、哈希与篡改检测、绝不静默截断、untrusted 标注 |
| `test/read-skips.test.mjs` | 观测完整性（B-1） |
| `test/read-diff.test.mjs`（75） | 分类契约、快照判定矩阵、diff/抑制 |
| `test/input-primitives.test.mjs` | 三个新原语的存在性、安全默认、放行后的硬约束 |
| `test/clipboard-restore.test.mjs`（9） | 剪贴板还原（真机往返） |
| `test/flow-batch.test.mjs` / `test/restart-watchdog.test.mjs` | 序列驱动引擎、常驻进程看门狗 |
| `scripts/check.mjs` | 仓库级门：语法、私有引用、PS1 编码、工具 schema 完整性 |

---
