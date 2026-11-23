import { createHash, randomBytes } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync, openSync, closeSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'
import { envOr } from './env-fallback.mjs'

const root = fileURLToPath(new URL('../', import.meta.url))
let starting = null

export function standaloneSettings() {
  const directory = envOr('DSH_CAPTURE_SERVICE_DIR') || join(homedir(), '.dsh-agent-toolchain', 'capture-service')
  const port = Number(envOr('DSH_CAPTURE_SERVICE_PORT') || 3081)
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('DSH_CAPTURE_SERVICE_PORT must be 1024–65535')
  const configuration = Object.fromEntries(['DSH_API_CAPTURE_STORE', 'DSH_CAPTURE_LOG', 'DSH_CAPTURE_CALLER_LOG', 'DSH_UI_PROC_NAME', 'DSH_UI_CLIENT_EXE'].map(key => [key, envOr(key) || '']))
  const identity = createHash('sha256').update(JSON.stringify({ root, configuration })).digest('hex')
  return { directory, port, identity, url: 'http://127.0.0.1:' + port }
}

export async function serviceToken(settings) {
  mkdirSync(settings.directory, { recursive: true })
  const path = join(settings.directory, 'token')
  try { writeFileSync(path, randomBytes(32).toString('hex'), { flag: 'wx', mode: 0o600 }) }
  catch (error) { if (error.code !== 'EEXIST') throw error }
  for (let attempt = 0; attempt < 10; attempt++) {
    const token = readFileSync(path, 'utf8').trim()
    if (/^[a-f0-9]{64}$/.test(token)) return token
    await new Promise(resolve => setTimeout(resolve, 30))
  }
  throw new Error('Invalid capture service token file: ' + path)
}

async function health(settings, token, requireIdentity = true) {
  let response
  try {
    response = await fetch(settings.url + '/health', {
      headers: { authorization: 'Bearer ' + token }, signal: AbortSignal.timeout(1000),
    })
  } catch (error) {
    if (error.cause?.code === 'ECONNREFUSED') return null
    throw new Error('Capture service health unavailable; existing process was not replaced', { cause: error })
  }
  const data = await response.json().catch(() => null)
  if (!response.ok || data?.service !== 'dsh-capture' || (requireIdentity && data.identity !== settings.identity)) {
    throw new Error('Capture service port is occupied or its configuration changed. Stop the previous standalone service before reinstalling, or choose another DSH_CAPTURE_SERVICE_PORT.')
  }
  return data.ready ? data : null
}

export async function ensureStandalone() {
  if (starting) return starting
  starting = (async () => {
    const settings = standaloneSettings()
    const token = await serviceToken(settings)
    if (await health(settings, token)) return { ...settings, token }
    const log = openSync(join(settings.directory, 'service.log'), 'a')
    try {
      const child = spawn(process.execPath, [join(root, 'mcp', 'capture-service.mjs')], {
        cwd: root, env: { ...process.env }, detached: true, windowsHide: true, stdio: ['ignore', log, log],
      })
      await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject) })
      child.unref()
    } finally { closeSync(log) }
    for (let attempt = 0; attempt < 100; attempt++) {
      await new Promise(resolve => setTimeout(resolve, 100))
      if (await health(settings, token)) return { ...settings, token }
    }
    throw new Error('Standalone capture service did not become ready. See ' + join(settings.directory, 'service.log'))
  })()
  try { return await starting } finally { starting = null }
}

export async function captureHostRequest(method, path, body = null, timeoutMs = null) {
  try {
    const standalone = envOr('DSH_CAPTURE_BACKEND') === 'standalone'
    const service = standalone ? await ensureStandalone() : { url: 'http://127.0.0.1:3080' }
    const response = await fetch(service.url + '/api/dsh-api-visualizer' + path, {
      method,
      headers: { ...(service.token ? { authorization: 'Bearer ' + service.token } : {}), ...(body === null ? {} : { 'content-type': 'application/json' }) },
      body: body === null ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs ?? (method === 'GET' ? 5000 : 20000)),
    })
    const data = await response.json().catch(() => null)
    if (data === null) return { ok: false, httpStatus: response.status, error: 'Capture service returned non-JSON' }
    return { ...data, httpStatus: response.status, backend: standalone ? 'standalone' : 'dsh', ...(response.ok ? (data.ok === undefined ? { ok: true } : {}) : { ok: false }) }
  } catch (error) {
    return { ok: false, state: 'unavailable', error: error.message, hint: envOr('DSH_CAPTURE_BACKEND') === 'standalone' ? 'Check capture-service/service.log and the configured port.' : 'Start DSH, or install the standalone package (DSH_CAPTURE_BACKEND=standalone).' }
  }
}

export async function stopStandalone() {
  const settings = standaloneSettings()
  const token = await serviceToken(settings)
  const current = await health(settings, token, false)
  if (!current) return { ok: true, stopped: false }
  const response = await fetch(settings.url + '/shutdown', { method: 'POST', headers: { authorization: 'Bearer ' + token }, signal: AbortSignal.timeout(15000) })
  if (!response.ok) throw new Error('Capture service refused shutdown. Stop active capture/proxy/interception and retry.')
  return response.json()
}
