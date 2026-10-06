# ============================================================
# 生成「抖音续火花助手」图标（纯 GDI+，零依赖）
# 设计：深色圆角底 + 火苗（红→橙→黄→白渐变）+ 火星
# 产物：
#   ui/icon.png  256x256 主图标（任务栏/窗口）
#   ui/tray.png  32x32   托盘图标（小尺寸更清晰）
# 用法：pwsh -File scripts/gen-icon.ps1
# ============================================================
Add-Type -AssemblyName System.Drawing
$ErrorActionPreference = 'Stop'

$root    = Split-Path -Parent $PSScriptRoot
$outBig  = Join-Path $root 'ui\icon.png'
$outTray = Join-Path $root 'ui\tray.png'

# ---------- 火焰轮廓（归一化 100x100，尖端朝上，y 向下） ----------
# AddCurve 样条平滑穿过这些点，得到带波动的经典火苗剪影
$flamePts = @(
  (50, 92), (35, 88), (25, 73), (30, 55), (37, 40), (41, 26), (53, 8),
  (65, 25), (71, 42), (75, 58), (70, 74), (61, 88), (50, 92)
)

function New-FlamePath($cx, $cy, $scale, $tension) {
  $pts = New-Object 'System.Drawing.PointF[]' $flamePts.Count
  for ($i = 0; $i -lt $flamePts.Count; $i++) {
    $px = [float](($flamePts[$i][0] - 50) * $scale + $cx)
    $py = [float](($flamePts[$i][1] - 55) * $scale + $cy)
    $pts[$i] = New-Object System.Drawing.PointF -ArgumentList $px, $py
  }
  $gp = New-Object System.Drawing.Drawing2D.GraphicsPath
  $gp.AddCurve($pts, $tension)
  $gp.CloseFigure()
  return $gp
}

function New-RoundedRectPath($x, $y, $w, $h, $radius) {
  $d = $radius * 2
  $gp = New-Object System.Drawing.Drawing2D.GraphicsPath
  $gp.AddArc([single]$x, [single]$y, [single]$d, [single]$d, [single]180, [single]90)
  $gp.AddArc([single]($x + $w - $d), [single]$y, [single]$d, [single]$d, [single]270, [single]90)
  $gp.AddArc([single]($x + $w - $d), [single]($y + $h - $d), [single]$d, [single]$d, [single]0, [single]90)
  $gp.AddArc([single]$x, [single]($y + $h - $d), [single]$d, [single]$d, [single]90, [single]90)
  $gp.CloseFigure()
  return $gp
}

function New-GradientBrush($x1, $y1, $x2, $y2, $c1, $c2) {
  $p1 = New-Object System.Drawing.PointF -ArgumentList ([single]$x1), ([single]$y1)
  $p2 = New-Object System.Drawing.PointF -ArgumentList ([single]$x2), ([single]$y2)
  $cc1 = [System.Drawing.ColorTranslator]::FromHtml($c1)
  $cc2 = [System.Drawing.ColorTranslator]::FromHtml($c2)
  $b = New-Object System.Drawing.Drawing2D.LinearGradientBrush -ArgumentList $p1, $p2, $cc1, $cc2
  return $b
}

function New-RadialGlow($g, $cx, $cy, $radius, $alpha, $centerHex) {
  $gp = New-Object System.Drawing.Drawing2D.GraphicsPath
  $gp.AddEllipse([single]($cx - $radius), [single]($cy - $radius), [single]($radius * 2), [single]($radius * 2))
  $pgb = New-Object System.Drawing.Drawing2D.PathGradientBrush -ArgumentList $gp
  $cc = [System.Drawing.ColorTranslator]::FromHtml($centerHex)
  $sur = New-Object 'System.Drawing.Color[]' $gp.PointCount
  for ($i = 0; $i -lt $gp.PointCount; $i++) {
    $sur[$i] = [System.Drawing.Color]::FromArgb(0, $cc.R, $cc.G, $cc.B)
  }
  $pgb.SurroundColors = $sur
  $pgb.CenterColor = [System.Drawing.Color]::FromArgb($alpha, $cc.R, $cc.G, $cc.B)
  $g.FillPath($pgb, $gp)
  $pgb.Dispose()
  $gp.Dispose()
}

