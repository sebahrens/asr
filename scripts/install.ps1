# asr CLI installer (Windows PowerShell 5.1+ / PowerShell 7+).
# Usage: $env:ASR_FORGEJO_URL='https://forge.example'; pwsh -NoProfile -File install.ps1 [VERSION]
$ErrorActionPreference = 'Stop'

$ForgejoUrl = $env:ASR_FORGEJO_URL
if (-not $ForgejoUrl) { $ForgejoUrl = 'https://forgejo.example.com' }

$Repo = if ($env:ASR_REPO) { $env:ASR_REPO } else { 'org/aks' }
$Version = if ($args.Count -gt 0) { $args[0] } else { 'latest' }
$Dest = if ($env:ASR_INSTALL_DIR) { $env:ASR_INSTALL_DIR } else { Join-Path $env:LOCALAPPDATA 'Programs\asr' }

if ($Version -eq 'latest') {
  $AssetBase = "$ForgejoUrl/$Repo/releases/latest/download"
} else {
  $AssetBase = "$ForgejoUrl/$Repo/releases/download/$Version"
}

New-Item -ItemType Directory -Force -Path $Dest | Out-Null

$AsrPath = Join-Path $Dest 'asr.mjs'
$ShaPath = Join-Path $Dest 'asr.mjs.sha256'

Invoke-WebRequest -Uri "$AssetBase/asr.mjs" -OutFile $AsrPath
Invoke-WebRequest -Uri "$AssetBase/asr.mjs.sha256" -OutFile $ShaPath

$Expected = (Get-Content $ShaPath -Raw).Split(' ')[0].Trim().ToLower()
$Actual = (Get-FileHash $AsrPath -Algorithm SHA256).Hash.ToLower()
if ($Expected -ne $Actual) {
  Remove-Item -Force $AsrPath, $ShaPath
  throw "SHA-256 mismatch: expected $Expected got $Actual"
}
Remove-Item -Force $ShaPath

$ShimPath = Join-Path $Dest 'asr.cmd'
@"
@echo off
node "%~dp0asr.mjs" %*
"@ | Set-Content -Path $ShimPath -Encoding ASCII

Write-Host "Installed asr to $ShimPath"
Write-Host "Add $Dest to your PATH if it isn't already."
