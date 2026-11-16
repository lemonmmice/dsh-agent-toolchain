/**
 * lib/capture-clients.mjs —— 多客户端捕获库：记录目录跟着「用户启动的客户端」切换。
 *
 * 配置与状态都放在捕获根目录（stateDir）下的 capture-clients.json（本机数据，不进仓库）：
 *   { version: 1, mode: 'auto' | 'manual', active: '<名称>', activeAt, activeReason,
 *     clients: [{ name, process: '<映像名>' | ['<映像名>', …], dir: '.' | '<相对 stateDir 的路径>' | '<绝对路径>' }] }
 *   · dir 省略 ⇒ clients/<名称>；'.' 或 '' ⇒ 捕获根目录本身（原来的那个库）。
 *   · 规则、证书、拦截状态、弱网、过滤器始终留在根目录（所有客户端共用一套）；只有记录（及基线 / 导出）按客户端分开。
 * 谁写 active：宿主里的 startClientWatcher 每 3 s 看一次在跑的进程，按 nextActive 算出当前客户端，变了才写文件；
 * MCP 进程只读这个文件。文件不存在 / 读不了 / 不合法 ⇒ 没有客户端（读的一方绝不抛），捕获库的行为与原来完全一样。
 */
import fs from 'node:fs'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'

export const CLIENTS_FILE = 'capture-clients.json'
export const CLIENTS_LIMITS = Object.freeze({ maxClients: 20, nameMax: 40, processMax: 10 })

/** 配置文件路径。 */
export const clientsFilePath = (stateDir) => path.join(stateDir, CLIENTS_FILE)

/** 映像名规范化：去路径（两种分隔符）、去 .exe、去首尾空白、小写。'' 表示无效。 */
export function procKey(name) {
  const base = path.win32.basename(String(name ?? '').trim())
  return base.replace(/\.exe$/i, '').trim().toLowerCase()
}

/** 控制字符换成空格（名称只用来显示 / 拼目录名）。 */
const withoutControls = (s) => [...s].map((ch) => (ch.charCodeAt(0) < 32 || ch.charCodeAt(0) === 127 ? ' ' : ch)).join('')
/** 目录名里只留安全字符。 */
const safeDirName = (name) => name.replace(/[^A-Za-z0-9._-]/g, '_')

function invalid(message) {
  const e = new Error(message)
  e.code = 'CLIENTS_INVALID'
  return e
}

/** 同一个目录（解析成绝对路径后比较；Windows 不区分大小写）。 */
export function sameDir(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a === '' || b === '') return false
  const x = path.resolve(a)
  const y = path.resolve(b)
  return process.platform === 'win32' ? x.toLowerCase() === y.toLowerCase() : x === y
}

/**
 * 规范化一个客户端：{ name, processes: string[]（规范化映像名）, dir（绝对路径）, spec: { name, process, dir? }（写回文件用的原样形式） }。
 * 不合法抛 CLIENTS_INVALID（写入路径直接把错误交给调用方；读路径跳过这一项并记下原因）。
 */
