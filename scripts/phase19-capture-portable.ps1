param()
$ErrorActionPreference = 'Stop'
$phase19Workspace = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$phase19Package = Join-Path $phase19Workspace 'artifacts\ProductSpy-0.8.0-windows-x64'
$phase19Launcher = Join-Path $phase19Package 'launcher\ProductSpy.ps1'
$phase19Stamp = [DateTime]::UtcNow.ToString('yyyy-MM-ddTHH-mm-ss-fffZ')
$phase19Root = Join-Path $phase19Workspace ('.test-data\phase19-screenshots\' + $phase19Stamp)
$phase19Data = Join-Path $phase19Root 'user'
$phase19Runtime = Join-Path $phase19Root 'runtime'
if (Get-NetTCPConnection -State Listen -LocalPort 3000 -ErrorAction SilentlyContinue) { throw 'Port 3000 is occupied. No existing listener will be stopped.' }
New-Item -ItemType Directory -Path $phase19Root -Force | Out-Null
$phase19PreviousMode = $env:AI_MODE
$env:AI_MODE = 'mock'
$phase19Args = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ('"' + $phase19Launcher + '"'), '-Headless', '-NoBrowser', '-DataRoot', ('"' + $phase19Data + '"'), '-RuntimeRoot', ('"' + $phase19Runtime + '"'))
$phase19Process = Start-Process -FilePath powershell.exe -ArgumentList $phase19Args -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $phase19Root 'launcher.log') -RedirectStandardError (Join-Path $phase19Root 'launcher-error.log')
try {
  $phase19Ready = $false
  for ($phase19Try = 0; $phase19Try -lt 100; $phase19Try++) {
    Start-Sleep -Milliseconds 300
    try {
      $phase19StatePath = Join-Path $phase19Runtime 'launcher-state.json'
      if (Test-Path -LiteralPath $phase19StatePath) {
        $phase19State = Get-Content -LiteralPath $phase19StatePath -Raw | ConvertFrom-Json
        $phase19Status = Invoke-RestMethod -Uri 'http://127.0.0.1:3000/api/status' -TimeoutSec 2
        if ($phase19Status.data.version -eq '0.8.0' -and $phase19Status.data.mode -eq 'mock' -and $phase19State.launcherPid -eq $phase19Process.Id) { $phase19Ready = $true; break }
      }
    } catch { }
  }
  if (-not $phase19Ready) { throw ('Owned portable screenshot service did not become ready. Inspect ' + $phase19Root) }
  Push-Location $phase19Workspace
  try { & node scripts/phase19-screenshots.mjs --data-root $phase19Data; if ($LASTEXITCODE -ne 0) { throw 'Actual screenshot checks failed.' } } finally { Pop-Location }
} finally {
  & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $phase19Launcher -Headless -NoBrowser -DataRoot $phase19Data -RuntimeRoot $phase19Runtime -Action Stop
  $phase19Process.WaitForExit(20000) | Out-Null
  $env:AI_MODE = $phase19PreviousMode
}
