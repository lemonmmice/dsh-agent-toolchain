import { createRequire } from 'node:module'
import { readFile, realpath, stat } from 'node:fs/promises'
import { existsSync, readFileSync } from 'node:fs'
import { join, dirname, resolve, relative, isAbsolute } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createHash, randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'

const MAX_FILE_BYTES = 2 * 1024 * 1024
const MAX_TEXT_CHARS = 60000
const BACKENDS = ['dsh-fs-encoding', 'dotnet-skills', '@dsh-lsp-packs/dsh-lsp-csharp', 'dsh-logtimeline']
const fail = (message, code = 'DEV_INVALID_ARGUMENT') => Object.assign(new Error(message), { code })
const hash = bytes => createHash('sha256').update(bytes).digest('hex')

function integer(value, fallback, minimum, maximum, name) {
  const result = value ?? fallback
  if (!Number.isInteger(result) || result < minimum || result > maximum) throw fail(`${name} must be an integer between ${minimum} and ${maximum}`)
  return result
}

function required(value, name, allowEmpty = false) {
  if (typeof value !== 'string' || (!allowEmpty && !value.trim())) throw fail(`${name} must be a ${allowEmpty ? '' : 'nonempty '}string`)
  return value
}

async function workspaceFile(repoRoot, file) {
  required(repoRoot, 'repoRoot')
  required(file, 'file')
  if (!isAbsolute(repoRoot)) throw fail('repoRoot must be absolute')
  const root = await realpath(repoRoot)
  const target = await realpath(resolve(root, file))
  const inside = relative(root, target)
  if (inside === '..' || inside.startsWith('../') || inside.startsWith('..\\') || isAbsolute(inside)) throw fail('File resolves outside repoRoot', 'DEV_PATH_OUTSIDE_ROOT')
  if (!(await stat(target)).isFile()) throw fail('file must identify a regular file')
  return { root, target }
}

