# Jev integration

`jev_decide` is an optional decision layer for cases where one agent turn would
otherwise be spent choosing among a bounded set of tools, controls, or evidence
chunks. It returns typed `Choice`, `Score`, and `Noul` answers; it never invokes
the selected tool or changes the client.

The implementation is intentionally opt-in. The call must pass
`allowRemoteData=true`, and the MCP/DSH process must receive `TYPESAFE_API_KEY`.
The key is read from the process environment and is not stored by this
repository. `stateJson` and `questionsJson` are JSON strings so the DSH and MCP
schemas stay identical. Keep them small and remove credentials, tokens, raw
customer data, and screenshots before sending them.

Example MCP call:

```json
{
  "stateJson": "{\"goal\":\"当前客户端无响应\",\"evidence\":{\"dumpAvailable\":true}}",
  "questionsJson": "{\"next\":{\"type\":\"choice\",\"instructions\":\"Which next step preserves the current evidence?\",\"criteria\":{\"capture\":\"Capture or analyze evidence before restarting.\",\"restart\":\"Restart immediately.\",\"defer\":\"Do not choose without enough evidence.\"}}}",
  "allowRemoteData": true,
  "timeoutMs": 1200,
  "model": "jev-1.13.0"
}
```

Use one request for independent questions. The official endpoint evaluates all
questions in parallel, so batching is the main latency win. A local pilot on
16 synthetic cases measured 48 single requests at p50 298 ms and 3 batched
requests at p50 365 ms; the same fixture took 4.9–6.1 seconds when questions
were sent serially and 0.33–0.78 seconds in batches. These are network and
fixture measurements, not a production guarantee.

The tool is not inserted into UI authorization, snapshot freshness, build
verification, hang evidence, or destructive-action paths. Those paths remain
deterministic and fail closed. Jev is currently strongest on focused semantic
questions; TypeSafe documents weaker behavior for arithmetic, dates, long
irrelevant state, adversarial content, and non-English workloads. Treat its
confidence as a routing signal that must be calibrated against local examples,
not as proof of correctness.

Run the synthetic pilot with a key supplied through a non-echoing pipe:

```powershell
$env:TYPESAFE_API_KEY = '<key>'
$env:TYPESAFE_API_KEY | node scripts/bench-jev.mjs --key-stdin --rounds 3 --output bench-runs/jev-pilot.json
Remove-Item Env:TYPESAFE_API_KEY
```

The benchmark stores only model metadata, timings, usage counters, answer
choices, and the synthetic case IDs. It does not write the key or raw request
state to the report.
