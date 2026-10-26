import { createRequire } from 'node:module'
import { readFile, stat, mkdir, writeFile } from 'node:fs/promises'
import { dirname, join, resolve, isAbsolute } from 'node:path'
import { pathToFileURL } from 'node:url'
import { randomUUID } from 'node:crypto'

const fail = (message, code = 'DEV_ADDON_INVALID') => Object.assign(new Error(message), { code })
function required(value, name) {
  if (typeof value !== 'string' || !value.trim()) throw fail(`${name} must be a nonempty string`)
  return value
}

export function createRecommendedRuntime(options) {
  const profileDir = resolve(options.profileDir)
  const requireProfile = createRequire(join(profileDir, 'package.json'))
  const importFile = file => import(pathToFileURL(file).href)
  function rootOf(name) {
    try { return dirname(requireProfile.resolve(name + '/package.json')) }
    catch (error) { throw fail(`Cannot locate ${name} in ${profileDir}: ${error.code}`, 'DEV_ADDON_MISSING') }
  }
  const importHost = name => importFile(requireProfile.resolve(name))
  let docsReady
  async function context7() {
    rootOf('dsh-mcp-context7')
    if (!docsReady) {
      docsReady = (async () => {
        const [{ Context }, { default: SystemPrompt }, { default: ToolRuntime }, bridge] = await Promise.all([
          importHost('@deepseek-ai/cordis'), importHost('@deepseek-ai/dsh-system-prompt'), importHost('@deepseek-ai/dsh-tools'), importHost('@deepseek-ai/dsh-mcp-client'),
        ])
        const context = new Context()
        try {
          await context.plugin(SystemPrompt)
          await context.plugin(ToolRuntime)
          await context.plugin(bridge, { serverName: 'toolchain_context7', transport: 'streamable-http', url: 'https://mcp.context7.com/mcp', headers: process.env.CONTEXT7_API_KEY ? { Authorization: 'Bearer ' + process.env.CONTEXT7_API_KEY } : {}, toolCallTimeoutMs: 60000, failOnStartupError: true, reconnect: { enabled: false } })
          return context
        } catch (error) {
          await context.fiber.dispose()
          throw error
        }
      })()
      docsReady.catch(() => { docsReady = undefined })
    }
    return docsReady
  }
  async function docs(tool, parameters, signal) {
    const context = await context7()
    const deadline = AbortSignal.timeout(60000)
    const result = await context.tools.execute({ name: 'mcp__toolchain_context7__' + tool, callId: randomUUID(), arguments: parameters, signal: signal ? AbortSignal.any([signal, deadline]) : deadline })
    const text = (result.content || []).filter(block => block.type === 'text').map(block => block.text).join('\n')
    if (result.isError) throw fail(text || JSON.stringify(result.error), 'DEV_CONTEXT7_FAILED')
    return { source: 'https://mcp.context7.com/mcp', text: text.slice(0, 60000), truncated: text.length > 60000, note: 'Library/version coverage is determined by the returned source. Do not infer old-framework support from newer examples.' }
  }
  async function vision(args, signal) {
    const beforePath = required(args.before, 'before')
    const afterPath = required(args.after, 'after')
    if (!isAbsolute(beforePath) || !isAbsolute(afterPath)) throw fail('before and after must be absolute PNG paths')
    const threshold = args.threshold ?? 0
    if (!Number.isInteger(threshold) || threshold < 0 || threshold > 255) throw fail('threshold must be 0–255')
    const ignore = args.ignoreJson === undefined ? [] : JSON.parse(args.ignoreJson)
    if (!Array.isArray(ignore) || ignore.length > 100) throw fail('ignoreJson must be an array of at most 100 rectangles')
    const root = rootOf('dsh-vision-diff')
    const [png, diff, html] = await Promise.all(['png.js', 'diff.js', 'html.js'].map(file => importFile(join(root, 'lib', file))))
    async function load(file) {
      const metadata = await stat(file)
      if (!metadata.isFile() || metadata.size > 64 * 1024 * 1024) throw fail('Input must be a regular PNG up to 64 MiB')
      const bytes = await readFile(file, { signal })
      const header = png.readPngHeader(bytes)
      if (header.width * header.height > 16000000) throw fail('Input exceeds 16 million pixels')
      return { bytes, image: png.decodePng(bytes) }
    }
    const before = await load(beforePath)
    const after = await load(afterPath)
    signal?.throwIfAborted()
    const outcome = diff.diffImages(before.image, after.image, { threshold, ignore, withImage: true, regionLimit: 20 })
    if (outcome.report.ignoreRejected?.length) throw fail('Invalid ignore rectangle: ' + outcome.report.ignoreRejected.join('; '))
    const outputRoot = options.evidenceDir || process.env.DSH_VISION_DIFF_DIR || resolve(profileDir, '..', '..', 'vision-diff', 'mcp')
    const directory = join(outputRoot, randomUUID())
    await mkdir(directory, { recursive: true })
    const difference = png.encodePng(outcome.diffImage)
    const reportPath = join(directory, 'report.json')
    const imagePath = join(directory, 'diff.png')
    const htmlPath = join(directory, 'index.html')
    await writeFile(reportPath, JSON.stringify(outcome.report, null, 2))
    await writeFile(imagePath, difference)
    await writeFile(htmlPath, html.comparePage({ report: outcome.report, before: before.bytes, after: after.bytes, diff: difference, meta: { before: beforePath, after: afterPath, label: args.label || '' } }))
    return { ...outcome.report, artifacts: { report: reportPath, image: imagePath, html: htmlPath }, note: 'Pixel differences describe change, not whether the new UI is correct.' }
  }
  async function precheck(args, signal) {
    const spec = required(args.spec, 'spec')
    let manifest
    let source
    if (isAbsolute(spec)) {
      const metadata = await stat(spec)
      source = metadata.isDirectory() ? join(spec, 'package.json') : spec
      if ((await stat(source)).size > 1024 * 1024) throw fail('Manifest exceeds 1 MiB')
      manifest = JSON.parse(await readFile(source, { encoding: 'utf8', signal }))
    } else {
      const match = spec.match(/^(@[a-z0-9._-]+\/[a-z0-9._-]+|[a-z0-9._-]+)(?:@([a-z0-9.+_-]+))?$/i)
      if (!match) throw fail('spec must be an absolute manifest/directory or npm package[@version]')
      source = 'https://registry.npmjs.org/' + encodeURIComponent(match[1]) + '/' + (match[2] || 'latest')
      const deadline = AbortSignal.timeout(20000)
      const response = await fetch(source, { signal: signal ? AbortSignal.any([signal, deadline]) : deadline })
      if (!response.ok) throw fail('npm metadata returned HTTP ' + response.status, 'DEV_PRECHECK_FETCH_FAILED')
      manifest = await response.json()
    }
    const pipeline = await importFile(join(rootOf('dsh-plugin-precheck'), 'lib', 'pipeline.js'))
    if (typeof pipeline.checkPackageMeta !== 'function') throw fail('The installed precheck package lacks the locally verified metadata entry', 'DEV_PRECHECK_ADAPTER_MISSING')
    const hostRoot = rootOf('@deepseek-ai/dsh')
    const host = JSON.parse(await readFile(join(hostRoot, 'package.json'), 'utf8'))
    const job = { findings: [], env: { dshVersion: host.version } }
    pipeline.checkPackageMeta(job, manifest, profileDir, join(hostRoot, 'node_modules'))
    const blocked = job.findings.some(finding => finding.level === 'error')
    const unknown = job.findings.some(finding => finding.level === 'unknown' || finding.level === 'risk')
    return { name: manifest.name, version: manifest.version, source, hostVersion: host.version, verdict: blocked ? 'blocked' : unknown ? 'incomplete' : 'compatible-metadata', findings: job.findings, scope: 'metadata-only', trialBoot: 'not-run', note: 'No package installation or scripts are executed. Full isolated trial remains available in the DSH precheck panel.' }
  }
  return {
    docsSearch: (args, signal) => docs('resolve-library-id', { libraryName: required(args.libraryName, 'libraryName'), query: required(args.query, 'query') }, signal),
    docsRead: (args, signal) => docs('query-docs', { libraryId: required(args.libraryId, 'libraryId'), query: required(args.query, 'query'), ...(args.language ? { language: args.language } : {}) }, signal),
    vision, precheck,
    async close() { if (docsReady) { const context = await docsReady; await context.fiber.dispose(); docsReady = undefined } },
  }
}
