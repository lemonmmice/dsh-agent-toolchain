import { readFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createInterface } from 'node:readline'
import { performance } from 'node:perf_hooks'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const flags = process.argv.slice(2)
const valueOf = (name, fallback) => {
  const index = flags.indexOf(name)
  if (index < 0) return fallback
  if (!flags[index + 1] || flags[index + 1].startsWith('--')) throw new Error(`Missing value for ${name}`)
  return flags[index + 1]
}
const rounds = Number(valueOf('--rounds', '3'))
const threshold = Number(valueOf('--threshold', '0.8'))
const timeoutMs = Number(valueOf('--timeout-ms', '5000'))
if (!Number.isSafeInteger(rounds) || rounds < 1 || rounds > 5) throw new Error('rounds must be 1..5')
if (!Number.isFinite(threshold) || threshold < 0 || threshold > 1) throw new Error('threshold must be 0..1')
if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 10000) throw new Error('timeout-ms must be 100..10000')
const fixture = JSON.parse(readFileSync(resolve(root, 'bench/fixtures/jev-decisions.json'), 'utf8'))
const scenarios = fixture.cases
if (!Array.isArray(scenarios) || scenarios.length === 0 || scenarios.length > 40) throw new Error('Invalid fixture size')
const identifiers = new Set()
for (const scenario of scenarios) {
  if (!/^[a-z][a-z0-9_-]*$/.test(scenario.id) || identifiers.has(scenario.id)) throw new Error('Invalid or duplicate scenario ID')
  identifiers.add(scenario.id)
  if (!scenario.instructions || !scenario.criteria || !Array.isArray(scenario.expected) || !scenario.expected.length) throw new Error('Invalid scenario contract')
  if (scenario.expected.some(choice => !Object.hasOwn(scenario.criteria, choice))) throw new Error('Expected choice missing from criteria')
}

const model = 'jev-1.13.0'
const endpoint = 'https://api.typesafe.ai/v1/systemone'
let apiKey = process.env.TYPESAFE_API_KEY
if (flags.includes('--key-stdin')) {
  if (process.stdin.isTTY) throw new Error('Key input requires a non-echoing pipe, not a terminal')
  const reader = createInterface({ input: process.stdin, terminal: false })
  for await (const line of reader) {
    apiKey = line.trim()
    break
  }
  reader.close()
}
if (!apiKey) throw new Error('Set TYPESAFE_API_KEY or provide a key through --key-stdin')

const round = value => Math.round(value * 100) / 100
const summarize = values => {
  const sorted = [...values].sort((left, right) => left - right)
  if (!sorted.length) return null
  const percentile = fraction => sorted[Math.max(0, Math.ceil(fraction * sorted.length) - 1)]
  return { count: sorted.length, p50: round(percentile(0.5)), sampleP95: round(percentile(0.95)), min: round(sorted[0]), max: round(sorted.at(-1)) }
}
const exactUiChoice = scenario => {
  if (scenario.kind !== 'ui' || !Array.isArray(scenario.state.candidates)) return null
  const matches = scenario.state.candidates.filter(candidate => candidate.enabled === true && candidate.scope === scenario.state.scope && candidate.name === scenario.state.goal)
  return matches.length === 1 ? matches[0].id : 'defer'
}
const questionFor = (scenario, batched) => ({
  type: 'choice',
  instructions: batched
    ? `Evaluate only state.records["${scenario.id}"]. Other records are unrelated. ${scenario.instructions}`
    : scenario.instructions,
  criteria: scenario.criteria,
})
const calls = []
let stoppedReason = null
async function evaluate(selected, mode, iteration) {
  const started = performance.now()
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  let status = null
  let row
  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      redirect: 'error',
      signal: controller.signal,
      headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        model,
        state: mode === 'batch' ? { records: Object.fromEntries(selected.map(scenario => [scenario.id, scenario.state])) } : selected[0].state,
        questions: Object.fromEntries(selected.map(scenario => [scenario.id, questionFor(scenario, mode === 'batch')])),
      }),
    })
    status = response.status
    if (!response.ok) {
      await response.body?.cancel()
      throw new Error(`http_${status}`)
    }
    const body = await response.json()
    if (body.model !== model) throw new Error('unexpected_model')
    const answers = selected.map(scenario => {
      const answer = body.answers?.[scenario.id]
      const validProbability = value => Number.isFinite(value) && value >= 0 && value <= 1
      const options = Object.keys(scenario.criteria)
      if (answer?.type !== 'choice' || !Object.hasOwn(scenario.criteria, answer.choice) || !validProbability(answer.confidence)) throw new Error('invalid_answer')
      if (!answer.probabilities || Object.keys(answer.probabilities).length !== options.length || options.some(option => !validProbability(answer.probabilities[option]))) throw new Error('invalid_distribution')
      const total = options.reduce((sum, option) => sum + answer.probabilities[option], 0)
      if (Math.abs(total - 1) > Math.max(0.02, options.length * 0.006)) throw new Error('invalid_distribution_sum')
      const abstained = ['defer', 'none'].includes(answer.choice) || answer.confidence < threshold
      return { id: scenario.id, kind: scenario.kind, choice: answer.choice, confidence: answer.confidence, probabilities: answer.probabilities, expected: scenario.expected, correct: scenario.expected.includes(answer.choice), abstained }
    })
    const inputTokens = body.usage?.input_tokens
    const outputTokens = body.usage?.output_tokens
    row = { mode, iteration, status, ok: true, model: body.model, ms: round(performance.now() - started), usage: { inputTokens: Number.isSafeInteger(inputTokens) && inputTokens >= 0 ? inputTokens : null, outputTokens: Number.isSafeInteger(outputTokens) && outputTokens >= 0 ? outputTokens : null }, answers }
  } catch (error) {
    const code = controller.signal.aborted ? 'timeout' : /^(http_\d+|unexpected_model|invalid_answer|invalid_distribution|invalid_distribution_sum)$/.test(error.message) ? error.message : 'transport_or_response_failure'
    row = { mode, iteration, status, ok: false, code, ms: round(performance.now() - started), ids: selected.map(scenario => scenario.id) }
  } finally {
    clearTimeout(timer)
  }
  calls.push(row)
  process.stderr.write(`${mode} round ${iteration + 1}: ${selected.length} judgments, ${row.ms} ms, ${row.ok ? 'ok' : row.code}\n`)
  if ([401, 402, 429, 529].includes(status)) stoppedReason = `http_${status}`
  return row
}

