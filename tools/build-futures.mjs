// Build the futures price-map pages for one report date.
//
//   node tools/build-futures.mjs --date 2026-09-13
//        [--src C:\Users\VINHSANH\.claude\tradingview\reports] [--symbols ES1,NQ1,GC1]
//
// Reads <SYM>-structured-<date>.md, writes futures/<date>/<KEY>.html, copies the
// shared page script and styles to futures/assets/, and upserts the day into
// futures/manifest.js.
//
// Besides rendering the markdown, it lifts the numbers the interactive parts
// need - the two ladders, the alert table and the ranked scenarios - into a
// JSON block on the page. Anything it cannot parse is simply left out of the
// map; the report text is always rendered in full.
//
// Every image in futures/<date>/img/ named <KEY>-<tag>.jpg|png is shown in a
// Charts section; the tag becomes the caption.

import { readFileSync, writeFileSync, existsSync, mkdirSync, statSync, readdirSync, copyFileSync } from "node:fs";
import { dirname, join, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { marked } from "./vendor/marked.mjs";
import { createHash } from "node:crypto";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const ORDER = ["ES", "NQ", "GC"];
const RANKS = ["🥇", "🥈", "🥉", "4️⃣", "5️⃣", "6️⃣"];

// Known chart tags, in display order: higher timeframe first.
const TAGS = [
  ["w", "Weekly"], ["weekly", "Weekly"], ["d", "Daily"], ["daily", "Daily"],
  ["4h", "4-hour"], ["1h", "1-hour"], ["60m", "60-minute"], ["30m", "30-minute"],
  ["15m", "15-minute"], ["5m", "5-minute"], ["tpo", "TPO profile"], ["profile", "Market Profile"],
];

// Hover definitions, condensed from the skill's mp-playbook.md and market-dynamics-laws.md.
const GLOSSARY = [
  ["VAH", "Value Area High — top of the range where ~70% of the session traded."],
  ["VAL", "Value Area Low — bottom of the value area."],
  ["POC", "Point of Control — the most-traded price; a magnet."],
  ["HVN", "High-volume node — heavy trade at a price: acceptance, price slows here (Law 9)."],
  ["LVN", "Low-volume node — thin trade: rejection, price moves fast through it (Law 9)."],
  ["ETH", "Electronic (overnight) session, 17:00–08:30 CT."],
  ["RTH", "Regular trading hours, 08:30–15:00 CT."],
  ["IB", "Initial Balance — the first hour's range. Narrow = trend-day risk; wide = range day."],
  ["MOC", "Market-on-close — the closing auction."],
  ["ATR", "Average True Range. Stops here are sized ~0.5× the 30-minute ATR."],
  ["80% rule", "Re-enter yesterday's value and hold two 30-min periods → ~80% odds of crossing to the far edge."],
  ["Poor High", "Unfinished high with no excess — a repair magnet likely to be revisited."],
  ["Poor Low", "Unfinished low with no excess — a repair magnet likely to be revisited."],
  ["Weak High", "Unfinished high — a repair magnet likely to be revisited."],
  ["Weak Low", "Unfinished low — a repair magnet likely to be revisited."],
  ["Buying Tail", "Excess at a low — a finished, decisive rejection. Trade against it with confidence."],
  ["Selling Tail", "Excess at a high — a finished, decisive rejection. Trade against it with confidence."],
  ["Single Print", "One-timeframe zone left by a fast move; revisits travel fast."],
  ["Spike Base", "Where the prior session's closing spike began. Open above = support; below = rejected."],
  ["DECISION>", "A two-sided level: hold or rejection on a 30-min close decides the side."],
];

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

// ---------- text helpers ----------

const esc = s => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const plain = s => String(s).replace(/\*/g, "").replace(/`/g, "").replace(/\s+/g, " ").trim();
const PRICE = /\d{3,}(?:\.\d+)?/;
const firstPrice = s => { const m = PRICE.exec(s); return m ? Number(m[0]) : null; };

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
const sortProducts = (a, b) => {
  const ia = ORDER.indexOf(a), ib = ORDER.indexOf(b);
  return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib) || a.localeCompare(b);
};

// Colour LONG / SHORT in text nodes only, never inside tags or attributes.
const colorDir = html => html.replace(/>([^<]+)</g, (m, t) =>
  ">" + t.replace(/\b(LONG|SHORT)\b/g, '<span class="d-$1">$1</span>') + "<");

function polish(html){
  html = html.replace(/<table>/g, '<div class="tw"><table>').replace(/<\/table>/g, "</table></div>");
  html = html.replace(/<td([^>]*)>([\s\S]*?)<\/td>/g, (m, attr, inner) => {
    const t = inner.replace(/<[^>]+>/g, "").trim();
    const cls = /^PASS-THROUGH/.test(t) ? "k-pass" : /^TARGET/.test(t) ? "k-tgt" : "";
    return cls ? `<td${attr} class="${cls}">${inner}</td>` : m;
  });
  html = html.replace(/<tr>(\s*<td[^>]*>)★<\/td>/g, '<tr class="star">$1★</td>');
  return colorDir(html);
}

// Wrap the first use of each glossary term in a section with <abbr title>.
// Skips text inside code, links, headings, table headers and existing abbr.
function gloss(html){
  const used = new Set();
  const terms = GLOSSARY.map(g => g[0]).sort((a, b) => b.length - a.length);
  const re = new RegExp("(?<![\\w-])(" + terms.map(t => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/&gt;|>/, "&gt;")).join("|") + ")(?![\\w-])", "gi");
  const defs = new Map(GLOSSARY.map(([k, v]) => [k.toLowerCase().replace(">", "&gt;"), [k, v]]));
  let skip = 0;
  return html.replace(/(<[^>]+>)|([^<]+)/g, (m, tag, text) => {
    if (tag){
      if (/^<(code|a|abbr|h[1-6]|th)[\s>]/i.test(tag)) skip++;
      else if (/^<\/(code|a|abbr|h[1-6]|th)>/i.test(tag)) skip = Math.max(0, skip - 1);
      return tag;
    }
    if (skip) return text;
    return text.replace(re, word => {
      const hit = defs.get(word.toLowerCase());
      if (!hit) return word;
      const [key, def] = hit;
      // Acronyms must match case exactly ("val" in prose is not VAL).
      if (/^[A-Z]{2,4}$/.test(key) && word !== key) return word;
      if (used.has(key)) return word;
      used.add(key);
      return `<abbr title="${esc(def)}">${word}</abbr>`;
    });
  });
}

const md = s => polish(marked.parse(s));
const inline = s => colorDir(">" + marked.parseInline(s) + "<").slice(1, -1);

function tocLabel(title){
  const map = [
    [/⛔|read this first/i, "⛔ Read first"],
    [/scorecard/i, "Scorecard"], [/long-term/i, "Long-term"], [/daily trend/i, "Trend & vol"],
    [/key price map/i, "Price map"], [/5-minute/i, "5-min tape"], [/market profile context/i, "Profile"],
    [/auction intent/i, "Auction"], [/market structure/i, "Structure"], [/forward scenarios/i, "Full scenarios"],
    [/final takeaway/i, "Takeaway"], [/^alerts/i, "Alerts"], [/skill changes/i, "Skill changes"],
  ];
  for (const [re, label] of map) if (re.test(title)) return label;
  const p = title.replace(/^\d+(\.\d+)?[a-z]?\.\s*/i, "").replace(/[*`]/g, "");
  return p.length > 24 ? p.slice(0, 23) + "…" : p;
}

