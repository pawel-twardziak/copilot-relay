// The Communication panel's words (no DOM): a node's status line (its clock first, short words), the badges on its
// corner, the tooltips, the number formats, and the box width the longest name and status line need.
// Loaded as a classic <script> before comms-view.js (sets globalThis.CommsText) and via require() in tests.
"use strict";
(function () {

const KEEPER_ON = new Set(["pinging", "countdown", "compacting"]);
const TIMED = new Set(["in-progress", "waiting-report", "queued", "reading", "awaiting-reopen"]);
// the status line's state words (short: the box is narrow) and the tooltip's
const STATE_WORDS = { working: "working", idle: "idle", "waiting-task": "idle", closed: "closed", proposed: "proposed" };
const STATE_LONG = { working: "working", idle: "idle", "waiting-task": "waiting for a task", closed: "closed", proposed: "proposed (waits for your approval)" };
const LIVE_WORDS = {
  "in-progress": "task in progress", "waiting-report": "parent waits for the report", queued: "queued, not delivered yet",
  reading: "recipient is processing it",
  "ended-no-report": "ended without report", "awaiting-reopen": "awaiting reopen",
};
const HELD_WORDS = { child: "from sub-sessions", parent: "from the parent", other: "from other sessions" };
const CARD_WORDS = { permission: "a permission question", link: "a link request", reopen: "a reopen request", create: "a new session proposal" };

const pad2 = (n) => String(n).padStart(2, "0");
/** m:ss, or h:mm:ss from an hour, of a duration in ms (never negative). */
function clock(ms) {
  const t = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), s = t % 60;
  return h ? `${h}:${pad2(m)}:${pad2(s)}` : `${m}:${pad2(s)}`;
}
/** HH:MM:SS of a time (local). */
function hms(ts) {
  const d = new Date(ts);
  return Number.isNaN(d.getTime()) ? "" : `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}
/** A size in characters, short: 850, 4.3k, 12k, 1.2M. */
function chars(n) {
  const v = Number(n) || 0;
  if (v < 1000) return String(v);
  if (v < 1e6) return `${(v / 1000).toFixed(v < 10000 ? 1 : 0)}k`;
  return `${(v / 1e6).toFixed(1)}M`;
}
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const sum = (o) => Object.values(o ?? {}).reduce((a, b) => a + (Number(b) || 0), 0);
const keeperOf = (n) => (KEEPER_ON.has(n.keeper?.phase) ? n.keeper : null);

/** The text of an edge's live state with its timer ("parent waits for the report · 5:40"), or null. */
function liveText(edge, now) {
  if (!edge.live) return null;
  const timer = TIMED.has(edge.live) && edge.since != null ? ` · ${clock(now - edge.since)}` : "";
  return LIVE_WORDS[edge.live] + timer;
}

/** A node's status line, its clock first so a narrow box cuts the word, never the time: the keeper while it runs
 *  ("⏳1:43 idle", "⏳ compacting", "♻2/5 idle"), else what the edges say ("3:12 working", "5:40 report due",
 *  "ended, no report", "awaiting reopen", "0:40 queued", "1:05 reading"), else the state word. */
function statusOf(node, edges, now) {
  // the newest of several (two reports read in one turn: the clock of the latest)
  const into = (live) => edges.filter((e) => e.to === node.id && e.live === live).sort((a, b) => (b.since ?? 0) - (a.since ?? 0))[0];
  const out = (live) => edges.find((e) => e.from === node.id && e.live === live);
  const at = (e) => (e.since != null ? `${clock(now - e.since)} ` : "");
  let s = STATE_WORDS[node.state] ?? node.state;
  let e;
  if (out("ended-no-report")) s = "ended, no report";
  else if ((e = into("in-progress"))) s = `${at(e)}working`;
  else if ((e = out("waiting-report"))) s = `${at(e)}report due`;
  else if (into("awaiting-reopen")) s = "awaiting reopen";
  else if ((e = into("queued"))) s = `${at(e)}queued`;
  else if ((e = into("reading"))) s = `${at(e)}reading`;
  const k = keeperOf(node);
  if (!k) return s;
  if (k.phase === "compacting") return "⏳ compacting";
  if (k.phase === "countdown") return `⏳${clock((k.compactAt ?? now) - now)} ${s}`;
  return `♻${k.pingsSent ?? 0}/${k.pings ?? 0} ${s}`;
}

/** True while some node or edge shows a running timer (the caller re-renders every second). */
function hasTimer(model) {
  return (model?.edges ?? []).some((e) => TIMED.has(e.live) && e.since != null) || (model?.nodes ?? []).some((n) => keeperOf(n));
}

/** The badges on a node's top right corner: what waits for you. [{ kind: "held" | "asks", text, title }] */
function cornerOf(n) {
  const out = [];
  const held = sum(n.held);
  if (held) {
    const by = Object.entries(n.held).filter(([, c]) => c > 0).map(([k, c]) => `${c} ${HELD_WORDS[k] ?? k}`).join(", ");
    out.push({ kind: "held", text: String(held), title: `${plural(held, "message")} waiting for your approval: ${by}` });
  }
  const asks = (n.cards ?? []).filter((c) => c.kind !== "create");
  if (asks.length) {
    const title = `Waits for your answer: ${asks.map((c) => CARD_WORDS[c.kind] ?? c.kind).join(", ")}`;
    out.push({ kind: "asks", text: asks.length > 1 ? `?${asks.length}` : "?", title });
  }
  return out;
}

/**
 * The box widths (px, unclamped) the widest name line and the widest status line need at the UI font:
 * { name, status }. measure(text, bold) -> px. Digits are measured as zeros, so a ticking clock does not change the
 * width (only its number of digits does). The em lengths are those of the .cn rules in style.css (padding .6em, dot
 * .5em, gaps .4em, corner pills).
 */
function nodeWidths({ nodes = [], edges = [], now = 0, font, measure }) {
  const zero = (t) => t.replace(/\d/g, "0");
  let names = 0, statuses = 0;
  for (const n of nodes) {
    const pills = cornerOf(n);
    const corner = pills.reduce((a, p) => a + Math.max(1.4 * font, measure(p.text, true) + 0.6 * font) + 2, 0) + 0.2 * font * Math.max(0, pills.length - 1);
    const tag = n.released ? 0.4 * font + measure("released", false) + 0.8 * font + 2 : 0;
    const name = 0.9 * font + measure(String(n.name ?? n.id), true) + tag + Math.max(0, corner - 0.9 * font);
    names = Math.max(names, name);
    statuses = Math.max(statuses, measure(zero(statusOf(n, edges, now)), false));
  }
  const box = (w) => Math.ceil(w + 1.2 * font + 6); // the padding, a 2 px border and rounding
  return { name: box(names), status: box(statuses) };
}
/** The width both lines need: the larger of nodeWidths. */
const nodeWidth = (input) => Math.max(...Object.values(nodeWidths(input)));

/** The node's tooltip: who it is, its state, counts, context, keeper, held messages and open cards. */
function nodeTitle(n, status) {
  const lines = [n.name, status];
  if (STATE_LONG[n.state] && !status.endsWith(STATE_LONG[n.state])) lines.push(`State: ${STATE_LONG[n.state]}`);
  if (!n.inTree) lines.push(n.released ? "Released from the tree" : "Outside the tree");
  if (n.state !== "proposed") {
    lines.push(`Between sessions: ${n.sent} sent · ${n.received} received`);
    if (n.badges.relay || n.badges.user) lines.push(`Received from relay: ${n.badges.relay} · from you: ${n.badges.user}`);
  }
  if (n.ctx) lines.push(n.ctx.label + (n.ctx.level !== "ok" ? " (automatic compaction is near)" : ""));
  for (const p of cornerOf(n)) lines.push(p.title);
  if (n.state !== "proposed") lines.push("Click: filter the log · double click: open");
  return lines.filter(Boolean).join("\n");
}

/** An edge's tooltip: the pair, count, size, last time, live state with its timer, held. */
function edgeTitle(e, names, now) {
  const lines = [`${names(e.from)} → ${names(e.to)}`, `${plural(e.count, "message")} · ${plural(e.size, "character")}`];
  if (e.last) lines.push(`Last: ${hms(e.last)}`);
  const live = liveText(e, now);
  if (live) lines.push(live);
  if (e.held) lines.push(`${e.held} waiting for your approval`);
  lines.push("Click: filter the log");
  return lines.join("\n");
}

const CommsText = { clock, hms, chars, plural, keeperOf, liveText, statusOf, hasTimer, cornerOf, nodeWidths, nodeWidth, nodeTitle, edgeTitle };
globalThis.CommsText = CommsText;
if (typeof module !== "undefined") module.exports = CommsText;
})();
