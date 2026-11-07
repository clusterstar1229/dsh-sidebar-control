param(
  [int]$Seconds = 14,
  [int]$IntervalMs = 120,
  [string]$Out = "$env:TEMP\dsh-demo-frames",
  [int]$ScaledWidth = 960
)

Add-Type -AssemblyName System.Drawing
Add-Type @'
using System;
using System.Runtime.InteropServices;
public class DemoWin {
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  public struct RECT { public int Left, Top, Right, Bottom; }
}
'@

$proc = Get-Process | Where-Object { $_.MainWindowTitle -like '*DeepSeek Harness*' } | Select-Object -First 1
if ($null -eq $proc) { throw 'DeepSeek Harness window not found' }
[void][DemoWin]::ShowWindow($proc.MainWindowHandle, 3)   # SW_MAXIMIZE
[void][DemoWin]::SetForegroundWindow($proc.MainWindowHandle)
Start-Sleep -Milliseconds 400

$rect = New-Object DemoWin+RECT
[void][DemoWin]::GetWindowRect($proc.MainWindowHandle, [ref]$rect)
$width = $rect.Right - $rect.Left
$height = $rect.Bottom - $rect.Top
if ($width -lt 400 -or $height -lt 300) { throw "unexpected window rect ${width}x${height}" }
$scaledHeight = [int][Math]::Round($height * $ScaledWidth / $width)

if (Test-Path $Out) { Remove-Item $Out -Recurse -Force }
New-Item -ItemType Directory -Path $Out | Out-Null

$deadline = (Get-Date).AddSeconds($Seconds)
$index = 0
while ((Get-Date) -lt $deadline) {
  $source = New-Object System.Drawing.Bitmap $width, $height
  $sourceGraphics = [System.Drawing.Graphics]::FromImage($source)
  $sourceGraphics.CopyFromScreen($rect.Left, $rect.Top, 0, 0, (New-Object System.Drawing.Size $width, $height))
  $bitmap = New-Object System.Drawing.Bitmap $ScaledWidth, $scaledHeight
  $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
  $graphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $graphics.DrawImage($source, 0, 0, $ScaledWidth, $scaledHeight)
  $path = Join-Path $Out ('f{0:d4}.png' -f $index)
  $bitmap.Save($path, [System.Drawing.Imaging.ImageFormat]::Png)
  $graphics.Dispose()
  $bitmap.Dispose()
  $sourceGraphics.Dispose()
  $source.Dispose()
  $index++
  Start-Sleep -Milliseconds $IntervalMs
}
"frames=$index width=$ScaledWidth height=$scaledHeight"
