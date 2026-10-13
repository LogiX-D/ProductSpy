param()
$ErrorActionPreference = 'Stop'
$phase18Workspace = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$phase18Package = Join-Path $phase18Workspace 'artifacts\ProductSpy-0.7.0-windows-x64'
$phase18Launcher = Join-Path $phase18Package 'launcher\ProductSpy.ps1'
$phase18Stamp = [DateTime]::UtcNow.ToString('yyyy-MM-ddTHH-mm-ss-fffZ')
$phase18Root = Join-Path $phase18Workspace ('.test-data\phase18-screenshots\' + $phase18Stamp)
$phase18Data = Join-Path $phase18Root 'user'
$phase18Runtime = Join-Path $phase18Root 'runtime'
if (Get-NetTCPConnection -State Listen -LocalPort 3000 -ErrorAction SilentlyContinue) { throw 'Port 3000 is occupied. No existing listener will be stopped.' }
New-Item -ItemType Directory -Path $phase18Root -Force | Out-Null
$phase18Args = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ('"' + $phase18Launcher + '"'), '-Headless', '-NoBrowser', '-DataRoot', ('"' + $phase18Data + '"'), '-RuntimeRoot', ('"' + $phase18Runtime + '"'))
$phase18Process = Start-Process -FilePath powershell.exe -ArgumentList $phase18Args -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $phase18Root 'launcher.log') -RedirectStandardError (Join-Path $phase18Root 'launcher-error.log')
try {
  $phase18Ready = $false
  for ($phase18Try = 0; $phase18Try -lt 100; $phase18Try++) {
    Start-Sleep -Milliseconds 300
    try {
      $phase18StatePath = Join-Path $phase18Runtime 'launcher-state.json'
      if (Test-Path -LiteralPath $phase18StatePath) {
        $phase18State = Get-Content -LiteralPath $phase18StatePath -Raw | ConvertFrom-Json
        $phase18Status = Invoke-RestMethod -Uri 'http://127.0.0.1:3000/api/status' -TimeoutSec 2
        if ($phase18Status.data.version -eq '0.7.0' -and $phase18Status.data.mode -eq 'mock' -and $phase18State.launcherPid -eq $phase18Process.Id) { $phase18Ready = $true; break }
      }
    } catch { }
  }
  if (-not $phase18Ready) { throw ('Owned portable screenshot service did not become ready. Inspect ' + $phase18Root) }
  Push-Location $phase18Workspace
  try { & node scripts/phase18-screenshots.mjs --data-root $phase18Data; if ($LASTEXITCODE -ne 0) { throw 'Actual screenshot checks failed.' } } finally { Pop-Location }
} finally {
  & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $phase18Launcher -Headless -NoBrowser -DataRoot $phase18Data -RuntimeRoot $phase18Runtime -Action Stop
  $phase18Process.WaitForExit(20000) | Out-Null
}
