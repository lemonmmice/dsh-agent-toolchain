#!/usr/bin/env node
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'

function asTasks(tasks) {
  if (!Array.isArray(tasks) || !tasks.length) throw new Error('tasks must contain at least one task')
  return tasks.map((task, index) => ({ ...task, id: String(task.id || `task-${index + 1}`) }))
}

function numeric(value) { return value === null || value === undefined || value === '' ? null : Number.isFinite(Number(value)) ? Number(value) : null }

/**
 * Evaluate fixed-harness and Harness²-style trials under the same task set.
 * `runTrial` is injected so the benchmark never guesses how to start an agent.
 * The callback receives `{task, arm, repetition, seed}` and must return the
 * persisted trial result. Hidden checks and answer keys must remain inside it.
 */
export async function runEvaluation({ tasks, heldOut = [], runTrial, repetitions = 1, seed = 'harness2-eval-v1', budget = null } = {}) {
  if (typeof runTrial !== 'function') throw new Error('runTrial callback is required')
  if (!Number.isSafeInteger(repetitions) || repetitions < 1 || repetitions > 20) throw new Error('repetitions must be 1..20')
  const train = asTasks(tasks)
  const holdout = heldOut.length ? asTasks(heldOut) : []
  const runs = []
  const execute = async (task, arm, repetition, heldOutTask) => {
    const result = await runTrial({ task, arm, repetition, seed, budget, heldOut: heldOutTask })
    const decision = result?.decision || {}
    const completeness = result?.completeness || (result?.status === 'completed' && Array.isArray(result?.runs) && result.runs.length > 0 && result.runs.every(run => run.completeness === 'complete') ? 'complete' : null)
    const usage = result?.usage || (Array.isArray(result?.runs) ? { inputTokens: result.runs.reduce((sum, run) => sum + (Number(run.usage?.inputTokens) || 0), 0) || null, outputTokens: result.runs.reduce((sum, run) => sum + (Number(run.usage?.outputTokens) || 0), 0) || null, cost: null } : null)
    runs.push({ taskId: task.id, arm, repetition, heldOut: !!heldOutTask, state: result?.state || result?.status || 'unknown', decision: decision.action || decision.kind || null,
      completeness, usage, cost: numeric(usage?.cost), result })
  }
  for (let repetition = 0; repetition < repetitions; repetition++) {
    for (const task of train) {
      await execute(task, 'fixed', repetition, false)
      await execute(task, 'harness2', repetition, false)
    }
    for (const task of holdout) {
      await execute(task, 'fixed', repetition, true)
      await execute(task, 'harness2', repetition, true)
    }
  }
  const aggregate = arm => {
    const values = runs.filter(run => run.arm === arm)
    const complete = values.filter(run => run.completeness === 'complete').length
    const accepted = values.filter(run => ['adopt', 'candidate', 'accepted'].includes(run.decision)).length
    const costs = values.map(run => run.cost).filter(value => value !== null)
    const inputTokens = values.map(run => numeric(run.usage?.inputTokens ?? run.usage?.input_tokens)).filter(value => value !== null)
    const outputTokens = values.map(run => numeric(run.usage?.outputTokens ?? run.usage?.output_tokens)).filter(value => value !== null)
    return { runs: values.length, complete, completionRate: values.length ? complete / values.length : null, accepted, cost: costs.length ? costs.reduce((sum, value) => sum + value, 0) : null,
      inputTokens: inputTokens.length ? inputTokens.reduce((sum, value) => sum + value, 0) : null, outputTokens: outputTokens.length ? outputTokens.reduce((sum, value) => sum + value, 0) : null }
  }
  return { schema: 1, seed, repetitions, budget, taskCount: train.length, heldOutCount: holdout.length, runs, summary: { fixed: aggregate('fixed'), harness2: aggregate('harness2') } }
}

export async function writeEvaluation(path, report) {
  const target = resolve(path)
  await mkdir(dirname(target), { recursive: true })
  await writeFile(target, JSON.stringify(report, null, 2) + '\n', 'utf8')
  return target
}

if (import.meta.url === `file://${process.argv[1]?.replaceAll('\\', '/')}`) {
  const input = process.argv[2]
  const output = process.argv[3]
  if (!input || !output) throw new Error('usage: node bench/harness2/evaluate.mjs <tasks.json> <report.json>')
  const tasks = JSON.parse(await readFile(resolve(input), 'utf8'))
  const report = await runEvaluation({ tasks: tasks.tasks || tasks, heldOut: tasks.heldOut || [], runTrial: async ({ task, arm }) => ({ state: 'unavailable', completeness: 'incomplete', decision: { action: 'no-acceptable-result', arm, taskId: task.id } }) })
  await writeEvaluation(output, report)
  console.log(output)
}