// Markdown tables in a chunk -> [{ head, rows }]
function tables(text){
  const out = [];
  let cur = null;
  for (const line of text.split("\n")){
    const t = line.trim();
    if (!t.startsWith("|")){ cur = null; continue; }
    const cells = t.replace(/^\||\|$/g, "").split("|").map(c => c.trim());
    if (!cur){ cur = { head: cells, rows: [] }; out.push(cur); continue; }
    if (cells.every(c => /^:?-{2,}:?$/.test(c))) continue;
    cur.rows.push(cells);
  }
  return out;
}

const chunks = text => text.split(/^(?=### )/m).map(c => {
  const m = /^### (.*)\n?/.exec(c);
  return m ? { title: m[1].trim(), body: c.slice(m[0].length) } : { title: null, body: c };
});

// ---------- structured extraction ----------

function parseLadders(bodyMd){
  const rungs = [];
  for (const c of chunks(bodyMd)){
    if (!c.title) continue;
    const side = /UPSIDE LADDER/i.test(c.title) ? "up" : /DOWNSIDE LADDER/i.test(c.title) ? "down" : null;
    if (!side) continue;
    const t = tables(c.body)[0];
    if (!t) continue;
    for (const r of t.rows){
      if (r.length < 4) continue;
      const p = (plain(r[1]).match(/\d{3,}(?:\.\d+)?/g) || []).map(Number);
      if (!p.length) continue;
      const cls = plain(r[3]);
      rungs.push({
        side, p, src: plain(r[2]),
        cls: /^PASS/i.test(cls) ? "pass" : /^STOP/i.test(cls) ? "stop" : "target",
        dec: /\*\*/.test(r[1]) || /decision|★/i.test(cls),
      });
    }
  }
  return rungs;
}

