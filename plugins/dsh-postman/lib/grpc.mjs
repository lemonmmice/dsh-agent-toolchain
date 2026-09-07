/**
 * dsh-postman — host-side gRPC caller.
 *
 * Loads a user-supplied .proto (written to a temp file), lists services /
 * methods, and performs unary calls with metadata. Uses @grpc/grpc-js +
 * @grpc/proto-loader (vendored into node_modules; pure JS, no native build).
 * grpc is imported lazily so a grpc problem can never block host boot.
 */

import { writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'

const LOAD_OPTS = { keepCase: true, longs: String, enums: String, defaults: true, oneofs: true }

let _grpc = null
let _loader = null
async function load() {
  if (_grpc === null) {
    _grpc = (await import('@grpc/grpc-js')).default
    _loader = (await import('@grpc/proto-loader')).default
  }
  return { grpc: _grpc, protoLoader: _loader }
}

function writeProto(text) {
  const file = join(tmpdir(), 'dsh-postman-' + randomUUID() + '.proto')
  writeFileSync(file, String(text ?? ''), 'utf8')
  return file
}
function rmProto(file) {
  try {
    rmSync(file, { force: true })
  } catch {
    // ignore
  }
}

/** Navigate a loaded package by a dotted service name. */
function findService(pkg, name) {
  let cur = pkg
  for (const part of String(name).split('.')) {
    cur = cur?.[part]
    if (cur === undefined) return null
  }
  return cur ?? null
}

/** Resolve the client instance method (original or camelCase name). */
function clientMethod(client, method) {
  if (typeof client[method] === 'function') return client[method].bind(client)
  const cc = method.charAt(0).toLowerCase() + method.slice(1)
  if (typeof client[cc] === 'function') return client[cc].bind(client)
  return null
}

/** List services + methods declared in a proto. */
export async function listMethods(protoText) {
  const { grpc, protoLoader } = await load()
  const file = writeProto(protoText)
  try {
    const pkg = grpc.loadPackageDefinition(protoLoader.loadSync(file, LOAD_OPTS))
    const services = []
    const walk = (obj, prefix) => {
      for (const [key, val] of Object.entries(obj)) {
        const full = prefix ? prefix + '.' + key : key
        if (typeof val === 'function' && val.service) {
          services.push({
            name: full,
            methods: Object.entries(val.service).map(([mname, m]) => ({
              name: mname,
              requestStream: !!m.requestStream,
              responseStream: !!m.responseStream,
            })),
          })
        } else if (val !== null && typeof val === 'object' && Object.getPrototypeOf(val) === Object.prototype) {
          walk(val, full)
        }
      }
    }
    walk(pkg, '')
    return { services }
  } finally {
    rmProto(file)
  }
}

/**
 * Perform a unary gRPC call.
 * @param spec - { protoText, target, service, method, request(JSON string|object), metadata?, tls?, deadlineMs? }
 * @returns { ok:true, durationMs, response } | { ok:false, error, code? }
 */
export async function unaryCall(spec) {
  const { grpc, protoLoader } = await load()
  const file = writeProto(spec.protoText)
  let client = null
  try {
    const pkg = grpc.loadPackageDefinition(protoLoader.loadSync(file, LOAD_OPTS))
    const ServiceCtor = findService(pkg, spec.service || '')
    if (typeof ServiceCtor !== 'function' || !ServiceCtor.service) return { ok: false, error: 'service not found: ' + spec.service }
    const methodDef = ServiceCtor.service[spec.method]
    if (methodDef === undefined) return { ok: false, error: 'method not found: ' + spec.method }
    if (methodDef.requestStream || methodDef.responseStream) return { ok: false, error: '目前仅支持 unary（非流式）方法' }

    let request = {}
    if (typeof spec.request === 'string' && spec.request.trim() !== '') {
      try {
        request = JSON.parse(spec.request)
      } catch (e) {
        return { ok: false, error: '请求 JSON 解析失败: ' + (e instanceof Error ? e.message : String(e)) }
      }
    } else if (spec.request !== null && typeof spec.request === 'object') {
      request = spec.request
    }

    const creds = spec.tls === true ? grpc.credentials.createSsl() : grpc.credentials.createInsecure()
    client = new ServiceCtor(String(spec.target || ''), creds)
    const fn = clientMethod(client, spec.method)
    if (fn === null) return { ok: false, error: 'client method missing: ' + spec.method }

    const md = new grpc.Metadata()
    if (spec.metadata !== null && typeof spec.metadata === 'object') {
      for (const [k, v] of Object.entries(spec.metadata)) md.set(k, String(v))
    }
    const deadline = new Date(Date.now() + (Number(spec.deadlineMs) || 20000))
    const started = Date.now()
    const result = await new Promise((resolve) => {
      fn(request, md, { deadline }, (err, response) => {
        if (err) resolve({ ok: false, code: err.code, error: err.details || err.message || String(err) })
        else resolve({ ok: true, response })
      })
    })
    result.durationMs = Date.now() - started
    return result
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  } finally {
    if (client !== null && typeof client.close === 'function') {
      try {
        client.close()
      } catch {
        // ignore
      }
    }
    rmProto(file)
  }
}
