import { createServer } from 'node:http'
import { timingSafeEqual } from 'node:crypto'
import { standaloneSettings, serviceToken } from '../lib/capture-host.mjs'
import { createCapture, createProxy, makeRoutes, watchCaptureClients } from '../plugins/dsh-api-visualizer/lib/index.js'

const settings = standaloneSettings()
const token = await serviceToken(settings)
let routes = []
let ready = false
let capture
let proxy
let watcher
let closing = false

async function close() {
  if (closing) return
  closing = true
  ready = false
  watcher?.stop()
  capture?.dispose()
  await proxy?.dispose()
  if (server.listening) {
    server.close()
    server.closeIdleConnections()
  }
}

const server = createServer(async (request, response) => {
  const supplied = Buffer.from(request.headers.authorization || '')
  const expected = Buffer.from('Bearer ' + token)
  const authorized = supplied.length === expected.length && timingSafeEqual(supplied, expected)
  const send = (status, value) => {
    response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' })
    response.end(JSON.stringify(value))
  }
  if (!authorized || request.headers.origin || request.headers['sec-fetch-site'] === 'cross-site') return send(403, { ok: false, error: 'Forbidden' })
  if (request.url === '/health' && request.method === 'GET') return send(200, { service: 'dsh-capture', identity: settings.identity, ready, pid: process.pid })
  if (request.url === '/shutdown' && request.method === 'POST') {
    const proxyState = proxy?.status()
    if (capture?.status().running || proxyState?.running || proxyState?.intercept?.active) {
      return send(409, { ok: false, error: 'Stop capture, proxy and interception before shutting down the service.' })
    }
    try { await close(); send(200, { ok: true, stopped: true }) }
    catch (error) { send(500, { ok: false, error: error.message }) }
    return
  }
  if (!ready) return send(503, { ok: false, error: 'Capture service is starting' })
  const route = routes.find(candidate => request.url.split('?')[0].startsWith(candidate.path))
  if (!route) return send(404, { ok: false, error: 'Unknown capture route' })
  try { await route.handler(request, response) }
  catch (error) {
    console.error(error)
    if (!response.headersSent) send(500, { ok: false, error: error.message })
    else response.destroy()
  }
})

try {
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(settings.port, '127.0.0.1', resolve)
  })
  capture = createCapture()
  proxy = createProxy()
  capture.setDedupe(record => proxy.claimDuplicate(record), (recordId, caller) => proxy.attachCaller(recordId, caller))
  await proxy.recover()
  watcher = watchCaptureClients(() => {})
  routes = makeRoutes(capture, proxy)
  ready = true
  console.error('Standalone capture service ready, pid=' + process.pid)
  process.once('SIGINT', () => void close())
  process.once('SIGTERM', () => void close())
} catch (error) {
  if (error.code !== 'EADDRINUSE') console.error(error)
  await close()
  process.exitCode = error.code === 'EADDRINUSE' ? 0 : 1
}
