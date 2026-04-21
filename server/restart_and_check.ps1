$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $root

function Get-NodePath {
  $cursorNode = Join-Path $env:LOCALAPPDATA "Programs\cursor\resources\app\resources\helpers\node.exe"
  if (Test-Path $cursorNode) {
    return $cursorNode
  }

  $cmd = Get-Command node -ErrorAction SilentlyContinue
  if ($cmd) {
    return $cmd.Source
  }

  throw "Node executable was not found."
}

function Stop-Port8787Process {
  $lines = netstat -ano | Select-String ":8787"
  $pids = @()
  foreach ($line in $lines) {
    $parts = ($line -replace "\s+", " ").Trim().Split(" ")
    if ($parts.Length -ge 5) {
      $procId = $parts[-1]
      if ($procId -match "^\d+$" -and $procId -ne "0") {
        $pids += $procId
      }
    }
  }

  $pids = $pids | Select-Object -Unique
  foreach ($procId in $pids) {
    try {
      Stop-Process -Id ([int]$procId) -Force -ErrorAction Stop
      Write-Host "Stopped process PID=$procId on port 8787"
    } catch {
      Write-Host "Failed to stop PID=$procId, skip"
    }
  }
}

function Wait-Endpoint($url, $timeoutSeconds = 15) {
  $start = Get-Date
  while (((Get-Date) - $start).TotalSeconds -lt $timeoutSeconds) {
    try {
      Invoke-RestMethod -Uri $url -Method Get | Out-Null
      return $true
    } catch {
      Start-Sleep -Milliseconds 500
    }
  }
  return $false
}

$nodePath = Get-NodePath
Write-Host "Using Node: $nodePath"

Stop-Port8787Process

Write-Host "Starting backend..."
$process = Start-Process -FilePath $nodePath -ArgumentList "server.js" -WorkingDirectory $root -PassThru
Write-Host "Backend PID: $($process.Id)"

if (-not (Wait-Endpoint "http://localhost:8787/api/health")) {
  throw "Backend start timeout, /api/health not ready."
}

Write-Host ""
Write-Host "===== health ====="
Invoke-RestMethod -Uri "http://localhost:8787/api/health" -Method Get | ConvertTo-Json -Depth 8

Write-Host ""
Write-Host "===== provider-info ====="
Invoke-RestMethod -Uri "http://localhost:8787/api/provider-info" -Method Get | ConvertTo-Json -Depth 8

Write-Host ""
Write-Host "===== provider-check ====="
Invoke-RestMethod -Uri "http://localhost:8787/api/provider-check" -Method Get | ConvertTo-Json -Depth 8

Write-Host ""
Write-Host "Done. Go back to the page and click deep answer."
