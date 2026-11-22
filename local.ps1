# Usage: .\local.ps1 [start|stop|restart|status] [-Lan] [-LanAddress <IPv4>]
param(
  [ValidateSet("start", "stop", "restart", "status")][string]$Action = "start",
  [switch]$Lan,
  [string]$LanAddress
)
$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot
$pidFile = Join-Path $PSScriptRoot ".local-server.pid"
$log = Join-Path $PSScriptRoot ".local-server.log"
$port = 8787
$scheme = if ($Lan) { "https" } else { "http" }

function Get-RunningPid {
  if (-not (Test-Path $pidFile)) { return $null }
  $id = [int](Get-Content $pidFile)
  if (Get-Process -Id $id -ErrorAction SilentlyContinue) { return $id }
  Remove-Item $pidFile
  return $null
}

function Stop-Server {
  $id = Get-RunningPid
  if (-not $id) { Write-Host "Not running."; return }
  # /T also stops the workerd child processes
  taskkill /PID $id /T /F | Out-Null
  Remove-Item $pidFile -ErrorAction SilentlyContinue
  Write-Host "Stopped (PID $id)."
}

function Start-Server {
  $id = Get-RunningPid
  if ($id) { Write-Host "Already running (PID $id). Use '.\local.ps1 restart' to change mode."; return }
  if (Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue) {
    throw "Port $port is already in use by another process."
  }

  if (-not (Test-Path "node_modules")) { npm install; if ($LASTEXITCODE) { exit 1 } }
  npm run build
  if ($LASTEXITCODE) { exit 1 }

  $wrangler = Join-Path $PSScriptRoot "node_modules\wrangler\bin\wrangler.js"
  $wargs = @("`"$wrangler`"", "dev", "--port", $port, "--var", "DEV_MODE:1")
  # HTTPS is required off-localhost: WebCrypto is only available in secure contexts
  if ($Lan) {
    if (-not $LanAddress) {
      $LanAddress = node scripts\lan-address.mjs
      if ($LASTEXITCODE -ne 0) { throw "Specify the host IPv4 address with -LanAddress." }
    }
    $ip = $null
    if (-not [System.Net.IPAddress]::TryParse($LanAddress, [ref]$ip) -or $ip.AddressFamily -ne [System.Net.Sockets.AddressFamily]::InterNetwork -or [System.Net.IPAddress]::IsLoopback($ip) -or $ip.ToString() -ne $LanAddress -or $LanAddress -eq "0.0.0.0") {
      throw "LanAddress must be a non-loopback IPv4 address."
    }
    $wargs += @("--ip", "0.0.0.0", "--local-protocol", "https", "--var", "LAN_ADDRESS:$LanAddress")
  }
  $proc = Start-Process node -ArgumentList $wargs -WorkingDirectory $PSScriptRoot `
    -WindowStyle Hidden -PassThru -RedirectStandardOutput $log -RedirectStandardError "$log.err"
  $proc.Id | Set-Content $pidFile

  for ($i = 0; $i -lt 240; $i++) {
    Start-Sleep -Milliseconds 500
    if ($proc.HasExited) { Remove-Item $pidFile -ErrorAction SilentlyContinue; throw "Server exited. See $log and $log.err" }
    curl.exe -s -k -m 2 -o NUL "${scheme}://localhost:$port/api/config"
    if ($LASTEXITCODE -eq 0) {
      Write-Host "secure-send running (PID $($proc.Id)) at ${scheme}://localhost:$port"
      if ($Lan) {
        Write-Host "LAN invite address: https://${LanAddress}:$port  (accept the self-signed cert warning)"
      }
      Write-Host "Local dev mode: Turnstile disabled. Stop with '.\local.ps1 stop'."
      return
    }
  }
  throw "Timed out waiting for the server. See $log"
}

switch ($Action) {
  "start"   { Start-Server }
  "stop"    { Stop-Server }
  "restart" { Stop-Server; Start-Server }
  "status"  {
    $id = Get-RunningPid
    if ($id) { Write-Host "Running (PID $id) on port $port." } else { Write-Host "Not running." }
  }
}