export function normalizeClient(raw, index, stateDir) {
  const where = `第 ${index + 1} 个客户端`
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) throw invalid(`${where}要写成对象 {name, process, dir?}`)
  for (const key of Object.keys(raw)) {
    if (!['name', 'process', 'dir'].includes(key)) throw invalid(`${where}：不认识的键「${key}」（只认 name / process / dir）`)
  }
  const name = typeof raw.name === 'string' ? withoutControls(raw.name).trim() : ''
  if (name === '' || name.length > CLIENTS_LIMITS.nameMax) throw invalid(`${where}：name 要是 1-${CLIENTS_LIMITS.nameMax} 个字符`)
  const list = Array.isArray(raw.process) ? raw.process : [raw.process]
  if (list.length === 0 || list.length > CLIENTS_LIMITS.processMax) throw invalid(`${where}（${name}）：process 要写 1-${CLIENTS_LIMITS.processMax} 个映像名`)
  const processes = []
  for (const p of list) {
    if (typeof p !== 'string') throw invalid(`${where}（${name}）：process 里只能是映像名字符串，如 "MyClient" 或 "MyClient.exe"`)
    const key = procKey(p)
    if (key === '') throw invalid(`${where}（${name}）：process 里有空的映像名`)
    if (!processes.includes(key)) processes.push(key)
  }
  if (raw.dir !== undefined && typeof raw.dir !== 'string') throw invalid(`${where}（${name}）：dir 要是字符串（'.' = 捕获根目录）`)
  const dirText = raw.dir === undefined ? `clients/${safeDirName(name)}` : raw.dir.trim()
  const dir = dirText === '' || dirText === '.' ? path.resolve(stateDir) : path.resolve(stateDir, dirText)
  const spec = { name, process: Array.isArray(raw.process) ? list.map((p) => String(p).trim()) : String(raw.process).trim() }
  if (raw.dir !== undefined) spec.dir = dirText
  return { name, processes, dir, spec }
}

/** 校验整张列表（写入用，严格）：名称不重复、同一个映像名不能分给两个客户端。 */
export function normalizeClients(list, stateDir) {
  if (!Array.isArray(list)) throw invalid('clients 要是数组：[{ name, process, dir? }, …]')
  if (list.length > CLIENTS_LIMITS.maxClients) throw invalid(`客户端最多 ${CLIENTS_LIMITS.maxClients} 个`)
  const out = []
  list.forEach((raw, i) => {
    const c = normalizeClient(raw, i, stateDir)
    const dupName = out.find((o) => o.name.toLowerCase() === c.name.toLowerCase())
    if (dupName) throw invalid(`第 ${i + 1} 个客户端：名称「${c.name}」重复`)
    const dupProc = out.find((o) => o.processes.some((p) => c.processes.includes(p)))
    if (dupProc) throw invalid(`第 ${i + 1} 个客户端（${c.name}）：映像名已经分给了「${dupProc.name}」`)
    out.push(c)
  })
  return out
}

const emptyConfig = (error) => ({ clients: [], mode: 'auto', active: null, activeAt: null, activeReason: null, error })

/** 读路径：容错（坏的客户端跳过，原因写进 error），永不抛。 */
function parseConfig(raw, stateDir) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return emptyConfig(`${CLIENTS_FILE} 不是 JSON 对象`)
  const clients = []
  const errors = []
  const list = Array.isArray(raw.clients) ? raw.clients.slice(0, CLIENTS_LIMITS.maxClients) : []
  list.forEach((entry, i) => {
    try {
      const c = normalizeClient(entry, i, stateDir)
      if (clients.some((o) => o.name.toLowerCase() === c.name.toLowerCase())) throw invalid(`第 ${i + 1} 个客户端：名称「${c.name}」重复`)
      if (clients.some((o) => o.processes.some((p) => c.processes.includes(p)))) throw invalid(`第 ${i + 1} 个客户端（${c.name}）：映像名与前面的客户端重复`)
      clients.push(c)
    } catch (e) {
      errors.push(e && e.message ? e.message : String(e))
    }
  })
  return {
    clients,
    mode: raw.mode === 'manual' ? 'manual' : 'auto',
    active: typeof raw.active === 'string' && raw.active !== '' ? raw.active : null,
    activeAt: Number.isFinite(raw.activeAt) ? raw.activeAt : null,
    activeReason: typeof raw.activeReason === 'string' ? raw.activeReason : null,
    error: errors.length > 0 ? errors.join('；') : null,
  }
}

const cache = new Map()

