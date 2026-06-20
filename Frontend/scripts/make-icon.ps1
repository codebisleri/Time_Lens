# Generates Frontend/build/icon.png — a 1024x1024 square app icon with the brand
# logomark centered on a transparent canvas. electron-builder converts this PNG
# to .ico (Windows) and .icns (macOS) at build time.
Add-Type -AssemblyName System.Drawing
$root = Split-Path -Parent $PSScriptRoot
$src = Join-Path $root "public\time-lens-logo.png"
$outDir = Join-Path $root "build"
$out = Join-Path $outDir "icon.png"
if (-not (Test-Path $src)) { Write-Error "source logo missing: $src"; exit 1 }
if (-not (Test-Path $outDir)) { New-Item -ItemType Directory -Path $outDir | Out-Null }

$logo = [System.Drawing.Image]::FromFile($src)
$size = 1024
$bmp = New-Object System.Drawing.Bitmap($size, $size)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
$g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
$g.Clear([System.Drawing.Color]::Transparent)

# Fit logo into ~80% of the canvas, preserving aspect ratio, centered.
$target = [int]($size * 0.80)
$scale = [Math]::Min($target / $logo.Width, $target / $logo.Height)
$w = [int]($logo.Width * $scale)
$h = [int]($logo.Height * $scale)
$x = [int](($size - $w) / 2)
$y = [int](($size - $h) / 2)
$g.DrawImage($logo, $x, $y, $w, $h)

$g.Dispose()
$bmp.Save($out, [System.Drawing.Imaging.ImageFormat]::Png)
$bmp.Dispose()
$logo.Dispose()
Write-Output ("icon.png written: {0}  ({1}x{1})" -f $out, $size)
