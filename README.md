# Trading Plans

A small static site for publishing the plans. `index.html` is a shell with three
tabs:

- **Equities Breakout** and **Wheel Strategy** — weekly, picked by plan date.
- **Futures** — daily price maps, picked by report date, with a sub-tab per
  product: **ES**, **NQ**, **GC**, plus **Summary** on the days that have a
  watchlist summary. Each product sub-tab shows ▲/▼ for that day's favoured
  branch; Summary is greyed out on days without one.

The two halves link to each other. A futures day links to that week's
equities and wheel plans (the newest plan dated on or before it). A weekly
plan links to the newest futures day inside its week.

Weekly reports are served untouched inside an iframe. Futures reports are
converted from the TradingView markdown into standalone HTML pages.

## Layout

```
index.html                      the shell: date dropdown, tabs, cross-links
plans/manifest.js               weekly plans list
plans/<date>/equities.html
plans/<date>/wheel.html
futures/manifest.js             futures days list
futures/<date>/ES.html          one page per product
futures/<date>/img/ES-30m.jpg   chart pictures, when supplied
futures/assets/report.css|js    page styles + price map / planner / scenarios (copied by the build)
tools/add-plan.ps1              adds a weekly plan
tools/add-futures.ps1           adds a futures day (pictures + build)
tools/build-futures.mjs         markdown -> HTML converter (needs Node.js)
tools/report/                   source of futures/assets - edit here, not in futures/assets
tools/vendor/marked.mjs         markdown parser, vendored (MIT) - no npm install
.nojekyll                       stops GitHub Pages running the files through Jekyll
```

## Futures — every day

The reports come from `C:\Users\VINHSANH\.claude\tradingview\reports`, named
`ES1-structured-<date>.md`, `NQ1-structured-<date>.md`,
`GC1-structured-<date>.md`.

**Watchlist summary (optional, weekend runs).** If
`watchlist-summary-<date>.md` sits beside them, it is built as
`futures/<date>/SUM.html` and appears as the **Summary** sub-tab, after the
three products. It is one page of text — the cross-symbol scorecard, the
comparison table, the ranked "easy to happen" list and the full alert table —
with no price map of its own; its header cards show each product's ★ level,
favoured branch and bias.

**Pictures (optional).** Save them in `...\tradingview\reports\img\` with the
symbol and the date at the front of the name. Anything after the date becomes
the caption:

```
ES1-2026-09-14-30m.png      -> "30-minute"
ES-2026-09-14-daily.png     -> "Daily"
NQ1-2026-09-14-5m.jpg       -> "5-minute"
GC1-2026-09-14.png          -> "Chart 1"
GC1-2026-09-14-tpo.png      -> "TPO profile"
```

`ES1-` and `ES-` both work. Pictures wider than 1800px are scaled down and saved
as JPEG; otherwise whichever of PNG or JPEG is smaller is kept (TradingView
snapshots are usually smaller as PNG, ~130 KB). Higher timeframes are shown
first.

The easiest way to get the files: in TradingView use the camera menu →
**Download image** (not *Copy image*). It saves to `Downloads` as
`ES1!_2026-09-14_18-25-32_xxxxx.png` — move it into `reports\img` and rename it
to `ES1-2026-09-14-30m.png`.

**Publish**, from the repo root in PowerShell:

```powershell
.\tools\add-futures.ps1 -Date 2026-09-14

git add -A
git commit -m "Futures 2026-09-14"
git push
```

`-Date` defaults to today. The script prints each page it built, how many
charts it found, and the section count, so a missing picture or report shows
up immediately. Re-running for the same date rebuilds what it finds and keeps
any product it didn't, so a late GC report can be added on its own:

```powershell
.\tools\add-futures.ps1 -Date 2026-09-14 -Symbols GC1
```

**What the converter expects from the markdown.** It relies on the structure
the reports already have:

- line 1 `# Symbol: ES1! (E-mini S&P 500 · CME)`;
- a `Snapshot:` paragraph and a `**Primary setup:**` paragraph before the first
  `---`;
- `## ` sections, and `### 🥇 RANK 1 …` style headings for the scenarios.

From those it pulls the header cards: last price, the ★ level (`★ \`7715.00\`` or
the older `★ … \`DECISION> 7665.25\``), the favoured LONG/SHORT branch, and the
bias from **Current bias:**.

A section whose heading contains **⛔** or "read this first" (e.g. a contract
roll or FOMC notice) is shown open, above the price map.

The interactive parts read three more pieces, all in the skill's fixed format:

