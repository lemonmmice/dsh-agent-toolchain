import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { lstat, mkdir, readFile, realpath, unlink, writeFile } from 'node:fs/promises'
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { runVerificationProcess } from '../verify/process.mjs'

const DEFAULT_TIMEOUT = 300000
const DEFAULT_OUTPUT_LIMIT = 8 * 1024 * 1024
const DEFAULT_TRAJECTORY_LIMIT = 2000

function workspacePath(value) {
  if (typeof value !== 'string' || !isAbsolute(value)) throw new Error('workspace must be an absolute path')
  return resolve(value)
}

function inside(root, value) {
  const target = resolve(root, value)
  const prefix = root.endsWith(sep) ? root : root + sep
  return target === root || target.startsWith(prefix)
}

function safeRelative(root, value) {
  if (typeof value !== 'string' || !value || isAbsolute(value)) return null
  const target = resolve(root, value)
  if (!inside(root, target)) return null
  return relative(root, target) || basename(target)
}

function bounded(value, limit = DEFAULT_TRAJECTORY_LIMIT) {
  const text = String(value ?? '').replace(/(?:sk|api|token|secret)[-_]?[a-z0-9]{8,}/gi, '[redacted]')
  return text.length <= limit ? text : text.slice(0, limit) + '…'
}

function usageOf(value) {
  const source = value && typeof value === 'object' ? value : {}
  const numberOrNull = field => source[field] === null || source[field] === undefined || source[field] === '' ? null : Number.isFinite(Number(source[field])) ? Number(source[field]) : null
  return { inputTokens: numberOrNull('inputTokens'), outputTokens: numberOrNull('outputTokens'), cost: numberOrNull('cost') }
}

function modelOf(config, input, observed) {
  const requested = input?.model || config.model || config.modelId
  return { id: observed ? String(observed) : 'unknown', ...(requested ? { requested: String(requested) } : {}) }
}

async function hashFile(path) {
  const bytes = await readFile(path)
  return createHash('sha256').update(bytes).digest('hex')
}

async function safeArtifact(root, candidate) {
  const relativePath = safeRelative(root, candidate)
  if (!relativePath) return null
  const path = join(root, relativePath)
  try {
    const stat = await lstat(path, { bigint: true })
    if (!stat.isFile() || stat.isSymbolicLink()) return null
    const canonicalRoot = await realpath(root)
    const canonicalFile = await realpath(path)
    if (!inside(canonicalRoot, canonicalFile)) return null
    const bytes = Number(stat.size)
    const text = bytes <= 1024 * 1024 ? (await readFile(path, 'utf8').catch(() => '')).slice(0, 400) : ''
    return { path: relativePath, bytes, sha256: await hashFile(path), ...(text ? { summary: text } : {}) }
  } catch { return null }
}

async function artifacts(root, paths, maxCount = 64) {
  const result = []
  for (const candidate of Array.isArray(paths) ? paths.slice(0, maxCount) : []) {
    const artifact = await safeArtifact(root, candidate)
    if (artifact) result.push(artifact)
  }
  return result
}

function commandOf(config, input) {
  const value = typeof config.commandBuilder === 'function' ? config.commandBuilder(input) : config.command
  if (Array.isArray(value) && value.length) return { command: String(value[0]), args: value.slice(1).map(String) }
  if (typeof value === 'string' && value) return { command: value, args: Array.isArray(config.args) ? config.args.map(String) : [] }
  if (value && typeof value === 'object' && value.command) return { command: String(value.command), args: Array.isArray(value.args) ? value.args.map(String) : [] }
  return null
}

function publicTask(task = {}) {
  return {
    id: typeof task.id === 'string' ? task.id : null,
    taskType: typeof task.taskType === 'string' ? task.taskType : null,
    prompt: typeof task.prompt === 'string' ? task.prompt : '',
    inputs: Array.isArray(task.inputs) ? task.inputs.filter(item => typeof item === 'string').slice(0, 64) : [],
    outputs: Array.isArray(task.outputs) ? task.outputs.filter(item => typeof item === 'string').slice(0, 64) : [],
  }
}

