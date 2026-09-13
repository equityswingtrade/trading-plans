// Build the futures price-map pages for one report date.
//
//   node tools/build-futures.mjs --date 2026-09-13
//        [--src C:\Users\VINHSANH\.claude\tradingview\reports] [--symbols ES1,NQ1,GC1]
//
// Reads <SYM>-structured-<date>.md, writes futures/<date>/<KEY>.html, and
// upserts the day into futures/manifest.js. Every image in
// futures/<date>/img/ named <KEY>-<tag>.jpg|png is shown in that page's Charts
// section (add-futures.ps1 puts them there); the tag becomes the caption.

import { readFileSync, writeFileSync, existsSync, mkdirSync, statSync, readdirSync } from "node:fs";
import { dirname, join, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { marked } from "./vendor/marked.mjs";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const ORDER = ["ES", "NQ", "GC"];
const RANKS = ["🥇", "🥈", "🥉", "4️⃣", "5️⃣", "6️⃣"];

// Known chart tags, in display order: higher timeframe first.
const TAGS = [
  ["w", "Weekly"], ["weekly", "Weekly"], ["d", "Daily"], ["daily", "Daily"],
  ["4h", "4-hour"], ["1h", "1-hour"], ["60m", "60-minute"], ["30m", "30-minute"],
  ["15m", "15-minute"], ["5m", "5-minute"], ["tpo", "TPO profile"], ["profile", "Market Profile"],
];

function chartsFor(key){
  const dir = join(outDir, "img");
  if (!existsSync(dir)) return [];
  const rank = tag => { const i = TAGS.findIndex(t => t[0] === tag); return i < 0 ? 99 : i; };
  return readdirSync(dir)
    .filter(f => f.toUpperCase().startsWith(key + "-") && /\.(jpe?g|png)$/i.test(f))
    .map(f => {
      const tag = f.slice(key.length + 1).replace(/\.(jpe?g|png)$/i, "").toLowerCase();
      const known = TAGS.find(t => t[0] === tag);
      return { file: "img/" + f, tag, caption: known ? known[1] : /^\d+$/.test(tag) ? "Chart " + tag : tag.replace(/-/g, " ") };
    })
    .sort((a, b) => rank(a.tag) - rank(b.tag) || a.tag.localeCompare(b.tag, undefined, { numeric: true }));
}

function fail(msg){ console.error("build-futures: " + msg); process.exit(1); }

function parseArgs(argv){
  const out = {};
  for (let i = 0; i < argv.length; i++){
    if (!argv[i].startsWith("--")) continue;
    const next = argv[i + 1];
    out[argv[i].slice(2)] = (next && !next.startsWith("--")) ? (i++, next) : "true";
  }
  return out;
}

const opt = parseArgs(process.argv.slice(2));
const date = opt.date;
if (!/^\d{4}-\d{2}-\d{2}$/.test(date || "")) fail("--date yyyy-MM-dd is required");
const srcDir = opt.src || "C:\\Users\\VINHSANH\\.claude\\tradingview\\reports";
const symbols = (opt.symbols || "ES1,NQ1,GC1").split(",").map(s => s.trim().toUpperCase()).filter(Boolean);
const outDir = join(ROOT, "futures", date);

marked.setOptions({ gfm: true });

// ---------- helpers ----------

const esc = s => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

function slug(s){
  return s.toLowerCase().replace(/<[^>]+>/g, "").replace(/&[a-z#0-9]+;/g, "")
          .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "s";
}
function uniq(id, seen){
  let out = id, n = 2;
  while (seen.has(out)) out = id + "-" + n++;
  seen.add(out);
  return out;
}

function longLabel(iso){
  return new Date(iso + "T00:00:00Z").toLocaleDateString("en-US", {
    weekday: "short", month: "short", day: "numeric", year: "numeric", timeZone: "UTC",
  });
}

// Colour LONG / SHORT in text nodes only, never inside tags or attributes.
const colorDir = html => html.replace(/>([^<]+)</g, (m, t) =>
  ">" + t.replace(/\b(LONG|SHORT)\b/g, '<span class="d-$1">$1</span>') + "<");

function polish(html){
  html = html.replace(/<table>/g, '<div class="tw"><table>').replace(/<\/table>/g, "</table></div>");
  // Ladder "Class" cells: targets read solid, pass-through levels recede.
  html = html.replace(/<td([^>]*)>([\s\S]*?)<\/td>/g, (m, attr, inner) => {
    const t = inner.replace(/<[^>]+>/g, "").trim();
    const cls = /^PASS-THROUGH/.test(t) ? "k-pass" : /^TARGET/.test(t) ? "k-tgt" : "";
    return cls ? `<td${attr} class="${cls}">${inner}</td>` : m;
  });
  html = html.replace(/<tr>(\s*<td[^>]*>)★<\/td>/g, '<tr class="star">$1★</td>');
  return colorDir(html);
}

const md = s => polish(marked.parse(s));
const inline = s => colorDir(">" + marked.parseInline(s) + "<").slice(1, -1);

function tocLabel(title){
  const map = [
    [/scorecard/i, "Scorecard"], [/long-term/i, "Long-term"], [/daily trend/i, "Trend & vol"],
    [/key price map/i, "Price map"], [/5-minute/i, "5-min tape"], [/market profile context/i, "Profile"],
    [/auction intent/i, "Auction"], [/market structure/i, "Structure"], [/forward scenarios/i, "Scenarios"],
    [/final takeaway/i, "Takeaway"], [/^alerts/i, "Alerts"], [/skill changes/i, "Skill changes"],
  ];
  for (const [re, label] of map) if (re.test(title)) return label;
  const plain = title.replace(/^\d+(\.\d+)?[a-z]?\.\s*/i, "").replace(/[*`]/g, "");
  return plain.length > 24 ? plain.slice(0, 23) + "…" : plain;
}

// ---------- report parsing ----------

function parseReport(text){
  text = text.replace(/\r\n/g, "\n");
  const lines = text.split("\n");
  let i = 0;
  while (i < lines.length && !lines[i].trim()) i++;

  const head = /^#\s*Symbol:\s*(\S+)\s*(?:\((.*)\))?\s*$/.exec(lines[i] || "");
  const ticker = head ? head[1] : "";
  const desc = head ? (head[2] || "") : "";
  if (head) i++;

  const rest = lines.slice(i).join("\n");
  const hr = rest.search(/^---\s*$/m);
  const headMd = hr >= 0 ? rest.slice(0, hr) : "";
  const bodyMd = hr >= 0 ? rest.slice(hr).replace(/^---\s*\n/, "") : rest;

  let snapshot = "", primary = "";
  const notes = [];
  for (const block of headMd.split(/\n\s*\n/)){
    const b = block.trim();
    if (!b) continue;
    if (/^Snapshot:/i.test(b)) snapshot = b.replace(/^Snapshot:\s*/i, "");
    else if (/^\*\*Primary setup:\*\*/i.test(b)) primary = b.replace(/^\*\*Primary setup:\*\*\s*/i, "");
    else notes.push(b);
  }

  const sections = [];
  for (const part of bodyMd.split(/^(?=## )/m)){
    if (!part.trim()) continue;
    const m = /^## (.*)\n?/.exec(part);
    const body = (m ? part.slice(m[0].length) : part).replace(/^-{3,}\s*$/gm, "");
    sections.push({ title: m ? m[1].trim() : null, md: body });
  }

  const last = (/Last \*\*([\d.,]+)\*\*/.exec(snapshot) || [])[1] || "";
  const star = (/`DECISION>\s*([\d.,]+)`/.exec(primary) || [])[1] || "";
  const favoured = ((/favou?red\s+\**\s*(LONG|SHORT)/i.exec(primary) || [])[1] || "").toUpperCase();
  const snapDate = (/^(.+?)(?:,|\s·)/.exec(snapshot) || [])[1] || "";
  const biasFull = ((/\*\*Current bias:\*\*\s*([^\n]+)/.exec(bodyMd) || [])[1] || "").replace(/\*\*/g, "").trim();
  const biasShort = (/^([A-Z]+(?:-to-[A-Z]+)?)(,\s*leaning\s+\w+)?/.exec(biasFull) || [])[0] || "";

  return { ticker, desc, snapshot, primary, notes, sections, last, star, favoured, snapDate, biasFull, biasShort };
}

function renderSection(body, prefix, seen){
  let html = "";
  for (const chunk of body.split(/^(?=### )/m)){
    const m = /^### (.*)\n?/.exec(chunk);
    if (!m){ if (chunk.trim()) html += md(chunk); continue; }
    const title = m[1].trim();
    const h3 = `<h3 id="${uniq(prefix + "-" + slug(title), seen)}">${inline(title)}</h3>`;
    const inner = md(chunk.slice(m[0].length));
    const rank = RANKS.findIndex(r => title.startsWith(r));
    html += rank >= 0
      ? `<article class="rank r${rank + 1}${title.includes("★") ? " star" : ""}">${h3}${inner}</article>`
      : `<div class="sub">${h3}${inner}</div>`;
  }
  return html;
}

// ---------- page ----------

const CSS = `
:root{
  color-scheme:light;
  --bg:#f6f7f8; --surface:#fff; --sunk:#f0f2f4;
  --ink:#111827; --ink2:#4b5563; --ink3:#8b95a3; --rule:#e1e5ea; --rule2:#eef0f3;
  --accent:#1d4ed8; --up:#0f7a55; --dn:#b42318; --gold:#a16207; --gold-soft:#fdf6e3;
  --mono:ui-monospace,SFMono-Regular,"SF Mono",Menlo,Consolas,monospace;
  --sans:-apple-system,BlinkMacSystemFont,"Segoe UI",Inter,Roboto,Helvetica,Arial,sans-serif;
}
@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){
  color-scheme:dark;
  --bg:#0e1116; --surface:#161b22; --sunk:#11151b;
  --ink:#e6edf3; --ink2:#a4afbb; --ink3:#6e7a87; --rule:#29313b; --rule2:#1e252d;
  --accent:#8fb2ff; --up:#3ec48f; --dn:#f07167; --gold:#e3b341; --gold-soft:#2a2414;
}}
:root[data-theme="dark"]{
  color-scheme:dark;
  --bg:#0e1116; --surface:#161b22; --sunk:#11151b;
  --ink:#e6edf3; --ink2:#a4afbb; --ink3:#6e7a87; --rule:#29313b; --rule2:#1e252d;
  --accent:#8fb2ff; --up:#3ec48f; --dn:#f07167; --gold:#e3b341; --gold-soft:#2a2414;
}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);font:14.5px/1.6 var(--sans);-webkit-font-smoothing:antialiased}
.wrap{max-width:1180px;margin:0 auto;padding:0 22px 64px}
a{color:var(--accent)}
header.top{padding:22px 0 14px}
.crumbs{display:flex;gap:8px;align-items:center;flex-wrap:wrap;font-size:12.5px;color:var(--ink3);margin-bottom:12px}
.crumbs a{text-decoration:none;font-weight:560}
.sib{margin-left:auto;display:flex;gap:4px}
.sib a{padding:2px 9px;border-radius:6px;border:1px solid var(--rule);color:var(--ink2);font-weight:600}
.sib a[aria-current]{background:var(--ink);border-color:var(--ink);color:var(--bg)}
.framed .crumbs{display:none}
h1{margin:0;font-size:26px;line-height:1.2;letter-spacing:-.02em;font-weight:690}
h1 .desc{font-size:15px;font-weight:500;letter-spacing:0;color:var(--ink3);margin-left:6px}
.snap{margin:6px 0 0;color:var(--ink2);font-size:13.5px}
.kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px;margin-top:16px}
.kpi{background:var(--surface);border:1px solid var(--rule);border-radius:10px;padding:9px 13px}
.kpi span{display:block;font-size:10.5px;font-weight:650;letter-spacing:.07em;text-transform:uppercase;color:var(--ink3)}
.kpi b{display:block;margin-top:2px;font:650 18px/1.3 var(--mono);font-variant-numeric:tabular-nums;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.kpi b.txt{font-family:var(--sans);font-size:15.5px;white-space:normal}
.kpi.star{border-left:3px solid var(--gold)}
.toc{position:sticky;top:0;z-index:5;display:flex;gap:2px;overflow-x:auto;background:var(--bg);
  border-bottom:1px solid var(--rule);margin:0 -22px;padding:7px 22px;scrollbar-width:thin}
.toc a{flex:0 0 auto;font-size:12.5px;font-weight:560;color:var(--ink2);text-decoration:none;padding:4px 10px;border-radius:999px}
.toc a:hover{background:var(--rule2);color:var(--ink)}
.primary{margin:18px 0 6px;background:var(--surface);border:1px solid var(--rule);border-left:4px solid var(--gold);border-radius:10px;padding:13px 18px}
.primary .lbl{font-size:11px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:var(--gold)}
.primary p{margin:5px 0 0;font-size:15px;line-height:1.65}
.notes{margin-top:12px;font-size:13.5px;color:var(--ink2)}
.notes p{margin:6px 0}
section{scroll-margin-top:50px;margin-top:30px}
h2{font-size:19px;letter-spacing:-.01em;margin:0 0 12px;padding-bottom:8px;border-bottom:1px solid var(--rule)}
h3{font-size:15.5px;margin:22px 0 8px;scroll-margin-top:50px}
p,li{max-width:96ch}
ul,ol{padding-left:22px}
li{margin:3px 0}
code{font-family:var(--mono);font-size:.87em;background:var(--sunk);border:1px solid var(--rule2);padding:0 5px;border-radius:4px;white-space:nowrap}
strong{font-weight:650}
.tw{overflow-x:auto;margin:10px 0 14px;border:1px solid var(--rule);border-radius:8px;background:var(--surface)}
table{border-collapse:collapse;width:100%;font-size:13px;font-variant-numeric:tabular-nums}
th{text-align:left;font-size:10.5px;font-weight:650;letter-spacing:.05em;text-transform:uppercase;color:var(--ink3);
  background:var(--sunk);padding:7px 10px;border-bottom:1px solid var(--rule);white-space:nowrap}
td{padding:7px 10px;border-bottom:1px solid var(--rule2);vertical-align:top}
tr:last-child td{border-bottom:0}
tr.star td{background:var(--gold-soft)}
td.k-tgt{white-space:nowrap}
td.k-pass{color:var(--ink3);font-style:italic;white-space:nowrap}
.d-LONG{color:var(--up);font-weight:650}
.d-SHORT{color:var(--dn);font-weight:650}
.rank{background:var(--surface);border:1px solid var(--rule);border-radius:12px;padding:2px 18px 8px;margin:14px 0}
.rank h3{margin-top:14px}
.rank.star{border-left:4px solid var(--gold)}
.charts .grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(360px,1fr));gap:14px}
figure{margin:0;background:var(--surface);border:1px solid var(--rule);border-radius:10px;overflow:hidden}
figure a{display:block}
figure img{display:block;width:100%;height:auto}
figcaption{font-size:12.5px;color:var(--ink3);padding:8px 12px;border-top:1px solid var(--rule2)}
footer{margin-top:44px;padding-top:12px;border-top:1px solid var(--rule);font:12px/1.5 var(--mono);color:var(--ink3)}
@media (max-width:640px){
  .wrap{padding:0 14px 48px}
  .toc{margin:0 -14px;padding:7px 14px}
  h1{font-size:22px}
  .charts .grid{grid-template-columns:1fr}
}`;

function page(r, key, siblings, mdName){
  const seen = new Set(["primary", "charts"]);
  const favTxt = r.favoured === "LONG" ? "▲ LONG" : r.favoured === "SHORT" ? "▼ SHORT" : "";

  const kpis = [
    r.last && `<div class="kpi"><span>Last</span><b>${esc(r.last)}</b></div>`,
    r.star && `<div class="kpi star"><span>★ Decision</span><b>${esc(r.star)}</b></div>`,
    favTxt && `<div class="kpi"><span>Favoured branch</span><b class="d-${r.favoured}">${favTxt}</b></div>`,
    r.biasShort && `<div class="kpi"><span>Bias</span><b class="txt" title="${esc(r.biasFull)}">${esc(r.biasShort)}</b></div>`,
  ].filter(Boolean).join("");

  const shots = chartsFor(key).map(c =>
    `<figure><a href="${c.file}" target="_blank" rel="noopener"><img src="${c.file}" alt="${esc(r.ticker || key)} ${esc(c.caption)} chart" loading="lazy"></a><figcaption>${esc(c.caption)}</figcaption></figure>`);

  const toc = [`<a href="#primary">Setup</a>`];
  if (shots.length) toc.push(`<a href="#charts">Charts</a>`);

  let body = "";
  for (const s of r.sections){
    if (!s.title){ body += md(s.md); continue; }
    const id = uniq(slug(tocLabel(s.title)), seen);
    toc.push(`<a href="#${id}">${esc(tocLabel(s.title))}</a>`);
    body += `<section id="${id}"><h2>${inline(s.title)}</h2>${renderSection(s.md, id, seen)}</section>`;
  }

  const sib = siblings.map(k =>
    `<a href="${k}.html"${k === key ? ' aria-current="page"' : ""}>${k}</a>`).join("");

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(key)} price map — ${esc(date)}</title>
<script>if (window.self !== window.top) document.documentElement.classList.add("framed");</script>
<style>${CSS}</style>
</head>
<body>
<div class="wrap">
<header class="top">
  <div class="crumbs">
    <a href="../../index.html#futures/${date}/${key}">Trading Plans</a><span>/</span><span>Futures · ${esc(longLabel(date))}</span>
    <nav class="sib" aria-label="Products">${sib}</nav>
  </div>
  <h1>${esc(r.ticker || key)}<span class="desc">${esc(r.desc)}</span></h1>
  ${r.snapshot ? `<p class="snap">${inline(r.snapshot)}</p>` : ""}
  ${kpis ? `<div class="kpis">${kpis}</div>` : ""}
</header>
<nav class="toc" aria-label="Sections">${toc.join("")}</nav>
<section class="primary" id="primary">
  <div class="lbl">★ Primary setup</div>
  <p>${inline(r.primary || "—")}</p>
  ${r.notes.length ? `<div class="notes">${md(r.notes.join("\n\n"))}</div>` : ""}
</section>
${shots.length ? `<section class="charts" id="charts"><h2>Charts</h2><div class="grid">${shots.join("")}</div></section>` : ""}
${body}
<footer>Built from ${esc(mdName)} · ${new Date().toISOString().slice(0, 16).replace("T", " ")} UTC</footer>
</div>
</body>
</html>
`;
}

