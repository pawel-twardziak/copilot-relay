// Renderer: session list + one chat view per open session. Talks to the main process via window.api.
"use strict";

// `api` is the global exposed by preload.cjs (window.api)
const $ = (sel, el = document) => el.querySelector(sel);

/** Tiny DOM helper: h("div", { class: "x", onclick }, child, "text") */
function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs ?? {})) {
    if (v == null || v === false) continue;
    if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else if (k === "class") el.className = v;
    else el.setAttribute(k, v === true ? "" : v);
  }
  for (const c of children.flat()) if (c != null && c !== false) el.append(c instanceof Node ? c : String(c));
  return el;
}

// ---------------------------------------------------------------------------
// copying

/** Small "Copy" button; getText is called on click. */
function copyBtn(getText, label = "Copy") {
  const b = h("button", { class: "copy", title: "Copy to clipboard" }, label);
  b.addEventListener("click", async (e) => {
    e.stopPropagation();
    e.preventDefault();
    try {
      await api.copy(String(getText() ?? ""));
      b.textContent = "Copied";
    } catch {
      b.textContent = "Failed";
    }
    setTimeout(() => (b.textContent = label), 1200);
  });
  return b;
}

/** Give every <pre> inside `root` its own copy button (pre._copy overrides the copied text, e.g. a diff's new file). */
function decoratePres(root) {
  for (const pre of root.querySelectorAll("pre")) {
    if (pre.parentElement?.classList.contains("codewrap")) continue;
    const wrap = h("div", { class: "codewrap" });
    pre.replaceWith(wrap);
    wrap.append(pre, copyBtn(() => pre._copy ?? (pre.querySelector("code") ?? pre).textContent));
  }
}

const URL_RE = /\bhttps?:\/\/[^\s<>"'`]+/g;

/** Drop sentence punctuation after a URL, and closing brackets that have no opening one inside it
 *  ("(see https://x.dev/a)" → "https://x.dev/a", but ".../Rust_(language)" keeps its ")"). */
function trimUrl(u) {
  for (;;) {
    const last = u.at(-1);
    const pair = { ")": "(", "]": "[", "}": "{" }[last];
    if (".,;:!?'\"".includes(last)) u = u.slice(0, -1);
    else if (pair && u.split(pair).length <= u.split(last).length - 1) u = u.slice(0, -1);
    else return u;
  }
}

/** Turn plain-text URLs inside `root` into links (existing links and code blocks are left alone).
 *  codeOnly: only inside inline code (for rendered Markdown, where marked has already linked the plain text). */
function linkify(root, { codeOnly = false } = {}) {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: (n) => {
      const parent = n.parentElement;
      if (!n.nodeValue.includes("http") || parent?.closest("a, button, pre")) return NodeFilter.FILTER_REJECT;
      // inside inline code only a code span that is nothing but a URL becomes a link (not `curl https://…`)
      const code = parent?.closest("code");
      if (codeOnly && !code) return NodeFilter.FILTER_REJECT;
      if (code && !/^https?:\/\/\S+$/.test(code.textContent.trim())) return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    },
  });
  const nodes = [];
  while (walker.nextNode()) nodes.push(walker.currentNode);
  for (const node of nodes) {
    const text = node.nodeValue;
    if (!text.match(URL_RE)) continue; // (not .test(): it would move lastIndex and matchAll would start after the URL)
    const frag = document.createDocumentFragment();
    let last = 0;
    for (const m of text.matchAll(URL_RE)) {
      const url = trimUrl(m[0]);
      frag.append(text.slice(last, m.index), h("a", { href: url }, url));
      last = m.index + url.length;
    }
    frag.append(text.slice(last));
    node.replaceWith(frag);
  }
}

/** A finished chat bubble (user prompt or relay message) with a copy button and a Markdown export. */
function bubble(cls, text, from) {
  const el = h("div", { class: `msg ${cls}` }, from && h("div", { class: "from" }, `from ${from}`), h("div", { class: "body" }, text), copyBtn(() => text));
  linkify(el);
  el._md = () => `**${from ? `from ${from}` : "You"}:**\n\n${text}`;
  el._matchText = () => text; // what fork/delete look for in the session history
  return el;
}

marked.use({ gfm: true, breaks: false });
// DOMPurify's default URI rules, plus file: for <a href> only. Links are opened by the main process on click, which
// refuses network paths. An <img src="file://host/..."> would be fetched on render (on Windows an SMB connection that
// leaks the NTLM hash), so file: stays forbidden everywhere else (and the CSP has no 'self' for images).
DOMPurify.addHook("uponSanitizeAttribute", (node, data) => {
  if (node.nodeName === "A" && data.attrName === "href" && /^file:/i.test(data.attrValue)) data.forceKeepAttr = true;
});
const md = (text) => DOMPurify.sanitize(marked.parse(text ?? ""), { ADD_ATTR: ["target"] });

// image types and size limit come from the main process, which attaches the images (one source of truth)
let imageConfigPromise;
const imageConfig = () =>
  (imageConfigPromise ??= api.imageConfig().catch((e) => {
    imageConfigPromise = null; // don't cache a failure: the next paste asks again
    throw e;
  }));

/** Decode any image the browser understands. createImageBitmap does not decode SVG, an <img> from a data: URL does. */
function decodeImage(file) {
  if (file.type !== "image/svg+xml") return createImageBitmap(file);
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error);
    reader.onload = () => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error("could not decode the SVG"));
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
  });
}

/**
 * Make a pasted image attachable: supported types within the size limit are kept as they are. Anything else
 * (bmp, svg, tiff…, or a large Retina/4K screenshot) is redrawn, scaled down to the maximum side, and saved as
 * PNG, or as JPEG when the PNG is still too large, so the model always gets to see it.
 */
