// Build the futures price-map pages for one report date.
//
//   node tools/build-futures.mjs --date 2026-09-15
//        [--src C:\Users\VINHSANH\.claude\tradingview\reports] [--symbols ES1,NQ1,GC1]
//
// Reads <SYM>-structured-<date>.md, writes futures/<date>/<KEY>.html, copies the
// shared page script and styles to futures/assets/, and upserts the day into
// futures/manifest.js.
//
// Besides rendering the markdown, it lifts the numbers the interactive parts
// need - the two ladders, the alert table and the ranked scenarios - into a
// JSON block on the page. Anything it cannot parse is simply left out of the
// map; the report text is always rendered in full, and the console warns.
//
// The report template has changed twice; all three shapes are read:
//   to 2026-09-13  "# Symbol: ES1! (...)", "**Primary setup:**", "**Trigger:**",
//                  prose branches with "entry ~x ... stop ~x ... R:R n"
//   2026-09-14     "**Level <p>**" + "FROM BELOW: REJECT -> SHORT T1 .. SL .."
//   from 2026-09-15 "# ES1! — Structured Market Analysis", "## Section N — ...",
//                  "### ★ RANK 1 — <p> · name", "Hold from above -> LONG T1 .. SL .."
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
    const cls = /^PASS-THROUGH/.test(t) ? "k-pass" : /^(TARGET|PIVOT)/.test(t) ? "k-tgt" : "";
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

// Sections whose full text opens by default.
const isTakeaway = title => /final takeaway/i.test(title) || /^section\s+\d+\s*[—–-]\s*summary/i.test(title);

