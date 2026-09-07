// scripts/seed-failure-corpus.mjs — idempotent local seed.
// Writes the sanitized example records from docs/failure-corpus.md into the
// local failure corpus so a fresh install starts with real, mineable data.
// Skips when the corpus already contains records. Local-only, never uploaded.
import { makeFailureCorpus } from '../lib/failure-corpus.mjs'

const SEED = [
  {
    task: 'push repo to GitHub',
    failureClass: 'tool-error',
    description: 'git push failed with TLS handshake errors when going through a local HTTP proxy (schannel backend)',
    resolution: 'push with -c http.sslBackend=openssl -c http.proxy=<proxy>',
    tags: ['git', 'proxy', 'tls'],
    costMs: 900000,
    context: { runtime: 'cli', tool: 'git push' },
  },
  {
    task: 'commit a CI workflow file',
    failureClass: 'tool-error',
    description: 'OAuth-token push of .github/workflows changes rejected: workflow scope missing',
    resolution: 'device-flow token with repo+workflow scope, one-shot token-URL push',
    tags: ['github', 'auth', 'ci'],
    costMs: 1200000,
    context: { runtime: 'cli', tool: 'git push' },
  },
  {
    task: 'refresh gh CLI auth through proxy',
    failureClass: 'tool-error',
    description: 'gh auth refresh timed out on TLS handshake; gh ignored the configured proxy',
    resolution: 'lowercase https_proxy/http_proxy; fetched a device code via the REST API manually',
    tags: ['github', 'proxy', 'cli'],
    costMs: 600000,
    context: { runtime: 'cli', tool: 'gh' },
  },
  {
    task: 'export plugin repo with a clean tree',
    failureClass: 'design-flaw',
    description: 'plugins ended up nested one level deep during extraction, breaking import paths',
    resolution: 'flatten to single-level plugin dirs before publishing',
    tags: ['repo-hygiene'],
    costMs: 300000,
    context: { runtime: 'cli' },
  },
  {
    task: 'publish tests with the repo',
    failureClass: 'verification-failure',
    description: 'a gitignore pattern silently excluded test directories from the public repo',
    resolution: 'replace with runtime-artifact ignores; the CI gate now asserts tests are committed',
    tags: ['git', 'ci'],
    costMs: 180000,
    context: { runtime: 'ci' },
  },
  {
    task: 'make a new source file compile',
    failureClass: 'doc-gap',
    description: 'legacy build system silently skips source files not registered in the project file, so zero errors did not mean the file compiled',
    resolution: 'hard rule: verify new files are registered before claiming a clean build',
    tags: ['build-system'],
    costMs: 1500000,
    context: { runtime: 'cli', tool: 'build' },
  },
]

const c = makeFailureCorpus({})
const total = c.query({ limit: 1 }).total
if (total > 0) {
  console.log(`corpus already has ${total} record(s) — seed skipped (${c.dir})`)
  process.exit(0)
}
for (const rec of SEED) c.record(rec)
console.log(`seeded ${SEED.length} example records into ${c.dir}`)
