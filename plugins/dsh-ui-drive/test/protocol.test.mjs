import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { PROTOCOL_VERSION, contentHash, createReplay, observationOf, protocolId, redactForRecord, validateReplay } from '../lib/protocol.mjs'

const target = { exe: 'C:/App/client.exe', procId: 71, handle: 19, sessionId: 'session-secret', approvalId: 'approval-secret' }
const makeReplay = (extra = {}) => createReplay({ target, steps: [{ action: 'click', name: 'Open' }], ...extra })
const rehash = record => {
  const { hash, ...body } = record
  return { ...body, hash: contentHash(body) }
}

assert.match(protocolId('act'), /^act_[0-9a-f-]{36}$/)
assert.equal(contentHash({ second: 2, first: 1 }), contentHash({ first: 1, second: 2 }))
assert.equal(contentHash({ first: 1, missing: undefined }), contentHash({ first: 1 }))
assert.notEqual(contentHash({ first: 1 }), contentHash({ first: 2 }))

const record = makeReplay()
assert.equal(record.version, PROTOCOL_VERSION)
assert.equal(validateReplay(record).ok, true)
assert.equal(validateReplay(JSON.parse(JSON.stringify(record))).ok, true)
assert.deepEqual(Object.keys(record.target), ['exeCanonical'])
assert.equal(record.target.exeCanonical, 'c:\\app\\client.exe')
assert.equal(record.requiresRetargeting, false)
assert.equal(JSON.stringify(record).includes('session-secret'), false)
assert.equal(JSON.stringify(record).includes('approval-secret'), false)

const tampered = structuredClone(record)
tampered.steps[0].name = 'Other'
assert.equal(validateReplay(tampered).ok, false)
assert.match(validateReplay(tampered).error, /哈希/)
assert.equal(validateReplay(rehash(tampered)).ok, true)

for (const action of ['pattern', 'scroll', 'selecttext']) {
  const ordinary = makeReplay({ steps: [{ action, value: 'selection-mode', expectValue: 'ready' }] })
  assert.equal(ordinary.steps[0].value, 'selection-mode')
  assert.equal(ordinary.requiresInput, false)
  assert.equal(validateReplay(ordinary).ok, true)
}

for (const action of ['setvalue', 'key', 'type']) {
  const secret = makeReplay({ steps: [{ action, value: 'typed-private', keys: 'private-keys' }] })
  assert.equal(secret.steps[0].value, '[redacted]')
  assert.equal(secret.steps[0].keys, '[redacted]')
  assert.equal(secret.requiresInput, true)
  assert.equal(JSON.stringify(secret).includes('typed-private'), false)
  assert.equal(validateReplay(secret).ok, false)
  secret.requiresInput = false
  assert.equal(validateReplay(rehash(secret)).ok, false)
}

const credential = makeReplay({ steps: [{ action: 'setvalue', value: '${cred:password}', secret: true }] })
assert.equal(credential.steps[0].value, '${cred:password}')
assert.equal(credential.requiresInput, false)
assert.equal(validateReplay(credential).ok, true)
const secretTranscript = makeReplay({
  steps: [{ action: 'click', secret: true }],
  transcript: [{ step: 1, action: 'click', output: 'private-output', detail: 'private-detail', lines: ['private-line'], observe: { lines: ['nested-private-line'] } }],
})
assert.equal(JSON.stringify(secretTranscript).includes('private'), false)
assert.equal(secretTranscript.transcript[0].output, '[redacted]')
assert.deepEqual(secretTranscript.transcript[0].observe.lines, ['[redacted]'])

for (const field of ['procId', 'pid', 'winHandle', 'windowHandle', 'handle', 'expectedWindowHandle']) {
  const temporary = makeReplay({ steps: [{ action: 'click', [field]: 42 }] })
  assert.equal(temporary.requiresRetargeting, true, field)
  assert.equal(Object.hasOwn(temporary.steps[0], field), false)
  assert.equal(validateReplay(temporary).ok, false)
}
assert.equal(makeReplay({ steps: [{ action: 'click', procId: 0 }] }).requiresRetargeting, false)
const noTarget = makeReplay({ target: { procId: 42 } })
assert.equal(noTarget.requiresRetargeting, true)
assert.equal(validateReplay(noTarget).ok, false)
assert.equal(validateReplay(rehash({ ...noTarget, requiresRetargeting: false })).ok, false)
assert.equal(validateReplay(makeReplay({ target: { aumid: 'Example_abc!Client' } })).ok, true)
const signature = { publisherName: 'Acme', productName: 'Client', binaryName: 'client.exe' }
assert.equal(validateReplay(makeReplay({ target: signature })).ok, false)
assert.equal(validateReplay(makeReplay({ target: { ...signature, publisherVerified: true } })).ok, true)