async function toAttachable(file) {
  const cfg = await imageConfig();
  const bytesOf = async (blob) => new Uint8Array(await blob.arrayBuffer());
  if (cfg.mimes.includes(file.type) && file.size <= cfg.maxBytes) return { bytes: await bytesOf(file), mime: file.type };
  const img = await decodeImage(file);
  try {
    const w0 = img.naturalWidth || img.width || 512;
    const h0 = img.naturalHeight || img.height || 512;
    const scale = Math.min(1, cfg.maxSide / Math.max(w0, h0));
    const [w, hgt] = [Math.max(1, Math.round(w0 * scale)), Math.max(1, Math.round(h0 * scale))];
    const draw = (background) => {
      const canvas = new OffscreenCanvas(w, hgt);
      const ctx = canvas.getContext("2d");
      if (background) {
        ctx.fillStyle = background; // JPEG has no transparency
        ctx.fillRect(0, 0, w, hgt);
      }
      ctx.drawImage(img, 0, 0, w, hgt);
      return canvas;
    };
    let blob = await draw(null).convertToBlob({ type: "image/png" });
    if (blob.size > cfg.maxBytes) {
      const canvas = draw("#fff");
      for (const quality of [0.9, 0.8, 0.65, 0.5]) {
        blob = await canvas.convertToBlob({ type: "image/jpeg", quality });
        if (blob.size <= cfg.maxBytes) break;
      }
    }
    if (blob.size > cfg.maxBytes) throw new Error("the image is too large even after scaling it down");
    return { bytes: await bytesOf(blob), mime: blob.type };
  } finally {
    img.close?.(); // free the decoded ImageBitmap right away
  }
}

const shortTitle = (t) => {
  const line = String(t ?? "").split("\n").find((l) => l.trim()) ?? "";
  return line.length > 90 ? line.slice(0, 89) + "…" : line || "Untitled session";
};
const baseName = (p) => String(p ?? "").split(/[\\/]/).filter(Boolean).pop() ?? p;
function ago(iso) {
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (!isFinite(s)) return "";
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  if (s < 86400 * 30) return `${Math.floor(s / 86400)} d ago`;
  return new Date(iso).toLocaleDateString();
}

// ---------------------------------------------------------------------------
// state

let sessions = []; // from session/list: { sessionId, cwd, title, updatedAt }
const views = new Map(); // sessionId -> SessionView
let activeId = null;

// ---------------------------------------------------------------------------
// session view