function New-Icon($size) {
  $bmp = New-Object System.Drawing.Bitmap -ArgumentList $size, $size
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
  $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
  $g.Clear([System.Drawing.Color]::Transparent)

  $unit  = [double]($size / 100.0)
  $cx    = [double](50 * $unit)
  $cy    = [double](55 * $unit)
  $rad   = [double](21 * $unit)

  # 1) 深色圆角底（暖黑渐变）
  $bg = New-RoundedRectPath 1.5 1.5 ($size - 3) ($size - 3) $rad
  $bgBrush = New-GradientBrush 0 0 $size $size '#3A1D12' '#140A07'
  $g.FillPath($bgBrush, $bg)

  # 底光晕（火苗背后的暖光）
  New-RadialGlow $g $cx ($cy + 6 * $unit) (58 * $unit) 90 '#FF7A1A'
  New-RadialGlow $g $cx ($cy + 12 * $unit) (34 * $unit) 110 '#FF5E00'

  # 2) 火星（三颗，右上飘散）：扁平数组，每 4 个一组 [x, y, r, 颜色]
  $ember = @(
    76, 40, 5.2, '#FFC400',
    85, 62, 3.4, '#FF7043',
    69, 27, 3.0, '#FFD54F'
  )
  for ($k = 0; $k -lt $ember.Count; $k += 4) {
    $ex = $ember[$k] * $unit
    $ey = $ember[$k + 1] * $unit
    $er = $ember[$k + 2] * $unit
    $ec = $ember[$k + 3]
    $br = New-Object System.Drawing.SolidBrush -ArgumentList ([System.Drawing.ColorTranslator]::FromHtml($ec))
    $g.FillEllipse($br, [single]($ex - $er), [single]($ey - $er), [single]($er * 2), [single]($er * 2))
    $br.Dispose()
  }

  # 3) 火苗三层：投影 / 外焰 / 中焰 / 内芯
  $shadow = New-FlamePath ($cx + 1.4 * $unit) ($cy + 3 * $unit) (0.86 * $unit) 0.6
  $sb = New-Object System.Drawing.SolidBrush -ArgumentList ([System.Drawing.Color]::FromArgb(70, 0, 0, 0))
  $g.FillPath($sb, $shadow)
  $sb.Dispose()
  $shadow.Dispose()

  $outer = New-FlamePath $cx $cy (0.86 * $unit) 0.6
  $ob = New-GradientBrush 0 ($cy - 34 * $unit) 0 ($cy + 40 * $unit) '#FF3D00' '#FFA000'
  $g.FillPath($ob, $outer)
  $ob.Dispose()

  $mid = New-FlamePath $cx ($cy - 2 * $unit) (0.6 * $unit) 0.6
  $mb = New-GradientBrush 0 ($cy - 30 * $unit) 0 ($cy + 30 * $unit) '#FFA000' '#FFD54F'
  $g.FillPath($mb, $mid)
  $mb.Dispose()

  $core = New-FlamePath $cx ($cy - 3 * $unit) (0.31 * $unit) 0.5
  $cb = New-GradientBrush 0 ($cy - 20 * $unit) 0 ($cy + 18 * $unit) '#FFFFFF' '#FFECB3'
  $g.FillPath($cb, $core)
  $cb.Dispose()

  $outer.Dispose()
  $mid.Dispose()
  $core.Dispose()
  $bg.Dispose()
  $bgBrush.Dispose()
  $g.Dispose()
  return $bmp
}

# ---------- 输出 ----------
$icon = New-Icon 256
$icon.Save($outBig, [System.Drawing.Imaging.ImageFormat]::Png)
$tray = New-Icon 32
$tray.Save($outTray, [System.Drawing.Imaging.ImageFormat]::Png)
$icon.Dispose()
$tray.Dispose()

# ---------- 多尺寸 .ico（exe 内嵌图标：16/32/48/64/128/256） ----------
$ico = Join-Path $root 'ui\app.ico'
$sizes = @(16, 32, 48, 64, 128, 256)
$imgs = New-Object System.Collections.ArrayList
foreach ($s in $sizes) {
  $b = New-Icon $s
  $ms = New-Object System.IO.MemoryStream
  $b.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
  $null = $imgs.Add(@{ size = $s; blob = $ms.ToArray() })
  $b.Dispose()
  $ms.Dispose()
}
$fs = [System.IO.File]::Create($ico)
$bw = New-Object System.IO.BinaryWriter($fs)
$bw.Write([uint16]0); $bw.Write([uint16]1); $bw.Write([uint16]$sizes.Count)
$off = 6 + 16 * $sizes.Count
foreach ($im in $imgs) {
  $w = 0; if ($im.size -ne 256) { $w = $im.size }
  $bw.Write([byte]$w); $bw.Write([byte]$w); $bw.Write([byte]0); $bw.Write([byte]0)
  $bw.Write([uint16]1); $bw.Write([uint16]32)
  $bw.Write([uint32]$im.blob.Length); $bw.Write([uint32]$off)
  $off += $im.blob.Length
}
foreach ($im in $imgs) { $bw.Write($im.blob) }
$bw.Close(); $fs.Close()
Write-Host "已生成: $outBig (256x256) / $outTray (32x32) / $ico (多尺寸 $($sizes -join '/'))"
