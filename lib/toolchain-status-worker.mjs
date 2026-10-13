import { parentPort, threadId } from 'node:worker_threads'
import { buildToolchainStatus } from './toolchain-status.mjs'

parentPort.on('message', message => {
  try { parentPort.postMessage({ id: message.id, value: { ...buildToolchainStatus(message.options), diagnosticWorkerId: threadId } }) }
  catch (error) { parentPort.postMessage({ id: message.id, error: { message: error.message, code: error.code } }) }
})
