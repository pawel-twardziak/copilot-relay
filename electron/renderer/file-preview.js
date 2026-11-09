// Full-screen file preview with a per-session list of recent files. Loaded before app.js; app.js calls
// createFilePreview once. File text reaches the DOM only as textContent, as escaped highlight.js output, or
// through md() (marked + DOMPurify).
"use strict";

const FILES_KEY = "copilot-sessions.files.v1";
const LINE_H = 18; // px, must match .fp-code line-height in style.css
const OVERSCAN = 40; // extra lines rendered above and below the viewport in the windowed view

function createFilePreview({ api, h, md, onStatus, onChange = () => {} }) {
  const el = document.querySelector("#file-preview");
  const itemsEl = el.querySelector(".fp-items");
  const nameEl = el.querySelector(".fp-name");
  const pathEl = el.querySelector(".fp-path");
  const content = el.querySelector(".fp-content");
  const mdBtn = el.querySelector('[data-act="md"]');
  const confirmEl = el.querySelector(".fp-confirm");
  const errEl = h("div", { class: "fp-error", hidden: true });
  content.before(errEl);
  const confirmPath = el.querySelector(".fp-confirm-path");

  let recent = {};
  try {
    recent = FileLinks.parseRecent(localStorage.getItem(FILES_KEY));
  } catch {}
  const gone = new Map(); // sessionId -> Set of paths that could not be read; they stay listed until closed
  let view = null; // the SessionView the overlay belongs to
  let cur = null; // { path, line, result } of the file on show
  let mdSource = false;
  let pending = null; // { view, href, base } waiting for the user's answer to the confirmation
  let fullText = null; // text of the windowed (plain tier) file on show, for Select all + copy
  let allSelected = false;
  let seq = 0; // a newer read or a close makes older reads stale
  let refreshSeq = 0; // a newer refresh makes older refreshes stale

  const listOf = (id) => recent[id] ?? [];
  const save = () => {
    try {
      localStorage.setItem(FILES_KEY, JSON.stringify(recent));
    } catch {}
  };
  const setList = (id, list) => {
    if (list.length) recent[id] = list;
    else delete recent[id];
    save();
    onChange(id);
  };
  const decode = (s) => {
    try {
      return decodeURIComponent(s);
    } catch {
      return s;
    }
  };
  const dirOf = (p) => p.slice(0, Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\")) + 1) || p;
  const sizeText = (n) => (n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);
  /** An error goes into the preview while it is open (the status line is hidden under it), else to the status line. */
  const fail = (text) => {
    if (el.hidden) return onStatus(text);
    if (!cur && confirmEl.hidden) {
      close();
      return onStatus(text);
    }
    errEl.textContent = text;
    errEl.hidden = false;
  };
  const message = (text) => content.replaceChildren(h("div", { class: "fp-msg" }, text));

  // --- one file's content -------------------------------------------------------------------------------

  /** Text split into lines; one trailing newline does not make an extra empty line. */
  const linesOf = (text) => {
    const lines = text.split("\n");
    if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
    return lines;
  };

  /** Code with a line-number gutter that is not part of the selectable text. `windowed` renders only the lines
   *  near the viewport (fixed line height, one text node per side), which keeps 20 MB of plain text responsive;
   *  otherwise all lines are rendered, the gutter as one joined text. */
  function codeView(text, language, line, windowed) {
    const lines = linesOf(text);
    const n = lines.length;
    const gutter = h("pre", { class: "fp-gutter", "aria-hidden": "true" });
    gutter.style.minWidth = `${String(n).length + 2}ch`;
    const code = h("code");
    const mark = h("div", { class: "fp-mark" });
    const scroll = h("div", { class: "fp-scroll", tabindex: "0" });
    const box = h("div", { class: "fp-code" });
    const numbers = (from, to) => Array.from({ length: to - from }, (_, i) => from + i + 1).join("\n");
    let render = () => {};

    if (windowed) {
      const win = h("div", { class: "fp-win" }, gutter, h("pre", { class: "fp-text" }, code));
      box.style.height = `${n * LINE_H}px`;
      box.append(win, mark);
      let shown = "";
      render = () => {
        const first = Math.max(0, Math.floor(scroll.scrollTop / LINE_H) - OVERSCAN);
        const last = Math.min(n, Math.ceil((scroll.scrollTop + scroll.clientHeight) / LINE_H) + OVERSCAN);
        if (shown === `${first}:${last}`) return;
        shown = `${first}:${last}`;
        gutter.textContent = numbers(first, last);
        code.textContent = lines.slice(first, last).join("\n");
        win.style.top = `${first * LINE_H}px`;
      };
      let queued = false;
      scroll.addEventListener("scroll", () => {
        if (queued) return;
        queued = true;
        requestAnimationFrame(() => {
          queued = false;
          render();
        });
      });
    } else {
      gutter.textContent = numbers(0, n);
      const source = lines.join("\n");
      if (language && hljs.getLanguage(language)) {
        code.className = "hljs";
        code.innerHTML = hljs.highlight(source, { language, ignoreIllegals: true }).value;
      } else code.textContent = source;
      box.append(h("div", { class: "fp-flat" }, gutter, h("pre", { class: "fp-text" }, code)), mark);
    }

    scroll.append(box);
    mark.hidden = !(line >= 1 && line <= n);
    if (!mark.hidden) mark.style.top = `${(line - 1) * LINE_H}px`;
    // the caller attaches `scroll`, then calls reveal once it has a height; `keepTop` (a refresh) replaces the jump to the mark
    const reveal = (keepTop) => {
      if (keepTop != null) scroll.scrollTop = keepTop;
      else if (!mark.hidden) scroll.scrollTop = Math.max(0, (line - 1) * LINE_H - scroll.clientHeight / 3);
      render();
    };
    return { scroll, reveal };
  }

  /** Rendered Markdown. Clicks stay inside the preview; images are not loaded, their alt text is shown. */
  function markdownView(text) {
    const box = h("div", { class: "fp-md", tabindex: "0" });
    // stricter than the chat: raw HTML in a file must not fetch images or restyle the window
    box.innerHTML = md(text, {
      FORBID_TAGS: ["img", "picture", "source", "video", "audio", "style", "svg", "math", "link", "object", "embed", "iframe", "image"],
      FORBID_ATTR: ["style", "srcset", "background", "poster"],
    });
    for (const ref of box.querySelectorAll(".img-ref")) ref.replaceWith(h("span", { class: "img-alt" }, ref.dataset.alt ?? ""));
    box.addEventListener("click", (e) => {
      const a = e.target.closest("a[href]");
      if (!a) return;
      e.preventDefault();
      const href = a.getAttribute("href");
      if (!href || href.startsWith("#")) return;
      if (/^[a-z][a-z0-9+.-]*:/i.test(href) && !/^file:/i.test(href)) {
        api.openLink(view.cwd, href).catch((err) => fail(err.message));
        return;
      }
      const base = dirOf(cur.path);
      const target = decode(href);
      openTarget(view, target, base).then((handled) => handled || api.openLink(base, target)).catch((err) => fail(err.message));
    });
    return box;
  }

  /** The one place that turns a read result into what is on screen. `keepScroll` (a refresh) keeps the scroll position. */
  function renderFile(result, line, keepScroll = false) {
    const top = keepScroll ? content.querySelector(".fp-scroll, .fp-md")?.scrollTop : undefined;
    errEl.hidden = true;
    fullText = result.tier === "plain" ? result.text : null;
    const isMd = /\.(md|markdown)$/i.test(result.name) && result.tier === "highlight";
    mdBtn.hidden = !isMd;
    nameEl.textContent = result.name;
    pathEl.textContent = result.path;
    if (result.tier === "too-large") {
      return message(`${result.name} is ${sizeText(result.size)}, too large to preview (the limit is 20 MB). Use "Open in system app".`);
    }
    if (isMd && !mdSource) {
      mdBtn.textContent = "Show source";
      const box = markdownView(result.text);
      content.replaceChildren(box);
      if (top != null) box.scrollTop = top;
      return;
    }
    mdBtn.textContent = "Show rendered";
    const language = result.tier === "highlight" ? FileLinks.previewLanguage(result.name) : null;
    const { scroll, reveal } = codeView(result.text, language, line, result.tier === "plain");
    content.replaceChildren(scroll);
    reveal(top);
  }

  /** A file that cannot be shown (gone, or no longer text): its name and path stay, `text` says why. */
  function showUnavailable(filePath, text) {
    fullText = null;
    nameEl.textContent = filePath.split(/[/\\]/).pop();
    pathEl.textContent = filePath;
    mdBtn.hidden = true;
    message(text);
  }

  /** Watch the file on show; a path main has not read (an old entry) is refused, which only means no refresh. */
  const watch = (filePath) => api.watchFile(filePath).catch(() => {});

  // --- the list -----------------------------------------------------------------------------------------

  function renderList() {
    const missing = gone.get(view.sessionId);
    itemsEl.replaceChildren(
      ...listOf(view.sessionId).map((entry) =>
        h(
          "div",
          { class: `fp-item${entry.path === cur?.path ? " active" : ""}${missing?.has(entry.path) ? " gone" : ""}`, title: entry.path, onclick: () => loadEntry(entry) },
          h("span", { class: "fp-item-name" }, entry.path.split(/[/\\]/).pop() || entry.path),
          h("button", { title: "Close this file", onclick: (e) => { e.stopPropagation(); closeEntry(entry.path); } }, "✕"),
        ),
      ),
    );
  }

  function closeEntry(path) {
    const id = view.sessionId;
    gone.get(id)?.delete(path);
    const list = FileLinks.recentRemove(listOf(id), path);
    setList(id, list);
    if (!list.length) return close();
    if (cur?.path === path) loadEntry(list[0]);
    else renderList();
  }

  /** Show a file from the list; it was confirmed when first opened, so no second prompt. */
  async function loadEntry(entry) {
    const my = ++seq;
    const v = view;
    let r;
    try {
      r = await api.readFile(v.cwd, entry.path, { viewingCwd: v.cwd, confirmed: true });
    } catch (e) {
      if (my !== seq) return;
      if (!gone.has(v.sessionId)) gone.set(v.sessionId, new Set());
      gone.get(v.sessionId).add(entry.path);
      cur = { path: entry.path, line: entry.line, result: null };
      showUnavailable(entry.path, e.message);
      watch(entry.path); // it may come back
      return renderList();
    }
    if (my !== seq) return;
    gone.get(v.sessionId)?.delete(entry.path);
    cur = { path: r.path ?? entry.path, line: entry.line, result: r };
    watch(cur.path);
    if (r.notText || r.outside || r.tier === "binary") showUnavailable(entry.path, "This file is no longer a text file.");
    else {
      mdSource = entry.line != null;
      renderFile(r, entry.line);
    }
    renderList();
  }

  // --- opening ------------------------------------------------------------------------------------------

  function showOverlay(v) {
    view = v;
    el.hidden = false;
    if (!el.contains(document.activeElement)) el.focus();
  }

  function askConfirm(v, href, base, path) {
    pending = { view: v, href, base };
    confirmPath.textContent = path;
    confirmEl.hidden = false;
    showOverlay(v);
    if (!cur) {
      nameEl.textContent = "";
      pathEl.textContent = "";
      mdBtn.hidden = true;
      content.replaceChildren();
    }
    renderList();
    confirmEl.querySelector('[data-act="allow"]').focus();
  }

  function cancelConfirm() {
    pending = null;
    confirmEl.hidden = true;
    if (!cur) close();
    else el.focus();
  }

  /** Read `href` and show it. Resolves false when it is not a text file (the caller opens it another way). */
  async function openTarget(v, href, base, confirmed = false) {
    const my = ++seq;
    let r;
    try {
      r = await api.readFile(base, href, { viewingCwd: v.cwd, confirmed });
    } catch (e) {
      fail(e.message);
      return true;
    }
    if (my !== seq) return true;
    if (r.notText || r.tier === "binary") return false;
    if (r.outside) {
      askConfirm(v, href, base, r.path);
      return true;
    }
    const line = FileLinks.splitPathSuffix(href).line;
    pending = null;
    confirmEl.hidden = true;
    showOverlay(v);
    mdSource = line != null;
    cur = { path: r.path, line, result: r };
    watch(r.path);
    setList(v.sessionId, FileLinks.recentAdd(listOf(v.sessionId), { path: r.path, line }));
    gone.get(v.sessionId)?.delete(r.path);
    renderFile(r, line);
    renderList();
    return true;
  }

  /** The watched file changed: read it again and show it in place. The list, the mark and the scroll stay as they are. */
  async function refresh(changed) {
    if (el.hidden || !view || cur?.path !== changed) return;
    const my = seq;
    const mine = ++refreshSeq;
    const v = view;
    let r;
    try {
      r = await api.readFile(v.cwd, changed, { viewingCwd: v.cwd, confirmed: true });
    } catch (e) {
      if (my !== seq || mine !== refreshSeq || cur?.path !== changed) return;
      if (!gone.has(v.sessionId)) gone.set(v.sessionId, new Set());
      gone.get(v.sessionId).add(changed);
      cur.result = null;
      showUnavailable(changed, e.message);
      return renderList();
    }
    if (my !== seq || mine !== refreshSeq || cur?.path !== changed) return; // the user has moved on
    gone.get(v.sessionId)?.delete(changed);
    cur.result = r;
    if (r.notText || r.outside || r.tier === "binary") showUnavailable(changed, "This file is no longer a text file.");
    else renderFile(r, cur.line, true);
    renderList();
  }
  api.onFileChanged(refresh);

  function close() {
    watch(null);
    seq++;
    errEl.hidden = true;
    fullText = null;
    pending = null;
    confirmEl.hidden = true;
    el.hidden = true;
    view = null;
    cur = null;
    content.replaceChildren();
  }

  // --- events -------------------------------------------------------------------------------------------

  el.addEventListener("click", (e) => {
    const act = e.target.closest("button[data-act]")?.dataset.act;
    if (act === "close") close();
    else if (act === "system" && cur) api.openLink(view.cwd, cur.path).catch((err) => fail(err.message));
    else if (act === "md" && cur?.result) {
      mdSource = !mdSource;
      renderFile(cur.result, cur.line);
    } else if (act === "allow" && pending) {
      const p = pending;
      pending = null;
      confirmEl.hidden = true;
      errEl.hidden = true;
      openTarget(p.view, p.href, p.base, true)
        .then((handled) => handled || api.openLink(p.base, p.href))
        .catch((err) => fail(err.message))
        .finally(() => {
          if (!cur && !el.hidden) close(); // nothing on show: do not leave an empty overlay
        });
    } else if (act === "deny") cancelConfirm();
  });

  const ZOOM_KEY = /^(\+|=|-|_|0)$/;
  // while open the preview has the keyboard: no chat shortcuts underneath. Default actions (copy, select all,
  // scrolling) are left alone; only Esc and Tab are handled here.
  document.addEventListener(
    "keydown",
    (e) => {
      if (el.hidden) return;
      if ((e.ctrlKey || e.metaKey) && ZOOM_KEY.test(e.key)) return; // the app's zoom guard swallows these
      e.stopImmediatePropagation();
      if ((e.ctrlKey || e.metaKey) && !e.altKey && e.key.toLowerCase() === "a") {
        e.preventDefault(); // select the file, not the whole window
        const node = content.querySelector(".fp-text, .fp-md");
        if (node) {
          getSelection().selectAllChildren(node);
          allSelected = true;
        }
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        if (!confirmEl.hidden) cancelConfirm();
        else close();
      } else if (e.key === "Tab") {
        e.preventDefault(); // focus stays in the preview
        const scope = confirmEl.hidden ? el : confirmEl;
        const items = [...scope.querySelectorAll("button:not([hidden]), .fp-scroll, .fp-md")].filter((x) => x.offsetParent !== null);
        if (!items.length) return;
        const i = items.indexOf(document.activeElement);
        items[(i + (e.shiftKey ? -1 : 1) + items.length) % items.length].focus();
      }
    },
    true,
  );

  el.addEventListener("mousedown", () => (allSelected = false));
  // Select all on the windowed view only covers the rendered lines: copy then supplies the whole file
  document.addEventListener("copy", (e) => {
    const sel = getSelection();
    if (el.hidden || !allSelected || fullText == null || sel.isCollapsed) return;
    e.clipboardData.setData("text/plain", fullText);
    e.preventDefault();
  });

  return {
    /** Resolves false when the target is not a text file; the caller then opens it with the system. */
    open: (v, href, base = v.cwd) => openTarget(v, href, base),
    /** Reopen the overlay on the session's list. */
    show(v) {
      const list = listOf(v.sessionId);
      if (!list.length) return;
      showOverlay(v);
      cur = null;
      loadEntry(list[0]);
      renderList();
    },
    close,
    /** The session is deleted: its list goes too. */
    forget(sessionId) {
      if (view?.sessionId === sessionId) close();
      gone.delete(sessionId);
      setList(sessionId, []);
    },
    count: (sessionId) => listOf(sessionId).length,
    get isOpen() {
      return !el.hidden;
    },
  };
}