class SessionView {
  constructor({ sessionId, cwd, title }) {
    Object.assign(this, { sessionId, cwd, title: title ?? "" });
    this.busy = false;
    this.dead = false;
    this.run = null; // current streamed block { type, el, text }
    this.tools = new Map();
    this.renderQueued = false;
    this.inbox = []; // relay messages waiting for the session to be idle
    this.relayName = null;
    this.turn = 0; // user/relay messages so far = the turn ordinal of the latest one (see append)
    this.turnText = null; // getter for the latest user message's text
    this.turnReplied = false; // the latest turn's reply already has fork/delete actions
    this.historyOp = false; // a fork/delete is running

    this.titleEl = h("b", { class: "renamable", onclick: () => this.renameSession() });
    this.selects = h("span", { class: "selects" });
    this.relayChip = h("button", { class: "relay-chip", hidden: true, onclick: () => this.renameRelay() });
    this.usageFill = h("span", { class: "fill" });
    this.usageLabel = h("span", { class: "label" }, "context: —");
    this.usageChip = h("span", { class: "usage-chip" }, h("span", { class: "meter" }, this.usageFill), this.usageLabel);
    this.log = h("div", { class: "log" });
    this.input = h("textarea", { rows: 2, placeholder: "Message Copilot…  (Enter to send, Shift+Enter for a new line, Esc to stop)" });
    this.sendBtn = h("button", { class: "primary", onclick: () => this.send() }, "Send");
    this.stopBtn = h("button", { onclick: () => this.cancel(), disabled: true }, "Stop");
    this.statusEl = h("div", { class: "status-line" });
    this.agentOption = undefined; // latest ACP "agent" config option
    this.agentPicker = h("select", { class: "agent-picker", hidden: true });
    this.agentPicker.addEventListener("change", () => this.chooseAgent(this.agentPicker.value));

    this.el = h(
      "section",
      { class: "session-view" },
      h(
        "div",
        { class: "head" },
        h("div", { class: "title" }, this.titleEl, h("a", { title: "Open folder", onclick: () => api.openPath(this.cwd).catch((e) => this.error(e.message)) }, cwd)),
        this.relayChip,
        this.usageChip,
        this.selects,
        h("button", { title: "Copy the whole conversation as Markdown", onclick: (e) => this.copyThread(e.currentTarget) }, "Copy thread"),
        h("button", { class: "danger", title: "Close this session in the app (it stays resumable)", onclick: () => closeView(this.sessionId) }, "Close"),
      ),
      this.log,
      h("div", { class: "composer" }, this.input, this.agentPicker, h("div", { class: "btns" }, this.sendBtn, this.stopBtn)),
      this.statusEl,
    );
    this.input.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
        e.preventDefault();
        this.send();
      } else if (e.key === "Escape" && this.busy) this.cancel();
    });
    this.input.addEventListener("input", () => this.autosize());
    this.input.addEventListener("paste", (e) => this.onFiles(e, e.clipboardData));
    this.input.addEventListener("dragover", (e) => e.preventDefault());
    this.input.addEventListener("drop", (e) => this.onFiles(e, e.dataTransfer));
    // left click, Enter on a focused link (fires "click") and middle click all go through openLink
    const onLink = (e) => {
      if (e.type === "auxclick" && e.button !== 1) return;
      const a = e.target.closest("a[href]");
      const p = e.target.closest("[data-path]");
      if (!a && !p) return;
      e.preventDefault();
      this.openLink(a ? a.getAttribute("href") : p.dataset.path);
    };
    this.log.addEventListener("click", onLink);
    this.log.addEventListener("auxclick", onLink);
    this.setTitle(title);
    $("#main").append(this.el);
  }

  /** Web links open in the browser; anything else is treated as a file path (relative to the session folder). */
  async openLink(href) {
    if (!href || href.startsWith("#")) return;
    try {
      const r = await api.openLink(this.cwd, href);
      if (r === "revealed") this.statusEl.textContent = `Shown in the file manager instead of opened: ${href} is not a document type the app opens directly.`;
    } catch (e) {
      this.statusEl.textContent = e.message;
    }
  }

  /** Paste / drop: files become their paths, pasted images (screenshots) are saved to a temp file first. */
  async onFiles(e, data) {
    const files = [...(data?.files ?? [])];
    if (!files.length) return; // ordinary text paste
    // Office apps and browsers put a rendered picture next to the copied text: when there is text and none of the
    // files is a real file on disk, it is a text paste
    // (only for paste: an image dragged from a web page also carries its URL as text, but the image is what is meant)
    const hasText = e.type === "paste" && Boolean(data.getData?.("text/plain")?.trim());
    if (hasText && !files.some((f) => api.pathForFile(f))) return;
    e.preventDefault();
    // problems go to the status line, not into the conversation (that would split an answer being streamed)
    const problems = [];
    const results = await Promise.all(
      files.map(async (f) => {
        try {
          const p = api.pathForFile(f);
          if (p) return p;
          if (!f.type.startsWith("image/")) return null;
          const { bytes, mime } = await toAttachable(f);
          return await api.savePastedImage(bytes, mime);
        } catch (err) {
          problems.push(`Could not paste ${f.name || "image"}: ${err.message}`);
          return null;
        }
      }),
    );
    const paths = results.filter(Boolean); // in the order the files were pasted
    const report = () => problems.length && (this.statusEl.textContent = problems.join(" · "));
    if (!paths.length) return report();
    // @path is Copilot's file mention syntax; images mentioned this way are attached when the prompt is sent
    // @"..." cannot hold a '"': a path with both spaces and quotes (rare) is inserted as plain text, not attached
    const mention = (p) => (!/\s/.test(p) ? `@${p}` : !p.includes('"') ? `@"${p}"` : p);
    const unquotable = paths.filter((p) => /\s/.test(p) && p.includes('"'));
    if (unquotable.length) problems.push(`Cannot attach (the path has both spaces and quotes): ${unquotable.join(", ")}`);
    report();
    const text = paths.map(mention).join(" ");
    const { selectionStart: s, selectionEnd: end, value } = this.input;
    const before = s > 0 && !/\s$/.test(value.slice(0, s)) ? " " : "";
    const after = !/^\s/.test(value.slice(end)) ? " " : "";
    this.input.setRangeText(before + text + after, s, end, "end");
    this.input.focus();
    this.autosize();
  }

  setTitle(t) {
    if (t) this.title = t;
    this.titleEl.textContent = this.title ? shortTitle(this.title) : "New session";
    this.titleEl.title = `${this.title ? this.title + "\n" : ""}Click to rename`;
    const listed = sessions.find((s) => s.sessionId === this.sessionId);
    if (listed && t) listed.title = t; // the list shows the new name before the next refresh
  }

  /** Inline editor for the session title; saved through Copilot's /rename. */
  renameSession() {
    if (this.busy || this.dead) return;
    const input = h("input", { class: "title-rename", value: this.title, spellcheck: "false", maxlength: "200" });
    let finished = false;
    const done = async (save) => {
      // removing the focused input fires "blur" inside replaceWith, which would call done again mid-replace
      if (finished) return;
      finished = true;
      input.replaceWith(this.titleEl);
      const name = input.value.replace(/\s+/g, " ").trim();
      if (!save || !name || name === this.title || this.busy || this.dead) return;
      this.setBusy(true);
      try {
        this.setTitle(await api.renameSession(this.sessionId, name));
      } catch (e) {
        this.error(`Rename failed: ${e.message}`);
      } finally {
        if (!this.dead) this.setBusy(false);
        scheduleRefresh();
      }
    };
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") done(true);
      else if (e.key === "Escape") done(false);
    });
    input.addEventListener("blur", () => done(false));
    this.titleEl.replaceWith(input);
    input.select();
  }

  autosize() {
    this.input.style.height = "auto";
    this.input.style.height = Math.min(this.input.scrollHeight + 2, 240) + "px";
  }

  // --- scrolling: follow new output only while the user is at the bottom
  nearBottom() {
    return this.log.scrollHeight - this.log.scrollTop - this.log.clientHeight < 80;
  }
  append(el) {
    this.markTurn(el);
    const stick = this.nearBottom();
    this.log.append(el);
    if (stick) this.log.scrollTop = this.log.scrollHeight;
    return el;
  }
  /** Number user/relay messages (turn ordinals, as in events.jsonl) and give them and the first reply block of
   *  their turn the fork/delete actions. Elements before the first user message get none. */
  markTurn(el) {
    const c = el.classList;
    if (c.contains("msg") && (c.contains("user") || c.contains("relay"))) {
      this.turn++;
      this.turnText = el._matchText ?? (() => "");
      this.turnReplied = false;
      Object.assign(el, { _turn: this.turn, _kind: "user" });
    } else if (this.turn > 0 && !this.turnReplied && ((c.contains("msg") && c.contains("agent")) || (el.tagName === "DETAILS" && c.contains("tool")))) {
      this.turnReplied = true;
      // cuts are anchored on user messages: a reply is found through its turn's user message
      Object.assign(el, { _turn: this.turn, _kind: "reply", _matchText: this.turnText });
    } else return;
    this.addActions(el);
  }

  /** "Fork" / "Delete" buttons next to the element's Copy button (in a tool card: in its summary line). */
  addActions(el) {
    const user = el._kind === "user";
    const act = (label, title, action) => {
      const b = h("button", { class: "act", title }, label);
      b.addEventListener("click", (e) => {
        e.stopPropagation();
        e.preventDefault(); // inside a <summary> a click would toggle the tool card
        this.historyAction(el, action);
      });
      return b;
    };
    const fork = act("Fork", user ? "Start a new session from before this message" : "Start a new session that ends with this reply", "fork");
    const del = act("Delete", user ? "Delete this message and everything after it" : "Delete this reply and everything after it", "delete");
    if (el.tagName === "DETAILS") {
      el.querySelector("summary").append(h("span", { class: "acts inline" }, fork, del));
      return;
    }
    const copy = [...el.children].find((c) => c.classList.contains("copy"));
    const bar = h("div", { class: "acts" }, fork, del);
    if (copy) {
      copy.replaceWith(bar);
      bar.append(copy);
    } else el.append(bar);
  }

  /** Fork a new session from, or delete the history from, a marked message (see markTurn). */
  async historyAction(el, action) {
    if (this.busy || this.dead || this.historyOp) return;
    const where = el._kind === "user" ? "beforeUser" : action === "fork" ? "afterReply" : "beforeReply";
    const target = { ordinal: el._turn, text: String(el._matchText?.() ?? ""), where };
    this.historyOp = true;
    try {
      if (action === "fork") await this.forkFrom(target);
      else await this.deleteFrom(target, el._kind);
    } finally {
      this.historyOp = false;
    }
  }

  async forkFrom(target) {
    this.statusEl.textContent = "Creating a fork…";
    let res;
    try {
      res = await api.forkSession(this.sessionId, target);
    } catch (e) {
      this.error(`Could not fork: ${e.message}`);
      return;
    } finally {
      if (!this.busy && !this.dead) this.setBusy(false); // restores the status line
    }
    await refresh(); // the list has to contain the fork before it is opened
    await openSession({ sessionId: res.sessionId, cwd: res.cwd ?? this.cwd, title: res.name });
    const v = views.get(res.sessionId);
    if (v && res.prefill) {
      v.input.value = res.prefill;
      v.autosize();
      v.input.focus();
    }
  }

  async deleteFrom(target, kind) {
    let count;
    try {
      count = await api.countFrom(this.sessionId, target);
    } catch (e) {
      this.error(`Could not delete: ${e.message}`);
      return;
    }
    const n = count.removedUserMessages;
    const ok = confirm(
      // a reply's own user message stays, so n counts only the later messages
      (kind === "reply"
        ? n
          ? `Delete this reply and the ${n} later message${n === 1 ? "" : "s"}?`
          : "Delete this reply?"
        : `Delete this message${n > 1 ? ` and the ${n - 1} later message${n === 2 ? "" : "s"}` : ""}?`) +
        "\n\n" +
        "This cannot be undone in the app (a backup is kept as events.jsonl.bak). Files changed by the agent are not reverted. " +
        "Don't use this while the session is open in a terminal Copilot CLI.",
    );
    if (!ok || this.busy || this.dead) return;
    const { sessionId, cwd, title, inbox } = this;
    this.setBusy(true);
    this.statusEl.textContent = "Deleting…";
    let failure = null;
    try {
      await api.truncateSession(sessionId, target); // main closes the session first
    } catch (e) {
      failure = e;
      // it may have failed before or after main closed the session: close it for sure, the reopen replays it
      await api.closeSession(sessionId).catch(() => {});
    }
    // rebuild the view from the replay (not closeView: the session is already closed)
    views.delete(sessionId);
    this.el.remove();
    await openSession({ sessionId, cwd, title });
    const v = views.get(sessionId);
    if (!v) return;
    if (failure) v.error(`Could not delete: ${failure.message}`);
    if (inbox.length) {
      v.inbox.push(...inbox); // relay messages that were waiting in the old view
      v.pump();
    }
  }

  system(text) {
    this.flush();
    return this.append(h("div", { class: "msg system" }, text));
  }
  error(text) {
    this.flush();
    return this.append(h("div", { class: "msg error" }, text));
  }

  setBusy(b) {
    this.busy = b;
    this.el.classList.toggle("busy", b || this.dead); // disables the fork/delete actions
    this.sendBtn.disabled = b || this.dead;
    this.stopBtn.disabled = !b || this.dead;
    this.input.disabled = this.dead;
    this.agentPicker.disabled = b || this.dead;
    this.statusEl.textContent = b ? "Working…" : this.dead ? "Copilot process ended" : this.inbox.length ? `${this.inbox.length} relay message(s) waiting` : "";
    renderList();
    if (!b) queueMicrotask(() => this.pump());
  }

  // --- context window and usage
  usage(view) {
    const ctx = view?.context ?? null;
    this.usageChip.classList.remove("ok", "warn", "full");
    if (ctx) this.usageChip.classList.add(ctx.level);
    this.usageFill.style.width = `${ctx ? Math.max(0, Math.min(100, ctx.pct)) : 0}%`;
    this.usageLabel.textContent = (ctx ? ctx.label : "context: —") + (view?.credits ? ` · ${view.credits}` : "");
    this.usageChip.title = view ? [view.tooltip, view.quota].filter(Boolean).join("\n") : "";
  }

  // --- copilot-relay
  relayStatus({ name, connected, note }) {
    if (name) this.relayName = name;
    this.relayChip.hidden = false;
    this.relayChip.classList.toggle("off", !connected);
    this.relayChip.textContent = connected ? `relay: ${this.relayName}` : "relay: offline";
    this.relayChip.title = connected
      ? "Name of this session in copilot-relay. Other sessions send messages to this name. Click to rename."
      : `Not connected to the copilot-relay broker${note ? ` (${note})` : ""}. Reconnecting…`;
  }

  renameRelay() {
    if (!this.relayName) return;
    const input = h("input", { class: "relay-rename", value: this.relayName, spellcheck: "false" });
    let finished = false;
    const done = async (save) => {
      if (finished) return; // see renameSession
      finished = true;
      input.replaceWith(this.relayChip);
      const name = input.value.trim();
      if (!save || !name || name === this.relayName) return;
      try {
        this.relayStatus({ name: await api.relayRename(this.sessionId, name), connected: true });
      } catch (e) {
        this.error(`Rename failed: ${e.message}`);
      }
    };
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") done(true);
      else if (e.key === "Escape") done(false);
    });
    input.addEventListener("blur", () => done(false));
    this.relayChip.replaceWith(input);
    input.select();
  }

  /** A message from another session (or the relay GUI) arrived; it becomes a prompt when the session is idle. */
  incoming(m) {
    this.inbox.push(m);
    if (!this.busy) this.pump();
    else this.statusEl.textContent = `Working… (${this.inbox.length} relay message(s) waiting)`;
  }

  pump() {
    if (this.busy || this.dead || !this.inbox.length) return;
    const m = this.inbox.shift();
    // set by the broker for messages typed by a person in the relay GUI; a broker older than this app doesn't send it,
    // then the reserved-for-people name decides. It only re-opens the relay budget: relay text never attaches files.
    const human = m.human ?? m.from === "user";
    this.runPrompt(m.prompt, bubble("relay", m.text, m.from), human ? "human" : "relay");
  }

  // --- streaming blocks
  stream(type, text, messageId) {
    // a different messageId means a new message even if the type is the same
    if (!this.run || this.run.type !== type || ((messageId || this.run.messageId) && messageId !== this.run.messageId)) {
      this.flush();
      const body = h("div", { class: type === "agent" ? "md" : "body" });
      const run = { type, body, text: "", messageId };
      let el;
      if (type === "thought") el = h("details", { class: "thought" }, h("summary", {}, "Thinking"), body);
      else {
        el = h("div", { class: `msg ${type}` }, body, copyBtn(() => run.text));
        el._md = () => (!run.text.trim() ? null : type === "user" ? `**You:**\n\n${run.text}` : run.text);
        if (type === "user") el._matchText = () => run.text; // replayed text arrives after append
      }
      run.el = el;
      this.append(el);
      this.run = run;
    }
    this.run.text += text;
    this.queueRender();
  }
  queueRender() {
    if (this.renderQueued) return;
    this.renderQueued = true;
    requestAnimationFrame(() => {
      this.renderQueued = false;
      const r = this.run;
      if (!r) return;
      const stick = this.nearBottom();
      renderRun(r);
      if (stick) this.log.scrollTop = this.log.scrollHeight;
    });
  }
  flush() {
    // Finish the current block before something else is appended. If a frame is still pending, render it now
    // (final render, with links); if the last frame already rendered everything, only add the links, so
    // the message is not parsed again and a text selection in it survives.
    const r = this.run;
    if (r && this.renderQueued) renderRun(r, true);
    else if (r?.type === "agent") linkify(r.body, { codeOnly: true });
    this.run = null;
  }

  // --- ACP session/update
  onUpdate(u) {
    const text = u.content?.type === "text" ? u.content.text : "";
    switch (u.sessionUpdate) {
      case "user_message_chunk":
        // our own prompt is already shown; only replayed history (session/load) is rendered
        if (!this.prompting) this.stream("user", text);
        break;
      case "agent_message_chunk":
        this.stream("agent", text, u.messageId);
        break;
      case "agent_thought_chunk":
        this.stream("thought", text, u.messageId);
        break;
      case "tool_call":
        this.flush();
        this.toolCall(u);
        break;
      case "tool_call_update":
        this.toolCall(u);
        break;
      case "plan":
        this.flush();
        this.plan(u.entries ?? []);
        break;
      case "session_info_update":
        if (u.title) {
          this.setTitle(u.title);
          renderList();
        }
        break;
      case "config_option_update":
        if (u.configOptions) this.setConfig(u.configOptions);
        break;
      default:
        break; // available_commands_update, current_mode_update, usage_update…
    }
  }

  toolCall(u) {
    let t = this.tools.get(u.toolCallId);
    if (!t) {
      const st = h("span", { class: "st" });
      const name = h("span", { class: "name" });
      const kind = h("span", { class: "kind" });
      const body = h("div", { class: "body" });
      const el = h("details", { class: "tool" }, h("summary", {}, st, kind, name), body);
      t = { el, st, name, kind, body, data: {} };
      el._md = () => `*Tool: ${t.data.title ?? "tool"} (${t.data.status ?? "pending"})*`;
      this.tools.set(u.toolCallId, t);
      this.append(el);
    }
    Object.assign(t.data, Object.fromEntries(Object.entries(u).filter(([, v]) => v != null)));
    const d = t.data;
    const status = d.status ?? "pending";
    t.st.className = `st ${status}`;
    t.st.textContent = { completed: "✓", failed: "✗", in_progress: "●", pending: "○" }[status] ?? "●";
    t.kind.textContent = d.kind && d.kind !== "other" ? d.kind : "";
    t.name.textContent = d.title ?? "tool";
    t.body.replaceChildren(...this.toolBody(d));
    decoratePres(t.body);
    linkify(t.body);
  }

  toolBody(d) {
    const out = [];
    for (const loc of d.locations ?? []) out.push(h("div", { class: "diff-path path-link", "data-path": loc.path, title: "Open file" }, loc.path + (loc.line ? `:${loc.line}` : "")));
    for (const c of d.content ?? []) {
      if (c.type === "diff") {
        const lines = [];
        for (const l of (c.oldText ?? "").split("\n")) if (c.oldText != null) lines.push(h("span", { class: "del" }, `- ${l}\n`));
        for (const l of (c.newText ?? "").split("\n")) lines.push(h("span", { class: "add" }, `+ ${l}\n`));
        const pre = h("pre", { class: "diff" }, lines);
        pre._copy = c.newText ?? ""; // copying a diff gives the new file content
        out.push(h("div", { class: "diff-path path-link", "data-path": c.path, title: "Open file" }, c.path), pre);
      } else if (c.type === "content" && c.content?.type === "text") {
        out.push(h("pre", {}, c.content.text));
      }
    }
    if (!out.length && d.rawInput != null) out.push(h("pre", {}, typeof d.rawInput === "string" ? d.rawInput : JSON.stringify(d.rawInput, null, 2)));
    if (d.rawOutput != null && !(d.content ?? []).length)
      out.push(h("pre", {}, typeof d.rawOutput === "string" ? d.rawOutput : JSON.stringify(d.rawOutput, null, 2)));
    return out.length ? out : [h("span", { class: "kind" }, "No details")];
  }

  plan(entries) {
    const list = h("ul", {}, entries.map((e) => h("li", { class: e.status }, e.content)));
    const asMd = () => "**Plan:**\n" + entries.map((e) => `- [${e.status === "completed" ? "x" : " "}] ${e.content}`).join("\n");
    if (this.planEl && this.log.lastElementChild === this.planEl) this.planEl.replaceChildren(h("b", {}, "Plan"), list);
    else this.planEl = this.append(h("div", { class: "plan" }, h("b", {}, "Plan"), list));
    this.planEl._md = asMd;
  }

  permission({ reqId, toolCall, options }) {
    this.flush();
    const card = h(
      "div",
      { class: "perm" },
      h("div", { class: "q" }, h("b", {}, "Permission needed: "), toolCall?.title ?? "tool call", permissionDetail(toolCall?.rawInput)),
    );
    const opts = h(
      "div",
      { class: "opts" },
      (options ?? []).map((o) =>
        h(
          "button",
          {
            class: o.kind?.startsWith("allow") ? "primary" : "",
            onclick: async () => {
              await api.answerPermission(this.sessionId, reqId, o.optionId).catch((e) => this.error(e.message));
              card.classList.add("done");
              opts.replaceChildren(h("span", {}, `→ ${o.name}`));
            },
          },
          o.name,
        ),
      ),
    );
    card.append(opts);
    decoratePres(card);
    linkify(card);
    this.append(card);
    this.statusEl.textContent = "Waiting for your permission…";
  }

  setConfig(configOptions) {
    if (!Array.isArray(configOptions)) return;
    this.setAgent(configOptions.find((c) => c.id === "agent"));
    this.selects.replaceChildren(
      ...configOptions
        .filter((c) => c.id !== "agent" && c.type === "select" && Array.isArray(c.options))
        .map((c) => {
          const seen = new Set();
          const opts = c.options.filter((o) => !seen.has(o.value) && seen.add(o.value));
          const sel = h(
            "select",
            { title: c.description ?? c.name },
            opts.map((o) => {
              const usage = o._meta?.copilotUsage ? ` (${o._meta.copilotUsage})` : "";
              const opt = h("option", { value: o.value, title: o.description ?? "" }, o.name + usage);
              if (o.value === c.currentValue) opt.selected = true;
              return opt;
            }),
          );
          sel.addEventListener("change", async () => {
            try {
              const updated = await api.setConfig(this.sessionId, c.id, sel.value);
              if (updated) this.setConfig(updated);
            } catch (e) {
              this.error(`Could not change ${c.name}: ${e.message}`);
              sel.value = c.currentValue;
            }
          });
          return sel;
        }),
    );
  }

  setAgent(option) {
    this.agentOption = option;
    const model = SlashCommands.agentPickerModel(option);
    this.agentPicker.hidden = !model.show;
    this.agentPicker.replaceChildren(
      ...model.entries.map((e) => {
        const opt = h("option", { value: e.value, title: e.description }, e.name);
        if (e.missing) opt.disabled = true;
        return opt;
      }),
    );
    this.agentPicker.value = model.current;
    this.agentPicker.title = model.entries.find((e) => e.value === model.current)?.description || "Agent";
    this.agentPicker.disabled = this.busy || this.dead;
  }

  agentAvailable() {
    return SlashCommands.agentPickerModel(this.agentOption).show;
  }

  async chooseAgent(value) {
    if (this.busy) {
      this.statusEl.textContent = "Wait until Copilot finishes this turn.";
      this.setAgent(this.agentOption);
      return false;
    }
    const previous = this.agentOption;
    try {
      const updated = await api.setConfig(this.sessionId, "agent", value);
      if (updated) this.setConfig(updated);
      const entry = SlashCommands.agentPickerModel(this.agentOption).entries.find((e) => e.value === value);
      this.system("Agent: " + (entry?.name ?? (value || "Copilot")));
      return true;
    } catch (e) {
      this.setAgent(previous);
      this.statusEl.textContent = "Agent change failed: " + e.message;
      return false;
    }
  }

  /** Whole conversation as Markdown: prompts, relay messages, answers, tool calls and plans (not thinking). */
  async copyThread(btn) {
    this.flush();
    const parts = [`# ${this.title ? shortTitle(this.title) : "Copilot session"}`, `_${this.cwd} · ${this.sessionId}_`];
    for (const el of this.log.children) {
      const t = el._md?.();
      if (t && t.trim()) parts.push(t.trim());
    }
    await api.copy(parts.join("\n\n"));
    const old = btn.textContent;
    btn.textContent = "Copied";
    setTimeout(() => (btn.textContent = old), 1200);
  }

  send() {
    const text = this.input.value.trim();
    if (!text || this.busy || this.dead) return;
    this.input.value = "";
    this.autosize();
    const cmd = this.agentAvailable() ? SlashCommands.parseAgentCommand(text) : null;
    if (cmd) {
      if (cmd.arg === "") {
        this.agentPicker.focus();
        this.agentPicker.showPicker?.();
        return;
      }
      const entries = SlashCommands.agentPickerModel(this.agentOption).entries.filter((e) => !e.missing);
      const hit = SlashCommands.matchAgent(entries, cmd.arg);
      if (hit) this.chooseAgent(hit.value);
      else {
        this.input.value = text;
        this.autosize();
        this.statusEl.textContent = `Unknown agent "${cmd.arg}". Available: ${entries.map((e) => e.name).join(", ")}`;
      }
      return;
    }
    this.runPrompt(text, bubble("user", text), "app");
  }

  /** @param {"app"|"human"|"relay"} source who wrote the prompt (decides the relay budget and image attachments) */
  async runPrompt(text, bubble, source) {
    this.flush();
    this.append(bubble);
    this.log.scrollTop = this.log.scrollHeight;
    this.setBusy(true);
    this.prompting = true;
    try {
      const stop = await api.prompt(this.sessionId, text, source);
      this.flush();
      if (stop === "cancelled") this.system("Stopped.");
      else if (stop && stop !== "end_turn") this.system(`Turn ended: ${stop}`);
    } catch (e) {
      this.error(e.message);
    } finally {
      this.prompting = false;
      if (!this.dead) this.setBusy(false);
      scheduleRefresh();
    }
  }

  cancel() {
    if (this.busy) api.cancel(this.sessionId).catch((e) => this.error(e.message));
  }

  markDead({ code, signal, stderr }) {
    this.flush();
    this.dead = true;
    this.error(`Copilot process exited (${code ?? signal}).${stderr ? "\n" + stderr : ""}\nClick the session in the list to resume it again.`);
    this.setBusy(false);
  }
}

