import { AsyncLocalStorage } from 'node:async_hooks'

const context = new AsyncLocalStorage()
export function withTaskContext(value, action) { return context.run(value, action) }
export function taskSignal() { return context.getStore()?.signal }
