$ErrorActionPreference = 'Stop'
$log = 'D:\AI\Claude\cindy\apps\desktop\release\replace-install-20261008.log'
function Log([string]$m) {
  $line = '{0} {1}' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $m
  Add-Content -Path $log -Value $line -Encoding UTF8
  Write-Output $line
}
function Sha256([string]$path) {
  return (Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash.ToLowerInvariant()
}
function StopCindy {
  Get-Process -Name Cindy -ErrorAction SilentlyContinue | ForEach-Object {
    Log ('stop pid=' + $_.Id)
    Stop-Process -Id $_.Id -Force -ErrorAction SilentlyContinue
  }
  Start-Sleep -Seconds 3
  $left = @(Get-Process -Name Cindy -ErrorAction SilentlyContinue)
  if ($left.Count -gt 0) {
    Log ('still running after stop: ' + (($left | ForEach-Object { $_.Id }) -join ','))
    foreach ($p in $left) { Stop-Process -Id $p.Id -Force -ErrorAction SilentlyContinue }
    Start-Sleep -Seconds 2
  }
}
function InstallSetup([string]$setup) {
  Log ('installer=' + $setup)
  $p = Start-Process -FilePath $setup -ArgumentList '/S' -PassThru -Wait
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
$want = '3cfe760885beb85369660fa343ac5abd8585a83b'
$wantTag = 'v0.1.97'
$old = 'e0041fc0877756723409544cae7c2693923dab0d'
$rollbackSha = '6da74aaccc9b0dbab215b47b71b53211e369f5fd9a452b542157e6411bedf2a0'

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
Log 'launch Cindy'
Start-Process -FilePath $exe
Log 'done'
Log 'VISIBLE CHECK REQUIRED: sidebar CN · 0.1.97 Beta; About 0.1.97; get-app-version still 0.0.0'
exit 0
