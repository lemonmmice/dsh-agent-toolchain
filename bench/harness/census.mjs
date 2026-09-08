#!/usr/bin/env node
/**
 * Tool-call census for one benchmark run (pilot).
 *
 * Reads a run's agent.log for the CLI session id, locates the CLI session
 * transcript under ~/.claude/projects, and prints the tool-call census
 * (name x count, in chronological order). Used by the pilot report to
 * count MCP tool pulls reproducibly.
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

// session id from the result JSON
let sessionId = null
for (const line of log.split(/\r?\n/).reverse()) {
  const t = line.trim()
  if (!t.startsWith('{')) continue
  try {
    const o = JSON.parse(t)
    if (o.session_id) { sessionId = o.session_id; break }
  } catch { /* keep scanning */ }
}
if (!sessionId) {
  console.error('no session_id in agent.log; is this a CLI print-mode run?')
  process.exit(1)
}

const projectsRoot = join(homedir(), '.claude', 'projects')
let transcript = null
for (const dir of readdirSync(projectsRoot)) {
  const p = join(projectsRoot, dir, sessionId + '.jsonl')
  if (existsSync(p)) { transcript = p; break }
}
if (!transcript) {
  console.error('transcript not found for session ' + sessionId)
  process.exit(1)
}

const tools = []
for (const line of readFileSync(transcript, 'utf8').split(/\r?\n/)) {
  if (!line.trim()) continue
  let o
  try { o = JSON.parse(line) } catch { continue }
  if (o.type !== 'assistant' || !o.message?.content) continue
  for (const c of o.message.content) {
    if (c.type === 'tool_use') tools.push(c.name)
  }
}

const counts = new Map()
for (const t of tools) counts.set(t, (counts.get(t) || 0) + 1)
const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1])
console.log('run: ' + runId)
console.log('session: ' + sessionId)
console.log('total tool calls: ' + tools.length)
console.log('census:')
for (const [name, n] of sorted) console.log('  ' + name + ' x' + n)
const mcp = tools.filter((t) => t.startsWith('mcp__'))
console.log('MCP tool calls: ' + mcp.length + (mcp.length ? ' (' + [...new Set(mcp)].join(', ') + ')' : ''))
if (full) {
  console.log('sequence:')
  tools.forEach((t, i) => console.log('  ' + String(i + 1).padStart(3) + ': ' + t))
}