- **Price map** — the `🔼 UPSIDE LADDER` / `🔽 DOWNSIDE LADDER` tables
  (`# | Level | Source | Class`) and the `30-min ATR ≈` plus `ATR:` (or older
  `ATR condition:`) lines. TARGET rungs draw as lines, PASS-THROUGH rungs as
  faint bands.
- **Trade planner** — the `## Alerts` table
  (`★ | Level | Name | LONG … | SHORT … | ID`, cells `T1 <p> T2 <p> T3 <p> SL <p>`).
  It rebuilds the exact 5-line alert text for copying.
- **Ranked scenarios** — each `### 🥇 RANK 1 — [S#] name`, its `**Why …:**` line,
  and a `Favoured …: LONG|SHORT` line (the ★ scenario falls back to the report's
  favoured side). Two branch formats are understood:
  - **from 2026-09-14** — a `**Level <p>**` line, then one bullet per approach:
    `FROM BELOW: REJECT → SHORT T1 <p> · T2 <p> · T3 <p> · SL <p>`, or two on one
    line after a level (`7834.25 — last lower high. BREAK → backtest → LONG T1 … SL <p> · REJECT → SHORT T1 … SL <p>`).
    The direction is the LONG/SHORT word; entry is the level unless the bullet
    states `entry ~<p>`.
  - **to 2026-09-13** — a `**Trigger:**` line and prose bullets carrying
    `entry ~<p>`, `T1 <p>`, `runner <p>`, `stop ~<p>`, `R:R <n>`.
  - **from 2026-09-15** — a bullet each for `Trigger:`, `Entry:`, `Target:`,
    `Stop Loss:` and `R:R:`, plus `If it … instead → SHORT T1 … tactical SL …`
    one-liners for the other side. From 09-19 the entry bullet may state only a
    `Max-chase:` limit, in which case the entry is the scenario's own level (the
    price in the heading); `R:R:` may be written as arithmetic
    (`to T1 = 8.50 ÷ 11.25 = 0.76`); and a fork scenario writes one
    `Target (a — … → LONG)` / `Target (b — … → SHORT)` bullet per side, with the
    `(a)` / `(b)` halves of the entry, stop and R:R bullets going with them.
    The header block ends at the `---` rule or, when there is none, at the first
    `## ` heading.

The build prints each product's branch count split into long / short, and
warns when a ★ level or ATR is missing, a branch has no entry or stop, or every
branch parsed the same direction — the usual signs the report format drifted.

The build prints what it found per product (rungs, alerts, scenarios, branches).
If a future report changes that wording, the page still renders in full; only
the part it could not read is left out — and a missing alert table is flagged
in the output.

The page script and styles live in `tools/report/` and are copied to
`futures/assets/` on every build, so a design change reaches every day's pages
the next time any day is built.

## Weekly plans — every weekend

```powershell
.\tools\add-plan.ps1 -Date 2026-09-19 `
    -Equities "C:\Users\VINHSANH\Documents\swing trade research\swing_breakout_report_2026-09-19.html" `
    -Wheel    "C:\Users\VINHSANH\Documents\the wheel strategies\wheel-desk-run6-2026-09-19.html"

git add -A
git commit -m "Plan 2026-09-19"
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
.\tools\add-plan.ps1 -Date 2026-09-19 -Wheel "...\wheel-desk-run6-2026-09-20.html"

# Custom dropdown text.
.\tools\add-plan.ps1 -Date 2026-09-19 -Label "Week of Sep 21" -Equities "..."

# Override the generated date if it isn't in the filename.
.\tools\add-plan.ps1 -Date 2026-09-19 -Equities "..." -EquitiesDate 2026-09-18
```

To drop a plan or a futures day: delete its folder and remove its line from the
matching `manifest.js`.

## Deep links

```
https://equityswingtrade.github.io/trading-plans/#2026-09-12/equities
https://equityswingtrade.github.io/trading-plans/#2026-09-12/wheel
https://equityswingtrade.github.io/trading-plans/#futures/2026-09-13/ES
```

## Notes

- The wheel report calls `window.claude.use('db')` for its live run-history
  table. That API only exists inside Claude Artifacts, so on GitHub Pages that
  one panel falls back to its offline state.
- The equities report ships a light-only palette; the wheel report, the futures
  pages and the shell follow the reader's light/dark setting.
- Size: weekly reports run ~3.5 MB a week; a futures day is ~175 KB of HTML
  plus its pictures. With six ~250 KB pictures a day that is roughly 400 MB a
  year of trading days. GitHub Pages sites are capped at 1 GB, so plan to prune
  old futures pictures yearly.

## Local preview

```bash
npx --yes http-server . -p 4173 -c-1
```