/** 读配置（按 路径 + mtime + 大小 缓存，每次只花一次 stat）。永不抛：没有文件 / 坏文件 ⇒ clients: []。 */
export function loadClientsConfig(stateDir) {
  const file = clientsFilePath(stateDir)
  let st = null
  try {
    st = fs.statSync(file)
  } catch {
    cache.delete(file)
    return emptyConfig(null)
  }
  const key = `${st.mtimeMs}:${st.size}`
  const hit = cache.get(file)
  if (hit !== undefined && hit.key === key) return hit.value
  let value
  try {
    let text = fs.readFileSync(file, 'utf8')
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1)
    value = parseConfig(JSON.parse(text), stateDir)
  } catch (e) {
    value = emptyConfig(`读不了 ${CLIENTS_FILE}：${e && e.message ? e.message : String(e)}`)
  }
  cache.set(file, { key, value })
  return value
}

/** 当前客户端：active 指名的那个（名称不区分大小写）；没有 / 不认识 ⇒ 第一个客户端；一个客户端都没有 ⇒ null。 */
export function activeClientOf(cfg) {
  if (!cfg || !Array.isArray(cfg.clients) || cfg.clients.length === 0) return null
  const want = typeof cfg.active === 'string' ? cfg.active.toLowerCase() : ''
  return cfg.clients.find((c) => c.name.toLowerCase() === want) ?? cfg.clients[0]
}

/** 按映像名找客户端；找不到 null。 */
export function clientForProcess(cfg, processName) {
  const key = procKey(processName)
  if (key === '' || !cfg || !Array.isArray(cfg.clients)) return null
  return cfg.clients.find((c) => c.processes.includes(key)) ?? null
}

const sleepSync = (ms) => {
  try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms) } catch { /* ignore */ }
}

