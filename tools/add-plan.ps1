<#
.SYNOPSIS
  Add (or update) one weekend's plan in the site.

.DESCRIPTION
  Copies the report HTML into plans\<date>\, wrapping bare fragments in a full
  HTML document, then rewrites plans\manifest.js. Re-running for a date that
  already exists updates only the tabs you pass; the other tab is left alone.

.EXAMPLE
  .\tools\add-plan.ps1 -Date 2026-09-13 `
      -Equities "C:\...\swing_breakout_report_2026-09-13.html" `
      -Wheel    "C:\...\wheel-desk-2026-09-13.html"

.EXAMPLE
  # Wheel report landed a day later - add it on its own.
  .\tools\add-plan.ps1 -Date 2026-09-13 -Wheel "C:\...\wheel-desk-2026-09-14.html"
#>
[CmdletBinding()]
param(
  # Plan id, yyyy-MM-dd. Use the weekend date the plan belongs to.
  [Parameter(Mandatory = $true)][string]$Date,

  # Source HTML for the equities breakout tab.
  [string]$Equities,

  # Source HTML for the wheel strategy tab.
  [string]$Wheel,

  # Dropdown text. Defaults to a friendly form of -Date.
  [string]$Label,

  # Override the "generated" date shown under each tab. Defaults to the date
  # found in the source filename, else -Date.
  [string]$EquitiesDate,
  [string]$WheelDate
)

$ErrorActionPreference = 'Stop'

if ($Date -notmatch '^\d{4}-\d{2}-\d{2}$') {
  throw "-Date must be yyyy-MM-dd (got '$Date')."
}
if (-not $Equities -and -not $Wheel) {
  throw "Pass at least one of -Equities or -Wheel."
}

$root     = Split-Path -Parent $PSScriptRoot
$plansDir = Join-Path $root 'plans'
$destDir  = Join-Path $plansDir $Date
$manifest = Join-Path $plansDir 'manifest.js'
$utf8     = New-Object System.Text.UTF8Encoding($false)

if (-not (Test-Path $destDir)) { New-Item -ItemType Directory -Path $destDir | Out-Null }

function Get-DateFromName {
  param([string]$Path, [string]$Fallback)
  $name = Split-Path -Leaf $Path
  if ($name -match '(\d{4}-\d{2}-\d{2})') { return $Matches[1] }
  return $Fallback
}

function Install-Report {
  param([string]$Source, [string]$Name)

  if (-not (Test-Path -LiteralPath $Source)) { throw "Not found: $Source" }
  $html = [IO.File]::ReadAllText((Resolve-Path -LiteralPath $Source))

  # Artifact exports often arrive as bare fragments - give them a real document
  # so they stand alone inside the iframe.
  $head = $html.Substring(0, [Math]::Min(2000, $html.Length))
  if ($head -notmatch '(?i)<html[\s>]') {
    $html = @"
<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
</head>
<body>
$html
</body>
</html>
"@
    Write-Host "  wrapped fragment -> full document" -ForegroundColor DarkGray
  }

  $out = Join-Path $destDir $Name
  [IO.File]::WriteAllText($out, $html, $utf8)
  $kb = [math]::Round((Get-Item -LiteralPath $out).Length / 1KB)
  Write-Host ("  {0}  ({1} KB)" -f $Name, $kb) -ForegroundColor Green
}

function ConvertTo-Ordered {
  param($Obj)
  $h = [ordered]@{}
  foreach ($p in $Obj.PSObject.Properties) {
    if ($p.Value -is [psobject] -and $p.Value.PSObject.Properties.Count -gt 0 -and
        $p.Value -isnot [string] -and $p.Value -isnot [ValueType]) {
      $h[$p.Name] = ConvertTo-Ordered $p.Value
    } else {
      $h[$p.Name] = $p.Value
    }
  }
  return $h
}

# ---------- read existing manifest ----------
$plans = @()
if (Test-Path $manifest) {
  $raw = [IO.File]::ReadAllText($manifest)
  $raw = $raw -replace '^\s*window\.PLAN_MANIFEST\s*=\s*', ''
  $raw = $raw -replace ';\s*$', ''
  $parsed = $raw | ConvertFrom-Json
  if ($parsed.plans) { $plans = @($parsed.plans | ForEach-Object { ConvertTo-Ordered $_ }) }
}

$entry = $plans | Where-Object { $_.id -eq $Date } | Select-Object -First 1
if (-not $entry) {
  $entry = [ordered]@{ id = $Date }
  $plans = @($plans) + @($entry)
}

if ($Label) {
  $entry['label'] = $Label
} elseif (-not $entry.Contains('label')) {
  $entry['label'] = ([datetime]::ParseExact($Date, 'yyyy-MM-dd', $null)).ToString('MMM d, yyyy')
}

Write-Host "Plan $Date - $($entry['label'])" -ForegroundColor Cyan

if ($Equities) {
  Install-Report -Source $Equities -Name 'equities.html'
  $g = $EquitiesDate
  if (-not $g) { $g = Get-DateFromName -Path $Equities -Fallback $Date }
  $entry['equities'] = [ordered]@{ file = 'equities.html'; generated = $g }
}
if ($Wheel) {
  Install-Report -Source $Wheel -Name 'wheel.html'
  $g = $WheelDate
  if (-not $g) { $g = Get-DateFromName -Path $Wheel -Fallback $Date }
  $entry['wheel'] = [ordered]@{ file = 'wheel.html'; generated = $g }
}

# Reorder keys so the file reads id, label, equities, wheel.
$ordered = @(foreach ($p in ($plans | Sort-Object { $_.id } -Descending)) {
  $o = [ordered]@{ id = $p.id; label = $p.label }
  foreach ($k in 'equities', 'wheel') { if ($p.Contains($k)) { $o[$k] = $p[$k] } }
  $o
})

$lines = @()
foreach ($p in $ordered) { $lines += '    ' + (ConvertTo-Json $p -Depth 6 -Compress) }

$body = @"
window.PLAN_MANIFEST = {
  "plans": [
$($lines -join ",`r`n")
  ]
};
"@
[IO.File]::WriteAllText($manifest, $body + "`r`n", $utf8)

Write-Host "  manifest.js updated - $($ordered.Count) plan(s) listed" -ForegroundColor Green
Write-Host ""
Write-Host "Next: git add -A; git commit -m ""Plan $Date""; git push" -ForegroundColor DarkGray
