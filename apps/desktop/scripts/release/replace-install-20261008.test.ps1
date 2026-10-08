$ErrorActionPreference = 'Stop'
$source = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'replace-install-20261008.ps1') -Raw
$tokens = $null
$errors = $null
$ast = [System.Management.Automation.Language.Parser]::ParseInput($source, [ref]$tokens, [ref]$errors)
if ($errors.Count) { throw 'Script parse failed' }
function Assert($condition, $message) { if (-not $condition) { throw $message } }

# Extract only definitions for the return-value regression; never run installer code.
$definitions = $ast.FindAll({ param($n) $n -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -in @('Log','InstallSetup') }, $false)
$functionText = ($definitions | ForEach-Object { $_.Extent.Text }) -join "`n"
& {
  $VerifyOnly = $true
  $log = 'unused'
  $script:fakeExit = 0
  function Start-Process { param($FilePath,$ArgumentList,[switch]$PassThru,[switch]$Wait,$WindowStyle) [pscustomobject]@{ExitCode=$script:fakeExit} }
  Invoke-Expression $functionText
  $result = @(InstallSetup 'fake.exe')
  Assert ($result.Count -eq 1 -and $result[0] -is [int] -and $result[0] -eq 0) 'Success return was polluted by logging'
  Assert (-not [bool]($result[0] -ne 0)) 'Success selected rollback'
  Assert ([bool](($result[0] -eq 0) -and $true)) 'Restore success rejected'
  $script:fakeExit = 7
  $result = @(InstallSetup 'fake.exe')
  Assert ($result.Count -eq 1 -and $result[0] -eq 7) 'Failure exit code was lost'
}

# Run the complete VerifyOnly path with virtual files and poisoned write/process APIs.
$scriptBlock = [scriptblock]::Create($source)
foreach ($scenario in @('valid','wrongCommit','wrongHash','wrongSize')) {
  & {
    param($case)
    $script:case = $case
    $script:newHash = '928bd4f55996f2191268b2d1f977a7bf8bd0e5a83b648f4bf8425b5f74ea5793'
    function Test-Path { param($LiteralPath) return $true }
    function Get-FileHash {
      param($LiteralPath,$Algorithm)
      $h = if ($LiteralPath -like '*rollback*') { '6da74aaccc9b0dbab215b47b71b53211e369f5fd9a452b542157e6411bedf2a0' } else { $script:newHash }
      if ($script:case -eq 'wrongHash' -and $LiteralPath -notlike '*rollback*') { $h = 'bad' }
      [pscustomobject]@{Hash=$h}
    }
    function Get-Content {
      param($LiteralPath,[switch]$Raw)
      $commit = if ($script:case -eq 'wrongCommit') { 'stale' } else { 'bbc495b1223b69622845f8f0ff2caa342a61fe2d' }
      @{commitSha=$commit;region='cn';platformKey='win32-x64';versionless=$true;files=@(@{role='installer';name='cindy-unversioned-Setup.exe';sha256=$script:newHash;size=247091987})} | ConvertTo-Json -Depth 4
    }
    function Get-Item { param($LiteralPath) [pscustomobject]@{Length=$(if($script:case -eq 'wrongSize'){1}else{247091987})} }
    function Start-Process { throw 'FORBIDDEN_PROCESS' }
    function Stop-Process { throw 'FORBIDDEN_PROCESS' }
    function Get-Process { throw 'FORBIDDEN_PROCESS' }
    function Add-Content { throw 'FORBIDDEN_WRITE' }
    $failure = $null
    try { & $scriptBlock -VerifyOnly } catch { $failure = $_.Exception.Message }
    Assert ($failure -notmatch 'FORBIDDEN') 'VerifyOnly caused a side effect'
    if ($case -eq 'valid') { Assert ($null -eq $failure) 'Valid preflight failed' }
    else { Assert ($null -ne $failure) 'Invalid artifact was accepted' }
  } $scenario
}
Write-Host 'PASS: return isolation, restore comparison, failure code, and four VerifyOnly scenarios'
