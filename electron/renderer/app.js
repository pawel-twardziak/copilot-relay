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

marked.use({ gfm: true, breaks: false });
const md = (text) => DOMPurify.sanitize(marked.parse(text ?? ""), { ADD_ATTR: ["target"] });

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

    this.titleEl = h("b");
    this.selects = h("span", { class: "selects" });
    this.relayChip = h("button", { class: "relay-chip", hidden: true, onclick: () => this.renameRelay() });
    this.log = h("div", { class: "log" });
    this.input = h("textarea", { rows: 2, placeholder: "Message Copilot…  (Enter to send, Shift+Enter for a new line, Esc to stop)" });
    this.sendBtn = h("button", { class: "primary", onclick: () => this.send() }, "Send");
    this.stopBtn = h("button", { onclick: () => this.cancel(), disabled: true }, "Stop");
    this.statusEl = h("div", { class: "status-line" });

    this.el = h(
      "section",
      { class: "session-view" },
      h(
        "div",
        { class: "head" },
        h("div", { class: "title" }, this.titleEl, h("a", { title: "Open folder", onclick: () => api.openPath(this.cwd).catch((e) => this.error(e.message)) }, cwd)),
        this.relayChip,
        this.selects,
        h("button", { class: "danger", title: "Close this session in the app (it stays resumable)", onclick: () => closeView(this.sessionId) }, "Close"),
      ),
      this.log,
      h("div", { class: "composer" }, this.input, h("div", { class: "btns" }, this.sendBtn, this.stopBtn)),
      this.statusEl,
    );
    this.input.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
        e.preventDefault();
        this.send();
      } else if (e.key === "Escape" && this.busy) this.cancel();
    });
    this.input.addEventListener("input", () => this.autosize());
    this.setTitle(title);
    $("#main").append(this.el);
  }

  setTitle(t) {
    if (t) this.title = t;
    this.titleEl.textContent = this.title ? shortTitle(this.title) : "New session";
    this.titleEl.title = this.title;
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
    const stick = this.nearBottom();
    this.log.append(el);
    if (stick) this.log.scrollTop = this.log.scrollHeight;
    return el;
  }
  system(text) {
    this.run = null;
    return this.append(h("div", { class: "msg system" }, text));
  }
  error(text) {
    this.run = null;
    return this.append(h("div", { class: "msg error" }, text));
  }

  setBusy(b) {
    this.busy = b;
    this.sendBtn.disabled = b || this.dead;
    this.stopBtn.disabled = !b || this.dead;
    this.input.disabled = this.dead;
    this.statusEl.textContent = b ? "Working…" : this.dead ? "Copilot process ended" : this.inbox.length ? `${this.inbox.length} relay message(s) waiting` : "";
    renderList();
    if (!b) queueMicrotask(() => this.pump());
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
    const done = async (save) => {
      if (!input.isConnected) return;
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
    const human = m.from === "user"; // sent by a person from the relay web GUI
    this.runPrompt(m.prompt, h("div", { class: "msg relay" }, h("div", { class: "from" }, `from ${m.from}`), m.text), human);
  }

  // --- streaming blocks
  stream(type, text, messageId) {
    // a different messageId means a new message even if the type is the same
    if (!this.run || this.run.type !== type || ((messageId || this.run.messageId) && messageId !== this.run.messageId)) {
      this.flush();
      let el;
      if (type === "agent") el = h("div", { class: "msg agent" });
      else if (type === "user") el = h("div", { class: "msg user" });
      else el = h("details", { class: "thought" }, h("summary", {}, "Thinking"), h("div"));
      this.append(el);
      this.run = { type, el, text: "", messageId };
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
      if (r.type === "agent") r.el.innerHTML = md(r.text);
      else if (r.type === "user") r.el.textContent = r.text;
      else r.el.lastChild.textContent = r.text;
      if (stick) this.log.scrollTop = this.log.scrollHeight;
    });
  }
  flush() {
    // render the pending block synchronously before something else is appended
    if (this.run && this.renderQueued) {
      const r = this.run;
      if (r.type === "agent") r.el.innerHTML = md(r.text);
      else if (r.type === "user") r.el.textContent = r.text;
      else r.el.lastChild.textContent = r.text;
    }
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
  }

  toolBody(d) {
    const out = [];
    for (const loc of d.locations ?? []) out.push(h("div", { class: "diff-path" }, loc.path + (loc.line ? `:${loc.line}` : "")));
    for (const c of d.content ?? []) {
      if (c.type === "diff") {
        const lines = [];
        for (const l of (c.oldText ?? "").split("\n")) if (c.oldText != null) lines.push(h("span", { class: "del" }, `- ${l}\n`));
        for (const l of (c.newText ?? "").split("\n")) lines.push(h("span", { class: "add" }, `+ ${l}\n`));
        out.push(h("div", { class: "diff-path" }, c.path), h("pre", { class: "diff" }, lines));
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
    if (this.planEl && this.log.lastElementChild === this.planEl) this.planEl.replaceChildren(h("b", {}, "Plan"), list);
    else this.planEl = this.append(h("div", { class: "plan" }, h("b", {}, "Plan"), list));
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
    this.append(card);
    this.statusEl.textContent = "Waiting for your permission…";
  }

  setConfig(configOptions) {
    if (!Array.isArray(configOptions)) return;
    this.selects.replaceChildren(
      ...configOptions
        .filter((c) => c.type === "select" && Array.isArray(c.options))
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

  send() {
    const text = this.input.value.trim();
    if (!text || this.busy || this.dead) return;
    this.input.value = "";
    this.autosize();
    this.runPrompt(text, h("div", { class: "msg user" }, text), true);
  }

  async runPrompt(text, bubble, human) {
    this.flush();
    this.append(bubble);
    this.log.scrollTop = this.log.scrollHeight;
    this.setBusy(true);
    this.prompting = true;
    try {
      const stop = await api.prompt(this.sessionId, text, human);
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
  $("#set-relay").checked = s.relay;
  $("#set-relay").disabled = !s.relayAvailable;
  $("#set-relay-hint").textContent = s.relayAvailable
    ? `Open sessions can message each other and terminal sessions through the broker at ${s.relayUrl}. Applies to sessions opened after saving.`
    : "relay-client.mjs is missing from this build, so the relay is not available.";
  $("#settings").showModal();
}
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

// relay events can arrive before the view exists (right after session/new) – keep them until it does
const early = new Map();
const forView = (sessionId, fn) => {
  const v = views.get(sessionId);
  if (v) return fn(v);
  if (!early.has(sessionId)) early.set(sessionId, []);
  early.get(sessionId).push(fn);
};
function flushEarly(v) {
  for (const fn of early.get(v.sessionId) ?? []) fn(v);
  early.delete(v.sessionId);
}
api.onRelayMessage((m) => forView(m.sessionId, (v) => v.incoming(m)));
api.onRelayStatus((s) => forView(s.sessionId, (v) => v.relayStatus(s)));

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