for (const field of ['approvalId', 'sessionId', 'procId', 'out', 'snapshotId', 'allowSideEffects', 'unknown']) {
  const unsupported = structuredClone(record)
  unsupported.steps[0][field] = 'unexpected'
  assert.equal(validateReplay(rehash(unsupported)).ok, false, field)
}
const nestedUnknown = makeReplay({ steps: [{ action: 'waitfor', waitFor: { ms: 100, command: 'unexpected' } }] })
assert.equal(validateReplay(nestedUnknown).ok, false)
const nestedValid = makeReplay({ steps: [{ action: 'waitany', conds: [{ kind: 'text', textRe: 'done', label: 'ready' }] }] })
assert.equal(validateReplay(nestedValid).ok, true)
assert.equal(validateReplay(makeReplay({ steps: [{ action: 'unknown_action' }] })).ok, false)
assert.equal(validateReplay(makeReplay({ steps: [{ action: 'click', name: { unknown: true } }] })).ok, false)
assert.equal(validateReplay(makeReplay({ steps: [{ action: 'waitfor', waitFor: { state: 'appear', aid: '[redacted]' } }] })).ok, false)

const clean = redactForRecord({ nested: { approvalId: 'approval-secret', sessionId: 'session-secret', procId: 2, value: 'ordinary' }, action: 'pattern', value: 'invoke' })
assert.deepEqual(clean, { nested: { value: 'ordinary' }, action: 'pattern', value: 'invoke' })
assert.equal(observationOf({ ok: false, lines: ['failure'] }, 'act_test'), null)
const observation = observationOf({ ok: true, lines: ['hello'], snapshotId: 's1', truncated: true, skipped: 2 }, 'act_first')
const repeated = observationOf({ ok: true, lines: ['hello'], snapshotId: 's1', truncated: true, skipped: 2 }, 'act_second')
assert.equal(observation.version, PROTOCOL_VERSION)
assert.equal(observation.actionId, 'act_first')
assert.notEqual(observation.observationId, repeated.observationId)
assert.equal(observation.digest, repeated.digest)
assert.equal(observation.authoritative, true)
assert.equal(observation.untrustedContent, true)
assert.equal(observation.truncated, true)
assert.equal(observation.skipped, 2)

const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-ui-protocol-'))
try {
  for (const secret of [false, true]) {
    const replayObservation = observationOf({ ok: true, lines: ['observation-private-value'], focused: 'observation-private-value', snapshotId: 's7.g2.w777' }, 'act_saved')
    const replayRecord = makeReplay({
      steps: [{ action: 'state', secret, snapshotId: replayObservation.snapshotId }],
      transcript: [{ step: 1, action: 'state', actionId: replayObservation.actionId, observationId: replayObservation.observationId, observationRecord: replayObservation }],
    })
    const replayPath = path.join(folder, 'replay-' + secret + '.json')
    fs.writeFileSync(replayPath, JSON.stringify(replayRecord), 'utf8')
    const storedReplay = JSON.parse(fs.readFileSync(replayPath, 'utf8'))
    assert.equal(validateReplay(storedReplay).ok, true)
    assert.equal(Object.hasOwn(storedReplay.steps[0], 'snapshotId'), false)
    const storedObservation = storedReplay.transcript[0].observationRecord
    assert.equal(storedObservation.snapshotId, replayObservation.snapshotId)
    assert.equal(storedObservation.observationId, storedReplay.transcript[0].observationId)
    assert.equal(storedObservation.actionId, storedReplay.transcript[0].actionId)
    const { digest, ...body } = storedObservation
    assert.equal(digest, contentHash({ ...body, observationId: null, actionId: null, at: null }))
    if (secret) {
      assert.notEqual(digest, replayObservation.digest)
      assert.equal(JSON.stringify(storedReplay).includes('observation-private-value'), false)
      assert.deepEqual(storedObservation.lines, ['[redacted]'])
      assert.equal(storedObservation.focused, '[redacted]')
    } else {
      assert.equal(digest, replayObservation.digest)
    }
  }
  const framePath = path.join(folder, 'frame.png')
  fs.writeFileSync(framePath, Buffer.from([1, 2, 3]))
  const frame = observationOf({ ok: true, path: framePath }, 'act_frame')
  assert.equal(frame.frameHash, contentHash(Buffer.from([1, 2, 3])))
  assert.equal(frame.authoritative, false)
  const missing = observationOf({ ok: true, path: path.join(folder, 'missing.png') }, 'act_missing')
  assert.equal(missing.frameHash, null)
  assert.equal(missing.frameError, 'ENOENT')
} finally {
  fs.rmSync(folder, { recursive: true, force: true })
}
console.log('PASS UI protocol: stable hashes, linked observations, target-bound replay, redaction and replay validation')
