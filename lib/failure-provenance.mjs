/**
 * lib/failure-provenance.mjs —— 自动失败记录的「来源」字段（producer）。
 *
 * 为什么要有（2026-10 真库复盘）：库里 811 条 tool-error 有约 94% 是三种重复报错，
 * 248 组「3 条 / 2 秒」的突发，最后查明全是 `mcp-snapshot-gate.test.mjs` 每跑一次往**真库**写的三条。
 * 能查明靠的是时间戳巧合；而记录本身只有 `{runtime:'mcp', tool}`，**根本分不出**是测试、bench
 * 还是真实 agent 写的。所以每条自动记录都要带上：
 *   runtime   —— mcp / dsh / verify；
 *   client    —— MCP initialize 里客户端报的 clientInfo（name/version）；
 *   agentTurn —— 宿主 agent 的会话/回合 id（目前只有 Codex 在 `_meta["x-codex-turn-metadata"]` 里给）；
 *   toolchain —— 本仓 version + 提交 sha（裁决器修 bug 后可按版本批量撤回它产出的记录）；
 *   test      —— 测试进程（DSH_TEST=1）写的记录自带标记。
 *
 * 只收**标识**，不收内容：会话/回合 id、客户端名字，绝不收参数、输出或提示词。
 */
import { toolchainVersion } from './toolchain-version.mjs'

export const CODEX_TURN_META_KEY = 'x-codex-turn-metadata'

const ID_RE = /^[\w.:-]{1,100}$/

function pickId(v) {
  return typeof v === 'string' && ID_RE.test(v) ? v : undefined
}

/**
 * 从 MCP 请求的 `_meta` 里取宿主 agent 的回合标识。
 * Codex（codex-rs/core/src/mcp_tool_call.rs）在每次 MCP 调用的 `_meta["x-codex-turn-metadata"]` 里放
 * 当前回合的元数据（对象，或序列化成字符串的对象）；这里只挑 session/thread/turn 三个 id。
 * 认不出来就返回 null —— 不猜。
 */
export function agentTurnFromMeta(meta) {
  if (!meta || typeof meta !== 'object') return null
  let raw = meta[CODEX_TURN_META_KEY]
  if (typeof raw === 'string') {
    try { raw = JSON.parse(raw) } catch { return null }
  }
  if (!raw || typeof raw !== 'object') return null
  const turn = {
    host: 'codex',
    sessionId: pickId(raw.session_id ?? raw.sessionId),
    threadId: pickId(raw.thread_id ?? raw.threadId),
    turnId: pickId(raw.turn_id ?? raw.turnId),
  }
  if (!turn.sessionId && !turn.threadId && !turn.turnId) return null
  return Object.fromEntries(Object.entries(turn).filter(([, v]) => v !== undefined))
}

/** 拼一条 producer；所有输入都可缺省，缺了就不写那一项。 */
export function buildProducer({ runtime, client, agentTurn, env = process.env } = {}) {
  const v = toolchainVersion()
  const c = client && typeof client === 'object' && typeof client.name === 'string' && client.name.trim()
    ? { name: client.name.trim().slice(0, 80), ...(typeof client.version === 'string' && client.version ? { version: client.version.slice(0, 40) } : {}) }
    : null
  return {
    ...(runtime ? { runtime } : {}),
    ...(c ? { client: c } : {}),
    ...(agentTurn ? { agentTurn } : {}),
    toolchain: { ...(v.version ? { version: v.version } : {}), ...(v.sha ? { sha: v.sha } : {}), ...(v.source ? { source: v.source, dirty: v.dirty } : {}) },
    ...(env && env.DSH_TEST === '1' ? { test: true } : {}),
  }
}