async function writeTaskInput(input, root, stage = false) {
  const path = join(root, stage ? '.harness-stage-input.json' : '.harness-task-input.json')
  const value = stage
    ? { stage: input.stage, task: publicTask(input.task), evidence: input.evidence, baseHarness: input.baseHarness, candidates: input.candidates, experiences: input.experiences, budget: input.budget, rejection: input.rejection || null }
    : { task: publicTask(input.task), harness: { fingerprint: input.harness?.fingerprint || null, files: Object.keys(input.harness?.files || {}) }, runId: input.runId || null, attemptId: input.attemptId || null, budget: input.budget || {} }
  await writeFile(path, JSON.stringify(value), 'utf8')
  return path
}

function parseProtocol(stdout) {
  const usage = { inputTokens: null, outputTokens: null, cost: null }
  let model = null
  let lastMessage = ''
  for (const line of String(stdout || '').split(/\r?\n/)) {
    if (!line.trim().startsWith('{')) continue
    let value
    try { value = JSON.parse(line) } catch { continue }
    if (value.type === 'turn.completed' || value.type === 'response.completed') {
      const source = value.usage || value.response?.usage || {}
      const inputTokens = Number(source.input_tokens ?? source.inputTokens)
      const outputTokens = Number(source.output_tokens ?? source.outputTokens)
      if (Number.isFinite(inputTokens)) usage.inputTokens = (usage.inputTokens || 0) + inputTokens
      if (Number.isFinite(outputTokens)) usage.outputTokens = (usage.outputTokens || 0) + outputTokens
      if (Number.isFinite(Number(source.cost))) usage.cost = Number(source.cost)
    }
    model ||= value.model || value.response?.model || value.item?.model || null
    const item = value.item || value.response?.output?.[0]
    if (value.type === 'item.completed' && item?.type === 'agent_message') lastMessage = String(item.text || item.content || '')
    if (value.type === 'response.output_text.done') lastMessage = String(value.text || value.output_text || '')
  }
  return { usage, model, lastMessage }
}

async function invoke(config, input, { stage = false } = {}) {
  const root = workspacePath(input.workspace)
  if (!existsSync(root)) throw new Error('workspace does not exist')
  const inputPath = await writeTaskInput(input, root, stage)
  const command = commandOf(config, input)
  if (!command) {
    await unlink(inputPath).catch(() => {})
    return { state: 'unavailable', completeness: 'incomplete', model: modelOf(config, input), usage: usageOf(null), artifacts: [], trajectory: [{ event: 'unavailable', detail: stage ? 'stage command is not configured' : 'executor command is not configured' }] }
  }
  const timeoutMs = Number.isFinite(Number(input.budget?.timeoutMs)) ? Math.max(1, Number(input.budget.timeoutMs)) : DEFAULT_TIMEOUT
  const maxBytes = Number.isFinite(Number(config.maxOutputBytes)) ? Math.max(1024, Number(config.maxOutputBytes)) : DEFAULT_OUTPUT_LIMIT
  try {
    const shell = config.__hostShell === true && config.protocol !== 'codex'
    const result = await runVerificationProcess(command.command, command.args, { cwd: root, shell, timeoutMs, signal: input.signal, maxBytes })
    const protocol = parseProtocol(result.stdout)
    const started = !result.error || result.code !== null || result.aborted || result.timedOut || result.outputLimitExceeded
    const state = result.aborted || result.timedOut || result.outputLimitExceeded ? 'unknown' : result.error ? (result.error.includes('ENOENT') ? 'unavailable' : 'failed') : result.code === 0 ? 'completed' : 'failed'
    const completeness = state === 'completed' ? 'complete' : 'incomplete'
    const summary = protocol.lastMessage || (stage || config.captureOutput === true ? bounded(result.stdout) : '')
    const trajectory = [{ event: stage ? 'stage' : 'task', command: basename(command.command), started, exitCode: result.code, ...(summary ? { summary: bounded(summary) } : {}), ...(result.stderr ? { error: bounded(result.stderr) } : {}) }]
    return { state, completeness, model: modelOf(config, input, protocol.model), usage: protocol.usage.inputTokens !== null || protocol.usage.outputTokens !== null || protocol.usage.cost !== null ? protocol.usage : usageOf(null), artifacts: [], trajectory, exitCode: result.code, ...(result.error ? { error: bounded(result.error) } : {}), ...(config.protocol === 'codex' ? { protocol } : {}) }
  } finally {
    await unlink(inputPath).catch(() => {})
  }
}

