param()
$ErrorActionPreference = 'Stop'
$phase20Workspace = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$phase20Package = Join-Path $phase20Workspace 'artifacts\ProductSpy-1.0.0-rc.1-windows-x64'
$phase20Launcher = Join-Path $phase20Package 'launcher\ProductSpy.ps1'
$phase20Stamp = [DateTime]::UtcNow.ToString('yyyy-MM-ddTHH-mm-ss-fffZ')
$phase20Root = Join-Path $phase20Workspace ('.test-data\phase20-screenshots\' + $phase20Stamp)
$phase20Data = Join-Path $phase20Root 'user'
$phase20Runtime = Join-Path $phase20Root 'runtime'
if (Get-NetTCPConnection -State Listen -LocalPort 3000 -ErrorAction SilentlyContinue) { throw 'Port 3000 is occupied. No existing listener will be stopped.' }
New-Item -ItemType Directory -Path $phase20Root -Force | Out-Null
$phase20PreviousMode = $env:AI_MODE
$env:AI_MODE = 'mock'
$phase20Args = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ('"' + $phase20Launcher + '"'), '-Headless', '-NoBrowser', '-DataRoot', ('"' + $phase20Data + '"'), '-RuntimeRoot', ('"' + $phase20Runtime + '"'))
$phase20Process = Start-Process -FilePath powershell.exe -ArgumentList $phase20Args -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $phase20Root 'launcher.log') -RedirectStandardError (Join-Path $phase20Root 'launcher-error.log')
try {
  $phase20Ready = $false
  for ($phase20Try = 0; $phase20Try -lt 100; $phase20Try++) {
    Start-Sleep -Milliseconds 300
    try {
      $phase20StatePath = Join-Path $phase20Runtime 'launcher-state.json'
      if (Test-Path -LiteralPath $phase20StatePath) {
        $phase20State = Get-Content -LiteralPath $phase20StatePath -Raw | ConvertFrom-Json
        $phase20Status = Invoke-RestMethod -Uri 'http://127.0.0.1:3000/api/status' -TimeoutSec 2
        if ($phase20Status.data.version -eq '1.0.0-rc.1' -and $phase20Status.data.mode -eq 'mock' -and $phase20State.launcherPid -eq $phase20Process.Id) { $phase20Ready = $true; break }
      }
    } catch { }
  }
  if (-not $phase20Ready) { throw ('Owned portable screenshot service did not become ready. Inspect ' + $phase20Root) }
  Push-Location $phase20Workspace
  try { & node scripts/phase20-screenshots.mjs --data-root $phase20Data; if ($LASTEXITCODE -ne 0) { throw 'Actual screenshot checks failed.' } } finally { Pop-Location }
} finally {
  & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $phase20Launcher -Headless -NoBrowser -DataRoot $phase20Data -RuntimeRoot $phase20Runtime -Action Stop
  $phase20Process.WaitForExit(20000) | Out-Null
  $env:AI_MODE = $phase20PreviousMode
}
