import { parentPort, workerData } from 'node:worker_threads'
import { buildToolchainStatus } from './toolchain-status.mjs'

parentPort.postMessage(buildToolchainStatus(workerData))
