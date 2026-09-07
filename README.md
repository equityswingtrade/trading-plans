# Weekend Trading Plans

A small static site that publishes the weekly plans. `index.html` is a shell with
two tabs — **Equities Breakout** and **Wheel Strategy** — plus a date dropdown for
picking which weekend's plan to read. Each report is served untouched inside an
iframe, so the reports keep their own styling and behaviour.

## Layout

```
index.html               the shell: date dropdown + two tabs
plans/manifest.js        the list of plans (what the dropdown reads)
plans/<date>/equities.html
plans/<date>/wheel.html
tools/add-plan.ps1       adds a week and rewrites the manifest
.nojekyll                stops GitHub Pages running the files through Jekyll
```

## Adding a plan each weekend

From the repo root, in PowerShell:

```powershell
.\tools\add-plan.ps1 -Date 2026-09-13 `
    -Equities "C:\Users\VINHSANH\Documents\swing trade research\swing_breakout_report_2026-09-13.html" `
    -Wheel    "C:\Users\VINHSANH\Documents\swing trade research\Claude outputs\wheel-desk-2026-09-13.html"

git add -A
git commit -m "Plan 2026-09-13"
git push
```

`-Date` is the plan's id and the dropdown's sort key — use the weekend date the
plan belongs to, `yyyy-MM-dd`.

The script:

- copies each report to `plans/<date>/`, wrapping bare artifact fragments (no
  `<html>` tag) in a full HTML document so they stand alone;
- reads the report's own generation date out of the source filename, so a wheel
  report produced a day after the equities one is labelled honestly;
- rewrites `plans/manifest.js`, newest plan first.

Useful variations:

```powershell
# Only one of the two reports is ready - add the other later, same -Date.
.\tools\add-plan.ps1 -Date 2026-09-13 -Wheel "...\wheel-desk-2026-09-14.html"

# Custom dropdown text.
.\tools\add-plan.ps1 -Date 2026-09-13 -Label "Sep 13 - CPI week" -Equities "..."

# Override the generated date if it isn't in the filename.
.\tools\add-plan.ps1 -Date 2026-09-13 -Equities "..." -EquitiesDate 2026-09-12
```

Re-running for a date that already exists only updates the tabs you pass, so
adding the wheel report later leaves the equities one alone.

To drop a plan: delete `plans/<date>/` and remove its line from
`plans/manifest.js`.

## Deep links

The URL carries the selection, so a single tab is linkable:

```
https://<user>.github.io/trading-plans/#2026-09-06/equities
https://<user>.github.io/trading-plans/#2026-09-06/wheel
```

## Notes

- The wheel report calls `window.claude.use('db')` for its live run-history
  table. That API only exists inside Claude Artifacts, so on GitHub Pages the
  report falls back to its own offline state for that one panel. Everything
  else renders normally.
- The equities report ships a light-only palette; the wheel report and the shell
  follow the reader's light/dark setting.
- Reports run large (the equities one is ~2.8 MB). At roughly 3.5 MB a week the
  repo grows about 180 MB a year — fine for GitHub, but worth pruning old plans
  eventually.

## Local preview

`fetch` isn't involved — the manifest is a plain script — but iframes still
behave best over HTTP:

```bash
npx --yes http-server . -p 4173 -c-1
```