for (let iteration = 0; iteration < rounds; iteration++) {
  if (iteration % 2 === 0) await evaluate(scenarios, 'batch', iteration)
  if (stoppedReason) break
  const rotated = [...scenarios.slice(iteration), ...scenarios.slice(0, iteration)]
  for (const scenario of rotated) {
    await evaluate([scenario], 'single', iteration)
    if (stoppedReason) break
  }
  if (stoppedReason) break
  if (iteration % 2 !== 0) await evaluate(scenarios, 'batch', iteration)
}
apiKey = undefined
const summarizeMode = mode => {
  const selected = calls.filter(call => call.mode === mode)
  const successful = selected.filter(call => call.ok)
  const answers = successful.flatMap(call => call.answers)
  const accepted = answers.filter(answer => !answer.abstained)
  return {
    calls: selected.length,
    successfulCalls: successful.length,
    successfulRequestLatencyMs: summarize(successful.map(call => call.ms)),
    judgments: answers.length,
    correct: answers.filter(answer => answer.correct).length,
    accuracy: answers.length ? round(answers.filter(answer => answer.correct).length / answers.length) : null,
    abstained: answers.filter(answer => answer.abstained).length,
    accepted: accepted.length,
    acceptedWrong: accepted.filter(answer => !answer.correct).length,
    acceptedCoverage: answers.length ? round(accepted.length / answers.length) : null,
    acceptedPrecision: accepted.length ? round(accepted.filter(answer => answer.correct).length / accepted.length) : null,
    successfulInputTokens: successful.every(call => call.usage.inputTokens !== null) ? successful.reduce((sum, call) => sum + call.usage.inputTokens, 0) : null,
    serialRequestMsPerRound: Array.from({ length: rounds }, (_, iteration) => round(selected.filter(call => call.iteration === iteration).reduce((sum, call) => sum + call.ms, 0))),
  }
}
const ruleResults = scenarios.map(scenario => ({ id: scenario.id, choice: exactUiChoice(scenario), expected: scenario.expected })).filter(row => row.choice !== null)
const report = {
  measuredAt: new Date().toISOString(),
  model,
  fixtureVersion: fixture.version,
  fixtureCases: scenarios.length,
  rounds,
  threshold,
  timeoutMs,
  endpoint,
  partial: calls.length !== rounds * (scenarios.length + 1) || calls.some(call => !call.ok),
  stoppedReason,
  syntheticOnly: true,
  sideEffectsExecuted: 0,
  caveats: ['A synthetic pilot with explicit policy instructions, not production accuracy or a client workflow benchmark.', 'Sample P95 is descriptive only; sample counts are small.', 'Threshold is exploratory and has not been calibrated.', 'Batch latency measures many independent judgments on this fixture; live sequential decisions cannot all be batched.', 'No comparison with an LLM agent runtime was performed.', 'Cold and warm connections are mixed; request times exclude logging and loop overhead.', 'Usage only covers schema-validated successful responses, not observed account billing.', 'Abstention includes none, which can be a correct terminal retrieval result.'],
  exactUiBaseline: { rule: 'Unique enabled name===goal within the supplied scope; otherwise defer', cases: ruleResults.length, correct: ruleResults.filter(row => row.expected.includes(row.choice)).length, results: ruleResults },
  alwaysDeferBaseline: { cases: scenarios.length, correct: scenarios.filter(scenario => scenario.expected.includes('defer')).length },
  single: summarizeMode('single'),
  batch: summarizeMode('batch'),
  calls,
}
const outputPath = resolve(valueOf('--output', resolve(root, 'bench-runs/jev-pilot.json')))
mkdirSync(dirname(outputPath), { recursive: true })
writeFileSync(outputPath, JSON.stringify(report, null, 2) + '\n', 'utf8')
console.log(JSON.stringify({ outputPath, single: report.single, batch: report.batch, exactUiBaseline: report.exactUiBaseline, sideEffectsExecuted: 0 }, null, 2))
if (calls.some(call => !call.ok)) process.exitCode = 1
