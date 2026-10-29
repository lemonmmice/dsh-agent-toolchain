# Harness² evaluation helper

`evaluate.mjs` compares a fixed Harness arm with the Harness²-style arm over the same tasks, repetitions and held-out set. It does not start an agent itself. Inject `runTrial({ task, arm, repetition, seed, heldOut })` from the DSH trial core so hidden checks and answer keys remain outside the improvement context.

The report records completion, accepted decisions, per-run usage and known costs. Missing usage stays `null`; it is not treated as zero. A run that cannot start an executor must return `state: "unavailable"` or `"unknown"` and remains incomplete.

Example:

```js
import { runEvaluation, writeEvaluation } from './evaluate.mjs'

const report = await runEvaluation({
  tasks: [{ id: 'fixture-a', prompt: '...' }],
  heldOut: [{ id: 'fixture-b', prompt: '...' }],
  repetitions: 2,
  runTrial: ({ task, arm, repetition }) => runHarnessTrial({ task, arm, repetition }),
})
await writeEvaluation('.dsh-agent-toolchain/harness/evaluation.json', report)
```

Do not use the helper report as evidence of improvement until both arms use equal budgets, frozen checks, independent repetitions and a separate held-out task set.

