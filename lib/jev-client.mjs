const DEFAULT_ENDPOINT = 'https://api.typesafe.ai/v1/systemone'
const DEFAULT_MODEL = 'jev-1.13.0'
const DEFAULT_TIMEOUT_MS = 1200
const MAX_TIMEOUT_MS = 5000
const MAX_STATE_BYTES = 120 * 1024
const MAX_QUESTIONS = 40
const MAX_INSTRUCTIONS_BYTES = 32 * 1024
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024   // 响应体有界读上限（对齐 http_request 的 2MiB），防无界响应读爆内存

const jsonBytes = value => Buffer.byteLength(JSON.stringify(value), 'utf8')

function fail(errorCode, error) {
  return { ok: false, errorCode, error }
}

function validateState(state) {
  if (!(typeof state === 'string' || (state && typeof state === 'object'))) return 'state must be a string, object, or array'
  let bytes
  try { bytes = jsonBytes(state) } catch { return 'state must be JSON serializable' }
  if (bytes > MAX_STATE_BYTES) return `state exceeds ${MAX_STATE_BYTES} bytes`
  return null
}

function validateQuestion(question, key) {
  if (!question || typeof question !== 'object' || Array.isArray(question)) return `${key} must be an object`
  if (!['choice', 'score', 'noul'].includes(question.type)) return `${key}.type must be choice, score, or noul`
  if (!(typeof question.instructions === 'string' || (question.instructions && typeof question.instructions === 'object'))) return `${key}.instructions must be a string or JSON value`
  if (jsonBytes(question.instructions) > MAX_INSTRUCTIONS_BYTES) return `${key}.instructions is too large`
  if (question.type === 'choice') {
    if (!question.criteria || typeof question.criteria !== 'object' || Array.isArray(question.criteria)) return `${key}.criteria must be an object`
    const choices = Object.keys(question.criteria)
    if (choices.length < 2 || choices.length > 255) return `${key}.criteria must contain 2..255 choices`
  }
  if (question.type === 'score' && (!Array.isArray(question.criteria) || question.criteria.length < 2 || question.criteria.length > 10)) return `${key}.criteria must contain 2..10 score levels`
  return null
}

function validateQuestions(questions) {
  if (!questions || typeof questions !== 'object' || Array.isArray(questions)) return 'questions must be an object'
  const keys = Object.keys(questions)
  if (keys.length < 1 || keys.length > MAX_QUESTIONS) return `questions must contain 1..${MAX_QUESTIONS} entries`
  for (const key of keys) {
    if (!/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(key)) return `invalid question id: ${key}`
    const error = validateQuestion(questions[key], key)
    if (error) return error
  }
  return null
}

function parseJsonArgument(value, name) {
  if (typeof value !== 'string' || value.length === 0) throw new Error(`${name} must be a JSON string`)
  try { return JSON.parse(value) } catch { throw new Error(`${name} is invalid JSON`) }
}

export function parseJevArguments(args = {}) {
  let state
  let questions
  try {
    state = parseJsonArgument(args.stateJson, 'stateJson')
    questions = parseJsonArgument(args.questionsJson, 'questionsJson')
  } catch (error) {
    return fail('jev_invalid_arguments', error.message)
  }
  const stateError = validateState(state)
  if (stateError) return fail('jev_invalid_state', stateError)
  const questionsError = validateQuestions(questions)
  if (questionsError) return fail('jev_invalid_questions', questionsError)
  const timeoutMs = args.timeoutMs === undefined ? DEFAULT_TIMEOUT_MS : Number(args.timeoutMs)
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > MAX_TIMEOUT_MS) return fail('jev_invalid_timeout', `timeoutMs must be an integer between 100 and ${MAX_TIMEOUT_MS}`)
  const model = args.model === undefined ? DEFAULT_MODEL : String(args.model)
  if (!/^jev-[A-Za-z0-9.-]{1,64}$/.test(model)) return fail('jev_invalid_model', 'model must be a versioned Jev model id')
  return { ok: true, request: { state, questions, timeoutMs, model } }
}

/**
 * 有界读响应体并解析 JSON。真实 fetch 走流式读：累加字节，超过 maxBytes 立即 cancel 流，
 * 绝不把无界响应读进内存（对齐 http_request 的 2MiB 有界读）；测试/运行时若无可读流则回退 response.json()。
 * 返回 { json } | { tooLarge:true } | { parseError:true }。
 */
async function readJsonBounded(response, maxBytes) {
  if (response.body && typeof response.body.getReader === 'function') {
    const reader = response.body.getReader()
    const chunks = []
    let size = 0
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        size += value.byteLength
        if (size > maxBytes) { try { await reader.cancel() } catch { /* ignore */ } return { tooLarge: true } }
        chunks.push(Buffer.from(value))
      }
    } finally {
      try { reader.releaseLock() } catch { /* ignore */ }
    }
    try { return { json: JSON.parse(Buffer.concat(chunks, size).toString('utf8')) } } catch { return { parseError: true } }
  }
  try { return { json: await response.json() } } catch { return { parseError: true } }
}

