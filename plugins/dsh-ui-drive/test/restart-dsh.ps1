# 延迟 15 秒后杀掉 dsh web 宿主进程（start-dsh.ps1 守护循环会自动拉起新宿主）
Start-Sleep -Seconds 15
$procs = Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -like '*dsh*bin.js*web*' }
foreach ($p in $procs) {
  try { taskkill /PID $p.ProcessId /T /F | Out-Null } catch {}
}