/** Readable view of a tool's input: diffs colored, other fields as "key: value". */
function permissionDetail(input) {
  if (input == null) return null;
  if (typeof input !== "object") return h("pre", {}, String(input));
  const parts = [];
  for (const [k, v] of Object.entries(input)) {
    if (k === "diff" && typeof v === "string") {
      const lines = v
        .split("\n")
        .filter((l) => l && !/^(diff --git|index |create file mode|--- |\+\+\+ )/.test(l))
        .map((l) => h("span", { class: l.startsWith("+") ? "add" : l.startsWith("-") ? "del" : "" }, l + "\n"));
      parts.push(h("pre", { class: "diff" }, lines));
    } else {
      parts.push(h("pre", {}, `${k}: ${typeof v === "string" ? v : JSON.stringify(v, null, 2)}`));
    }
  }
  return parts;
}

function renderRun(r, final = false) {
  if (r.type === "agent") {
    r.body.innerHTML = md(r.text);
    decoratePres(r.body);
    if (final) linkify(r.body, { codeOnly: true }); // marked already links plain URLs in Markdown text
  } else r.body.textContent = r.text;
  if (r.type === "user") r.el.hidden = !r.text.trim(); // replayed prompts can be empty (e.g. attachments only)
}

// ---------------------------------------------------------------------------
// opening / closing

