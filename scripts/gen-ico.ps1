<#
  gen-ico.ps1  --  Convert build\icon.png into build\icon.ico
  Embeds sizes: 256, 128, 64, 48, 32, 16  (PNG-compressed frames inside ICO container).
  Compatible with Windows PowerShell 5.1 and PowerShell 7+.
  Run from the Porkfolio project root:
      powershell -ExecutionPolicy Bypass -File scripts\gen-ico.ps1
#>
param(
  [string]$PngPath = (Join-Path $PSScriptRoot "..\build\icon.png"),
  [string]$IcoPath = (Join-Path $PSScriptRoot "..\build\icon.ico")
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$PngPath = (Resolve-Path $PngPath).Path
$IcoPath = [System.IO.Path]::GetFullPath($IcoPath)

Add-Type -AssemblyName System.Drawing

Write-Host "[ICO] Source : $PngPath"
Write-Host "[ICO] Output : $IcoPath"

$sizes = @(256, 128, 64, 48, 32, 16)
$srcImg = [System.Drawing.Image]::FromFile($PngPath)

try {
  $ms = New-Object System.IO.MemoryStream
  $bw = New-Object System.IO.BinaryWriter($ms)

  # ICO header: reserved(2) + type(2) + count(2)
  $bw.Write([uint16]0)               # reserved
  $bw.Write([uint16]1)               # type 1 = icon
  $bw.Write([uint16]$sizes.Count)    # number of images

  # Pre-render each frame into a PNG byte array so we know byte lengths for the directory.
  $frames = @()
  foreach ($sz in $sizes) {
    $bmp = New-Object System.Drawing.Bitmap($sz, $sz, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
    $g   = [System.Drawing.Graphics]::FromImage($bmp)
    $g.InterpolationMode  = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $g.SmoothingMode      = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
    $g.PixelOffsetMode    = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
    $g.CompositingQuality = [System.Drawing.Drawing2D.CompositingQuality]::HighQuality
    $g.DrawImage($srcImg, 0, 0, $sz, $sz)
    $g.Dispose()

    $fms = New-Object System.IO.MemoryStream
    $bmp.Save($fms, [System.Drawing.Imaging.ImageFormat]::Png)
    $bmp.Dispose()
    $frames += , $fms.ToArray()    # `, @(...)` preserves array-in-array
    $fms.Dispose()
  }

  # ICONDIRENTRY directory (16 bytes each)
  # Width/height 256 is stored as 0 per ICO spec.
  $headerBytes = 6 + 16 * $sizes.Count
  $offset = $headerBytes
  for ($i = 0; $i -lt $sizes.Count; $i++) {
    $sz  = $sizes[$i]
    $len = $frames[$i].Length

    # Width byte: 0 means 256
    if ($sz -eq 256) { $bw.Write([byte]0) } else { $bw.Write([byte]$sz) }
    # Height byte: 0 means 256
    if ($sz -eq 256) { $bw.Write([byte]0) } else { $bw.Write([byte]$sz) }
    $bw.Write([byte]0)              # color count  (0 = no palette)
    $bw.Write([byte]0)              # reserved
    $bw.Write([uint16]1)            # planes
    $bw.Write([uint16]32)           # bits per pixel
    $bw.Write([uint32]$len)         # data size in bytes
    $bw.Write([uint32]$offset)      # offset to image data from start of file
    $offset += $len
  }

  # Image data (PNG-compressed frames, stored in the same order as the directory)
  foreach ($f in $frames) {
    $bw.Write($f)
  }

  $bw.Flush()
  $srcImg.Dispose()

  $icoBytes = $ms.ToArray()
  [System.IO.File]::WriteAllBytes($IcoPath, $icoBytes)
  Write-Host ("[OK] icon.ico written - {0} KB, {1} sizes" -f [math]::Round($icoBytes.Length / 1024, 1), $sizes.Count)
}
catch {
  $srcImg.Dispose()
  throw
}
