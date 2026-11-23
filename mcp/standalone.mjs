import { readEnvFile, envFilePath, applyEnvFile } from '../lib/toolchain-env-file.mjs'

const settingsPath = envFilePath(process.env)
const settings = readEnvFile(settingsPath)
if (!settings.exists || settings.error || settings.rejected?.length) {
  throw new Error('Standalone settings are missing or invalid. Run setup.cmd again. ' + (settings.error || ''))
}
for (const key of Object.keys(process.env)) {
  if (key.startsWith('DSH_') && key !== 'DSH_ENV_FILE' && !key.startsWith('DSH_CRED_')) delete process.env[key]
}
if (process.argv.includes('--stop-capture-service')) {
  applyEnvFile(process.env)
  const { stopStandalone } = await import('../lib/capture-host.mjs')
  console.log(JSON.stringify(await stopStandalone()))
} else {
  await import('./launch.mjs')
}
