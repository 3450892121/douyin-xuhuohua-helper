# ============================================================
# set-exe-icon.ps1 —— 把 .ico 内嵌进 EXE 图标资源（零第三方依赖）
# 用法：pwsh -File scripts/set-exe-icon.ps1 <exe路径> <ico路径>
# 原理：BeginUpdateResource / UpdateResource / EndUpdateResource
#       先枚举并删除旧的 RT_GROUP_ICON + RT_ICON（含多语言），
#       再写入新图标帧与新的 GROUP_ICON 目录。
# ============================================================
param(
  [Parameter(Mandatory = $true)][string]$ExePath,
  [Parameter(Mandatory = $true)][string]$IcoPath
)

Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class WinRes {
  public delegate bool EnumResNameProc(IntPtr hModule, IntPtr lpszType, IntPtr lpszName, IntPtr lParam);
  public delegate bool EnumResLangProc(IntPtr hModule, IntPtr lpszType, IntPtr lpszName, ushort wIDLanguage, IntPtr lParam);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  public static extern IntPtr LoadLibraryEx(string lpFileName, IntPtr hFile, uint dwFlags);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  public static extern bool EnumResourceNames(IntPtr hModule, IntPtr lpszType, EnumResNameProc lpEnumFunc, IntPtr lParam);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  public static extern bool EnumResourceLanguages(IntPtr hModule, IntPtr lpszType, IntPtr lpszName, EnumResLangProc lpEnumFunc, IntPtr lParam);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  public static extern bool FreeLibrary(IntPtr hModule);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  public static extern IntPtr BeginUpdateResource(string pFileName, bool bDeleteExistingResources);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  public static extern bool UpdateResource(IntPtr hUpdate, IntPtr lpType, IntPtr lpName, ushort wLanguage, byte[] lpData, uint cbData);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  public static extern bool EndUpdateResource(IntPtr hUpdate, bool fDiscard);
  public static readonly IntPtr RT_ICON = new IntPtr(3);
  public static readonly IntPtr RT_GROUP_ICON = new IntPtr(14);
}
'@

$ExePath = [System.IO.Path]::GetFullPath($ExePath)
$IcoPath = [System.IO.Path]::GetFullPath($IcoPath)
if (-not (Test-Path $ExePath)) { throw "exe 不存在: $ExePath" }
if (-not (Test-Path $IcoPath)) { throw "ico 不存在: $IcoPath" }

# ---------------- 解析 .ico ----------------
$icoBytes = [System.IO.File]::ReadAllBytes($IcoPath)
$ms = New-Object System.IO.MemoryStream -ArgumentList (,$icoBytes)
$br = New-Object System.IO.BinaryReader -ArgumentList $ms
$null = $br.ReadUInt16()   # reserved
$type = $br.ReadUInt16()   # 1 = icon
$count = $br.ReadUInt16()
if ($type -ne 1) { throw "不是有效的 .ico（type=$type）" }
$frames = New-Object System.Collections.ArrayList
for ($i = 0; $i -lt $count; $i++) {
  $bw = $br.ReadByte(); $bh = $br.ReadByte()
  $null = $br.ReadByte(); $null = $br.ReadByte()
  $planes = $br.ReadUInt16(); $bitCount = $br.ReadUInt16()
  $len = $br.ReadUInt32(); $off = $br.ReadUInt32()
  $w = 256; if ($bw -ne 0) { $w = $bw }
  $h = 256; if ($bh -ne 0) { $h = $bh }
  $data = New-Object byte[] $len
  [Array]::Copy($icoBytes, $off, $data, 0, $len)
  $null = $frames.Add(@{ w = $w; h = $h; planes = $planes; bits = $bitCount; data = $data })
}
$br.Dispose(); $ms.Dispose()
Write-Host ("解析 .ico：{0} 帧（{1}）" -f $frames.Count, (($frames | ForEach-Object { "$($_.w)x$($_.h)" }) -join ', '))

