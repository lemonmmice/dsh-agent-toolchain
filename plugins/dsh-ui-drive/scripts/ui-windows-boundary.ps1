if (-not ('UiDriveInputWin32' -as [type])) {
  Add-Type @"
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;
public sealed class UiDriveDesktopPolicyException : InvalidOperationException {
  public string PolicyCode { get; private set; }
  public string DesktopState { get; private set; }
  public UiDriveDesktopPolicyException(string code, string state) : base(code + ": desktop=" + state) {
    PolicyCode = code; DesktopState = state;
  }
}
public static class UiDriveInputWin32 {
  static readonly HashSet<byte> PressedKeys = new HashSet<byte>();
  static readonly object InputLock = new object();
  static uint PressedMouseButtons;
  [DllImport("user32.dll", SetLastError=true)] static extern IntPtr OpenInputDesktop(uint flags, bool inherit, uint access);
  [DllImport("user32.dll", SetLastError=true, CharSet=CharSet.Unicode)] static extern bool GetUserObjectInformation(IntPtr handle, int index, StringBuilder data, int length, out int needed);
  [DllImport("user32.dll")] static extern bool CloseDesktop(IntPtr handle);
  [DllImport("wtsapi32.dll", SetLastError=true)] static extern bool WTSQuerySessionInformation(IntPtr server, int sessionId, int infoClass, out IntPtr buffer, out uint bytes);
  [DllImport("wtsapi32.dll")] static extern void WTSFreeMemory(IntPtr buffer);
  [DllImport("kernel32.dll", SetLastError=true)] static extern IntPtr OpenProcess(uint access, bool inherit, int processId);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode)] static extern int GetApplicationUserModelId(IntPtr process, ref uint length, StringBuilder appId);
  [DllImport("user32.dll", EntryPoint="SetForegroundWindow")] static extern bool NativeSetForegroundWindow(IntPtr handle);
  [DllImport("user32.dll", EntryPoint="ShowWindow")] static extern bool NativeShowWindow(IntPtr handle, int command);
  [DllImport("user32.dll", EntryPoint="SetCursorPos")] static extern bool NativeSetCursorPos(int x, int y);
  [DllImport("user32.dll", EntryPoint="mouse_event")] static extern void NativeMouseEvent(uint flags, uint dx, uint dy, uint data, UIntPtr extra);
  [DllImport("user32.dll", EntryPoint="keybd_event")] static extern void NativeKeyboardEvent(byte key, byte scan, uint flags, UIntPtr extra);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr handle, out uint processId);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern int GetWindowText(IntPtr handle, StringBuilder title, int length);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumWindowsProc callback, IntPtr param);
  [DllImport("user32.dll", SetLastError=true)] static extern IntPtr SetThreadDpiAwarenessContext(IntPtr context);
  [DllImport("user32.dll")] static extern IntPtr GetThreadDpiAwarenessContext();
  [DllImport("user32.dll")] static extern int GetAwarenessFromDpiAwarenessContext(IntPtr context);
  delegate bool EnumWindowsProc(IntPtr handle, IntPtr param);
  public static bool UsePhysicalPixels() {
    try { return SetThreadDpiAwarenessContext(new IntPtr(-4)) != IntPtr.Zero; }
    catch (EntryPointNotFoundException) { return false; }
  }
  public static int GetDpiAwareness() {
    try { return GetAwarenessFromDpiAwarenessContext(GetThreadDpiAwarenessContext()); }
    catch (EntryPointNotFoundException) { return -1; }
  }
  public static string GetWindowTitle(IntPtr handle) {
    StringBuilder title = new StringBuilder(2048); GetWindowText(handle, title, title.Capacity); return title.ToString();
  }
  public static IntPtr ResolveWindow(int processId, long requestedHandle, string title, IntPtr defaultHandle) {
    if (requestedHandle != 0) {
      IntPtr handle = new IntPtr(requestedHandle); uint owner;
      GetWindowThreadProcessId(handle, out owner);
      if (owner != processId) throw new InvalidOperationException("window_identity_mismatch");
      return handle;
    }
    if (String.IsNullOrEmpty(title)) return defaultHandle;
    IntPtr matched = IntPtr.Zero;
    EnumWindows(delegate(IntPtr handle, IntPtr unused) {
      uint owner; GetWindowThreadProcessId(handle, out owner);
      if (owner == processId && GetWindowTitle(handle) == title) { matched = handle; return false; }
      return true;
    }, IntPtr.Zero);
    return matched == IntPtr.Zero ? defaultHandle : matched;
  }
  public static string GetDesktopState() {
    IntPtr desktop = OpenInputDesktop(0, false, 1);
    if (desktop == IntPtr.Zero) return "unknown";
    try {
      StringBuilder name = new StringBuilder(256); int needed;
      if (!GetUserObjectInformation(desktop, 2, name, name.Capacity * 2, out needed)) return "unknown";
      if (String.Equals(name.ToString(), "Default", StringComparison.OrdinalIgnoreCase)) return "unlocked";
      if (!String.Equals(name.ToString(), "Winlogon", StringComparison.OrdinalIgnoreCase)) return "secure";
      IntPtr session; uint bytes;
      if (!WTSQuerySessionInformation(IntPtr.Zero, Process.GetCurrentProcess().SessionId, 25, out session, out bytes)) return "unknown";
      try {
        if (bytes < 20 || Marshal.ReadInt32(session, 0) != 1) return "unknown";
        int flags = Marshal.ReadInt32(session, 16);
        return flags == 0 ? "locked" : (flags == 1 ? "secure" : "unknown");
      } finally { WTSFreeMemory(session); }
    } finally { CloseDesktop(desktop); }
  }
  public static string PolicyCodeForState(string state, string allowLocked) {
    if (state == "unlocked") return null;
    if (state == "locked" && (allowLocked == "1" || String.Equals(allowLocked, "true", StringComparison.OrdinalIgnoreCase))) return null;
    return state == "locked" ? "desktop_locked" : (state == "secure" ? "desktop_secure" : "desktop_unknown");
  }
  public static void AssertInputAllowed() {
    string state = GetDesktopState();
    string code = PolicyCodeForState(state, Environment.GetEnvironmentVariable("DSH_UI_ALLOW_LOCKED"));
    if (code != null) throw new UiDriveDesktopPolicyException(code, state);
  }
  public static string GetAumid(int processId) {
    IntPtr process = OpenProcess(0x1000, false, processId);
    if (process == IntPtr.Zero) throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
    try {
      uint length = 0;
      int result = GetApplicationUserModelId(process, ref length, null);
      if (result == 15703) return "";
      if (result != 122) throw new System.ComponentModel.Win32Exception(result);
      StringBuilder appId = new StringBuilder((int)length);
      result = GetApplicationUserModelId(process, ref length, appId);
      if (result != 0) throw new System.ComponentModel.Win32Exception(result);
      return appId.ToString();
    } finally { CloseHandle(process); }
  }
  public static bool SetForegroundWindow(IntPtr handle) { AssertInputAllowed(); return NativeSetForegroundWindow(handle); }
  public static bool ShowWindow(IntPtr handle, int command) { AssertInputAllowed(); return NativeShowWindow(handle, command); }
  public static bool SetCursorPos(int x, int y) { AssertInputAllowed(); return NativeSetCursorPos(x, y); }
  public static void mouse_event(uint flags, uint dx, uint dy, uint data, UIntPtr extra) {
    lock (InputLock) {
      uint released = (flags & 0x54) >> 1;
      bool trackedRelease = flags != 0 && (flags & ~0x54U) == 0 && (PressedMouseButtons & released) == released;
      if (!trackedRelease) AssertInputAllowed();
      NativeMouseEvent(flags, dx, dy, data, extra);
      PressedMouseButtons = (PressedMouseButtons | (flags & 0x2A)) & ~released;
    }
  }
  public static void keybd_event(byte key, byte scan, uint flags, UIntPtr extra) {
    lock (InputLock) {
      bool trackedRelease = flags == 2 && PressedKeys.Contains(key);
      if (!trackedRelease) AssertInputAllowed();
      NativeKeyboardEvent(key, scan, flags, extra);
      if ((flags & 2) == 0) PressedKeys.Add(key); else PressedKeys.Remove(key);
    }
  }
  public static void ReleaseKey(byte key) {
    lock (InputLock) {
      if (!PressedKeys.Remove(key)) return;
      NativeKeyboardEvent(key, 0, 2, UIntPtr.Zero);
    }
  }
  public static void ReleasePressedInputs() {
    lock (InputLock) {
      uint mouseRelease = PressedMouseButtons << 1;
      PressedMouseButtons = 0;
      if (mouseRelease != 0) NativeMouseEvent(mouseRelease, 0, 0, 0, UIntPtr.Zero);
      foreach (byte key in PressedKeys) NativeKeyboardEvent(key, 0, 2, UIntPtr.Zero);
      PressedKeys.Clear();
    }
  }
}
"@
}

