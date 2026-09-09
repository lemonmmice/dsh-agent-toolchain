#!/usr/bin/env node
/**
 * dsh-agent-toolchain benchmark harness (pilot).
 *
 * Runs one coding task against an external agent CLI in two modes:
 *   baseline   - the agent works on the repository with its built-in tools only.
 *   toolchain  - the agent additionally receives the dsh-agent-toolchain MCP
 *                server (build loop, capture store, memory, verify_report, ...)
 *                plus the toolchain usage guidance a real dsh install injects
 *                (bench/harness/toolchain-guidance.md, prepended to the task
 *                prompt; recorded per-run as toolchainGuidance=true).
 *
 * The agent sees the repository at the task's base commit and a written prompt.
 * The task's hidden verification patch and the gold patch are NOT shown to the
 * agent. After the agent finishes, its working-tree patch is applied to a clean
 * checkout together with the hidden verification patch, and the task's verify
 * command is executed. "Verified" means the verify command exits 0.
 *
 * Task packages live in bench/tasks/<id>/ (not committed to the public repo;
 * see bench/README.md for the task format and the reasoning).
 *
 * Usage:
 *   node bench/harness/bench.mjs --task <id> --mode baseline|toolchain
 *     [--runs N] [--workspace-root DIR] [--max-turns N] [--model NAME]
 *     [--reference DIR] [--local-env FILE] [--agent-timeout-ms MS]
 */

import { spawn, execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync, rmSync } from 'node:fs'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { homedir } from 'node:os'
import { VACUOUS_TEST_PATTERNS } from '../../lib/verify/report.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(HERE, '..', '..')

// On Windows, spawning the bare 'claude'/'codex' commands through cmd's shell
// fails to resolve the npm .cmd shim (tested); the explicit .cmd name works.

// Toolchain-mode guidance: a real dsh install injects plugin systemPrompt
// sections describing the toolchain tools (build loop hard rules,
// verify_report closing check, ui_drive read-only/副作用 split, ...). The
// harness mirrors that so the toolchain arm is faithful to the real product
// instead of exposing bare MCP tools with no context — agents empirically
// ignore unguided tools (0 MCP pulls on 3 build-centric runs). Delivered by
// prepending to the task prompt because CLI args containing spaces are
// unsupported through the cmd.exe chain (documented in runAgentCli).
const TOOLCHAIN_GUIDANCE = readFileSync(join(HERE, 'toolchain-guidance.md'), 'utf8')

// ------------------------------------------------------------------ agents

/**
 * Parse a Codex CLI `exec --json` stream. Codex emits JSONL events:
 *   thread.started {thread_id} | turn.started / turn.completed {usage} |
 *   item.completed {item:{type: agent_message|command_execution|mcp_tool_call|error|...}}
 * It does not report USD cost or a stop_reason; token usage is summed over
 * turn.completed events. item errors are warnings (e.g. "model metadata not
 * found") and are ignored — the process exit code decides isError.
 */
function parseCodexResult(out) {
  let turns = 0
  let threadId = null
  let lastMsg = ''
  const usage = { input: 0, output: 0, cached: 0 }
  for (const line of String(out || '').split(/\r?\n/)) {
    const t = line.trim()
    if (!t.startsWith('{')) continue
    let ev
    try {
      ev = JSON.parse(t)
    } catch {
      continue
    }
    if (ev.type === 'thread.started') threadId = ev.thread_id || threadId
    else if (ev.type === 'turn.completed') {
      turns++
      const u = ev.usage || {}
      usage.input += u.input_tokens || 0
      usage.output += u.output_tokens || 0
      usage.cached += u.cached_input_tokens || 0
    } else if (ev.type === 'item.completed') {
      const it = ev.item || {}
      if (it.type === 'agent_message' && it.text) lastMsg = it.text
    }
  }
  return { turns, threadId, lastMsg, usage }
}