# ---------------- 枚举现有图标资源（名称+语言） ----------------
$hMod = [WinRes]::LoadLibraryEx($ExePath, [IntPtr]::Zero, 0x2)   # LOAD_LIBRARY_AS_DATAFILE
if ($hMod -eq [IntPtr]::Zero) { throw "无法打开 exe（LoadLibraryEx 失败）: $ExePath" }
$toDelete = New-Object System.Collections.ArrayList
$langCb = [WinRes+EnumResLangProc]{
  param($hm, $t, $n, $lang, $lp)
  $id = -1
  if ([int64]$n -le 0xFFFF) { $id = [int]([int64]$n -band 0xFFFF) }
  $null = $toDelete.Add(@{ type = $t; id = $id; lang = $lang })
  return $true
}
$nameCb = [WinRes+EnumResNameProc]{
  param($hm, $t, $n, $lp)
  if ([int64]$n -le 0xFFFF) {
    $id = [int]([int64]$n -band 0xFFFF)
    [WinRes]::EnumResourceLanguages($hm, $t, $n, $langCb, [IntPtr]::Zero) | Out-Null
  }
  return $true
}
foreach ($t in @([WinRes]::RT_ICON, [WinRes]::RT_GROUP_ICON)) {
  [WinRes]::EnumResourceNames($hMod, $t, $nameCb, [IntPtr]::Zero) | Out-Null
}
[WinRes]::FreeLibrary($hMod) | Out-Null
Write-Host "待删除的旧图标资源: $($toDelete.Count) 项"

# ---------------- 写入新图标 ----------------
$hUpd = [WinRes]::BeginUpdateResource($ExePath, $false)
if ($hUpd -eq [IntPtr]::Zero) { throw "BeginUpdateResource 失败（文件可能被占用）" }
$okEnd = $false
try {
  foreach ($r in $toDelete) {
    if ($r.id -ge 0) {
      [WinRes]::UpdateResource($hUpd, $r.type, [IntPtr]$r.id, $r.lang, $null, 0) | Out-Null
    }
  }
  # RT_ICON：每帧一个资源，ID 从 1 递增
  $gid = 1
  foreach ($f in $frames) {
    $ok = [WinRes]::UpdateResource($hUpd, [WinRes]::RT_ICON, [IntPtr]$gid, 0, $f.data, [uint32]$f.data.Length)
    if (-not $ok) { throw "写入 RT_ICON($gid) 失败: $([System.Runtime.InteropServices.Marshal]::GetLastWin32Error())" }
    $gid++
  }
  # RT_GROUP_ICON：目录结构，ID 用 1
  $gms = New-Object System.IO.MemoryStream
  $gbw = New-Object System.IO.BinaryWriter -ArgumentList $gms
  $gbw.Write([uint16]0); $gbw.Write([uint16]1); $gbw.Write([uint16]$frames.Count)
  $gi = 1
  foreach ($f in $frames) {
    $wB = 0; if ($f.w -ne 256) { $wB = $f.w }
    $hB = 0; if ($f.h -ne 256) { $hB = $f.h }
    $gbw.Write([byte]$wB); $gbw.Write([byte]$hB); $gbw.Write([byte]0); $gbw.Write([byte]0)
    $gbw.Write([uint16]1); $gbw.Write([uint16]$f.bits)
    $gbw.Write([uint32]$f.data.Length); $gbw.Write([uint16]$gi)
    $gi++
  }
  $grp = $gms.ToArray()
  $gbw.Dispose(); $gms.Dispose()
  $ok = [WinRes]::UpdateResource($hUpd, [WinRes]::RT_GROUP_ICON, [IntPtr]1, 0, $grp, [uint32]$grp.Length)
  if (-not $ok) { throw "写入 RT_GROUP_ICON 失败: $([System.Runtime.InteropServices.Marshal]::GetLastWin32Error())" }
}
finally {
  $okEnd = [WinRes]::EndUpdateResource($hUpd, $false)
}
if (-not $okEnd) { throw "EndUpdateResource 失败: $([System.Runtime.InteropServices.Marshal]::GetLastWin32Error())" }
Write-Host "图标已写入: $ExePath"
