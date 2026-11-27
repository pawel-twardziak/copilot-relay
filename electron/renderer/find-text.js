// Case-insensitive, whitespace-collapsing substring matcher, shared by the find bar and the content-search worker so
// both count matches the same way. Loaded as a classic <script> (sets globalThis.FindText) and via require().
// Wrapped so no helper leaks into the shared global scope of the renderer's scripts.
(() => {
  /** Lower-cased copy of text with every whitespace run collapsed to one space; map[i] is the index in the original
   *  of the character that produced folded code unit i. */
  function fold(text) {
    let folded = "";
    const map = [];
    let inSpace = false;
    for (let i = 0; i < text.length; ) {
      const cp = text.codePointAt(i);
      const ch = String.fromCodePoint(cp);
      if (/\s/u.test(ch)) {
        if (!inSpace) {
          folded += " ";
          map.push(i);
        }
        inSpace = true;
      } else {
        inSpace = false;
        const low = ch.toLowerCase();
        folded += low;
        for (let k = 0; k < low.length; k++) map.push(i);
      }
      i += ch.length;
    }
    return { folded, map };
  }

  /** Offsets in text of the non-overlapping matches of query, left to right; none for an empty (trimmed) query. */
  function findMatches(text, query) {
    const q = fold(String(query ?? "").trim()).folded;
    if (!q) return [];
    const src = String(text ?? "");
    const { folded, map } = fold(src);
    const out = [];
    for (let at = folded.indexOf(q); at !== -1; at = folded.indexOf(q, at + q.length)) {
      const last = map[at + q.length - 1];
      out.push({ start: map[at], end: last + String.fromCodePoint(src.codePointAt(last)).length });
    }
    return out;
  }

  /** The text around a match: up to width characters each side, cut at whitespace in the outer half, newlines as
   *  spaces (also in the match), an ellipsis where cut. */
  function makeSnippet(text, start, end, width = 40) {
    const flat = (s) => s.replace(/[\r\n]/g, " ");
    let before = text.slice(Math.max(0, start - width), start);
    if (start - width > 0) {
      const ws = before.search(/\s/);
      if (ws !== -1 && ws < width / 2) before = before.slice(ws + 1);
      before = "…" + before;
    }
    let after = text.slice(end, end + width);
    if (end + width < text.length) {
      let ws = -1;
      for (let i = after.length - 1; i >= width / 2; i--) if (/\s/.test(after[i])) { ws = i; break; }
      if (ws !== -1) after = after.slice(0, ws);
      after += "…";
    }
    return { before: flat(before), match: flat(text.slice(start, end)), after: flat(after) };
  }

  /** Which of a view's matches (their snippets, in order) is the one wanted: those whose before/after agree with it
   *  on their shorter common length, the nearest to k among them (exact); else the index nearest to k (not exact). */
  function pickTarget(snippets, wanted) {
    const n = snippets.length;
    if (!n) return { index: -1, exact: false };
    // the cut marks makeSnippet adds are not text
    const normBefore = (s) => fold(String(s ?? "").replace(/^…/, "")).folded;
    const normAfter = (s) => fold(String(s ?? "").replace(/…$/, "")).folded;
    const wb = normBefore(wanted.before);
    const wa = normAfter(wanted.after);
    let best = -1;
    for (let i = 0; i < n; i++) {
      const b = normBefore(snippets[i].before);
      const a = normAfter(snippets[i].after);
      const lb = Math.min(b.length, wb.length);
      const la = Math.min(a.length, wa.length);
      const agrees = b.slice(b.length - lb) === wb.slice(wb.length - lb) && a.slice(0, la) === wa.slice(0, la);
      if (agrees && (best === -1 || Math.abs(i - wanted.k) < Math.abs(best - wanted.k))) best = i;
    }
    if (best !== -1) return { index: best, exact: true };
    return { index: Math.max(0, Math.min(wanted.k, n - 1)), exact: false };
  }

  const FindText = { findMatches, makeSnippet, pickTarget };
  globalThis.FindText = FindText;
  if (typeof module !== "undefined") module.exports = FindText;
})();
