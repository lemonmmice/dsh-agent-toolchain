#!/usr/bin/env node
/**
 * dsh-agent-toolchain benchmark harness (pilot).
 *
 * Runs one coding task against an external agent CLI in two modes:
 *   baseline   - the agent works on the repository with its built-in tools only.
 *   toolchain  - the agent additionally receives the dsh-agent-toolchain MCP
 *                server (build loop, capture store, memory, verify_report, ...).
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

// On Windows, spawning the bare 'claude' command through cmd's shell fails to
// resolve the npm .cmd shim (tested); the explicit .cmd name is reliable.
const AGENT_CLI = process.platform === 'win32' ? 'claude.cmd' : 'claude'

// ------------------------------------------------------------------ args

function parseArgs(argv) {
  const a = {}
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i]
    const v = () => argv[++i]
    if (k === '--task') a.task = v()
    else if (k === '--mode') a.mode = v()
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
  --max-turns N          agent turn budget (default: task config, 40)
  --model NAME           pin the agent model (default: the CLI's default)
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
async function runAgentCli(cliArgs, promptText, promptFile, cwd, env) {
  writeFileSync(promptFile, promptText, 'utf8')
  // No embedded quotes here: Node wraps this single arg (it contains spaces)
  // in quotes when building the CreateProcess command line, and cmd /s
  // strips exactly that one outer pair.
  const cmdline = `${AGENT_CLI} ${cliArgs.join(' ')} < ${promptFile}`
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
        `cost=$${Number(s.costUsd || 0).toFixed(4)}`,
        `model=${s.model || '?'}`,
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

  let mcpConfigPath = null
  if (args.mode === 'toolchain') {
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

  const cliArgs = [
    '-p',
    '--output-format',
    'json',
    '--max-turns',
    String(maxTurns),
    '--dangerously-skip-permissions',
    '--add-dir',
    repoDir,
    // Hard-block web access at the tool level (WebSearch/WebFetch excluded):
    // the answer must come from the code, not from looking up the fix online.
    // MCP tools are unaffected by --allowedTools.
    '--allowedTools',
    'Bash,Read,Edit,Write,Grep,Glob,PowerShell',
  ]
  // NOTE: --bare is deliberately NOT used. Empirically, --bare drops MCP
  // servers entirely (probed: with --bare only built-in tools were listed;
  // without it all mcp__* tools appear). Both modes must differ only in
  // whether --mcp-config is passed, so both run without --bare.
  if (args.model) cliArgs.push('--model', args.model)
  if (mcpConfigPath) {
    cliArgs.push('--mcp-config', mcpConfigPath)
    // MCP server connection evidence lands on stderr (captured in agent.log).
    cliArgs.push('--mcp-debug')
  }

  const startedAt = Date.now()
  const timer = { done: false }
  const killer = setTimeout(() => {
    if (!timer.done) {
      console.warn(`[run ${runId}] agent timeout after ${Math.round(agentTimeoutMs / 60000)}m, killing`)
      try {
        spawn('taskkill', ['/IM', 'claude.exe', '/T', '/F'], { windowsHide: true })
      } catch {
        /* ignore */
      }
    }
  }, agentTimeoutMs)

  const agent = await runAgentCli(cliArgs, task.prompt, join(runDir, 'prompt.txt'), repoDir, agentEnv)
  timer.done = true
  clearTimeout(killer)
  const durationMs = Date.now() - startedAt

  writeFileSync(logPath, `===== stdout =====\n${agent.out}\n\n===== stderr =====\n${agent.err}`, 'utf8')

  const parsed = parseResultJson(agent.out)

  // Machine-check that the toolchain MCP was actually visible to the agent.
  // (A one-turn probe that lists its tools; guards against CLI-flag
  // regressions like --bare silently dropping MCP servers.)
  let mcpToolsVisible = null
  if (mcpConfigPath) {
    // The CLI's MCP connections are occasionally flaky; retry the probe up to
    // 3 times before declaring the run invalid (false negatives observed).
    let probeParsed = null
    let probeOut = ''
    let probeErr = ''
    for (let attempt = 1; attempt <= 3; attempt++) {
      const probe = await runAgentCli(
        ['-p', '--output-format', 'json', '--max-turns', '2', '--mcp-config', mcpConfigPath, '--mcp-debug'],
        'Do NOT call any tools. Answer only with a comma-separated list of the tool names available to you, including MCP tools.',
        join(runDir, 'probe.prompt.txt'),
        runDir,
        agentEnv,
      )
      probeOut = probe.out
      probeErr = probe.err
      probeParsed = parseResultJson(probe.out)
      mcpToolsVisible = !!(
        probeParsed &&
        typeof probeParsed.result === 'string' &&
        probeParsed.result.includes('mcp__dsh-agent-toolchain__build_run')
      )
      if (mcpToolsVisible) break
    }
    writeFileSync(join(runDir, 'probe.log'), `visible=${mcpToolsVisible}\n\n${probeOut}\n\n${probeErr}`, 'utf8')
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

  const model = parsed?.modelUsage ? Object.keys(parsed.modelUsage)[0] : parsed?.model || ''
  const usage = parsed?.usage || {}

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
    modeValid: args.mode === 'baseline' ? true : mcpToolsVisible === true,
    mcpToolsVisible,
    model: model || args.model || '',
    turns: parsed?.num_turns ?? null,
    stopReason: parsed?.stop_reason ?? null,
    isError: !!parsed?.is_error,
    durationMs,
    costUsd: parsed?.total_cost_usd ?? null,
    usageInputTokens: usage?.input_tokens ?? null,
    usageOutputTokens: usage?.output_tokens ?? null,
    usageCacheReadTokens: usage?.cache_read_input_tokens ?? null,
    usageCacheCreateTokens: usage?.cache_creation_input_tokens ?? null,
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

  console.log(
    `[run ${runId}] valid=${rec.modeValid} verified=${verified} turns=${rec.turns ?? '?'} cost=$${Number(rec.costUsd || 0).toFixed(4)}` +
      (rec.verifyReason ? ` reason=${rec.verifyReason.slice(0, 120)}` : ''),
  )
  return rec
}

main().catch((e) => {
  console.error('[bench] ' + (e.stderr || e.message || e))
  process.exit(1)
})