/**
 * Per-agent-CLI adapters. Each agent implements how to build the CLI args,
 * parse the output, machine-check MCP tool visibility, and (optionally)
 * transform the spawn environment. The two arms of a comparison always use
 * the SAME agent; cross-model runs pick a different agent but keep the same
 * task/mode/harness logic.
 */
const AGENTS = {
  claude: {
    cli: process.platform === 'win32' ? 'claude.cmd' : 'claude',
    processName: 'claude.exe',
    makeAgentArgs({ maxTurns, model, mcpConfigPath, repoDir }) {
      const a = [
        '-p',
        '--output-format',
        'json',
        '--max-turns',
        String(maxTurns),
        '--dangerously-skip-permissions',
        '--add-dir',
        repoDir,
        // --strict-mcp-config: load ONLY the servers from --mcp-config, never
        // the user's personal MCP servers (~/.claude.json) — observed npx
        // design-tool servers hanging the CLI through the proxy.
        '--strict-mcp-config',
        // Hard-block web access at the tool level (WebSearch/WebFetch
        // excluded): the answer must come from the code. MCP tools are
        // unaffected by --allowedTools.
        '--allowedTools',
        'Bash,Read,Edit,Write,Grep,Glob,PowerShell',
      ]
      // NOTE: --bare is deliberately NOT used. Empirically, --bare drops MCP
      // servers entirely (probed); both modes must differ only in whether
      // --mcp-config is passed, so both run without --bare.
      if (model) a.push('--model', model)
      if (mcpConfigPath) a.push('--mcp-config', mcpConfigPath, '--mcp-debug')
      return a
    },
    makeProbeArgs({ mcpConfigPath }) {
      return ['-p', '--output-format', 'json', '--max-turns', '2', '--strict-mcp-config', '--mcp-config', mcpConfigPath, '--mcp-debug']
    },
    parse(out) {
      const p = parseResultJson(out)
      return {
        turns: p?.num_turns ?? null,
        stopReason: p?.stop_reason ?? null,
        isError: !!p?.is_error,
        costUsd: p?.total_cost_usd ?? null,
        usageInputTokens: p?.usage?.input_tokens ?? null,
        usageOutputTokens: p?.usage?.output_tokens ?? null,
        usageCacheReadTokens: p?.usage?.cache_read_input_tokens ?? null,
        usageCacheCreateTokens: p?.usage?.cache_creation_input_tokens ?? null,
        model: p?.modelUsage ? Object.keys(p.modelUsage)[0] : p?.model || '',
        result: p?.result ?? '',
        sessionId: p?.session_id ?? null,
      }
    },
    probeCheck(text) {
      return String(text || '').includes('mcp__dsh-agent-toolchain__build_run')
    },
    // claude keeps the harness env (proxy included, per local.env).
    transformEnv(env) {
      return env
    },
  },
  codex: {
    cli: 'codex.cmd',
    processName: 'codex.exe',
    makeAgentArgs({ model, mcpProfile, repoDir }) {
      const a = ['exec', '--json', '--skip-git-repo-check']
      // Codex has no --max-turns; the run is bounded by the harness timeout.
      // Approvals: exec mode auto-approves tools; this flag additionally
      // removes sandboxing so the agent's shell can run dotnet/git freely
      // (mirrors claude's --dangerously-skip-permissions; both repos are
      // local throwaway clones).
      a.push('--dangerously-bypass-approvals-and-sandbox')
      if (model) a.push('-m', model)
      if (mcpProfile) a.push('-p', mcpProfile)
      a.push('-C', repoDir)
      return a
    },
    makeProbeArgs({ mcpProfile, repoDir }) {
      return ['exec', '--json', '--skip-git-repo-check', '--dangerously-bypass-approvals-and-sandbox', '-p', mcpProfile, '-C', repoDir]
    },
    parse(out) {
      const p = parseCodexResult(out)
      return {
        turns: p.turns,
        stopReason: 'end',
        isError: false, // decided by process exit code in runOnce
        costUsd: null, // codex does not report cost; tokens are recorded
        usageInputTokens: p.usage.input,
        usageOutputTokens: p.usage.output,
        usageCacheReadTokens: p.usage.cached,
        usageCacheCreateTokens: null,
        model: '', // recorded as args.model in runOnce
        result: p.lastMsg,
        sessionId: p.threadId ? `codex:${p.threadId}` : null,
      }
    },
    // Codex surfaces MCP tools under their bare names (no mcp__ prefix).
    probeCheck(text) {
      return /\bbuild_run\b/.test(String(text || ''))
    },
    /**
     * Stall probe: newest mtime under the codex session transcript tree.
     * Codex streams its rollout JSONL while it works, so a frozen transcript
     * means a hung agent — the failure mode that burned a whole overnight slot
     * (two runs sat 20+ minutes with an empty agent.log and no CPU).
     */
    progressMtimeMs() {
      const codexHome = process.env.CODEX_HOME || join(homedir(), '.codex')
      const dayDir = join(codexHome, 'sessions', ...new Date().toISOString().slice(0, 10).split('-'))
      let newest = 0
      try {
        for (const f of readdirSync(dayDir)) {
          if (!f.endsWith('.jsonl')) continue
          const m = statSync(join(dayDir, f)).mtimeMs
          if (m > newest) newest = m
        }
      } catch { /* dir may not exist yet */ }
      return newest
    },
    // Codex must reach its model endpoint directly (relay); proxy variables
    // would route it through the local proxy and hang. The agent's shell
    // inherits the same env, so dotnet/nuget inside codex also go direct
    // (warm package cache makes restore offline in practice).
    transformEnv(env) {
      for (const k of Object.keys(env)) {
        if (/^(HTTP|HTTPS|ALL|NO)_PROXY$/i.test(k)) delete env[k]
      }
      return env
    },
  },
}

