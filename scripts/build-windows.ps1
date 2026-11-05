# Builds dist/PasswordProtect.exe on Windows, then checks the result works
# without Node. Run with the Node version that should be embedded.
$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $true
Set-Location (Join-Path $PSScriptRoot '..')

New-Item -ItemType Directory -Force dist | Out-Null
npx esbuild bin/protect.js --bundle --platform=node --format=cjs --log-level=warning --outfile=dist/protect.cjs

@{
  main = 'dist/protect.cjs'
  output = 'dist/PasswordProtect.exe'
  disableExperimentalSEAWarning = $true
  useSnapshot = $false
  useCodeCache = $false
} | ConvertTo-Json | Set-Content dist/sea-config.json -Encoding ascii

node --build-sea dist/sea-config.json

$exe = Resolve-Path dist/PasswordProtect.exe
$work = Join-Path $env:RUNNER_TEMP 'smoke'
if (-not $env:RUNNER_TEMP) { $work = Join-Path $env:TEMP 'protect-smoke' }
Remove-Item -Recurse -Force $work -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force (Join-Path $work 'My Folder') | Out-Null
Set-Content (Join-Path $work 'My Folder/a.txt') 'smoke test' -NoNewline

$env:PATH = "$env:SystemRoot\System32"
'smoke-test-password' | & $exe lock (Join-Path $work 'My Folder') --remove --password-stdin
if (Test-Path (Join-Path $work 'My Folder')) { throw 'Original was not removed' }
'smoke-test-password' | & $exe unlock (Join-Path $work 'My Folder.locked') --password-stdin
if ((Get-Content (Join-Path $work 'My Folder/a.txt') -Raw) -ne 'smoke test') { throw 'Contents differ' }
Write-Host "Built and verified: $exe"
