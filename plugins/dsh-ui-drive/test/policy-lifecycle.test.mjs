import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createPolicy } from '../lib/policy.mjs'

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-ui-policy-lifecycle-'))
const approvalFile = path.join(root, 'approvals.json')
const identity = { exe: 'C:/App/client.exe', windowHandle: 7, aid: 'delete' }
const cleanup = () => fs.rmSync(root, { recursive: true, force: true })

try {
  const invalid = createPolicy({ approvalFile })
  assert.equal(invalid.grantApproval({ identity: {}, actions: ['click'] }).code, 'approval_invalid')
  assert.equal(invalid.grantApproval({ identity: { aid: 'delete' }, actions: ['click'] }).code, 'approval_invalid')
  assert.equal(invalid.grantApproval({ identity: { company: 'Acme' }, actions: ['click'] }).code, 'approval_invalid')
  assert.equal(invalid.grantApproval({ identity: { publisherName: 'Acme', productName: 'Client', binaryName: 'client.exe' }, actions: ['click'] }).ok, true)

  const denied = createPolicy({ approvalFile, rules: [{ exe: identity.exe, effect: 'deny' }] })
  const denyApproval = denied.grantApproval({ identity, sessionId: 's1', actions: ['click'] })
  assert.equal(denyApproval.ok, true)
  assert.equal(denied.check({ action: 'click', identity, sessionId: 's1', approvalId: denyApproval.approval.id, allowSideEffects: true }).code, 'policy_unavailable')

  const oncePolicy = createPolicy({ approvalFile: path.join(root, 'once.json') })
  let executed = 0
  const once = oncePolicy.grantApproval({ identity, sessionId: 's1', scope: 'once', actions: ['click'] })
  assert.equal(once.ok, true)
  assert.equal(oncePolicy.check({ action: 'click', identity, sessionId: 's1', approvalId: once.approval.id, allowSideEffects: true, consume: false, onExecute: () => executed++ }).ok, true)
  assert.equal(executed, 0)
  assert.equal(oncePolicy.check({ action: 'click', identity, sessionId: 's1', approvalId: once.approval.id, allowSideEffects: true, onExecute: () => executed++ }).ok, true)
  assert.equal(executed, 1)
  assert.equal(oncePolicy.check({ action: 'click', identity, sessionId: 's1', approvalId: once.approval.id, allowSideEffects: true }).code, 'approval_invalid')
  assert.equal(fs.existsSync(path.join(root, 'once.json')), false)

  const session = createPolicy({ approvalFile: path.join(root, 'session.json') })
  const sessionApproval = session.grantApproval({ identity, sessionId: 's1', scope: 'session', actions: ['click'] })
  assert.equal(session.check({ action: 'click', identity, sessionId: 's2', approvalId: sessionApproval.approval.id, allowSideEffects: true }).code, 'approval_session_mismatch')
  assert.equal(fs.existsSync(path.join(root, 'session.json')), false)

  const persistentFile = path.join(root, 'persistent.json')
  const first = createPolicy({ approvalFile: persistentFile })
  const second = createPolicy({ approvalFile: persistentFile })
  const local = first.grantApproval({ identity, scope: 'session', actions: ['click'] })
  const persistent = first.grantApproval({ identity, scope: 'persistent', actions: ['click'], ttlMs: 60000 })
  assert.equal(persistent.ok, true)
  assert.equal(second.check({ action: 'click', identity, approvalId: persistent.approval.id, allowSideEffects: true }).ok, true)
  assert.equal(first.revokeApproval(persistent.approval.id).ok, true)
  assert.equal(second.check({ action: 'click', identity, approvalId: persistent.approval.id, allowSideEffects: true }).code, 'approval_revoked')
  const stored = JSON.parse(fs.readFileSync(persistentFile, 'utf8'))
  assert.deepEqual(stored.map(row => row.scope), ['persistent'])
  assert.equal(second.check({ action: 'click', identity, approvalId: local.approval.id, allowSideEffects: true }).code, 'approval_invalid')
  const laterGrant = second.grantApproval({ identity, scope: 'permanent', actions: ['click'] })
  assert.equal(laterGrant.ok, true)
  assert.equal(laterGrant.approval.expiresAt, null)
  assert.equal(first.check({ action: 'click', identity, approvalId: persistent.approval.id, allowSideEffects: true }).code, 'approval_revoked')
  assert.equal(first.check({ action: 'click', identity, approvalId: laterGrant.approval.id, allowSideEffects: true }).ok, true)
  const finitePermanent = first.grantApproval({ identity, scope: 'permanent', ttlMs: 10000 })
  assert.equal(finitePermanent.ok, true)
  assert.ok(Date.parse(finitePermanent.approval.expiresAt) > Date.now())

  const expiringFile = path.join(root, 'expiring.json')
  const expiring = createPolicy({ approvalFile: expiringFile })
  const short = expiring.grantApproval({ identity, scope: 'persistent', actions: ['click'], ttlMs: 1 })
  assert.equal(short.ok, true)
  await new Promise(resolve => setTimeout(resolve, 15))
  assert.equal(expiring.check({ action: 'click', identity, approvalId: short.approval.id, allowSideEffects: true }).code, 'approval_expired')
  assert.equal(expiring.approvalStatus().find(row => row.id === short.approval.id).expired, true)

  const brokenFile = path.join(root, 'broken.json')
  fs.writeFileSync(brokenFile, '{broken', 'utf8')
  const broken = createPolicy({ approvalFile: brokenFile })
  assert.equal(broken.approvalStatus().code, 'approval_store_unavailable')
  assert.equal(broken.check({ action: 'click', identity, approvalId: 'apv_missing', allowSideEffects: true }).code, 'approval_store_unavailable')
  assert.equal(broken.grantApproval({ identity, scope: 'persistent', actions: ['click'] }).code, 'approval_store_unavailable')

  const gate = createPolicy({ approvalFile: path.join(root, 'gate.json') })
  assert.equal(gate.needsCheck({ approvalId: 'apv_external' }), true)
  gate.stop('s1')
  assert.equal(gate.needsCheck(), true)
  assert.equal(gate.check({ action: 'click', identity, allowSideEffects: true, sessionId: 's1' }).code, 'stopped_by_user')
  gate.reset('s1')
  assert.equal(gate.check({ action: 'click', identity, allowSideEffects: true, desktopState: 'locked' }).code, 'desktop_locked')
  assert.equal(gate.check({ action: 'click', identity, allowSideEffects: true, desktopState: 'unknown' }).code, 'desktop_unknown')
  assert.equal(gate.check({ action: 'click', identity, allowSideEffects: true, desktopState: 'secure' }).code, 'desktop_secure')
  assert.equal(gate.check({ action: 'click', identity, allowSideEffects: true }).ok, true)

  for (const args of [{ scope: 'typo' }, { actions: [] }, { actions: [''] }, { actions: 'click' }, { ttlMs: -1 }, { ttlMs: Infinity }, { ttlMs: 1e20 }, { expiresAt: 'invalid' }, { expiresAt: Date.now() - 1 }]) {
    assert.equal(gate.grantApproval({ identity, ...args }).code, 'approval_invalid', JSON.stringify(args))
  }
  const detached = gate.grantApproval({ identity, scope: 'session', actions: ['click'] })
  detached.approval.identity.exe = null
  detached.approval.actions.push('type')
  assert.equal(gate.check({ action: 'type', identity, approvalId: detached.approval.id, allowSideEffects: true }).code, 'approval_action_mismatch')
  const listed = gate.approvalStatus().find(row => row.id === detached.approval.id)
  listed.identity.exe = null
  assert.equal(gate.check({ action: 'click', identity: { exe: 'C:/Different/app.exe' }, approvalId: detached.approval.id, allowSideEffects: true }).code, 'approval_identity_mismatch')

  const lockedFile = path.join(root, 'locked.json')
  fs.writeFileSync(lockedFile + '.lock', 'held', 'utf8')
  const locked = createPolicy({ approvalFile: lockedFile })
  assert.equal(locked.grantApproval({ identity, scope: 'permanent' }).code, 'approval_store_unavailable')
  assert.equal(locked.diagnostics.approvalStoreError.code, 'approval_store_unavailable')
  assert.equal(fs.readFileSync(lockedFile + '.lock', 'utf8'), 'held')

  const publisher = { publisherName: 'Acme', productName: 'Client', binaryName: 'client.exe' }
  const publisherPolicy = createPolicy({ approvalFile: '', rules: [{ ...publisher, effect: 'allow' }] })
  assert.equal(publisherPolicy.check({ action: 'click', identity: { ...publisher, publisherVerified: true }, allowSideEffects: true }).ok, true)
  assert.equal(publisherPolicy.check({ action: 'click', identity: publisher, allowSideEffects: true }).ok, false)
  assert.equal(publisherPolicy.check({ action: 'click', identity: null, allowSideEffects: true }).ok, false)
  assert.equal(publisherPolicy.check({ action: 'click', identity: { ...publisher, publisherVerified: false }, allowSideEffects: true }).ok, false)
  const publisherGrant = gate.grantApproval({ identity: publisher })
  assert.equal(gate.check({ action: 'click', identity: publisher, approvalId: publisherGrant.approval.id, allowSideEffects: true }).code, 'approval_identity_mismatch')
  assert.equal(gate.check({ action: 'click', identity: { ...publisher, publisherVerified: true }, approvalId: publisherGrant.approval.id, allowSideEffects: true }).ok, true)

  const permitLocked = createPolicy({ approvalFile: '', allowLockedDesktop: true, allowUnknownDesktop: true })
  assert.equal(permitLocked.check({ action: 'click', identity, allowSideEffects: true, desktopState: 'locked' }).ok, true)
  assert.equal(permitLocked.check({ action: 'click', identity, allowSideEffects: true, desktopState: 'unknown' }).code, 'desktop_unknown')
  assert.equal(permitLocked.check({ action: 'click', identity, allowSideEffects: true, desktopState: 'secure' }).code, 'desktop_secure')
  console.log('PASS policy lifecycle')
} finally {
  cleanup()
}