// ------------------------------------------------------------------ args

function parseArgs(argv) {
  const a = {}
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i]
    const v = () => argv[++i]
    if (k === '--task') a.task = v()
    else if (k === '--mode') a.mode = v()
    else if (k === '--agent') a.agent = v()
    else if (k === '--workspace-root') a.workspaceRoot = v()
    else if (k === '--runs') a.runs = Number(v())
    else if (k === '--max-turns') a.maxTurns = Number(v())
    else if (k === '--model') a.model = v()
    else if (k === '--reference') a.reference = v()
    else if (k === '--local-env') a.localEnv = v()
    else if (k === '--agent-timeout-ms') a.agentTimeoutMs = Number(v())
    else if (k === '--help' || k === '-h') a.help = true
    else throw new Error('Unknown argument: ' + k)
  }
  a.runs = a.runs || 1
  if (a.help) {    console.log(`Usage: node bench/harness/bench.mjs --task <id> --mode baseline|toolchain [options]
  --workspace-root DIR   default bench-runs/ (gitignored)
  --runs N               repeat the same mode N times (default 1)
  --max-turns N          agent turn budget (default: task config, 40);
                         ignored by codex (no turn cap - timeout only)
  --model NAME           pin the agent model (default: the CLI's default)
  --agent NAME           agent CLI: claude (default) | codex
  --reference DIR        local mirror to speed up clones (optional)
  --local-env FILE       KEY=VALUE lines merged into the AGENT environment
                         (local proxy/no-proxy config; never committed)
  --agent-timeout-ms MS  wall-clock cap for one agent run (default 3600000)`)
    process.exit(0)
  }
  return a
}

// ------------------------------------------------------------------ helpers

// Git operations go through whatever proxy the harness environment configures;
// on Windows schannel fails TLS against the local proxy while the bundled
// openssl backend works (see CONTRIBUTING.md proxy notes). The flag is inert
// for local git operations.
const GIT_BASE = ['-c', 'http.sslBackend=openssl']

function git(args, opts = {}) {
  return execFileSync('git', [...GIT_BASE, ...args], { encoding: 'utf8', windowsHide: true, ...opts })
}

function sh(cmd, opts = {}) {
  return execFileSync(cmd, { encoding: 'utf8', windowsHide: true, ...opts })
}

