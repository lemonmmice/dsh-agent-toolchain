// Synthetic xperf-like input. Never captures a real process or opens a trace session.
import { openSync, writeSync, closeSync } from 'node:fs'

export const ALLOC = 'Microsoft-Windows-DotNETRuntime/GarbageCollection/GCAllocationTick'
export function allocation(ts, proc, tid, bytes = '0x18000', type = 'System.String') {
  return `${ALLOC}, ${ts}, ${proc}, ${tid}, 5, , , , , 0x10000, 0, 40, ${bytes}, 0x7ffb, "${type}", 0, 0x1234`
}

export function writeTrace(file, samples = 30000, depth = 24) {
  const fd = openSync(file, 'w')
  try {
    let batch = ''
    for (let i = 0; i < samples; i++) {
      const ts = i * 1000, tid = 100 + i % 8, proc = i % 5 ? 'Client.exe (42)' : 'Other.exe (99)'
      batch += `SampledProfile, ${ts}, ${proc}, ${tid}\n`
      batch += allocation(ts, proc, tid, i % 2 ? '0x18000' : '0x10000', i % 2 ? 'System.String' : 'Generic`2[A,B]') + '\n'
      for (let frame = 1; frame <= depth; frame++) {
        const module = frame % 4 === 0 ? 'kernel32.dll' : frame % 4 === 1 ? 'app.dll' : 'clr.dll'
        batch += `Stack, ${ts}, ${tid}, ${frame}, 0x${(4096 + frame).toString(16)}, ${module}!Function${frame}\n`
      }
      batch += `CSwitch, ${ts + 1}, Other.exe (99), 77\nStack, ${ts + 1}, 77, 1, 0x0, wait.dll!Wait\n`
      if (i % 500 === 499) { writeSync(fd, batch); batch = '' }
    }
    if (batch) writeSync(fd, batch)
  } finally { closeSync(fd) }
}