function parseAlerts(sections){
  const sec = sections.find(s => s.title && /^Alerts/i.test(s.title));
  const t = sec && tables(sec.md)[0];
  if (!t) return [];
  const plan = cell => {
    const c = plain(cell);
    const tg = [...c.matchAll(/T(\d)\s+(\d{3,}(?:\.\d+)?)/g)].sort((a, b) => a[1] - b[1]).map(m => Number(m[2]));
    const sl = /SL\s+(\d{3,}(?:\.\d+)?)/.exec(c);
    return tg.length ? { t: tg, sl: sl ? Number(sl[1]) : null } : null;
  };
  return t.rows.filter(r => r.length >= 5 && firstPrice(plain(r[1])) != null).map(r => ({
    star: r[0].includes("★"), level: firstPrice(plain(r[1])), name: plain(r[2]),
    long: plan(r[3]), short: plan(r[4]),
  }));
}

// Older reports (to 2026-09-13): prose branches - "LONG if it HOLDS …: entry ~<p> · T1 <p> …
// runner <p> · stop ~<p> · R:R <n>".
function parseBranches(body, triggerPrice, triggerText){
  // Top-level bullets, with their indented sub-bullets folded in.
  const blocks = [];
  let cur = null;
  for (const line of body.split("\n")){
    if (/^- /.test(line)){ cur = [line.slice(2)]; blocks.push(cur); }
    else if (cur && /^\s+\S/.test(line)) cur.push(line.trim().replace(/^- /, ""));
    else if (line.trim()) cur = null;
  }
  let texts = blocks.map(b => plain(b.join(" · ")));
  // One-branch scenarios list Entry / Targets / Stop / R:R as separate bullets.
  if (blocks.some(b => /^Targets?:/i.test(plain(b[0])))) texts = [texts.join(" · ")];
  const single = texts.length === 1 && /^Entry:/i.test(texts[0]);

  const out = [];
  for (const text of texts){
    const colon = text.indexOf(":");
    const blockNum = colon > 0 && colon < 40 ? firstPrice(text.slice(0, colon)) : null;
    for (const part of text.split(/\s·\s(?=(?:LONG|SHORT)\b)|;\s(?=(?:LONG|SHORT)\b)/)){
      if (!/\bT1\b/.test(part)) continue;
      const pre = part.split(/R:R/)[0];
      const seen = new Set();
      const targets = [...pre.matchAll(/\bT([1-9])\s*~?\s*(\d{3,}(?:\.\d+)?)/g)]
        .filter(m => !seen.has(m[1]) && seen.add(m[1]))
        .map(m => ({ k: "T" + m[1], p: Number(m[2]) }))
        .sort((a, b) => a.k.localeCompare(b.k));
      if (!targets.length) continue;
      const num = re => { const m = re.exec(part); return m ? Number(m[m.length - 1]) : null; };
      let entry = num(/entry[^·]{0,60}?(\d{3,}(?:\.\d+)?)/i);
      if (entry == null) entry = blockNum != null ? blockNum : triggerPrice;
      const runner = (() => { const m = /runner\s*~?\s*(\d{3,}(?:\.\d+)?)/i.exec(pre); return m ? Number(m[1]) : null; })();
      let stop = num(/stop[^·]*?~\s*(\d{3,}(?:\.\d+)?)/i);
      if (stop == null) stop = num(/stop\s*~?\s*(\d{3,}(?:\.\d+)?)/i);
      const rr = num(/R:R\s*(?:to T1\s*)?(\d+(?:\.\d+)?)/);
      const dir = entry != null && targets[0].p < entry ? "SHORT" : "LONG";

      const arrow = part.indexOf("→"), t1 = part.search(/\bT1\b/), c = part.indexOf(":");
      let label = arrow > 0 && arrow < t1 ? part.slice(0, arrow) : c > 0 && c < t1 ? part.slice(0, c) : "";
      label = label.replace(/\s*·\s*$/, "").trim();
      if (single || label.length < 8) label = triggerText ? "On the trigger: " + triggerText : "On the trigger";
      if (label.length > 120) label = label.slice(0, 117) + "…";

      out.push({ label, dir, entry, targets, runner, stop, rr });
    }
  }
  return out;
}

