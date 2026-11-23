// Full-screen changes browser: the files changed in the session's repositories (main's changes:* records), their
// commits and the git diff of the selected one; a file link from the chat opens that file alone. This file holds
// the state; changes-list.js draws the list. Diff, File and Both choose the panes: the diff, the file on disk, or the
// two side by side; the file on show is watched. Loaded before app.js; app.js calls createFilePreview once. File and
// diff text reach the DOM only as textContent, as escaped highlight.js output, or through md() (marked + DOMPurify).
"use strict";

const LINE_H = 18; // px, must match .fp-code line-height in style.css
const OVERSCAN = 40; // extra lines rendered above and below the viewport in the windowed view
// ChangesModel.locate compares paths as the main process's platform does (the renderer has no process.platform)
const PLATFORM = /^win/i.test(navigator.platform) ? "win32" : "other";
const PREFS_KEY = "copilot-sessions.changes.v1"; // { view, ratio } of the right side, for all sessions

function createFilePreview({ api, h, md, onStatus }) {
  const el = document.querySelector("#file-preview");
  const itemsEl = el.querySelector(".fp-items");
  const loadingEl = el.querySelector(".fp-loading");
  const nameEl = el.querySelector(".fp-name");
  const pathEl = el.querySelector(".fp-path");
  const panesEl = el.querySelector(".fp-panes");
  const diffEl = el.querySelector(".fp-diff");
  const splitEl = el.querySelector(".fp-split");
  const content = el.querySelector(".fp-content");
  const mdBtn = el.querySelector('[data-act="md"]');
  const viewEl = el.querySelector(".fp-view");
  const confirmEl = el.querySelector(".fp-confirm");
  const errEl = h("div", { class: "fp-error", hidden: true });
  el.querySelector(".fp-head").after(errEl);
  const confirmPath = el.querySelector(".fp-confirm-path");

  let view = null; // the SessionView the overlay belongs to
  let data = null; // the last list of dataOf's session: { repos, loose, opened }; kept while closed, for the next show
  let dataOf = null;
  // the selection: key (a ChangesModel.key; find(sel.key) gives its file) and version ("uncommitted" or a commit's sha)
  let sel = null;
  // "change": a repository file's row is on show (cur is its file); "file": a file without a diff (a loose row, an
  // opened row, a link; a link's row may be selected); null: nothing
  let mode = null;
  let shown = null; // the view on show, "diff", "file" or "both" (ChangesModel.viewFor); null with nothing on show
  let diffOf; // the selection whose diff the diff pane holds or reads; undefined: none (null is a selection too)
  const diskNewer = new Set(); // keys of the files changed on disk since the list was read: their flags are older
  const collapsed = new Set(); // `${sessionId}\n${root}` of the folded groups
  const unfolded = new Set(); // `${sessionId}\n${key}` of the files that show their commits
  // key -> "loading", { error } or the file's commits, for the list on show; every list answer empties it
  const commitCache = new Map();
  let cur = null; // { path, line, result, note } of the file on show; in "change" mode the selected row's file
  let mdSource = false;
  let pending = null; // { view, href, base } waiting for the user's answer to the confirmation
  let confirmOnly = false; // the overlay was opened by a link's confirmation, not by the browser
  let fullText = null; // text of the windowed (plain tier) file on show, for Select all + copy
  let allSelected = false;
  let seq = 0; // a newer read or selection, a close or another session makes older content answers stale
  let diffSeq = 0; // a newer diff request (another version, a refresh) makes older diff answers stale
  // a newer list request, a close or another session makes an older list, and the commits read for it, stale
  let listSeq = 0;
  let refreshSeq = 0; // a newer refresh makes older refreshes stale
  let prefs = { view: "diff", ratio: 0.5 };
  try {
    prefs = ChangesModel.parsePrefs(localStorage.getItem(PREFS_KEY));
  } catch {}

  const dirOf = (p) => p.slice(0, Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\")) + 1) || p;
  const baseName = (p) => p.split(/[/\\]/).pop() || p;
  const sizeText = (n) => (n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);
  const absPath = (root, rel) => ChangesModel.abs(root, rel, PLATFORM);
  /** An error goes into the preview while it is open (the status line is hidden under it), else to the status line. */
  const fail = (text) => {
    if (el.hidden) return onStatus(text);
    if (confirmOnly) {
      close();
      return onStatus(text);
    }
    errEl.textContent = text;
    errEl.hidden = false;
  };
  const message = (text) => content.replaceChildren(h("div", { class: "fp-msg" }, text));
  const isMd = (r) => /\.(md|markdown)$/i.test(r?.name ?? "") && r.tier === "highlight";
  /** The Markdown toggle: shown for a Markdown file in the content pane while that pane shows. */
  const syncMd = () => {
    mdBtn.hidden = content.hidden || !isMd(cur?.result);
    mdBtn.textContent = mdSource ? "Show rendered" : "Show source";
  };
  const setHeader = (name, path) => {
    nameEl.textContent = name;
    pathEl.textContent = path;
    syncMd();
  };
  /** What is on show: mode `m`, in the view the stored one gives for a row of `kind` (ChangesModel.viewFor). Leaving
   *  both modes drops the file and the diff on show. */
  function setMode(m, kind) {
    mode = m;
    shown = m ? ChangesModel.viewFor(prefs.view, kind) : null;
    if (m == null) {
      cur = null;
      fullText = null;
      content.replaceChildren();
      diffEl.replaceChildren();
      diffOf = undefined;
      watch(null);
    }
    setPanes();
  }
  /** The panes of `shown`; the diff pane reads the selection's diff when it first shows for it. */
  function setPanes() {
    const diff = shown === "diff" || shown === "both";
    diffEl.hidden = !diff;
    content.hidden = shown !== "file" && shown !== "both";
    splitEl.hidden = shown !== "both";
    diffEl.style.flex = shown === "both" ? `0 0 ${prefs.ratio * 100}%` : "";
    viewEl.hidden = shown == null;
    for (const b of viewEl.querySelectorAll("button")) b.classList.toggle("active", b.dataset.view === shown);
    syncMd();
    if (diff && diffOf !== sel) loadDiff(sel?.version);
  }
  /** A click on the control: this showing's view, and the stored one for the next showings. */
  function setView(v) {
    prefs.view = v;
    savePrefs();
    const wasHidden = content.hidden;
    shown = v;
    setPanes();
    if (wasHidden) paintFile();
  }
  const savePrefs = () => {
    try {
      localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
    } catch {}
  };

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
      FORBID_ATTR: ["style", "srcset", "background", "poster", "src"],
    });
    for (const ref of box.querySelectorAll(".img-ref")) ref.replaceWith(h("span", { class: "img-alt" }, ref.dataset.alt ?? ""));
    box.addEventListener("click", (e) => {
      const a = e.target.closest("a[href]");
      if (!a) return;
      e.preventDefault();
      const href = a.getAttribute("href");
      if (!href || href.startsWith("#")) return;
      // like main's open:link: "notes2.md:42" (file:line) and "C:\x.md" (drive) are paths, not schemes
      if (/^[a-z][a-z0-9+.-]*:(?!\d)/i.test(href) && !/^file:/i.test(href) && !/^[a-z]:[\\/]/i.test(href)) {
        api.openLink(view.cwd, href).catch((err) => fail(err.message));
        return;
      }
      const base = dirOf(cur.path);
      // main decodes percent escapes itself (resolveTarget), so the link text goes through as written
      openTarget(view, href, base).then((handled) => handled || api.openLink(base, href)).catch((err) => fail(err.message));
    });
    return box;
  }

  /** The one place that turns a read result into what is on screen. `keepScroll` (a refresh) keeps the scroll position. */
  function renderFile(result, line, keepScroll = false) {
    const top = keepScroll ? content.querySelector(".fp-scroll, .fp-md")?.scrollTop : undefined;
    const hadFocus = keepScroll && content.contains(document.activeElement); // replacing the node would drop the keyboard focus
    const refocus = () => {
      if (hadFocus) content.querySelector(".fp-scroll, .fp-md")?.focus({ preventScroll: true });
    };
    errEl.hidden = true;
    fullText = result.tier === "plain" ? result.text : null;
    nameEl.textContent = result.name;
    pathEl.textContent = result.path;
    syncMd();
    if (result.tier === "too-large") {
      return message(`${result.name} is ${sizeText(result.size)}, too large to preview (the limit is 20 MB). Use "Open in system app".`);
    }
    if (isMd(result) && !mdSource) {
      const box = markdownView(result.text);
      content.replaceChildren(box);
      if (top != null) box.scrollTop = top;
      return refocus();
    }
    const language = result.tier === "highlight" ? FileLinks.previewLanguage(result.name) : null;
    const { scroll, reveal } = codeView(result.text, language, line, result.tier === "plain");
    content.replaceChildren(scroll);
    reveal(top);
    refocus();
  }

  /** "file" mode: cur cannot be shown (gone, or no longer text): its name and path stay, `text` says why. */
  function showUnavailable(filePath, text) {
    cur.result = null;
    cur.note = text;
    setHeader(baseName(filePath), filePath);
    paintFile();
  }

  /** Watch the file on show; a path main has not read (an old entry) is refused, which only means no refresh. */
  const watch = (filePath) => api.watchFile(filePath).catch(() => {});

  /** Show a file in the content pane without the confirmation (a loose file of the list). `my` is its selection's seq. */
  async function loadContent(my, filePath) {
    setMode("file", "nodiff");
    const v = view;
    let r;
    try {
      r = await api.readFile(v.cwd, filePath, { viewingCwd: v.cwd, confirmed: true });
    } catch (e) {
      if (my !== seq) return;
      cur = { path: filePath, line: null, result: null, note: null };
      showUnavailable(filePath, readNote(e));
      return watch(filePath); // it may come back
    }
    if (my !== seq) return;
    cur = { path: r.path ?? filePath, line: null, result: r, note: null };
    watch(cur.path);
    if (notText(r)) showUnavailable(filePath, "This file is not a text file.");
    else {
      mdSource = false;
      setHeader(r.name, cur.path); // also while its pane is hidden
      paintFile();
    }
  }

  const notText = (r) => r.notText || r.outside || r.tier === "binary";

  const LEADS_OUT = "This path now leads to a file outside the session folder.";

  /** Read a path that should still be the file `expected` (a real path): unconfirmed; outside the session folder as
   *  confirmed only while its real path is `expected`, before and after that read. Resolves the read's answer, or
   *  { elsewhere: realPath } (nothing of that file) when the path now leads to another file outside the folder. */
  async function readSame(v, expected) {
    const same = (r) => ChangesModel.samePath(r.path, expected, PLATFORM);
    const r = await api.readFile(v.cwd, expected, { viewingCwd: v.cwd });
    if (!r.outside) return r;
    if (!same(r)) return { elsewhere: r.path };
    const again = await api.readFile(v.cwd, expected, { viewingCwd: v.cwd, confirmed: true });
    // swapped between the two reads
    if (again.path != null && !same(again)) return { elsewhere: again.path };
    return again;
  }

  /** Show an opened file's row (`recorded`: its real path when it was opened), read by readSame; when it leads
   *  elsewhere now the confirmation asks, as for a link, over the note. `my` is its selection's seq. */
  async function loadOpened(my, recorded) {
    setMode("file", "nodiff");
    const v = view;
    cur = { path: recorded, line: null, result: null, note: null };
    mdSource = false;
    setHeader(baseName(recorded), recorded);
    paintFile(); // empty while it is read
    let r;
    try {
      r = await readSame(v, recorded);
    } catch (e) {
      if (my !== seq) return;
      showUnavailable(recorded, readNote(e));
      return watch(recorded); // it may come back
    }
    if (my !== seq) return;
    if (r.elsewhere) {
      showUnavailable(recorded, LEADS_OUT); // what stays on Cancel
      return askConfirm(v, recorded, v.cwd, r.elsewhere);
    }
    if (notText(r)) return showUnavailable(recorded, "This file is not a text file.");
    cur = { path: r.path, line: null, result: r, note: null };
    watch(cur.path);
    setHeader(r.name, cur.path);
    paintFile();
  }

  /** What the content pane shows of cur, when it shows. */
  function paintFile(keepScroll = false) {
    if (!mode || content.hidden || !cur) return;
    if (cur.result) return renderFile(cur.result, cur.line, keepScroll);
    fullText = null;
    if (cur.note) message(cur.note);
    else content.replaceChildren(); // still reading
  }

  /** The note for a listed file that cannot be read, from the read's error. */
  const readNote = (e) => (/^File not found/.test(e.message) ? "This file is deleted." : e.message);

  /** "change" mode: read the selected row's file, also while its pane is hidden: main watches only a path it has read. */
  async function loadPaneFile(my, root, rel) {
    const v = view;
    const abs = absPath(root, rel);
    cur = { path: abs, line: null, result: null, note: null };
    mdSource = false;
    fullText = null;
    content.replaceChildren();
    watch(null);
    syncMd();
    let r;
    try {
      r = await api.readFile(root, abs, { viewingCwd: v.cwd, confirmed: true });
    } catch (e) {
      if (my !== seq) return;
      cur.note = readNote(e);
      return paintFile();
    }
    if (my !== seq) return;
    const ok = !notText(r);
    cur = { path: r.path ?? abs, line: null, result: ok ? r : null, note: ok ? null : "This file is not a text file." };
    watch(cur.path);
    paintFile();
  }

  // --- the split ----------------------------------------------------------------------------------------

  /** The divider drags with pointer capture, as dragPanel in app.js; the ratio is saved when it is let go. */
  function dragSplit(e) {
    if (e.button !== 0) return;
    e.preventDefault(); // no text selection while dragging
    try {
      splitEl.setPointerCapture(e.pointerId); // the moves still arrive outside the window
    } catch {}
    const startX = e.clientX;
    const start = diffEl.getBoundingClientRect().width;
    const total = panesEl.getBoundingClientRect().width;
    const move = (m) => {
      prefs.ratio = ChangesModel.clampRatio((start + m.clientX - startX) / total);
      diffEl.style.flex = `0 0 ${prefs.ratio * 100}%`;
    };
    const end = () => {
      removeEventListener("pointermove", move);
      removeEventListener("pointerup", end);
      removeEventListener("pointercancel", end);
      el.classList.remove("fp-resizing");
      savePrefs();
    };
    addEventListener("pointermove", move);
    addEventListener("pointerup", end);
    addEventListener("pointercancel", end);
    el.classList.add("fp-resizing");
  }
  splitEl.addEventListener("pointerdown", dragSplit);

  // --- the list -----------------------------------------------------------------------------------------

  /** { root, rel, file, opened } of a key that is in the list, else null; root null for a loose or an opened file. */
  function find(key) {
    if (key == null || !data) return null;
    for (const r of data.repos) for (const f of r.files) if (ChangesModel.key(r.root, f.path) === key) return { root: r.root, rel: f.path, file: f, opened: false };
    for (const p of data.loose) if (ChangesModel.key(null, p) === key) return { root: null, rel: p, file: null, opened: false };
    for (const p of ChangesModel.openedShown(data, PLATFORM)) if (ChangesModel.key(null, p) === key) return { root: null, rel: p, file: null, opened: true };
    return null;
  }

  function renderList() {
    const fold = (id) => `${dataOf}\n${id}`; // a group's foldId or a file's key
    const on = {
      select: (key) => select(key),
      commit: (key, sha) => selectCommit(key, sha),
      unfold(key) {
        if (!unfolded.delete(fold(key))) {
          unfolded.add(fold(key));
          if (!commitCache.has(key)) readCommits(key);
        }
        renderList();
      },
      toggle(foldId) {
        if (!collapsed.delete(fold(foldId))) collapsed.add(fold(foldId));
        renderList();
      },
      remove: (root) => removeRepo(root),
      add: () => addRepo(),
      forget: (path) => forgetOpened(path),
    };
    const isShut = (foldId) => collapsed.has(fold(foldId));
    const isUnfolded = (key) => unfolded.has(fold(key));
    const opened = ChangesModel.openedShown(data, PLATFORM).map((p) => ({ path: p, ...ChangesModel.openedLabel(p, view?.cwd, PLATFORM) }));
    itemsEl.replaceChildren(...ChangesList.render(data, { h, sel, isShut, isUnfolded, commitsOf: (key) => commitCache.get(key), opened, on }));
  }

  /** Read a listed file's commits into commitCache and redraw. Resolves to them ({ error } when the read failed), or to
   *  undefined when the answer came for an older list or another session and was dropped. */
  async function readCommits(key) {
    const found = find(key);
    if (found?.root == null) return undefined;
    const my = listSeq;
    const d = data;
    commitCache.set(key, "loading");
    let value;
    try {
      value = await api.changesCommits(dataOf, found.root, found.rel);
    } catch (e) {
      value = { error: e.message };
    }
    if (my !== listSeq || d !== data) return undefined;
    commitCache.set(key, value);
    renderList();
    return value;
  }

  /** Ask for the session's list; until it answers the loader shows above the list it had. `after(reads)` runs on the
   *  answer, `reads` the commit reads (key -> readCommits) of the unfolded files that are still listed. */
  async function loadList(after) {
    const my = ++listSeq;
    const v = view;
    errEl.hidden = true;
    loadingEl.hidden = false;
    let d;
    try {
      d = await api.changesList(v.sessionId);
    } catch (e) {
      if (my !== listSeq) return;
      loadingEl.hidden = true;
      return fail(e.message);
    }
    if (my !== listSeq) return;
    loadingEl.hidden = true;
    data = d;
    dataOf = v.sessionId;
    commitCache.clear();
    diskNewer.clear();
    const reads = new Map();
    for (const id of unfolded) {
      const key = id.startsWith(`${dataOf}\n`) ? id.slice(dataOf.length + 1) : null;
      if (key != null && find(key)?.file?.committed) reads.set(key, readCommits(key));
    }
    after(reads);
  }

  /** After a list: the file on show from a link keeps showing and gets its row; otherwise the selection is kept or the
   *  first file is picked. A selected commit is kept while its file's commits still hold it, else the file's
   *  uncommitted version is shown. */
  function afterList(reads) {
    if (mode === "file") return locateCur();
    const key = ChangesModel.pick(data, sel?.key, PLATFORM);
    if (key == null || key !== sel?.key || sel.version === "uncommitted") return select(key);
    const { version } = sel;
    renderList();
    (reads.get(key) ?? readCommits(key)).then((commits) => {
      if (commits === undefined || sel?.key !== key || sel.version !== version) return; // dropped, or the user moved on
      select(key, ChangesModel.keepVersion(version, Array.isArray(commits) ? commits : []));
    });
  }
  const reloadList = () => loadList(afterList);

  function removeRepo(root) {
    const v = view;
    api.changesRemove(v.sessionId, root).then(() => view === v && reloadList()).catch((e) => fail(e.message));
  }

  /** ✕ on an opened file's row: it leaves the session's opened files. */
  function forgetOpened(path) {
    const v = view;
    api.changesForgetOpened(v.sessionId, path).then(() => view === v && reloadList()).catch((e) => fail(e.message));
  }

  function addRepo() {
    const v = view;
    errEl.hidden = true;
    api
      .changesAdd(v.sessionId)
      .then((r) => {
        if (!r || view !== v) return; // the dialog was cancelled, or the browser moved on
        if (r.message) fail(r.message);
        else reloadList();
      })
      .catch((e) => fail(e.message));
  }

  // --- selection ----------------------------------------------------------------------------------------

  /** Select a version of a row; with showDiff its diff and its file, in the view the stored one gives for it. A loose
   *  or an opened file shows its content. Without showDiff only the row is marked (its diff read if the diff pane
   *  shows), and a content read in flight is left alone. */
  function select(key, version = "uncommitted", showDiff = true) {
    const my = showDiff ? ++seq : seq;
    const found = find(key);
    sel = found ? { key, version } : null;
    renderList();
    if (!showDiff) return setPanes();
    if (!found) {
      setMode(null);
      setHeader("", "");
      return;
    }
    if (found.root == null) return found.opened ? loadOpened(my, found.rel) : loadContent(my, found.rel);
    errEl.hidden = true;
    setHeader(ChangesModel.splitName(found.rel).name, absPath(found.root, found.rel));
    setMode("change", version === "uncommitted" ? "change" : "commit"); // reads the diff if its pane shows
    loadPaneFile(my, found.root, found.rel);
  }

  /** A commit row: of the file whose diff is on show only the diff changes (the file pane keeps its file). */
  function selectCommit(key, sha) {
    if (mode !== "change" || sel?.key !== key) return select(key, sha);
    sel = { key, version: sha };
    renderList();
    setMode("change", "commit");
  }

  /** The file on show came from a link or a row without a diff: mark its row in the changes list when it is there, else
   *  its opened row (its diff is read if the diff pane shows). */
  function locateCur() {
    const found = cur && ChangesModel.locate(data, cur.path, PLATFORM);
    let key = found ? ChangesModel.key(found.root, found.rel) : null;
    if (!find(key)) key = cur && data.loose.includes(cur.path) ? ChangesModel.key(null, cur.path) : null;
    // a loose or opened row on show (its path may not be the real one)
    if (key == null && find(sel?.key)?.root === null) key = sel.key;
    if (key == null && cur) {
      const p = ChangesModel.openedShown(data, PLATFORM).find((o) => ChangesModel.samePath(o, cur.path, PLATFORM));
      if (p !== undefined) key = ChangesModel.key(null, p);
    }
    select(key, "uncommitted", false);
    itemsEl.querySelector(".fp-row.active")?.scrollIntoView({ block: "nearest" });
  }

  // --- diff ---------------------------------------------------------------------------------------------

  /** Show the diff of the selected row's version `id` in the diff pane; a selection without one (a loose row, a link
   *  that is not listed) has no changes. `keep` (the file changed on disk): the diff is replaced in place, at the same
   *  scroll position. */
  async function loadDiff(id, keep = false) {
    const found = find(sel?.key);
    const my = seq;
    const mine = ++diffSeq;
    const stale = () => my !== seq || mine !== diffSeq;
    const v = view;
    if (!keep) {
      diffOf = sel;
      errEl.hidden = true;
      diffEl.replaceChildren();
    }
    const { scrollTop, scrollLeft } = diffEl;
    const show = (node) => {
      diffEl.replaceChildren(node);
      diffEl.scrollTop = scrollTop;
      diffEl.scrollLeft = scrollLeft;
    };
    const say = (text) => show(h("div", { class: "fp-msg" }, text));
    if (found?.root == null) return say("No changes."); // only a repository's file has versions
    const { root, rel, file } = found;
    // only committed changes: no git call; a change on disk (keep, or one seen since the list) asks git, the list's
    // flags are older than it
    if (!keep && id === "uncommitted" && !file.uncommitted && !diskNewer.has(sel.key)) return say("No changes.");
    try {
      // an untracked file has no diff: its content is the addition
      const r = id === "uncommitted" && file.state === "?" ? { added: true } : await api.changesDiff(v.sessionId, root, rel, id);
      if (stale()) return;
      if (r.tooLarge) return say("This diff is larger than 2 MB. Use File.");
      if (r.added) return await showAdded(stale, v, root, rel, show, say);
      const parsed = DiffView.parse(r.text);
      if (parsed.binary) say("Binary file.");
      else if (!parsed.lines.length) say("No changes."); // a mode change, a pure rename, a submodule
      else show(DiffView.render(parsed, h));
    } catch (e) {
      if (!stale()) say(e.message);
    }
  }

  /** A new file's diff: its whole content as added lines. */
  async function showAdded(stale, v, root, rel, show, say) {
    const abs = absPath(root, rel);
    const r = await api.readFile(root, abs, { viewingCwd: v.cwd, confirmed: true });
    if (stale()) return;
    if (r.notText || r.tier === "binary") say("Binary file.");
    else if (r.tier === "too-large") say(`${r.name} is ${sizeText(r.size)}, too large to preview (the limit is 20 MB). Use "Open in system app".`);
    else {
      const parsed = DiffView.added(r.text);
      if (parsed.lines.length) show(DiffView.render(parsed, h));
      else say("Empty file.");
    }
  }

  // --- opening ------------------------------------------------------------------------------------------

  function showOverlay(v) {
    if (dataOf !== v.sessionId) {
      // another session: its own list, nothing of the previous one's answers
      listSeq++;
      data = null;
      dataOf = v.sessionId;
      sel = null;
      commitCache.clear();
      renderList();
    }
    view = v;
    el.hidden = false;
    if (!el.contains(document.activeElement)) el.focus();
  }

  function askConfirm(v, href, base, path) {
    pending = { view: v, href, base };
    confirmPath.textContent = path;
    confirmEl.hidden = false;
    if (el.hidden) confirmOnly = true;
    showOverlay(v);
    if (confirmOnly) {
      setMode(null);
      setHeader("", "");
    }
    confirmEl.querySelector('[data-act="allow"]').focus();
  }

  function cancelConfirm() {
    pending = null;
    confirmEl.hidden = true;
    if (confirmOnly) close();
    else el.focus();
  }

  /** Read `href` and show it alone. Resolves false when it is not a text file (the caller opens it another way). */
  async function openTarget(v, href, base, confirmed = false) {
    const my = ++seq;
    let r;
    try {
      r = await api.readFile(base, href, { viewingCwd: v.cwd, confirmed });
    } catch (e) {
      if (my !== seq) return true; // the user has moved on
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
    confirmOnly = false;
    showOverlay(v);
    setMode("file", "nodiff");
    mdSource = line != null;
    cur = { path: r.path, line, result: r, note: null };
    watch(r.path);
    paintFile();
    // its row, when it is listed
    sel = null;
    renderList();
    try {
      await api.changesOpened(v.sessionId, r.path);
    } catch {} // not recorded: the file still shows
    if (my === seq) reloadList();
    return true;
  }

  /** The watched file changed: read it again (readSame: a path that now leads outside the folder shows a note, not the
   *  file, and asks nothing) and show it in place, and with its row's Uncommitted selected its diff too (now if the
   *  diff pane shows, else when it next shows). The list, the mark and the scroll positions stay. */
  async function refresh(changed) {
    if (el.hidden || !view || !mode || cur?.path !== changed) return;
    // a selected repository row is cur's file (in "file" mode the link's own row)
    if (find(sel?.key)?.root != null) {
      diskNewer.add(sel.key);
      if (sel.version === "uncommitted") {
        if (diffEl.hidden) diffOf = undefined;
        else loadDiff("uncommitted", true);
      }
    }
    const my = seq;
    const mine = ++refreshSeq;
    const v = view;
    const stale = () => my !== seq || mine !== refreshSeq || cur?.path !== changed; // the user has moved on
    let r;
    try {
      r = await readSame(v, changed);
    } catch (e) {
      if (stale()) return;
      if (mode === "file") return showUnavailable(changed, readNote(e));
      cur.result = null;
      cur.note = readNote(e);
      return paintFile();
    }
    if (stale()) return;
    if (r.elsewhere) {
      if (mode === "file") return showUnavailable(changed, LEADS_OUT);
      cur.result = null;
      cur.note = LEADS_OUT;
      return paintFile();
    }
    if (!notText(r)) {
      cur.result = r;
      cur.note = null;
    } else if (mode === "file") return showUnavailable(changed, "This file is no longer a text file.");
    else {
      cur.result = null;
      cur.note = "This file is no longer a text file.";
    }
    paintFile(true);
  }
  api.onFileChanged(refresh);

  /** The list and the selection stay for the next show of the same session. */
  function close() {
    seq++;
    listSeq++;
    setMode(null);
    errEl.hidden = true;
    pending = null;
    confirmOnly = false;
    confirmEl.hidden = true;
    loadingEl.hidden = true;
    setHeader("", "");
    el.hidden = true;
    view = null;
  }

  // --- events -------------------------------------------------------------------------------------------

  el.addEventListener("click", (e) => {
    const pick = e.target.closest(".fp-view button[data-view]")?.dataset.view;
    if (pick && shown) return setView(pick);
    const act = e.target.closest("button[data-act]")?.dataset.act;
    if (act === "close") close();
    else if (act === "refresh" && view) reloadList();
    else if (act === "add" && view) addRepo();
    else if (act === "system" && view) {
      if (cur?.path) api.openLink(view.cwd, cur.path).catch((err) => fail(err.message));
    } else if (act === "md" && !content.hidden && cur?.result) {
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
          if (confirmOnly && !el.hidden) close(); // nothing on show: do not leave an empty overlay
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
        e.preventDefault(); // select the pane that has the focus (else the diff, if it shows), not the whole window
        const inFile = !content.hidden && (diffEl.hidden || content.contains(document.activeElement));
        const node = inFile ? content.querySelector(".fp-text, .fp-md") : diffEl.querySelector(".dv");
        if (node) {
          getSelection().selectAllChildren(node);
          allSelected = inFile;
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
        const items = [...scope.querySelectorAll("button:not([hidden]), .fp-scroll, .fp-md, .fp-diff")].filter((x) => x.offsetParent !== null);
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
    if (el.hidden || !allSelected || fullText == null || getSelection().isCollapsed) return;
    e.clipboardData.setData("text/plain", fullText);
    e.preventDefault();
  });

  setMode(null);

  return {
    /** Resolves false when the target is not a text file; the caller then opens it with the system. */
    open: (v, href, base = v.cwd) => openTarget(v, href, base),
    /** Open the browser on the session's changes: the list is read again, the selection kept when still listed. */
    show(v) {
      seq++;
      confirmOnly = false;
      showOverlay(v);
      setMode(null);
      reloadList();
    },
    close,
    /** The session is deleted: the browser closes if it shows it, and its list goes. */
    forget(sessionId) {
      if (view?.sessionId === sessionId) close();
      if (dataOf === sessionId) {
        data = dataOf = sel = null;
        commitCache.clear();
        renderList();
      }
      for (const fold of collapsed) if (fold.startsWith(`${sessionId}\n`)) collapsed.delete(fold);
      for (const id of unfolded) if (id.startsWith(`${sessionId}\n`)) unfolded.delete(id);
    },
    get isOpen() {
      return !el.hidden;
    },
  };
}
