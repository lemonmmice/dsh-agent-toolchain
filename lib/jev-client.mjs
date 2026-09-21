const DEFAULT_ENDPOINT = 'https://api.typesafe.ai/v1/systemone'
const DEFAULT_MODEL = 'jev-1.13.0'
const DEFAULT_TIMEOUT_MS = 1200
const MAX_TIMEOUT_MS = 5000
const MAX_STATE_BYTES = 120 * 1024
const MAX_QUESTIONS = 40
const MAX_INSTRUCTIONS_BYTES = 32 * 1024

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

export function createJevClient({ apiKey = process.env.TYPESAFE_API_KEY, endpoint = DEFAULT_ENDPOINT, fetchImpl = globalThis.fetch } = {}) {
  return {
    async evaluate({ state, questions, model = DEFAULT_MODEL, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
      const stateError = validateState(state)
      if (stateError) return fail('jev_invalid_state', stateError)
      const questionsError = validateQuestions(questions)
      if (questionsError) return fail('jev_invalid_questions', questionsError)
      if (typeof apiKey !== 'string' || apiKey.length < 20) return fail('jev_not_configured', 'TYPESAFE_API_KEY is not configured')
      if (typeof fetchImpl !== 'function') return fail('jev_unavailable', 'fetch is unavailable in this runtime')
      const started = performance.now()
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), timeoutMs)
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
        const body = await response.json()
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
        return fail(controller.signal.aborted ? 'jev_timeout' : 'jev_transport_error', controller.signal.aborted ? `TypeSafe request exceeded ${timeoutMs}ms` : 'TypeSafe request failed')
      } finally {
        clearTimeout(timer)
      }
    },
  }
}

export const JEV_LIMITS = Object.freeze({ DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS, MAX_STATE_BYTES, MAX_QUESTIONS })