function nowStamp() {
  const d = new Date()
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
}

function parseLocalEnv(file) {
  const out = {}
  if (!file || !existsSync(file)) return out
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const t = line.trim()
    if (!t || t.startsWith('#')) continue
    const i = t.indexOf('=')
    if (i <= 0) continue
    out[t.slice(0, i).trim()] = t.slice(i + 1).trim()
  }
  return out
}

/** Files touched by a unified diff (diff --git headers), lowercased. */
function patchFiles(patchText) {
  const out = []
  for (const line of String(patchText || '').split(/\r?\n/)) {
    const m = line.match(/^diff --git a\/(.+?) b\/(.+?)$/)
    if (m) out.push(m[1].toLowerCase())
  }
  return out
}

function spawnCapture(cmd, args, opts) {
  return new Promise((resolvePromise) => {
    const child = spawn(cmd, args, { windowsHide: true, ...opts })
    const chunks = []
    const errChunks = []
    child.stdout.on('data', (d) => chunks.push(Buffer.from(d)))
    child.stderr.on('data', (d) => errChunks.push(Buffer.from(d)))
    child.on('error', (e) => resolvePromise({ error: String(e), code: -1, out: '', err: '' }))
    child.on('exit', (code, signal) =>
      resolvePromise({
        code,
        signal,
        out: Buffer.concat(chunks).toString('utf8'),
        err: Buffer.concat(errChunks).toString('utf8'),
      }),
    )
  })
}

/**
 * Run the agent CLI once in print mode. The prompt is written to promptFile
 * and delivered via cmd's stdin redirection (Node's spawn input does not
 * reach the CLI through the cmd.exe / .cmd chain on Windows; quoting a
 * multi-line prompt as a command argument is unsafe). Paths with spaces in
 * cliArgs or promptFile are not supported — a documented limitation.
 */
async function runAgentCli(cli, cliArgs, promptText, promptFile, cwd, env) {
  writeFileSync(promptFile, promptText, 'utf8')
  // No embedded quotes here: Node wraps this single arg (it contains spaces)
  // in quotes when building the CreateProcess command line, and cmd /s
  // strips exactly that one outer pair.
  const cmdline = `${cli} ${cliArgs.join(' ')} < ${promptFile}`
  return await spawnCapture('cmd.exe', ['/d', '/s', '/c', cmdline], {
    cwd,
    env,
  })
}

/** Parse the CLI's result JSON out of its stdout. */
function parseResultJson(out) {
  for (const line of String(out || '').split(/\r?\n/).reverse()) {
    const t = line.trim()
    if (!t.startsWith('{')) continue
    try {
      return JSON.parse(t)
    } catch {
      /* keep scanning */
    }
  }
  const m = String(out || '').indexOf('{"type":"result"')
  if (m >= 0) {
    try {
      return JSON.parse(String(out).slice(m, String(out).lastIndexOf('}') + 1))
    } catch {
      /* ignore */
    }
  }
  return null
}

// ------------------------------------------------------------------ task

function loadTask(id) {
  const dir = join(REPO_ROOT, 'bench', 'tasks', id)
  const cfgPath = join(dir, 'config.json')
  const promptPath = join(dir, 'prompt.md')
  const verifyPath = join(dir, 'verify.patch')
  const goldPath = join(dir, 'gold.patch')
  for (const p of [cfgPath, promptPath, verifyPath]) {
    if (!existsSync(p)) throw new Error('Task file missing: ' + p)
  }
  const cfg = JSON.parse(readFileSync(cfgPath, 'utf8'))
  return {
    dir,
    cfg,
    prompt: readFileSync(promptPath, 'utf8'),
    verifyPatch: readFileSync(verifyPath, 'utf8'),
    goldPatch: existsSync(goldPath) ? readFileSync(goldPath, 'utf8') : '',
  }
}

// ------------------------------------------------------------------ run

