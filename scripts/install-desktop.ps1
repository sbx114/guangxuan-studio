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
$shortcutPath = Join-Path $desktopDirectory '光宣工作台.lnk'
$launcherPath = Join-Path $installationDirectory '启动光宣工作台.cmd'
$iconPath = Join-Path $installationDirectory '光宣工作台.ico'

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
    'resources\app\desktop\icon.png',
    'resources\app\LICENSE',
    'resources\bin\ffmpeg.exe',
    'resources\bin\ffprobe.exe',
    'resources\third-party',
    '启动光宣工作台.cmd',
    '停止本地服务.cmd'
)
foreach ($relative in $required) {
    if (-not (Test-Path -LiteralPath (Join-Path $sourceDirectory $relative))) { throw "The package is incomplete: $relative" }
}
$package = Get-Content -LiteralPath (Join-Path $sourceDirectory 'resources\app\package.json') -Raw -Encoding UTF8 | ConvertFrom-Json
if ($package.name -ne 'guangxuan-studio') { throw 'The source is not a Guangxuan Studio package.' }

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
    if (-not (Same-Path $oldShortcut.TargetPath $launcherPath)) { throw 'An unrelated desktop shortcut already uses this name.' }
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
foreach ($name in @('启动光宣工作台.cmd', '停止本地服务.cmd')) {
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

# Wrap the existing, original PNG in an ICO container without changing pixels.
$png = [IO.File]::ReadAllBytes((Join-Path $appDirectory 'desktop\icon.png'))
$signature = [byte[]](137, 80, 78, 71, 13, 10, 26, 10)
if ($png.Length -lt 24) { throw 'The application icon is incomplete.' }
for ($index = 0; $index -lt 8; $index++) { if ($png[$index] -ne $signature[$index]) { throw 'The application icon is not PNG.' } }
$width = [uint32]$png[16] * 16777216 + [uint32]$png[17] * 65536 + [uint32]$png[18] * 256 + [uint32]$png[19]
$height = [uint32]$png[20] * 16777216 + [uint32]$png[21] * 65536 + [uint32]$png[22] * 256 + [uint32]$png[23]
if ($width -lt 1 -or $height -lt 1 -or $width -gt 256 -or $height -gt 256) { throw 'The PNG icon must be no larger than 256 by 256 pixels.' }
$memory = [IO.MemoryStream]::new()
$writer = [IO.BinaryWriter]::new($memory)
try {
    $writer.Write([uint16]0); $writer.Write([uint16]1); $writer.Write([uint16]1)
    $writer.Write([byte]$(if ($width -eq 256) { 0 } else { $width }))
    $writer.Write([byte]$(if ($height -eq 256) { 0 } else { $height }))
    $writer.Write([byte]0); $writer.Write([byte]0)
    $writer.Write([uint16]1); $writer.Write([uint16]32)
    $writer.Write([uint32]$png.Length); $writer.Write([uint32]22)
    $writer.Write($png)
    $writer.Flush()
    [IO.File]::WriteAllBytes($iconPath, $memory.ToArray())
} finally { $writer.Dispose(); $memory.Dispose() }

$shortcut = $shell.CreateShortcut($shortcutPath)
$shortcut.TargetPath = $launcherPath
$shortcut.Arguments = ''
$shortcut.WorkingDirectory = $installationDirectory
$shortcut.IconLocation = "$iconPath,0"
$shortcut.WindowStyle = 7
$shortcut.Description = '光宣工作台 · 本地 AI 创作空间'
$shortcut.Save()

$marker = [ordered]@{
    app = 'GuangxuanStudio'
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
[ordered]@{
    app = 'GuangxuanStudio'
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