// ---------- build ----------

const found = [];
for (const sym of symbols){
  const mdPath = join(srcDir, `${sym}-structured-${date}.md`);
  if (!existsSync(mdPath)){ console.warn(`  skip ${sym}: ${basename(mdPath)} not found`); continue; }
  found.push({ sym, key: sym.replace(/1$/, ""), mdPath });
}
if (!found.length) fail(`no reports for ${date} in ${srcDir}`);

mkdirSync(outDir, { recursive: true });
const siblings = found.map(f => f.key).sort((a, b) => {
  const ia = ORDER.indexOf(a), ib = ORDER.indexOf(b);
  return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib) || a.localeCompare(b);
});

const built = {};
console.log(`Futures ${date} — ${longLabel(date)}`);
for (const f of found){
  const r = parseReport(readFileSync(f.mdPath, "utf8"));
  const html = page(r, f.key, siblings, basename(f.mdPath));
  const out = join(outDir, `${f.key}.html`);
  writeFileSync(out, html, "utf8");
  const charts = chartsFor(f.key).length;
  built[f.key] = {
    file: `${f.key}.html`, symbol: r.ticker || f.sym, name: r.desc, snapshot: r.snapDate,
    last: r.last, star: r.star, favoured: r.favoured || null, bias: r.biasShort || null, charts,
  };
  console.log(`  ${f.key}.html  (${Math.round(statSync(out).size / 1024)} KB, ${charts} chart${charts === 1 ? "" : "s"}, ${r.sections.length} sections)`);
}