export function createExecutor(config = {}) {
  if (config.kind === 'codex') return createCodexExecutor(config)
  return {
    async runTask(input = {}) {
      const result = await invoke(config, input)
      if (result.state === 'unavailable' || result.state === 'unknown') return result
      const root = workspacePath(input.workspace)
      const paths = input.task?.outputs || config.outputs || []
      return { ...result, artifacts: await artifacts(root, paths, config.maxArtifacts) }
    },
  }
}

function parseStage(stdout) {
  try { return JSON.parse(String(stdout || '').trim()) } catch { return null }
}

function stageResult(value) {
  if (!value || typeof value !== 'object') return { noEntry: true, rationale: 'stage returned no structured result', evidenceRefs: [], usage: usageOf(null) }
  const output = { ...value, usage: usageOf(value.usage) }
  if (output.files && typeof output.files !== 'object') delete output.files
  if (Array.isArray(output.evidenceRefs)) output.evidenceRefs = output.evidenceRefs.filter(item => typeof item === 'string').slice(0, 32)
  if (output.rationale !== undefined) output.rationale = bounded(output.rationale, 2000)
  if (output.reflection && typeof output.reflection === 'object') output.reflection = { ...output.reflection, confidence: Number.isFinite(Number(output.reflection.confidence)) ? Number(output.reflection.confidence) : null }
  return output
}

export function createImprover(config = {}) {
  if (config.kind === 'codex') return createCodexImprover(config)
  return {
    async runStage(input = {}) {
      if (typeof config.runner === 'function') return stageResult(await config.runner(input))
      const root = workspacePath(input.workspace)
      await mkdir(root, { recursive: true })
      const inputPath = join(root, '.harness-stage-input.json')
      const publicInput = { stage: input.stage, task: input.task, evidence: input.evidence, baseHarness: input.baseHarness, candidates: input.candidates, experiences: input.experiences, budget: input.budget, rejection: input.rejection || null }
      await writeFile(inputPath, JSON.stringify(publicInput), 'utf8')
      try {
        const commandInput = { ...input, stageInputPath: inputPath }
        const result = await invoke(config, commandInput, { stage: true })
        if (result.state === 'unavailable') return { noEntry: true, state: 'unavailable', unavailable: true, rationale: result.trajectory?.[0]?.detail, evidenceRefs: [], usage: result.usage }
        const parsed = parseStage(result.protocol?.lastMessage || result.trajectory?.[0]?.summary)
        if (!parsed) return { noEntry: false, state: 'failed', rationale: result.state === 'completed' ? 'stage did not return one JSON object' : `stage ${result.state}`, evidenceRefs: [], usage: result.usage }
        return { ...stageResult(parsed), state: result.state }
      } finally {
        try { await writeFile(inputPath, '', 'utf8') } catch { /* workspace cleanup is owned by caller */ }
      }
    },
  }
}

export function createCodexImprover({ model, command = process.platform === 'win32' ? 'codex.exe' : 'codex', ...config } = {}) {
  const { kind: _kind, ...safeConfig } = config
  return createImprover({ ...safeConfig, protocol: 'codex', model, command, commandBuilder: input => ({ command, args: ['exec', '--json', '--ephemeral', '--sandbox', 'workspace-write', '--skip-git-repo-check', ...(model ? ['-m', model] : []), '-C', input.workspace, 'Read .harness-stage-input.json (if its "rejection" field is set, your previous attempt was rejected for that reason — fix exactly that). Return only one JSON object; use noEntry=true when no safe change is supported.'] }) })
}

export function createCodexExecutor({ model, command = process.platform === 'win32' ? 'codex.exe' : 'codex', ...config } = {}) {
  const { kind: _kind, ...safeConfig } = config
  return createExecutor({ ...safeConfig, protocol: 'codex', command, model, commandBuilder: input => ({ command, args: ['exec', '--json', '--ephemeral', '--sandbox', 'workspace-write', '--skip-git-repo-check', ...(model ? ['-m', model] : []), '-C', input.workspace, 'Read .harness-task-input.json and complete the task in this workspace.'] }) })
}

