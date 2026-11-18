$ErrorActionPreference = 'Stop'

$identityDirectory = Join-Path $PSScriptRoot '..\target\identity'
$packagePath = Join-Path $identityDirectory 'NotchApp.Identity.msix'
$certificatePath = Join-Path $identityDirectory 'NotchAppDevelopment.cer'
$externalPath = (Resolve-Path (Join-Path $PSScriptRoot '..\target\debug')).Path
$resultPath = Join-Path $identityDirectory 'registration-result.txt'

try {
    if (-not (Test-Path (Join-Path $externalPath 'notch-app.exe'))) {
        throw 'notch-app.exe is missing from the external location.'
    }

    Import-Certificate -FilePath $certificatePath -CertStoreLocation 'Cert:\LocalMachine\TrustedPeople' | Out-Null
    Add-AppxPackage -Path $packagePath -ExternalLocation $externalPath

    $package = Get-AppxPackage -Name 'NotchApp.Identity'
    if (-not $package) {
        throw 'Windows did not report the registered NotchApp package.'
    }

    "OK`nPackage: $($package.PackageFullName)`nExternal location: $externalPath" |
        Set-Content -LiteralPath $resultPath
} catch {
    "FAILED`n$($_.Exception.Message)" | Set-Content -LiteralPath $resultPath
    throw
}