export function createDevelopmentRuntime(options) {
  const profileDir = resolve(options.profileDir)
  const requireProfile = createRequire(join(profileDir, 'package.json'))
  let lspContext
  let lspRoot
  let skillProvider
  const importFile = file => import(pathToFileURL(file).href)
  function resolvePackage(name) {
    try { return requireProfile.resolve(name) }
    catch (error) {
      if (error.code !== 'MODULE_NOT_FOUND' && error.code !== 'ERR_PACKAGE_PATH_NOT_EXPORTED') throw error
      throw fail(`Missing ${name} in ${profileDir}; install the documented backend before using this tool`, 'DEV_DEPENDENCY_MISSING')
    }
  }
  const importPackage = name => importFile(resolvePackage(name))
  function packageRoot(name) {
    resolvePackage(name)
    return dirname(requireProfile.resolve(name + '/package.json'))
  }
  function deploymentConfig(id) {
    const patchFile = join(profileDir, 'cordis.patch.yml')
    if (!existsSync(patchFile)) return {}
    const rows = requireProfile('yaml').parse(readFileSync(patchFile, 'utf8'))
    if (!Array.isArray(rows)) throw fail('Profile patch must contain an array', 'DEV_CONFIG_INVALID')
    let config = {}
    for (const row of rows) {
      for (const entry of row.insert || []) if (entry.id === id) config = { ...config, ...entry.config }
      if (row.id === id) config = { ...config, ...row.config }
    }
    return config
  }
  async function status() {
    const backends = BACKENDS.map(name => {
      try {
        const metadata = JSON.parse(readFileSync(join(packageRoot(name), 'package.json'), 'utf8'))
        return { name, available: true, version: metadata.version, license: metadata.license }
      } catch (error) {
        return { name, available: false, error: error.message }
      }
    })
    return { profileDir, state: backends.every(backend => backend.available) ? 'installed' : 'unconfigured', backends, runtimeVerified: false, note: 'Package discovery only; call the relevant tool to verify operation. Backends remain separately installed packages.' }
  }
  async function csharp(args, signal) {
    const { root, target } = await workspaceFile(args.repoRoot, args.file)
    const operations = ['goToDefinition', 'findReferences', 'goToImplementation', 'hover']
    if (!operations.includes(args.operation)) throw fail('Unsupported C# LSP operation')
    const line = integer(args.line, undefined, 1, 10000000, 'line')
    const character = integer(args.character, undefined, 1, 10000000, 'character')
    const timeoutMs = integer(args.timeoutMs, 60000, 1000, 120000, 'timeoutMs')
    if (lspContext && lspRoot !== root) { await lspContext.fiber.dispose(); lspContext = undefined }
    if (!lspContext) {
      const [{ Context }, { default: Lsp }, { default: LocalFileSystem }, { default: LocalSubprocessRuntime }, pack] = await Promise.all([
        importPackage('@deepseek-ai/cordis'), importPackage('@deepseek-ai/dsh-lsp'), importPackage('@deepseek-ai/dsh-fs-local'), importPackage('@deepseek-ai/dsh-subprocess-local'), importPackage('@dsh-lsp-packs/dsh-lsp-csharp'),
      ])
      const context = new Context()
      try {
        await context.plugin(Lsp)
        await context.plugin(LocalFileSystem, { cwd: root })
        await context.plugin(LocalSubprocessRuntime)
        const config = deploymentConfig('lsp-csharp')
        await context.plugin(pack, { ...config, command: options.csharpServer || process.env.DSH_CSHARP_SERVER || config.command || 'omnisharp', args: config.args || ['--languageserver', '--encoding', 'utf-8'] })
        lspContext = context
        lspRoot = root
      } catch (error) { await context.fiber.dispose(); throw error }
    }
    const deadline = AbortSignal.timeout(timeoutMs)
    const result = await lspContext.lsp.query({ operation: args.operation, filePath: target, position: { line: line - 1, character: character - 1 }, workspaceRoot: root }, signal ? AbortSignal.any([signal, deadline]) : deadline)
    if (result.kind === 'locations') return { ...result, total: result.locations.length, locations: result.locations.slice(0, 200), truncated: result.locations.length > 200 }
    const contents = result.hover?.contents || ''
    return { ...result, hover: result.hover ? { ...result.hover, contents: contents.slice(0, MAX_TEXT_CHARS) } : null, truncated: contents.length > MAX_TEXT_CHARS }
  }
  async function logs(args, signal) {
    const file = required(args.file, 'file')
    if (!isAbsolute(file)) throw fail('Log file must be absolute')
    if (!(await stat(file)).isFile()) throw fail('Log file must be a regular file')
    const timeText = required(args.timeText, 'timeText')
    const maxLines = integer(args.maxLines, 100, 0, 500, 'maxLines')
    const script = join(packageRoot('dsh-logtimeline'), 'python', 'lq.py')
    const config = deploymentConfig('logtimeline')
    const command = options.pythonBin || process.env.DSH_LOG_PYTHON || config.pythonBin || 'python'
    const argv = ['-B', script, timeText, '--json', '--no-llm', '--files', file, '--max-lines', String(maxLines)]
    if (args.timezone !== undefined) argv.push('--timezone', required(args.timezone, 'timezone'))
    const output = await new Promise((resolveOutput, reject) => {
      execFile(command, argv, { windowsHide: true, signal, timeout: 30000, maxBuffer: 8 * 1024 * 1024, encoding: 'utf8', env: { ...process.env, PYTHONUTF8: '1' } }, (error, stdout, stderr) => {
        if (error && error.code !== 2) { reject(error); return }
        if (!stdout.trim()) { reject(fail(`Log query produced no JSON: ${stderr.slice(-500)}`, 'DEV_LOG_FAILED')); return }
        resolveOutput(stdout)
      })
    })
    const result = JSON.parse(output)
    if (!result.filter || !result.time_range) throw fail('Log query returned an unexpected result', 'DEV_LOG_FAILED')
    if (Object.keys(result.filter.file_errors || {}).length) throw fail('LogTimeline could not read the requested file: ' + JSON.stringify(result.filter.file_errors).slice(0, 1000), 'DEV_LOG_FAILED')
    let remaining = MAX_TEXT_CHARS
    let outputTruncated = false
    result.filter.lines = result.filter.lines.slice(0, maxLines).map(line => {
      const raw = String(line.raw).replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '')
      const limited = raw.slice(0, remaining)
      remaining -= limited.length
      outputTruncated ||= limited.length < raw.length
      return { ...line, raw: limited }
    })
    return { ...result, outputTruncated }
  }
  async function skills(args, signal) {
    if (!skillProvider) {
      const plugin = await importPackage('dotnet-skills')
      plugin.apply({ skills: { registerProvider(factory) { skillProvider = factory() } } })
    }
    const candidates = await skillProvider.list({ signal })
    if (args.name !== undefined) {
      const candidate = candidates.find(item => item.name === args.name)
      if (!candidate) throw fail('Unknown .NET skill name', 'DEV_SKILL_NOT_FOUND')
      const definition = await skillProvider.get(candidate, { signal })
      return { name: definition.name, description: definition.description, resourceBase: definition.resourceBase, content: definition.content.slice(0, MAX_TEXT_CHARS), truncated: definition.content.length > MAX_TEXT_CHARS }
    }
    const query = String(args.query || '').toLowerCase()
    const limit = integer(args.limit, 15, 1, 50, 'limit')
    const matches = candidates.filter(item => `${item.name} ${item.description}`.toLowerCase().includes(query))
    return { total: matches.length, skills: matches.slice(0, limit).map(item => ({ name: item.name, description: item.description })), truncated: matches.length > limit }
  }
  async function encodedFile(args, signal, edit) {
    if (edit && args.allowWrite !== true) throw fail('dev_edit requires allowWrite=true', 'DEV_WRITE_NOT_ALLOWED')
    if (edit && !/^[a-f0-9]{64}$/i.test(args.expectedHash || '')) throw fail('expectedHash must be the SHA-256 returned by dev_read')
    const { root, target } = await workspaceFile(args.repoRoot, args.file)
    if ((await stat(target)).size > MAX_FILE_BYTES) throw fail('Encoding tools accept files up to 2 MiB', 'DEV_FILE_TOO_LARGE')
    const beforeBytes = await readFile(target, { signal })
    const version = hash(beforeBytes)
    if (edit && version !== args.expectedHash.toLowerCase()) throw fail('File changed since dev_read; read it again', 'DEV_STALE_FILE')
    const encodingRoot = packageRoot('dsh-fs-encoding')
    if (edit) {
      const config = await importFile(join(encodingRoot, 'lib/config.js'))
      if (config.loadConfig().normalizeToUtf8) throw fail('Disable normalizeToUtf8 in the encoding backend before using preserving edits', 'DEV_ENCODING_MIGRATION_ENABLED')
    }
    const [{ Context }, { SandboxedFileSystem }, observation, io, { EncodingSandbox }, state, undo] = await Promise.all([
      importPackage('@deepseek-ai/cordis'), importPackage('@deepseek-ai/dsh-fs-sandbox'), importPackage('@deepseek-ai/dsh-fs-observation-policy'),
      importFile(join(encodingRoot, 'lib/io.js')), importFile(join(encodingRoot, 'lib/sandbox.js')), importFile(join(encodingRoot, 'lib/encoding-state.js')), importFile(join(encodingRoot, 'lib/undo-state.js')),
    ])
    const context = new Context()
    const policy = { mode: 'workspace-write', workspaceRoot: root }
    context.provide('sandboxPolicy', { defaultMode: policy.mode, resolve: () => policy })
    new SandboxedFileSystem(context, { cwd: root, diffBasisMaxBytes: MAX_FILE_BYTES })
    observation.apply(context)
    const execution = { name: edit ? 'edit' : 'read', callId: randomUUID(), signal, agent: { session: { id: randomUUID(), header: { cwd: root } } } }
    try {
      const opened = await io.readFile(context, target, root, { exec: execution, signal, encodingHint: args.encoding })
      if (hash(await readFile(target, { signal })) !== version) throw fail('File changed during reading; retry dev_read', 'DEV_STALE_FILE')
      const metadata = { file: target, encoding: opened.state.encoding, bom: opened.state.hasBOM, lineEnding: opened.state.lineEnding, sha256: version }
      if (!edit) {
        const offset = integer(args.offset, 1, 1, 10000000, 'offset')
        const limit = integer(args.limit, 200, 1, 1000, 'limit')
        const lines = opened.text.split(/\r\n|\n|\r/)
        if (lines.at(-1) === '') lines.pop()
        const content = lines.slice(offset - 1, offset - 1 + limit).join('\n')
        return { ...metadata, offset, totalLines: lines.length, content: content.slice(0, MAX_TEXT_CHARS), truncated: offset - 1 + limit < lines.length || content.length > MAX_TEXT_CHARS }
      }
      const oldText = required(args.oldText, 'oldText').replace(/\r\n|\r/g, '\n')
      const newText = required(args.newText, 'newText', true).replace(/\r\n|\r/g, '\n')
      const current = opened.text.replace(/\r\n|\r/g, '\n')
      const occurrences = current.split(oldText).length - 1
      if (!occurrences || (occurrences > 1 && args.replaceAll !== true)) throw fail(`oldText has ${occurrences} matches; provide an exact unique match or replaceAll=true`, 'DEV_EDIT_MATCH')
      const next = current.split(oldText).join(newText)
      const sandbox = new EncodingSandbox(context)
      await io.writeFile(context, sandbox, { target: opened.target, content: next, exec: execution, policy, previousText: current }, 'edit')
      return { ...metadata, sha256: hash(await readFile(target, { signal })), previousHash: version, replacements: occurrences }
    } finally {
      state.clearSession(io.sessionKeyFor(execution))
      undo.clearSessionUndo(io.sessionKeyFor(execution))
      await context.fiber.dispose()
    }
  }
  return {
    status, csharp, logs, skills,
    read: (args, signal) => encodedFile(args, signal, false),
    edit: (args, signal) => encodedFile(args, signal, true),
    async close() { if (lspContext) { await lspContext.fiber.dispose(); lspContext = undefined } },
  }
}
