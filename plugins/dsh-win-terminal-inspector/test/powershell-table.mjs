// Previous production backend, retained ONLY as a benchmark/parity oracle.
import { spawnSync } from 'node:child_process'

export function powershellTable() {
  const script = String.raw`
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
Get-CimInstance Win32_Process | ForEach-Object {
  $created = $null
  $cd = $_.CreationDate
  if ($cd -is [datetime]) {
    $created = $cd.ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ss.fffZ')
  } elseif ($cd -is [string] -and $cd.Length -gt 0) {
    try { $created = ([System.Management.ManagementDateTimeConverter]::ToDateTime($cd)).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ss.fffZ') } catch { $created = $null }
  }
  [PSCustomObject]@{ pid = [int]$_.ProcessId; ppid = [int]$_.ParentProcessId; session = [int]$_.SessionId; created = $created }
} | ConvertTo-Json -Compress
`
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
    encoding: 'utf8', windowsHide: true, timeout: 20000, maxBuffer: 16 * 1024 * 1024,
  })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error('PowerShell reference query failed: ' + result.stderr)
  return result.stdout
}