function Get-UiDesktopState {
  try { return [UiDriveInputWin32]::GetDesktopState() }
  catch { return 'unknown' }
}

function Send-UiKeys([string]$keys) {
  Assert-UiInputAllowed
  [System.Windows.Forms.SendKeys]::SendWait($keys)
}

function Assert-UiInputAllowed {
  $desktopState = Get-UiDesktopState
  $policyCode = [UiDriveInputWin32]::PolicyCodeForState($desktopState, $env:DSH_UI_ALLOW_LOCKED)
  if ($policyCode) { throw (New-Object UiDriveDesktopPolicyException($policyCode, $desktopState)) }
}

function Get-UiPolicyFailure($exception) {
  while ($null -ne $exception) {
    if ($exception -is [UiDriveDesktopPolicyException]) {
      return @{ policyCode = $exception.PolicyCode; desktopState = $exception.DesktopState }
    }
    $exception = $exception.InnerException
  }
  return $null
}

function Get-UiProcessIdentity($process) {
  $identity = @{ publisherName = ''; publisherVerified = $false; signatureStatus = 'unavailable'; aumid = ''; aumidStatus = 'unavailable' }
  try {
    $exePath = [string]$process.Path
    if (-not $exePath) { $identity.identityError = 'process_path_unavailable'; return $identity }
    $identity.exe = $exePath
    $identity.exeCanonical = [System.IO.Path]::GetFullPath($exePath).ToLowerInvariant()
    $identity.binaryName = [System.IO.Path]::GetFileName($exePath)
    try {
      $versionInfo = (Get-Item -LiteralPath $exePath -ErrorAction Stop).VersionInfo
      $identity.company = [string]$versionInfo.CompanyName
      $identity.product = [string]$versionInfo.ProductName
      $identity.productName = [string]$versionInfo.ProductName
      $identity.description = [string]$versionInfo.FileDescription
      $identity.fileVersion = [string]$versionInfo.FileVersion
    } catch { $identity.versionInfoError = 'version_info_unavailable' }
    try {
      $signature = Get-AuthenticodeSignature -LiteralPath $exePath -ErrorAction Stop
      $identity.signatureStatus = [string]$signature.Status
      if ($signature.Status -eq 'Valid' -and $null -ne $signature.SignerCertificate) {
        $identity.publisherName = $signature.SignerCertificate.GetNameInfo([System.Security.Cryptography.X509Certificates.X509NameType]::SimpleName, $false)
        $identity.signerSubject = [string]$signature.SignerCertificate.Subject
        $identity.publisherVerified = $true
      }
    } catch { $identity.signatureStatus = 'unavailable' }
    try {
      $identity.aumid = [UiDriveInputWin32]::GetAumid([int]$process.Id)
      $identity.aumidStatus = $(if ($identity.aumid) { 'available' } else { 'none' })
    } catch { $identity.aumidStatus = 'unavailable' }
  } catch { $identity.identityError = 'process_identity_unavailable' }
  return $identity
}

$script:UiPhysicalPixels = [UiDriveInputWin32]::UsePhysicalPixels()