async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (!args.task || !args.mode) throw new Error('--task and --mode are required')
  if (!['baseline', 'toolchain'].includes(args.mode)) throw new Error('--mode must be baseline|toolchain')
  args.agent = args.agent || 'claude'
  if (!AGENTS[args.agent]) throw new Error('--agent must be one of: ' + Object.keys(AGENTS).join(', '))
  const task = loadTask(args.task)
  const workspaceRoot = resolve(args.workspaceRoot || join(REPO_ROOT, 'bench-runs'))
  const maxTurns = args.maxTurns || task.cfg.maxTurns || 40
  const agentTimeoutMs = args.agentTimeoutMs || task.cfg.agentTimeoutMs || 3600000
  const dotnetDir = process.env.BENCH_DOTNET_DIR || join(homedir(), '.dotnet')
  const dotnetExe = join(dotnetDir, 'dotnet.exe')
  const localEnvPath = args.localEnv || join(REPO_ROOT, 'bench', 'local.env')
  const localEnv = parseLocalEnv(localEnvPath)
  const resultsPath = join(workspaceRoot, 'results.jsonl')
  mkdirSync(workspaceRoot, { recursive: true })

  if (!existsSync(dotnetExe)) {
    console.warn(`[warn] dotnet SDK not found at ${dotnetExe}; agents will use whatever dotnet resolves on PATH (set BENCH_DOTNET_DIR to override).`)
  }

  console.log(`task=${task.cfg.id} mode=${args.mode} runs=${args.runs} maxTurns=${maxTurns}`)
  console.log(`model=${args.model || '<cli default>'} reference=${args.reference || '(none)'}`)

  const summaries = []
  for (let i = 0; i < (args.runs || 1); i++) {
    const s = await runOnce({
      args,
      task,
      i,
      workspaceRoot,
      maxTurns,
      agentTimeoutMs,
      dotnetDir,
      localEnv,
      resultsPath,
    })
    summaries.push(s)
  }

  console.log('\n===== summary =====')
  for (const s of summaries) {
    console.log(
      [
        s.mode,
        `verified=${s.verified}`,
        `turns=${s.turns}`,
        `dur=${Math.round(s.durationMs / 60000)}m`,
        `cost=${s.costUsd == null ? 'n/a' : '$' + Number(s.costUsd).toFixed(4)}`,
        `model=${s.model || '?'}`,
        `agent=${s.agent || 'claude'}`,
      ].join(' '),
    )
  }
  console.log('\nResults appended to: ' + resultsPath)
}

