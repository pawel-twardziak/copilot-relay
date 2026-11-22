// Full-screen changes browser: the files changed in the session's repositories (main's changes:* records), the
// versions of the selected file and its git diff; a file link from the chat opens that file alone. Loaded before
// app.js; app.js calls createFilePreview once. File and diff text reach the DOM only as textContent, as escaped
// highlight.js output, or through md() (marked + DOMPurify).
"use strict";

const LINE_H = 18; // px, must match .fp-code line-height in style.css
const OVERSCAN = 40; // extra lines rendered above and below the viewport in the windowed view
// ChangesModel.locate compares paths as the main process's platform does (the renderer has no process.platform)
const PLATFORM = /^win/i.test(navigator.platform) ? "win32" : "other";

function createFilePreview({ api, h, md, onStatus }) {
  const el = document.querySelector("#file-preview");
  const itemsEl = el.querySelector(".fp-items");
  const loadingEl = el.querySelector(".fp-loading");
  const nameEl = el.querySelector(".fp-name");
  const pathEl = el.querySelector(".fp-path");
  const stripEl = el.querySelector(".fp-versions");
  const diffEl = el.querySelector(".fp-diff");
  const content = el.querySelector(".fp-content");
  const mdBtn = el.querySelector('[data-act="md"]');
  const confirmEl = el.querySelector(".fp-confirm");
  const errEl = h("div", { class: "fp-error", hidden: true });
  el.querySelector(".fp-head").after(errEl);
  const confirmPath = el.querySelector(".fp-confirm-path");

  let view = null; // the SessionView the overlay belongs to
  let data = null; // the last list of dataOf's session: { repos, loose }; kept while closed, for the next show
  let dataOf = null;
  let selKey = null; // ChangesModel.key of the selected row
  let sel = null; // { root, rel, file } of the selected row (root null for a loose file; rel is then its path)
  let versions = []; // the strip of the selected row
  let version = null; // the strip entry on show in the diff pane
  let mode = null; // "change": the diff pane shows; "file": the content pane shows; null: nothing on show
  const collapsed = new Set(); // `${sessionId}\n${root}` of the folded groups
  let cur = null; // { path, line, result } of the file on show in the content pane
  let mdSource = false;
  let pending = null; // { view, href, base } waiting for the user's answer to the confirmation
  let confirmOnly = false; // the overlay was opened by a link's confirmation, not by the browser
  let fullText = null; // text of the windowed (plain tier) file on show, for Select all + copy
  let allSelected = false;
  let seq = 0; // a newer read or selection, a close or another session makes older content answers stale
  let listSeq = 0; // a newer list request, a close or another session makes an older list stale
  let refreshSeq = 0; // a newer refresh makes older refreshes stale

  const dirOf = (p) => p.slice(0, Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\")) + 1) || p;
  const baseName = (p) => p.split(/[/\\]/).pop() || p;
  const sizeText = (n) => (n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);
  /** A listed file's absolute path; rel comes from git with forward slashes. */
  const absPath = (root, rel) => {
    const p = `${root.replace(/[\\/]+$/, "")}/${rel}`;
    return PLATFORM === "win32" ? p.replace(/\//g, "\\") : p;
  };
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
  const diffMessage = (text) => diffEl.replaceChildren(h("div", { class: "fp-msg" }, text));
  const setHeader = (name, path) => {
    nameEl.textContent = name;
    pathEl.textContent = path;
    mdBtn.hidden = true;
  };
  function setMode(m) {
    mode = m;
    content.hidden = m !== "file";
    diffEl.hidden = m !== "change";
    if (m !== "file") {
      cur = null;
      fullText = null;
      content.replaceChildren();
      watch(null);
    }
  }

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
      return refocus();
    }
    mdBtn.textContent = "Show rendered";
    const language = result.tier === "highlight" ? FileLinks.previewLanguage(result.name) : null;
    const { scroll, reveal } = codeView(result.text, language, line, result.tier === "plain");
    content.replaceChildren(scroll);
    reveal(top);
    refocus();
  }

  /** A file that cannot be shown (gone, or no longer text): its name and path stay, `text` says why. */
  function showUnavailable(filePath, text) {
    fullText = null;
    setHeader(baseName(filePath), filePath);
    message(text);
  }

  /** Watch the file on show; a path main has not read (an old entry) is refused, which only means no refresh. */
  const watch = (filePath) => api.watchFile(filePath).catch(() => {});

  /** Show a file in the content pane without the confirmation (a loose file of the list). `my` is its selection's seq. */
  async function loadContent(my, filePath) {
    setMode("file");
    const v = view;
    let r;
    try {
      r = await api.readFile(v.cwd, filePath, { viewingCwd: v.cwd, confirmed: true });
    } catch (e) {
      if (my !== seq) return;
      cur = { path: filePath, line: null, result: null };
      showUnavailable(filePath, e.message);
      return watch(filePath); // it may come back
    }
    if (my !== seq) return;
    cur = { path: r.path ?? filePath, line: null, result: r };
    watch(cur.path);
    if (r.notText || r.outside || r.tier === "binary") showUnavailable(filePath, "This file is not a text file.");
    else {
      mdSource = false;
      renderFile(r, null);
    }
  }

  // --- the list -----------------------------------------------------------------------------------------

  /** { root, rel, file } of a key that is in the list, else null. */
  function find(key) {
    if (key == null || !data) return null;
    for (const r of data.repos) for (const f of r.files) if (ChangesModel.key(r.root, f.path) === key) return { root: r.root, rel: f.path, file: f };
    for (const p of data.loose) if (ChangesModel.key(null, p) === key) return { root: null, rel: p, file: null };
    return null;
  }

  const flag = (text, title) => h("span", { class: "fp-flag", title }, text);

  function row(key, title, flags, dir, name, state) {
    return h(
      "div",
      { class: `fp-row${key === selKey ? " active" : ""}`, title, onclick: () => select(key) },
      h("span", { class: "fp-state" }, state),
      h("span", { class: "fp-flags" }, flags),
      // the folder part gives way first, cut at its start (see .fp-dir), so the name stays readable
      h("span", { class: "fp-row-path" }, dir && h("span", { class: "fp-dir" }, h("span", {}, dir)), h("span", { class: "fp-file" }, name)),
    );
  }

  /** A collapsible group; `root` (a repository's) adds the button that removes it from the list. */
  function group(foldId, name, title, root, body) {
    const fold = `${dataOf}\n${foldId}`;
    const shut = collapsed.has(fold);
    const toggle = () => {
      if (!collapsed.delete(fold)) collapsed.add(fold);
      renderList();
    };
    const remove = (e) => {
      e.stopPropagation();
      removeRepo(root);
    };
    return h(
      "div",
      { class: "fp-group" },
      h(
        "div",
        { class: "fp-group-head", title, onclick: toggle },
        h("span", { class: "fp-fold" }, shut ? "▸" : "▾"),
        h("span", { class: "fp-group-name" }, name),
        root != null && h("button", { title: "Remove from the list", onclick: remove }, "✕"),
      ),
      !shut && body,
    );
  }

  function repoGroup(r) {
    const note = (text, cls = "") => h("div", { class: `fp-note${cls}` }, text);
    const body = [];
    if (r.error) body.push(note(r.error, " err"));
    else {
      if (r.note) body.push(note(r.note));
      for (const f of r.files) {
        const { dir, name } = ChangesModel.splitName(f.path);
        const flags = [
          f.touched && flag("●", "Edited by the agent"),
          f.dirtyAtStart && flag("⏱", "Changed before the session"),
          f.committed && !f.uncommitted && flag("✓", "Committed, no uncommitted change now"),
        ];
        body.push(row(ChangesModel.key(r.root, f.path), f.path, flags, dir, name, f.state));
      }
      if (!r.files.length && !r.note) body.push(note("No changes."));
      if (r.truncated) body.push(note("Only the first 2000 files are shown."));
    }
    const since = r.at ? `\nSince ${new Date(r.at).toLocaleString()}` : "";
    return group(r.root, r.name, r.root + since, r.root, body);
  }

  function renderList() {
    if (!data) return itemsEl.replaceChildren();
    const groups = data.repos.map(repoGroup);
    if (data.loose.length) {
      const rows = data.loose.map((p) => row(ChangesModel.key(null, p), p, [flag("●", "Edited by the agent")], "", baseName(p), ""));
      groups.push(group("\0loose", "No repository", "Files the agent edited outside any repository", null, rows));
    }
    if (!groups.length) {
      groups.push(h("div", { class: "fp-empty" }, h("p", {}, "No repository is recorded for this session yet."), h("button", { "data-act": "add" }, "+ Add repository")));
    }
    itemsEl.replaceChildren(...groups);
  }

  /** Ask for the session's list; until it answers the loader shows above the list it had. `after` runs on the answer. */
  async function loadList(after) {
    const my = ++listSeq;
    const v = view;
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
    after();
  }

  /** After a list: the file on show from a link keeps showing and gets its row; otherwise the selection is kept or the first file is picked. */
  const afterList = () => (mode === "file" ? locateCur() : select(ChangesModel.pick(data, selKey)));
  const reloadList = () => loadList(afterList);

  function removeRepo(root) {
    const v = view;
    api.changesRemove(v.sessionId, root).then(() => view === v && reloadList()).catch((e) => fail(e.message));
  }

  function addRepo() {
    const v = view;
    api
      .changesAdd(v.sessionId)
      .then((r) => {
        if (!r || view !== v) return; // the dialog was cancelled, or the browser moved on
        if (r.message) fail(r.message);
        else reloadList();
      })
      .catch((e) => fail(e.message));
  }

  // --- versions -----------------------------------------------------------------------------------------

  function renderStrip() {
    stripEl.hidden = !versions.length; // never an empty strip
    stripEl.replaceChildren(
      ...versions.map((ver) => h("button", { class: `fp-version${ver.id === version ? " active" : ""}`, title: ver.title || null, onclick: () => loadDiff(ver.id) }, ver.label)),
    );
  }

  /** Select a row: its versions in the strip, then (showDiff) the first one's diff. A loose file shows its content. */
  async function select(key, showDiff = true) {
    const my = ++seq;
    sel = find(key);
    selKey = sel ? key : null;
    versions = [];
    version = null;
    renderList();
    renderStrip();
    if (!sel) {
      if (showDiff) {
        setMode(null);
        setHeader("", "");
      }
      return;
    }
    if (sel.root == null) {
      if (showDiff) loadContent(my, sel.rel);
      return;
    }
    const { root, rel, file } = sel;
    if (showDiff) {
      setMode("change");
      errEl.hidden = true;
      setHeader(ChangesModel.splitName(rel).name, absPath(root, rel));
      diffEl.replaceChildren();
    }
    let commits;
    try {
      commits = await api.changesCommits(view.sessionId, root, rel);
    } catch (e) {
      if (my !== seq) return;
      return showDiff ? diffMessage(e.message) : fail(e.message);
    }
    if (my !== seq) return;
    versions = ChangesModel.versions(file, commits);
    renderStrip();
    if (!showDiff) return;
    if (versions.length) loadDiff(versions[0].id);
    else diffMessage("No changes.");
  }

  /** The file on show came from a link: select its row when it is listed (the strip shows, no diff yet). */
  function locateCur() {
    const found = cur && ChangesModel.locate(data, cur.path, PLATFORM);
    let key = found ? ChangesModel.key(found.root, found.rel) : null;
    if (!find(key)) key = cur && data.loose.includes(cur.path) ? ChangesModel.key(null, cur.path) : null;
    if (key == null && find(selKey)?.root === null) key = selKey; // a loose row on show (its path may not be the real one)
    select(key, false);
    itemsEl.querySelector(".fp-row.active")?.scrollIntoView({ block: "nearest" });
  }

  // --- diff ---------------------------------------------------------------------------------------------

  /** Show the diff of the selected row's version `id` (switches to the diff pane). */
  async function loadDiff(id) {
    if (sel?.root == null) return; // only a repository's file has versions
    const my = ++seq;
    const { root, rel, file } = sel;
    const v = view;
    version = id;
    renderStrip();
    setMode("change");
    errEl.hidden = true;
    setHeader(ChangesModel.splitName(rel).name, absPath(root, rel));
    diffEl.replaceChildren();
    try {
      // an untracked file has no diff: its content is the addition
      const r = id === "uncommitted" && file.state === "?" ? { added: true } : await api.changesDiff(v.sessionId, root, rel, id);
      if (my !== seq) return;
      if (r.tooLarge) return diffMessage("This diff is larger than 2 MB. Use Show file.");
      if (r.added) return await showAdded(my, v, root, rel);
      const parsed = DiffView.parse(r.text);
      if (parsed.binary) diffMessage("Binary file.");
      else if (!parsed.lines.length) diffMessage("No changes."); // a mode change, a pure rename, a submodule
      else diffEl.replaceChildren(DiffView.render(parsed, h));
    } catch (e) {
      if (my === seq) diffMessage(e.message);
    }
  }

  /** A new file's diff: its whole content as added lines. */
  async function showAdded(my, v, root, rel) {
    const abs = absPath(root, rel);
    const r = await api.readFile(root, abs, { viewingCwd: v.cwd, confirmed: true });
    if (my !== seq) return;
    if (r.notText || r.tier === "binary") diffMessage("Binary file.");
    else if (r.tier === "too-large") diffMessage(`${r.name} is ${sizeText(r.size)}, too large to preview (the limit is 20 MB). Use "Open in system app".`);
    else diffEl.replaceChildren(DiffView.render(DiffView.added(r.text), h));
  }

  // --- opening ------------------------------------------------------------------------------------------

  function showOverlay(v) {
    if (dataOf !== v.sessionId) {
      // another session: its own list, nothing of the previous one's answers
      listSeq++;
      data = null;
      dataOf = v.sessionId;
      sel = selKey = null;
      versions = [];
      renderList();
      renderStrip();
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
    setMode("file");
    mdSource = line != null;
    cur = { path: r.path, line, result: r };
    watch(r.path);
    renderFile(r, line);
    // its row, when it is listed; the strip stays hidden until then
    sel = selKey = null;
    versions = [];
    renderList();
    renderStrip();
    reloadList();
    return true;
  }

  /** The watched file changed: read it again and show it in place. The list, the mark and the scroll stay as they are. */
  async function refresh(changed) {
    if (el.hidden || !view || mode !== "file" || cur?.path !== changed) return;
    const my = seq;
    const mine = ++refreshSeq;
    const v = view;
    let r;
    try {
      r = await api.readFile(v.cwd, changed, { viewingCwd: v.cwd, confirmed: true });
    } catch (e) {
      if (my !== seq || mine !== refreshSeq || cur?.path !== changed) return;
      cur.result = null;
      return showUnavailable(changed, e.message);
    }
    if (my !== seq || mine !== refreshSeq || cur?.path !== changed) return; // the user has moved on
    cur.result = r;
    if (r.notText || r.outside || r.tier === "binary") showUnavailable(changed, "This file is no longer a text file.");
    else renderFile(r, cur.line, true);
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
    versions = [];
    version = null;
    renderStrip();
    diffEl.replaceChildren();
    setHeader("", "");
    el.hidden = true;
    view = null;
  }

  // --- events -------------------------------------------------------------------------------------------

  el.addEventListener("click", (e) => {
    const act = e.target.closest("button[data-act]")?.dataset.act;
    if (act === "close") close();
    else if (act === "refresh" && view) reloadList();
    else if (act === "add" && view) addRepo();
    else if (act === "system" && view) {
      const target = mode === "file" ? cur?.path : sel?.root != null ? absPath(sel.root, sel.rel) : null;
      if (target) api.openLink(view.cwd, target).catch((err) => fail(err.message));
    } else if (act === "md" && mode === "file" && cur?.result) {
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
        e.preventDefault(); // select the pane on show, not the whole window
        const node = mode === "change" ? diffEl.querySelector(".dv") : content.querySelector(".fp-text, .fp-md");
        if (node) {
          getSelection().selectAllChildren(node);
          allSelected = mode === "file";
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
        data = dataOf = sel = selKey = null;
        renderList();
      }
      for (const fold of collapsed) if (fold.startsWith(`${sessionId}\n`)) collapsed.delete(fold);
    },
    get isOpen() {
      return !el.hidden;
    },
  };
}