function tocLabel(title){
  const map = [
    [/⛔|read this first/i, "⛔ Read first"],
    [/scorecard/i, "Scorecard"], [/long-term/i, "Long-term"], [/daily trend/i, "Trend & vol"],
    [/key price map/i, "Price map"], [/5-minute/i, "5-min tape"], [/market profile context/i, "Profile"],
    [/auction intent/i, "Auction"], [/market structure/i, "Structure"], [/forward scenarios/i, "Full scenarios"],
    [/final takeaway/i, "Takeaway"], [/^alerts/i, "Alerts"], [/skill changes/i, "Skill changes"],
    // from 2026-09-15
    [/scoring|step\s*[−–-]\s*1/i, "Scorecard"], [/multi-timeframe/i, "Structure"],
    [/level inventory/i, "Price map"], [/ranked scenarios/i, "Full scenarios"],
    [/alerts set/i, "Alerts"], [/summary/i, "Takeaway"],
  ];
  for (const [re, label] of map) if (re.test(title)) return label;
  const p = title.replace(/^(?:section\s+[\d.]+|step\s*[−–-]?\s*\d+)\s*[—–-]\s*/i, "")
                 .replace(/^\d+(\.\d+)?[a-z]?\.\s*/i, "").replace(/[*`]/g, "");
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

// Ladder tables are "# | Level | Source | Class" (to 09-14) or "Price | Source | Tag" (from 09-15).
function parseLadders(bodyMd){
  const rungs = [];
  for (const c of chunks(bodyMd)){
    if (!c.title) continue;
    const side = /UPSIDE LADDER/i.test(c.title) ? "up" : /DOWNSIDE LADDER/i.test(c.title) ? "down" : null;
    if (!side) continue;
    for (const t of tables(c.body)){
      const col = re => t.head.findIndex(h => re.test(plain(h)));
      const iP = col(/^(level|price)$/i), iS = col(/^source/i), iC = col(/^(class|tag)$/i);
      if (iP < 0 || iC < 0) continue;
      for (const r of t.rows){
        if (r.length <= Math.max(iP, iC)) continue;
        const p = (plain(r[iP]).match(/\d{3,}(?:\.\d+)?/g) || []).map(Number);
        if (!p.length) continue;
        const cls = plain(r[iC]);
        rungs.push({
          side, p, src: iS >= 0 ? plain(r[iS]) : "",
          cls: /^PASS/i.test(cls) ? "pass" : /^STOP/i.test(cls) ? "stop" : "target",
          dec: /\*\*/.test(r[iP]) || /decision|★/i.test(cls) || /^(?:★\s*)?PIVOT\b/i.test(cls),
        });
      }
    }
  }
  return rungs;
}

function parseAlerts(sections){
  const sec = sections.find(s => s.title && /alerts/i.test(s.title));
  const t = sec && tables(sec.md).find(x => x.head.length >= 5);
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
//   "Hold from above → LONG T1 <p> · T2 <p> · T3 <p> · SL <p>"
// or two on one line after a level -
//   "7834.25 — last lower high. BREAK → backtest → LONG T1 … SL <p> · REJECT → SHORT T1 … SL <p>".
// The direction is the word itself, never inferred from where T1 sits.
function parseLevelBranches(body, level){
  const out = [];
  for (const line of body.split("\n")){
    if (!/^- /.test(line)) continue;
    const t = plain(line.slice(2));
    const hits = [...t.matchAll(/\b(LONG|SHORT)\b(?::|\s)[^·;]{0,40}?(?=\bT1\b)/g)];
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
        targets,
        runner: (r => r ? Number(r[1]) : null)(/\brunner\s*~?\s*(\d{3,}(?:\.\d+)?)/i.exec(seg.slice(0, numsEnd))),
        stop: sl ? Number(sl[1]) : null, rr: null,
      });
    });
  }
  return out;
}

// The rewritten 2026-09-15 reports: a branch is a block of bullets -
//   "Trigger (with-trend): …", "Entry: short ≈ 7654", "Target: T1 … · runner …",
//   "Stop Loss: tactical 7666.00 …", "R:R: T1 0.54 …"
// - separated by blank lines, plus alert-style one-liners ("If it BREAKS instead … → LONG T1 …
// · tactical SL …"), some indented under a level bullet ("7540.25 / 7541.75 — the six-year shelf").
const groupedStyle = body => /^- \*\*Trigger\b/m.test(body) ||
  body.split("\n").some(l => /^\s+- /.test(l) && /\b(?:LONG|SHORT):?\s+T1\b/.test(plain(l)));

function parseGroupedBranches(body, level, headDir){
  const out = [];
  let group = [], parent = null;
  const fieldOf = t => (/^(Trigger|Entry|Target|Stop Loss|R:R)\b[^:]*:/i.exec(t) || [])[1];

  // "Max-chase: do not enter above 7728.50" is a limit on chasing, not the entry price.
  const noChase = s => s.replace(/\bmax[-\s]?chase\b.*$/i, "").trim();
  // One leg of a fork: the text from "(a)" (or "(a —") up to the next such marker.
  const leg = (text, tag) => {
    if (!tag) return text;
    const m = new RegExp("\\(\\s*" + tag + "\\s*[)—–-]", "i").exec(text);
    if (!m) return text;
    const rest = text.slice(m.index + m[0].length);
    const next = /\(\s*[a-z]\s*[)—–-]/i.exec(rest);
    return next ? rest.slice(0, next.index) : rest;
  };

  const flush = () => {
    if (!group.length) return;
    const get = name => (group.find(g => g.field.toLowerCase() === name) || {}).text || "";
    const trigT = get("trigger"), entryT = get("entry"), stopT = get("stop loss"), rrT = get("r:r");
    const targetTs = group.filter(g => g.field.toLowerCase() === "target").map(g => g.text);
    group = [];
    if (!entryT || !targetTs.length) return;
    // A two-edge fade ("long ≈ 7626 / short ≈ 7696") describes a range, not one trade.
    if (/\blong\b/i.test(entryT) && /\bshort\b/i.test(entryT)) return;

    for (const targetT of targetTs){
      // "Target (a — acceptance → LONG):" - the other bullets label their halves the same way.
      const tag = targetTs.length > 1 ? (/^Target\s*\(\s*([a-z])\b/i.exec(targetT) || [])[1] : null;
      const seen = new Set();
      const targets = [...targetT.matchAll(/\bT([1-9])\s*~?\s*(\d{3,}(?:\.\d+)?)/g)]
        .filter(m => !seen.has(m[1]) && seen.add(m[1]))
        .map(m => ({ k: "T" + m[1], p: Number(m[2]) }))
        .sort((a, b) => a.k.localeCompare(b.k));
      if (!targets.length) continue;
      const entryLeg = noChase(leg(entryT, tag));
      const entry = firstPrice(entryLeg.replace(/^Entry[^:]*:/i, ""));
      const runner = /\brunner\s*~?\s*(\d{3,}(?:\.\d+)?)/i.exec(targetT);
      const stopLeg = leg(stopT, tag);
      const tactical = /tactical\s*~?\s*(\d{3,}(?:\.\d+)?)/i.exec(stopLeg);
      const stop = tactical ? Number(tactical[1]) : firstPrice(stopLeg.replace(/^Stop Loss[^:]*:/i, ""));
      const rrLeg = leg(rrT, tag).replace(/^R:R[^:]*:/i, "");
      let rr = /T1\s*(\d+(?:\.\d+)?)(?![\d.]|\s*÷)/.exec(rrLeg);
      // 09-19 shows the arithmetic instead: "to T1 off the stop = 62.25 ÷ 62.00 = 1.00 ✅
      // — T2 = 1.94R …". The ratio is the last "= n" of the T1 clause, which ends at the
      // verdict mark, the next target or the runner.
      if (!rr){
        const i = rrLeg.search(/\bT1\b/);
        const clause = i < 0 ? "" : rrLeg.slice(i).split(/[⚠✅·]|\bT[2-9]\b|\brunner\b/i)[0];
        const eqs = [...clause.matchAll(/=\s*(\d+(?:\.\d+)?)/g)];
        if (eqs.length) rr = eqs[eqs.length - 1];
      }
      // The direction is the word on the Target leg ("→ LONG") or in the Entry line
      // ("short ≈ 7654"); fall back to where T1 sits relative to the level.
      const word = /(?:→|->)\s*\**\s*(LONG|SHORT)/i.exec(targetT) || /\b(long|short)\b/i.exec(entryLeg);
      let at = entry != null ? entry : level;
      const dir = word ? word[1].toUpperCase() : headDir ? headDir
                : at != null && targets[0].p < at ? "SHORT" : "LONG";
      if (headDir && !word && entry != null && level != null &&
          (dir === "SHORT" ? targets[0].p >= entry : targets[0].p <= entry)) at = level;
      const q = /^Trigger\s*\(([^)]*)\)/i.exec(trigT);
      let label = trigT.replace(/^Trigger[^:]*:\s*/i, "");
      if (q) label = q[1].charAt(0).toUpperCase() + q[1].slice(1) + " — " + label;
      const half = tag && (/^Target\s*\(([^)]*)\)/i.exec(targetT) || [])[1];
      if (half) label = half.replace(/^[a-z]\s*[—–-]\s*/i, "").trim() + " — " + label;
      if (label.length > 120) label = label.slice(0, 117) + "…";
      out.push({ label: label || "On the trigger", dir, entry: at, targets,
        runner: runner ? Number(runner[1]) : null, stop, rr: rr ? Number(rr[1]) : null });
    }
  };

  for (const raw of body.split("\n")){
    const top = /^- /.test(raw), nested = /^\s+- /.test(raw);
    if (!top && !nested){ if (!raw.trim()) flush(); continue; }
    const t = plain(raw.replace(/^\s*- /, ""));
    const field = top ? fieldOf(t) : null;
    if (field){ group.push({ field, text: t }); continue; }
    flush();
    const alertLine = /\b(?:LONG|SHORT)\b(?::|\s)[^·;]{0,40}?\bT1\b/.test(t);
    if (top){
      // A level bullet heads the indented alert-style lines beneath it.
      const head = /^(\d{3,}(?:\.\d+)?)(?:\s*\/\s*[\d.]+)*\s*—\s*[^(.]*/.exec(t);
      parent = head && !alertLine ? { price: Number(head[1]), head: head[0].trim() } : null;
    }
    if (!alertLine) continue;
    const ctx = nested ? parent : null;
    for (const b of parseLevelBranches("- " + t, ctx ? ctx.price : level)){
      if (ctx) b.label = ctx.head + " · " + b.label;
      out.push(b);
    }
  }
  flush();
  return out;
}

function parseScenarios(sections){
  const sec = sections.find(s => s.title && /(forward|ranked) scenarios/i.test(s.title));
  if (!sec) return [];
  const out = [];
  for (const c of chunks(sec.md)){
    if (!c.title) continue;
    // "🥇 RANK 1 — [S2/S5] name ★" (to 09-14) or "★ RANK 1 — 7656.25 · name" (from 09-15)
    const emoji = RANKS.findIndex(r => c.title.startsWith(r));
    const numbered = /^★?\s*RANK\s+(\d+)\b/i.exec(plain(c.title));
    if (emoji < 0 && !numbered) continue;
    const rank = emoji >= 0 ? emoji + 1 : Number(numbered[1]);
    const title = plain(c.title);
    const slot = (/\[([^\]]+)\]/.exec(title) || [])[1] || "";
    let name = slot ? title.slice(title.indexOf("]") + 1)
                    : title.replace(/^.*?RANK\s*\d+\s*[—–-]\s*/i, "");
    name = name.replace(/★/g, "").trim();

    const trig = /^\*\*Trigger:\*\*\s*(.+)$/m.exec(c.body);
    const lvl = /^\*\*Level\s+(\d{3,}(?:\.\d+)?)[.*]*\s*(.*)$/m.exec(c.body);
    const why = /^\*\*Why[^*]*:\*\*\s*(.+)$/m.exec(c.body);
    const fav = /Favou?red(?: branch)?[^:]*:\s*(LONG|SHORT)/i.exec(plain(c.body));
    const triggerText = trig ? plain(trig[1]) : lvl ? plain("Level " + lvl[1] + " " + lvl[2]) : "";
    // From 09-15 the level is in the heading and the lead paragraph replaces "Why".
    // The level can live in the heading: "RANK 1 — [S1] Thursday's VAH ★ 7711.50 …"
    // (from 09-17) or "★ RANK 1 — 7656.25 · …" (09-15).
    const headingStar = (/★\s*([\d,]+(?:\.\d+)?)/.exec(title) || [])[1];
    const headingLevel = headingStar ? Number(headingStar.replace(/,/g, ""))
                       : firstPrice(title.replace(/RANK\s*\d+/i, "").replace(/\[[^\]]*\]/g, ""));
    let whyText = why ? plain(why[1]) : "";
    if (!whyText && !trig && !lvl){
      const lead = c.body.split(/\n\s*\n/).find(b => b.trim() && !/^[-|>]/.test(b.trim())) || "";
      whyText = plain(lead.split("\n").filter(l => !/^\s*-/.test(l)).join(" "));
    }

    out.push({
      rank, slot, name, star: c.title.includes("★"),
      trigger: triggerText, why: whyText,
      favoured: fav ? fav[1].toUpperCase() : null,
      branches: (() => {
        const at = lvl ? Number(lvl[1]) : headingLevel != null ? headingLevel : triggerText ? firstPrice(triggerText) : null;
        // "30146.50 / 30155.75 BREAKS → SHORT" - only when the heading names one side.
        const hd = [...title.matchAll(/→\s*(LONG|SHORT)\b/g)].map(m => m[1]);
        const headDir = hd.length && hd.every(d => d === hd[0]) ? hd[0] : null;
        if (groupedStyle(c.body)) return parseGroupedBranches(c.body, at, headDir);
        if (/\b(?:LONG|SHORT):?\s+T1\b/.test(plain(c.body))) return parseLevelBranches(c.body, at);
        return parseBranches(c.body, triggerText ? firstPrice(triggerText) : null, triggerText.length > 70 ? "" : triggerText);
      })(),
    });
  }
  return out.sort((a, b) => a.rank - b.rank);
}

// From 09-15 there is no "**Primary setup:**" line; build the callout from the ★ scenario
// using only its own words and numbers.
function synthPrimary(scenarios, decimals){
  const s = scenarios.find(x => x.star) || scenarios[0];
  if (!s || !s.branches.length) return "";
  const lvl = s.branches[0].entry;
  // The 09-15 headings start with the level itself ("7656.25 · HVN 920K …"); don't repeat it.
  const nm = s.name.replace(/^\s*[\d.,]+\s*[·—–-]\s*/, "");
  const head = "★ `" + (lvl != null ? lvl.toFixed(decimals) : s.name) + "` — " + nm + ".";
  const legs = s.branches.map(b => {
    const t = b.targets.map(x => x.k + " " + x.p.toFixed(decimals)).join(" · ");
    return " " + b.label + " → **" + b.dir + "** " + t + (b.stop != null ? " · SL " + b.stop.toFixed(decimals) : "") + ".";
  }).join("");
  return head + (s.why ? " " + s.why : "") + legs;
}

// ---------- report parsing ----------

function parseReport(text){
  text = text.replace(/\r\n/g, "\n");
  const lines = text.split("\n");
  let i = 0;
  while (i < lines.length && !lines[i].trim()) i++;

  // "# Symbol: ES1! (E-mini S&P 500 · CME)" or "# ES1! — Structured Market Analysis"
  const head = /^#\s*Symbol:\s*(\S+)\s*(?:\((.*)\))?\s*$/.exec(lines[i] || "");
  const headNew = head ? null : /^#\s*(\S+)\s*[—–-]\s*(.*)$/.exec(lines[i] || "");
  const ticker = head ? head[1] : headNew ? headNew[1] : "";
  let desc = head ? (head[2] || "") : "";
  if (head || headNew) i++;

  const rest = lines.slice(i).join("\n");
  // The header block runs to the "---" rule - but 09-19 dropped that rule and put one
  // inside section 6 instead, so the first "## " heading ends the header just as well.
  const rule = rest.search(/^---\s*$/m);
  const firstSec = rest.search(/^## /m);
  const hr = rule >= 0 && (firstSec < 0 || rule < firstSec) ? rule : firstSec;
  const headMd = hr >= 0 ? rest.slice(0, hr) : "";
  const bodyMd = hr >= 0 ? rest.slice(hr).replace(/^---\s*\n/, "") : rest;

  const metaLine = re => { const m = re.exec(headMd); return m ? m[1].trim() : ""; };
  const planFor = metaLine(/^\*\*Plan for:\*\*\s*(.+)$/m);
  const lastLine = metaLine(/^\*\*Last:\*\*\s*(.+)$/m);
  const contract = metaLine(/^\*\*Contract:\*\*\s*(.+)$/m);
  const scored = metaLine(/^\*\*Session scored:\*\*\s*(.+)$/m);

  let snapshot = "", primary = "";
  const notes = [];
  for (const block of headMd.split(/\n\s*\n/)){
    const b = block.trim();
    if (!b) continue;
    if (/^Snapshot:/i.test(b)){ snapshot = b.replace(/^Snapshot:\s*/i, ""); continue; }
    if (/^\*\*Primary setup:\*\*/i.test(b)){ primary = b.replace(/^\*\*Primary setup:\*\*\s*/i, ""); continue; }
    // The newer metadata block: keep it as a note, minus the two lines shown in the header.
    const keep = b.split("\n").filter(l => !/^\*\*(Plan for|Last):\*\*/i.test(l)).join("\n").trim();
    if (keep) notes.push(keep);
  }
  if (!snapshot){
    snapshot = [planFor && "Plan for " + planFor, lastLine && "Last " + lastLine].filter(Boolean).join(" · ");
  }
  if (!desc && contract) desc = contract.replace(/\.\s*Roll.*$/i, "").trim();

  const sections = [];
  for (const part of bodyMd.split(/^(?=## )/m)){
    if (!part.trim()) continue;
    const m = /^## (.*)\n?/.exec(part);
    const body = (m ? part.slice(m[0].length) : part).replace(/^-{3,}\s*$/gm, "");
    sections.push({ title: m ? m[1].trim() : null, md: body });
  }

  const lastStr = (/Last \*\*([\d.,]+)\*\*/.exec(snapshot) || [])[1] ||
                  (/^\*\*Last:\*\*\s*\**([\d.,]+)/m.exec(headMd) || [])[1] || "";
  const flat = plain(bodyMd);
  const num = re => { const m = re.exec(flat); return m ? Number(m[1].replace(/,/g, "")) : null; };

  // "**Current bias:** …", "**Bias:** …" or "**Bias: … .**"
  const biasLine = (bodyMd.split("\n").find(l => /^\s*[-*>]?\s*\*{0,2}(current bias|bias)\*{0,2}\s*:/i.test(l)) || "");
  // Drop the list/quote marker first ("- **Current bias:** …"), then the label.
  const biasFull = plain(biasLine).replace(/^[-*>\s]+/, "").replace(/^(current bias|bias)\s*:\s*/i, "").replace(/\s*$/, "");
  // A shouted word is the whole bias ("UP short-term"); 09-19 writes a sentence instead
  // ("Bullish inside a balance, with a hard ceiling at 7752.50."), so keep its first clause.
  const biasHead = biasFull.replace(/^[^A-Za-z]+/, "");
  let biasShort = (/^([A-Z]{2,}(?:-to-[A-Z]+)?)(?![a-z])(?:\s+(?:short|long)-term)?(,\s*leaning\s+\w+)?/.exec(biasHead) || [])[0] || "";
  if (!biasShort && biasHead){
    biasShort = biasHead.split(/\s+[—–-]\s+|(?<=\.)\s|\.\s/)[0].replace(/\.$/, "");
    if (biasShort.length > 46) biasShort = biasShort.split(",")[0].trim();
    if (biasShort.length > 46) biasShort = biasShort.slice(0, 44) + "…";
  }

  const decimals = lastStr.includes(".") ? lastStr.split(".")[1].length : 0;
  const scenarios = parseScenarios(sections);

  return {
    ticker, desc, snapshot, notes, sections, scenarios,
    primary: primary || synthPrimary(scenarios, decimals),
    primarySynth: !primary,
    last: lastStr ? Number(lastStr.replace(/,/g, "")) : null,
    decimals,
    // "★ two-sided `DECISION> 7665.25`" / "★ `7715.00`" / "### ★ RANK 1 — 7656.25 · …"
    star: (/★[^`]*`(?:DECISION>\s*)?([\d.,]{3,})`/.exec(primary) || [])[1] ||
          ((scenarios.find(s => s.star) || {}).branches || []).reduce((v, b) => v || (b.entry != null ? String(b.entry) : ""), "") || "",
    // "favoured LONG", or on a Rule 5 = 3/3 day "directional LONG".
    favoured: ((/(?:favou?red(?:\s+branch)?|directional)\s+\**\s*(LONG|SHORT)/i.exec(primary) || [])[1] || "").toUpperCase(),
    // Newer reports name the session they scored; older ones lead the Snapshot line with it.
    snapDate: scored ? plain(scored).replace(/\s*\(.*$/, "")
                     : plain((/^(.+?)(?:,|\s·)/.exec(snapshot) || [])[1] || ""),
    biasFull, biasShort,
    // "30-min ATR ≈ 18.85" or "30-min ATR = 0.28 × 66.50 = **18.62**"
    atr30: num(/30-min ATR\s*=\s*[\d.]+\s*×\s*[\d.,]+\s*=\s*([\d,]+(?:\.\d+)?)/) ||
           num(/30-min ATR\s*(?:≈|~|=)\s*([\d,]+(?:\.\d+)?)/),
    // "ATR condition: 72.25 …", "ATR: 67.25 …" or "ATR 66.50."
    atrD: num(/\bATR(?: condition)?:\s*([\d,]+(?:\.\d+)?)/) || num(/\bATR\s+([\d,]+(?:\.\d+)?)\b/),
    ladder: parseLadders(bodyMd),
    alerts: parseAlerts(sections),
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

function renderSection(body, prefix, seen, plainRanks){
  let html = "";
  for (const c of chunks(body)){
    if (!c.title){ if (c.body.trim()) html += md(c.body); continue; }
    const h3 = `<h3 id="${uniq(prefix + "-" + slug(c.title), seen)}">${inline(c.title)}</h3>`;
    const inner = md(c.body);
    if (plainRanks){ html += `<div class="sub">${h3}${inner}</div>`; continue; }
    const emoji = RANKS.findIndex(r => c.title.startsWith(r));
    const numbered = /^★?\s*RANK\s+(\d+)\b/i.exec(plain(c.title));
    const rank = emoji >= 0 ? emoji + 1 : numbered ? Number(numbered[1]) : 0;
    html += rank
      ? `<article class="rank${c.title.includes("★") ? " star" : ""}" data-rank="${rank}">${h3}${inner}</article>`
      : `<div class="sub">${h3}${inner}</div>`;
  }
  return html;
}

const HINTS = [
  [/key price map|level inventory/i, "full ladders, profile tables, naked levels"],
  [/(forward|ranked) scenarios/i, "all six in full"],
  [/alerts/i, "repeating level alerts"],
  [/scorecard|scoring/i, "how yesterday's plan did"],
];

// The weekend run adds a cross-symbol summary alongside the three product maps.
const PROD_LABEL = { SUM: "Summary" };
const sibNav = (siblings, key) => siblings.map(k =>
  `<a href="${k}.html"${k === key ? ' aria-current="page"' : ""}>${esc(PROD_LABEL[k] || k)}</a>`).join("");

// The TOC behaviour report.js adds; the summary page has no map, so it ships this alone.
const TOC_JS = `
(function(){
  function open(el){ if (el && el.tagName === "DETAILS") el.open = true; }
  Array.prototype.forEach.call(document.querySelectorAll(".toc a"), function(a){
    a.addEventListener("click", function(){ open(document.getElementById(a.getAttribute("href").slice(1))); });
  });
  function fromHash(){ if (location.hash) open(document.getElementById(location.hash.slice(1))); }
  window.addEventListener("hashchange", fromHash);
  fromHash();
})();`;

// watchlist-summary-<date>.md: one page, no price map - it is about all three products.
function summaryPage(text, siblings, mdName, products){
  const seen = new Set(["primary"]);
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  let i = 0;
  while (i < lines.length && !lines[i].trim()) i++;
  const title = /^#\s+(.*)$/.exec(lines[i] || "");
  if (title) i++;
  const rest = lines.slice(i).join("\n");
  const cut = rest.search(/^## /m);
  const head = (cut >= 0 ? rest.slice(0, cut) : rest).replace(/^-{3,}\s*$/gm, "").trim();

  const secs = [];
  for (const part of (cut >= 0 ? rest.slice(cut) : "").split(/^(?=## )/m)){
    if (!part.trim()) continue;
    const m = /^## (.*)\n?/.exec(part);
    if (!m) continue;
    secs.push({ title: m[1].trim(), md: part.slice(m[0].length).replace(/^-{3,}\s*$/gm, "") });
  }

  const kpis = Object.keys(products).map(k => {
    const p = products[k];
    const fav = p.favoured === "LONG" ? "▲ LONG" : p.favoured === "SHORT" ? "▼ SHORT" : "—";
    return `<div class="kpi${p.star ? " star" : ""}"><span>${esc(k)}${p.star ? " ★ " + esc(String(p.star)) : ""}</span>` +
      `<b class="${p.favoured ? "d-" + p.favoured : "txt"}">${esc(fav)}</b>` +
      `${p.bias ? `<small>${esc(p.bias)}</small>` : ""}</div>`;
  }).join("");

  // The ranking and the one observation behind it are the point of the page: open them.
  const lead = t => /easy to happen|most likely|one paragraph|one observation|decisions for you|correlation cap|rule 4/i.test(t);
  const urgent = t => /⛔|read this first/i.test(t);
  const toc = [], body = [];
  for (const s of secs){
    const id = uniq(slug(tocLabel(s.title)), seen);
    const open = lead(s.title) || urgent(s.title);
    toc.push(`<a href="#${id}">${esc(tocLabel(s.title))}</a>`);
    body.push(`<details class="sec${urgent(s.title) ? " urgent" : ""}" id="${id}"${open ? " open" : ""}>` +
      `<summary><h2>${inline(s.title)}</h2></summary>` +
      `<div class="sec-body">${gloss(renderSection(s.md, id, seen, true))}</div></details>`);
  }

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Watchlist summary — ${esc(date)}</title>
<script>if (window.self !== window.top) document.documentElement.classList.add("framed");</script>
<link rel="stylesheet" href="../assets/report.css?v=${ASSET_V}">
</head>
<body>
<div class="wrap">
<header class="top">
  <div class="crumbs">
    <a href="../../index.html#futures/${date}/SUM">Trading Plans</a><span>/</span><span>Futures · ${esc(longLabel(date))}</span>
    <nav class="sib" aria-label="Products">${sibNav(siblings, "SUM")}</nav>
  </div>
  <h1>${esc(title ? title[1].replace(/\s*—.*$/, "") : "Watchlist summary")}<span class="desc">${esc(Object.keys(products).filter(k => k !== "SUM").join(" · "))}</span></h1>
  ${kpis ? `<div class="kpis">${kpis}</div>` : ""}
</header>
<nav class="toc" aria-label="Sections">${toc.join("")}</nav>
${head ? `<section class="primary" id="primary"><div class="lbl">This run</div>${gloss(md(head))}</section>` : ""}
${body.join("\n")}
<footer>Built from ${esc(mdName)} · ${new Date().toISOString().slice(0, 16).replace("T", " ")} UTC</footer>
</div>
<script>${TOC_JS}</script>
</body>
</html>
`;
}

function page(r, key, siblings, mdName){
  const seen = new Set(["primary", "desk", "ranked", "charts"]);
  const sign = n => (n > 0 ? "+" : n < 0 ? "−" : "") + Math.abs(n).toFixed(r.decimals);
  const starN = r.star ? Number(String(r.star).replace(/,/g, "")) : null;
  const favTxt = r.favoured === "LONG" ? "▲ LONG" : r.favoured === "SHORT" ? "▼ SHORT" : "";

  const starSub = starN != null && r.last != null
    ? `<small>${sign(starN - r.last)} from last${r.atr30 ? " · " + (Math.abs(starN - r.last) / r.atr30).toFixed(2) + "× 30m ATR" : ""}</small>` : "";
  const kpis = [
    r.last != null && `<div class="kpi"><span>Last</span><b>${esc(r.last.toFixed(r.decimals))}</b>${r.atr30 ? `<small>30m ATR ${esc(r.atr30)}</small>` : ""}</div>`,
    starN != null && `<div class="kpi star"><span>★ Level</span><b>${esc(starN.toFixed(r.decimals))}</b>${starSub}</div>`,
    favTxt && `<div class="kpi"><span>Favoured branch</span><b class="d-${r.favoured}">${favTxt}</b></div>`,
    r.biasShort && `<div class="kpi"><span>Bias</span><b class="txt" title="${esc(r.biasFull)}">${esc(r.biasShort)}</b></div>`,
  ].filter(Boolean).join("");

  const interactive = r.alerts.length > 0;

  // A "read this first" notice (contract roll, event risk) sits above the map and starts open.
  const urgent = s => /⛔|read this first/i.test(s.title);
  // The summary leads the remaining collapsible sections and starts open; the rest keep report order.
  const secs = r.sections.filter(s => s.title);
  const take = secs.findIndex(s => isTakeaway(s.title));
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
    const html = `<details class="sec${u ? " urgent" : ""}" id="${id}"${u || isTakeaway(s.title) ? " open" : ""}>` +
      `<summary><h2>${inline(s.title)}</h2>${hint ? `<span class="hint">${esc(hint)}</span>` : ""}</summary>` +
      `<div class="sec-body">${gloss(renderSection(s.md, id, seen))}</div></details>`;
    (u ? tocPre : tocBody).push(`<a href="#${id}">${esc(tocLabel(s.title))}</a>`);
    if (u) pre += html; else body += html;
  }

  const toc = [`<a href="#primary">Setup</a>`].concat(tocPre);
  if (interactive) toc.push(`<a href="#desk">Map & planner</a>`);
  if (r.scenarios.length) toc.push(`<a href="#ranked">Scenarios</a>`);
  toc.push(...tocBody);

  const sib = sibNav(siblings, key);

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
  <div class="lbl">★ Primary setup${r.primarySynth ? " — from RANK 1" : ""}</div>
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

const summaryMd = join(srcDir, `watchlist-summary-${date}.md`);
const hasSummary = existsSync(summaryMd);
const siblings = found.map(f => f.key).concat(hasSummary ? ["SUM"] : []).sort(sortProducts);

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
  if (!r.scenarios.length) console.warn(`    ! no ranked scenarios parsed for ${f.key}`);
  if (!r.ladder.length) console.warn(`    ! no ladder rungs parsed for ${f.key} - the map has no levels`);
  if (!r.star) console.warn(`    ! no ★ level found for ${f.key}`);
  if (r.last == null) console.warn(`    ! no last price found for ${f.key}`);
  if (r.atr30 == null || r.atrD == null) console.warn(`    ! ATR not found for ${f.key} (30-min ${r.atr30}, daily ${r.atrD})`);
  const noStop = branches.filter(b => b.stop == null).length, noEntry = branches.filter(b => b.entry == null).length;
  if (branches.length && (noStop || noEntry)) console.warn(`    ! ${f.key}: ${noEntry} branch(es) without an entry, ${noStop} without a stop`);
  if (branches.length && (!nL || !nS)) console.warn(`    ! ${f.key}: every scenario branch parsed as ${nL ? "LONG" : "SHORT"} - check the scenario format`);
}

if (hasSummary){
  const out = join(outDir, "SUM.html");
  writeFileSync(out, summaryPage(readFileSync(summaryMd, "utf8"), siblings, basename(summaryMd), built), "utf8");
  built.SUM = {
    file: "SUM.html", symbol: "Watchlist summary", name: Object.keys(built).join(" · "),
    snapshot: date, last: "", star: "", favoured: null, bias: null, charts: 0,
  };
  console.log(`  SUM.html  (${Math.round(statSync(out).size / 1024)} KB) — cross-symbol summary`);
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
