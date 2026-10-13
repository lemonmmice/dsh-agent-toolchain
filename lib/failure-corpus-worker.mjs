import { parentPort } from 'node:worker_threads'
import { resolve } from 'node:path'
import { makeFailureCorpus } from './failure-corpus.mjs'

const corpora = new Map()
parentPort.on('message', ({ id, directory, operation, args }) => {
  try {
    if (!['query', 'stats'].includes(operation)) throw new Error('Unsupported failure read operation')
    const key = resolve(directory)
    let corpus = corpora.get(key)
    if (!corpus) {
      corpus = makeFailureCorpus({ dir: key })
      if (corpora.size >= 4) corpora.delete(corpora.keys().next().value)
      corpora.set(key, corpus)
    }
    parentPort.postMessage({ id, value: corpus[operation](args) })
  } catch (error) { parentPort.postMessage({ id, error: { message: error.message, code: error.code ?? 'FAILURE_READ_FAILED', incomplete: true } }) }
})
