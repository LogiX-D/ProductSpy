$ErrorActionPreference='Stop'
$phase21Workspace=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$phase21Package=Join-Path $phase21Workspace 'artifacts\ProductSpy-1.0.0-rc.1-windows-x64'
$phase21Launcher=Join-Path $phase21Package 'launcher\ProductSpy.ps1'
$phase21Stamp=[DateTime]::UtcNow.ToString('yyyy-MM-ddTHH-mm-ss-fffZ')
$phase21Root=Join-Path $phase21Workspace ('.test-data\phase21-media\'+$phase21Stamp)
$phase21Data=Join-Path $phase21Root 'user'
$phase21Runtime=Join-Path $phase21Root 'runtime'
if(Get-NetTCPConnection -State Listen -LocalPort 3000 -ErrorAction SilentlyContinue){throw 'Port occupied; no existing listener will be stopped.'}
New-Item -ItemType Directory -Path $phase21Root -Force | Out-Null
$phase21PreviousMode=$env:AI_MODE
$env:AI_MODE='mock'
$phase21Args=@('-NoProfile','-ExecutionPolicy','Bypass','-File',('"'+$phase21Launcher+'"'),'-Headless','-NoBrowser','-DataRoot',('"'+$phase21Data+'"'),'-RuntimeRoot',('"'+$phase21Runtime+'"'))
$phase21Process=Start-Process -FilePath powershell.exe -ArgumentList $phase21Args -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $phase21Root 'launcher.log') -RedirectStandardError (Join-Path $phase21Root 'launcher-error.log')
try{
 $phase21Ready=$false
 for($phase21Try=0;$phase21Try -lt 120;$phase21Try++){
  Start-Sleep -Milliseconds 250
  try{$phase21State=Get-Content -LiteralPath (Join-Path $phase21Runtime 'launcher-state.json') -Raw | ConvertFrom-Json;$phase21Status=Invoke-RestMethod -Uri 'http://127.0.0.1:3000/api/status' -TimeoutSec 2;if($phase21State.launcherPid -eq $phase21Process.Id -and $phase21Status.data.mode -eq 'mock' -and $phase21Status.data.version -eq '1.0.0-rc.1'){$phase21Ready=$true;break}}catch{}
 }
 if(-not $phase21Ready){throw 'Owned Mock service not ready'}
 Push-Location $phase21Workspace
 try{& node scripts/phase21-media-check.mjs $phase21Data;if($LASTEXITCODE -ne 0){throw 'Media diagnostic failed'}}finally{Pop-Location}
}finally{
 try{
  $phase21FinalState=$null
  try{$phase21FinalState=Get-Content -LiteralPath (Join-Path $phase21Runtime 'launcher-state.json') -Raw -ErrorAction Stop | ConvertFrom-Json}catch{}
  if($phase21FinalState.launcherPid -eq $phase21Process.Id){& powershell.exe -NoProfile -ExecutionPolicy Bypass -File $phase21Launcher -Headless -NoBrowser -DataRoot $phase21Data -RuntimeRoot $phase21Runtime -Action Stop}
 }finally{
  if(-not $phase21Process.WaitForExit(20000)){
   # Only the exact launcher process created above can be terminated.
   $phase21Process.Kill()
   $phase21Process.WaitForExit(10000) | Out-Null
  }
  $env:AI_MODE=$phase21PreviousMode
 }
}