function activate(id) {
  activeId = id;
  for (const [sid, v] of views) v.el.classList.toggle("active", sid === id);
  $("#empty").style.display = id ? "none" : "";
  renderList();
  const v = views.get(id);
  if (v && !v.dead) v.input.focus();
}

async function openSession(s) {
  const existing = views.get(s.sessionId);
  if (existing && !existing.dead) return activate(s.sessionId);
  if (existing) {
    existing.el.remove();
    views.delete(s.sessionId);
  }
  const v = new SessionView(s);
  views.set(s.sessionId, v);
  flushEarly(v);
  activate(s.sessionId);
  v.setBusy(true);
  v.statusEl.textContent = "Resuming session…";
  try {
    const res = await api.openSession(s.sessionId, s.cwd);
    v.flush();
    v.setConfig(res.configOptions);
    v.log.scrollTop = v.log.scrollHeight;
    v.setBusy(false);
    if (!v.log.childElementCount) v.system("No messages yet.");
  } catch (e) {
    v.dead = true;
    v.error(`Could not resume this session: ${e.message}`);
    v.setBusy(false);
  }
}

async function newSession(cwd) {
  try {
    cwd ??= await api.pickDir();
    if (!cwd) return;
    setStatus(`Starting Copilot in ${cwd}…`);
    const res = await api.newSession(cwd);
    setStatus("");
    const v = new SessionView({ sessionId: res.sessionId, cwd, title: "" });
    views.set(res.sessionId, v);
    flushEarly(v);
    v.setConfig(res.configOptions);
    v.system(`New session in ${cwd}`);
    v.setBusy(false);
    activate(res.sessionId);
  } catch (e) {
    setStatus(e.message, true);
  }
}

