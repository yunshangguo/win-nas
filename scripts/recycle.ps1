# NasManager 回收站集成脚本
# 用法: powershell -File recycle.ps1 <delete|list|restore|purge> [extra]
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$ErrorActionPreference = 'Stop'
$action = $args[0]

function Get-Bin {
  $shell = New-Object -ComObject Shell.Application
  return $shell.NameSpace(10)   # ssfBITBUCKET = 回收站
}

switch ($action) {
  'delete' {
    $filePath = $args[1]
    Add-Type @"
using System;
using System.Runtime.InteropServices;
public class RecycleOp {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Auto)]
  public struct SHFILEOPSTRUCT {
    public IntPtr hwnd; public uint wFunc; public string pFrom; public string pTo;
    public ushort fFlags; public bool fAnyOperationsAborted; public IntPtr hNameMappings; public string lpszProgressTitle;
  }
  [DllImport("shell32.dll", CharSet = CharSet.Auto)]
  public static extern int SHFileOperation(ref SHFILEOPSTRUCT FileOp);
}
"@
    $op = New-Object RecycleOp+SHFILEOPSTRUCT
    $op.wFunc = 3                              # FO_DELETE
    $op.pFrom = $filePath + [char]0 + [char]0  # 双 null 结尾
    $op.fFlags = 0x40 -bor 0x10                # FOF_ALLOWUNDO | FOF_NOCONFIRMATION
    $r = [RecycleOp]::SHFileOperation([ref]$op)
    if ($r -eq 0) { @{ ok = $true } | ConvertTo-Json -Compress }
    else { @{ ok = $false; code = $r } | ConvertTo-Json -Compress }
  }
  'list' {
    $bin = Get-Bin
    $out = @()
    foreach ($item in $bin.Items()) {
      $out += @{
        name             = $item.Name
        originalLocation = $bin.GetDetailsOf($item, 1)
        size             = $bin.GetDetailsOf($item, 2)
        modified         = $bin.GetDetailsOf($item, 3)
      }
    }
    $out | ConvertTo-Json -Compress
  }
  'restore' {
    $name = $args[1]
    $bin = Get-Bin
    $found = $false
    foreach ($item in $bin.Items()) {
      if ($item.Name -eq $name) {
        $verb = $item.Verbs() | Where-Object { $_.Name -match '还原|Restore' }
        if ($verb) { $verb.DoIt(); $found = $true; break }
      }
    }
    @{ ok = $found; name = $name } | ConvertTo-Json -Compress
  }
  'purge' {
    Add-Type @"
using System;
using System.Runtime.InteropServices;
public class EmptyBin {
  [DllImport("shell32.dll")]
  public static extern int SHEmptyRecycleBin(IntPtr hwnd, string pszRootPath, uint dwFlags);
}
"@
    $r = [EmptyBin]::SHEmptyRecycleBin([IntPtr]::Zero, $null, 0)
    @{ ok = ($r -eq 0); code = $r } | ConvertTo-Json -Compress
  }
  default {
    @{ ok = $false; error = 'unknown action' } | ConvertTo-Json -Compress
  }
}
