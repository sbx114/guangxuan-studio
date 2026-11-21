# Install the compatible desktop launcher for the current Windows user.
# Copies application resources only; never launches/stops the app or changes policy.
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$SourceRoot,
    [string]$InstallRoot = (Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'Programs\GuangxuanStudio'),
    [string]$DesktopPath = ([Environment]::GetFolderPath('DesktopDirectory')),
    [string]$NodePath
)

$ErrorActionPreference = 'Stop'
$sourceDirectory = [IO.Path]::GetFullPath($SourceRoot)
$installationDirectory = [IO.Path]::GetFullPath($InstallRoot)
$desktopDirectory = [IO.Path]::GetFullPath($DesktopPath)
$userDataDirectory = [IO.Path]::GetFullPath((Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'GuangxuanStudio'))
$appDirectory = Join-Path $installationDirectory 'resources\app'
$markerPath = Join-Path $installationDirectory 'installation.json'
$shortcutPath = Join-Path $desktopDirectory 'Gx.lnk'
$launcherPath = Join-Path $installationDirectory '启动Gx.cmd'
$iconPath = Join-Path $installationDirectory 'Gx.ico'
$legacyShortcutPath = Join-Path $desktopDirectory '光宣工作台.lnk'
$legacyLauncherPath = Join-Path $installationDirectory '启动光宣工作台.cmd'

