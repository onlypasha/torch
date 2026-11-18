param([string]$Executable = (Join-Path $PSScriptRoot '..\src-tauri\target\debug\notch-app.exe'))
$ErrorActionPreference = 'Stop'
$notchExecutablePath = (Resolve-Path -LiteralPath $Executable).Path
if (-not ('NotchLaunchCheck' -as [type])) {
    Add-Type @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
public static class NotchLaunchCheck {
    [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)]
    struct StartupInfo {
        public int cb; public string reserved, desktop, title;
        public int x, y, xSize, ySize, xCount, yCount, fill, flags;
        public short show, reservedBytes; public IntPtr reservedPointer, input, output, error;
    }
    [StructLayout(LayoutKind.Sequential)]
    struct ProcessInfo { public IntPtr process, thread; public int processId, threadId; }
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
    static extern bool CreateProcess(string app, string args, IntPtr processAttributes,
        IntPtr threadAttributes, bool inheritHandles, uint flags, IntPtr environment,
        string directory, ref StartupInfo startup, out ProcessInfo process);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool TerminateProcess(IntPtr process, uint code);
    [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
    public static void Verify(string path) {
        var startup = new StartupInfo { cb = Marshal.SizeOf(typeof(StartupInfo)) };
        ProcessInfo process;
        // Validate Windows activation without running application code or opening windows.
        if (!CreateProcess(path, null, IntPtr.Zero, IntPtr.Zero, false, 0x08000004,
            IntPtr.Zero, null, ref startup, out process)) {
            throw new Win32Exception(Marshal.GetLastWin32Error());
        }
        try {
            if (!TerminateProcess(process.process, 0)) throw new Win32Exception(Marshal.GetLastWin32Error());
        } finally { CloseHandle(process.thread); CloseHandle(process.process); }
    }
}
'@
}
try {
    [NotchLaunchCheck]::Verify($notchExecutablePath)
    Write-Output "PASS: Windows can launch $notchExecutablePath"
} catch {
    $notchLaunchFailure = $_.Exception
    while ($notchLaunchFailure.InnerException) { $notchLaunchFailure = $notchLaunchFailure.InnerException }
    Write-Output "FAIL: $($notchLaunchFailure.Message)"
    if ($notchLaunchFailure -is [System.ComponentModel.Win32Exception]) {
        Write-Output "nativeError=$($notchLaunchFailure.NativeErrorCode)"
    }
    exit 1
}
