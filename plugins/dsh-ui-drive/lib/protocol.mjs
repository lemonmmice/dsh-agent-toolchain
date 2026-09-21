import { createHash, randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { stableStringify } from './evidence.mjs'
import { canonicalExe } from './policy.mjs'

export const PROTOCOL_VERSION = 1
const REDACTED = '[redacted]'
const TRANSIENT_FIELDS = new Set(['approvalId', 'sessionId', 'procId', 'pid', 'windowHandle', 'winHandle', 'handle', 'expectedWindowHandle', 'snapshotId', 'expectedRect'])
export function protocolId(prefix) { return prefix + '_' + randomUUID() }
export function contentHash(value) {
  const normalized = typeof value === 'string' || Buffer.isBuffer(value) ? value : stableStringify(JSON.parse(JSON.stringify(value ?? null)))
  return 'sha256:' + createHash('sha256').update(normalized).digest('hex')
}

function observationDigest(observation) {
  const { digest, ...body } = observation
  return contentHash({ ...body, observationId: null, actionId: null, at: null })
}

export function observationOf(result, actionId) {
  if (!result || result.ok !== true) return null
  const observation = {
    version: PROTOCOL_VERSION, observationId: protocolId('obs'), actionId: actionId || null, at: new Date().toISOString(),
    snapshotId: result.snapshotId || null, window: result.window ?? null,
    count: result.count ?? null, lines: Array.isArray(result.lines) ? result.lines : null,
    focused: result.focused ?? null, truncated: result.truncated === true,
    skipped: result.skipped ?? null, path: result.path || null, frameHash: null,
    authoritative: Boolean(result.snapshotId), untrustedContent: true,
  }
  if (observation.path) {
    try { observation.frameHash = contentHash(readFileSync(observation.path)) }
    catch (error) { observation.frameError = error.code || error.message }
  }
  observation.digest = observationDigest(observation)
  return observation
}

export function redactForRecord(value, secret = false) {
  if (Array.isArray(value)) return value.map(item => redactForRecord(item, secret))
  if (!value || typeof value !== 'object') return value
  const sensitive = secret || value.secret === true
  const inputAction = ['setvalue', 'key', 'type'].includes(String(value.action || '').toLowerCase())
  const observationRecord = value.version === PROTOCOL_VERSION && typeof value.observationId === 'string' && typeof value.digest === 'string'
  const result = {}
  for (const [key, item] of Object.entries(value)) {
    if (key.startsWith('__') || (TRANSIENT_FIELDS.has(key) && !(observationRecord && key === 'snapshotId'))) continue
    if (['value', 'keys', 'expectValue'].includes(key) && item != null && (sensitive || inputAction)) {
      result[key] = /^\$\{cred:[^}]+\}$/.test(String(item)) ? item : REDACTED
    } else if (sensitive && ['output', 'detail', 'error', 'lines', 'focused'].includes(key)) {
      result[key] = Array.isArray(item) ? ['[redacted]'] : '[redacted]'
    } else result[key] = redactForRecord(item, sensitive)
  }
  if (observationRecord) result.digest = observationDigest(result)
  return result
}

const REPLAY_FIELDS = new Set(['action', 'name', 'aid', 'value', 'keys', 'ascii', 'match', 'index', 'inAid', 'inName', 'waitFor', 'state', 'fromX', 'fromY', 'toX', 'toY', 'steps', 'holdMs', 'count', 'mods', 'focus', 'waitMs', 'label', 'expectEnabled', 'expectMatch', 'expectValue', 'titleRe', 'textRe', 'gone', 'ms', 'interval', 'conds', 'stableCount', 'max', 'secret', 'visualFallback', 'visualMinConfidence', 'visualTarget', 'winTitle'])
const WAIT_FIELDS = new Set(['ms', 'interval', 'state', 'match', 'index', 'name', 'aid', 'inAid', 'inName', 'stableCount'])
const CONDITION_FIELDS = new Set(['kind', 'titleRe', 'textRe', 'name', 'aid', 'match', 'index', 'label', 'inAid', 'inName'])
const TARGET_FIELDS = new Set(['exeCanonical', 'aumid', 'publisherName', 'productName', 'binaryName', 'publisherVerified'])
const REPLAY_ACTIONS = new Set(['find', 'click', 'setvalue', 'key', 'type', 'drag', 'pattern', 'scroll', 'selecttext', 'read', 'state', 'shot', 'wait', 'waitfor', 'expect', 'windows', 'expectwindow', 'expecttext', 'waitany'])

