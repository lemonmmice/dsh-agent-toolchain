/**
 * dsh-agent-toolchain MCP server — stdio transport.
 *
 * Exposes the engineering-quality tools of the toolchain (build / ui-drive /
 * http_request / memory / failure corpus) to any MCP client:
 * Claude Code, Cursor, Cline, ...
 *
 * Env config follows the toolchain convention (DSH_* variables), e.g.:
 *   DSH_UI_PROC_NAME / DSH_UI_WINDOW_NAME / DSH_UI_CLIENT_EXE  (ui tools)
 *   DSH_BUILD_CLIENT_ROOT / DSH_BUILD_MSBUILD / DSH_BUILD_LOGS_DIR (build)
 *   DSH_MEMORY_DIR (memory data dir, default ~/.dsh/memory)
 *   DSH_FAILURE_CORPUS_DIR (failure corpus, default ~/.dsh-agent-toolchain/failure-corpus)
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import { makeBuilder } from '../plugins/dsh-build/lib/builder.mjs'
import { makeDriver } from '../plugins/dsh-ui-drive/lib/driver.mjs'
import { sendRequest } from '../plugins/dsh-postman/lib/http.mjs'
import { DshMemory } from '../plugins/dsh-memory/lib/memory.mjs'
import { makeFailureCorpus, FAILURE_CLASSES } from '../lib/failure-corpus.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

const server = new McpServer({
  name: 'dsh-agent-toolchain',
  version: '0.1.0',
})

// ---------------------------------------------------------------- shared

const text = (s) => ({ content: [{ type: 'text', text: s }] })
const jtext = (o) => text(JSON.stringify(o, null, 1))

let driver = null
function drv() {
  if (!driver) {
    driver = makeDriver({
      scriptsDir: join(root, 'plugins', 'dsh-ui-drive', 'scripts'),
      procName: process.env.DSH_UI_PROC_NAME || '',
      windowName: process.env.DSH_UI_WINDOW_NAME || '',
      clientExe: process.env.DSH_UI_CLIENT_EXE || '',
      evidenceDir: process.env.DSH_UI_EVIDENCE_DIR || '',
    })
  }
  return driver
}

let memory = null
function mem() {
  if (!memory) memory = new DshMemory({})
  return memory
}

let corpus = null
function fc() {
  if (!corpus) corpus = makeFailureCorpus({})
  return corpus
}

// ---------------------------------------------------------------- build

server.tool(
  'build_run',
  'Run an MSBuild build (incremental Build or full Rebuild) and return structured errors. ' +
    'Use after changing code to verify it compiles. Requires DSH_BUILD_CLIENT_ROOT (solution dir) or the clientRoot argument.',
  {
    target: z.enum(['Build', 'Rebuild']).default('Build').describe('Build (incremental, fast) or Rebuild (full)'),
    project: z.string().optional().describe('Optional csproj path relative to the solution root; empty = WholeSolution.sln'),
    configuration: z.string().default('Debug'),
    platform: z.string().default('x86'),
    clientRoot: z.string().optional().describe('Solution root dir (env DSH_BUILD_CLIENT_ROOT)'),
    killClient: z.boolean().optional().describe('Kill the running client process before building (breaks the user UI — confirm first)'),
  },
  async (args) => {
    const b = makeBuilder({
      clientRoot: args.clientRoot || process.env.DSH_BUILD_CLIENT_ROOT || '',
      msbuild: process.env.DSH_BUILD_MSBUILD || '',
      logsDir: process.env.DSH_BUILD_LOGS_DIR || '',
    })
    const r = await b.build({
      target: args.target,
      project: args.project,
      configuration: args.configuration,
      platform: args.platform,
      killClient: args.killClient,
    })
    return jtext(r)
  }
)

// ---------------------------------------------------------------- ui-drive

server.tool(
  'ui_status',
  'Check the target desktop client process / main-window status (read-only). Configure the client via DSH_UI_PROC_NAME / DSH_UI_WINDOW_NAME / DSH_UI_CLIENT_EXE.',
  {},
  async () => jtext(await drv().status())
)

const uiAction = z.enum(['find', 'click', 'setvalue', 'key', 'read', 'shot'])

server.tool(
  'ui_drive',
  'Drive the running desktop client via Windows UIA: find / read / shot are read-only; ' +
    'click / setvalue / key are real side effects and REQUIRE allowSideEffects=true. ' +
    'shot with describe=true returns a vision description of the screen.',
  {
    action: uiAction,
    name: z.string().optional().describe('Control Name'),
    aid: z.string().optional().describe('AutomationId'),
    value: z.string().optional().describe('Value for setvalue/key'),
    ascii: z.boolean().optional().describe('key mode: send ASCII directly instead of clipboard paste'),
    match: z.string().optional().describe('read mode: regex filter'),
    label: z.string().optional().describe('Screenshot file label (shot mode)'),
    describe: z.boolean().optional().describe('shot mode: also return a vision description of the screen'),
    waitMs: z.number().optional(),
    allowSideEffects: z.boolean().optional().describe('REQUIRED true for click/setvalue/key'),
  },
  async (args) => {
    if (['click', 'setvalue', 'key'].includes(args.action) && !args.allowSideEffects) {
      return text('Blocked: action "' + args.action + '" is a real side effect. Re-call with allowSideEffects=true after confirming with the user.')
    }
    const r = await drv().drive({
      action: args.action,
      name: args.name,
      aid: args.aid,
      value: args.value,
      ascii: args.ascii,
      match: args.match,
      label: args.label,
      describe: args.describe,
      waitMs: args.waitMs,
      allowSideEffects: args.allowSideEffects,
    })
    return jtext(r)
  }
)

// ---------------------------------------------------------------- http

server.tool(
  'http_request',
  'Send an HTTP request from the host (server-side, no browser CORS) and return status / headers / body. ' +
    'A non-2xx status is a normal result; ok:false means the request could not be made.',
  {
    method: z.string().default('GET').describe('HTTP method'),
    url: z.string().describe('Absolute http(s) URL'),
    headers: z.record(z.string(), z.string()).optional().describe('Request headers'),
    body: z.string().optional().describe('Request body (ignored for GET/HEAD)'),
    timeoutMs: z.number().optional(),
  },
  async (args) => {
    const r = await sendRequest({
      method: args.method,
      url: args.url,
      headers: args.headers,
      body: args.body,
      timeoutMs: args.timeoutMs,
    })
    return jtext(r)
  }
)

// ---------------------------------------------------------------- memory

server.tool(
  'memory_index',
  'Index a local directory into the long-term memory vector store (incremental: skips unchanged files by mtime; skips bin/obj/node_modules).',
  { path: z.string().describe('Absolute directory to index') },
  async (args) => jtext(await mem().indexWorkspace(args.path))
)

server.tool(
  'memory_search',
  'Semantic search over indexed documents/code. Returns relevant snippets with source files.',
  { query: z.string(), k: z.number().default(5).describe('Results count, max 10') },
  async (args) => {
    const k = Math.min(Math.max(Math.round(args.k || 5), 1), 10)
    const hits = await mem().search(args.query, k)
    return jtext({
      embed: mem().embed.label,
      hits: hits.map((h) => ({ file: h.meta.file, chunk: h.meta.chunkIndex, score: +h.score.toFixed(3), text: String(h.meta.text).slice(0, 400) })),
    })
  }
)

server.tool(
  'memory_save',
  'Save a cross-session key-value memory (per scope, e.g. a project name). Same key+scope overwrites.',
  { key: z.string(), value: z.string(), scope: z.string().default('global') },
  async (args) => jtext(mem().remember(args.key, args.value, args.scope))
)

server.tool(
  'memory_recall',
  'Read a saved key-value memory.',
  { key: z.string(), scope: z.string().default('global') },
  async (args) => {
    const v = mem().recall(args.key, args.scope)
    return jtext(v === undefined ? { found: false } : { found: true, value: v })
  }
)

server.tool(
  'memory_status',
  'Memory store status: chunk count, KV entries, data dir, embedding backend.',
  {},
  async () => jtext(mem().status())
)

// ---------------------------------------------------------------- failure corpus

server.tool(
  'failure_record',
  'Record one failure / human-handoff event into the local failure corpus (JSONL, local-only, never uploaded). ' +
    'Call this every time a task fails, verification disagrees with a claim, a tool malfunctions, or a human had to take over. Facts, not blame.',
  {
    task: z.string().describe('One-line task name'),
    failureClass: z.enum(FAILURE_CLASSES).describe('Failure class from the fixed taxonomy: ' + FAILURE_CLASSES.join(' | ')),
    description: z.string().describe('What went wrong'),
    resolution: z.string().optional().describe('How it was unblocked'),
    context: z.record(z.string(), z.string()).optional().describe('Runtime context (runtime / tool / model / repo)'),
    tags: z.array(z.string()).optional().describe('Free-form tags for later mining'),
    costMs: z.number().optional().describe('Approximate time wasted in ms'),
  },
  async (args) => {
    try {
      return jtext(fc().record(args))
    } catch (e) {
      return text('failure_record rejected: ' + e.message)
    }
  }
)

server.tool(
  'failure_query',
  'Query the local failure corpus: substring q (task/description/resolution), failureClass, tag, time range. Returns newest-first records.',
  {
    q: z.string().optional(),
    failureClass: z.enum(FAILURE_CLASSES).optional(),
    tag: z.string().optional(),
    fromTs: z.number().optional().describe('Earliest ts (epoch ms)'),
    toTs: z.number().optional().describe('Latest ts (epoch ms)'),
    limit: z.number().optional().describe('Max records, default 50, max 500'),
    offset: z.number().optional(),
  },
  async (args) => jtext(fc().query(args))
)

server.tool(
  'failure_stats',
  'Failure corpus stats: total, last 7/30 days, per-class counts, corpus dir.',
  {},
  async () => jtext(fc().stats())
)

// ---------------------------------------------------------------- boot

const transport = new StdioServerTransport()
await server.connect(transport)
