# assets/icons/teachericon.svg, studenticon.svg (720px PNG가 내장된 SVG) → teacher.ico / student.ico, *-256.png
#   powershell -ExecutionPolicy Bypass -File tools\make-icons.ps1
# 1) node로 SVG 안의 PNG를 꺼내고 2) System.Drawing으로 16~256 크기로 줄인 뒤 3) tools/make-ico.js 로 ICO를 조립합니다.
$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Drawing
$root = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$dir = Join-Path $root "assets\icons"
Set-Location $root
node -e "const fs=require('fs');for(const n of ['teacher','student']){const s=fs.readFileSync('assets/icons/'+n+'icon.svg','utf8');const m=/data:image\/png;base64,([A-Za-z0-9+\/=]+)/.exec(s);if(!m)throw new Error(n+'icon.svg: 내장 PNG 없음');fs.writeFileSync('assets/icons/'+n+'-720.png',Buffer.from(m[1],'base64'));}"
foreach ($n in @("teacher", "student")) {
  $src = [System.Drawing.Image]::FromFile("$dir\$n-720.png")
  foreach ($s in @(16, 24, 32, 48, 64, 128, 256)) {
    $bmp = New-Object System.Drawing.Bitmap $s, $s, ([System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
    $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
    $g.Clear([System.Drawing.Color]::Transparent)
    $g.DrawImage($src, 0, 0, $s, $s)
    $g.Dispose()
    if ($s -eq 256) { $bmp.Save("$dir\$n-256.png", [System.Drawing.Imaging.ImageFormat]::Png) }
    $rect = New-Object System.Drawing.Rectangle 0, 0, $s, $s
    $data = $bmp.LockBits($rect, [System.Drawing.Imaging.ImageLockMode]::ReadOnly, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
    $bytes = New-Object byte[] ($s * $s * 4)
    [System.Runtime.InteropServices.Marshal]::Copy($data.Scan0, $bytes, 0, $bytes.Length)
    $bmp.UnlockBits($data)
    [System.IO.File]::WriteAllBytes("$dir\$n-$s.raw", $bytes)
    $bmp.Dispose()
  }
  $src.Dispose()
  Remove-Item "$dir\$n-720.png" -Force
}
node tools/make-ico.js
Remove-Item "$dir\*.raw" -Force
Get-ChildItem "$dir\*.ico" | ForEach-Object { "{0,-14} {1,8} bytes" -f $_.Name, $_.Length }
