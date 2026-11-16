param([string]$CacheDirectory)
$ErrorActionPreference = 'Stop'
$repoRoot = [System.IO.Path]::GetFullPath((Split-Path -Parent $PSScriptRoot))
if (-not $CacheDirectory) { $CacheDirectory = Join-Path $repoRoot '.build-cache' }
$cacheRoot = [System.IO.Path]::GetFullPath($CacheDirectory)
New-Item -ItemType Directory -Path $cacheRoot -Force | Out-Null
$manifest = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'ffmpeg-manifest.json') -Raw | ConvertFrom-Json
$archive = Join-Path $cacheRoot "ffmpeg-$($manifest.version)-essentials_build.zip"
$extracted = Join-Path $cacheRoot 'ffmpeg-runtime'
$distribution = Join-Path $extracted $manifest.directory
if (-not (Test-Path -LiteralPath $archive)) {
  Write-Host "Downloading FFmpeg $($manifest.version)..."
  & curl.exe -sS -L --fail --retry 2 --connect-timeout 20 --max-time 900 $manifest.url -o $archive
  if ($LASTEXITCODE -ne 0) { throw 'FFmpeg download failed.' }
}
$digest = (Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash.ToLowerInvariant()
if ($digest -ne $manifest.sha256) { throw 'FFmpeg SHA256 verification failed.' }
if (-not (Test-Path -LiteralPath (Join-Path $distribution 'bin/ffmpeg.exe')) -or
    -not (Test-Path -LiteralPath (Join-Path $distribution 'bin/ffprobe.exe'))) {
  Expand-Archive -LiteralPath $archive -DestinationPath $extracted -Force
}
Write-Output $distribution