function Same-Path([string]$Left, [string]$Right) {
    return [string]::Equals([IO.Path]::GetFullPath($Left).TrimEnd('\', '/'), [IO.Path]::GetFullPath($Right).TrimEnd('\', '/'), [StringComparison]::OrdinalIgnoreCase)
}

function Assert-InstallationChild([string]$Candidate) {
    $resolved = [IO.Path]::GetFullPath($Candidate)
    $prefix = $installationDirectory.TrimEnd('\', '/') + [IO.Path]::DirectorySeparatorChar
    if (-not $resolved.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)) {
        throw 'A destination path is outside the selected installation directory.'
    }
}

if (-not (Test-Path -LiteralPath $sourceDirectory -PathType Container)) { throw 'The source package directory does not exist.' }
if (Same-Path $sourceDirectory $installationDirectory) { throw 'The source and installation directory must be different.' }
if ($installationDirectory.StartsWith($sourceDirectory.TrimEnd('\', '/') + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase) -or
    $sourceDirectory.StartsWith($installationDirectory.TrimEnd('\', '/') + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) {
    throw 'Source and installation directories must not contain one another.'
}
if ((Same-Path $installationDirectory $userDataDirectory) -or $installationDirectory.StartsWith($userDataDirectory + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) {
    throw 'The application cannot be installed into the existing user-data directory.'
}
if (Same-Path $installationDirectory ([IO.Path]::GetPathRoot($installationDirectory))) { throw 'A drive root is not an installation directory.' }

$required = @(
    'resources\app\package.json',
    'resources\app\server.mjs',
    'resources\app\scripts\start-local.mjs',
    'resources\app\node_modules\@remotion\renderer\package.json',
    'resources\app\node_modules\playwright-core\package.json',
    'resources\app\integrations\openfilm\packages\openfilm\studio\server\server.mjs',
    'resources\app\integrations\openfilm\packages\openfilm\studio\ui\dist\index.html',
    'resources\app\integrations\openfilm\LICENSE',
    'resources\app\integrations\openfilm\TRADEMARK.md',
    'resources\app\integrations\openfilm\packages\openfilm\library\LICENSE.md',
    'resources\app\desktop\icon.ico',
    'resources\app\LICENSE',
    'resources\bin\ffmpeg.exe',
    'resources\bin\ffprobe.exe',
    'resources\third-party',
    '启动Gx.cmd',
    '启动光宣工作台.cmd',
    '停止本地服务.cmd'
)
foreach ($relative in $required) {
    if (-not (Test-Path -LiteralPath (Join-Path $sourceDirectory $relative))) { throw "The package is incomplete: $relative" }
}
$package = Get-Content -LiteralPath (Join-Path $sourceDirectory 'resources\app\package.json') -Raw -Encoding UTF8 | ConvertFrom-Json
if ($package.name -ne 'guangxuan-studio') { throw 'The source is not a Guangxuan Studio package.' }
$playwright = Get-Content -LiteralPath (Join-Path $sourceDirectory 'resources\app\node_modules\playwright-core\package.json') -Raw -Encoding UTF8 | ConvertFrom-Json
if ($playwright.version -ne '1.61.1') { throw 'The source package requires root playwright-core 1.61.1.' }

if (Test-Path -LiteralPath $installationDirectory) {
    if (-not (Test-Path -LiteralPath $markerPath -PathType Leaf)) { throw 'The destination already exists and is not marked as a managed installation.' }
    $previous = Get-Content -LiteralPath $markerPath -Raw -Encoding UTF8 | ConvertFrom-Json
    if ($previous.app -ne 'GuangxuanStudio' -or -not (Same-Path $previous.installRoot $installationDirectory)) {
        throw 'The destination belongs to a different installation.'
    }
}

$shell = New-Object -ComObject WScript.Shell
if (Test-Path -LiteralPath $shortcutPath) {
    $oldShortcut = $shell.CreateShortcut($shortcutPath)
    if (-not (Same-Path $oldShortcut.TargetPath $launcherPath) -and
        -not (Same-Path $oldShortcut.TargetPath $legacyLauncherPath)) { throw 'An unrelated desktop shortcut already uses this name.' }
}
$removeLegacyShortcut = $false
if (Test-Path -LiteralPath $legacyShortcutPath) {
    $legacyShortcut = $shell.CreateShortcut($legacyShortcutPath)
    $removeLegacyShortcut = (Same-Path $legacyShortcut.TargetPath $legacyLauncherPath) -or
        (Same-Path $legacyShortcut.TargetPath $launcherPath)
}

if (-not $NodePath) {
    $nodeCommand = Get-Command node.exe -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($nodeCommand) { $NodePath = $nodeCommand.Source }
    else {
        $runtimeCandidate = Join-Path ([Environment]::GetFolderPath('UserProfile')) '.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe'
        if (Test-Path -LiteralPath $runtimeCandidate -PathType Leaf) { $NodePath = $runtimeCandidate }
    }
}
if (-not $NodePath -or -not (Test-Path -LiteralPath $NodePath -PathType Leaf)) { throw 'Node.js 24 or later must already be installed.' }
$nodeVersion = (& $NodePath --version | Out-String).Trim()
if ($LASTEXITCODE -ne 0 -or $nodeVersion -notmatch '^v(\d+)\.' -or [int]$Matches[1] -lt 24) { throw 'Node.js 24 or later is required.' }

[void][IO.Directory]::CreateDirectory($installationDirectory)
[void][IO.Directory]::CreateDirectory($desktopDirectory)

function Copy-ApplicationTree([string]$RelativePath) {
    $from = Join-Path $sourceDirectory $RelativePath
    $to = Join-Path $installationDirectory $RelativePath
    Assert-InstallationChild $to
    $arguments = @($from, $to, '/E', '/COPY:DAT', '/DCOPY:DAT', '/R:1', '/W:1', '/XJ', '/NP', '/NFL', '/NDL', '/NJH', '/NJS')
    if ($RelativePath -eq 'resources\app') {
        # Runtime data and secrets are never installed, including accidental
        # additions to a package assembled from a development checkout.
        $arguments += '/XD'
        foreach ($name in @('.data', 'userData', 'userdata', 'logs', 'log', 'keys', 'browser-profile', '.git', 'work', 'outputs')) {
            $arguments += (Join-Path $from $name)
        }
        $arguments += @('/XF', '*.log', '.env', '.env.*', 'connection-settings.json', 'desktop-runtime.json')
    }
    $copyOutput = & robocopy.exe @arguments
    $copyExit = $LASTEXITCODE
    if ($copyExit -ge 8) { throw "Application file copy failed (robocopy $copyExit). $($copyOutput | Select-Object -Last 5 | Out-String)" }
}

Copy-ApplicationTree 'resources\app'
Copy-ApplicationTree 'resources\bin'
Copy-ApplicationTree 'resources\third-party'
foreach ($name in @('启动Gx.cmd', '启动光宣工作台.cmd', '停止本地服务.cmd', '重启Gx.cmd', '重启光宣工作台.cmd')) {
    if (-not (Test-Path -LiteralPath (Join-Path $sourceDirectory $name))) { continue }
    $destination = Join-Path $installationDirectory $name
    Assert-InstallationChild $destination
    Copy-Item -LiteralPath (Join-Path $sourceDirectory $name) -Destination $destination -Force
}
if (Test-Path -LiteralPath (Join-Path $sourceDirectory '使用说明.txt') -PathType Leaf) {
    Copy-Item -LiteralPath (Join-Path $sourceDirectory '使用说明.txt') -Destination (Join-Path $installationDirectory '使用说明.txt') -Force
}
$installedInstaller = Join-Path $appDirectory 'scripts\install-desktop.ps1'
if ($PSCommandPath -and -not (Same-Path $PSCommandPath $installedInstaller)) {
    Copy-Item -LiteralPath $PSCommandPath -Destination $installedInstaller -Force
}

# Use the packaged multi-resolution icon so small desktop sizes stay clear.
$packagedIcon = Join-Path $appDirectory 'desktop\icon.ico'
$iconBytes = [IO.File]::ReadAllBytes($packagedIcon)
if ($iconBytes.Length -lt 22 -or [BitConverter]::ToUInt16($iconBytes, 0) -ne 0 -or
    [BitConverter]::ToUInt16($iconBytes, 2) -ne 1 -or [BitConverter]::ToUInt16($iconBytes, 4) -lt 1 -or
    $iconBytes.Length -lt (6 + 16 * [BitConverter]::ToUInt16($iconBytes, 4))) {
    throw 'The packaged application icon is invalid.'
}
Copy-Item -LiteralPath $packagedIcon -Destination $iconPath -Force

$shortcut = $shell.CreateShortcut($shortcutPath)
$shortcut.TargetPath = $launcherPath
$shortcut.Arguments = ''
$shortcut.WorkingDirectory = $installationDirectory
$shortcut.IconLocation = "$iconPath,0"
$shortcut.WindowStyle = 7
$shortcut.Description = 'Gx · 本地 AI 创作空间'
$shortcut.Save()

$marker = [ordered]@{
    app = 'GuangxuanStudio'
    displayName = 'Gx'
    version = [string]$package.version
    installRoot = $installationDirectory
    appRoot = $appDirectory
    source = $sourceDirectory
}
[IO.File]::WriteAllText($markerPath, ($marker | ConvertTo-Json -Depth 4), [Text.UTF8Encoding]::new($false))

$verified = $shell.CreateShortcut($shortcutPath)
if (-not (Same-Path $verified.TargetPath $launcherPath) -or $verified.Arguments -ne '' -or
    -not (Same-Path $verified.WorkingDirectory $installationDirectory) -or $verified.WindowStyle -ne 7 -or
    -not (Test-Path -LiteralPath $verified.TargetPath -PathType Leaf) -or
    -not (Test-Path -LiteralPath $verified.WorkingDirectory -PathType Container) -or
    -not (Test-Path -LiteralPath $iconPath -PathType Leaf) -or $verified.IconLocation -ne "$iconPath,0") {
    throw 'Desktop shortcut verification failed.'
}

# This documented launcher branch reads dependencies/service health only.
# It does not create an Edge window, stop the running app, or start a service.
$checkOutput = (& $NodePath (Join-Path $appDirectory 'scripts\start-local.mjs') --check | Out-String).Trim()
if ($LASTEXITCODE -ne 0) { throw 'Installed application dependency check failed.' }
$check = $checkOutput | ConvertFrom-Json
if ($removeLegacyShortcut) { Remove-Item -LiteralPath $legacyShortcutPath -Force }
[ordered]@{
    app = 'GuangxuanStudio'
    displayName = 'Gx'
    version = [string]$package.version
    installRoot = $installationDirectory
    appRoot = $appDirectory
    shortcut = $shortcutPath
    target = $verified.TargetPath
    arguments = $verified.Arguments
    workingDirectory = $verified.WorkingDirectory
    icon = $verified.IconLocation
    windowStyle = $verified.WindowStyle
    check = $check
} | ConvertTo-Json -Depth 5