async function closeView(id) {
  const v = views.get(id);
  if (!v) return;
  if (v.busy && !v.dead && !confirm("Copilot is still working in this session. Stop it and close?")) return;
  views.delete(id);
  lastUsage.delete(id); // a re-opened session must not flash this stale snapshot
  v.el.remove();
  if (activeId === id) activate([...views.keys()].pop() ?? null);
  await api.closeSession(id).catch(() => {});
  renderList();
}

// ---------------------------------------------------------------------------
// session list

function setStatus(text, isError = false) {
  const el = $("#side-status");
  el.textContent = text;
  el.classList.toggle("error", isError);
}

async function refresh() {
  try {
    sessions = await api.listSessions();
    for (const s of sessions) {
      const v = views.get(s.sessionId);
      if (v && s.title && !v.title) v.setTitle(s.title);
    }
    setStatus(`${sessions.length} sessions`);
  } catch (e) {
    setStatus(e.message, true);
  }
  renderList();
}

let refreshTimer;
function scheduleRefresh() {
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(refresh, 1500);
}

function item(s, v) {
  return h(
    "button",
    { class: "item" + (s.sessionId === activeId ? " active" : ""), title: `${s.title ?? ""}\n${s.cwd}\n${s.sessionId}`, onclick: () => openSession(s) },
    h("div", { class: "t" }, v && !v.dead && h("span", { class: "dot" + (v.busy ? " busy" : "") }), h("b", {}, shortTitle(v?.title || s.title))),
    h("div", { class: "m" }, [s.updatedAt ? ago(s.updatedAt) : "", s.sessionId.slice(0, 8)].filter(Boolean).join(" · ")),
  );
}

