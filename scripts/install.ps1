# asr CLI installer (Windows PowerShell 5.1+ / PowerShell 7+).
# Usage: $env:ASR_FORGEJO_URL='https://forge.example'; pwsh -NoProfile -File install.ps1 [VERSION]
$ErrorActionPreference = 'Stop'

$ForgejoUrl = $env:ASR_FORGEJO_URL
if (-not $ForgejoUrl) { $ForgejoUrl = 'https://forgejo.example.com' }

$Repo = if ($env:ASR_REPO) { $env:ASR_REPO } else { 'org/aks' }
$Version = if ($args.Count -gt 0) { $args[0] } else { 'latest' }
$Dest = if ($env:ASR_INSTALL_DIR) { $env:ASR_INSTALL_DIR } else { Join-Path $env:LOCALAPPDATA 'Programs\asr' }
$AllowInsecure = $env:ASR_ALLOW_INSECURE_INSTALL -eq '1'
$PublicKeyPem = if ($env:ASR_INSTALL_PUBLIC_KEY_PEM) {
  $env:ASR_INSTALL_PUBLIC_KEY_PEM
} else {
@'
-----BEGIN PUBLIC KEY-----
MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAzSx3tw5U78hJdXcc773k
pxJk4WlD8+mMeN4ke7KUaF4AKCAgsEp4kjVj/cornoebWTlWp0aEhhuwrUjQ9fgE
FkgFYm1EJHefypMQyEINTLiXfI3aIVfrL6GioI5QMS8ZEI6M5gspNiWuFVTcg8Gz
sd5fXNgwYjUOcnXKM/aanVm3uD9dOufz4NCHfXNbr2Q239OVUndgivEwHXL8ry98
W5FgLiSdVzJnHXNgZvfgAyHHlY57xSnhjL7qMTVhLt5KzCg4AbB/Ok6gRjI21FZk
a/Vjpd7g5q9GquY7ukAnQjnT3VY/kbiDxb9KdiIc4v6paHj/PadzDg1plmxOXKNE
KQIDAQAB
-----END PUBLIC KEY-----
'@
}

if (-not $ForgejoUrl.StartsWith('https://') -and -not $AllowInsecure) {
  throw 'Refusing non-HTTPS release URL: set ASR_ALLOW_INSECURE_INSTALL=1 only for local development.'
}

if ($Version -eq 'latest') {
  $AssetBase = "$ForgejoUrl/$Repo/releases/latest/download"
} else {
  $AssetBase = "$ForgejoUrl/$Repo/releases/download/$Version"
}

New-Item -ItemType Directory -Force -Path $Dest | Out-Null

$AsrPath = Join-Path $Dest 'asr.mjs'
$ShimPath = Join-Path $Dest 'asr.cmd'
$TempDir = Join-Path ([System.IO.Path]::GetTempPath()) ([System.IO.Path]::GetRandomFileName())
New-Item -ItemType Directory -Force -Path $TempDir | Out-Null

try {
  $TempAsrPath = Join-Path $TempDir 'asr.mjs'
  $ShaPath = Join-Path $TempDir 'asr.mjs.sha256'
  $SigPath = Join-Path $TempDir 'asr.mjs.sig'
  $PublicKeyPath = Join-Path $TempDir 'asr-release.pub'

  Set-Content -Path $PublicKeyPath -Value $PublicKeyPem -Encoding ASCII

  Invoke-WebRequest -Uri "$AssetBase/asr.mjs" -OutFile $TempAsrPath
  Invoke-WebRequest -Uri "$AssetBase/asr.mjs.sha256" -OutFile $ShaPath
  Invoke-WebRequest -Uri "$AssetBase/asr.mjs.sig" -OutFile $SigPath

  $Expected = (Get-Content $ShaPath -Raw).Split(' ')[0].Trim().ToLower()
  $Actual = (Get-FileHash $TempAsrPath -Algorithm SHA256).Hash.ToLower()
  if ($Expected -ne $Actual) {
    throw "SHA-256 mismatch: expected $Expected got $Actual"
  }

  $VerifyOutput = & openssl dgst -sha256 -verify $PublicKeyPath -signature $SigPath $TempAsrPath 2>&1
  if ($LASTEXITCODE -ne 0) {
    throw "Signature verification failed for asr.mjs"
  }

  Move-Item -Force $TempAsrPath $AsrPath
} finally {
  Remove-Item -Recurse -Force -ErrorAction SilentlyContinue $TempDir
}

@"
@echo off
node "%~dp0asr.mjs" %*
"@ | Set-Content -Path $ShimPath -Encoding ASCII

Write-Host "Installed asr to $ShimPath"
Write-Host "Add $Dest to your PATH if it isn't already."
