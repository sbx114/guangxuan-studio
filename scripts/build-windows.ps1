param(
  [string]$RuntimeZip,
  [string]$FFmpegDirectory,
  [string]$OutputDirectory,
  [string]$CacheDirectory,
  [switch]$CreateZip,
  [switch]$SkipDependencies
)
$ErrorActionPreference = 'Stop'
$repoRoot = [System.IO.Path]::GetFullPath((Split-Path -Parent $PSScriptRoot))
$package = Get-Content -LiteralPath (Join-Path $repoRoot 'package.json') -Raw | ConvertFrom-Json
$electronVersion = $package.config.electronRuntimeVersion
if (-not $electronVersion) { $electronVersion = $package.devDependencies.electron }
if ($electronVersion -notmatch '^\d+\.\d+\.\d+$') { throw 'Electron version must be pinned.' }
if (-not $OutputDirectory) { $OutputDirectory = Join-Path $repoRoot 'dist/Guangxuan-Studio-win32-x64' }
if (-not $CacheDirectory) { $CacheDirectory = Join-Path $repoRoot '.build-cache' }
$buildOutput = [System.IO.Path]::GetFullPath($OutputDirectory)
$buildCache = [System.IO.Path]::GetFullPath($CacheDirectory)
if ($buildOutput -eq $repoRoot -or $buildOutput -eq [System.IO.Path]::GetPathRoot($buildOutput)) {
  throw 'Choose a dedicated build output directory.'
}
foreach ($required in @('package.json','server.mjs','LICENSE','lib','public','desktop','animation','scripts')) {
  if (-not (Test-Path -LiteralPath (Join-Path $repoRoot $required))) { throw "Missing required application path: $required" }
}
if (-not (Test-Path -LiteralPath (Join-Path $repoRoot 'public/rhine/index.html'))) {
  throw 'The Rhine home has not been built. Run npm run build:home (or pnpm run build:home) first.'
}
if (-not (Test-Path -LiteralPath (Join-Path $repoRoot 'THIRD_PARTY_NOTICES.md'))) {
  throw 'The required THIRD_PARTY_NOTICES.md is missing.'
}
if ((Test-Path -LiteralPath $buildOutput) -and
    (Get-ChildItem -LiteralPath $buildOutput -Force | Select-Object -First 1) -and
    -not (Test-Path -LiteralPath (Join-Path $buildOutput '.guangxuan-build.json'))) {
  throw 'The output directory is not an existing Guangxuan build. Choose an empty directory.'
}
New-Item -ItemType Directory -Path $buildOutput,$buildCache -Force | Out-Null
@{ product = 'Guangxuan Studio'; version = $package.version; state = 'building' } | ConvertTo-Json |
  Set-Content -LiteralPath (Join-Path $buildOutput '.guangxuan-build.json') -Encoding UTF8