function renderList() {
  const q = $("#search").value.trim().toLowerCase();
  const match = (s) => !q || `${s.title ?? ""} ${s.cwd ?? ""} ${s.sessionId}`.toLowerCase().includes(q);
  const out = [];

  const openOnes = [...views.values()].map((v) => sessions.find((s) => s.sessionId === v.sessionId) ?? { sessionId: v.sessionId, cwd: v.cwd, title: v.title });
  if (openOnes.length) {
    out.push(h("div", { class: "group-title" }, h("span", {}, "Open in app")));
    for (const s of openOnes) out.push(item(s, views.get(s.sessionId)));
  }

  const groups = new Map();
  for (const s of sessions.filter(match)) {
    if (!groups.has(s.cwd)) groups.set(s.cwd, []);
    groups.get(s.cwd).push(s);
  }
  const latest = (list) => Math.max(...list.map((s) => new Date(s.updatedAt ?? 0).getTime()));
  const sorted = [...groups.entries()].sort((a, b) => latest(b[1]) - latest(a[1]));
  for (const [cwd, list] of sorted) {
    list.sort((a, b) => new Date(b.updatedAt ?? 0) - new Date(a.updatedAt ?? 0));
    out.push(
      h(
        "div",
        { class: "group-title", title: cwd },
        h("span", {}, baseName(cwd)),
        h("button", { class: "new-here", title: `New session in ${cwd}`, onclick: () => newSession(cwd) }, "+"),
      ),
    );
    for (const s of list) out.push(item(s, views.get(s.sessionId)));
  }
  if (!out.length) out.push(h("div", { class: "group-title" }, h("span", {}, q ? "No matches" : "No sessions yet")));
  $("#session-list").replaceChildren(...out);
}

