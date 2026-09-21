import assert from 'node:assert/strict'
import { setTimeout as delay } from 'node:timers/promises'
import { makeToolProgress } from './tool-progress.mjs'

const wrapper = makeToolProgress({ intervalMs: 10 })
const result = { content: [{ type: 'text', text: 'result' }] }
const notifications = []
const controller = new AbortController()
const extra = { _meta: { progressToken: 0 }, signal: controller.signal, sendNotification: async (notification) => notifications.push(notification) }
const returned = await wrapper.wrap('test_tool', async () => { await delay(55); return result })({ secret: 'must-not-appear' }, extra)
assert.equal(returned, result)
assert.ok(notifications.length >= 3)
assert.match(notifications[0].params.message, /started/)
assert.match(notifications.at(-1).params.message, /completed/)
assert.ok(notifications.every((notification) => notification.params.progressToken === 0))
assert.ok(notifications.every((notification, index) => index === 0 || notification.params.progress > notifications[index - 1].params.progress))
assert.ok(!JSON.stringify(notifications).includes('must-not-appear'))
const completedCount = notifications.length
await delay(30)
assert.equal(notifications.length, completedCount)
let unrequestedNotifications = 0
await wrapper.wrap('silent', async () => result)({}, { sendNotification: () => unrequestedNotifications++ })
assert.equal(unrequestedNotifications, 0)
const expectedError = new Error('private-error-details')
await assert.rejects(wrapper.wrap('failure', async () => { await delay(5); throw expectedError })({}, extra), (error) => error === expectedError)
assert.match(notifications.at(-1).params.message, /failed/)
assert.ok(!JSON.stringify(notifications).includes('private-error-details'))
assert.equal(await wrapper.wrap('disconnected', async () => { await delay(20); return result })({}, { ...extra, sendNotification: () => Promise.reject(new Error('closed')) }), result)
assert.equal(await wrapper.wrap('backpressure', async () => result)({}, { ...extra, sendNotification: () => new Promise(() => {}) }), result)
const delayedNotifications = []
let releaseNotification
const pendingNotification = new Promise((done) => { releaseNotification = done })
assert.equal(await wrapper.wrap('delayed-send', async () => result)({}, {
  ...extra,
  sendNotification: (notification) => {
    delayedNotifications.push(notification)
    return delayedNotifications.length === 1 ? pendingNotification : Promise.resolve()
  },
}), result)
assert.equal(delayedNotifications.length, 1)
releaseNotification()
await delay(1)
assert.equal(delayedNotifications.length, 2)
assert.match(delayedNotifications[1].params.message, /completed/)
const cancellation = new AbortController()
let cancelledNotifications = 0
await wrapper.wrap('cancelled', async () => {
  cancellation.abort()
  await delay(30)
  return result
})({}, { ...extra, signal: cancellation.signal, sendNotification: async () => cancelledNotifications++ })
assert.equal(cancelledNotifications, 1)
console.log('PASS: progress notifications, lifecycle, privacy, disconnect and backpressure')
