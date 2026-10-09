/**
 * lib/stop-gate.mjs —— 收尾裁决闸门（Claude Code 的 Stop 钩子）。
 *
 * 为什么要有：bench 试点（bench/pilot/report.md §15.4）里，有引导注入时 6/6 次都走了
 * build_run → verify_report，没有引导时 0/4 —— "证据胜于声明"整条链完全靠提示词撑着。
 * 这个闸门把它从"agent 记得调"变成"宿主在结束时检查"：
 *   本回合改了文件、却没有调用 verify_report ⇒ 拦一次（decision:block），要求先交给机器裁决；
 *   调用过 verify_report 且结论不是 pass ⇒ 放行，但把机器裁决原样告诉用户（systemMessage），
 *   agent 的收尾总结怎么写都盖不住它。
 *
 * 只拦一次：Claude Code 在被 Stop 钩子拦过之后再次结束时会带 stop_hook_active=true，此时一律放行
 * （仍未裁决就给用户一句提示）。agent 停下来是为了提问或汇报阻塞时，说明一句就能结束。
 *
 * 失败一律放行（fail-open）：读不到/认不出会话记录、
 * 任何异常 —— 闸门坏了不能把人困在会话里。
 *
 * 配置：DSH_STOP_GATE = block（默认）| warn（只提醒不拦）| off；
 *       DSH_STOP_GATE_IGNORE = 不计入"改了文件"的路径正则（默认：文档/日志 与 .claude/.codex 配置目录）。
 */
import { closeSync, fstatSync, openSync, readSync } from 'node:fs'
import { parseCodexTurn } from './codex-turn.mjs'
export { parseCodexTurn } from './codex-turn.mjs'

export const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit'])
export const DEFAULT_IGNORE = /(\.(md|markdown|txt|log)$)|([\\/]\.(claude|codex)[\\/])/i
const VERIFY_TOOL = /(^|__)verify_report$/
const TAIL_BYTES = 8 * 1024 * 1024

/** 读文件末尾（会话记录可能很大；回合一定在末尾）。读不了返回 null。 */
export function readTail(path, maxBytes = TAIL_BYTES) {
  let fd
  try {
    fd = openSync(path, 'r')
    const size = fstatSync(fd).size
    const start = Math.max(0, size - maxBytes)
    const buf = Buffer.alloc(size - start)
    readSync(fd, buf, 0, buf.length, start)
    const text = buf.toString('utf8')
    return start > 0 ? text.slice(text.indexOf('\n') + 1) : text
  } catch {
    return null
  } finally {
    if (fd !== undefined) try { closeSync(fd) } catch { /* ignore */ }
  }
}

function contentItems(entry) {
  const c = entry && entry.message && entry.message.content
  return Array.isArray(c) ? c : []
}

/** 用户真正输入的一句话（不是工具结果、不是系统注入的 meta 消息、不是压缩摘要）。 */
function isRealPrompt(e) {
  if (!e || e.type !== 'user' || e.isMeta || e.isSidechain || e.isCompactSummary) return false
  const c = e.message && e.message.content
  if (typeof c === 'string') return c.trim().length > 0
  if (!Array.isArray(c)) return false
  return c.some((x) => x && x.type === 'text') && !c.some((x) => x && x.type === 'tool_result')
}

function resultText(item) {
  const c = item && item.content
  if (typeof c === 'string') return c
  if (Array.isArray(c)) return c.filter((x) => x && x.type === 'text').map((x) => x.text).join('\n')
  return ''
}

/**
 * 从 Claude Code 会话记录（JSONL）里取出**最后一个回合**：改了哪些文件、调没调 verify_report、结论是什么。
 * recognized=false 表示这不像 Claude Code 的会话记录（调用方据此放行）。
 */