// Newer reports (from 2026-09-14): alert-style branches, one per approach -
//   "FROM BELOW: REJECT → SHORT T1 <p> · T2 <p> · T3 <p> · SL <p>"
// or two on one line after a level -
//   "7834.25 — last lower high. BREAK → backtest → LONG T1 … SL <p> · REJECT → SHORT T1 … SL <p>".
// The direction is the word itself, never inferred from where T1 sits.
function parseLevelBranches(body, level){
  const out = [];
  for (const line of body.split("\n")){
    if (!/^- /.test(line)) continue;
    const t = plain(line.slice(2));
    const hits = [...t.matchAll(/\b(LONG|SHORT)\s+(?=T1\b)/g)];
    if (!hits.length) continue;
    const lead = /^(\d{3,}(?:\.\d+)?)\s*—\s*([^.]*)\.\s*/.exec(t);
    const head = lead ? lead[1] + " — " + lead[2].trim() : "";
    let from = lead ? lead[0].length : 0;
    hits.forEach((m, i) => {
      const numsStart = m.index + m[0].length;
      const seg = t.slice(numsStart, i + 1 < hits.length ? hits[i + 1].index : t.length);
      const sl = /\bSL\s*(\d{3,}(?:\.\d+)?)/.exec(seg);
      const numsEnd = sl ? sl.index + sl[0].length : seg.length;
      const seen = new Set();
      const targets = [...seg.slice(0, numsEnd).matchAll(/\bT([1-9])\s*(\d{3,}(?:\.\d+)?)/g)]
        .filter(x => !seen.has(x[1]) && seen.add(x[1]))
        .map(x => ({ k: "T" + x[1], p: Number(x[2]) }))
        .sort((a, b) => a.k.localeCompare(b.k));
      // A stated entry after the stop ("— entry ~29475 → risk 65") beats the level.
      const ent = /\bentry\s*(?:near|~|≈)\s*~?\s*(\d{3,}(?:\.\d+)?)/i.exec(seg.slice(numsEnd));
      const phrase = t.slice(from, m.index).replace(/^[\s·—]+/, "").replace(/[\s→:·]+$/, "").trim();
      from = numsStart + numsEnd;
      if (!targets.length) return;
      let label = [head, phrase].filter(Boolean).join(" · ") || "On the level";
      if (label.length > 120) label = label.slice(0, 117) + "…";
      out.push({
        label, dir: m[1], entry: ent ? Number(ent[1]) : lead ? Number(lead[1]) : level,
        targets, runner: null, stop: sl ? Number(sl[1]) : null, rr: null,
      });
    });
  }
  return out;
}

