param([string]$ExternalLocation)
$ErrorActionPreference = 'Stop'
if (Get-Process notch-app -ErrorAction SilentlyContinue) {
    throw 'Tutup NotchApp sebelum memperbarui paket lokasi, lalu jalankan kembali skrip ini.'
}
if (-not $ExternalLocation) {
    $weatherInstalledPackage = Get-AppxPackage -Name 'NotchApp.Identity'
    if ($weatherInstalledPackage) {
        $weatherRepositoryPath = 'HKCU:\Software\Classes\Local Settings\Software\Microsoft\Windows\CurrentVersion\AppModel\Repository\Packages\' + $weatherInstalledPackage.PackageFullName
        $ExternalLocation = (Get-ItemProperty -LiteralPath $weatherRepositoryPath -Name PackageRootFolder -ErrorAction SilentlyContinue).PackageRootFolder
    }
    if (-not $ExternalLocation) { $ExternalLocation = Join-Path $PSScriptRoot '..\target\debug' }
}
$weatherExternalPath = (Resolve-Path -LiteralPath $ExternalLocation).Path
$weatherPackagePath = Join-Path $PSScriptRoot '..\target\identity\NotchApp.Identity.0.1.0.1.msix'
if (-not (Test-Path -LiteralPath (Join-Path $weatherExternalPath 'notch-app.exe'))) {
    throw 'notch-app.exe tidak ditemukan pada lokasi aplikasi.'
}
if (-not (Test-Path -LiteralPath $weatherPackagePath)) {
    throw 'Paket capability lokasi belum dibangun dan ditandatangani.'
}
Add-AppxPackage -Path $weatherPackagePath -ExternalLocation $weatherExternalPath
$weatherUpdatedPackage = Get-AppxPackage -Name 'NotchApp.Identity'
if (-not $weatherUpdatedPackage -or $weatherUpdatedPackage.Version -ne '0.1.0.1') {
    throw 'Pembaruan paket belum aktif. Jalankan ulang skrip setelah semua proses NotchApp ditutup.'
}
$weatherManifest = Get-AppxPackageManifest -Package $weatherUpdatedPackage.PackageFullName
if (@($weatherManifest.Package.Capabilities.DeviceCapability | Where-Object Name -eq 'location').Count -eq 0) {
    throw 'Paket aktif belum memiliki capability lokasi.'
}
Write-Output "Paket lokasi 0.1.0.1 aktif. External location: $weatherExternalPath"
