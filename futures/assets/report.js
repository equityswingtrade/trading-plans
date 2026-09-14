/* Futures price-map pages: price map, trade planner, ranked scenarios.
   Reads the JSON in #report-data written by build-futures.mjs.
   Copied to futures/assets/ by the build. Every label goes in via textContent. */
(function(){
  "use strict";

  var dataEl = document.getElementById("report-data");
  if (!dataEl) return;
  var D;
  try { D = JSON.parse(dataEl.textContent); } catch (e) { return; }

  var NS = "http://www.w3.org/2000/svg";
  function $(id){ return document.getElementById(id); }
  function h(tag, cls, text){
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }
  function s(tag, attrs, text){
    var e = document.createElementNS(NS, tag);
    for (var k in attrs) e.setAttribute(k, attrs[k]);
    if (text != null) e.textContent = text;
    return e;
  }
  // A surface-coloured plate behind a label, so a line crossing its price stays behind the text.
  function plate(g, t){
    g.appendChild(t);
    var bb = t.getBBox();
    g.insertBefore(s("rect", { "class": "lbl-bg", x: bb.x - 3, y: bb.y - 1, width: bb.width + 6, height: bb.height + 2, rx: 3 }), t);
    return t;
  }
  var dec = D.decimals != null ? D.decimals : 2;
  function fmt(p){ return p == null || isNaN(p) ? "—" : Number(p).toFixed(dec); }
  function signed(n){ return (n > 0 ? "+" : n < 0 ? "−" : "") + Math.abs(n).toFixed(dec); }

  var alerts = D.alerts || [], ladder = D.ladder || [], scenarios = D.scenarios || [];
  var starIdx = 0;
  for (var i = 0; i < alerts.length; i++) if (alerts[i].star){ starIdx = i; break; }

  var fav = String(D.favoured || "").toLowerCase();
  var state = {
    level: starIdx,
    dir: fav === "long" || fav === "short" ? fav : "both",
    dirPinned: false,
    zoom: "plan",
    scen: null,      // { i: scenario index, b: branch index } while a branch is plotted
    rank: 0
  };

  // ---------- plan geometry ----------

  // The overlay currently drawn: either an alert level's LONG/SHORT plans or one scenario branch.
  function overlay(){
    if (state.scen){
      var sc = scenarios[state.scen.i], br = sc && sc.branches[state.scen.b];
      if (!br) return null;
      var t = br.targets.map(function(x){ return { k: x.k, p: x.p }; });
      if (br.runner != null) t.push({ k: "Run", p: br.runner });
      var entry = br.entry != null ? br.entry : (t.length ? null : null);
      return { level: entry, name: "RANK " + sc.rank, sides: [{ dir: br.dir.toLowerCase(), t: t, sl: br.stop }] };
    }
    var a = alerts[state.level];
    if (!a) return null;
    var sides = [];
    ["long", "short"].forEach(function(d){
      if ((state.dir === d || state.dir === "both") && a[d]){
        sides.push({ dir: d, t: a[d].t.map(function(p, n){ return { k: "T" + (n + 1), p: p }; }), sl: a[d].sl });
      }
    });
    return { level: a.level, name: a.name, sides: sides };
  }

  // "plan" fits the plan being read (plus last price) so its targets get room;
  // "levels" fits every alert plan; "wide" is last ± 2 daily ATR.
  function domain(ov){
    var ps = [D.last];
    var hasPlan = ov && ov.level != null && ov.sides.length > 0;
    if (state.zoom === "wide" && D.atrD){
      ps.push(D.last + 2 * D.atrD, D.last - 2 * D.atrD);
    } else if (state.zoom === "levels" || !hasPlan){
      alerts.forEach(function(a){
        ps.push(a.level);
        ["long", "short"].forEach(function(d){ if (a[d]){ ps = ps.concat(a[d].t); if (a[d].sl != null) ps.push(a[d].sl); } });
      });
    }
    if (hasPlan){
      ps.push(ov.level);
      ov.sides.forEach(function(sd){ sd.t.forEach(function(x){ ps.push(x.p); }); if (sd.sl != null) ps.push(sd.sl); });
    }
    ps = ps.filter(function(p){ return p != null && isFinite(p); });
    var lo = Math.min.apply(null, ps), hi = Math.max.apply(null, ps);
    var pad = Math.max((hi - lo) * 0.08, (D.atr30 || 1) * 0.5);
    return [lo - pad, hi + pad];
  }

  function niceStep(range, n){
    var raw = range / n, mag = Math.pow(10, Math.floor(Math.log10(raw))), f = raw / mag;
    return (f < 1.5 ? 1 : f < 2.25 ? 2 : f < 3.5 ? 2.5 : f < 7.5 ? 5 : 10) * mag;
  }

  // Push labels apart vertically, keeping order; returns adjusted y per item.
  function spread(items, gap, top, bottom){
    items.sort(function(a, b){ return a.y - b.y; });
    for (var i = 1; i < items.length; i++){
      if (items[i].ly - items[i - 1].ly < gap) items[i].ly = items[i - 1].ly + gap;
    }
    var over = items.length ? items[items.length - 1].ly - bottom : 0;
    if (over > 0){
      for (var j = items.length - 1; j >= 0; j--){
        items[j].ly -= over;
        if (j > 0 && items[j].ly - items[j - 1].ly >= gap) break;
        over = j > 0 ? items[j - 1].ly - (items[j].ly - gap) : 0;
        if (over <= 0) break;
      }
    }
    items.forEach(function(it){ if (it.ly < top) it.ly = top; });
    return items;
  }

  // ---------- price map ----------

  var svg = $("map"), wrap = svg && svg.parentNode, tip = $("tip");

  function showTip(evt, lines){
    if (!tip) return;
    tip.textContent = "";
    tip.appendChild(h("b", null, lines[0]));
    if (lines[1]) tip.appendChild(h("span", null, lines[1]));
    if (lines[2]) tip.appendChild(h("em", null, lines[2]));
    tip.hidden = false;
    var r = wrap.getBoundingClientRect();
    var x = evt.clientX - r.left + 14, y = evt.clientY - r.top + 12;
    var tw = tip.offsetWidth, th = tip.offsetHeight;
    if (x + tw > r.width) x = Math.max(0, evt.clientX - r.left - tw - 14);
    if (y + th > r.height) y = Math.max(0, evt.clientY - r.top - th - 12);
    tip.style.left = x + "px";
    tip.style.top = y + "px";
  }
  function hideTip(){ if (tip) tip.hidden = true; }

  function drawMap(){
    if (!svg) return;
    var W = Math.max(300, wrap.clientWidth);
    var H = W < 560 ? 540 : 660;
    var narrow = W < 520;
    var L = narrow ? 46 : 58, R = narrow ? 104 : 150, T = 12, B = 12;
    var x0 = L, x1 = W - R, pw = x1 - x0;
    var ov = overlay();
    var dom = domain(ov), lo = dom[0], hi = dom[1];
    function y(p){ return T + (hi - p) / (hi - lo) * (H - T - B); }
    function inDom(p){ return p >= lo && p <= hi; }

    svg.textContent = "";
    svg.setAttribute("viewBox", "0 0 " + W + " " + H);
    svg.setAttribute("width", W);
    svg.setAttribute("height", H);

    // axis
    var g = s("g", { "class": "axis" });
    g.appendChild(s("line", { x1: x0, x2: x0, y1: T, y2: H - B }));
    var step = niceStep(hi - lo, narrow ? 7 : 10), first = Math.ceil(lo / step) * step;
    var stepDec = step < 1 ? 2 : step % 1 ? 1 : 0;
    for (var p = first; p <= hi; p += step){
      g.appendChild(s("line", { x1: x0 - 4, x2: x0, y1: y(p), y2: y(p) }));
      g.appendChild(s("text", { x: x0 - 7, y: y(p) + 4, "text-anchor": "end" },
        Number(p.toFixed(stepDec)).toLocaleString("en-US", { minimumFractionDigits: stepDec, maximumFractionDigits: stepDec })));
    }
    svg.appendChild(g);

    // ladder rungs: magnets as hairlines, pass-through as faint bands
    var gl = s("g", {});
    ladder.forEach(function(r){
      var ps = r.p.filter(inDom);
      if (!ps.length) return;
      var top = y(Math.max.apply(null, ps)), bot = y(Math.min.apply(null, ps));
      if (r.cls === "pass"){
        gl.appendChild(s("rect", { "class": "zone", x: x0, width: pw, y: top - 3, height: Math.max(6, bot - top + 6) }));
      } else {
        ps.forEach(function(q){
          gl.appendChild(s("line", { "class": "rung" + (r.dec ? " dec" : ""), x1: x0, x2: x1, y1: y(q), y2: y(q) }));
        });
      }
      var hit = s("rect", { "class": "hit", x: x0, width: pw, y: top - 6, height: Math.max(12, bot - top + 12) });
      var label = r.p.map(fmt).join(" / ");
      var cls = r.cls === "pass" ? "Pass-through — price tends to move fast here" : r.cls === "stop" ? "Stop-class level" : "Target — a magnet, price tends to react";
      hit.addEventListener("pointermove", function(evt){ showTip(evt, [label, r.src, cls]); });
      hit.addEventListener("pointerleave", hideTip);
      gl.appendChild(hit);
    });
    svg.appendChild(gl);

    // right-gutter labels, collected then spread so they never collide
    var labels = [];

    // Paint order: rungs, then alert and price lines, then the plan's bands and markers,
    // then every plan label last - so no line or band ever covers a label.
    var ga = s("g", {});
    svg.appendChild(ga);
    var gov = s("g", {});
    svg.appendChild(gov);
    var govL = s("g", {});
    svg.appendChild(govL);
    if (ov && ov.level != null){
      var n = ov.sides.length;
      ov.sides.forEach(function(sd, idx){
        var cx = n === 1 ? x0 + pw * 0.5 : x0 + pw * (idx === 0 ? 0.33 : 0.67);
        var half = Math.min(46, pw * (n === 1 ? 0.22 : 0.14));
        var ts = sd.t.filter(function(x){ return x.p != null; });
        if (!ts.length) return;
        var far = ts[ts.length - 1].p;
        var yl = y(ov.level), yf = y(far);
        gov.appendChild(s("rect", { "class": "wash " + sd.dir, x: cx - half, width: half * 2, y: Math.min(yl, yf), height: Math.abs(yf - yl) }));
        if (sd.sl != null){
          var ys = y(sd.sl);
          gov.appendChild(s("rect", { "class": "zone", x: cx - half, width: half * 2, y: Math.min(yl, ys), height: Math.abs(ys - yl) }));
          gov.appendChild(s("line", { "class": "sl", x1: cx - half - 6, x2: cx + half + 6, y1: ys, y2: ys }));
        }
        gov.appendChild(s("line", { "class": "rail " + sd.dir, x1: cx, x2: cx, y1: yl, y2: yf }));
        gov.appendChild(s("circle", { "class": "mk-entry " + sd.dir, cx: cx, cy: yl, r: 5 }));
        var risk = sd.sl != null ? Math.abs(ov.level - sd.sl) : 0;
        var tl = ts.map(function(x){ return { y: y(x.p), ly: y(x.p), x: x }; });
        if (sd.sl != null) tl.push({ y: y(sd.sl), ly: y(sd.sl), sl: true });
        spread(tl, 14, T + 6, H - B - 2);
        tl.forEach(function(it){
          var tx = cx + half + 10;
          if (it.sl){
            plate(govL, s("text", { "class": "t-lbl", x: tx, y: it.ly + 4 }, "SL " + fmt(sd.sl)));
            return;
          }
          gov.appendChild(s("circle", { "class": "mk " + sd.dir, cx: cx, cy: it.y, r: 5 }));
          var t = s("text", { "class": "t-lbl", x: tx, y: it.ly + 4 }, it.x.k + " " + fmt(it.x.p));
          if (risk > 0){
            var rr = s("tspan", { "class": "t-r", dx: 5 }, (Math.abs(it.x.p - ov.level) / risk).toFixed(1) + "R");
            t.appendChild(rr);
          }
          plate(govL, t);
        });
        var up = far > ov.level;
        plate(govL, s("text", { "class": "side-lbl", x: cx, y: (up ? Math.min(yl, yf) - 8 : Math.max(yl, yf) + 16), "text-anchor": "middle" },
          sd.dir === "long" ? "▲ LONG" : "▼ SHORT"));
      });
    }

    // alert levels (clickable)
    alerts.forEach(function(a, idx){
      if (!inDom(a.level)) return;
      var sel = !state.scen && idx === state.level;
      ga.appendChild(s("line", { "class": "lvl-line" + (sel ? " sel" : ""), x1: x0, x2: x1, y1: y(a.level), y2: y(a.level) }));
      if (a.star) ga.appendChild(s("text", { x: x0 + 4, y: y(a.level) - 5 }, "★"));
      labels.push({ y: y(a.level), ly: y(a.level), kind: "lvl", a: a, sel: sel });
      var hit = s("rect", { "class": "hit-lvl", x: x0, width: pw, y: y(a.level) - 10, height: 20 });
      hit.addEventListener("click", function(){ selectLevel(idx); });
      hit.addEventListener("pointermove", function(evt){
        showTip(evt, [(a.star ? "★ " : "") + fmt(a.level) + " · " + a.name, "Alert level — click to plan it",
          "Long T1 " + fmt(a.long && a.long.t[0]) + " · Short T1 " + fmt(a.short && a.short.t[0])]);
      });
      hit.addEventListener("pointerleave", hideTip);
      ga.appendChild(hit);
    });

    // last price
    if (inDom(D.last)){
      ga.appendChild(s("line", { "class": "price-line", x1: x0, x2: x1, y1: y(D.last), y2: y(D.last) }));
      labels.push({ y: y(D.last), ly: y(D.last), kind: "price" });
    }

    spread(labels, 18, T + 8, H - B - 6);
    var gt = s("g", {});
    labels.forEach(function(it){
      var tx = x1 + 10;
      if (Math.abs(it.ly - it.y) > 1) gt.appendChild(s("path", { "class": "leader", d: "M" + x1 + " " + it.y + " L" + (x1 + 5) + " " + it.ly, fill: "none" }));
      if (it.kind === "price"){
        var txt = (narrow ? "" : "Last ") + fmt(D.last);
        var wpx = txt.length * 6.9 + 12;
        gt.appendChild(s("rect", { "class": "price-pill", x: tx - 4, y: it.ly - 9, width: wpx, height: 18, rx: 4 }));
        gt.appendChild(s("text", { "class": "price-txt", x: tx + 2, y: it.ly + 4 }, txt));
        return;
      }
      var t = s("text", { x: tx, y: it.ly + 4 });
      t.appendChild(s("tspan", { "class": "lbl-val" }, (it.a.star ? "★ " : "") + fmt(it.a.level)));
      if (!narrow) t.appendChild(s("tspan", { "class": "lbl-name", dx: 6 }, it.a.name));
      gt.appendChild(t);
    });
    svg.appendChild(gt);

    var dirTxt = ov ? ov.sides.map(function(sd){ return sd.dir; }).join(" and ") : "";
    svg.setAttribute("aria-label", D.ticker + " price map: last " + fmt(D.last) +
      (ov && ov.level != null ? "; showing the " + dirTxt + " plan at " + fmt(ov.level) : "") +
      ". The full ladders are in the Price map section.");
  }

  // ---------- planner ----------

  function selectLevel(idx){
    state.level = idx;
    state.scen = null;
    if (!state.dirPinned){
      state.dir = alerts[idx].star && (fav === "long" || fav === "short") ? fav : "both";
    }
    render();
  }

  function renderLevels(){
    var box = $("lvls");
    if (!box) return;
    box.textContent = "";
    alerts.forEach(function(a, idx){
      var b = h("button", "lvl");
      b.type = "button";
      b.setAttribute("role", "option");
      b.setAttribute("aria-selected", String(!state.scen && idx === state.level));
      b.appendChild(h("b", null, (a.star ? "★ " : "") + fmt(a.level)));
      b.appendChild(h("span", null, a.name));
      var dist = a.level - D.last;
      b.appendChild(h("small", null, signed(dist) + (D.atr30 ? " · " + (Math.abs(dist) / D.atr30).toFixed(1) + "× 30m ATR" : "")));
      b.addEventListener("click", function(){ selectLevel(idx); });
      box.appendChild(b);
    });
  }

  function sideTable(level, sd){
    var wrapEl = h("div", "side");
    var risk = sd.sl != null ? Math.abs(level - sd.sl) : 0;
    var hd = h("h3", sd.dir, sd.dir === "long" ? "▲ Long" : "▼ Short");
    hd.appendChild(h("small", null, "risk " + (risk ? risk.toFixed(dec) + " pts" : "—")));
    wrapEl.appendChild(hd);
    var tbl = h("table", "plan-tbl"), tb = h("tbody");
    sd.t.forEach(function(x){
      var tr = h("tr");
      tr.appendChild(h("td", null, x.k));
      tr.appendChild(h("td", null, fmt(x.p)));
      tr.appendChild(h("td", "r", signed(x.p - level)));
      tr.appendChild(h("td", "r", risk ? (Math.abs(x.p - level) / risk).toFixed(2) + "R" : "—"));
      tb.appendChild(tr);
    });
    if (sd.sl != null){
      var tr = h("tr", "sl");
      tr.appendChild(h("td", null, "SL"));
      tr.appendChild(h("td", null, fmt(sd.sl)));
      tr.appendChild(h("td", "r", signed(sd.sl - level)));
      tr.appendChild(h("td", "r", "−1R"));
      tb.appendChild(tr);
    }
    tbl.appendChild(tb);
    wrapEl.appendChild(tbl);
    return wrapEl;
  }

  function popupText(a){
    function line(p){ return p ? "T1 " + fmt(p.t[0]) + " T2 " + fmt(p.t[1]) + " T3 " + fmt(p.t[2]) + " SL " + fmt(p.sl) : "—"; }
    return "CLAUDE" + (a.star ? "★" : "") + " " + D.key + " " + fmt(a.level) + " " + a.name + "\n" +
      "FROM ABOVE: HOLD → LONG " + line(a.long) + "\n" +
      "FROM ABOVE: NO HOLD → wait backtest → SHORT " + line(a.short) + "\n" +
      "FROM BELOW: REJECT → SHORT " + line(a.short) + "\n" +
      "FROM BELOW: BREAK → wait backtest → LONG " + line(a.long);
  }

  function renderPlan(){
    var out = $("planOut");
    if (!out) return;
    out.textContent = "";
    ["long", "short", "both"].forEach(function(d){
      var b = document.querySelector('#dirSeg [data-dir="' + d + '"]');
      if (b) b.setAttribute("aria-pressed", String(!state.scen && state.dir === d));
    });

    var pop = $("popupText"), popBox = $("popupBox");
    if (state.scen){
      var sc = scenarios[state.scen.i], br = sc.branches[state.scen.b];
      var ban = h("div", "scen-banner");
      ban.appendChild(h("b", null, "RANK " + sc.rank + " · " + (br.dir === "LONG" ? "▲ LONG" : "▼ SHORT")));
      ban.appendChild(document.createTextNode(br.label));
      var back = h("button", "btn", "Back to alert levels");
      back.type = "button";
      back.style.marginTop = "6px";
      back.addEventListener("click", function(){ state.scen = null; render(); });
      ban.appendChild(h("br"));
      ban.appendChild(back);
      out.appendChild(ban);
      var t = br.targets.map(function(x){ return { k: x.k, p: x.p }; });
      if (br.runner != null) t.push({ k: "Run", p: br.runner });
      if (br.entry != null) out.appendChild(sideTable(br.entry, { dir: br.dir.toLowerCase(), t: t, sl: br.stop }));
      if (popBox) popBox.hidden = true;
      return;
    }
    var a = alerts[state.level];
    if (!a) return;
    if (popBox) popBox.hidden = false;
    ["long", "short"].forEach(function(d){
      if ((state.dir === d || state.dir === "both") && a[d]){
        out.appendChild(sideTable(a.level, { dir: d, t: a[d].t.map(function(p, n){ return { k: "T" + (n + 1), p: p }; }), sl: a[d].sl }));
      }
    });
    if (pop) pop.textContent = popupText(a);
  }

  // ---------- scenarios ----------

  function renderRanks(){
    var tabs = $("rankTabs"), out = $("rankOut");
    if (!tabs || !out) return;
    tabs.textContent = "";
    scenarios.forEach(function(sc, idx){
      var b = h("button", "rank-tab");
      b.type = "button";
      b.setAttribute("role", "tab");
      b.setAttribute("aria-selected", String(idx === state.rank));
      b.appendChild(h("b", null, sc.rank + (sc.star ? " ★" : "")));
      b.appendChild(h("span", null, sc.name));
      b.addEventListener("click", function(){ state.rank = idx; renderRanks(); });
      tabs.appendChild(b);
    });

    out.textContent = "";
    var sc = scenarios[state.rank];
    if (!sc) return;
    var head = h("div", "rank-head");
    head.appendChild(h("h3", null, "RANK " + sc.rank + (sc.star ? " ★" : "") + " — " + sc.name));
    if (sc.slot) head.appendChild(h("span", "tag", sc.slot));
    out.appendChild(head);
    if (sc.trigger){
      var tr = h("p", "rank-trig");
      tr.appendChild(h("strong", null, "Trigger: "));
      tr.appendChild(document.createTextNode(sc.trigger));
      out.appendChild(tr);
    }
    if (sc.why) out.appendChild(h("p", "rank-why", sc.why));

    var list = h("div", "branches");
    sc.branches.forEach(function(br, bi){
      var row = h("div", "branch" + (sc.favoured && sc.favoured === br.dir ? " fav" : ""));
      row.appendChild(h("span", "badge " + br.dir.toLowerCase(), br.dir === "LONG" ? "▲ LONG" : "▼ SHORT"));
      var lab = h("span", "b-label", br.label);
      if (sc.favoured && sc.favoured === br.dir) lab.appendChild(h("small", null, "favoured"));
      row.appendChild(lab);
      if (br.entry != null && br.targets.length){
        var btn = h("button", "btn", "Show on map");
        btn.type = "button";
        btn.addEventListener("click", function(){
          state.scen = { i: state.rank, b: bi };
          render();
          var m = $("map-card");
          if (m && m.getBoundingClientRect().top < 0) m.scrollIntoView({ behavior: "smooth", block: "start" });
        });
        row.appendChild(btn);
      } else {
        row.appendChild(h("span"));
      }
      var nums = h("div", "b-nums");
      function px(k, v, cls){
        var e = h("span", "px" + (cls ? " " + cls : ""));
        e.appendChild(h("i", null, k));
        e.appendChild(document.createTextNode(v));
        nums.appendChild(e);
      }
      if (br.entry != null) px("Entry", fmt(br.entry));
      br.targets.forEach(function(x){ px(x.k, fmt(x.p)); });
      if (br.runner != null) px("Runner", fmt(br.runner));
      if (br.stop != null) px("Stop", fmt(br.stop));
      if (br.rr != null) px("R:R", String(br.rr), "rr");
      row.appendChild(nums);
      list.appendChild(row);
    });
    if (!sc.branches.length) list.appendChild(h("p", "rank-why", "No numeric branches in this scenario — the full reasoning is below."));
    out.appendChild(list);

    var src = document.querySelector('article.rank[data-rank="' + sc.rank + '"]');
    if (src){
      var det = h("details", "full");
      if (!sc.branches.length) det.open = true;
      det.appendChild(h("summary", null, "Full reasoning"));
      var body = src.cloneNode(true);
      body.removeAttribute("data-rank");
      body.className = "";
      var hh = body.querySelector("h3");
      if (hh) hh.remove();
      Array.prototype.forEach.call(body.querySelectorAll("[id]"), function(e){ e.removeAttribute("id"); });
      det.appendChild(body);
      out.appendChild(det);
    }
  }

  // ---------- wiring ----------

  function render(){
    renderLevels();
    renderPlan();
    drawMap();
  }

  Array.prototype.forEach.call(document.querySelectorAll("#dirSeg button"), function(b){
    b.addEventListener("click", function(){
      state.dir = b.getAttribute("data-dir");
      state.dirPinned = true;
      state.scen = null;
      render();
    });
  });
  Array.prototype.forEach.call(document.querySelectorAll("#zoomSeg button"), function(b){
    b.addEventListener("click", function(){
      state.zoom = b.getAttribute("data-zoom");
      Array.prototype.forEach.call(document.querySelectorAll("#zoomSeg button"), function(o){
        o.setAttribute("aria-pressed", String(o === b));
      });
      drawMap();
    });
  });

  var copyBtn = $("copyBtn");
  if (copyBtn){
    copyBtn.addEventListener("click", function(){
      var text = $("popupText").textContent;
      function done(label){
        copyBtn.textContent = label;
        setTimeout(function(){ copyBtn.textContent = "Copy"; }, 1600);
      }
      function fallback(){
        var r = document.createRange();
        r.selectNodeContents($("popupText"));
        var sel = window.getSelection();
        sel.removeAllRanges();
        sel.addRange(r);
        done("Selected — press Ctrl+C");
      }
      if (navigator.clipboard && navigator.clipboard.writeText){
        navigator.clipboard.writeText(text).then(function(){ done("Copied"); }, fallback);
      } else fallback();
    });
  }

  // Section nav: open a collapsed section before jumping to it, and mark where we are.
  Array.prototype.forEach.call(document.querySelectorAll(".toc a"), function(a){
    a.addEventListener("click", function(){
      var target = document.getElementById(a.getAttribute("href").slice(1));
      if (target && target.tagName === "DETAILS") target.open = true;
    });
  });
  function openFromHash(){
    var target = location.hash && document.getElementById(location.hash.slice(1));
    if (target && target.tagName === "DETAILS") target.open = true;
  }
  window.addEventListener("hashchange", openFromHash);
  openFromHash();

  for (var r = 0; r < scenarios.length; r++) if (scenarios[r].star){ state.rank = r; break; }

  var frame = 0;
  window.addEventListener("resize", function(){
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(drawMap);
  });

  renderRanks();
  render();
})();