/** 原子写：同目录临时文件 + rename（Windows 上目标被占用时重试几次）；失败时删掉临时文件。 */
function writeAtomic(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}-${randomUUID().slice(0, 8)}.tmp`
  fs.writeFileSync(tmp, text, { encoding: 'utf8', flag: 'wx' })
  try {
    for (let attempt = 0; ; attempt++) {
      try {
        fs.renameSync(tmp, file)
        return
      } catch (e) {
        if (attempt >= 5 || !['EPERM', 'EBUSY', 'EACCES'].includes(e && e.code)) throw e
        sleepSync(20 * (attempt + 1))
      }
    }
  } catch (e) {
    try { fs.rmSync(tmp, { force: true }) } catch { /* ignore */ }
    throw e
  }
}

/**
 * 写配置：patch = { clients?, mode?, active?, activeAt?, activeReason? }。
 * clients 整张替换（严格校验）；mode 只能 auto / manual；active 必须是已配置的客户端名（或 null = 跟随第一个）。
 * 文件存在但读不出来时，只有带了 clients（整张重写）才允许覆盖，否则抛 CLIENTS_INVALID（不悄悄冲掉用户手改的内容）。
 * 返回写后的配置（loadClientsConfig 的形状）。
 */
export function saveClientsConfig(stateDir, patch = {}) {
  if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) throw invalid('要写成对象 { active?, mode?, clients? }')
  const file = clientsFilePath(stateDir)
  let current = null
  if (fs.existsSync(file)) {
    try {
      let text = fs.readFileSync(file, 'utf8')
      if (text.charCodeAt(0) === 0xfeff) text = text.slice(1)
      current = JSON.parse(text)
      if (current === null || typeof current !== 'object' || Array.isArray(current)) throw new Error('不是 JSON 对象')
    } catch (e) {
      if (patch.clients === undefined) throw invalid(`${CLIENTS_FILE} 读不出来（${e && e.message ? e.message : e}），先修好它，或带上完整的 clients 重写`)
      current = null
    }
  }
  const base = current ?? { version: 1, mode: 'auto', clients: [] }
  let specs = Array.isArray(base.clients) ? base.clients : []
  let clients
  if (patch.clients !== undefined) {
    clients = normalizeClients(patch.clients, stateDir)
    specs = clients.map((c) => c.spec)
  } else {
    clients = parseConfig({ clients: specs }, stateDir).clients
  }
  let mode = base.mode === 'manual' ? 'manual' : 'auto'
  if (patch.mode !== undefined) {
    if (patch.mode !== 'auto' && patch.mode !== 'manual') throw invalid("mode 只能是 'auto'（跟随启动的客户端）或 'manual'（锁定 active）")
    mode = patch.mode
  }
  let active = typeof base.active === 'string' && base.active !== '' ? base.active : null
  let activeAt = Number.isFinite(base.activeAt) ? base.activeAt : null
  let activeReason = typeof base.activeReason === 'string' ? base.activeReason : null
  if (patch.active !== undefined) {
    if (patch.active === null || patch.active === '') {
      active = null
    } else {
      if (typeof patch.active !== 'string') throw invalid('active 要是客户端名称')
      const found = clients.find((c) => c.name.toLowerCase() === patch.active.trim().toLowerCase())
      if (!found) throw invalid(`没有名为「${patch.active}」的客户端（已配置：${clients.map((c) => c.name).join('、') || '无'}）`)
      active = found.name
    }
    activeAt = Number.isFinite(patch.activeAt) ? patch.activeAt : Date.now()
    activeReason = typeof patch.activeReason === 'string' ? patch.activeReason : 'manual'
  }
  if (active !== null && !clients.some((c) => c.name === active)) active = null
  const out = { ...base, version: 1, mode, active, activeAt, activeReason, clients: specs }
  writeAtomic(file, JSON.stringify(out, null, 2) + '\n')
  cache.delete(file)
  return loadClientsConfig(stateDir)
}

/**
 * 纯函数：根据这一轮在跑的映像名算下一个「当前客户端」。
 *   order = 在跑的客户端，最近启动的在前（调用方在两轮之间保存）；wasRunning = 上一轮在跑的客户端名集合（首轮传 null）。
 *   · 首轮：order = 在跑的客户端，原来的 active 排第一，其余按配置顺序（不知道谁先启动的）。
 *   · 之后：新出现的客户端插到最前（同一轮出现多个按配置顺序），退出的移除。
 *   · auto：有客户端在跑 ⇒ active = order[0]；一个都没在跑 ⇒ 保持原来的（关掉客户端后还能接着看它的记录）。
 *   · manual：active 不变（仍然算 order / running，给界面显示）。
 * 返回 { active, order, running: Set<名称>, changed, reason }。
 */
export function nextActive({ clients, mode = 'auto', active = null, order = [], wasRunning = null, running }) {
  const list = Array.isArray(clients) ? clients : []
  const runningKeys = running instanceof Set ? running : new Set(running ?? [])
  const runningNow = new Set(list.filter((c) => c.processes.some((p) => runningKeys.has(p))).map((c) => c.name))
  const current = activeClientOf({ clients: list, active })
  const currentName = current === null ? null : current.name
  let nextOrder
  let reason
  if (wasRunning === null) {
    const first = currentName !== null && runningNow.has(currentName) ? [currentName] : []
    nextOrder = [...first, ...list.map((c) => c.name).filter((n) => runningNow.has(n) && !first.includes(n))]
    reason = 'scan'
  } else {
    const started = list.map((c) => c.name).filter((n) => runningNow.has(n) && !wasRunning.has(n))
    const kept = order.filter((n) => runningNow.has(n) && !started.includes(n))
    const rest = list.map((c) => c.name).filter((n) => runningNow.has(n) && !started.includes(n) && !kept.includes(n))
    nextOrder = [...started, ...kept, ...rest]
    if (started.length > 0) reason = `started:${started[0]}`
    else if (currentName !== null && wasRunning.has(currentName) && !runningNow.has(currentName)) reason = `exited:${currentName}`
    else reason = 'running'
  }
  let nextName = currentName
  if (mode !== 'manual' && nextOrder.length > 0) nextName = nextOrder[0]
  const changed = nextName !== null && (typeof active !== 'string' || active.toLowerCase() !== nextName.toLowerCase())
  return { active: nextName, order: nextOrder, running: runningNow, changed, reason }
}

/** 默认的进程列表：`tasklist /FO CSV /NH` 的第一列（映像名）。失败返回 null（这一轮跳过，不当成「都没在跑」）。 */
export function listProcessesTasklist({ timeoutMs = 5000 } = {}) {
  if (process.platform !== 'win32') return Promise.resolve(null)
  const exe = path.join(process.env.SystemRoot || process.env.windir || 'C:/Windows', 'System32', 'tasklist.exe')
  return new Promise((resolve) => {
    execFile(fs.existsSync(exe) ? exe : 'tasklist', ['/FO', 'CSV', '/NH'], { windowsHide: true, timeout: timeoutMs, encoding: 'latin1', maxBuffer: 16 * 1024 * 1024 }, (error, stdout) => {
      if (error) { resolve(null); return }
      const names = []
      for (const line of String(stdout).split('\n')) {
        const t = line.trim()
        if (!t.startsWith('"')) continue
        const end = t.indexOf('"', 1)
        if (end > 1) names.push(t.slice(1, end))
      }
      resolve(names.length > 0 ? names : null)
    })
  })
}

/**
 * 宿主用的轮询器：每 intervalMs 看一次在跑的进程，当前客户端变了就写回配置并回调 onChange({ from, to, reason })。
 * 环境变量 DSH_API_CAPTURE_CLIENT_WATCH=off 时什么都不做（自测用）。返回 { stop(), status(), tick() }。
 */
export function startClientWatcher({ stateDir, listProcesses = listProcessesTasklist, intervalMs = 3000, onChange = null } = {}) {
  const st = { running: false, disabled: false, lastScanAt: null, lastChangeAt: null, lastError: null, runningClients: [], order: [] }
  if (String(process.env.DSH_API_CAPTURE_CLIENT_WATCH ?? '').trim().toLowerCase() === 'off') {
    st.disabled = true
    return { stop() {}, status: () => ({ ...st }), tick: async () => {} }
  }
  let stopped = false
  let busy = false
  let order = []
  let wasRunning = null
  const dirOf = () => (typeof stateDir === 'function' ? stateDir() : stateDir)
  const tick = async () => {
    if (busy || stopped) return
    busy = true
    try {
      const dir = dirOf()
      const cfg = loadClientsConfig(dir)
      if (cfg.clients.length === 0) {
        order = []
        wasRunning = null
        st.runningClients = []
        st.order = []
        st.lastScanAt = Date.now()
        return
      }
      const names = await listProcesses()
      if (stopped) return
      if (!Array.isArray(names)) throw new Error('读不到进程列表（tasklist 失败），这一轮跳过')
      const r = nextActive({ clients: cfg.clients, mode: cfg.mode, active: cfg.active, order, wasRunning, running: new Set(names.map(procKey).filter(Boolean)) })
      order = r.order
      wasRunning = r.running
      st.runningClients = [...r.running]
      st.order = [...r.order]
      st.lastScanAt = Date.now()
      st.lastError = null
      if (r.changed) {
        const from = activeClientOf(cfg)
        saveClientsConfig(dir, { active: r.active, activeAt: Date.now(), activeReason: r.reason })
        st.lastChangeAt = Date.now()
        if (typeof onChange === 'function') {
          try { onChange({ from: from === null ? null : from.name, to: r.active, reason: r.reason }) } catch { /* 回调出错不影响轮询 */ }
        }
      }
    } catch (e) {
      st.lastError = e && e.message ? e.message : String(e)
      st.lastScanAt = Date.now()
    } finally {
      busy = false
    }
  }
  st.running = true
  const timer = setInterval(tick, intervalMs)
  if (typeof timer.unref === 'function') timer.unref()
  tick()
  return {
    stop() {
      stopped = true
      st.running = false
      clearInterval(timer)
    },
    status: () => ({ ...st, runningClients: [...st.runningClients], order: [...st.order] }),
    tick,
  }
}