$runtimeName = "electron-v$electronVersion-win32-x64.zip"
$releaseBase = "https://github.com/electron/electron/releases/download/v$electronVersion"
if (-not $RuntimeZip) { $RuntimeZip = Join-Path $buildCache $runtimeName }
$RuntimeZip = [System.IO.Path]::GetFullPath($RuntimeZip)
function Get-BuildFile([string]$Uri, [string]$Destination) {
  if (Get-Command curl.exe -ErrorAction SilentlyContinue) {
    & curl.exe -sS -L --fail --retry 2 --connect-timeout 20 --max-time 900 $Uri -o $Destination
    if ($LASTEXITCODE -ne 0) { throw "Download failed: $Uri" }
  } else { Invoke-WebRequest -Uri $Uri -OutFile $Destination -UseBasicParsing }
}
if (-not (Test-Path -LiteralPath $RuntimeZip)) {
  Write-Output "Downloading Electron $electronVersion..."
  Get-BuildFile "$releaseBase/$runtimeName" $RuntimeZip
}
$checksumFile = Join-Path $buildCache "SHASUMS256-v$electronVersion.txt"
if (-not (Test-Path -LiteralPath $checksumFile)) {
  Get-BuildFile "$releaseBase/SHASUMS256.txt" $checksumFile
}
$checksumLine = Get-Content -LiteralPath $checksumFile | Where-Object { $_ -match [regex]::Escape($runtimeName) + '$' } | Select-Object -First 1
if (-not $checksumLine) { throw 'The official checksum does not list this runtime.' }
$expectedHash = ($checksumLine.Trim() -split '\s+')[0].ToLowerInvariant()
$actualHash = (Get-FileHash -LiteralPath $RuntimeZip -Algorithm SHA256).Hash.ToLowerInvariant()
if ($actualHash -ne $expectedHash) { throw 'Electron SHA256 verification failed.' }
Write-Output 'Electron SHA256 verified.'
Expand-Archive -LiteralPath $RuntimeZip -DestinationPath $buildOutput -Force
$runtimeExecutable = Join-Path $buildOutput 'electron.exe'
$appExecutable = Join-Path $buildOutput '光宣工作台.exe'
foreach ($candidate in @($runtimeExecutable, $appExecutable)) {
  if (-not ([System.IO.Path]::GetFullPath($candidate)).StartsWith($buildOutput + [System.IO.Path]::DirectorySeparatorChar, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw 'Executable path escaped the output directory.'
  }
}
if (Test-Path -LiteralPath $appExecutable) {
  Copy-Item -LiteralPath $runtimeExecutable -Destination $appExecutable -Force
  Remove-Item -LiteralPath $runtimeExecutable -Force
} else { Rename-Item -LiteralPath $runtimeExecutable -NewName '光宣工作台.exe' }
$appDestination = Join-Path $buildOutput 'resources/app'
New-Item -ItemType Directory -Path $appDestination -Force | Out-Null
foreach ($required in @('package.json','server.mjs','LICENSE','lib','public','desktop','animation','scripts')) {
  $source = Join-Path $repoRoot $required
  if (-not (Test-Path -LiteralPath $source)) { throw "Missing required application path: $required" }
  Copy-Item -LiteralPath $source -Destination $appDestination -Recurse -Force
}
foreach ($launcher in @('启动光宣工作台.cmd','停止本地服务.cmd')) {
  $launcherSource = Join-Path $repoRoot $launcher
  if (Test-Path -LiteralPath $launcherSource) { Copy-Item -LiteralPath $launcherSource -Destination $buildOutput -Force }
}
if (-not $SkipDependencies) {
  Write-Output 'Installing production rendering dependencies...'
  $previousElectronSkip = $env:ELECTRON_SKIP_BINARY_DOWNLOAD
  $env:ELECTRON_SKIP_BINARY_DOWNLOAD = '1'
  try {
    if (Get-Command npm.cmd -ErrorAction SilentlyContinue) {
      & npm.cmd install --prefix $appDestination --omit=dev --ignore-scripts --no-audit --no-fund
    } elseif (Get-Command pnpm.cmd -ErrorAction SilentlyContinue) {
      & pnpm.cmd --dir $appDestination install --prod --ignore-scripts --lockfile=false --config.node-linker=hoisted
    } else { throw 'Install Node.js (including npm) before building from source.' }
    if ($LASTEXITCODE -ne 0) { throw 'Production dependency installation failed.' }
  } finally {
    $env:ELECTRON_SKIP_BINARY_DOWNLOAD = $previousElectronSkip
  }
}
if (-not (Test-Path -LiteralPath (Join-Path $appDestination 'node_modules/@remotion/renderer'))) {
  throw 'The packaged Remotion renderer is missing.'
}
if (-not $FFmpegDirectory) {
  $FFmpegDirectory = & (Join-Path $PSScriptRoot 'get-ffmpeg.ps1') -CacheDirectory $buildCache
}
$ffmpegDistribution = [System.IO.Path]::GetFullPath($FFmpegDirectory)
$ffmpegBin = Join-Path $ffmpegDistribution 'bin'
if (-not (Test-Path -LiteralPath $ffmpegBin)) { $ffmpegBin = $ffmpegDistribution; $ffmpegDistribution = Split-Path -Parent $ffmpegDistribution }
$packagedBin = Join-Path $buildOutput 'resources/bin'
$ffmpegNotices = Join-Path $buildOutput 'resources/third-party/ffmpeg'
New-Item -ItemType Directory -Path $packagedBin,$ffmpegNotices -Force | Out-Null
foreach ($binary in @('ffmpeg.exe','ffprobe.exe')) {
  $sourceBinary = Join-Path $ffmpegBin $binary
  if (-not (Test-Path -LiteralPath $sourceBinary)) { throw "FFmpeg distribution is missing $binary." }
  Copy-Item -LiteralPath $sourceBinary -Destination $packagedBin -Force
}
foreach ($notice in @('LICENSE','README.txt','doc')) {
  $noticePath = Join-Path $ffmpegDistribution $notice
  if (Test-Path -LiteralPath $noticePath) { Copy-Item -LiteralPath $noticePath -Destination $ffmpegNotices -Recurse -Force }
}
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'ffmpeg-manifest.json') -Destination $ffmpegNotices -Force
$ffmpegInfo = Start-Process -FilePath (Join-Path $ffmpegBin 'ffmpeg.exe') -ArgumentList '-buildconf' -WindowStyle Hidden -Wait -PassThru `
  -RedirectStandardError (Join-Path $ffmpegNotices 'build-configuration.txt') -RedirectStandardOutput (Join-Path $ffmpegNotices 'build-output.txt')
if ($ffmpegInfo.ExitCode -ne 0) { throw 'Unable to inspect the bundled FFmpeg build.' }
foreach ($optional in @('README.md','PRIVACY.md','THIRD_PARTY_NOTICES.md','docs','tests')) {
  $source = Join-Path $repoRoot $optional
  if (Test-Path -LiteralPath $source) { Copy-Item -LiteralPath $source -Destination $appDestination -Recurse -Force }
}
@{
  product = 'Guangxuan Studio'; version = $package.version; electron = $electronVersion; state = 'complete'
  runtimeSHA256 = $actualHash
} | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $buildOutput '.guangxuan-build.json') -Encoding UTF8
$launchNote = @'
光宣工作台 Windows 便携版

1. 将整个文件夹解压到本地，不要单独移动 EXE。
2. 原生桌面版：双击“光宣工作台.exe”。此方式无需安装 Node.js。
   兼容桌面入口：双击“启动光宣工作台.cmd”，使用已安装的 Node.js 24+ 与 Edge 标准应用窗口。
   兼容入口不执行 Electron，也不修改 Windows 安全策略。
3. 在应用的“模型连接”中填写中转站地址、模型名称和 API 密钥。
4. Remotion 动画渲染使用本机的 Microsoft Edge 或 Google Chrome。

项目保存在当前 Windows 账户的应用数据目录。
兼容入口的数据在 %LOCALAPPDATA%/GuangxuanStudio；“停止本地服务.cmd”可关闭其后台服务。
查看、编辑和导出已有项目不需要联网，AI 生成会连接你配置的服务。
选择“记住密钥”时使用 Windows 系统加密，仅当前账户可解密。

此为未经代码签名的开源便携版。发布源码随附 MIT 许可证。
Electron 及 Chromium 的许可证保留在本目录的 LICENSE 和 LICENSES.chromium.html 中。
Remotion 与 FFmpeg 使用各自的许可证，详见 resources/app/desktop/THIRD_PARTY.md。
'@
$launchNote | Set-Content -LiteralPath (Join-Path $buildOutput '使用说明.txt') -Encoding UTF8
if ($CreateZip) {
  $zipPath = "$buildOutput.zip"
  Compress-Archive -LiteralPath $buildOutput -DestinationPath $zipPath -CompressionLevel Optimal -Force
  Write-Output "Archive: $zipPath"
}
Write-Output "Application: $appExecutable"
