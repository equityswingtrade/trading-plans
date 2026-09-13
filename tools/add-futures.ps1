<#
.SYNOPSIS
  Publish one day's futures price maps (ES, NQ, GC) to the site.

.DESCRIPTION
  Converts <SYM>-structured-<date>.md from the TradingView reports folder into
  futures\<date>\<KEY>.html and rewrites futures\manifest.js.

  Chart pictures are optional. Save them in reports\img named with the symbol
  and the date, then anything you like:
      ES1-2026-09-14-30m.png     ES-2026-09-14-daily.jpg     GC1-2026-09-14.png
  Each is resized, saved as JPEG next to the pages, and shown in that product's
  Charts section. 30m / 5m / D / daily / W / 4h ... become the caption; other
  tags are shown as written.

  Re-running for the same date rebuilds what it finds and keeps any product it
  didn't find, so a late GC report can be added on its own.

.EXAMPLE
  .\tools\add-futures.ps1                       # today's reports

.EXAMPLE
  .\tools\add-futures.ps1 -Date 2026-09-13

.EXAMPLE
  .\tools\add-futures.ps1 -Date 2026-09-13 -Symbols GC1
#>
[CmdletBinding()]
param(
  # Report date, yyyy-MM-dd - the date in the .md filenames.
  [string]$Date = (Get-Date -Format 'yyyy-MM-dd'),

  # Folder holding the <SYM>-structured-<date>.md reports.
  [string]$Reports = 'C:\Users\VINHSANH\.claude\tradingview\reports',

  # Folder holding chart pictures. Defaults to <Reports>\img.
  [string]$Images,

  [string[]]$Symbols = @('ES1', 'NQ1', 'GC1'),

  # Pictures wider than this are scaled down; JPEG quality 1-100.
  [int]$MaxWidth = 1800,
  [int]$Quality = 82
)

$ErrorActionPreference = 'Stop'

if ($Date -notmatch '^\d{4}-\d{2}-\d{2}$') { throw "-Date must be yyyy-MM-dd (got '$Date')." }
if (-not $Images) { $Images = Join-Path $Reports 'img' }
if (-not (Get-Command node -ErrorAction SilentlyContinue)) { throw "Node.js is required - 'node' was not found on PATH." }

$root   = Split-Path -Parent $PSScriptRoot
$outImg = Join-Path $root "futures\$Date\img"

Add-Type -AssemblyName System.Drawing
$jpeg = [System.Drawing.Imaging.ImageCodecInfo]::GetImageEncoders() | Where-Object { $_.MimeType -eq 'image/jpeg' }
$encParams = New-Object System.Drawing.Imaging.EncoderParameters 1
$encParams.Param[0] = New-Object System.Drawing.Imaging.EncoderParameter ([System.Drawing.Imaging.Encoder]::Quality, [long]$Quality)

function Save-Chart {
  param([string]$Source, [string]$Dest)
  $img = [System.Drawing.Image]::FromFile($Source)
  try {
    $w = $img.Width; $h = $img.Height
    if ($w -gt $MaxWidth) { $h = [int]($h * $MaxWidth / $w); $w = $MaxWidth }
    $bmp = New-Object System.Drawing.Bitmap $w, $h
    try {
      $g = [System.Drawing.Graphics]::FromImage($bmp)
      try {
        $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
        $g.DrawImage($img, 0, 0, $w, $h)
      } finally { $g.Dispose() }
      $bmp.Save($Dest, $jpeg, $encParams)
    } finally { $bmp.Dispose() }
  } finally { $img.Dispose() }
}

if (Test-Path -LiteralPath $Images) {
  Write-Host "Pictures from $Images" -ForegroundColor DarkGray
  $all = @(Get-ChildItem -LiteralPath $Images -File | Where-Object { $_.Extension -match '^\.(png|jpe?g)$' } | Sort-Object Name)
  foreach ($sym in $Symbols) {
    $key = $sym -replace '1$', ''
    # ES1-2026-09-14-30m.png, ES_2026-09-14 daily.jpg, ES-2026-09-14.png ...
    $pattern = '^(' + [regex]::Escape($sym) + '|' + [regex]::Escape($key) + ')[-_ ]+' + [regex]::Escape($Date) + '(.*)$'
    $n = 0
    foreach ($f in $all) {
      if ($f.BaseName -notmatch $pattern) { continue }
      $tag = (($Matches[2] -replace '[^A-Za-z0-9]+', '-').Trim('-')).ToLower()
      if (-not $tag) { $n++; $tag = "$n" }
      if (-not (Test-Path $outImg)) { New-Item -ItemType Directory -Path $outImg | Out-Null }
      $dest = Join-Path $outImg "$key-$tag.jpg"
      Save-Chart -Source $f.FullName -Dest $dest
      $kb = [math]::Round((Get-Item -LiteralPath $dest).Length / 1KB)
      Write-Host ("  {0}  ->  img\{1}-{2}.jpg  ({3} KB)" -f $f.Name, $key, $tag, $kb) -ForegroundColor DarkGray
    }
  }
}

& node (Join-Path $PSScriptRoot 'build-futures.mjs') --date $Date --src $Reports --symbols ($Symbols -join ',')
if ($LASTEXITCODE -ne 0) { throw "build-futures.mjs failed (exit $LASTEXITCODE)." }

Write-Host ""
Write-Host "Next: git add -A; git commit -m ""Futures $Date""; git push" -ForegroundColor DarkGray
