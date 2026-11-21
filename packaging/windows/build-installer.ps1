[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$PayloadRoot,
  [Parameter(Mandatory = $true)][string]$CompilerPath,
  [Parameter(Mandatory = $true)][string]$OutputDirectory,
  [string]$ExtraNoticesDirectory,
  [switch]$TestBuild
)
$ErrorActionPreference = 'Stop'
$gxPayload = [IO.Path]::GetFullPath($PayloadRoot)
$gxCompiler = [IO.Path]::GetFullPath($CompilerPath)
$gxOutput = [IO.Path]::GetFullPath($OutputDirectory)
$gxScriptRoot = [IO.Path]::GetFullPath($PSScriptRoot)
if (-not (Test-Path -LiteralPath $gxPayload -PathType Container)) { throw 'The payload directory does not exist.' }
if (-not (Test-Path -LiteralPath $gxCompiler -PathType Leaf)) { throw 'Install the NSIS 3.13 compiler before building.' }
foreach ($relative in @('Gx.exe', 'LICENSE', 'LICENSES.chromium.html', 'resources/app/package.json', 'resources/app/desktop/main.cjs', 'resources/app/LICENSE', 'resources/app/THIRD_PARTY_NOTICES.md', 'resources/app/lib/distribution-runtime.mjs', 'resources/app/scripts/distribution-runtime-manifest.json')) {
  if (-not (Test-Path -LiteralPath (Join-Path $gxPayload $relative) -PathType Leaf)) { throw "Missing required payload file: $relative" }
}
foreach ($relative in @('resources/bin/ffmpeg.exe', 'resources/bin/ffprobe.exe', 'resources/bin/yt-dlp.exe')) {
  if (Test-Path -LiteralPath (Join-Path $gxPayload $relative)) { throw "The public installer downloads this third-party tool from its official source on first start; do not redistribute it: $relative" }
}
$gxPackage = Get-Content -LiteralPath (Join-Path $gxPayload 'resources/app/package.json') -Raw -Encoding UTF8 | ConvertFrom-Json
if ($gxPackage.name -ne 'guangxuan-studio' -or $gxPackage.version -notmatch '^\d+\.\d+\.\d+$') { throw 'The payload does not identify a pinned Gx application version.' }
$gxFiles = @(Get-ChildItem -LiteralPath $gxPayload -File -Force -Recurse | Sort-Object FullName)
$gxPrefix = $gxPayload.TrimEnd('\', '/') + [IO.Path]::DirectorySeparatorChar
$gxFiles | ForEach-Object {
  if (-not $_.FullName.StartsWith($gxPrefix, [StringComparison]::OrdinalIgnoreCase)) { throw 'A payload file escaped the selected payload root.' }
  $relative = $_.FullName.Substring($gxPrefix.Length)
  if ($relative -match '(^|[\\/])(?:\.git|\.data|userData|userdata|work|outputs|browser-profile|keys|logs)([\\/]|$)' -or
      $_.Name -match '^(?:\.env(?:\..*)?|connection-settings\.json|desktop-runtime\.json)$' -or
      $_.Extension -match '^\.(?:docx|log)$') { throw "Private or development data is not an installer input: $relative" }
  if ($_.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Reparse points are not installer input.' }
}
New-Item -ItemType Directory -Path $gxOutput -Force | Out-Null
$gxGenerated = Join-Path $gxOutput 'generated'
New-Item -ItemType Directory -Path $gxGenerated -Force | Out-Null
function Nsis-Quote([string]$Value) { return $Value.Replace('$', '$$').Replace('"', '$\"') }
$gxUninstall = [Collections.Generic.List[string]]::new()
foreach ($file in $gxFiles) {
  $relative = $file.FullName.Substring($gxPrefix.Length)
  $gxUninstall.Add('Delete "$INSTDIR\' + (Nsis-Quote $relative) + '"')
}
$gxUninstall.Add('Delete "$INSTDIR\安装说明.txt"')
if ($ExtraNoticesDirectory) {
  $gxExtra = [IO.Path]::GetFullPath($ExtraNoticesDirectory)
  if (-not (Test-Path -LiteralPath $gxExtra -PathType Container)) { throw 'The extra notices directory does not exist.' }
  foreach ($file in @(Get-ChildItem -LiteralPath $gxExtra -File -Force)) { $gxUninstall.Add('Delete "$INSTDIR\' + (Nsis-Quote $file.Name) + '"') }
}
$gxDirectories = @(Get-ChildItem -LiteralPath $gxPayload -Directory -Force -Recurse | Sort-Object @{e={$_.FullName.Length};Descending=$true})
foreach ($directory in $gxDirectories) { $gxUninstall.Add('RMDir "$INSTDIR\' + (Nsis-Quote $directory.FullName.Substring($gxPrefix.Length)) + '"') }
[IO.File]::WriteAllLines((Join-Path $gxGenerated 'uninstall-payload.nsh'), $gxUninstall, [Text.UTF8Encoding]::new($true))
$gxAppKey = 'Software\GuangxuanStudio\Installer'
$gxUninstallKey = 'Software\Microsoft\Windows\CurrentVersion\Uninstall\GuangxuanStudio'
$gxShortcut = 'Gx'
$gxDesktopShortcut = 'Gx Desktop'
$gxSuffix = ''
if ($TestBuild) {
  $gxAppKey += '-QA'
  $gxUninstallKey += '-QA'
  $gxShortcut += ' Installer QA'
  $gxDesktopShortcut += ' Installer QA'
  $gxSuffix = '-QA'
}
$gxDefines = @(
  '/V3',
  '/INPUTCHARSET', 'UTF8',
  ('/DPAYLOAD_ROOT=' + $gxPayload),
  ('/DAPP_VERSION=' + $gxPackage.version),
  ('/DOUTPUT_FILE=' + (Join-Path $gxOutput ('Gx-' + $gxPackage.version + '-Windows-x64-Setup' + $gxSuffix + '.exe'))),
  ('/DGENERATED_DIR=' + $gxGenerated),
  ('/DAPP_REGKEY=' + $gxAppKey),
  ('/DUNINSTALL_REGKEY=' + $gxUninstallKey),
  ('/DSHORTCUT_GROUP=' + $gxShortcut),
  ('/DDESKTOP_SHORTCUT=' + $gxDesktopShortcut)
)
if ($ExtraNoticesDirectory) { $gxDefines += '/DEXTRA_NOTICES=' + $gxExtra }
& $gxCompiler @gxDefines (Join-Path $gxScriptRoot 'Gx-Setup.nsi')
if ($LASTEXITCODE -ne 0) { throw 'NSIS installer compilation failed.' }
$gxResult = Join-Path $gxOutput ('Gx-' + $gxPackage.version + '-Windows-x64-Setup' + $gxSuffix + '.exe')
[ordered]@{
  product = 'Gx'; version = $gxPackage.version; architecture = 'win32-x64'; installer = $gxResult;
  bytes = (Get-Item -LiteralPath $gxResult).Length;
  sha256 = (Get-FileHash -LiteralPath $gxResult -Algorithm SHA256).Hash.ToLowerInvariant();
  compiler = 'NSIS 3.13'; signed = $false; payloadFiles = $gxFiles.Count; firstStartNeedsNetwork = $true;
  perUser = $true; externalNodeRequired = $false; testBuild = [bool]$TestBuild
} | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $gxOutput 'installer-build.json') -Encoding UTF8
Get-Content -LiteralPath (Join-Path $gxOutput 'installer-build.json')
