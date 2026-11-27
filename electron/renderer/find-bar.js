// The find bar over a session's log (Ctrl+F): finds text in the main-thread message bubbles, marks the matches with
// the CSS Custom Highlight API (Range objects: the message DOM is never changed) and steps through them. Loaded as a
// classic <script> (sets globalThis.FindBar) after message-text.js and find-text.js; wrapped so no helper leaks into
// the shared global scope of the renderer's scripts.
(() => {
  /** The log's own children that are searched: your messages, relay messages and answers (not groups, tools,
   *  thinking blocks or notices). */
  const BUBBLE = ".msg.user, .msg.relay, .msg.agent";
  /** Not message text: the buttons (copy, edit, fork, delete), the sender label, the time, a thinking block and the
   *  image thumbnails (their chips' labels). */
  const SKIP = ".acts, .copy, .from, .time, details.thought, .thumbs, .thumb-slot";
  const DEBOUNCE_MS = 100;

  /** A bubble's searchable text and the text nodes it is read from (at: where a node starts in the whole text). In a
   *  .msg.user a replayed relay message's sender header is not searchable: offset is its length. */
  function bubbleText(el) {
    const nodes = [];
    let whole = "";
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
      acceptNode: (n) => (n.nodeType === Node.TEXT_NODE ? NodeFilter.FILTER_ACCEPT : n.matches(SKIP) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_SKIP),
    });
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      nodes.push({ node: n, at: whole.length });
      whole += n.data;
    }
    const text = el.classList.contains("user") ? MessageText.relayBody(whole) : whole;
    return { whole, text, offset: whole.length - text.length, nodes };
  }

  /** The text node and the offset in it of position pos of the whole text: the last node starting at or before it
   *  (a start), or before it (an end, so a match ending at a node's end stays in that node). */
  function locate(nodes, pos, end) {
    let lo = 0;
    let hi = nodes.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (end ? nodes[mid].at < pos : nodes[mid].at <= pos) lo = mid;
      else hi = mid - 1;
    }
    return [nodes[lo].node, pos - nodes[lo].at];
  }

  class FindBar {
    /** onClose: called when you close the bar (Esc, ✕), e.g. to give the message box the focus back. */
    constructor(log, { onClose } = {}) {
      this.log = log;
      this.onClose = onClose;
      this.isOpen = false;
      this.matches = []; // { el, text, start, end, range }: start/end in text (the bubble's searchable text)
      this.current = -1;
      this.cache = new WeakMap(); // bubble -> { whole, query, found }: a bubble whose text did not change is not searched again
      this.typeTimer = null;
      this.liveTimer = null;
      this.all = new Highlight();
      this.cur = new Highlight();
      this.cur.priority = 1; // painted over find-match
      const button = (label, title, onclick) => {
        const b = document.createElement("button");
        b.type = "button";
        b.title = title;
        b.textContent = label;
        b.addEventListener("click", onclick);
        return b;
      };
      this.input = document.createElement("input");
      this.input.type = "text";
      this.input.placeholder = "Find in messages";
      this.input.spellcheck = false;
      this.input.addEventListener("input", () => {
        clearTimeout(this.typeTimer);
        this.typeTimer = setTimeout(() => this.run(false), DEBOUNCE_MS);
      });
      this.input.addEventListener("keydown", (e) => this.key(e));
      this.count = document.createElement("span");
      this.count.className = "find-count";
      this.el = document.createElement("div");
      this.el.className = "find-bar";
      this.el.hidden = true;
      this.el.append(
        this.input,
        this.count,
        button("↑", "Previous match (Shift+Enter)", () => this.step(-1)),
        button("↓", "Next match (Enter)", () => this.step(1)),
        button("✕", "Close (Esc)", () => this.dismiss()),
      );
      // new, growing (streamed) or re-rendered bubbles: the search runs again, at most once per DEBOUNCE_MS
      this.observer = new MutationObserver((records) => {
        if (this.liveTimer || this.typeTimer || !records.some((r) => r.target === this.log || this.inBubble(r.target))) return;
        this.liveTimer = setTimeout(() => {
          this.liveTimer = null;
          this.refresh();
        }, DEBOUNCE_MS);
      });
    }

    /** Opens the bar (with query in its input, if given), selects its text and searches. */
    open(query) {
      const reopened = !this.isOpen;
      if (query != null) this.input.value = query;
      this.isOpen = true;
      this.el.hidden = false;
      this.observer.observe(this.log, { childList: true, subtree: true, characterData: true });
      this.show();
      this.input.focus();
      this.input.select();
      if (reopened || query != null) this.run(false);
    }

    /** Hides the bar and drops its matches and highlights; the query stays for the next open. */
    close() {
      clearTimeout(this.typeTimer);
      clearTimeout(this.liveTimer);
      this.typeTimer = this.liveTimer = null;
      this.observer.disconnect();
      this.isOpen = false;
      this.el.hidden = true;
      this.matches = [];
      this.current = -1;
      this.paint();
      this.hide();
    }

    /** Searches again, keeping the current match when it still exists (no scrolling). */
    refresh() {
      if (this.isOpen && !this.typeTimer) this.run(true);
    }

    /** Selects the match target names (a content-search hit: pickTarget on the snippets around this view's matches),
     *  or the first one for null. exact: false when no match agrees with target (or there is none). */
    goTo(target) {
      if (this.typeTimer) this.run(false);
      if (!this.matches.length) return { exact: false };
      let index = 0;
      let exact = true;
      if (target) ({ index, exact } = FindText.pickTarget(this.matches.map((m) => FindText.makeSnippet(m.text, m.start, m.end)), target));
      this.select(index);
      return { exact };
    }

    /** Shows this bar's highlights (its view became the active one). */
    show() {
      if (!this.isOpen) return;
      CSS.highlights.set("find-match", this.all);
      CSS.highlights.set("find-current", this.cur);
    }

    /** Removes this bar's highlights, unless another bar's are shown. */
    hide() {
      if (CSS.highlights.get("find-match") === this.all) CSS.highlights.delete("find-match");
      if (CSS.highlights.get("find-current") === this.cur) CSS.highlights.delete("find-current");
    }

    key(e) {
      if (e.isComposing) return;
      if (e.key === "Escape") this.dismiss();
      else if (e.key === "Enter" && this.typeTimer) this.run(false); // typed and Enter at once: the first match
      else if (e.key === "Enter") this.step(e.shiftKey ? -1 : 1);
      else if (e.key === "ArrowDown" || e.key === "ArrowUp") this.step(e.key === "ArrowDown" ? 1 : -1);
      else return;
      e.preventDefault();
      e.stopPropagation();
    }

    dismiss() {
      this.close();
      this.onClose?.();
    }

    /** Whether node is inside one of the searched bubbles. */
    inBubble(node) {
      let n = node.nodeType === Node.ELEMENT_NODE ? node : node.parentNode;
      while (n && n.parentNode !== this.log) n = n.parentNode;
      return !!n && n.matches(BUBBLE);
    }

    /** Runs the search for the input's text. keep: the current match stays current if it still exists (else the
     *  same index, within the new count); otherwise the first match is current and scrolled to. */
    run(keep) {
      clearTimeout(this.typeTimer);
      this.typeTimer = null;
      const query = this.input.value;
      const was = this.matches[this.current];
      this.matches = this.search(query);
      const n = this.matches.length;
      let i = n ? 0 : -1;
      if (keep && n && was) {
        i = this.matches.findIndex((m) => m.el === was.el && m.start === was.start);
        if (i === -1) i = Math.min(this.current, n - 1);
      }
      this.current = i;
      this.paint();
      if (!keep) this.reveal();
    }

    /** The matches of query in the log's bubbles, in log order, each with its Range. */
    search(query) {
      const out = [];
      if (!query.trim()) return out;
      for (const el of this.log.children) {
        if (!el.matches(BUBBLE) || el.hidden) continue;
        const { whole, text, offset, nodes } = bubbleText(el);
        let c = this.cache.get(el);
        if (!c || c.whole !== whole || c.query !== query) this.cache.set(el, (c = { whole, query, found: FindText.findMatches(text, query) }));
        for (const { start, end } of c.found) {
          const range = new Range();
          range.setStart(...locate(nodes, start + offset, false));
          range.setEnd(...locate(nodes, end + offset, true));
          out.push({ el, text, start, end, range });
        }
      }
      return out;
    }

    step(dir) {
      const n = this.matches.length;
      if (n) this.select((this.current + dir + n) % n);
    }

    select(i) {
      this.current = i;
      this.paint();
      this.reveal();
    }

    /** The highlights and the counter for the matches and the current one. */
    paint() {
      this.all.clear();
      this.cur.clear();
      for (const m of this.matches) this.all.add(m.range);
      const m = this.matches[this.current];
      if (m) this.cur.add(m.range);
      const n = this.matches.length;
      this.count.textContent = !this.isOpen || !this.input.value.trim() ? "" : n ? `${this.current + 1}/${n}` : "0/0";
    }

    /** Opens the closed <details> the current match is in and centres it in the log. */
    reveal() {
      const m = this.matches[this.current];
      if (!m) return;
      for (let p = m.range.startContainer.parentElement; p && p !== this.log; p = p.parentElement) {
        if (p.tagName === "DETAILS" && !p.open) p.open = true;
      }
      // the match itself, not its element: a long paragraph can be taller than the log
      const r = m.range.getBoundingClientRect();
      const box = this.log.getBoundingClientRect();
      this.log.scrollTop += r.top + r.height / 2 - (box.top + box.height / 2);
    }
  }

  globalThis.FindBar = FindBar;
  if (typeof module !== "undefined") module.exports = FindBar;
})();
