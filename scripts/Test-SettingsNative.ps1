param([switch]$SkipBuild)
$ErrorActionPreference = 'Stop'
$notchNativeRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..\src-tauri')).Path
$notchNativeExample = Join-Path $notchNativeRoot 'target\debug\examples\settings_smoke.exe'
Push-Location -LiteralPath $notchNativeRoot
try {
    if (-not $SkipBuild) {
        & cargo build --example settings_smoke --features tauri/custom-protocol
        if ($LASTEXITCODE -ne 0) { throw 'Build tes konfigurasi native gagal.' }
    }
    $notchSdkRoot = Join-Path ${env:ProgramFiles(x86)} 'Windows Kits\10\bin'
    $notchManifestTool = Get-ChildItem -LiteralPath $notchSdkRoot -Directory |
        Sort-Object Name -Descending |
        ForEach-Object { Join-Path $_.FullName 'x64\mt.exe' } |
        Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
    if (-not $notchManifestTool) { throw 'Manifest Tool dari Windows SDK tidak ditemukan.' }
    $notchTestManifest = Join-Path $notchNativeRoot 'windows-identity\app.manifest'
    & $notchManifestTool -nologo -manifest $notchTestManifest "-outputresource:$notchNativeExample;#1"
    if ($LASTEXITCODE -ne 0) { throw 'Pemasangan manifest pada executable tes gagal.' }
    & $notchNativeExample
    if ($LASTEXITCODE -ne 0) { throw 'Tes konfigurasi native gagal atau timeout.' }
} finally { Pop-Location }
