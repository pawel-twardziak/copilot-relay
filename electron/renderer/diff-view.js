// Unified diff parser and a small DOM renderer for the changes browser (the parser is pure).
// Loaded as a classic <script> (sets globalThis.DiffView) and via require() in tests.
"use strict";
(function () {

const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;
const BINARY_RE = /^Binary files .* differ$/;

/** Splits diff text into lines: split on "\n", one trailing "\r" (the terminator) is dropped, no empty last line. */
function splitLines(text) {
  const raw = String(text ?? "").split("\n");
  if (raw.length && raw[raw.length - 1] === "") raw.pop();
  return raw.map((l) => (l.endsWith("\r") ? l.slice(0, -1) : l));
}

/**
 * Parses git's unified diff into { binary, lines }. A line is { type: "hunk" | "ctx" | "add" | "del" | "note", old, new, text }.
 * Whether a line belongs to a hunk is decided by the counts of the hunk header, so a content line that starts with
 * "---" or "+++" stays content. Git's header lines outside hunks are dropped.
 */
function parse(text) {
  const lines = [];
  let binary = false;
  let oldNo = 0;
  let newNo = 0;
  let oldLeft = 0;
  let newLeft = 0;
  let seenHunk = false;
  const push = (type, old, nu, t) => lines.push({ type, old, new: nu, text: t });

  for (const line of splitLines(text)) {
    if (oldLeft > 0 || newLeft > 0) {
      const c = line[0];
      if (c === "-") {
        push("del", oldNo++, null, line.slice(1));
        oldLeft--;
        continue;
      }
      if (c === "+") {
        push("add", null, newNo++, line.slice(1));
        newLeft--;
        continue;
      }
      if (c === "\\") {
        push("note", null, null, line);
        continue;
      }
      if (c === " " || line === "") {
        push("ctx", oldNo++, newNo++, line.slice(1));
        oldLeft--;
        newLeft--;
        continue;
      }
      oldLeft = newLeft = 0; // a malformed hunk: fall through and read the line as a header
    }
    const m = HUNK_RE.exec(line);
    if (m) {
      oldNo = Number(m[1]);
      oldLeft = m[2] === undefined ? 1 : Number(m[2]);
      newNo = Number(m[3]);
      newLeft = m[4] === undefined ? 1 : Number(m[4]);
      seenHunk = true;
      push("hunk", null, null, line);
    } else if (line[0] === "\\" && seenHunk) push("note", null, null, line);
    else if (BINARY_RE.test(line)) binary = true;
  }
  return { binary, lines };
}

/** A whole file as an addition: every line of text is an "add", numbered from 1. */
function added(text) {
  return { binary: false, lines: splitLines(text).map((t, i) => ({ type: "add", old: null, new: i + 1, text: t })) };
}

const LINE_LIMIT = 20000;

/** At most limit lines: the first ones plus a note, or parsed itself when it fits. */
function clip(parsed, limit = LINE_LIMIT) {
  if (parsed.lines.length <= limit) return parsed;
  const note = { type: "note", old: null, new: null, text: `Only the first ${limit} lines are shown.` };
  return { binary: parsed.binary, lines: [...parsed.lines.slice(0, limit), note] };
}

/** Renders the (clipped) parsed lines with the app's element helper h(tag, attrs, children); text only through children strings. */
function render(parsed, h) {
  const num = (n) => h("span", { class: "dv-num" }, n == null ? "" : String(n));
  return h(
    "div",
    { class: "dv" },
    clip(parsed).lines.map((l) =>
      h("div", { class: `dv-line ${l.type}` }, num(l.old), num(l.new), h("span", { class: "dv-text" }, l.text)),
    ),
  );
}

const DiffView = { parse, added, clip, render, LINE_LIMIT };
globalThis.DiffView = DiffView;
if (typeof module !== "undefined") module.exports = DiffView;
})();