function parseScenarios(sections){
  const sec = sections.find(s => s.title && /forward scenarios/i.test(s.title));
  if (!sec) return [];
  const out = [];
  for (const c of chunks(sec.md)){
    if (!c.title) continue;
    const idx = RANKS.findIndex(r => c.title.startsWith(r));
    if (idx < 0) continue;
    const title = plain(c.title);
    const slot = (/\[([^\]]+)\]/.exec(title) || [])[1] || "";
    let name = slot ? title.slice(title.indexOf("]") + 1) : title.replace(/^.*?RANK\s*\d+\s*—\s*/i, "");
    name = name.replace(/★/g, "").trim();
    const trig = /^\*\*Trigger:\*\*\s*(.+)$/m.exec(c.body);
    const lvl = /^\*\*Level\s+(\d{3,}(?:\.\d+)?)[.*]*\s*(.*)$/m.exec(c.body);
    const why = /^\*\*Why[^*]*:\*\*\s*(.+)$/m.exec(c.body);
    const fav = /Favou?red(?: branch)?[^:]*:\s*(LONG|SHORT)/i.exec(plain(c.body));
    const triggerText = trig ? plain(trig[1]) : lvl ? plain("Level " + lvl[1] + " " + lvl[2]) : "";
    const alertStyle = /\b(?:LONG|SHORT)\s+T1\b/.test(plain(c.body));
    out.push({
      rank: idx + 1, slot, name, star: c.title.includes("★"),
      trigger: triggerText, why: why ? plain(why[1]) : "",
      favoured: fav ? fav[1].toUpperCase() : null,
      branches: alertStyle
        ? parseLevelBranches(c.body, lvl ? Number(lvl[1]) : triggerText ? firstPrice(triggerText) : null)
        : parseBranches(c.body, triggerText ? firstPrice(triggerText) : null, triggerText.length > 70 ? "" : triggerText),
    });
  }
  return out;
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

  const lastStr = (/Last \*\*([\d.,]+)\*\*/.exec(snapshot) || [])[1] || "";
  const flat = plain(bodyMd);
  const num = re => { const m = re.exec(flat); return m ? Number(m[1].replace(/,/g, "")) : null; };
  const biasFull = ((/\*\*Current bias:\*\*\s*([^\n]+)/.exec(bodyMd) || [])[1] || "").replace(/\*\*/g, "").trim();

  return {
    ticker, desc, snapshot, primary, notes, sections,
    last: lastStr ? Number(lastStr.replace(/,/g, "")) : null,
    decimals: lastStr.includes(".") ? lastStr.split(".")[1].length : 0,
    // "★ two-sided `DECISION> 7665.25`" (to 09-13) or "★ `7715.00`" (from 09-14)
    star: (/★[^`]*`(?:DECISION>\s*)?([\d.,]{3,})`/.exec(primary) || [])[1] || "",
    favoured: ((/favou?red\s+\**\s*(LONG|SHORT)/i.exec(primary) || [])[1] || "").toUpperCase(),
    snapDate: (/^(.+?)(?:,|\s·)/.exec(snapshot) || [])[1] || "",
    biasFull,
    biasShort: (/^([A-Z]+(?:-to-[A-Z]+)?)(,\s*leaning\s+\w+)?/.exec(biasFull) || [])[0] || "",
    atr30: num(/30-min ATR\s*(?:≈|~|=)?\s*([\d,]+(?:\.\d+)?)/),
    // "ATR condition: 72.25 = …" (to 09-13) or "ATR: 67.25 = …" (from 09-14)
    atrD: num(/\bATR(?: condition)?:\s*([\d,]+(?:\.\d+)?)/),
    ladder: parseLadders(bodyMd),
    alerts: parseAlerts(sections),
    scenarios: parseScenarios(sections),
  };
}

// ---------- page ----------

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

function renderSection(body, prefix, seen){
  let html = "";
  for (const c of chunks(body)){
    if (!c.title){ if (c.body.trim()) html += md(c.body); continue; }
    const h3 = `<h3 id="${uniq(prefix + "-" + slug(c.title), seen)}">${inline(c.title)}</h3>`;
    const inner = md(c.body);
    const rank = RANKS.findIndex(r => c.title.startsWith(r));
    html += rank >= 0
      ? `<article class="rank${c.title.includes("★") ? " star" : ""}" data-rank="${rank + 1}">${h3}${inner}</article>`
      : `<div class="sub">${h3}${inner}</div>`;
  }
  return html;
}

const HINTS = [
  [/key price map/i, "full ladders, profile tables, naked levels"],
  [/forward scenarios/i, "all six in full"],
  [/^alerts/i, "repeating level alerts"],
  [/scorecard/i, "how yesterday's plan did"],
];

function page(r, key, siblings, mdName){
  const seen = new Set(["primary", "desk", "ranked", "charts"]);
  const sign = n => (n > 0 ? "+" : n < 0 ? "−" : "") + Math.abs(n).toFixed(r.decimals);
  const starN = r.star ? Number(r.star.replace(/,/g, "")) : null;
  const favTxt = r.favoured === "LONG" ? "▲ LONG" : r.favoured === "SHORT" ? "▼ SHORT" : "";

  const starSub = starN != null && r.last != null
    ? `<small>${sign(starN - r.last)} from last${r.atr30 ? " · " + (Math.abs(starN - r.last) / r.atr30).toFixed(2) + "× 30m ATR" : ""}</small>` : "";
  const kpis = [
    r.last != null && `<div class="kpi"><span>Last</span><b>${esc(r.last.toFixed(r.decimals))}</b>${r.atr30 ? `<small>30m ATR ${esc(r.atr30)}</small>` : ""}</div>`,
    r.star && `<div class="kpi star"><span>★ Level</span><b>${esc(r.star)}</b>${starSub}</div>`,
    favTxt && `<div class="kpi"><span>Favoured branch</span><b class="d-${r.favoured}">${favTxt}</b></div>`,
    r.biasShort && `<div class="kpi"><span>Bias</span><b class="txt" title="${esc(r.biasFull)}">${esc(r.biasShort)}</b></div>`,
  ].filter(Boolean).join("");

  const interactive = r.alerts.length > 0;

  // A "read this first" notice (contract roll, event risk) sits above the map and starts open.
  const urgent = s => /⛔|read this first/i.test(s.title);
  // Takeaway leads the remaining collapsible sections and starts open; the rest keep report order.
  const secs = r.sections.filter(s => s.title);
  const take = secs.findIndex(s => /final takeaway/i.test(s.title));
  if (take > 0) secs.unshift(secs.splice(take, 1)[0]);

  const tocPre = [], tocBody = [];
  let pre = "", body = "";
  const shots = chartsFor(key);
  if (shots.length){
    tocBody.push(`<a href="#charts">Charts</a>`);
    body += `<details class="sec" id="charts" open><summary><h2>Charts</h2></summary><div class="sec-body"><div class="charts-grid">` +
      shots.map(c => `<figure><a href="${c.file}" target="_blank" rel="noopener"><img src="${c.file}" alt="${esc(r.ticker || key)} ${esc(c.caption)} chart" loading="lazy"></a><figcaption>${esc(c.caption)}</figcaption></figure>`).join("") +
      `</div></div></details>`;
  }
  for (const s of secs){
    const id = uniq(slug(tocLabel(s.title)), seen);
    const u = urgent(s);
    const hint = (HINTS.find(([re]) => re.test(s.title)) || [])[1];
    const html = `<details class="sec${u ? " urgent" : ""}" id="${id}"${u || /final takeaway/i.test(s.title) ? " open" : ""}>` +
      `<summary><h2>${inline(s.title)}</h2>${hint ? `<span class="hint">${esc(hint)}</span>` : ""}</summary>` +
      `<div class="sec-body">${gloss(renderSection(s.md, id, seen))}</div></details>`;
    (u ? tocPre : tocBody).push(`<a href="#${id}">${esc(tocLabel(s.title))}</a>`);
    if (u) pre += html; else body += html;
  }

  const toc = [`<a href="#primary">Setup</a>`].concat(tocPre);
  if (interactive) toc.push(`<a href="#desk">Map & planner</a>`);
  if (r.scenarios.length) toc.push(`<a href="#ranked">Scenarios</a>`);
  toc.push(...tocBody);

  const sib = siblings.map(k =>
    `<a href="${k}.html"${k === key ? ' aria-current="page"' : ""}>${k}</a>`).join("");

  const data = {
    key, ticker: r.ticker || key, decimals: r.decimals, last: r.last, star: starN,
    favoured: r.favoured || null, atr30: r.atr30, atrD: r.atrD,
    ladder: r.ladder, alerts: r.alerts, scenarios: r.scenarios,
  };

  const desk = interactive ? `
<section class="desk" id="desk">
  <div class="desk-grid">
    <div class="card map-card" id="map-card">
      <div class="card-head">
        <h2>Price map</h2>
        <div class="seg" id="zoomSeg" role="group" aria-label="Map range">
          <button type="button" data-zoom="plan" aria-pressed="true">This plan</button>
          <button type="button" data-zoom="levels" aria-pressed="false">All levels</button>
          <button type="button" data-zoom="wide" aria-pressed="false">±2 daily ATR</button>
        </div>
      </div>
      <div class="legend" aria-hidden="true">
        <span><i class="k-line k-price"></i>Last price</span>
        <span><i class="k-star">★</i>Decision level</span>
        <span><i class="k-line"></i>Alert level</span>
        <span><i class="k-dot k-long"></i>Long targets</span>
        <span><i class="k-dot k-short"></i>Short targets</span>
        <span><i class="k-zone"></i>Thin zone / risk</span>
      </div>
      <div class="map-wrap"><svg id="map" role="img" aria-label="Price map"></svg><div class="tip" id="tip" hidden></div></div>
      <p class="map-note">Hover a line for its source; click an alert level to plan it. Every level is also in the <a href="#price-map">Price map</a> tables.</p>
    </div>
    <div class="card plan-card">
      <div class="card-head"><h2>Trade planner</h2><span class="sub">${esc(String(r.alerts.length))} alert levels</span></div>
      <div class="lvls" id="lvls" role="listbox" aria-label="Alert levels"></div>
      <div class="plan-ctl">
        <div class="seg" id="dirSeg" role="group" aria-label="Direction">
          <button type="button" data-dir="long">▲ Long</button>
          <button type="button" data-dir="short">▼ Short</button>
          <button type="button" data-dir="both">Both</button>
        </div>
        <span class="note">R measured from the level — your fill is the confirming 30-min close.</span>
      </div>
      <div id="planOut"></div>
      <div class="popup" id="popupBox">
        <div class="popup-head"><span>Alert text</span><button type="button" class="btn" id="copyBtn">Copy</button></div>
        <pre id="popupText"></pre>
      </div>
    </div>
  </div>
</section>` : "";

  const ranked = r.scenarios.length ? `
<section class="scen" id="ranked">
  <div class="card">
    <div class="card-head"><h2>Ranked scenarios</h2><span class="sub">best first · ★ = today's A+ level</span></div>
    <div class="rank-tabs" id="rankTabs" role="tablist" aria-label="Scenarios"></div>
    <div id="rankOut"></div>
  </div>
</section>` : "";

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(key)} price map — ${esc(date)}</title>
<script>if (window.self !== window.top) document.documentElement.classList.add("framed");</script>
<link rel="stylesheet" href="../assets/report.css?v=${ASSET_V}">
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
  <p>${gloss(inline(r.primary || "—"))}</p>
  ${r.notes.length ? `<div class="notes">${md(r.notes.join("\n\n"))}</div>` : ""}
</section>
${pre}
${desk}
${ranked}
${body}
<footer>Built from ${esc(mdName)} · ${new Date().toISOString().slice(0, 16).replace("T", " ")} UTC</footer>
</div>
<script type="application/json" id="report-data">${JSON.stringify(data).replace(/</g, "\\u003c")}</script>
<script src="../assets/report.js?v=${ASSET_V}"></script>
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
const assets = join(ROOT, "futures", "assets");
mkdirSync(assets, { recursive: true });
for (const f of ["report.css", "report.js"]) copyFileSync(join(ROOT, "tools", "report", f), join(assets, f));
// GitHub Pages lets browsers cache files for 10 minutes. Versioning the asset URLs by content
// means a freshly built page never runs against a stale cached script, while unchanged
// assets keep the same URL.
const ASSET_V = createHash("sha1").update(readFileSync(join(assets, "report.css")))
  .update(readFileSync(join(assets, "report.js"))).digest("hex").slice(0, 8);

const siblings = found.map(f => f.key).sort(sortProducts);

const built = {};
console.log(`Futures ${date} — ${longLabel(date)}`);
for (const f of found){
  const r = parseReport(readFileSync(f.mdPath, "utf8"));
  // A ★ scenario with no "Favoured" line of its own takes the report's favoured side.
  r.scenarios.forEach(s => { if (s.star && !s.favoured && r.favoured) s.favoured = r.favoured; });
  const out = join(outDir, `${f.key}.html`);
  writeFileSync(out, page(r, f.key, siblings, basename(f.mdPath)), "utf8");
  const charts = chartsFor(f.key).length;
  const branches = r.scenarios.flatMap(s => s.branches);
  built[f.key] = {
    file: `${f.key}.html`, symbol: r.ticker || f.sym, name: r.desc, snapshot: r.snapDate,
    last: r.last != null ? r.last.toFixed(r.decimals) : "", star: r.star, favoured: r.favoured || null,
    bias: r.biasShort || null, charts,
  };
  const nL = branches.filter(b => b.dir === "LONG").length, nS = branches.length - nL;
  console.log(`  ${f.key}.html  (${Math.round(statSync(out).size / 1024)} KB) — ${r.ladder.length} rungs, ` +
    `${r.alerts.length} alerts, ${r.scenarios.length} scenarios / ${branches.length} branches (${nL} long, ${nS} short), ` +
    `${charts} chart${charts === 1 ? "" : "s"}`);
  // Loud warnings for the things that silently degrade a page when the report format drifts.
  if (!r.alerts.length) console.warn(`    ! no alert table parsed for ${f.key} - the map and planner are left out`);
  if (!r.star) console.warn(`    ! no ★ level found in the Primary setup for ${f.key}`);
  if (r.atr30 == null || r.atrD == null) console.warn(`    ! ATR not found for ${f.key} (30-min ${r.atr30}, daily ${r.atrD})`);
  const noStop = branches.filter(b => b.stop == null).length, noEntry = branches.filter(b => b.entry == null).length;
  if (branches.length && (noStop || noEntry)) console.warn(`    ! ${f.key}: ${noEntry} branch(es) without an entry, ${noStop} without a stop`);
  if (branches.length && (!nL || !nS)) console.warn(`    ! ${f.key}: every scenario branch parsed as ${nL ? "LONG" : "SHORT"} - check the scenario format`);
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
Object.keys(merged).sort(sortProducts).forEach(k => { products[k] = merged[k]; });

const day = { id: date, label: longLabel(date), products };
const all = days.filter(d => d.id !== date).concat(day).sort((a, b) => String(b.id).localeCompare(String(a.id)));

writeFileSync(mfPath,
  "window.FUTURES_MANIFEST = {\n  \"days\": [\n" +
  all.map(d => "    " + JSON.stringify(d)).join(",\n") +
  "\n  ]\n};\n", "utf8");
console.log(`  manifest.js updated — ${all.length} day${all.length === 1 ? "" : "s"} listed`);
