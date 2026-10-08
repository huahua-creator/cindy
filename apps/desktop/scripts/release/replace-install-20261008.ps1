param([switch]$VerifyOnly)

$ErrorActionPreference = 'Stop'
$log = 'D:\AI\Claude\cindy\apps\desktop\release\replace-install-20261008.log'
function Log([string]$m) {
  $line = '{0} {1}' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $m
  if (-not $VerifyOnly) { Add-Content -LiteralPath $log -Value $line -Encoding UTF8 }
  Write-Host $line
}
function Sha256([string]$path) {
  return (Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash.ToLowerInvariant()
}
function StopCindy {
  for ($i = 0; $i -lt 8; $i++) {
    $running = @(Get-Process -Name Cindy -ErrorAction SilentlyContinue)
    if ($running.Count -eq 0) {
      Log 'cindy stopped'
      return
    }
    Log ('stop attempt=' + ($i + 1) + ' pids=' + (($running | ForEach-Object { $_.Id }) -join ','))
    foreach ($p in $running) { Stop-Process -Id $p.Id -Force -ErrorAction SilentlyContinue }
    Start-Sleep -Seconds 2
  }
  $left = @(Get-Process -Name Cindy -ErrorAction SilentlyContinue)
  if ($left.Count -gt 0) {
    Log ('cindy still running after stop: ' + (($left | ForEach-Object { $_.Id }) -join ','))
    throw 'Cindy still running; silent NSIS would show the running-app dialog and exit 1602'
  }
}
function InstallSetup([string]$setup) {
  Log ('installer=' + $setup)
  $p = Start-Process -FilePath $setup -ArgumentList '/S' -PassThru -Wait -WindowStyle Hidden
  Log ('installer exit=' + $p.ExitCode)
  return $p.ExitCode
}
function ReadSource {
  if (-not (Test-Path -LiteralPath $src)) { return $null }
  return (Get-Content -LiteralPath $src -Raw | ConvertFrom-Json)
}

Log 'start'
$setup = 'D:\AI\Claude\cindy\apps\desktop\release\artifacts\cn\unversioned\win32-x64\cindy-unversioned-Setup.exe'
$rollback = 'D:\AI\Claude\cindy\apps\desktop\release\rollback\e0041fc08\cindy-unversioned-Setup.exe'
$exe = 'C:\Users\XINDONG\AppData\Local\Programs\Cindy\Cindy.exe'
$src = 'C:\Users\XINDONG\AppData\Local\Programs\Cindy\resources\cindy-source.json'
$want = 'bbc495b1223b69622845f8f0ff2caa342a61fe2d'
$wantTag = 'v0.1.97'
$old = 'e0041fc0877756723409544cae7c2693923dab0d'
$rollbackSha = '6da74aaccc9b0dbab215b47b71b53211e369f5fd9a452b542157e6411bedf2a0'
$expectedNewSha = '928bd4f55996f2191268b2d1f977a7bf8bd0e5a83b648f4bf8425b5f74ea5793'
$buildInfoPath = Join-Path (Split-Path -Parent $setup) 'build-info.json'

if (-not (Test-Path -LiteralPath $rollback)) {
  Log 'rollback MISSING'
  exit 1
}
$actualRollbackSha = Sha256 $rollback
if ($actualRollbackSha -ne $rollbackSha) {
  Log ('rollback sha mismatch got=' + $actualRollbackSha)
  exit 1
}
if (-not (Test-Path -LiteralPath $setup)) {
  Log 'new installer MISSING'
  exit 1
}
$newSha = Sha256 $setup
if ($newSha -eq $rollbackSha) {
  Log 'new installer is still the rollback copy; pack did not replace artifacts'
  exit 1
}
if ($newSha -ne $expectedNewSha) { throw 'New installer does not match the reviewed artifact' }
$buildInfo = Get-Content -LiteralPath $buildInfoPath -Raw | ConvertFrom-Json
$artifacts = @($buildInfo.files | Where-Object { $_.role -eq 'installer' -and $_.name -eq (Split-Path -Leaf $setup) })
if ($buildInfo.commitSha -ne $want -or $buildInfo.region -ne 'cn' -or
    $buildInfo.platformKey -ne 'win32-x64' -or $buildInfo.versionless -ne $true -or
    $artifacts.Count -ne 1 -or $artifacts[0].sha256 -ne $expectedNewSha -or
    $artifacts[0].size -ne (Get-Item -LiteralPath $setup).Length) {
  throw 'New installer metadata mismatch; no processes stopped'
}
if ($VerifyOnly) {
  Log 'preflight passed (VerifyOnly); no stop, install or launch performed'
  return
}

function RestoreOld {
  Log 'restore old'
  $restoreExit = InstallSetup $rollback
  Start-Sleep -Seconds 2
  $restored = ReadSource
  $ok = ($restoreExit -eq 0) -and ($null -ne $restored) -and ($restored.sourceCommit -eq $old)
  Log ('restore verify=' + $ok)
  if (-not $ok) { exit 1 }
}

StopCindy
$exit = InstallSetup $setup
Start-Sleep -Seconds 2
if ($exit -ne 0) {
  Log 'new installer failed; rolling back'
  RestoreOld
  exit 1
}

$j = ReadSource
if ($null -eq $j) {
  Log 'source MISSING after new install; rolling back'
  RestoreOld
  exit 1
}
Log ('source=' + (Get-Content -LiteralPath $src -Raw))
if (Test-Path -LiteralPath $exe) {
  $vi = (Get-Item -LiteralPath $exe).VersionInfo
  Log ('FileVersion=' + $vi.FileVersion + ' ProductVersion=' + $vi.ProductVersion)
}
$ok = ($j.sourceCommit -eq $want) -and ($j.upstreamTag -eq $wantTag)
if (Test-Path -LiteralPath $exe) {
  $vi = (Get-Item -LiteralPath $exe).VersionInfo
  $ok = $ok -and ($vi.FileVersion -eq '0.0.0')
}
Log ('verify=' + $ok)
if (-not $ok) {
  Log 'metadata verify failed; rolling back'
  RestoreOld
  exit 1
}
if (-not (Test-Path -LiteralPath $exe)) {
  Log 'Cindy.exe MISSING after verified install; rolling back'
  RestoreOld
  exit 1
}
Log 'launch Cindy'
Start-Process -FilePath $exe
Start-Sleep -Seconds 3
$launched = @(Get-Process -Name Cindy -ErrorAction SilentlyContinue)
if ($launched.Count -eq 0) {
  Log 'Cindy did not stay running after launch'
  exit 1
}
Log ('launched pids=' + (($launched | ForEach-Object { $_.Id }) -join ','))
Log 'done'
Log 'VISIBLE CHECK REQUIRED: sidebar CN · 0.1.97 Beta; About 0.1.97; get-app-version still 0.0.0'
exit 0