// ---------------------------------------------------------------------------
// settings

async function openSettings() {
  const s = await api.getSettings();
  $("#set-command").value = s.copilotCommand;
  const example = s.platform === "win32" ? "C:\\Users\\you\\AppData\\Roaming\\npm\\copilot.cmd" : "/opt/homebrew/bin/copilot";
  $("#set-hint").textContent =
    `Leave empty to use "copilot" from PATH (or $COPILOT_PATH). Currently used: ${s.effective}\n` +
    `Set a full path if the app cannot find Copilot, e.g. ${example}\n` +
    `Find it with: ${s.platform === "win32" ? "where copilot" : "which copilot"}`;
  renderStorage();
  $("#set-relay").checked = s.relay;
  $("#set-relay").disabled = !s.relayAvailable;
  $("#set-relay-hint").textContent = s.relayAvailable
    ? `Open sessions can message each other and terminal sessions through the broker at ${s.relayUrl}. Applies to sessions opened after saving.`
    : "relay-client.mjs is missing from this build, so the relay is not available.";
  $("#settings").showModal();
}
async function renderStorage(message = "") {
  try {
    const st = await api.storage();
    $("#store-pastes").textContent = st.pastes.dir;
    $("#store-pastes-info").textContent =
      (message ? message + "\n" : "") +
      `${st.pastes.count} pasted image(s), ${st.pastes.size}. ` +
      "They stay until you delete them here (the system may also clean its temp folder, e.g. on restart).";
    $("#store-clear").disabled = !st.pastes.count;
    $("#store-settings").textContent = st.settingsFile;
  } catch (err) {
    $("#store-pastes-info").textContent = err.message;
  }
}
$("#store-open").addEventListener("click", (e) => {
  e.preventDefault();
  api.openPastes().catch((err) => ($("#store-pastes-info").textContent = err.message));
});
$("#store-clear").addEventListener("click", async (e) => {
  e.preventDefault();
  if (!confirm("Delete all pasted images? Prompts that mention them will no longer find the files.")) return;
  let message = "";
  try {
    message = `Deleted ${await api.clearPastes()} file(s).`;
  } catch (err) {
    message = err.message;
  }
  renderStorage(message);
});

$("#settings").addEventListener("close", async () => {
  if ($("#settings").returnValue !== "save") return;
  await api.setSettings({ copilotCommand: $("#set-command").value, relay: $("#set-relay").checked });
  refresh();
});

// ---------------------------------------------------------------------------
// wiring

api.onUpdate(({ sessionId, update }) => views.get(sessionId)?.onUpdate(update));
api.onPermission((p) => views.get(p.sessionId)?.permission(p));
api.onExit((e) => views.get(e.sessionId)?.markDead(e));
api.onNotice((n) => views.get(n.sessionId)?.system(n.text));

// relay events can arrive before the view exists (right after session/new) – keep them until it does
const early = new Map();
const forView = (sessionId, fn) => {
  const v = views.get(sessionId);
  if (v) return fn(v);
  if (!early.has(sessionId)) early.set(sessionId, []);
  early.get(sessionId).push(fn);
};
function flushEarly(v) {
  if (lastUsage.has(v.sessionId)) v.usage(lastUsage.get(v.sessionId));
  for (const fn of early.get(v.sessionId) ?? []) fn(v);
  early.delete(v.sessionId);
}
api.onRelayMessage((m) => forView(m.sessionId, (v) => v.incoming(m)));
api.onRelayStatus((s) => forView(s.sessionId, (v) => v.relayStatus(s)));

// latest usage per session, so a re-opened/replaced view starts with it; sidebar shows the latest quota line
const lastUsage = new Map();
let lastQuota = null;
api.onUsage(({ sessionId, view }) => {
  lastUsage.set(sessionId, view);
  if (view?.quota) {
    lastQuota = view.quota;
    const q = $("#side-quota");
    q.textContent = lastQuota;
    q.hidden = false;
  }
  forView(sessionId, (v) => v.usage(view));
});

$("#btn-new").addEventListener("click", () => newSession());
$("#btn-new-2").addEventListener("click", () => newSession());
$("#btn-refresh").addEventListener("click", refresh);
$("#btn-settings").addEventListener("click", openSettings);
$("#search").addEventListener("input", renderList);
document.addEventListener("keydown", (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "n") {
    e.preventDefault();
    newSession();
  }
});
setInterval(renderList, 60_000); // keep "x min ago" fresh
setStatus("Loading sessions…");
refresh();
