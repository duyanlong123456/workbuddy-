# Refresh WorkBuddy accessToken by scanning WorkBuddy process memory.
$ErrorActionPreference = "SilentlyContinue"
$dir = Split-Path -Parent $MyInvocation.MyCommand.Path
$lock = Join-Path $dir "refresh.lock"
$cachePath = Join-Path $dir "token-cache.json"

# simple lock: skip if another refresh ran in last 8 minutes
if (Test-Path $lock) {
  $age = (Get-Date) - (Get-Item $lock).LastWriteTime
  if ($age.TotalMinutes -lt 8) { exit 0 }
}
Set-Content -Path $lock -Value "$PID $(Get-Date -Format o)" -Encoding ASCII

try {
  Add-Type -Path (Join-Path $dir "memscan.cs")
} catch { exit 1 }

$pids = @(Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.ProcessName -match "^WorkBuddy" } | Select-Object -ExpandProperty Id)
$best = $null; $bestExp = 0
foreach ($procId in $pids) {
  try { $hits = [MemScan]::Scan($procId, "") } catch { continue }
  foreach ($h in $hits) {
    if ($h.Length -lt 700 -or $h.Length -gt 3000) { continue }
    $parts = $h.Split('.')
    if ($parts.Count -ne 3) { continue }
    $p = $parts[1]
    while ($p.Length % 4) { $p += '=' }
    try { $pl = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String($p)) } catch { continue }
    if ($pl -notmatch '"typ"\s*:\s*"Bearer"') { continue }
    if ($pl -notmatch 'workbuddy\.cn/auth/realms/copilot') { continue }
    $exp = 0
    if ($pl -match '"exp"\s*:\s*(\d+)') { $exp = [long]$Matches[1] }
    if ($exp -gt $bestExp) { $bestExp = $exp; $best = $h }
  }
}

if ($best) {
  $obj = @{ token = $best; exp = $bestExp; capturedAt = [DateTimeOffset]::Now.ToUnixTimeSeconds(); source = "memory-scan" }
  $json = $obj | ConvertTo-Json
  [System.IO.File]::WriteAllText($cachePath, $json)
  Remove-Item $lock -Force
  exit 0
} else {
  Set-Content -Path $lock -Value "failed $(Get-Date -Format o)" -Encoding ASCII
  exit 1
}
