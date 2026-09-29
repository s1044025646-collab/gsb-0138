# Local smoke test: start API on an ephemeral loopback port, hit it, stop it.
$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root
$dataDir = Join-Path $root "data"
$env:OPT_DB = Join-Path $dataDir "srv.db"
$p = Start-Process -FilePath "node" -ArgumentList @("--import", "tsx", "src/server/main.ts") `
  -WindowStyle Hidden -PassThru `
  -RedirectStandardError (Join-Path $dataDir "srv.err.log") `
  -RedirectStandardOutput (Join-Path $dataDir "srv.out.log")
try {
  Start-Sleep 5
  $port = Get-Content (Join-Path $dataDir "server.port")
  $h = Invoke-RestMethod "http://127.0.0.1:$port/api/health"
  Write-Output ("health: " + ($h | ConvertTo-Json -Compress))
  $body = '{"code":"HTTP-C","optionType":"put","style":"american","strike":100,"maturityDate":"2027-01-01","annualVolatility":0.25}'
  $c = Invoke-RestMethod -Method Post "http://127.0.0.1:$port/api/contracts" -ContentType "application/json" -Body $body
  Write-Output ("created id=" + $c.data.id)
  $list = Invoke-RestMethod "http://127.0.0.1:$port/api/contracts?limit=1&offset=0"
  Write-Output ("page total=" + $list.data.total + " rows=" + $list.data.rows.Count)
} finally {
  Stop-Process -Id $p.Id -Force
}
Get-Content (Join-Path $dataDir "srv.out.log")
