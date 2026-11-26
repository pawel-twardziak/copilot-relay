// The Communication panel's DOM: the graph (CommsLayout's boxes as HTML over an SVG of the edges), the drag bar
// between graph and log, the summary bar and the log rows. No data wiring: app.js builds the model (CommsModel.build)
// and calls render; clicks go back through `on`. Elements are kept per node, edge and row id and updated in place, so
// a render every second (timers) keeps hover tooltips, double clicks and the edge animation running.
// Loaded as a classic <script> after comms-layout.js (sets globalThis.CommsView).
"use strict";
(function () {

const NS = "http://www.w3.org/2000/svg";
const OLD_BROKER = "The relay broker is older than the app and keeps no message history; restart it to get one.";
const LOG_MAX = 1000; // rows drawn at most (the newest); the summary still counts all
const { clock, hms, chars, plural, keeperOf, statusOf, hasTimer, cornerOf, nodeWidths, nodeTitle, edgeTitle } = CommsText;
let seq = 0; // marker ids unique per panel (url(#id) takes the first match in the document)

const svg = (tag, attrs = {}) => {
  const el = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  return el;
};
const MIN_NODE = 140, MAX_NODE = 320, PADS = 1.26; // the layout's box width limits; a box plus its two margins

/**
 * The panel in `el` (the view's comms-body).
 *   h: the app's element helper; on = { openSession(id), fetchText(id) -> Promise<string>, filter(f | null),
 *   split(ratio, done), autoSplit() }  (split: the graph's share while dragging, done on pointer up after a drag;
 *   autoSplit: the bar was double-clicked, back to the height the graph needs)
 * -> { render(model, opts), destroy() }; opts = { split (0..1), autoSplit (the bar was never dragged: the graph
 *    gets the height it needs, up to the largest share the log allows), filter, note (a log line instead of the rows:
 *    loading, an error) }
 */
function create({ h, el, on }) {
  const id = `cm${++seq}`;
  const edgeLayer = svg("g", { class: "ce-lines" });
  const labelLayer = svg("g", { class: "ce-labels" });
  const defs = svg("defs");
  for (const kind of ["base", "active", "wait", "err", "sel"]) {
    const m = svg("marker", { id: `${id}-${kind}`, class: `cm-arrow ${kind}`, viewBox: "0 0 10 10", refX: "10", refY: "5", markerWidth: "8", markerHeight: "8", markerUnits: "userSpaceOnUse", orient: "auto" });
    m.append(svg("path", { d: "M 0 1 L 10 5 L 0 9 z" }));
    defs.append(m);
  }
  const svgEl = svg("svg", { class: "comms-svg" });
  svgEl.append(defs, edgeLayer, labelLayer);
  const canvas = h("div", { class: "comms-canvas" }, svgEl);
  const graph = h("div", { class: "comms-graph" }, canvas);
  const bar = h("div", { class: "comms-split", title: "Drag to share the height between graph and log; double-click to give the graph the height it needs" });
  const chip = h("button", { class: "comms-filter", hidden: true, title: "Clear the filter" });
  const totals = h("span", { class: "comms-totals" });
  const summary = h("div", { class: "comms-summary" }, totals, chip);
  const log = h("div", { class: "comms-log" });
  el.replaceChildren(graph, bar, summary, log);

  let model = null, opts = {}, laid = null, ratio = 0.5, dragging = false, manual = false;
  const layouts = new Map(); // layout key -> CommsLayout.layout's result (sizes and box widths tried)
  const nodeEls = new Map(), edgeEls = new Map(), rowEls = new Map();
  const names = (nid) => model?.nodes.find((n) => n.id === nid)?.name ?? nid;

  // text widths at the UI font (the box width the names and status lines need)
  const widths = new Map();
  let ctx2d = null;
  const measure = (font, family) => (text, bold) => {
    const k = `${bold ? 1 : 0}${font}\0${text}`;
    if (!widths.has(k)) {
      ctx2d ??= document.createElement("canvas").getContext("2d");
      ctx2d.font = `${bold ? "600 " : ""}${font}px ${family}`;
      if (widths.size > 2000) widths.clear();
      widths.set(k, ctx2d.measureText(text).width);
    }
    return widths.get(k);
  };
  // the split: the graph's share of the height left by the bar and the summary
  const graphTotal = () => el.clientHeight - bar.offsetHeight - summary.offsetHeight;
  bar.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const { top, bottom } = graph.getBoundingClientRect();
    const grab = e.clientY - bottom; // where on the bar it was grabbed: the bar moves with the pointer, no jump
    const total = graphTotal();
    let moved = false; // a click (or a double click) is no drag: auto height stays
    const move = (m) => {
      if (!moved && Math.abs(m.clientY - e.clientY) < 3) return;
      moved = true;
      manual = true; // the stored share from now on, not the height the graph needs
      ratio = UiState.clampSplit((m.clientY - grab - top) / total, total);
      graph.style.height = `${Math.round(ratio * total)}px`;
      on.split?.(ratio, false);
    };
    const end = () => {
      removeEventListener("pointermove", move);
      removeEventListener("pointerup", end);
      removeEventListener("pointercancel", end);
      document.body.classList.remove("comms-resizing");
      dragging = false;
      if (moved) on.split?.(ratio, true);
    };
    dragging = true;
    addEventListener("pointermove", move);
    addEventListener("pointerup", end);
    addEventListener("pointercancel", end);
    document.body.classList.add("comms-resizing");
  });
  // a double click on the bar: the graph gets the height it needs again
  bar.addEventListener("dblclick", () => {
    manual = false;
    on.autoSplit?.();
  });

  // clicks: a node or an edge filters the log, empty space clears; a double click on a session opens it
  canvas.addEventListener("click", (e) => {
    const node = e.target.closest?.(".cn");
    const edge = e.target.closest?.("[data-from]");
    if (node && node.dataset.proposed) return;
    if (node) on.filter?.({ node: node.dataset.id });
    else if (edge) on.filter?.({ from: edge.dataset.from, to: edge.dataset.to });
    else if (opts.filter) on.filter?.(null);
  });
  canvas.addEventListener("dblclick", (e) => {
    const node = e.target.closest?.(".cn");
    if (node && !node.dataset.proposed) on.openSession?.(node.dataset.id);
  });
  canvas.addEventListener("keydown", (e) => {
    const node = e.target.closest?.(".cn");
    if (!node || node.dataset.proposed || e.key !== "Enter") return;
    e.preventDefault();
    if (opts.filter?.node === node.dataset.id) on.openSession?.(node.dataset.id); // Enter filters, Enter again opens
    else on.filter?.({ node: node.dataset.id });
  });
  chip.addEventListener("click", () => on.filter?.(null));

  // the log follows new rows while you are at its bottom (ScrollFollow, as the chat)
  let follow = true, lastTop = 0;
  log.addEventListener("scroll", () => {
    const { scrollTop: top, scrollHeight: height, clientHeight: client } = log;
    follow = ScrollFollow.followAfterScroll(follow, lastTop, { top, height, client });
    lastTop = top;
  });
  const toBottom = () => {
    if (follow) log.scrollTop = log.scrollHeight;
  };

  function drawGraph() {
    if (!model) return;
    const width = graph.clientWidth, total = graphTotal();
    if (!width || total <= 0) return; // not shown: drawn when it shows (the ResizeObserver)
    const style = getComputedStyle(graph);
    const font = Math.max(parseFloat(style.fontSize) || 0, parseFloat(getComputedStyle(document.documentElement).fontSize) || 0, 10);
    const now = Date.now();
    // boxes as wide as the longest name needs (a clock counts as zeros) when that needs no scroll, else narrower
    // down to what the status lines need (a long name may be cut, a clock never); within the layout's limits and
    // never wider than one box fits the area
    const need = nodeWidths({ nodes: model.nodes, edges: model.edges, now, font, measure: measure(font, style.fontFamily) });
    const clampW = (v) => Math.max(MIN_NODE, Math.min(v, MAX_NODE, Math.floor((width - 2) / PADS)));
    const hi = clampW(Math.max(need.name, need.status)), lo = clampW(need.status);
    const shape = JSON.stringify([model.nodes.map((n) => [n.id, n.parent, n.inTree]), model.edges.map((e) => [e.from, e.to])]);
    const layAt = (height, minNode) => {
      const key = JSON.stringify([width, height, font, minNode, shape]);
      if (!layouts.has(key)) {
        if (layouts.size > 60) layouts.clear();
        layouts.set(key, CommsLayout.layout(model.nodes, model.edges, { width, height, font, minNode }));
      }
      return (laid = layouts.get(key));
    };
    const boxWidth = (height) => {
      const fits = (m) => !layAt(height, m).scrollX && !layAt(height, m).scrollY;
      if (hi === lo || fits(hi)) return hi;
      if (!fits(lo)) return lo; // scrolls anyway: the narrowest boxes
      let a = lo, b = hi; // a fits, b does not
      while (b - a > 6) {
        const m = Math.round((a + b) / 2);
        if (fits(m)) a = m;
        else b = m;
      }
      return a;
    };
    // the graph's height: the stored share once the bar was dragged, else what the graph needs at this width, up to
    // the largest share (the log keeps its minimum)
    let height;
    if (opts.autoSplit && !manual) {
      const max = Math.round(UiState.clampSplit(1, total) * total);
      const m = boxWidth(max);
      const full = layAt(max, m);
      const top = Math.min(...full.nodes.map((n) => n.y)), bottom = Math.max(...full.nodes.map((n) => n.y + n.h));
      const used = full.scrollY || !full.nodes.length ? max : Math.ceil(bottom + top) + 2;
      height = Math.max(Math.min(120, max), Math.min(max, used));
      layAt(height, m);
    } else {
      height = Math.round(UiState.clampSplit(ratio, total) * total);
      layAt(height, boxWidth(height));
    }
    graph.style.height = `${height}px`;
    canvas.style.width = `${laid.width}px`;
    canvas.style.height = `${laid.height}px`;
    svgEl.setAttribute("width", laid.width);
    svgEl.setAttribute("height", laid.height);
    const f = opts.filter ?? null;
    const byId = new Map(model.nodes.map((n) => [n.id, n]));
    const closedEnd = (e) => byId.get(e.from)?.state === "closed" || byId.get(e.to)?.state === "closed";
    // a filter dims what it leaves out: a node filter keeps the node, its edges and their other ends
    const edgeIn = (e) => !f || (f.node != null ? e.from === f.node || e.to === f.node : e.from === f.from && e.to === f.to);
    const nodeIn = (nid) => !f || (f.node != null ? nid === f.node || model.edges.some((e) => edgeIn(e) && (e.from === nid || e.to === nid)) : nid === f.from || nid === f.to);

    // edges: a wide transparent line to hover and click, the drawn line, and the count in a pill over all lines
    const seen = new Set();
    let atLine = edgeLayer.firstChild, atLabel = labelLayer.firstChild;
    for (const p of laid.edges) {
      const e = model.edges.find((x) => x.from === p.from && x.to === p.to);
      if (!e) continue;
      const k = JSON.stringify([p.from, p.to]);
      seen.add(k);
      let it = edgeEls.get(k);
      if (!it) {
        it = { g: svg("g", { "data-from": p.from, "data-to": p.to }), title: svg("title"), hit: svg("path", { class: "ce-hit" }), line: svg("path", { class: "ce-line" }),
          label: svg("g", { class: "ce-label", "data-from": p.from, "data-to": p.to }), ltitle: svg("title"), pill: svg("rect", { rx: "999" }), text: svg("text", { "text-anchor": "middle", "dominant-baseline": "central" }) };
        it.g.append(it.title, it.hit, it.line);
        it.label.append(it.ltitle, it.pill, it.text);
        edgeEls.set(k, it);
      }
      // in layout order, moved only when out of place (a moved element loses its hover and tooltip)
      if (it.g !== atLine) edgeLayer.insertBefore(it.g, atLine);
      else atLine = atLine.nextSibling;
      if (it.label !== atLabel) labelLayer.insertBefore(it.label, atLabel);
      else atLabel = atLabel.nextSibling;
      const selected = f && f.from === e.from && f.to === e.to;
      const kind = selected ? "sel" : e.live === "ended-no-report" ? "err" : e.live === "in-progress" ? "active" : e.live ? "wait" : "base";
      const cls = ["ce", e.tree ? "tree" : "other", e.live ? `live-${e.live}` : "", !e.live && closedEnd(e) ? "muted" : "", selected ? "selected" : "", edgeIn(e) ? "" : "dim"].filter(Boolean).join(" ");
      it.g.setAttribute("class", cls);
      it.label.setAttribute("class", `ce-label ${cls}`);
      for (const path of [it.hit, it.line]) path.setAttribute("d", p.path);
      it.line.setAttribute("marker-end", `url(#${id}-${kind})`);
      const tip = edgeTitle(e, names, now);
      it.title.textContent = it.ltitle.textContent = tip;
      it.text.textContent = String(e.count);
      it.label.style.display = e.count ? "" : "none"; // a live state without messages yet (a report awaited): no count
      const lw = Math.max(laid.label.w, String(e.count).length * font * 0.62 + font * 0.9);
      Object.entries({ x: p.labelX - lw / 2, y: p.labelY - laid.label.h / 2, width: lw, height: laid.label.h }).forEach(([a, v]) => it.pill.setAttribute(a, v));
      it.text.setAttribute("x", p.labelX);
      it.text.setAttribute("y", p.labelY);
      it.text.style.fontSize = `${font}px`;
    }
    for (const [k, it] of edgeEls) if (!seen.has(k)) (it.g.remove(), it.label.remove(), edgeEls.delete(k));

    // nodes: a name line (state dot, name, marks) and a status line (state or live text, relay/user badges), the
    // context bar along the bottom border
    const shown = new Set();
    for (const b of laid.nodes) {
      const n = byId.get(b.id);
      if (!n) continue;
      shown.add(n.id);
      let it = nodeEls.get(n.id);
      if (!it) {
        it = { dot: h("span", { class: "cn-dot" }), name: h("span", { class: "cn-name" }), tag: h("span", { class: "cn-tag" }, "released"),
          corner: h("span", { class: "cn-corner" }), status: h("span", { class: "cn-status" }), badges: h("span", { class: "cn-badges" }), fill: h("i") };
        it.ctx = h("div", { class: "cn-ctx" }, it.fill);
        it.first = h("div", { class: "cn-line" }, it.dot, it.name, it.tag);
        it.el = h("div", { class: "cn", "data-id": n.id }, it.first, h("div", { class: "cn-line sub" }, it.status, it.badges), it.ctx, it.corner);
        nodeEls.set(n.id, it);
        canvas.append(it.el);
      }
      const status = statusOf(n, model.edges, now);
      const selected = f?.node === n.id;
      const ended = model.edges.some((e) => e.from === n.id && e.live === "ended-no-report");
      it.el.className = ["cn", `st-${n.state}`, n.inTree ? "" : "outside", n.released ? "released" : "", n.current ? "current" : "", ended ? "ended" : "",
        keeperOf(n) ? "keeper" : "", selected ? "selected" : "", nodeIn(n.id) ? "" : "dim"].filter(Boolean).join(" ");
      if (n.state === "proposed") it.el.dataset.proposed = "1";
      else delete it.el.dataset.proposed;
      it.el.tabIndex = n.state === "proposed" ? -1 : 0;
      const nf = font * Math.min(1.3, b.h / (font * 3.2)); // the text grows with the box, a little
      Object.assign(it.el.style, { left: `${b.x}px`, top: `${b.y}px`, width: `${b.w}px`, height: `${b.h}px`, fontSize: `${nf}px` });
      it.el.title = nodeTitle(n, status);
      it.name.textContent = n.name;
      it.status.textContent = status;
      it.tag.hidden = !n.released;
      // what waits for you sits on the box's top right corner; the name line keeps clear of it
      it.corner.replaceChildren(...cornerOf(n).map((p) => h("span", { class: `cn-pill ${p.kind}`, title: p.title }, p.text)));
      it.first.style.paddingRight = it.corner.firstChild ? `${Math.max(0, it.corner.offsetWidth - 0.9 * nf)}px` : "";
      it.badges.replaceChildren(
        ...[n.badges.relay && h("span", { class: "cn-pill" }, `relay ${n.badges.relay}`), n.badges.user && h("span", { class: "cn-pill" }, `user ${n.badges.user}`)].filter(Boolean),
      );
      // the badges only while the status line keeps its whole text (the tooltip has them anyway)
      it.badges.hidden = false;
      if (it.badges.firstChild && it.status.scrollWidth > it.status.clientWidth + 1) it.badges.hidden = true;
      it.ctx.hidden = !n.ctx;
      it.ctx.className = `cn-ctx ${n.ctx?.level ?? ""}`;
      it.fill.style.width = `${Math.max(0, Math.min(100, Number(n.ctx?.pct) || 0))}%`;
    }
    for (const [k, it] of nodeEls) if (!shown.has(k)) (it.el.remove(), nodeEls.delete(k));
  }

  function drawSummary() {
    const s = model.stats;
    const parts = [plural(s.messages, "message"), `${chars(s.size)} chars`];
    if (s.avgTaskToReport != null) parts.push(`task → report ⌀ ${clock(s.avgTaskToReport)}`);
    if (s.heldNow) parts.push(`${s.heldNow} held`);
    for (const k of ["discarded", "dropped", "blocked"]) if (s[k]) parts.push(`${s[k]} ${k}`);
    totals.textContent = parts.join(" · ");
    totals.title = `${plural(s.messages, "message")}, ${plural(s.size, "character")}${opts.filter ? " (filtered)" : ""}`;
    const f = opts.filter;
    chip.hidden = !f;
    if (f) chip.textContent = `${f.node != null ? names(f.node) : `${names(f.from)} → ${names(f.to)}`}  ✕`;
  }

  /** A log row: time, from → to, kind, size, status, then the preview (the full text once expanded). */
  function rowEl(r) {
    const it = { status: h("span", { class: "cl-status" }), text: h("div", { class: "cl-text" }), open: false, full: null };
    const from = r.from ?? (r.kind === "notice" ? "relay" : r.kind === "user" ? "you" : "?");
    it.el = h(
      "div",
      { class: `cl-row k-${r.kind}`, tabindex: "0", title: "Click to show the whole message" },
      h("div", { class: "cl-head" }, h("span", { class: "cl-time" }, hms(r.ts)), h("span", { class: "cl-route", title: `${from} → ${r.to ?? "?"}` }, `${from} → ${r.to ?? "?"}`),
        h("span", { class: "cl-kind" }, r.kind), h("span", { class: "cl-size", title: plural(Number(r.size) || 0, "character") }, chars(r.size)), it.status),
      it.text,
    );
    const toggle = () => {
      it.open = !it.open;
      it.el.classList.toggle("open", it.open);
      fill(it, r);
      if (!it.open || it.full != null) return;
      it.loading = true;
      fill(it, r);
      Promise.resolve()
        .then(() => on.fetchText(r.id))
        .then((text) => (it.full = String(text ?? "")), (e) => (it.error = e?.message ?? String(e)))
        .finally(() => {
          it.loading = false;
          fill(it, r);
        });
    };
    it.el.addEventListener("click", () => {
      if (!getSelection()?.toString()) toggle(); // selecting text in an open row does not close it
    });
    it.el.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") (e.preventDefault(), toggle());
    });
    return it;
  }
  function fill(it, r) {
    const text = it.open && it.full != null ? it.full : r.preview ?? "";
    it.text.textContent = text;
    it.text.classList.toggle("loading", it.open && !!it.loading);
    if (it.open && it.error && it.full == null) it.text.append(h("span", { class: "cl-error" }, ` (could not load the whole message: ${it.error})`));
  }

  function drawLog() {
    const note = opts.note ?? (model.unsupported ? OLD_BROKER : model.rows.length ? null : opts.filter ? "No messages match the filter." : "No messages yet.");
    const rows = note && !model.rows.length ? [] : model.rows.slice(-LOG_MAX);
    const keep = new Set(rows.map((r) => r.id));
    for (const [k, it] of rowEls) if (!keep.has(k)) (it.el.remove(), rowEls.delete(k));
    let noteEl = log.querySelector(":scope > .cl-note");
    const noteText = note ?? (model.rows.length > LOG_MAX ? `${model.rows.length - LOG_MAX} earlier messages are not shown.` : null);
    if (noteText) {
      noteEl ??= h("div", { class: "cl-note" });
      noteEl.textContent = noteText;
      noteEl.classList.toggle("hint", note === OLD_BROKER);
      if (log.firstChild !== noteEl) log.prepend(noteEl);
    } else noteEl?.remove();
    let at = noteEl ? noteEl.nextSibling : log.firstChild;
    for (const r of rows) {
      let it = rowEls.get(r.id);
      if (!it) rowEls.set(r.id, (it = rowEl(r)));
      if (it.el !== at) log.insertBefore(it.el, at);
      else at = at.nextSibling;
      if (it.shownStatus !== r.status) {
        it.shownStatus = r.status;
        it.status.textContent = r.status ?? "";
        it.status.className = `cl-status s-${r.status ?? "none"}`;
      }
      if (it.preview !== r.preview) (it.preview = r.preview, fill(it, r));
    }
    toBottom();
  }

  // sizes change: laid out again in the next frame (in the observer's callback a scroll bar the new layout brings
  // would be a resize it cannot deliver)
  let frame = 0;
  const ro = new ResizeObserver(() => {
    if (dragging || frame) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      drawGraph();
      toBottom();
    });
  });
  ro.observe(el);
  ro.observe(graph);
  ro.observe(log);

  return {
    render(next, nextOpts = {}) {
      model = next;
      opts = nextOpts;
      if (!dragging && Number.isFinite(opts.split)) ratio = opts.split;
      if (!dragging && opts.autoSplit) manual = false; // auto again (a double click in this or another view)
      drawGraph();
      drawSummary();
      drawLog();
    },
    destroy() {
      ro.disconnect();
      cancelAnimationFrame(frame);
      el.replaceChildren();
      nodeEls.clear();
      edgeEls.clear();
      rowEls.clear();
      model = null;
    },
  };
}

const CommsView = { create, hasTimer, OLD_BROKER };
globalThis.CommsView = CommsView;
})();
