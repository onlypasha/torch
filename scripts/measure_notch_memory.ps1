param([int]$Samples = 3, [int]$IntervalSeconds = 10)
$ErrorActionPreference = 'Stop'
if ($Samples -lt 1 -or $Samples -gt 60 -or $IntervalSeconds -lt 1 -or $IntervalSeconds -gt 30) { throw 'Invalid sampling limits' }
$targetExe = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\src-tauri\target\debug\notch-app.exe'))
for ($sample = 1; $sample -le $Samples; $sample++) {
    $all = Get-CimInstance Win32_Process
    $root = @($all | Where-Object { $_.ExecutablePath -eq $targetExe })
    if ($root.Count -eq 0) { throw 'NotchApp is not running' }
    $ids = @($root.ProcessId)
    for ($depth = 0; $depth -lt 4; $depth++) {
        $children = @($all | Where-Object { $_.ParentProcessId -in $ids -and $_.ProcessId -notin $ids } | ForEach-Object ProcessId)
        if ($children.Count -eq 0) { break }
        $ids += $children
    }
    $perf = @(Get-CimInstance Win32_PerfFormattedData_PerfProc_Process | Where-Object { $_.IDProcess -in $ids })
    $native = @(Get-Process -Id $root.ProcessId)
    [pscustomobject]@{
        Time = (Get-Date).ToString('HH:mm:ss')
        Processes = $ids.Count
        PrivateWorkingSetMiB = [math]::Round(($perf | Measure-Object WorkingSetPrivate -Sum).Sum / 1MB, 1)
        PrivateBytesMiB = [math]::Round(($perf | Measure-Object PrivateBytes -Sum).Sum / 1MB, 1)
        NativePrivateMiB = [math]::Round(($native | Measure-Object PrivateMemorySize64 -Sum).Sum / 1MB, 1)
        NativeThreads = ($native | ForEach-Object { $_.Threads.Count } | Measure-Object -Sum).Sum
        NativeHandles = ($native | Measure-Object HandleCount -Sum).Sum
    }
    if ($sample -lt $Samples) { Start-Sleep -Seconds $IntervalSeconds }
}
