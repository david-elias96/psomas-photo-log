# Builds "Psomas Photo Log.exe" (portable, single file).
# Stages the project to %LOCALAPPDATA%\PhotoLogBuild first so node_modules
# and build artifacts never land inside the OneDrive-synced project folder.
# Usage:  powershell -ExecutionPolicy Bypass -File .\build-exe.ps1

$ErrorActionPreference = 'Stop'
$src = $PSScriptRoot
$stage = Join-Path $env:LOCALAPPDATA 'PhotoLogBuild'

Write-Host "Staging to $stage ..."
New-Item -ItemType Directory -Force $stage | Out-Null
foreach ($item in @('index.html', 'app.js', 'styles.css', 'package.json')) {
    Copy-Item (Join-Path $src $item) $stage -Force
}
foreach ($dir in @('lib', 'electron', 'build')) {
    Copy-Item (Join-Path $src $dir) $stage -Recurse -Force
}

Push-Location $stage
try {
    Write-Host 'Installing build dependencies (first run takes a few minutes)...'
    npm install --no-audit --no-fund
    if ($LASTEXITCODE -ne 0) { throw "npm install failed (exit $LASTEXITCODE)" }

    # Pre-extract electron-builder's winCodeSign toolkit, excluding its macOS
    # symlinks (Windows can't create symlinks without admin/Developer Mode and
    # the extract aborts the whole build otherwise).
    $cache = Join-Path $env:LOCALAPPDATA 'electron-builder\Cache\winCodeSign'
    $signDir = Join-Path $cache 'winCodeSign-2.6.0'
    if (-not (Test-Path (Join-Path $signDir 'rcedit-x64.exe'))) {
        Write-Host 'Preparing winCodeSign cache (symlink workaround)...'
        New-Item -ItemType Directory -Force $cache | Out-Null
        $archive = Join-Path $cache 'winCodeSign-2.6.0.7z'
        if (-not (Test-Path $archive)) {
            curl.exe -sL -o $archive 'https://github.com/electron-userland/electron-builder-binaries/releases/download/winCodeSign-2.6.0/winCodeSign-2.6.0.7z'
        }
        $sevenZip = Join-Path $stage 'node_modules\7zip-bin\win\x64\7za.exe'
        & $sevenZip x -y "-o$signDir" '-xr!darwin' $archive | Out-Null
        if ($LASTEXITCODE -ne 0) { throw "winCodeSign extraction failed (exit $LASTEXITCODE)" }
    }

    Write-Host 'Building portable exe...'
    npx electron-builder --win portable
    if ($LASTEXITCODE -ne 0) { throw "electron-builder failed (exit $LASTEXITCODE)" }
}
finally {
    Pop-Location
}

$exe = Join-Path $stage 'dist\Psomas Photo Log.exe'
if (-not (Test-Path $exe)) { throw "Build finished but exe not found at $exe" }
New-Item -ItemType Directory -Force (Join-Path $src 'dist') | Out-Null
Copy-Item $exe (Join-Path $src 'dist\') -Force
$out = Get-Item (Join-Path $src 'dist\Psomas Photo Log.exe')
Write-Host ("Done: {0}  ({1:N1} MB)" -f $out.FullName, ($out.Length / 1MB))
