param([string]$Version = '0.7.0')
$ErrorActionPreference = 'Stop'
if ($Version -notin @('0.7.0', '0.8.0')) { throw 'Only frozen Phase19 baseline / target packages.' }
$phase19Workspace = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$phase19Launcher = Join-Path $phase19Workspace ('artifacts\ProductSpy-' + $Version + '-windows-x64\launcher\ProductSpy.ps1')
$phase19Root = Join-Path $phase19Workspace ('.test-data\phase19-performance\' + $Version + '-' + [DateTime]::UtcNow.ToString('yyyyMMddTHHmmssfff'))
$phase19Data = Join-Path $phase19Root 'user'
$phase19Runtime = Join-Path $phase19Root 'runtime'
if (Get-NetTCPConnection -State Listen -LocalPort 3000 -ErrorAction SilentlyContinue) { throw 'Port 3000 occupied; existing listener untouched.' }
New-Item -ItemType Directory -Path $phase19Root -Force | Out-Null
$phase19Timer = [Diagnostics.Stopwatch]::StartNew()
$phase19Arguments = @('-NoProfile','-ExecutionPolicy','Bypass','-File',('"'+$phase19Launcher+'"'),'-Headless','-NoBrowser','-DataRoot',('"'+$phase19Data+'"'),'-RuntimeRoot',('"'+$phase19Runtime+'"'))
$phase19Process = Start-Process powershell.exe -ArgumentList $phase19Arguments -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $phase19Root 'launcher.log') -RedirectStandardError (Join-Path $phase19Root 'launcher-error.log')
try {
  $phase19Ready = $false
  for ($phase19Try=0; $phase19Try -lt 100; $phase19Try++) {
    Start-Sleep -Milliseconds 300
    try {
      $phase19State = Get-Content -LiteralPath (Join-Path $phase19Runtime 'launcher-state.json') -Raw | ConvertFrom-Json
      $phase19Status = Invoke-RestMethod 'http://127.0.0.1:3000/api/status' -TimeoutSec 2
      if ($phase19State.launcherPid -eq $phase19Process.Id -and $phase19Status.data.version -eq $Version -and $phase19Status.data.mode -eq 'mock') { $phase19Ready=$true;break }
    } catch { }
  }
  if (-not $phase19Ready) { throw 'Owned portable service failed to become ready.' }
  $phase19Timer.Stop()
  Push-Location $phase19Workspace
  try {
    & node scripts/phase19-performance.mjs --data-root $phase19Data --server-pid $phase19State.nodePid --version $Version --startup-ms $phase19Timer.ElapsedMilliseconds
    if ($LASTEXITCODE -ne 0) { throw 'Measured performance acceptance failed.' }
  } finally { Pop-Location }
} finally {
  & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $phase19Launcher -Headless -NoBrowser -DataRoot $phase19Data -RuntimeRoot $phase19Runtime -Action Stop
  $phase19Process.WaitForExit(20000) | Out-Null
}