function containsRedacted(value) {
  if (typeof value === 'string') return value.includes(REDACTED)
  if (Array.isArray(value)) return value.some(containsRedacted)
  return Boolean(value && typeof value === 'object' && Object.values(value).some(containsRedacted))
}

function normalizeTarget(target) {
  if (!target || typeof target !== 'object' || Array.isArray(target)) return null
  const normalized = {}
  const exe = canonicalExe(target.exeCanonical || target.exe)
  if (exe) normalized.exeCanonical = exe
  for (const key of ['aumid', 'productName', 'binaryName']) {
    const value = target[key] ?? (key === 'aumid' ? target.appUserModelId : key === 'productName' ? target.product : null)
    if (typeof value === 'string' && value.trim()) normalized[key] = value.trim()
  }
  if (normalized.binaryName) normalized.binaryName = normalized.binaryName.toLowerCase()
  if (target.publisherVerified === true && typeof target.publisherName === 'string' && target.publisherName.trim()) {
    normalized.publisherName = target.publisherName.trim()
    normalized.publisherVerified = true
  }
  if (!normalized.exeCanonical && !normalized.aumid && !(normalized.publisherVerified && normalized.productName && normalized.binaryName)) return null
  return normalized
}

function hasTemporaryTarget(step) {
  if (!step || typeof step !== 'object') return false
  return ['procId', 'pid', 'winHandle', 'windowHandle', 'handle', 'expectedWindowHandle'].some(key => step[key] != null && String(step[key]) !== '' && String(step[key]) !== '0')
}

function validNestedFields(value, fields) {
  return value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).every(key => fields.has(key)) && Object.values(value).every(item => item === null || ['string', 'number', 'boolean'].includes(typeof item))
}

function validStep(step) {
  if (!step || typeof step !== 'object' || Array.isArray(step) || !REPLAY_ACTIONS.has(step.action) || Object.keys(step).some(key => !REPLAY_FIELDS.has(key))) return false
  if (step.waitFor != null && !validNestedFields(step.waitFor, WAIT_FIELDS)) return false
  if (step.conds != null && (!Array.isArray(step.conds) || !step.conds.every(condition => validNestedFields(condition, CONDITION_FIELDS)))) return false
  return Object.entries(step).every(([key, value]) => ['waitFor', 'conds'].includes(key) || value === null || ['string', 'number', 'boolean'].includes(typeof value))
}

export function createReplay({ replayId = protocolId('replay'), tag = '', steps, transcript = [], target }) {
  const sourceSteps = Array.isArray(steps) ? steps : []
  const replaySteps = sourceSteps.map(step => {
    if (!step || typeof step !== 'object' || Array.isArray(step)) return null
    const filtered = Object.fromEntries(Object.entries(step).filter(([key]) => REPLAY_FIELDS.has(key)))
    if (typeof filtered.action === 'string') filtered.action = filtered.action.trim().toLowerCase()
    return redactForRecord(filtered)
  })
  const safeTranscript = Array.isArray(transcript) ? transcript.map((entry, index) => redactForRecord(entry, sourceSteps[(entry?.step || index + 1) - 1]?.secret === true)) : []
  const record = {
    version: PROTOCOL_VERSION, replayId, createdAt: new Date().toISOString(), tag,
    target: normalizeTarget(target), steps: replaySteps, transcript: safeTranscript,
    requiresInput: replaySteps.some(containsRedacted),
    requiresRetargeting: sourceSteps.some(hasTemporaryTarget) || !normalizeTarget(target),
  }
  return { ...record, hash: contentHash(record) }
}

export function validateReplay(record) {
  if (!record || record.version !== PROTOCOL_VERSION || !Array.isArray(record.steps) || record.steps.length < 1 || record.steps.length > 60 || typeof record.replayId !== 'string' || !record.replayId || !Number.isFinite(Date.parse(record.createdAt))) return { ok: false, error: '不支持的 replay 格式或步骤数量' }
  const { hash, ...body } = record
  if (hash !== contentHash(body)) return { ok: false, error: 'replay 内容哈希失配' }
  if (record.requiresInput || record.requiresRetargeting || record.steps.some(containsRedacted)) return { ok: false, error: '回放含已脱敏输入或临时 PID/窗口句柄，请用原流程重新指定输入和目标' }
  if (record.steps.some(step => !validStep(step))) return { ok: false, error: 'replay 含不支持的动作或步骤字段' }
  const target = normalizeTarget(record.target)
  if (!target || Object.keys(record.target).some(key => !TARGET_FIELDS.has(key)) || stableStringify(target) !== stableStringify(record.target)) return { ok: false, error: 'replay 缺少有效且持久的应用身份' }
  return { ok: true }
}

export { normalizeTarget, containsRedacted }
