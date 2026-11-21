param(
  [string]$RuntimeZip,
  [string]$FFmpegDirectory,
  [string]$ReferenceToolsDirectory,
  [string]$OutputDirectory,
  [string]$CacheDirectory,
  [switch]$CreateZip,
  [switch]$SkipDependencies,
  [switch]$PublicDistribution
)
$ErrorActionPreference = 'Stop'
$repoRoot = [System.IO.Path]::GetFullPath((Split-Path -Parent $PSScriptRoot))
$package = Get-Content -LiteralPath (Join-Path $repoRoot 'package.json') -Raw | ConvertFrom-Json
$electronVersion = $package.config.electronRuntimeVersion
if (-not $electronVersion) { $electronVersion = $package.devDependencies.electron }
if ($electronVersion -notmatch '^\d+\.\d+\.\d+$') { throw 'Electron version must be pinned.' }
if (-not $OutputDirectory) { $OutputDirectory = Join-Path $repoRoot 'dist/Gx-Windows-x64' }
if (-not $CacheDirectory) { $CacheDirectory = Join-Path $repoRoot '.build-cache' }
$buildOutput = [System.IO.Path]::GetFullPath($OutputDirectory)
$buildCache = [System.IO.Path]::GetFullPath($CacheDirectory)
if ($buildOutput -eq $repoRoot -or $buildOutput -eq [System.IO.Path]::GetPathRoot($buildOutput)) {
  throw 'Choose a dedicated build output directory.'
}
foreach ($required in @('package.json','server.mjs','LICENSE','lib','public','desktop','desktop/icon.ico','animation','scripts')) {
  if (-not (Test-Path -LiteralPath (Join-Path $repoRoot $required))) { throw "Missing required application path: $required" }
}
if (-not (Test-Path -LiteralPath (Join-Path $repoRoot 'public/rhine/index.html'))) {
  throw 'The Rhine home has not been built. Run npm run build:home (or pnpm run build:home) first.'
}
if (-not (Test-Path -LiteralPath (Join-Path $repoRoot 'THIRD_PARTY_NOTICES.md'))) {
  throw 'The required THIRD_PARTY_NOTICES.md is missing.'
}
if ($package.dependencies.'playwright-core' -ne '1.61.1') { throw 'playwright-core 1.61.1 must be a root production dependency.' }
$nativePackager = Join-Path $PSScriptRoot 'package-openfilm-runtime.mjs'
& node $nativePackager --check
if ($LASTEXITCODE -ne 0) { throw 'OpenFilm native runtime preflight failed. Build its Studio UI before packaging.' }
if ((Test-Path -LiteralPath $buildOutput) -and
    (Get-ChildItem -LiteralPath $buildOutput -Force | Select-Object -First 1) -and
    -not (Test-Path -LiteralPath (Join-Path $buildOutput '.guangxuan-build.json'))) {
  throw 'The output directory is not an existing Guangxuan build. Choose an empty directory.'
}
New-Item -ItemType Directory -Path $buildOutput,$buildCache -Force | Out-Null
@{ product = 'Gx'; version = $package.version; state = 'building' } | ConvertTo-Json |
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
$appExecutable = Join-Path $buildOutput 'Gx.exe'
$legacyExecutable = Join-Path $buildOutput '光宣工作台.exe'
foreach ($candidate in @($runtimeExecutable, $appExecutable, $legacyExecutable)) {
  if (-not ([System.IO.Path]::GetFullPath($candidate)).StartsWith($buildOutput + [System.IO.Path]::DirectorySeparatorChar, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw 'Executable path escaped the output directory.'
  }
}
# Preserve an existing native entry with the unmodified, verified runtime.
if (Test-Path -LiteralPath $legacyExecutable -PathType Leaf) {
  Copy-Item -LiteralPath $runtimeExecutable -Destination $legacyExecutable -Force
}
if (Test-Path -LiteralPath $appExecutable) {
  Copy-Item -LiteralPath $runtimeExecutable -Destination $appExecutable -Force
  Remove-Item -LiteralPath $runtimeExecutable -Force
} else { Rename-Item -LiteralPath $runtimeExecutable -NewName 'Gx.exe' }
& (Join-Path $PSScriptRoot 'set-windows-icon.ps1') -ExecutablePath $appExecutable -IconPath (Join-Path $repoRoot 'desktop/icon.ico')
$appDestination = Join-Path $buildOutput 'resources/app'
New-Item -ItemType Directory -Path $appDestination -Force | Out-Null
foreach ($required in @('package.json','server.mjs','LICENSE','lib','public','desktop','animation','scripts')) {
  $source = Join-Path $repoRoot $required
  if (-not (Test-Path -LiteralPath $source)) { throw "Missing required application path: $required" }
  Copy-Item -LiteralPath $source -Destination $appDestination -Recurse -Force
}
$lockFile = Join-Path $repoRoot 'package-lock.json'
if (Test-Path -LiteralPath $lockFile) { Copy-Item -LiteralPath $lockFile -Destination $appDestination -Force }
& node $nativePackager --destination $appDestination
if ($LASTEXITCODE -ne 0) { throw 'OpenFilm native runtime packaging failed.' }
foreach ($launcher in @('启动Gx.cmd','启动光宣工作台.cmd','停止本地服务.cmd','重启Gx.cmd','重启光宣工作台.cmd')) {
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
$playwrightPackage = Join-Path $appDestination 'node_modules/playwright-core/package.json'
if (-not (Test-Path -LiteralPath $playwrightPackage)) { throw 'The packaged root playwright-core dependency is missing.' }
$playwright = Get-Content -LiteralPath $playwrightPackage -Raw -Encoding UTF8 | ConvertFrom-Json
if ($playwright.version -ne '1.61.1') { throw 'The packaged playwright-core version must be 1.61.1.' }
if ($PublicDistribution) {
  # Public releases obtain these separate tools from their fixed official
  # sources on first start. Preserve development build behavior by default.
  $compositorDirectory = [IO.Path]::GetFullPath((Join-Path $appDestination 'node_modules/@remotion/compositor-win32-x64-msvc'))
  $applicationPrefix = [IO.Path]::GetFullPath($appDestination).TrimEnd('\', '/') + [IO.Path]::DirectorySeparatorChar
  if (-not $compositorDirectory.StartsWith($applicationPrefix, [StringComparison]::OrdinalIgnoreCase)) { throw 'Compositor path escaped this build.' }
  if (Test-Path -LiteralPath $compositorDirectory) {
    if ((Get-Item -LiteralPath $compositorDirectory -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Public builds cannot contain a linked compositor directory.' }
    Remove-Item -LiteralPath $compositorDirectory -Recurse -Force
  }
  $downloadNotices = Join-Path $buildOutput 'resources/third-party/runtime-downloads'
  New-Item -ItemType Directory -Path $downloadNotices -Force | Out-Null
  Copy-Item -LiteralPath (Join-Path $repoRoot 'scripts/distribution-runtime-manifest.json') -Destination $downloadNotices -Force
  foreach ($notice in @('COPYRIGHT.md','PROJECT_LICENSE.txt','THIRD_PARTY_SOURCES.md')) {
    $sourceNotice = Join-Path $repoRoot $notice
    if (Test-Path -LiteralPath $sourceNotice) { Copy-Item -LiteralPath $sourceNotice -Destination $buildOutput -Force }
  }
  foreach ($relative in @('resources/bin/ffmpeg.exe','resources/bin/ffprobe.exe','resources/bin/yt-dlp.exe')) {
    $existing = [IO.Path]::GetFullPath((Join-Path $buildOutput $relative))
    if (-not $existing.StartsWith($buildOutput.TrimEnd('\', '/') + [IO.Path]::DirectorySeparatorChar,[StringComparison]::OrdinalIgnoreCase)) { throw 'Runtime tool path escaped this build.' }
    if (Test-Path -LiteralPath $existing -PathType Leaf) { Remove-Item -LiteralPath $existing -Force }
  }
} else {
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
$referenceManifest = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'reference-downloader-manifest.json') -Raw | ConvertFrom-Json
if (-not $ReferenceToolsDirectory) {
  $ReferenceToolsDirectory = Join-Path $buildCache 'reference-tools'
  & node (Join-Path $PSScriptRoot 'reference-downloader-setup.mjs') --output-dir ([IO.Path]::GetFullPath($ReferenceToolsDirectory))
  if ($LASTEXITCODE -ne 0) { throw 'Reference video tool download or checksum verification failed.' }
}
$referenceTool = Join-Path $ReferenceToolsDirectory $referenceManifest.filename
if (-not (Test-Path -LiteralPath $referenceTool -PathType Leaf) -or
    (Get-Item -LiteralPath $referenceTool).Length -ne $referenceManifest.bytes -or
    (Get-FileHash -LiteralPath $referenceTool -Algorithm SHA256).Hash.ToLowerInvariant() -ne $referenceManifest.sha256) { throw 'Reference video tool does not match the pinned official release.' }
Copy-Item -LiteralPath $referenceTool -Destination (Join-Path $packagedBin $referenceManifest.filename) -Force
$referenceNotices = Join-Path $buildOutput 'resources/third-party/reference-video'
New-Item -ItemType Directory -Path $referenceNotices -Force | Out-Null
foreach ($notice in @('reference-downloader.json','SHA2-256SUMS','yt-dlp-SOURCE-LICENSE.txt','yt-dlp-BINARY-GPL-3.0.txt','yt-dlp-README.md')) {
  $noticePath = Join-Path $ReferenceToolsDirectory $notice
  if (-not (Test-Path -LiteralPath $noticePath -PathType Leaf)) { throw "Reference video tool notice is missing: $notice" }
  Copy-Item -LiteralPath $noticePath -Destination $referenceNotices -Force
}
}
foreach ($optional in @('README.md','PRIVACY.md','THIRD_PARTY_NOTICES.md','docs','tests')) {
  $source = Join-Path $repoRoot $optional
  if (Test-Path -LiteralPath $source) { Copy-Item -LiteralPath $source -Destination $appDestination -Recurse -Force }
}
if ($PublicDistribution) {
  $publicFiles = @(Get-ChildItem -LiteralPath $buildOutput -File -Force -Recurse)
  foreach ($file in $publicFiles) {
    $relative = $file.FullName.Substring($buildOutput.TrimEnd('\', '/').Length + 1)
    if ($file.Name -in @('ffmpeg.exe','ffprobe.exe','yt-dlp.exe') -or
        $relative -match '(^|[\\/])compositor-win32-x64-msvc([\\/]|$)') { throw "An on-demand video binary remained in the public build: $relative" }
    if ($relative -match '(^|[\\/])(?:\.git|\.data|userData|userdata|work|outputs|browser-profile|keys|logs)([\\/]|$)' -or
        $file.Name -match '^(?:\.env(?:\..*)?|connection-settings\.json|desktop-runtime\.json)$' -or
        $file.Extension -in @('.docx','.log')) { throw "Private or development data remained in the public build: $relative" }
  }
}
@{
  product = 'Gx'; version = $package.version; electron = $electronVersion; state = 'complete'
  runtimeSHA256 = $actualHash
  publicDistribution = [bool]$PublicDistribution
} | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $buildOutput '.guangxuan-build.json') -Encoding UTF8
$launchNote = @'
Gx Windows 便携版

1. 将整个文件夹解压到本地，不要单独移动 EXE。
2. 原生桌面版：双击“Gx.exe”。此方式无需安装 Node.js。
   兼容桌面入口：双击“启动Gx.cmd”，使用已安装的 Node.js 24+ 与 Edge 标准应用窗口。
   兼容入口不执行 Electron，也不修改 Windows 安全策略。
3. 在应用的“模型连接”中填写中转站地址、模型名称和 API 密钥。
4. 视频项目使用集成的原生剪辑编辑器；Remotion与原生导出使用本机的 Microsoft Edge 或 Google Chrome。

项目方块对应真实记录。点击方块查看详情，可修改名称与简介；确认编辑后进入对应工作区。
项目保存在当前 Windows 账户的应用数据目录。
兼容入口的数据在 %LOCALAPPDATA%/GuangxuanStudio；“停止本地服务.cmd”可关闭其后台服务。
原生视频工程在 openfilm/projects/<项目ID>/，状态在 openfilm/state/；旧JSON资料继续保留。
视频备份应保存完整原生工程目录和关联资料，不能仅用旧JSON代替最新剪辑。
查看、编辑和导出已有项目不需要联网，AI 生成会连接你配置的服务。
Electron版选择“记住密钥”时使用 Windows 系统加密，仅当前账户可解密；兼容入口使用会话密钥。

此为未经代码签名的开源便携版。发布源码随附 MIT 许可证。
Electron 及 Chromium 的许可证保留在本目录的 LICENSE 和 LICENSES.chromium.html 中。
OpenFilm代码、商标及素材库的许可分别保留；素材库不能统称MIT。
Remotion、FFmpeg及其它组件使用各自的许可证，详见 resources/app/THIRD_PARTY_NOTICES.md。
'@
if ($PublicDistribution) {
  $launchNote = @'
Gx Windows x64 便携版

完整解压后打开 Gx.exe，无需预装 Node.js。首次启动需联网，应用直接从固定官方来源下载视频工具与 Remotion 运行组件并验证 SHA256；之后可离线使用已有素材。
Remotion与原生剪辑导出需要本机 Microsoft Edge 或 Google Chrome。
项目和模型设置保存在当前账户的应用数据目录，不随程序目录删除。
模型服务由用户自行配置。兼容“启动Gx.cmd”入口需要 Node.js 24+。
此版本未进行代码签名。项目及第三方许可范围详见 COPYRIGHT.md、PROJECT_LICENSE.txt、THIRD_PARTY_SOURCES.md 与 resources/app/THIRD_PARTY_NOTICES.md；根 LICENSE 属于 Electron。
'@
}
$launchNote | Set-Content -LiteralPath (Join-Path $buildOutput '使用说明.txt') -Encoding UTF8
if ($CreateZip) {
  $zipPath = "$buildOutput.zip"
  Compress-Archive -LiteralPath $buildOutput -DestinationPath $zipPath -CompressionLevel Optimal -Force
  Write-Output "Archive: $zipPath"
}
Write-Output "Application: $appExecutable"
