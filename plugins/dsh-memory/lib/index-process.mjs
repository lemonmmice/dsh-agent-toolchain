import { DshMemory } from './memory.mjs'
import { EmbedProvider } from './embed-provider.mjs'

let memory = null
let configuration = null
process.on('disconnect', () => { memory?.close(); process.exit(0) })
process.on('message', async message => {
  try {
    const identity = JSON.stringify(message.config)
    if (configuration !== identity) {
      memory?.close()
      const embed = new EmbedProvider({ apiKey: message.config.apiKey, cacheDir: message.config.cacheDir })
      embed.mode = message.config.mode
      embed.model = message.config.model
      embed.baseURL = message.config.baseURL
      memory = new DshMemory({ dataDir: message.config.dataDir, project: message.config.project, embedProvider: embed })
      configuration = identity
    }
    const result = await memory.indexWorkspace(message.path, message.options)
    process.send?.({ id: message.id, value: result })
  } catch (error) { process.send?.({ id: message.id, error: { message: error.message, code: error.code, incomplete: true } }) }
})
