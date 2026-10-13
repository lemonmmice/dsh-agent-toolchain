import { KvMemory } from './kv.mjs'

const store = new KvMemory(process.argv[2])
process.on('disconnect', () => { store.close(); process.exit(0) })
process.on('message', async message => {
  const deadline = Date.now() + 2000
  for (;;) {
    try {
      let value
      if (message.action === 'save') value = store.save(message.key, message.value, message.scope, message.metadata)
      else if (message.action === 'forget') value = store.forget(message.key, message.scope)
      else throw new Error('Unknown KV write operation')
      process.send?.({ id: message.id, value })
      return
    } catch (error) {
      if (error.code === 'FILE_TRANSACTION_BUSY' && error.writesApplied === false && Date.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, 10))
        continue
      }
      process.send?.({ id: message.id, error: { message: error.message, code: error.code, retryable: error.retryable, retryAfterMs: error.retryAfterMs, writesApplied: error.writesApplied, incomplete: error.incomplete } })
      return
    }
  }
})
