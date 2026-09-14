// lib/tool-aliases.mjs — 两面工具名的**显式**别名映射（E4 gate 与参数 gate 共用一份）。
//
// 为什么单独抽出来（不是"文件洁癖"）：
//   `toolface-parity.test.mjs` 里原来把这 5 条**内联**在测试文件里，本轮的参数 gate
//   （`toolface-params.test.mjs`）也需要它。抄第二份的那天起，两份就会开始漂移 ——
//   而"两处实现漂移"正是这份清单里反复抓到的一类错（#38）。所以：**一处定义，两处 import**。
//
// ⚠ 别名机制本身是**有风险的**（@claude r35 构造过它的滥用方式）：
//   只要把任意 MCP-only 工具**映射到对面任一既有工具名**，`onlyMcp` 就空了 ⇒ gate 变绿。
//   也就是说「别名」能把真实的缺失**洗成"已对齐"**。两份 gate 都读 `ALIAS_COUNT_EXPECTED`，
//   条目数被钉死：增删别名必须显式改这个数，逼出一次人工判断。
/** MCP 面名 → DSH 面名。 */
export const ALIASES = {
  // dsh-api-visualizer 的捕获库：MCP 面叫 capture_*（源站/大面上更短），DSH 面叫 api_capture_*
  // （DSH 面还有 ui_* / perf_* 等一族，加前缀避免 capture_* 这种过宽的名字撞车）。
  capture_append: 'api_capture_append',
  capture_query: 'api_capture_query',
  // 2026-09-12（r39，两个 G1 黑盒 agent 独立点名的缺口）：**捕获控制面**补了三个工具。
  // 它们在两面都**必须**存在 —— 补之前，agent 只能自己拼 `/api/dsh-api-visualizer/capture/start` 的 URL，
  // 而工具目录里连 host/port 都没有。两侧同一套命名规则（MCP 短名 / DSH 加 api_ 前缀），
  // 理由同上一条别名，属于同一族，不是"把缺失洗成已对齐"。
  capture_start: 'api_capture_start',
  capture_status: 'api_capture_status',
  capture_stop: 'api_capture_stop',
}

/** 别名条目数**钉死**（绊线，不是证明）。 */
export const ALIAS_COUNT_EXPECTED = 5

/** DSH 面名 → MCP 面名。 */
export function reverseAliases() {
  const rev = {}
  for (const [mcp, dsh] of Object.entries(ALIASES)) rev[dsh] = mcp
  return rev
}