async function runOnce({ args, task, i, workspaceRoot, maxTurns, agentTimeoutMs, dotnetDir, localEnv, resultsPath }) {
  const runId = `${task.cfg.id}-${args.mode}-${nowStamp()}${args.runs > 1 ? '-' + (i + 1) : ''}`
  const runDir = join(workspaceRoot, runId)
  const repoDir = join(runDir, 'repo')
  const verifyDir = join(runDir, 'verify')
  const logPath = join(runDir, 'agent.log')
  const patchPath = join(runDir, 'agent.patch')
  const verifyLogPath = join(runDir, 'verify.log')
  mkdirSync(runDir, { recursive: true })
  console.log(`\n--- run ${runId} ---`)

  const cloneArgs = ['clone', '-q']
  if (args.reference && existsSync(args.reference)) cloneArgs.push('--reference', args.reference)
  cloneArgs.push(task.cfg.repo, repoDir)
  git(cloneArgs)
  git(['-C', repoDir, 'checkout', '-q', task.cfg.baseCommit])
  try {
    git(['-C', repoDir, 'remote', 'remove', 'origin'])
  } catch {
    /* no remote configured */
  }

  // Agent environment: start from the harness env, drop proxy variables
  // (the agent CLI talks to its own endpoint directly), then apply the
  // local overrides from --local-env (which may re-add a proxy for package
  // restores together with NO_PROXY exclusions).
  // NOTE: process.env on this platform may carry the key as "Path"; a spread
  // keeps that casing and setting "PATH" afterwards would then collide
  // case-insensitively, leaving the child with a broken PATH. Delete the
  // mixed-case key first.
  const agentEnv = { ...process.env }
  delete agentEnv.Path
  for (const k of Object.keys(agentEnv)) {
    if (/^(HTTP|HTTPS|ALL|NO)_PROXY$/i.test(k)) delete agentEnv[k]
  }
  Object.assign(agentEnv, localEnv)
  // Task-declared environment (config.json `agentEnv`): the task declares
  // what its toolchain needs — e.g. DSH_UI_PROC_NAME / DSH_UI_WINDOW_NAME
  // for a UI-driven verification task. Documented in bench/README.md.
  Object.assign(agentEnv, task.cfg.agentEnv ?? {})
  agentEnv.PATH = `${dotnetDir};${process.env.PATH || process.env.Path || ''}`
  agentEnv.DOTNET_ROOT = dotnetDir
  agentEnv.DOTNET_CLI_TELEMETRY_OPTOUT = '1'
  agentEnv.DOTNET_SKIP_FIRST_TIME_EXPERIENCE = '1'
  agentEnv.MSBUILDDISABLENODEREUSE = '1'

  const agentDef = AGENTS[args.agent]

  let mcpConfigPath = null
  let mcpProfile = null
  if (args.mode === 'toolchain') {
    if (args.agent === 'codex') {
      // Codex MCP servers live in $CODEX_HOME/<profile>.config.toml (layered
      // on top of the user config via -p). Literal single-quoted TOML strings
      // keep Windows backslashes intact. The user's bundled MCP servers
      // (e.g. node_repl) remain available in BOTH codex arms — inherent to
      // the codex environment, disclosed in the report.
      const codexHome = process.env.CODEX_HOME || join(homedir(), '.codex')
      mcpProfile = 'bench'
      const toml = [
        args.model ? `model = "${args.model}"` : '',
        '[mcp_servers.dsh-agent-toolchain]',
        `command = '${process.execPath}'`,
        `args = ['${join(REPO_ROOT, 'mcp', 'server.mjs')}']`,
        'startup_timeout_sec = 120',
        '[mcp_servers.dsh-agent-toolchain.env]',
        `DSH_BUILD_CLIENT_ROOT = '${repoDir}'`,
        `DSH_BUILD_LOGS_DIR = '${join(runDir, 'build-logs')}'`,
        `DSH_API_CAPTURE_STORE = '${join(runDir, 'capture')}'`,
        `DSH_UI_EVIDENCE_DIR = '${join(runDir, 'ui-evidence')}'`,
      ]
      for (const [k, v] of Object.entries(task.cfg.agentEnv ?? {})) {
        toml.push(`${k} = '${v}'`)
      }
      writeFileSync(join(codexHome, `${mcpProfile}.config.toml`), toml.join('\n') + '\n', 'utf8')
    } else {
      mcpConfigPath = join(runDir, 'mcp-config.json')
      writeFileSync(
        mcpConfigPath,
        JSON.stringify(
          {
            mcpServers: {
              'dsh-agent-toolchain': {
                type: 'stdio',
                command: process.execPath,
                args: [join(REPO_ROOT, 'mcp', 'server.mjs')],
                env: {
                  DSH_BUILD_CLIENT_ROOT: repoDir,
                  DSH_BUILD_LOGS_DIR: join(runDir, 'build-logs'),
                  DSH_API_CAPTURE_STORE: join(runDir, 'capture'),
                  DSH_UI_EVIDENCE_DIR: join(runDir, 'ui-evidence'),
                  ...(task.cfg.agentEnv ?? {}),
                },
              },
            },
          },
          null,
          2,
        ),
        'utf8',
      )
    }
  }

  const cliArgs = agentDef.makeAgentArgs({ maxTurns, model: args.model, mcpConfigPath, mcpProfile, repoDir })

  const startedAt = Date.now()
  const timer = { done: false }
  const killer = setTimeout(() => {
    if (!timer.done) {
      console.warn(`[run ${runId}] agent timeout after ${Math.round(agentTimeoutMs / 60000)}m, killing`)
      try {
        spawn('taskkill', ['/IM', agentDef.processName, '/T', '/F'], { windowsHide: true })
      } catch {
        /* ignore */
      }
    }
  }, agentTimeoutMs)

  const agentPrompt =
    args.mode === 'toolchain' ? TOOLCHAIN_GUIDANCE + '\n\n' + task.prompt : task.prompt
  const agentSpawnEnv = agentDef.transformEnv({ ...agentEnv })
  const agent = await runAgentCli(agentDef.cli, cliArgs, agentPrompt, join(runDir, 'prompt.txt'), repoDir, agentSpawnEnv)
  timer.done = true
  clearTimeout(killer)
  const durationMs = Date.now() - startedAt

  writeFileSync(logPath, `===== stdout =====\n${agent.out}\n\n===== stderr =====\n${agent.err}`, 'utf8')

  const parsed = agentDef.parse(agent.out)
  const isAgentError = args.agent === 'codex' ? agent.code !== 0 : !!parsed.isError

  // Machine-check that the toolchain MCP was actually visible to the agent.
  // (A one-turn probe that lists its tools; guards against CLI-flag
  // regressions silently dropping MCP servers.)
  let mcpToolsVisible = null
  if (args.mode === 'toolchain') {
    // MCP connections are occasionally flaky; retry the probe up to 3 times
    // before declaring the run invalid (false negatives observed).
    let probeText = ''
    let probeOut = ''
    let probeErr = ''
    for (let attempt = 1; attempt <= 3; attempt++) {
      const probe = await runAgentCli(
        agentDef.cli,
        agentDef.makeProbeArgs({ mcpConfigPath, mcpProfile, repoDir }),
        'Do NOT call any tools. Answer only with a comma-separated list of the tool names available to you, including MCP tools.',
        join(runDir, 'probe.prompt.txt'),
        runDir,
        agentSpawnEnv,
      )
      probeOut = probe.out
      probeErr = probe.err
      probeText = agentDef.parse(probe.out).result
      mcpToolsVisible = agentDef.probeCheck(probeText)
      if (mcpToolsVisible) break
    }
    writeFileSync(join(runDir, 'probe.log'), `visible=${mcpToolsVisible}\n\n${probeText}\n\n${probeOut}\n\n${probeErr}`, 'utf8')
    if (!mcpToolsVisible) {
      console.warn(`[run ${runId}] MCP tools NOT visible to the agent - this run is INVALID as a toolchain datapoint`)
    }
  }

  // Patch extraction: stage everything the agent changed.
  let patch = ''
  try {
    git(['-C', repoDir, 'add', '-A', '--', '.'])
    patch = git(['-C', repoDir, 'diff', '--cached', '--binary'])
  } catch (e) {
    console.warn('[run ' + runId + '] patch extraction failed: ' + String(e.message || e))
  }
  writeFileSync(patchPath, patch, 'utf8')

  const model = args.model || parsed.model || ''
  const usage = parsed

  // ---- verify in a clean checkout ----
  let verified = false
  let verifyExitCode = null
  let verifyReason = ''
  let patchedTests = false
  let verifyTail = ''
  try {
    git(['-C', repoDir, 'worktree', 'add', '-f', verifyDir, task.cfg.baseCommit])
    if (patch.trim()) {
      try {
        git(['-C', verifyDir, 'apply', '--whitespace=nowarn', '--', join(task.dir, 'verify.patch')])
      } catch (e) {
        verifyReason = 'verify.patch failed to apply: ' + (e.stderr || e.message || e)
        throw new Error(verifyReason)
      }
      try {
        git(['-C', verifyDir, 'apply', '--whitespace=nowarn', '--', patchPath])
      } catch (e) {
        // Retry with 3-way merge before giving up.
        try {
          git(['-C', verifyDir, 'apply', '--3way', '--whitespace=nowarn', '--', patchPath])
        } catch (e2) {
          verifyReason = 'agent.patch failed to apply: ' + (e2.stderr || e2.message || e2)
          throw new Error(verifyReason)
        }
      }
    } else {
      verifyReason = 'agent produced no patch'
      throw new Error(verifyReason)
    }

    patchedTests =
      patchFiles(patch).filter((f) => patchFiles(task.verifyPatch).includes(f)).length > 0

    const verifyEnv = { ...agentEnv }
    verifyEnv.PATH = `${dotnetDir};${verifyEnv.PATH || ''}`
    // Run the task's verify command verbatim through the shell so its
    // internal quoting (e.g. --filter "FullyQualifiedName~X") survives.
    const r = await spawnCapture(task.cfg.verifyCommand, [], {
      cwd: verifyDir,
      env: verifyEnv,
      shell: true,
    })
    verifyExitCode = r.code
    verifyTail = String(r.out || '').trim().split(/\r?\n/).slice(-12).join('\n')
    verified = r.code === 0
    if (!verified) verifyReason = 'verify command exited ' + r.code
    else {
      // Runtime anti-green-wash (same discipline as verify_report's gate
      // kind): an exit-0 verify whose output shows zero tests ran must not
      // certify `verified` — the offline base-fails validation is a promise
      // by the task author, this is an in-harness check.
      const vac = VACUOUS_TEST_PATTERNS.find((p) => p.re.test(String(r.out ?? '')))
      if (vac) {
        verified = false
        verifyReason = `verify output vacuous (${vac.label})`
      }
    }
    // A patch that overlaps the hidden test paths is never a fair pass,
    // even if the apply conflict machinery happened to let it through.
    if (verified && patchedTests) {
      verified = false
      verifyReason = 'agent patch touched the hidden test paths'
    }
  } catch (e) {
    verified = false
    if (!verifyReason) verifyReason = String(e.stderr || e.message || e)
  }
  writeFileSync(
    verifyLogPath,
    `reason: ${verifyReason}\nexit: ${verifyExitCode}\npatchedTests: ${patchedTests}\n\n${verifyTail}`,
    'utf8',
  )

  const rec = {
    ts: new Date().toISOString(),
    runId,
    task: task.cfg.id,
    tier: task.cfg.tier || '',
    mode: args.mode,
    agent: args.agent,
    modeValid: args.mode === 'baseline' ? true : mcpToolsVisible === true,
    mcpToolsVisible,
    toolchainGuidance: args.mode === 'toolchain',
    model: model || '',
    turns: parsed.turns ?? null,
    stopReason: parsed.stopReason ?? null,
    isError: isAgentError,
    durationMs,
    costUsd: parsed.costUsd ?? null,
    usageInputTokens: parsed.usageInputTokens ?? null,
    usageOutputTokens: parsed.usageOutputTokens ?? null,
    usageCacheReadTokens: parsed.usageCacheReadTokens ?? null,
    usageCacheCreateTokens: parsed.usageCacheCreateTokens ?? null,
    patchBytes: Buffer.byteLength(patch),
    patchFiles: patchFiles(patch),
    patchedTests,
    verified,
    verifyExitCode,
    verifyReason,
    agentExitCode: agent.code,
    agentSignal: agent.signal || null,
    spawnError: agent.error || null,
    logPath,
    patchPath,
  }
  appendFileSync(resultsPath, JSON.stringify(rec) + '\n', 'utf8')
  writeFileSync(join(runDir, 'run.json'), JSON.stringify(rec, null, 2), 'utf8')

  const costStr = rec.costUsd == null ? 'n/a' : '$' + Number(rec.costUsd).toFixed(4)
  console.log(
    `[run ${runId}] valid=${rec.modeValid} verified=${verified} turns=${rec.turns ?? '?'} cost=${costStr}` +
      (rec.verifyReason ? ` reason=${rec.verifyReason.slice(0, 120)}` : ''),
  )
  return rec
}

main().catch((e) => {
  console.error('[bench] ' + (e.stderr || e.message || e))
  process.exit(1)
})