// ---------- manifest ----------

const mfPath = join(ROOT, "futures", "manifest.js");
let manifest = { days: [] };
if (existsSync(mfPath)){
  const raw = readFileSync(mfPath, "utf8").replace(/^\s*window\.FUTURES_MANIFEST\s*=\s*/, "").replace(/;\s*$/, "");
  try { manifest = JSON.parse(raw); } catch (e) { fail("futures/manifest.js is not valid JSON: " + e.message); }
}
const days = Array.isArray(manifest.days) ? manifest.days : [];
const prev = days.find(d => d.id === date);

// Products rebuilt now replace their old entries; ones not in this run are kept.
const merged = Object.assign({}, prev && prev.products, built);
const products = {};
Object.keys(merged)
  .sort((a, b) => { const ia = ORDER.indexOf(a), ib = ORDER.indexOf(b); return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib) || a.localeCompare(b); })
  .forEach(k => { products[k] = merged[k]; });

const day = { id: date, label: longLabel(date), products };
const all = days.filter(d => d.id !== date).concat(day).sort((a, b) => String(b.id).localeCompare(String(a.id)));

writeFileSync(mfPath,
  "window.FUTURES_MANIFEST = {\n  \"days\": [\n" +
  all.map(d => "    " + JSON.stringify(d)).join(",\n") +
  "\n  ]\n};\n", "utf8");
console.log(`  manifest.js updated — ${all.length} day${all.length === 1 ? "" : "s"} listed`);