export function parseClaudeTurn(text) {
  const entries = []
  for (const line of String(text ?? '').split('\n')) {
    if (!line.trim()) continue
    try { entries.push(JSON.parse(line)) } catch { /* 半行/坏行跳过 */ }
  }
  const recognized = entries.some((e) => (e.type === 'user' || e.type === 'assistant') && e.message)
  let start = -1
  for (let i = entries.length - 1; i >= 0; i--) {
    if (isRealPrompt(entries[i])) { start = i; break }
  }
  const edits = []
  const verifies = []
  const byId = new Map()
  for (const e of entries.slice(start + 1)) {
    if (e.isSidechain) continue
    if (e.type === 'assistant') {
      for (const item of contentItems(e)) {
        if (!item || item.type !== 'tool_use') continue
        const name = String(item.name ?? '')
        if (EDIT_TOOLS.has(name)) {
          const file = item.input && (item.input.file_path ?? item.input.notebook_path)
          edits.push({ tool: name, file: typeof file === 'string' ? file : null })
        } else if (VERIFY_TOOL.test(name)) {
          const v = { id: item.id, tool: name, verdict: null, isError: false }
          verifies.push(v)
          if (item.id) byId.set(item.id, v)
        }
      }
    } else if (e.type === 'user') {
      for (const item of contentItems(e)) {
        if (!item || item.type !== 'tool_result' || !byId.has(item.tool_use_id)) continue
        const v = byId.get(item.tool_use_id)
        v.isError = item.is_error === true
        try {
          const payload = JSON.parse(resultText(item))
          if (payload && typeof payload.verdict === 'string') v.verdict = payload.verdict
          if (payload && payload.counts) v.counts = payload.counts
          if (payload && typeof payload.reportPath === 'string') v.reportPath = payload.reportPath
        } catch { /* 拒绝类错误不是 JSON 报告：verdict 留 null */ }
      }
    }
  }
  return { recognized, turnFound: start >= 0, edits, verifies }
}

export function gateConfig(env = process.env) {
  const mode = String(env.DSH_STOP_GATE ?? '').trim().toLowerCase()
  let ignore = DEFAULT_IGNORE
  if (env.DSH_STOP_GATE_IGNORE) {
    try { ignore = new RegExp(env.DSH_STOP_GATE_IGNORE, 'i') } catch { ignore = DEFAULT_IGNORE }
  }
  return { mode: ['off', 'warn', 'block'].includes(mode) ? mode : 'block', ignore }
}

function fileList(edits) {
  const files = [...new Set(edits.map((e) => e.file))]
  const shown = files.slice(0, 4).map((f) => f.replace(/^.*[\\/]/, ''))
  return shown.join('、') + (files.length > 4 ? ` 等 ${files.length} 个` : '')
}

/** 回合 + 钩子输入 → 钩子输出（null = 静默放行）。 */
export function decideStop({ input = {}, turn, config }) {
  if (config.mode === 'off' || !turn || !turn.recognized) return null
  const edits = turn.edits.filter((e) => e.file && !config.ignore.test(e.file))
  const last = turn.verifies[turn.verifies.length - 1]
  if (last) {
    if (last.verdict === 'pass') return null
    const c = last.counts
    const counts = c ? `（pass ${c.pass ?? 0} / fail ${c.fail ?? 0} / unverified ${c.unverified ?? 0}）` : ''
    const verdict = last.verdict ?? (last.isError ? '调用被拒绝' : '未知')
    return { systemMessage: `dsh 收尾裁决：verify_report = ${verdict}${counts}` + (last.reportPath ? `，报告：${last.reportPath}` : '') }
  }
  if (edits.length === 0) return null
  const n = new Set(edits.map((e) => e.file)).size
  if (input.stop_hook_active === true || config.mode === 'warn') {
    return { systemMessage: `⚠ dsh 收尾裁决：本回合改了 ${n} 个文件（${fileList(edits)}），结束前没有调用 verify_report。` + (input.stop_hook_active === true ? '（已提醒过一次）' : '') }
  }
  return {
    decision: 'block',
    reason: [
      `dsh 收尾裁决：本回合修改了 ${n} 个文件（${fileList(edits)}），但还没有调用 verify_report。`,
      '结束前请把完成声明写成 claims 交给 verify_report 裁决（同一个 runId 贯穿 build_run / verify_report）：',
      '- 能跑命令就用 kind=gate（测试 / lint / 构建命令，退出码 0 才算过）；',
      '- 新增的 .cs 用 kind=compiled 确认进了编译集；本回合跑过 build_run 就用 kind=build；',
      '- 实在无法机器验证的，用 kind=manual 写明状态和依据（会标成自评，不算独立验证）。',
      '如果你停下来是为了向用户提问或汇报阻塞（不是宣布完成），在回复里说明即可，再次结束不会再被拦。',
    ].join('\n'),
  }
}

/** 钩子入口：原始 stdin 文本 → 输出对象或 null。永不抛。 */
export function runStopGate(rawInput, env = process.env, { readTranscript = readTail } = {}) {
  try {
    const config = gateConfig(env)
    if (config.mode === 'off') return null
    const input = JSON.parse(String(rawInput || '{}'))
    if (typeof input.transcript_path !== 'string' || !input.transcript_path) return null
    const text = readTranscript(input.transcript_path)
    if (text === null) return null
    const turn = input.turn_id !== undefined ? parseCodexTurn(text, input.turn_id) : parseClaudeTurn(text)
    return decideStop({ input, turn, config })
  } catch {
    return null
  }
}