export function createJevClient({ apiKey = process.env.TYPESAFE_API_KEY, endpoint = DEFAULT_ENDPOINT, fetchImpl = globalThis.fetch } = {}) {
  // single-flight：Jev 是**无副作用**的评估请求，完全相同(model+timeout+state+questions)且无外部 signal 的并发调用
  // 去重 —— 搭车者共享同一个在途结果（只读，安全），不额外打 TypeSafe。第一个发起者结束即从表中移除。
  const inflight = new Map()

  async function runEvaluate({ state, questions, model, timeoutMs, signal }) {
    const started = performance.now()
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    // 外部 signal（任务取消 / 调用方期限）与内部 timeout 合并：任一触发都中止本次请求（整段取消贯穿到 fetch）。
    const onExternalAbort = () => controller.abort()
    if (signal) { if (signal.aborted) controller.abort(); else signal.addEventListener('abort', onExternalAbort, { once: true }) }
    try {
      const response = await fetchImpl(endpoint, {
        method: 'POST',
        redirect: 'error',
        signal: controller.signal,
        headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
        body: JSON.stringify({ model, state, questions }),
      })
      if (!response.ok) {
        await response.body?.cancel?.()
        const errorCode = response.status === 401 ? 'jev_invalid_key' : response.status === 429 || response.status === 529 ? 'jev_rate_limited' : 'jev_http_error'
        return fail(errorCode, `TypeSafe returned HTTP ${response.status}`)
      }
      const read = await readJsonBounded(response, MAX_RESPONSE_BYTES)
      if (read.tooLarge) return fail('jev_response_too_large', `TypeSafe response exceeds ${MAX_RESPONSE_BYTES} bytes`)
      if (read.parseError) return fail('jev_invalid_response', 'TypeSafe response is not valid JSON')
      const body = read.json
      if (!body || typeof body !== 'object' || !body.answers || typeof body.answers !== 'object') return fail('jev_invalid_response', 'TypeSafe response has no answers')
      return {
        ok: true,
        model: typeof body.model === 'string' ? body.model : model,
        answers: body.answers,
        usage: body.usage && typeof body.usage === 'object' ? {
          inputTokens: Number.isSafeInteger(body.usage.input_tokens) ? body.usage.input_tokens : null,
          outputTokens: Number.isSafeInteger(body.usage.output_tokens) ? body.usage.output_tokens : null,
        } : { inputTokens: null, outputTokens: null },
        latencyMs: Math.round(performance.now() - started),
      }
    } catch (error) {
      if (signal?.aborted) return fail('jev_cancelled', 'request cancelled')
      return fail(controller.signal.aborted ? 'jev_timeout' : 'jev_transport_error', controller.signal.aborted ? `TypeSafe request exceeded ${timeoutMs}ms` : 'TypeSafe request failed')
    } finally {
      clearTimeout(timer)
      if (signal) signal.removeEventListener('abort', onExternalAbort)
    }
  }

  return {
    async evaluate({ state, questions, model = DEFAULT_MODEL, timeoutMs = DEFAULT_TIMEOUT_MS, signal } = {}) {
      const stateError = validateState(state)
      if (stateError) return fail('jev_invalid_state', stateError)
      const questionsError = validateQuestions(questions)
      if (questionsError) return fail('jev_invalid_questions', questionsError)
      if (typeof apiKey !== 'string' || apiKey.length < 20) return fail('jev_not_configured', 'TYPESAFE_API_KEY is not configured')
      if (typeof fetchImpl !== 'function') return fail('jev_unavailable', 'fetch is unavailable in this runtime')
      // 带外部 signal 的调用要独立的取消控制，不参与 single-flight 搭车（否则一人取消会连累共享结果）。
      const shareKey = signal ? null : `${model} ${timeoutMs} ${JSON.stringify(state)} ${JSON.stringify(questions)}`
      if (shareKey && inflight.has(shareKey)) return inflight.get(shareKey)
      const pending = runEvaluate({ state, questions, model, timeoutMs, signal })
      if (shareKey) {
        inflight.set(shareKey, pending)
        pending.then(() => inflight.delete(shareKey), () => inflight.delete(shareKey))
      }
      return pending
    },
  }
}

export const JEV_LIMITS = Object.freeze({ DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS, MAX_STATE_BYTES, MAX_QUESTIONS, MAX_INSTRUCTIONS_BYTES, MAX_RESPONSE_BYTES })
