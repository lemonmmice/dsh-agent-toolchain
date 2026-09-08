#!/usr/bin/env node
/**
 * Tool-call census for one benchmark run (pilot).
 *
 * claude runs: reads the run's agent.log for the CLI session id, locates the
 *   session transcript under ~/.claude/projects, counts tool_use calls.
 * codex runs:  the agent.log IS the transcript (exec --json stream);
 *   command_execution items count as shell calls and mcp_tool_call items
 *   carry {server, tool}. The toolchain MCP server is `dsh-agent-toolchain`.
 *
 * Usage: node bench/harness/census.mjs <runId> [--full]
 *   --full  also prints the chronological tool sequence
 */
import { readFileSync, existsSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { homedir } from 'node:os'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = join(HERE, '..', '..')

const args = process.argv.slice(2)
const runId = args[0]
const full = args.includes('--full')
if (!runId) {
  console.error('usage: node bench/harness/census.mjs <runId> [--full]')
  process.exit(1)
}

const logPath = join(REPO_ROOT, 'bench-runs', runId, 'agent.log')
if (!existsSync(logPath)) {
  console.error('run not found: ' + runId)
  process.exit(1)
}
const log = readFileSync(logPath, 'utf8')

function printCensus(tools, sessionLabel) {
  const counts = new Map()
  for (const t of tools) counts.set(t, (counts.get(t) || 0) + 1)
  const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1])
  console.log('run: ' + runId)
  console.log('session: ' + sessionLabel)
  console.log('total tool calls: ' + tools.length)
  console.log('census:')
  for (const [name, n] of sorted) console.log('  ' + name + ' x' + n)
  const mcp = tools.filter((t) => t.startsWith('mcp:'))
  console.log('MCP tool calls: ' + mcp.length + (mcp.length ? ' (' + [...new Set(mcp)].join(', ') + ')' : ''))
  if (full) {
    console.log('sequence:')
    tools.forEach((t, i) => console.log('  ' + String(i + 1).padStart(3) + ': ' + t))
  }
}

// ---- codex: the agent.log is the event stream itself
if (log.includes('"type":"thread.started"') || log.includes('"type":"turn.completed"')) {
  const tools = []
  let threadId = null
  for (const line of log.split(/\r?\n/)) {
    const t = line.trim()
    if (!t.startsWith('{')) continue
    let o
    try {
      o = JSON.parse(t)
    } catch {
      continue
    }
    if (o.type === 'thread.started') threadId = o.thread_id || threadId
    if (o.type !== 'item.completed') continue
    const it = o.item || {}
    if (it.type === 'mcp_tool_call') tools.push('mcp:' + (it.server || '?') + ':' + (it.tool || '?'))
    else if (it.type === 'command_execution') tools.push('shell_command')
    else if (it.type !== 'agent_message' && it.type !== 'error') tools.push(it.type || 'unknown')
  }
  printCensus(tools, 'codex:' + (threadId || '?'))
  process.exit(0)
}

// ---- claude: locate the session transcript via the session id
let sessionId = null
for (const line of log.split(/\r?\n/).reverse()) {
  const t = line.trim()
  if (!t.startsWith('{')) continue
  try {
    const o = JSON.parse(t)
    if (o.session_id) {
      sessionId = o.session_id
      break
    }
  } catch {
    /* keep scanning */
  }
}
if (!sessionId) {
  console.error('no session_id in agent.log; is this a CLI print-mode run?')
  process.exit(1)
}

const projectsRoot = join(homedir(), '.claude', 'projects')
let transcript = null
for (const dir of readdirSync(projectsRoot)) {
  const p = join(projectsRoot, dir, sessionId + '.jsonl')
  if (existsSync(p)) {
    transcript = p
    break
  }
}
if (!transcript) {
  console.error('transcript not found for session ' + sessionId)
  process.exit(1)
}

const tools = []
for (const line of readFileSync(transcript, 'utf8').split(/\r?\n/)) {
  if (!line.trim()) continue
  let o
  try {
    o = JSON.parse(line)
  } catch {
    continue
  }
  if (o.type !== 'assistant' || !o.message?.content) continue
  for (const c of o.message.content) {
    if (c.type === 'tool_use') tools.push(c.name)
  }
}
printCensus(tools, sessionId)
