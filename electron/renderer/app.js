// Renderer: session list + one chat view per open session. Talks to the main process via window.api.
"use strict";

// `api` is the global exposed by preload.cjs (window.api)
const $ = (sel, el = document) => el.querySelector(sel);

// under the prompt editor of a running session, and under the prompt fields of Settings
const RESTART_NOTE = "Saving restarts this session's Copilot. The history stays.";
const SETTINGS_NOTE = "Changes here reach a running session the next time its Copilot starts.";

const decodeURIComponentSafe = (x) => {
  try {
    return decodeURIComponent(x);
  } catch {
    return x;
  }
};

/** Open the viewer on a thumbnail's image, with the other loaded images of the same message to page through. */
function openViewerFrom(img) {
  const msg = img.closest(".msg") ?? img.parentElement;
  const imgs = [...msg.querySelectorAll(".thumb img")];
  viewer.open?.(
    imgs.map((i) => ({ src: i.src, name: i.alt })),
    Math.max(0, imgs.indexOf(img)),
    img.closest(".thumb"),
  );
}

/** Moves node into parent before ref; with moveBefore where it can (both in the page), which keeps the node's state
 *  (focus, scroll offsets) that a removal and an insertion reset. */
function moveNode(parent, node, ref) {
  if (parent.moveBefore && parent.isConnected && node.isConnected) parent.moveBefore(node, ref);
  else parent.insertBefore(node, ref);
}

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

/** Whether a log element shows its time: your messages (the continue line too), relay messages and answers. */
function isTimed(el) {
  const c = el.classList;
  return c.contains("msg") && (c.contains("user") || c.contains("relay") || c.contains("agent"));
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
// Markdown images never become <img>: a local src must be read by the main process (see images:load), and every
// image gets the same thumbnail + viewer. The placeholder is replaced by a thumbnail when the reply is finished.
const attr = (x) => String(x ?? "").replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
marked.use({ renderer: { image: ({ href, text }) => `<span class="img-ref" data-src="${attr(href)}" data-alt="${attr(text)}"></span>` } });
// DOMPurify's default URI rules, plus file: for <a href> only. Links are opened by the main process on click, which
// refuses network paths. An <img src="file://host/..."> would be fetched on render (on Windows an SMB connection that
// leaks the NTLM hash), so file: stays forbidden everywhere else (and the CSP has no 'self' for images).
DOMPurify.addHook("uponSanitizeAttribute", (node, data) => {
  if (node.nodeName === "A" && data.attrName === "href" && /^file:/i.test(data.attrValue)) data.forceKeepAttr = true;
});
const md = (text, options) => DOMPurify.sanitize(marked.parse(text ?? ""), { ADD_ATTR: ["target"], ...options });
// the DOM helpers schedules.js builds its page with (it loads before this file, so it reads them at call time)
globalThis.AppUi = { h, md, copyBtn };

// The full-screen changes browser (file-preview.js); one for the whole window, it closes when the active session changes.
const filePreview = createFilePreview({
  api,
  h,
  md,
  onStatus: (text) => setStatus(text, true),
});
// the preview's list of opened files before the changes browser
try {
  localStorage.removeItem("copilot-sessions.files.v1");
} catch {}

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

let sessions = []; // from session/list: { sessionId, cwd, title, updatedAt } plus lastActivityAt (main)
let links = []; // the broker's sub-session links (api.getLinks / api.onLinks), keys "cli:<sessionId>"
let tree = SessionTree.index(links); // parent/child index over `links` (bare session ids)
let heldByKey = {}; // the broker's count of held messages per key "cli:<sessionId>" (for sessions not open here)
let heldByKindKey = {}; // the same by kind: { "cli:<sessionId>": { child, parent, other } }
// the Communication panel's data, per tree (key = its root's "cli:<id>"): the broker's { root, keys (Set), events,
// peers, ids (Set of event ids) }, or { loading, keys } before the first answer, { unsupported } (an older broker),
// { error }; fetched when a panel of the tree is first shown, when the tree changes and (throttled) on every links
// change while a panel shows it (commsLinksChanged), then fed by comms events
const commsByRoot = new Map();
const commsFetching = new Map(); // root key -> the events pushed while its fetch runs (merged into the answer)
const commsSoon = new Map(); // root key -> the timer of its refetch after a links change (at most one per 2 s)
const commsStale = new Set(); // root keys whose links changed while their fetch ran: fetched again once it answers
let commsQueued = false; // a redraw of the shown Communication panels is due
let commsTicker = null; // the 1 s redraw while a shown graph has a running timer
const HOLD_TITLES = {
  child: "Replies from your sub-sessions wait here until you approve them",
  parent: "Orders from the parent session wait here until you approve them",
  other: "Messages from other sessions wait here until you approve them",
  user: "Your messages from the relay GUI that arrive during a turn wait here until you approve them",
};
const views = new Map(); // sessionId -> SessionView
let activeId = null;
let queueMidTurn = false; // setting: deliver queued messages while a turn runs
let activityPanel = "off"; // setting: where activity group details open (off | subagents | all)
/** Text of a replayed user message as the user sees it: a queued message comes back wrapped, the app's continue
 *  prompt as its label. */
const shownUserText = (raw) => (MessageQueue.isContinuePrompt(raw) ? MessageQueue.CONTINUE_LABEL : MessageQueue.unwrap(raw) ?? raw);
/** The text of a replayed user message that is yours (Edit, Left Shift+Up/Down): none for the continue prompt. */
const ownUserText = (raw) => (MessageQueue.isContinuePrompt(raw) ? "" : shownUserText(raw));
let queueItemSeq = 0; // ids of queued items (MessageQueue item shape)
// a group's status mark in its header (Activity statuses; a work group is running while one of its tools runs): its
// tooltip, and the word for it in Copy thread
const MARK_TITLES = {
  running: "running",
  completed: "completed",
  failed: "failed",
  interrupted: "interrupted (main turn stopped; the subagent may still be working)",
  quiet: "quiet (no news)",
};
const STATUS_WORDS = { quiet: "no news" };
api
  .getSettings()
  .then((s) => {
    queueMidTurn = s.queueMidTurn === true;
    activityPanel = s.activityPanel ?? "off";
    for (const v of views.values()) v.settingChanged(); // views opened before the settings arrived
  })
  .catch(() => {});

// ---------------------------------------------------------------------------
// session view


/** A user/relay bubble of yours, with a turn ordinal: Edit is offered on it. */
function isEditableBubble(el) {
  const text = (el._ownText ?? el._matchText)?.() ?? "";
  return el._kind === "user" && EditMessage.isOwnMessage({ relay: el.classList.contains("relay"), human: !!el._human, hidden: el.hidden, text });
}

class SessionView {
  constructor({ sessionId, cwd, title, parentSessionId, seenDeliveries, pendingNotes, holdInbox, held, discarded }) {
    Object.assign(this, { sessionId, cwd, title: title ?? "" });
    // set for a session created by another one (from relay:status); the sidebar and the relation bar use `tree`
    this.parentSessionId = parentSessionId ?? null;
    this.seenDeliveries = seenDeliveries ?? new Set(); // report ids already taken (the broker redelivers until acked)
    // ids of replies you discarded whose acknowledgement did not get through (a closed session): acknowledged when the broker delivers them again
    this.discarded = discarded ?? new Set();
    this.pendingNotes = pendingNotes ?? []; // non-waking notices, passed to the model with the next prompt
    this.openCards = new Set(); // permission, delegation, reopen and link cards still waiting for an answer
    // requestId -> previews element of its reopen card while it is open, null once answered (the broker re-emits a
    // request, with every queued message, until it is answered)
    this.reopenRequests = new Map();
    // the cards open now that the Communication panel lists: [{ kind: "create" | "permission" | "link" | "reopen", id, name? }]
    // (openCard/closeCard keep it; a card carries its entry as `_pending`)
    this.pendingCards = [];
    this.panelKind = null; // which panel holds the right-hand slot: "activity" | "comms" | null (updatePanelShown)
    this.linkRequests = new Set(); // requestIds of the link cards shown (main replays an unanswered one)
    this.busy = false;
    this.dead = false;
    // streamed blocks { type, messageId, el, body, text }: each chunk goes to its message's block (StreamRuns)
    this.runs = StreamRuns.create();
    this.dirty = new Set(); // runs with text not rendered yet
    this.touched = new Set(); // runs changed since the last flush (to finish: final render, links)
    this.tools = new Map(); // toolCallId -> badge { el, st, name, kind, body, data, group } (task calls have none)
    // where each update goes: the log, the main agent's work group or a subagent's group (Activity)
    this.activity = Activity.create();
    this.groupEls = new Map(); // Activity groupId -> its subagent group element
    this.renderQueued = false;
    this.queue = []; // MessageQueue items (relay messages, your prompts sent while busy) waiting for delivery
    this.held = held ?? []; // messages waiting for your approval (not the queue), of every kind (child, parent, other, user): { id, kind, from, text, prompt, fromCwd, human, deliveryId, arrivedAt }
    this.holdOn = { child: true, parent: true, other: true, user: true }; // the per-session switches by kind (stored only when off); on until api.getHoldReplies answers
    this.holdTouched = {}; // kinds whose switch you used: the stored answer does not overwrite them
    this.paused = false; // Stop with items queued: nothing is delivered automatically until resumed
    // prompts of this view pending: a mid-turn delivery overlaps the running one, one turn for the app (its tools,
    // switch point, interrupted prompts and your Stop: MessageQueue.createChain)
    this.chain = MessageQueue.createChain();
    // a task interrupted by a queued message: the answers come first, then the continue prompt (createFollowUp)
    this.followUp = MessageQueue.createFollowUp();
    this.relayName = null;
    this.turn = 0; // user/relay messages so far = the turn ordinal of the latest one (see append)
    this.turnText = null; // getter for the latest user message's text
    this.turnReplyEl = null; // the latest turn's reply element carrying actions
    this.turnReplied = false; // the latest turn's reply already has fork/delete actions
    this.historyOp = false; // a fork/delete is running
    this.recallEl = null; // the user bubble whose text is in the message box (Left Shift+Up/Down), null = the draft
    this.draft = ""; // what was typed before recalling
    this.edit = null; // the message being edited: { el, ordinal, matchText, ownText, draft } (nothing on disk yet)
    this.holdInbox = Boolean(holdInbox); // relay messages wait (an edited prompt is about to be sent)

    this.titleEl = h("b", { class: "renamable", onclick: () => this.renameSession() });
    this.selects = h("span", { class: "selects" });
    this.promptBtn = h("button", { class: "prompt-btn", title: "This session's prompt and Copilot command (saving restarts its Copilot)", onclick: () => this.editPrompt() }, "Setup");
    this.relayChip = h("button", { class: "relay-chip", hidden: true, onclick: () => this.renameRelay() });
    this.usageFill = h("span", { class: "fill" });
    this.usageLabel = h("span", { class: "label" }, "context: —");
    this.keeperText = h("span");
    this.keeperNotNow = h("button", { class: "keeper-not-now", onclick: () => api.keeperNotNow(this.sessionId).catch((e) => this.error(e.message)) }, "Not now");
    this.keeperChip = h("span", { class: "keeper-chip", hidden: true }, this.keeperText, this.keeperNotNow);
    this.keeperState = null; // the runner's last { phase, pingsSent, pings, compactAt }
    this.keeperTimer = null; // ticks the countdown every second
    this.keeperHeldSent = null; // the last held value sent to main
    this.keeperHeldTimer = null;
    this.keeperSwitch = h("input", { type: "checkbox", class: "keeper-switch", checked: true, onchange: () => {
      const on = this.keeperSwitch.checked;
      api.keeperOptOut(this.sessionId, !on).catch((e) => {
        this.keeperSwitch.checked = !on; // main did not store it
        this.error(e.message);
      });
    } });
    this.keeperLabel = h("label", { class: "keeper-switch-label", title: "Keep this session's prompt cache warm, then compact it, while it is idle" }, this.keeperSwitch, " Keep cache");
    this.usageChip = h("span", { class: "usage-chip" }, h("span", { class: "meter" }, this.usageFill), this.usageLabel);
    this.log = h("div", { class: "log" });
    // the activity panel beside the log: in a panel mode it holds the bodies of groups (place), each in an entry
    this.panelBody = h("div", { class: "panel-body" }); // the panel's scroller, zoomed with the chat
    this.panelClose = h("button", { onclick: () => this.hidePanel() }); // collapse, or close the drawer
    const panelHead = h("div", { class: "panel-head" }, h("span", { class: "title" }, "Activity"), this.panelClose);
    this.panel = h("aside", { class: "activity-panel", hidden: true }, panelHead, this.panelBody); // hidden: not in the slot
    // the Communication panel: the other occupant of the same slot (width, collapse, drawer and handle are shared);
    // its body is filled by comms-view
    this.commsBody = h("div", { class: "comms-body" });
    this.commsClose = h("button", { onclick: () => this.hidePanel() });
    this.commsPanel = h("aside", { class: "comms-panel", hidden: true }, h("div", { class: "panel-head" }, h("span", { class: "title" }, "Communication"), this.commsClose), this.commsBody);
    // Esc inside the open drawer closes it; listened to here only, so Esc elsewhere keeps its meaning (stop the
    // turn, cancel an edit, close the command popup, the image viewer or the file preview). A held Esc's repeats do
    // nothing: one press closes the drawer and no more
    for (const aside of [this.panel, this.commsPanel]) {
      aside.addEventListener("keydown", (e) => {
        if (e.key !== "Escape" || e.repeat || !this.row.classList.contains("drawer-open")) return;
        e.preventDefault();
        e.stopPropagation();
        this.setDrawer(false);
      });
    }
    this.panelHandle = h("div", { class: "panel-handle", hidden: true, onpointerdown: (e) => this.dragPanel(e) });
    this.row = h("div", { class: "chat-row" }, this.log, this.panelHandle, this.panel, this.commsPanel);
    this.drawerOpen = false; // the narrow layout's drawer: per view, not stored (layoutPanel)
    new ResizeObserver(() => this.layoutPanel()).observe(this.row); // the layout follows the view's width
    this.follow = true; // follow streamed output: off once you scroll up, on again near the bottom
    this.lastTop = 0;
    this.log.addEventListener("scroll", () => {
      const { scrollTop: top, scrollHeight: height, clientHeight: client } = this.log;
      this.follow = ScrollFollow.followAfterScroll(this.follow, this.lastTop, { top, height, client });
      this.lastTop = top;
    });
    // the panel follows its own output on the same rule; panel content never changes the log's follow
    this.panelFollow = true;
    this.panelLastTop = 0;
    this.panelOwnTop = null; // where the app's own scroll (showInPanel, an entry opened) left the panel: not your scroll
    this.panelBody.addEventListener("scroll", () => {
      const { scrollTop: top, scrollHeight: height, clientHeight: client } = this.panelBody;
      if (top !== this.panelOwnTop) this.panelFollow = ScrollFollow.followAfterScroll(this.panelFollow, this.panelLastTop, { top, height, client });
      this.panelOwnTop = null;
      this.panelLastTop = top;
    });
    // a size change (a resize, the panel showing or hiding, the view becoming visible) fires no scroll event: a
    // following log or panel goes back to its bottom
    const resized = new ResizeObserver(() => this.followBottom());
    resized.observe(this.log);
    resized.observe(this.panelBody);
    this.input = h("textarea", { rows: 2, placeholder: "Message Copilot…  (Enter to send, Shift+Enter for a new line, Left Shift+↑/↓ for your earlier messages, Esc to stop)" });
    this.sendBtn = h("button", { class: "primary", onclick: () => this.send() }, "Send");
    this.stopBtn = h("button", { onclick: () => this.cancel(), disabled: true }, "Stop");
    this.statusEl = h("div", { class: "status-line" });
    this.bgEl = h("button", { type: "button", class: "bg-running", hidden: true, title: "Show the first running subagent" }); // "N subagents running": only the log's groups, never busy
    this.closeChildrenBtn = h(
      "button",
      { class: "danger", hidden: true, title: "Close every sub-session of this one (they stay resumable)", onclick: () => closeViews(openDescendants(this.sessionId)) },
      "Close all sub-sessions",
    );
    this.relationsEl = h("div", { class: "relations", hidden: true });
    this.agentOption = undefined; // latest ACP "agent" config option
    this.agentPicker = h("select", { class: "agent-picker", hidden: true });
    this.agentPicker.addEventListener("change", () => this.chooseAgent(this.agentPicker.value));
    this.commands = []; // Copilot's availableCommands
    this.cmdMatches = [];
    this.cmdIndex = 0;
    this.cmdToken = null;
    // shown while the view has a panel entry: shows or hides the panel (wide layout) or the drawer (narrow)
    this.activityBtn = h("button", { title: "Show or hide the activity panel", hidden: true, onclick: () => this.switchPanel("activity") }, "Activity");
    // shown while the session belongs to a tree (a parent or sub-sessions)
    this.commsBtn = h("button", { title: "Show or hide the communication panel", hidden: true, onclick: () => this.switchPanel("comms") }, "Communication");
    this.updatePanelShown(); // a session that already belongs to a tree
    this.cmdPopup = h("div", { class: "cmd-popup", role: "listbox", hidden: true, onmousedown: (e) => e.preventDefault() });
    this.editText = h("span");
    this.queueEl = h("div", { class: "queue-strip", hidden: true });
    this.heldEl = h("div", { class: "held", hidden: true });
    // one switch per kind of held message, in the status bar after "Approve:"
    this.holdSwitches = {};
    this.holdLabels = {};
    for (const kind of HeldReplies.SWITCH_KINDS) {
      this.holdSwitches[kind] = h("input", { type: "checkbox", class: "held-switch", "data-kind": kind, checked: true, onchange: () => this.setHold(kind, this.holdSwitches[kind].checked) });
      this.holdLabels[kind] = h("label", { class: "held-switch-label", hidden: true, title: HOLD_TITLES[kind] }, this.holdSwitches[kind], ` ${HeldReplies.switchLabel(kind)}`);
    }
    this.holdBar = h("span", { class: "held-switches", hidden: true }, "Approve:", ...HeldReplies.SWITCH_KINDS.map((kind) => this.holdLabels[kind]));
    this.editBar = h("div", { class: "edit-bar", hidden: true }, this.editText, h("button", { onclick: () => this.cancelEdit() }, "Cancel"));

    // the ⋯ menu: the header's rare and destructive actions (Setup, Copy thread, Close all sub-sessions, Close, Delete)
    this.moreMenu = h(
      "div",
      { class: "more-menu", role: "menu", hidden: true },
      this.promptBtn,
      h("button", { title: "Copy the whole conversation as Markdown", onclick: () => this.copyThread() }, "Copy thread"),
      this.closeChildrenBtn,
      h("hr", { role: "separator" }),
      h("button", { class: "danger", title: "Close this session in the app (it stays resumable)", onclick: () => closeView(this.sessionId) }, "Close"),
      h("button", { class: "danger", title: "Delete this whole session from disk", onclick: () => deleteSessionFlow({ sessionId: this.sessionId, cwd: this.cwd, title: this.title }) }, "Delete"),
    );
    for (const b of this.moreMenu.querySelectorAll("button")) b.setAttribute("role", "menuitem");
    this.moreBtn = h("button", { class: "more-btn", title: "More actions", "aria-haspopup": "menu", "aria-expanded": "false", onclick: () => this.toggleMore() }, "⋯");
    this.bindMoreMenu();

    this.el = h(
      "section",
      { class: "session-view" },
      h(
        "div",
        { class: "head" },
        h("div", { class: "title" }, this.titleEl, h("a", { title: "Open folder", onclick: () => api.openPath(this.cwd).catch((e) => this.error(e.message)) }, cwd)),
        this.relayChip,
        this.usageChip,
        this.keeperChip,
        this.selects,
        h(
          "div",
          { class: "head-actions" },
          h("button", { title: "Changes in this session's repositories", onclick: () => filePreview.show(this) }, "Changes"),
          this.activityBtn,
          this.commsBtn,
          h("div", { class: "more" }, this.moreBtn, this.moreMenu),
        ),
      ),
      this.relationsEl,
      this.row,
      this.editBar,
      this.heldEl,
      this.queueEl,
      h("div", { class: "composer" }, this.cmdPopup, this.input, this.agentPicker, h("div", { class: "btns" }, this.sendBtn, this.stopBtn)),
      h("div", { class: "status-bar" }, this.statusEl, this.holdBar, this.keeperLabel, this.bgEl), // the running line sits beside the status: no shift
    );
    this.renderHeld(); // replies handed over from the view this one replaces
    this.loadHoldSwitch();
    this.loadKeeper();
    this.bgEl.onclick = () => {
      const first = this.activity.running().map((id) => this.groupEls.get(id)).find(Boolean);
      if (first?.classList.contains("in-panel")) this.showInPanel(first);
      else first?.scrollIntoView({ block: "nearest" });
    };
    // Left Shift+Up/Down walks through your earlier messages, with the draft as the newest entry; registered first,
    // so it also works while the command popup is open. Right Shift+arrows still extend the text selection.
    this.input.addEventListener("keydown", (e) => {
      if (!["ArrowUp", "ArrowDown"].includes(e.key) || !e.shiftKey || !leftShift.down || e.ctrlKey || e.altKey || e.metaKey || e.isComposing) return;
      if (this.edit) return; // a recall would replace the text being edited
      e.preventDefault();
      e.stopImmediatePropagation();
      this.recall(e.key === "ArrowUp" ? -1 : 1);
    });
    // registered before the Enter/Esc handler below; consumes keys only while the popup is visible
    this.input.addEventListener("keydown", (e) => {
      if (this.cmdPopup.hidden || e.isComposing) return;
      const n = this.cmdMatches.length;
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        this.cmdIndex = (this.cmdIndex + (e.key === "ArrowDown" ? 1 : n - 1)) % n;
        this.renderPopup();
      } else if (e.key === "Tab" || (e.key === "Enter" && !e.shiftKey && !e.ctrlKey && !e.altKey)) this.insertCommandAt(this.cmdIndex);
      else if (e.key === "Escape") this.hidePopup();
      else return;
      e.preventDefault();
      e.stopImmediatePropagation();
    });
    // Up in the first line takes your queued messages back into the box (relay messages stay queued)
    this.input.addEventListener("keydown", (e) => {
      if (e.key !== "ArrowUp" || e.shiftKey || e.ctrlKey || e.altKey || e.metaKey || e.isComposing || this.edit) return;
      const { selectionStart: s, selectionEnd: end, value } = this.input;
      if (s !== end || value.slice(0, s).includes("\n")) return; // a selection, or not the first line: the caret moves
      if (this.takeBackQueued()) {
        e.preventDefault();
        e.stopImmediatePropagation();
      }
    });
    this.input.addEventListener("keyup", (e) => {
      if (["ArrowLeft", "ArrowRight", "Home", "End"].includes(e.key)) this.updatePopup();
    });
    this.input.addEventListener("click", () => this.updatePopup());
    this.input.addEventListener("blur", () => this.hidePopup());
    this.input.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
        e.preventDefault();
        this.send();
      } else if (e.key === "Escape" && this.busy) this.cancel();
      else if (e.key === "Escape" && this.edit) this.cancelEdit();
    });
    this.input.addEventListener("input", () => {
      this.reportKeeperHeld();
      if (this.recallEl) this.setRecalled(null); // an edited earlier message is the new draft
      this.autosize();
      this.updatePopup();
    });
    this.input.addEventListener("paste", (e) => this.onFiles(e, e.clipboardData));
    this.input.addEventListener("dragover", (e) => e.preventDefault());
    this.input.addEventListener("drop", (e) => this.onFiles(e, e.dataTransfer));
    this.bindLinks(this.log);
    this.bindLinks(this.panelBody);
    this.setTitle(title);
    $("#main").append(this.el);
  }

  /** Web links open in the browser; anything else is treated as a file path (relative to the session folder). */
  // --- images in messages: thumbnails, opened in the viewer

  /** One load per image source and session (re-renders and repeated mentions reuse it). Never rejects. */
  loadImage(src) {
    this.images ??= new Map();
    if (!this.images.has(src)) {
      const name = decodeURIComponentSafe(String(src).split(/[\\/]/).pop().replace(/[?#].*$/, "")) || "image";
      const remote = /^https:\/\//i.test(src) || /^data:image\/(png|jpeg|gif|webp)[;,]/i.test(src);
      this.images.set(src, remote ? Promise.resolve({ dataUrl: src, name }) : api.loadImage(this.cwd, src).catch((e) => ({ problem: e.message, name })));
    }
    return this.images.get(src);
  }

  /** A thumbnail for `src`, filled in when it has loaded: an image, a "click to load" chip or an "unavailable" note. */
  thumb(src, alt = "") {
    const slot = h("span", { class: "thumb-slot" });
    const show = (r) => {
      if (r.dataUrl) {
        const img = h("img", { src: r.dataUrl, alt: alt || r.name, loading: "lazy", draggable: "false" });
        slot.replaceChildren(h("button", { class: "thumb", title: alt || r.name, onclick: () => openViewerFrom(img) }, img));
      } else if (r.outside) {
        // outside the session and paste folders: read only because the user asked for it (not cached for others)
        const chip = h("button", { class: "img-chip", title: `${src}\nOutside the session folder: loaded only when you click.` }, `🖼 Click to load ${r.name}`);
        chip.onclick = () => {
          chip.disabled = true;
          api
            .loadImage(this.cwd, src, { clicked: true })
            .catch((e) => ({ problem: e.message, name: r.name }))
            .then(show);
        };
        slot.replaceChildren(chip);
      } else slot.replaceChildren(h("span", { class: "img-chip off", title: r.problem ?? "" }, `🖼 ${r.name} unavailable`));
    };
    this.loadImage(src).then(show);
    return slot;
  }

  /** Thumbnails for the images a prompt mentions (`@path`), under its text. */
  mentionThumbs(el, text) {
    const refs = UiState.imageMentions(text);
    if (!refs.length || el.querySelector(":scope > .thumbs")) return;
    el.querySelector(":scope > .body")?.after(h("div", { class: "thumbs" }, ...refs.map((src) => this.thumb(src))));
  }

  /** Markdown images of a finished agent reply (placeholders from the marked renderer) become thumbnails in place. */
  imageRefs(body) {
    for (const ref of body.querySelectorAll(".img-ref[data-src]")) {
      const src = ref.dataset.src;
      ref.replaceWith(h("span", { class: "thumbs inline" }, src ? this.thumb(src, ref.dataset.alt) : null));
    }
  }

  /** Links and file paths in el: left click, Enter on a focused link (fires "click") and middle click all go
   *  through openLink. */
  bindLinks(el) {
    const onLink = (e) => {
      if (e.type === "auxclick" && e.button !== 1) return;
      const a = e.target.closest("a[href]");
      const p = e.target.closest("[data-path]");
      if (!a && !p) return;
      e.preventDefault();
      this.openLink(a ? a.getAttribute("href") : p.dataset.path, a?._base ?? this.cwd);
    };
    el.addEventListener("click", onLink);
    el.addEventListener("auxclick", onLink);
  }

  async openLink(href, base = this.cwd) {
    if (!href || href.startsWith("#")) return;
    try {
      if (await filePreview.open(this, href, base)) return;
      const r = await api.openLink(base, href);
      if (r === "revealed") this.statusEl.textContent = `Shown in the file manager instead of opened: ${href} is not a document type the app opens directly.`;
    } catch (e) {
      this.statusEl.textContent = e.message;
    }
  }

  /** Turn paths in `root` that name an existing file (relative ones against `base`, null = absolute only) into links.
   *  One check per call; a node that changed while it ran is left alone. The base lives on the property a._base,
   *  never a DOM attribute: sanitised agent HTML may carry data-*. */
  async linkPaths(root, base) {
    const unique = new Set();
    const found = [];
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode: (n) => (n.parentElement?.closest("a, button") ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
    });
    const nodes = [];
    while (walker.nextNode()) nodes.push(walker.currentNode);
    for (const node of nodes) {
      const text = node.nodeValue;
      const code = node.parentElement?.closest("code");
      const cands = FileLinks.pathCandidates(text, { whole: !!code && !code.closest("pre"), max: 500 }).filter((c) => {
        if (unique.has(c.path)) return true;
        if (unique.size >= 500) return false;
        unique.add(c.path);
        return true;
      });
      if (cands.length) found.push({ node, text, cands });
    }
    if (!found.length) return;
    let existing;
    try {
      existing = new Set(await api.checkFiles(base, [...unique]));
    } catch {
      return; // a missing link is harmless
    }
    for (const { node, text, cands } of found) {
      if (!node.isConnected || node.nodeValue !== text) continue;
      const hits = cands.filter((c) => existing.has(c.path));
      if (!hits.length) continue;
      const frag = document.createDocumentFragment();
      let last = 0;
      for (const c of hits) {
        const a = h("a", { href: c.raw }, c.raw);
        if (base !== this.cwd) a._base = base;
        frag.append(text.slice(last, c.start), a);
        last = c.end;
      }
      frag.append(text.slice(last));
      node.replaceWith(frag);
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

  /** Rename through Copilot's /rename (used by the title editor and the typed /rename command). */
  async applyRename(name) {
    if (this.busy || this.dead) return;
    this.setBusy(true);
    try {
      this.setTitle(await api.renameSession(this.sessionId, name));
    } catch (e) {
      this.error(`Rename failed: ${e.message}`);
    } finally {
      if (!this.dead) this.setBusy(false);
      scheduleRefresh();
    }
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
      await this.applyRename(name);
    };
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") done(true);
      else if (e.key === "Escape") done(false);
    });
    input.addEventListener("blur", () => done(false));
    this.titleEl.replaceWith(input);
    input.select();
  }

  setCommands(list) {
    this.commands = Array.isArray(list) ? list : [];
    if (!this.cmdPopup.hidden) this.updatePopup();
  }

  hidePopup() {
    this.cmdPopup.hidden = true;
    this.cmdToken = null;
  }

  updatePopup() {
    const token = SlashCommands.commandToken(this.input.value, this.input.selectionStart);
    if (token === null) return this.hidePopup();
    const own = this.agentAvailable()
      ? [{ name: "agent", description: "Choose the custom agent for this session", input: { hint: "name" } }]
      : [];
    const matches = SlashCommands.filterCommands([...own, ...this.commands], token);
    if (!matches.length) return this.hidePopup();
    this.cmdIndex = token === this.cmdToken ? Math.min(this.cmdIndex, matches.length - 1) : 0;
    this.cmdToken = token;
    this.cmdMatches = matches;
    this.renderPopup();
    this.cmdPopup.hidden = false;
    this.cmdPopup.querySelector(".active")?.scrollIntoView({ block: "nearest" });
  }

  renderPopup() {
    this.cmdPopup.replaceChildren(
      ...this.cmdMatches.map((c, i) =>
        h(
          "div",
          {
            class: "cmd-row" + (i === this.cmdIndex ? " active" : ""),
            role: "option",
            "aria-selected": i === this.cmdIndex ? "true" : "false",
            title: c.description ?? "",
            // keep focus in the textarea
            onmousedown: (e) => {
              e.preventDefault();
              this.insertCommandAt(i);
            },
          },
          h("span", { class: "cmd-name" }, "/" + c.name),
          c.input?.hint ? h("span", { class: "cmd-hint" }, c.input.hint) : null,
          h("span", { class: "cmd-desc" }, c.description ?? ""),
        ),
      ),
    );
    this.cmdPopup.querySelector(".active")?.scrollIntoView({ block: "nearest" });
  }

  insertCommandAt(i) {
    const c = this.cmdMatches[i];
    if (!c) return;
    const r = SlashCommands.insertCommand(this.input.value, c.name);
    this.input.value = r.text;
    this.input.setSelectionRange(r.caret, r.caret);
    this.autosize();
    this.hidePopup();
  }

  /** The cache keeper's view of this session: its switch and chip from main, and what the queue and box hold (main
   *  keeps a stale "held" across a window reload, so it is sent again). */
  loadKeeper() {
    this.reportKeeperHeld();
    api
      .keeperGet(this.sessionId)
      .then((r) => {
        this.keeperSwitch.checked = !r?.optedOut;
        if (r?.state && !this.keeperState) this.keeperUpdate(r.state);
      })
      .catch(() => {}); // unreadable: the switch stays on, the chip hidden
  }

  /** Tells main whether the queue or the message box holds text (debounced, only when it changed). */
  reportKeeperHeld() {
    clearTimeout(this.keeperHeldTimer);
    if (this.keeperStopped) return;
    this.keeperHeldTimer = setTimeout(() => {
      const held = this.queue.length > 0 || this.input.value.trim() !== "";
      if (held === this.keeperHeldSent) return;
      this.keeperHeldSent = held;
      api.keeperHeld(this.sessionId, held).catch(() => {});
    }, 300);
  }

  /** The view is closed or replaced: no more reports for its session, no countdown tick, no Communication panel. */
  stopKeeper() {
    this.keeperStopped = true;
    clearTimeout(this.keeperHeldTimer);
    clearInterval(this.keeperTimer);
    this.commsView?.destroy();
    this.commsView = null;
  }

  /** A keeper:state payload: the chip, its countdown, and the ⏳ mark in the session list. */
  keeperUpdate(state) {
    const was = this.keeperState?.phase;
    this.keeperState = state;
    clearInterval(this.keeperTimer);
    this.keeperTimer = state.phase === "countdown" ? setInterval(() => {
      if (views.get(this.sessionId) === this) this.drawKeeper();
      else clearInterval(this.keeperTimer); // the view was closed or replaced
    }, 1000) : null;
    this.drawKeeper();
    if ((was === "countdown") !== (state.phase === "countdown")) renderList();
    commsRefresh(); // the node's "⏳ 1:45 / Compacting… / pings"
  }

  drawKeeper() {
    const chip = CacheKeeper.chipView(this.keeperState, Date.now());
    this.keeperChip.hidden = !chip;
    if (!chip) return;
    this.keeperText.textContent = chip.text;
    this.keeperNotNow.hidden = !chip.notNow;
  }

  autosize() {
    this.reportKeeperHeld();
    this.input.style.height = "auto";
    this.input.style.height = Math.min(this.input.scrollHeight + 2, 240) + "px";
  }

  // --- scrolling: follow new output until you scroll up (see scroll-follow.js)
  toBottom() {
    this.follow = true;
    this.log.scrollTop = this.log.scrollHeight;
  }
  panelToBottom() {
    this.panelFollow = true;
    this.panelBody.scrollTop = this.panelBody.scrollHeight;
  }
  /** After new content or a size change: the log and the panel, each at its bottom if it follows. Nothing during a
   *  replay: the end of the replay takes both to their bottoms once (a layout per replayed block slowed every open). */
  followBottom() {
    if (this.resuming) return;
    if (this.follow) this.toBottom();
    if (this.panelFollow) this.panelToBottom();
  }
  /** Your messages in this thread, oldest first. Relay messages from other sessions are not yours: live ones are
   *  .msg.relay, replayed ones are .msg.user with the broker's "[from <name>]" prefix. */
  ownMessages() {
    // a message you typed in the relay GUI is yours: live it is .msg.relay with _human, replayed a plain .msg.user
    return [...this.log.querySelectorAll(".msg.user, .msg.relay")].filter((el) => {
      const text = (el._ownText ?? el._matchText)?.() ?? "";
      return EditMessage.isOwnMessage({ relay: el.classList.contains("relay"), human: !!el._human, hidden: el.hidden, text });
    });
  }

  /** Put the previous (dir -1) or next (dir 1) of your messages into the message box; past the newest: the draft. */
  recall(dir) {
    const list = this.ownMessages();
    const at = this.recallEl ? list.indexOf(this.recallEl) : list.length;
    const i = (at === -1 ? list.length : at) + dir;
    if (i < 0 || (i >= list.length && !this.recallEl)) return; // already at the oldest / at the draft
    if (!this.recallEl) this.draft = this.input.value;
    const el = list[i] ?? null;
    this.setRecalled(el);
    this.input.value = el ? (el._ownText ?? el._matchText)() : this.draft;
    this.input.setSelectionRange(this.input.value.length, this.input.value.length);
    this.hidePopup();
    this.autosize();
    if (el) el.scrollIntoView({ block: "nearest" });
  }

  setRecalled(el) {
    this.recallEl?.classList.remove("recalled");
    this.recallEl = el;
    el?.classList.add("recalled");
  }

  append(el) {
    this.markTurn(el);
    this.log.append(el);
    // a live message takes the clock; replayed ones get their recorded time when the replay ends (applyTimes). An
    // answer of the history that arrives after the replay's end still takes its recorded time.
    if (!this.resuming && isTimed(el)) this.stamp(el, this.recordedTime(el) ?? Date.now());
    if (el._info) this.place(el); // a group: its body goes where the mode says
    this.followBottom();
    return el;
  }
  /** The time the session history has for an answer (by its messageId), or null. */
  recordedTime(el) {
    const agents = this.historyTimes?.agents;
    const id = el._messageId;
    return agents && typeof id === "string" && Object.hasOwn(agents, id) ? agents[id] : null;
  }
  /** After a replay: give the replayed messages the times the session history has for them (api.messageTimes: the
   *  user messages in order, the answers by messageId). A hidden (empty) prompt counts for the order and shows none;
   *  a message the history can't place shows none either. */
  applyTimes(times) {
    this.historyTimes = times;
    const els = [...this.log.children].filter((el) => isTimed(el) && el._time == null);
    const items = els.map((el) => ({ kind: el.classList.contains("agent") ? "agent" : "user", messageId: el._messageId }));
    const at = MessageTimes.assign(times, items);
    els.forEach((el, i) => {
      if (at[i] != null && !el.hidden) this.stamp(el, at[i]);
    });
  }
  /** Show a message's time (once) in its top right corner, with a date line before it when it is the first timed
   *  message of its day. el is already in the log. */
  stamp(el, ms) {
    if (el._time != null) return;
    el._time = ms;
    el.append(h("span", { class: "time", title: MessageTimes.full(ms) }, MessageTimes.clock(ms)));
    let prev = el.previousElementSibling;
    while (prev && prev._time == null) prev = prev.previousElementSibling;
    if (MessageTimes.newDay(prev?._time ?? null, ms)) el.before(h("div", { class: "day-sep" }, h("span", {}, MessageTimes.dayLabel(ms))));
  }
  /** Number user/relay messages (turn ordinals, as in events.jsonl) and give them and the first reply block of
   *  their turn the fork/delete actions. Elements before the first user message get none. */
  markTurn(el) {
    const c = el.classList;
    if (c.contains("msg") && (c.contains("user") || c.contains("relay"))) {
      this.turn++;
      this.turnText = el._matchText ?? (() => "");
      this.turnReplied = false;
      this.turnReplyEl = null;
      Object.assign(el, { _turn: this.turn, _kind: "user" });
    } else if (this.turn > 0 && !this.turnReplied && this.isReply(el)) {
      this.turnReplied = true;
      this.turnReplyEl = el;
      // cuts are anchored on user messages: a reply is found through its turn's user message
      Object.assign(el, { _turn: this.turn, _kind: "reply", _matchText: this.turnText });
    } else return;
    this.addActions(el);
  }

  /** Whether el can be its turn's reply: an answer, a tool badge or a group (not a standalone subagent group: it may
   *  arrive after the next user message). */
  isReply(el) {
    const c = el.classList;
    if (c.contains("msg") && c.contains("agent")) return true;
    if (el.tagName === "DETAILS" && c.contains("tool")) return true;
    return c.contains("group") && el._anchored !== false;
  }

  /** Un-number a turn that Copilot did not record (a CLI command such as /context): strip its actions. */
  dropTurn(userEl) {
    if (userEl._turn !== this.turn) return;
    for (const el of [userEl, this.turnReplyEl]) {
      if (!el) continue;
      for (const bar of el.querySelectorAll(".acts")) {
        if (bar.tagName === "DIV") {
          const copy = [...bar.children].find((c) => c.classList.contains("copy"));
          if (copy) bar.replaceWith(copy);
          else bar.remove();
        } else bar.remove();
      }
      delete el._turn;
      delete el._kind;
    }
    this.turn--;
    this.turnReplied = true;
    this.turnReplyEl = null;
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
    const edit = user ? h("button", { class: "act", title: "Edit this message: sending replaces it and everything after it" }, "Edit") : null;
    if (edit) {
      edit.addEventListener("click", (e) => {
        e.stopPropagation();
        this.startEdit(el);
      });
      edit.hidden = !this.isEditable(el);
      el._editAct = edit;
    }
    const fork = act("Fork", user ? "Start a new session from before this message" : "Start a new session that ends with this reply", "fork");
    const del = act("Delete", user ? "Delete this message and everything after it" : "Delete this reply and everything after it", "delete");
    if (el.tagName === "DETAILS") {
      el.querySelector("summary").append(h("span", { class: "acts inline" }, fork, del));
      return;
    }
    const copy = [...el.children].find((c) => c.classList.contains("copy"));
    const bar = h("div", { class: "acts" }, edit, fork, del);
    if (copy) {
      copy.replaceWith(bar);
      bar.append(copy);
    } else el.append(bar);
  }

  /** Edit is offered on your own messages only (the same ones Left Shift+Up/Down recalls). */
  isEditable(el) {
    return isEditableBubble(el);
  }

  /** Put a message of yours in the box to be replaced on Send; nothing on disk changes until then. */
  async startEdit(el) {
    const blocked = () => this.busy || this.dead || this.deleting || this.historyOp;
    if (blocked() || !this.isEditable(el)) return;
    const matchText = String(el._matchText?.() ?? "");
    let count;
    try {
      count = await api.countFrom(this.sessionId, { ordinal: el._turn, text: matchText, where: "beforeUser" });
    } catch (e) {
      this.error(`Could not edit: ${e.message}`);
      return;
    }
    if (blocked() || views.get(this.sessionId) !== this) return; // a turn started or the view went meanwhile
    let draft;
    if (this.edit) {
      draft = this.edit.draft; // switching to another message keeps what was typed before the first one
      this.clearEdit();
    } else {
      draft = this.recallEl ? this.draft : this.input.value;
      this.setRecalled(null);
      this.draft = "";
    }
    const ownText = String((el._ownText ?? el._matchText)());
    this.edit = { el, ordinal: el._turn, matchText, ownText, draft };
    el.classList.add("edit-from");
    this.dimEntries();
    this.editText.textContent = EditMessage.editBanner(count.removedUserMessages);
    this.editBar.hidden = false;
    this.input.value = ownText;
    this.input.setSelectionRange(ownText.length, ownText.length);
    this.hidePopup();
    this.autosize();
    this.input.focus();
  }

  /** Leave edit mode without restoring anything (the box keeps its text). */
  clearEdit() {
    if (!this.edit) return;
    this.edit.el.classList.remove("edit-from");
    this.edit = null;
    this.dimEntries();
    this.editBar.hidden = true;
    if (!this.busy) queueMicrotask(() => this.pump());
  }

  /** Edit mode dims the panel entries of the groups after the message being edited, as the log dims those groups
   *  (.edit-from ~ *, a sibling rule that cannot reach the panel); no entry is dimmed when not editing. */
  dimEntries() {
    const from = this.edit?.el;
    for (const g of this.log.querySelectorAll(":scope > .group")) {
      g._entry?.classList.toggle("dim", !!from && !!(from.compareDocumentPosition(g) & Node.DOCUMENT_POSITION_FOLLOWING));
    }
  }

  /** Leave edit mode and bring back what was typed before it. */
  cancelEdit() {
    if (!this.edit) return;
    const { draft } = this.edit;
    this.clearEdit();
    this.input.value = draft;
    this.autosize();
    this.updatePopup();
  }

  /** Resolves once no session update has arrived for `quiet` ms (at most `max` ms). */
  async updatesSettled(quiet = 400, max = 3000) {
    const start = Date.now();
    while (Date.now() - start < max && Date.now() - (this.lastUpdate ?? 0) < quiet) await new Promise((r) => setTimeout(r, 100));
  }

  /** Let relay messages that waited for an edited prompt run again. */
  releaseInbox() {
    this.holdInbox = false;
    if (!this.busy) this.pump();
  }

  /** Fork a new session from, or delete the history from, a marked message (see markTurn). */
  async historyAction(el, action) {
    if (this.busy || this.dead || this.deleting || this.historyOp) return;
    const where = el._kind === "user" ? "beforeUser" : action === "fork" ? "afterReply" : "beforeReply";
    const target = { ordinal: el._turn, text: String(el._matchText?.() ?? ""), where };
    // each operation releases only its own flag: a fork releases it early, and another operation may start then
    const op = Symbol(action);
    this.historyOp = op; // set first: the pump that cancelEdit queues must not start a held relay message now
    this.cancelEdit();
    const release = () => {
      if (this.historyOp !== op) return;
      this.historyOp = false;
      // relay messages held by an edit or by this operation; a delete moved them to the rebuilt view instead
      if (views.get(this.sessionId) === this && !this.busy) this.pump();
    };
    try {
      if (action === "fork") await this.forkFrom(target, release);
      else await this.deleteFrom(target, el._kind);
    } finally {
      release();
    }
  }

  async forkFrom(target, release) {
    this.statusEl.textContent = "Creating a fork…";
    let res;
    try {
      res = await api.forkSession(this.sessionId, target);
      release(); // the source's files are done with: opening the fork doesn't touch them
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
    const { sessionId } = this;
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
    // a failed cut leaves the history as it was: a task waiting to be continued still waits
    await reopenView(this, failure && `Could not delete: ${failure.message}`, { keepFollowUp: !!failure });
  }

  system(text) {
    this.flush();
    return this.append(h("div", { class: "msg system" }, text));
  }
  error(text) {
    this.flush();
    return this.append(h("div", { class: "msg error" }, text));
  }

  /** A setting changed: re-apply the busy state so the Send button and status line follow it, and put the groups'
   *  bodies where activityPanel says. */
  settingChanged() {
    this.setBusy(this.busy);
    this.placeAll();
  }

  /** A prompt of this view is pending (the user_message_chunk of a live prompt is not shown again). */
  get prompting() {
    return this.chain.active();
  }

  setBusy(b) {
    if (b && this.busy !== true) this.busySince = Date.now(); // the turn's start (the panel's "reading" clock)
    if (!b) this.busySince = null;
    this.busy = b;
    const off = b || this.dead || this.deleting; // this.deleting: the whole session is being deleted
    this.el.classList.toggle("busy", off); // disables the fork/delete actions
    this.updateSendBtn();
    this.stopBtn.disabled = !b || this.dead || this.deleting;
    this.input.disabled = this.dead || this.deleting;
    this.agentPicker.disabled = off;
    // a new prompt or command takes a restart, as a new context window does; a dead view keeps it: Setup repairs it
    this.promptBtn.disabled = b || this.deleting;
    this.showQueueStatus();
    renderList();
    commsRefresh(); // the node's working / idle
    if (!b) queueMicrotask(() => this.pump());
  }

  /** Send is off while busy, except where it queues (queue setting on) or holds your message (a turn runs, "user" switch on). */
  updateSendBtn() {
    this.sendBtn.disabled = this.dead || this.deleting || (this.busy && !this.sendsWhileBusy());
  }

  /** Messages that would be lost with this view: the queue's and your typed held ones (the broker's held ones are delivered again when a view is reopened, but not after a delete: the broker forgets them). */
  unsentCount() {
    return this.queue.length + this.held.filter((item) => item.typed).length;
  }

  /** What Send does with a message while the view is busy: queue it or hold it (the queue setting, or a running turn with the "user" switch on). */
  sendsWhileBusy() {
    return queueMidTurn || this.holdsTyped();
  }

  /** Your own message typed during a turn waits in the "user" list (switch on). */
  holdsTyped() {
    return this.prompting && this.holdOn.user;
  }

  showQueueStatus() {
    const { busy, dead, deleting, paused } = this;
    this.statusEl.textContent = MessageQueue.statusText({ busy, dead, deleting, queued: this.queue.length, paused, held: this.held.length });
  }

  /** Draws the lists of held messages (parent, other, user, child) above the queue; called after every change of `held`. */
  renderHeld() {
    this.heldEl.hidden = this.held.length === 0;
    this.heldEl.replaceChildren();
    for (const kind of HeldReplies.KINDS) {
      const list = this.held.filter((item) => item.kind === kind);
      if (!list.length) continue;
      const rows = list.map((item) => {
        const first = item.text.split("\n")[0];
        const heldText = h("span", { class: "held-text", title: item.text }, first);
        heldText.onclick = () => {
          const open = heldText.classList.toggle("expanded"); // the full text, as plain text
          heldText.textContent = open ? item.text : first;
        };
        return h(
          "div",
          { class: "held-row" },
          h("span", { class: "held-from" }, item.from),
          h("span", { class: "held-time", title: MessageTimes.full(item.arrivedAt) }, MessageTimes.clock(item.arrivedAt)),
          heldText,
          h("button", { class: "held-approve", title: "Send this message to Copilot", disabled: this.dead || this.deleting, onclick: () => this.approveHeld(item) }, "Approve"),
          h("button", { class: "held-discard", title: "Discard this message", onclick: () => this.discardHeld(item) }, "✕"),
        );
      });
      this.heldEl.append(h("div", { class: "held-group", "data-kind": kind }, h("div", { class: "held-head" }, h("span", {}, HeldReplies.listTitle(kind, list.length))), ...rows));
    }
    this.renderHoldSwitches();
    this.showQueueStatus();
  }

  /** The switches after "Approve:" in the status bar: those whose kind can occur here or has held items (the one place for renderHeld and renderRelations). */
  renderHoldSwitches() {
    const rel = SessionTree.relation(tree, this.sessionId);
    const hasParent = !!rel.parent && rel.parent !== this.sessionId;
    let any = false;
    for (const kind of HeldReplies.SWITCH_KINDS) {
      const show = HeldReplies.showSwitch({ kind, hasChildren: rel.children.length > 0, hasParent, onRelay: !!this.relayName, held: this.held.filter((item) => item.kind === kind).length });
      this.holdLabels[kind].hidden = !show;
      this.holdSwitches[kind].checked = this.holdOn[kind];
      this.holdSwitches[kind].disabled = this.dead || this.deleting;
      any ||= show;
    }
    this.holdBar.hidden = !any;
  }

  /** A message of `kind` (child, parent, other, user): it waits in its list until you approve it. */
  hold(m, kind) {
    // main stamps arrivedAt once, so a reload or a replay keeps the time and the order (oldest on top)
    HeldReplies.insertByArrival(this.held, { id: ++queueItemSeq, kind, from: m.from, text: m.text, prompt: m.prompt, fromCwd: m.fromCwd ?? null, human: m.human === true, deliveryId: m.deliveryId, arrivedAt: m.arrivedAt ?? Date.now() });
    this.renderHeld();
    renderList();
  }

  /** A message you typed while a turn runs (switch "user" on): it waits in the "Your messages" list until you approve it. */
  holdTyped(text, command) {
    HeldReplies.insertByArrival(this.held, { id: ++queueItemSeq, kind: "user", typed: true, from: "you", text, prompt: text, command, arrivedAt: Date.now() });
    this.renderHeld();
    renderList();
  }

  /** Approving puts the message in the queue (the one path to a prompt; its acknowledgement happens when it starts). */
  approveHeld(item) {
    const i = this.held.indexOf(item);
    if (i < 0) return;
    this.held.splice(i, 1);
    if (item.typed) this.enqueue({ kind: "app", text: item.text, prompt: item.prompt, command: item.command });
    else this.enqueue({ kind: "relay", text: item.text, prompt: HeldReplies.approvedPrompt(item.prompt, item.arrivedAt, Date.now(), item.kind), from: item.from, human: item.human === true, fromCwd: item.fromCwd, deliveryId: item.deliveryId, command: false });
    this.renderHeld();
    renderList();
  }

  discardHeld(item) {
    const i = this.held.indexOf(item);
    if (i < 0) return;
    this.held.splice(i, 1);
    if (!item.typed) {
      this.discarded.add(item.deliveryId);
      this.ackDiscarded(item.deliveryId); // the broker must not deliver it again
    }
    this.system(HeldReplies.discardLine(item.kind, item.from));
    this.renderHeld();
    renderList();
  }

  /** Acknowledges a discarded message; only a confirmed ack (not false, not an error) lets the id go. */
  ackDiscarded(id) {
    api
      .relayAck(this.sessionId, id, "discarded")
      .then((ok) => ok !== false && this.discarded.delete(id))
      .catch(() => {});
  }

  /** The switch of one kind: off sends every held message of that kind to the queue (oldest first); on moves nothing back. */
  async setHold(kind, on) {
    try {
      await api.setHoldReplies(this.sessionId, kind, on);
    } catch (e) {
      this.error(`Could not save the setting: ${e.message}`);
      this.holdSwitches[kind].checked = this.holdOn[kind]; // the file was not written: the switch stays as it was
      return;
    }
    this.holdOn[kind] = on;
    this.holdTouched[kind] = true;
    this.updateSendBtn();
    if (!on) for (const item of this.held.filter((i) => i.kind === kind)) this.approveHeld(item);
    this.renderHeld();
  }

  /** Draws the queue strip above the input; called after every change of the queue. */
  renderQueue() {
    const q = this.queue;
    this.queueEl.hidden = q.length === 0;
    this.queueEl.replaceChildren();
    this.reportKeeperHeld();
    if (q.length) {
      const head = h("div", { class: "queue-head" }, h("span", {}, `Queue (${q.length})`));
      if (this.paused) {
        head.append(h("span", { class: "queue-paused" }, "Paused"), h("button", { title: "Resume delivering the queued messages", onclick: () => this.resumeQueue() }, "▶ resume"));
      }
      this.queueEl.append(head);
      for (const item of q) {
        const text = h("span", { class: "queue-text", title: item.text }, item.text);
        if (item.kind === "app") {
          text.classList.add("editable");
          text.onclick = () => this.editQueued(item);
        }
        this.queueEl.append(
          h("div", { class: "queue-row" }, h("span", { class: "queue-from" }, item.kind === "app" ? "you:" : `from ${item.from}:`), text, h("button", { title: "Remove from the queue", onclick: () => this.removeQueued(item) }, "✕")),
        );
      }
    }
    this.showQueueStatus();
  }

  removeQueued(item) {
    const i = this.queue.indexOf(item);
    if (i < 0) return;
    this.queue.splice(i, 1);
    if (!this.queue.length) this.endPauseOnEmpty();
    if (item.kind === "relay") {
      // the broker must not deliver it again (a message without an id, such as a delegated task, has nothing to ack)
      if (item.deliveryId) api.relayAck(this.sessionId, item.deliveryId, "discarded").catch(() => {});
      this.system(`Removed a queued message from ${item.from}.`);
    }
    this.renderQueue();
    if (!this.busy) this.pump();
  }

  /** Move a queued app message back into the (empty) input box to change it. */
  editQueued(item) {
    if (this.input.value.trim()) {
      this.statusEl.textContent = "Clear the message box to edit a queued message.";
      return;
    }
    const i = this.queue.indexOf(item);
    if (i < 0) return;
    this.queue.splice(i, 1);
    if (!this.queue.length) this.endPauseOnEmpty();
    this.input.value = item.text;
    this.autosize();
    this.updatePopup();
    this.input.focus();
    this.renderQueue();
  }

  /** Your queued messages back into the box, in front of what is typed there; false when none is queued. */
  takeBackQueued() {
    const res = MessageQueue.takeBack(this.queue, this.input.value);
    if (!res) return false;
    this.queue.splice(0, this.queue.length, ...res.rest);
    if (!this.queue.length) this.endPauseOnEmpty();
    if (this.recallEl) this.setRecalled(null); // the recalled text is now part of the draft
    this.input.value = res.text;
    this.input.setSelectionRange(res.caret, res.caret);
    this.autosize();
    this.updatePopup();
    this.renderQueue();
    return true;
  }

  /** The queue was emptied by hand: a pause ends. A pause comes from your Stop, so the task it stopped is not continued
   *  later by itself (unpaused, e.g. during an answer turn, the waiting task stays). */
  endPauseOnEmpty() {
    if (!this.paused) return;
    this.paused = false;
    this.followUp.drop();
  }

  resumeQueue() {
    this.paused = false;
    this.renderQueue();
    if (!this.busy) this.pump();
  }

  /** Queue an item (see MessageQueue); it is delivered at the next tool boundary (setting on) or when the turn ends. */
  enqueue(item) {
    this.queue.push({ id: ++queueItemSeq, ...item });
    this.renderQueue();
    if (!this.busy) this.pump();
    this.showQueueStatus(); // also when idle and held (paused, edit, holdInbox): "Queue paused (N)" / "N waiting"
  }

  /** The bubble, relay source and broker acknowledgement for a queued item about to become a prompt. */
  itemPrompt(item) {
    if (item.kind === "app") return { el: this.userBubble(item.text), source: "app", delivery: null };
    // the broker forgets it once its prompt has really started (a failed ack only means it is delivered again later)
    const delivery = item.deliveryId ? UiState.deliveryAck(item.deliveryId, this.seenDeliveries, (id) => api.relayAck(this.sessionId, id).catch(() => {})) : null;
    const el = bubble("relay", item.text, item.from);
    this.mentionThumbs(el, item.text);
    this.linkPaths(el.querySelector(".body"), item.fromCwd ?? null);
    el._human = item.human; // typed by you in the relay GUI: yours for Left Shift+Up/Down
    return { el, source: item.human ? "human" : "relay", delivery };
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
  relayStatus({ name, connected, note, parentSessionId, parentChanged }) {
    if (name && name !== this.relayName) {
      this.relayName = name;
      this.renderHoldSwitches(); // the switch of other sessions' messages shows once the session has a relay name
      commsRefresh(); // its node's name when the broker gives none
    }
    if (parentChanged) {
      // the user linked or unlinked this session (adopt_session, release_session): null is a release
      if ((parentSessionId ?? null) !== this.parentSessionId) {
        this.parentSessionId = parentSessionId ?? null;
        renderList();
      }
    } else if (parentSessionId && parentSessionId !== this.parentSessionId) {
      // otherwise only ever set: a status sent before the broker's registration has no link yet, and a rename carries none
      this.parentSessionId = parentSessionId;
      renderList();
    }
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
    if (m.deliveryId && this.discarded.has(m.deliveryId)) {
      this.ackDiscarded(m.deliveryId);
      return;
    }
    if (!UiState.acceptDelivery(this.seenDeliveries, m.deliveryId)) return;
    if (m.wake === false) {
      // informational: no turn of its own, the model gets it with the next prompt
      this.system(m.text);
      this.pendingNotes.push(m.prompt);
      return;
    }
    const kind = HeldReplies.kindOf(m);
    if (HeldReplies.shouldHold({ kind, on: kind && this.holdOn[kind], deliveryId: m.deliveryId, prompting: this.prompting, cameBack: m.redelivered === true || m.replayed === true })) return this.hold(m, kind);
    // set by the broker for messages typed by a person in the relay GUI; a broker older than this app doesn't send it,
    // then the reserved-for-people name decides. It only re-opens the relay budget: relay text never attaches files.
    const human = m.human ?? m.from === "user";
    this.enqueue({ kind: "relay", text: m.text, prompt: m.prompt, from: m.from, human, fromCwd: m.fromCwd ?? null, deliveryId: m.deliveryId, command: false });
  }

  /** End of a turn: the head item starts a new one; while an interrupted task waits it goes as an answer prompt
   *  (wrapped), otherwise as a plain prompt. */
  pump() {
    const { busy, paused, edit, historyOp, holdInbox, deleting, dead } = this;
    if (!MessageQueue.canDeliverIdle({ busy, paused, edit, historyOp, holdInbox, deleting, dead, queued: this.queue.length })) return;
    const item = this.queue.shift();
    this.renderQueue();
    const { el, source, delivery } = this.itemPrompt(item);
    this.runPrompt(item.prompt, el, source, delivery, { answer: this.followUp.answerDue(), more: this.queue.length > 0 });
  }

  /** A tool boundary with the queue head eligible: send it now, as a second prompt that interrupts the running one
   *  (an answer prompt; the interrupted task is continued after the last answer). */
  deliverMidTurn() {
    const item = this.queue.shift();
    this.renderQueue();
    const { el, source, delivery } = this.itemPrompt(item);
    this.runPrompt(item.prompt, el, source, delivery, { midTurn: true, more: this.queue.length > 0 }); // interrupts the task
  }

  /** After the last answer to queued messages: the app's own prompt that resumes the interrupted task. It is a small
   *  system-style line, never editable or recalled (it is still a user message for the turn ordinals). */
  sendContinue() {
    const label = MessageQueue.CONTINUE_LABEL;
    const el = h("div", { class: "msg user continue" }, h("div", { class: "body" }, label), copyBtn(() => label));
    el._md = () => `_${label}_`;
    el._matchText = () => MessageQueue.CONTINUE_PROMPT;
    el._ownText = () => "";
    return this.runPrompt(MessageQueue.CONTINUE_PROMPT, el, "relay");
  }

  /** Copilot's abort marker after a mid-turn send: the delivered prompt has taken over the turn.
   *  dropped: the tools in flight then (killed by the interruption, they stay "pending" forever). */
  switchPoint({ record, dropped: ids }) {
    const { delivery } = record;
    const dropped = new Set(ids);
    for (const toolCallId of dropped) this.applyTool({ sessionUpdate: "tool_call_update", toolCallId, status: "interrupted" });
    // its permission question is gone with it (a card without a tool id was asked before the switch too); main still
    // holds the request open, so it is answered as cancelled. A subagent's question is not: the interruption is the
    // main agent's, the subagent may still be waiting for the answer.
    for (const card of [...this.openCards]) {
      if (!card._dismiss || card._agentId || (card._toolCallId != null && !dropped.has(card._toolCallId))) continue;
      api.answerPermission(this.sessionId, card._reqId, null).catch(() => {});
      card._dismiss("→ interrupted");
    }
    delivery?.returned(); // its prompt has really started
    this.delivery = delivery;
  }

  // --- streaming blocks
  /** container: null = the log (top-level, through append), else a group element (its body and its own runs). */
  stream(type, text, messageId, container = null) {
    const runs = container ? container._runs : this.runs;
    let run = runs.find(type, messageId);
    if (!run) {
      if (container) this.finishRuns();
      else this.flush();
      const body = h("div", { class: type === "agent" ? "md" : "body" });
      run = { type, body, text: "", messageId };
      const shown = () => FileLinks.parseRelayHeader(shownUserText(run.text)).display; // a replayed relay message hides its [folder "..."] line
      let el;
      if (type === "thought") el = h("details", { class: "thought" }, h("summary", {}, "Thinking"), body);
      else {
        el = h("div", { class: `msg ${type}` }, body, copyBtn(() => shown()));
        el._messageId = messageId; // its time in the session history is found by it (applyTimes)
        el._md = () => {
          if (!shown().trim()) return null;
          if (type !== "user") return shown();
          return MessageQueue.isContinuePrompt(run.text) ? `_${shown()}_` : `**You:**\n\n${shown()}`;
        };
        if (type === "user") {
          el._matchText = () => run.text; // replayed text arrives after append; what was sent (wrapped if delivered mid-turn)
          el._ownText = () => ownUserText(run.text); // none for the continue prompt
        }
      }
      run.el = el;
      if (container) {
        if (type === "thought") container._info.thoughts++;
        this.groupAppend(container, el);
      } else this.append(el);
      runs.add(run);
    }
    run.text += text;
    this.dirty.add(run);
    this.touched.add(run);
    this.queueRender();
  }
  queueRender() {
    if (this.renderQueued) return;
    this.renderQueued = true;
    requestAnimationFrame(() => {
      this.renderQueued = false;
      if (!this.dirty.size) return;
      for (const r of this.dirty) renderRun(r);
      this.dirty.clear();
      this.followBottom();
    });
  }
  /** Before something else is appended to the log: finish the streamed blocks (finishRuns); chunks without a
   *  messageId then start a new block. */
  flush() {
    this.finishRuns();
    this.runs.close();
  }
  finishRuns() {
    // Finish the blocks streamed into since the last flush, in the log and in groups. A block with text not
    // rendered yet is rendered now (final render, with links); one whose last frame rendered everything only gets
    // the links, so the message is not parsed again and a text selection in it survives. A message that streams on
    // later (a background subagent) is rendered again in its own block and finished at the next flush.
    let rendered = false;
    for (const r of this.touched) {
      if (this.dirty.has(r)) {
        renderRun(r, true);
        rendered = true;
      } else if (r.type === "agent") linkify(r.body, { codeOnly: true });
      else if (r.type === "user") linkify(r.body);
      if (r.type === "agent") this.imageRefs(r.body);
      else if (r.type === "user") this.mentionThumbs(r.el, r.text);
      if (r.type === "agent") this.linkPaths(r.body, this.cwd);
      else if (r.type === "user") {
        const head = FileLinks.parseRelayHeader(shownUserText(r.text));
        this.linkPaths(r.body, head.from ? head.folder : this.cwd);
      }
    }
    this.touched.clear();
    this.dirty.clear();
    if (rendered) this.followBottom(); // a block rendered here (the turn's last text, at its end) grew: no frame follows it
  }

  // --- groups: the main agent's work (tools, thinking) and each subagent, collapsed (Activity decides the place)
  /** A <details class="group work|subagent">: a one-line header (_renderHeader from _info) and a body. */
  groupElement(kind, { title = "", prompt = null, anchored = true } = {}) {
    const mark = h("span", { class: "mark" });
    const name = h("span", { class: "title" });
    const body = h("div", { class: "group-body" });
    const summary = h("summary", {}, mark, name);
    const el = h("details", { class: `group ${kind}` }, summary, body);
    summary.addEventListener("click", (e) => {
      if (!el.classList.contains("in-panel")) return;
      e.preventDefault(); // its body is in the panel: no toggle, the panel shows it
      this.showInPanel(el);
    });
    // (the kind is in _info: el._kind is the turn mark's "user"/"reply")
    el._info = { kind, title, prompt, status: "running", tools: 0, thoughts: 0, running: new Map(), failed: new Set(), leftover: new Set(), waiting: false, lastLine: "" }; // running: toolCallId -> title
    Object.assign(el, { _body: body, _runs: StreamRuns.create(), _anchored: anchored });
    el._md = () => {
      const i = el._info;
      const items = [...body.children].map((c) => c._md?.()?.trim()).filter(Boolean);
      if (kind === "work") return items.join("\n\n");
      const quoted = i.prompt ? i.prompt.split("\n").map((l) => `> ${l}`).join("\n") : "";
      const name = i.title && i.title !== "subagent" ? `**Subagent: ${i.title}**` : "**Subagent**";
      return [`${name} (${STATUS_WORDS[i.status] ?? i.status})`, quoted, ...items].filter(Boolean).join("\n\n");
    };
    el._renderHeader = () => {
      const i = el._info;
      // work: ● while a tool runs, then ✗ if one failed, ○ if one never ended or was interrupted, else ✓; when its
      // tools ended in different ways, a count per outcome ("✓ 25 · ✗ 1"), the first one behind the header's mark
      const split = kind === "work" ? Activity.toolSplit({ tools: i.tools, running: i.running.size, failed: i.failed.size, leftover: i.leftover.size }) : null;
      const status = kind !== "work" ? i.status : split ? split[0][0] : i.running.size ? "running" : i.failed.size ? "failed" : i.leftover.size ? "quiet" : "completed";
      const runningTitle = [...i.running.values()].pop();
      const args = { kind, title: i.title, tools: i.tools, thoughts: i.thoughts, runningTitle, lastLine: i.status === "running" ? i.lastLine : "", waiting: i.waiting };
      const text = Activity.headerText({ ...args, split });
      const rest = split ? Activity.headerText({ ...args, tools: 0 }) : ""; // what follows the counts
      // the group's summary in the chat, and its entry's in the panel once it has one
      for (const [m, n] of el._entry ? [[mark, name], [el._entry._mark, el._entry._name]] : [[mark, name]]) {
        m.className = `mark ${status}`;
        m.textContent = Activity.MARKS[status] ?? Activity.MARKS.running;
        m.title = MARK_TITLES[status] ?? MARK_TITLES.running;
        n.title = text;
        if (!split) n.textContent = text;
        else {
          // the counts after the first get their own coloured mark
          const more = split.slice(1).flatMap(([s, count]) => [" · ", h("span", { class: `mark ${s}`, title: MARK_TITLES[s] }, Activity.MARKS[s]), ` ${count}`]);
          n.replaceChildren(String(split[0][1]), ...more, rest ? ` · ${rest}` : "");
        }
      }
    };
    el._renderHeader();
    return el;
  }

  /** The main agent's open work group: the log's last element when it is one, else a new one. */
  workGroup() {
    const last = this.log.lastElementChild;
    if (last?._info?.kind === "work") return last;
    this.flush();
    return this.append(this.groupElement("work"));
  }

  /** An item into a group's body: never a turn mark; the log and the panel still follow their bottoms. */
  groupAppend(group, el) {
    group._body.append(el);
    group._renderHeader();
    this.followBottom();
  }

  /** Route an update (Activity) and apply the group changes it brings. */
  route(u) {
    const r = this.activity.route(u, { replaying: !!this.resuming });
    this.applyChanges(r.changes);
    return r;
  }

  /** A streamed chunk where Activity routes it: the log, the work group or a subagent's group. A subagent's text never
   *  falls back to the log: without its group element it is not shown. */
  streamRouted(type, u, text) {
    const r = this.route(u);
    if (r.to === "main") return this.stream(type, text, u.messageId);
    const container = r.to === "work" ? this.workGroup() : this.groupEls.get(r.groupId);
    if (!container) return;
    if (type === "agent" && container._info.kind === "subagent") {
      const line = (this.activity.group(r.groupId)?.lastText ?? "").split("\n").map((l) => l.trim()).filter(Boolean).pop();
      if (line) {
        container._info.lastLine = line.length > 60 ? line.slice(0, 59) + "…" : line;
        container._renderHeader();
      }
    }
    this.stream(type, text, u.messageId, container);
  }

  /** The turn is over (chain end, replay end, the process gone): Activity.settle turns a sync subagent still running
   *  into ⊘ (stopped, no task update came) and a background one with no news into ○; the tools left pending in work
   *  groups (killed, stopped, replayed without an end) no longer count as running. */
  settleGroups() {
    this.applyChanges(this.activity.settle());
    for (const g of this.log.querySelectorAll(":scope > .group.work")) {
      if (!g._info.running.size) continue;
      for (const id of g._info.running.keys()) g._info.leftover.add(id); // ○ until they end
      g._info.running.clear();
      g._renderHeader();
    }
    this.refreshBg();
  }

  /** "N subagent(s) running" after the status line; a click shows the first one. */
  refreshBg() {
    const n = this.activity.running().length;
    this.bgEl.hidden = !n;
    this.bgEl.textContent = n ? `${n} subagent${n === 1 ? "" : "s"} running` : "";
  }

  applyChanges(changes) {
    for (const c of changes) {
      if (c.type === "created") this.addSubagentGroup(c);
      else if (c.type === "status") {
        const el = this.groupEls.get(c.groupId);
        if (!el) continue;
        el._info.status = c.status;
        el._renderHeader();
      } else if (c.type === "merged") this.mergeGroups(this.groupEls.get(c.from), this.groupEls.get(c.into), c.from);
    }
    this.refreshBg();
  }

  /** A subagent group, appended at the log's end (a task's group stands for its badge: replacesTool removes it). */
  addSubagentGroup({ groupId, title, prompt, anchored, replacesTool }) {
    const el = this.groupElement("subagent", { title: title || "subagent", prompt, anchored });
    el._task = {};
    const badge = replacesTool != null ? this.tools.get(replacesTool) : null;
    if (badge) {
      // an earlier update of the task (replay) made it a tool badge: its data is the task's now
      this.tools.delete(replacesTool);
      el._task = badge.data;
      badge.el.remove();
      const g = badge.group;
      g._info.tools--;
      g._info.running.delete(replacesTool);
      g._info.failed.delete(replacesTool);
      g._info.leftover.delete(replacesTool);
      if (g._body.childElementCount || g._turn) g._renderHeader();
      else this.removeGroup(g);
    }
    this.groupEls.set(groupId, el);
    this.renderTask(el);
    this.flush();
    this.append(el);
  }

  /** Parallel sync subagents: a standalone group turned out to be a task's; its items go after the task's prompt. */
  mergeGroups(from, into, fromId) {
    this.groupEls.delete(fromId);
    if (!from || !into) return;
    const items = [...from._body.childNodes];
    if (into._prompt) into._prompt.after(...items);
    else into._body.prepend(...items);
    if (this.isOpen(from)) this.setOpen(into, true); // you opened it: it stays open
    into._runs = from._runs; // a continuing message keeps its block (an unlinked task group never streamed: no runs of its own)
    into._info.tools += from._info.tools;
    into._info.thoughts += from._info.thoughts;
    for (const [id, title] of from._info.running) into._info.running.set(id, title);
    for (const id of from._info.failed) into._info.failed.add(id);
    for (const id of from._info.leftover) into._info.leftover.add(id);
    for (const t of this.tools.values()) if (t.group === from) t.group = into;
    this.removeGroup(from);
    into._renderHeader();
  }

  // --- the activity panel: a group's body inside the group (inline) or inside its entry in the panel
  /** Put the group's body where the mode says (Activity.inPanel, read here only): inside the group, or inside the
   *  group's entry in the panel, the entries in the order of their groups in the log. Only what changes place is
   *  moved; the open state goes with the body. dim false: the caller dims the entries (placeAll, once for all). */
  place(group, dim = true) {
    const inPanel = Activity.inPanel(activityPanel, group._info.kind);
    if (inPanel && !group._entry) {
      const mark = h("span", { class: "mark" });
      const name = h("span", { class: "title" });
      const summary = h("summary", {}, mark, name);
      // you open it to read it: the panel stops following. Opened here rather than by the default action, so that
      // the browser's scroll anchoring for the grown entry happens when scrollTop is read, and its scroll is the app's
      summary.addEventListener("click", (e) => {
        if (group._entry.open) return;
        e.preventDefault();
        group._entry.open = true;
        this.panelFollow = false;
        this.panelOwnTop = this.panelBody.scrollTop;
      });
      group._entry = Object.assign(h("details", { class: `panel-entry ${group._info.kind}` }, summary), { _mark: mark, _name: name });
      group._renderHeader();
    }
    const holder = inPanel ? group._entry : group;
    if (inPanel) {
      // before the entry of the next group in the log that has one in the panel
      let next = group.nextElementSibling;
      while (next && next._entry?.parentNode !== this.panelBody) next = next.nextElementSibling;
      const ref = next?._entry ?? null;
      if (holder.parentNode !== this.panelBody || holder.nextElementSibling !== ref) moveNode(this.panelBody, holder, ref);
    }
    const from = group._body.parentNode;
    if (from !== holder) {
      const open = from.open;
      moveNode(holder, group._body, null);
      from.open = false;
      holder.open = open;
    }
    if (!inPanel) group._entry?.remove();
    group.classList.toggle("in-panel", inPanel);
    if (dim && this.edit) this.dimEntries(); // a group created or moved during an edit (none is dimmed otherwise)
    this.updatePanelShown();
  }

  /** place() for every group of the log, in log order (the mode changed). */
  placeAll() {
    for (const g of this.log.querySelectorAll(":scope > .group")) this.place(g, false);
    if (this.edit) this.dimEntries(); // once for all the groups, not once per group
    this.followBottom(); // bodies that moved changed the content of the log and the panel, not always their size
  }

  /** The slot holds Activity while it has an entry, Communication while the session belongs to a tree; when both
   *  are available, the stored choice (ui.rightPanel) wins; never both shown. */
  updatePanelShown() {
    const activity = !!this.panelBody.firstElementChild;
    const comms = CommsModel.inTree(tree, this.sessionId);
    const kind = UiState.slotPanel(ui.rightPanel, activity, comms);
    if (kind === this.panelKind && activity === this.activityAvailable && comms === this.commsAvailable) return;
    Object.assign(this, { panelKind: kind, activityAvailable: activity, commsAvailable: comms });
    this.panel.hidden = kind !== "activity";
    this.commsPanel.hidden = kind !== "comms";
    this.panelHandle.hidden = kind === null;
    this.layoutPanel();
    if (kind === "comms") commsRefresh();
  }

  /** The panel's geometry for the view's width (UiState.panelLayout): its width, the narrow layout (a drawer over
   *  the log) and what shows: in the wide layout the panel unless collapsed (ui.panelCollapsed), in the narrow one
   *  the drawer while open (drawerOpen). panel.hidden / commsPanel.hidden mean "not in the slot"; the rest is
   *  classes on the row. */
  layoutPanel() {
    this.activityBtn.hidden = !this.activityAvailable;
    this.commsBtn.hidden = !this.commsAvailable;
    const viewWidth = this.row.clientWidth;
    if (!viewWidth) return; // not shown: laid out when it shows (the row's ResizeObserver)
    const { narrow, width } = UiState.panelLayout(viewWidth, ui.panelWidth);
    this.panel.style.width = this.commsPanel.style.width = `${width}px`;
    this.row.classList.toggle("narrow", narrow);
    this.row.classList.toggle("collapsed", !narrow && ui.panelCollapsed);
    this.row.classList.toggle("drawer-open", narrow && this.drawerOpen);
    this.panelClose.textContent = this.commsClose.textContent = narrow ? "✕" : "»";
    this.panelClose.title = narrow ? "Close (Esc)" : "Hide the activity panel";
    this.commsClose.title = narrow ? "Close (Esc)" : "Hide the communication panel";
  }
  /** The layout applied: the panel is a drawer over the log. */
  isNarrow() {
    return this.row.classList.contains("narrow");
  }
  /** The aside in the slot (null when none). */
  shownPanel() {
    return this.panelKind === "comms" ? this.commsPanel : this.panelKind === "activity" ? this.panel : null;
  }
  setDrawer(open) {
    const closing = !open && this.row.classList.contains("drawer-open") && !!this.shownPanel()?.contains(document.activeElement);
    this.drawerOpen = open;
    this.layoutPanel();
    if (open) commsRefresh(); // a Communication panel back on screen retries a failed load (drawComms)
    // the focus leaves the drawer it was in for the button that opens it again (not the message box, where the next
    // Esc would stop the turn)
    if (closing) (this.panelKind === "comms" ? this.commsBtn : this.activityBtn).focus();
  }
  /** A header button ("Activity" / "Communication"): the other panel's button switches the slot to its panel and
   *  reveals it; the shown panel's button hides or shows it. */
  switchPanel(kind) {
    if (this.panelKind === kind) this.togglePanel();
    else this.showPanel(kind);
  }
  /** The slot's choice is `kind` (stored, every view follows); this view reveals it. */
  showPanel(kind) {
    setRightPanel(kind);
    this.revealPanel();
  }
  /** The shown panel's button. */
  togglePanel() {
    if (this.isNarrow()) this.setDrawer(!this.drawerOpen);
    else setPanelCollapsed(!ui.panelCollapsed);
  }
  /** The panel head's button. */
  hidePanel() {
    if (this.isNarrow()) this.setDrawer(false);
    else setPanelCollapsed(true);
  }
  /** A group is shown: the panel un-collapsed, or the drawer opened. */
  revealPanel() {
    if (this.isNarrow()) this.setDrawer(true);
    else if (ui.panelCollapsed) setPanelCollapsed(false);
  }
  /** The handle dragged: the width follows the pointer in real pixels, kept within the layout's limits; stored and
   *  applied to every view when the drag ends. */
  dragPanel(e) {
    if (e.button !== 0) return;
    e.preventDefault(); // no text selection while dragging
    const startX = e.clientX;
    const start = (this.shownPanel() ?? this.panel).getBoundingClientRect().width; // the one in the slot (the other is display:none)
    const move = (m) => {
      ui.panelWidth = UiState.panelLayout(this.row.clientWidth, start + startX - m.clientX).width;
      this.layoutPanel();
    };
    const end = () => {
      removeEventListener("pointermove", move);
      removeEventListener("pointerup", end);
      removeEventListener("pointercancel", end);
      document.body.classList.remove("panel-resizing");
      saveUi();
      layoutPanels();
    };
    addEventListener("pointermove", move);
    addEventListener("pointerup", end);
    addEventListener("pointercancel", end);
    document.body.classList.add("panel-resizing");
  }

  /** Whether the group is open: the state of whatever holds its body (the group, or its entry in the panel). */
  isOpen(group) {
    return group._body.parentNode.open;
  }
  setOpen(group, open) {
    group._body.parentNode.open = open;
  }

  /** A group leaves the log, and its entry the panel. */
  removeGroup(group) {
    group.remove();
    group._entry?.remove();
    this.updatePanelShown();
  }

  /** An in-panel group's header clicked in the chat (or "N subagents running"): its entry opened, scrolled into view
   *  and highlighted for a second. The panel stops following, and the scroll made here does not turn it back on. */
  showInPanel(group) {
    // the entry is in Activity: bring it into the slot first (setRightPanel re-evaluates every view synchronously)
    if (this.panelKind !== "activity") this.showPanel("activity");
    else this.revealPanel();
    const entry = group._entry;
    entry.open = true;
    this.panelFollow = false;
    entry.scrollIntoView({ block: "nearest" });
    this.panelOwnTop = this.panelBody.scrollTop;
    entry.classList.add("flash");
    clearTimeout(entry._flash);
    entry._flash = setTimeout(() => entry.classList.remove("flash"), 1000);
  }

  /** A task call's update: no badge, its prompt and error are in its group (the status comes with the changes). */
  taskUpdate(el, u) {
    el._task = ToolCalls.merge(el._task, u);
    this.renderTask(el);
  }
  renderTask(el) {
    const d = el._task;
    const prompt = d.rawInput?.prompt ?? el._info.prompt;
    if (prompt) {
      el._info.prompt = prompt;
      if (!el._prompt) {
        el._prompt = h("details", { class: "task-prompt" }, h("summary", {}, "Prompt"), h("pre", {}));
        el._body.prepend(el._prompt);
      }
      el._prompt.querySelector("pre").textContent = prompt;
    }
    const error = d.status === "failed" ? d.rawOutput?.message : null;
    if (error) {
      el._error ??= h("div", { class: "msg error" });
      el._error._md = () => `Error: ${el._error.textContent}`;
      el._error.textContent = error;
      if (!el._error.isConnected) this.groupAppend(el, el._error);
    } else el._error?.remove();
  }

  // --- ACP session/update
  onUpdate(u) {
    this.lastUpdate = Date.now();
    this.delivery?.update(u);
    const text = u.content?.type === "text" ? u.content.text : "";
    switch (u.sessionUpdate) {
      case "user_message_chunk":
        // our own prompt is already shown; only replayed history (session/load) is rendered
        if (!this.prompting) this.stream("user", text);
        break;
      case "agent_message_chunk": {
        // the switch point of a mid-turn send is not shown (a Stop of yours still shows whatever Copilot sends)
        const sw = this.chain.marker(text);
        if (sw) this.switchPoint(sw);
        else this.streamRouted("agent", u, text);
        break;
      }
      case "agent_thought_chunk":
        this.streamRouted("thought", u, text);
        break;
      case "tool_call":
        this.applyTool(u);
        this.toolBoundary(u);
        break;
      case "tool_call_update":
        this.applyTool(u);
        this.toolBoundary(u);
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
      case "available_commands_update":
        this.setCommands(u.availableCommands ?? []);
        break;
      default:
        break; // current_mode_update, usage_update…
    }
  }

  /** Track the chain's tools; when the last one in flight finishes, the queue head may go out mid-turn. */
  toolBoundary(u) {
    if (!this.chain.toolUpdate(u)) return;
    // one mid-turn send at a time: until its switch point the tools of the turn are not known to be settled; after
    // your Stop a tool may still report completed/failed: what is queued then waits for the end of the turn
    if (this.chain.midTurnBlocked()) return;
    const { prompting, paused, edit, historyOp, holdInbox, deleting, dead } = this;
    const s = { enabled: queueMidTurn, paused, prompting, edit, historyOp, holdInbox, deleting, dead, inFlight: this.chain.inFlight(), head: this.queue[0] };
    if (MessageQueue.canDeliverMidTurn(s)) this.deliverMidTurn();
  }

  /** The single entry for every tool update, also the synthetic "interrupted" ones of switchPoint/chainEnded. */
  applyTool(u) {
    const r = this.route(u);
    if (r.to === "work") {
      if (u.sessionUpdate === "tool_call") this.flush(); // its badge closes the log's block (a subagent's does not)
      return this.toolCall(u);
    }
    const group = this.groupEls.get(r.groupId);
    if (!group) return; // never in the log or the main agent's work
    if (r.task) this.taskUpdate(group, u);
    else this.toolCall(u, group);
  }

  /** A tool badge: a new one goes into the given group, else into the main agent's work group; an update goes to the
   *  badge wherever it is. */
  toolCall(u, group = null) {
    let t = this.tools.get(u.toolCallId);
    if (!t) {
      const st = h("span", { class: "st" });
      const name = h("span", { class: "name" });
      const kind = h("span", { class: "kind" });
      const body = h("div", { class: "body" });
      const el = h("details", { class: "tool" }, h("summary", {}, st, kind, name), body);
      t = { el, st, name, kind, body, data: {}, group: group ?? this.workGroup() };
      el._md = () => `*Tool: ${t.data.title ?? "tool"} (${t.data.status ?? "pending"})*`;
      this.tools.set(u.toolCallId, t);
      this.finishRuns();
      t.group._runs.close();
      t.group._info.tools++;
      this.groupAppend(t.group, el);
    }
    const d = (t.data = ToolCalls.merge(t.data, u));
    const status = d.status ?? "pending";
    const { running } = t.group._info;
    if (status === "pending" || status === "in_progress") running.set(u.toolCallId, d.title ?? "tool");
    else running.delete(u.toolCallId);
    if (status === "interrupted") t.group._info.leftover.add(u.toolCallId); // ○ like a tool that never ended, not ✓
    else if (status !== "pending" && status !== "in_progress") t.group._info.leftover.delete(u.toolCallId);
    if (status === "failed") t.group._info.failed.add(u.toolCallId);
    else t.group._info.failed.delete(u.toolCallId);
    t.group._renderHeader();
    t.st.className = `st ${status}`;
    t.st.textContent = { completed: "✓", failed: "✗", in_progress: "●", pending: "○", interrupted: "⊘" }[status] ?? "●";
    t.kind.textContent = d.kind && d.kind !== "other" ? d.kind : "";
    t.name.textContent = d.title ?? "tool";
    t.body.replaceChildren(...this.toolBody(d));
    decoratePres(t.body);
    linkify(t.body);
    if (status === "completed" || status === "failed") this.linkPaths(t.body, this.cwd);
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
    // in place while only groups came after it (tool calls and thinking collapse into groups)
    let after = this.planEl?.isConnected ? this.planEl.nextElementSibling : null;
    while (after?.classList.contains("group")) after = after.nextElementSibling;
    if (this.planEl?.isConnected && !after) this.planEl.replaceChildren(h("b", {}, "Plan"), list);
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
    // main has answered this one as cancelled (or the process is gone): nothing is left to decide
    card._dismiss = (label = "→ turn ended") => {
      card.classList.add("done");
      opts.replaceChildren(h("span", {}, label));
      this.closeCard(card);
    };
    card._toolCallId = toolCall?.toolCallId ?? null; // a mid-turn switch dismisses the cards of the tools it killed
    // a subagent's question (a background subagent runs on after the turn): see dismissPermissions
    card._agentId = ToolCalls.agentOf(toolCall) ?? ToolCalls.agentOf(this.tools.get(card._toolCallId)?.data);
    card._pending = { kind: "permission", id: reqId };
    card._reqId = reqId; // ...and answers their requests
    card._group = this.tools.get(card._toolCallId)?.group ?? null; // its header shows ⏸ while the card is open
    if (card._group) {
      card._group._info.waiting = true;
      card._group._renderHeader();
    }
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
              this.closeCard(card);
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
    this.openCard(card);
    this.statusEl.textContent = "Waiting for your permission…";
  }

  /** This session asks for a new session. Everything on the card is model-written: plain text only, never Markdown.
   *  `start` is what main made of the request (delegation.mjs cardStart): the folder, context, agent and model the
   *  card starts with, their lists, the own part and the Copilot command, which values came from the parent (`from`)
   *  and why a value it asked for was not taken (`notes`). Every one of them can be changed on the card; Approve
   *  sends what the card shows, Reject nothing. Approve waits until the prompt editor has its Settings parts. A child
   *  whose start fails (its command, its folder, or an agent or model its folder does not offer) leaves the card open
   *  with the reason, for another value and a second Approve, or a Reject: main keeps the request and has told the
   *  parent nothing. */
  delegationCard({ requestId, name, task, start = {} }) {
    this.flush();
    const from = start.from ?? {};
    const notes = start.notes ?? {};
    const command = start.command ?? "";
    const fromMark = (key) => (from[key] ? h("span", { class: "dc-from" }, `from ${start.parentName || "the session"}`) : null);
    const note = (key) => (notes[key] ? h("p", { class: "hint dc-note" }, notes[key]) : null);
    const select = (cls, entries, value) => {
      const sel = h("select", { class: cls }, entries.map(([v, label]) => h("option", { value: v }, label)));
      sel.value = value ?? "";
      if (sel.selectedIndex < 0) sel.selectedIndex = 0;
      return sel;
    };
    // "" is the default agent and the inherited model: the first entry stands for it
    const listed = (list) => (list ?? []).filter((o) => o.value !== "").map((o) => [o.value, o.name || o.value]);
    const row = FolderRow.createFolderRow({ value: start.cwd ?? "", pick: (cur) => api.pickDir("Folder for the new session", cur), h });
    const contextSel = select("dc-context", [["default", "200k"], ["long_context", "1M"]], start.tier);
    const agentSel = select("dc-agent", [["", "default"], ...listed(start.agents)], start.agent);
    if (agentSel.options.length < 2) agentSel.disabled = true; // no custom agents: only the default
    const modelSel = select("dc-model", [["", start.currentModel ? `inherited (${start.currentModel})` : "inherited"], ...listed(start.models)], start.model);
    const field = (label, value, key) => [h("dt", {}, label), h("dd", {}, key ? [h("div", { class: "dc-value" }, value, fromMark(key)), note(key)] : value)];
    const fieldsEl = h(
      "dl",
      { class: "fields" },
      field("Name", name),
      field("Folder", row.el, "cwd"),
      field("Context", contextSel, "tier"),
      field("Agent", agentSel, "agent"),
      field("Model", modelSel, "model"),
    );
    // the command field's marks: whose it is, the warning for a parent-written one, the arguments it added in full
    // (the one-line field can hide its end), why the parent's was not taken
    const addedArgs = from.command ? (start.addedArgs ?? []) : [];
    const commandMarks = () => [
      from.command ? h("div", { class: "dc-marks" }, fromMark("command"), h("span", { class: "dc-warning" }, "Written by the session that asked. It runs when you approve.")) : null,
      addedArgs.length ? h("p", { class: "hint dc-args" }, `Arguments added by ${start.parentName || "the session"}: ${addedArgs.join(" ")}`) : null,
      note("command"),
    ];
    let editor = null;
    const promptSlot = h("div", { class: "delegation-prompt" }, h("p", { class: "hint" }, "Loading the prompt parts…"));
    const errorEl = h("p", { class: "hint delegation-error", hidden: true });
    const answer = async (approved) => {
      this.closeCard(card);
      const own = approved ? (editor?.value() ?? "") : "";
      // without the editor (Settings could not be read) the child takes the command main gave, which the hint shows
      const childCommand = editor ? editor.command() : command;
      const fields = approved ? { cwd: row.value(), tier: contextSel.value, agent: agentSel.value, model: modelSel.value } : undefined;
      // while it is answered nothing is edited; only what was usable is given back if the card takes another answer
      const frozen = [fieldsEl, promptSlot].flatMap((el) => [...el.querySelectorAll("textarea, select, button, input")]).filter((c) => !c.disabled);
      for (const c of frozen) c.disabled = true;
      errorEl.hidden = true;
      opts.replaceChildren(h("span", {}, approved ? "Creating the session…" : "Rejecting…"));
      let result;
      try {
        const res = await api.answerDelegation(requestId, approved, own, childCommand, fields);
        if (res?.outcome === "failed" && res.retry) {
          // the child did not start: the request is still open in main, and so is the card
          for (const c of frozen) c.disabled = false;
          // without the editor there is no command field to change: say so, as the text points at the card
          errorEl.textContent = editor ? res.text : `${res.text}\n\nThis card could not load its command field. Reject it and let the session ask again.`;
          errorEl.hidden = false;
          opts.replaceChildren(approveBtn, rejectBtn);
          this.openCard(card);
          // the clicked button is gone and took the focus with it: back to what is to be corrected
          if (activeId === this.sessionId && (!document.activeElement || document.activeElement === document.body)) promptSlot.querySelector(".pe-command")?.focus();
          return;
        }
        result = !res ? "This request is no longer open." : res.outcome === "failed" ? `Not created: ${res.text}` : approved ? "→ Approved" : "→ Rejected";
      } catch (e) {
        result = `Could not answer: ${e.message}`;
      }
      card.classList.add("done");
      opts.replaceChildren(h("span", {}, result));
    };
    const approveBtn = h("button", { class: "primary", disabled: true, onclick: () => answer(true) }, "Approve");
    const rejectBtn = h("button", { onclick: () => answer(false) }, "Reject");
    const opts = h("div", { class: "opts" }, approveBtn, rejectBtn);
    const card = h(
      "div",
      { class: "perm delegation" },
      h("div", { class: "q" }, h("b", {}, "New session requested")),
      fieldsEl,
      h("div", { class: "task" }, task),
      promptSlot,
      errorEl,
      opts,
    );
    api
      .getSettings()
      .then((s) => {
        editor = PromptEditor.createPromptEditor({
          defaultPart: s.defaultPart ?? "",
          childPart: s.promptChild ?? s.childPartDefault ?? "",
          templates: s.promptTemplates ?? [],
          own: start.own ?? "",
          command: { value: command, settings: s.effective, platform: s.platform },
          h,
        });
        if (from.own) editor.el.querySelector(".pe-own")?.after(h("div", { class: "dc-marks" }, fromMark("own")));
        editor.el.querySelector(".pe-command-row")?.after(...commandMarks().filter(Boolean));
        promptSlot.replaceChildren(editor.el);
      })
      .catch((e) => {
        const using = command ? `the Copilot command "${command}"` : "this session's Copilot command";
        promptSlot.replaceChildren(h("p", { class: "hint" }, `Could not read the prompt parts (${e.message}). Approve starts the session without an own part, with ${using}.`), ...commandMarks().filter(Boolean));
      })
      .finally(() => (approveBtn.disabled = false));
    card._pending = { kind: "create", id: requestId, name };
    this.append(card);
    this.openCard(card);
  }

  /** A relative of this session sent a message to a closed one: the user decides whether it is reopened. The names
   *  and previews are model-written: plain text only. */
  reopenCard({ requestId, targetSessionId, targetName, fromName, previews }) {
    const previewEls = (list) => (list ?? []).map((p) => h("div", { class: "task" }, p));
    if (this.reopenRequests.has(requestId)) {
      // another message to the same closed target: the open card shows every queued one; an answered id stays ignored
      this.reopenRequests.get(requestId)?.replaceChildren(...previewEls(previews));
      return;
    }
    const previewsEl = h("div", { class: "previews" }, previewEls(previews));
    this.reopenRequests.set(requestId, previewsEl);
    this.flush();
    const NOT_PENDING = "This request is no longer pending.";
    const answer = async (approved) => {
      this.reopenRequests.set(requestId, null);
      this.closeCard(card);
      opts.replaceChildren(h("span", {}, approved ? "Reopening…" : "Rejecting…"));
      // each answer is false when the broker no longer has the request; a thrown one did not arrive
      const say = async (ok, reason, text) => ((await api.answerReopen(this.sessionId, requestId, ok, reason)) ? text : NOT_PENDING);
      let result;
      try {
        if (!approved) {
          result = await say(false, undefined, "→ Rejected");
        } else if (deleting.has(targetSessionId)) {
          result = await say(false, undefined, "This session is being deleted.");
        } else {
          const tv = views.get(targetSessionId); // open (or a dead view): never "missing", that would forget its link
          let target = tv ? { sessionId: targetSessionId, cwd: tv.cwd, title: tv.title } : sessions.find((s) => s.sessionId === targetSessionId);
          let complete = true;
          if (!target) {
            const listed = await api.listSessionsChecked();
            target = listed.sessions.find((s) => s.sessionId === targetSessionId);
            complete = listed.complete;
          }
          if (target) {
            result = await say(true, undefined, "→ Approved");
            // the queued message is delivered when it registers (no-op if open)
            if (result !== NOT_PENDING) openSession(target, { activate: false });
          } else if (!complete) {
            // a partial list proves nothing: approve without forgetting; the message waits until it is opened
            result = await say(true, undefined, "→ Approved. It was not found in the session list; open it to deliver the message.");
          } else {
            result = await say(false, "missing", "This session no longer exists.");
          }
        }
      } catch (e) {
        // not answered: the buttons come back, so the user can try again
        this.reopenRequests.set(requestId, previewsEl);
        opts.replaceChildren(h("span", { class: "err" }, `Could not answer: ${e.message}`), ...buttons());
        this.openCard(card);
        return;
      }
      card.classList.add("done");
      opts.replaceChildren(h("span", {}, result));
    };
    const buttons = () => [h("button", { class: "primary", onclick: () => answer(true) }, "Approve"), h("button", { onclick: () => answer(false) }, "Reject")];
    const opts = h("div", { class: "opts" }, buttons());
    const card = h(
      "div",
      { class: "perm reopen" },
      h("div", { class: "q" }, h("b", {}, fromName), ` wants to message the closed session `, h("b", {}, targetName), ". Reopen it?"),
      previewsEl,
      opts,
    );
    card._pending = { kind: "reopen", id: requestId };
    this.append(card);
    this.openCard(card);
  }

  /** This session asks to adopt another session as its sub-session, or to release one. The names and the task are
   *  model-visible strings: plain text only. */
  linkCard({ requestId, kind, childName, childCwd, parentName, task }) {
    if (this.linkRequests.has(requestId)) return;
    this.linkRequests.add(requestId);
    this.flush();
    const adopt = kind === "adopt";
    const field = (label, value) => (value ? [h("dt", {}, label), h("dd", {}, value)] : []);
    const DONE = { linked: "→ Linked", released: "→ Released", rejected: "→ Rejected" };
    const answer = async (approved) => {
      this.closeCard(card);
      opts.replaceChildren(h("span", {}, !approved ? "Rejecting…" : adopt ? "Linking…" : "Unlinking…"));
      let result;
      try {
        // false when the broker no longer has the request; a thrown answer did not arrive
        const answered = await api.answerLink(this.sessionId, requestId, approved);
        result = !answered ? "This request is no longer pending." : (DONE[answered.result] ?? answered.text);
      } catch (e) {
        // not answered: the buttons come back, so the user can try again
        opts.replaceChildren(h("span", { class: "err" }, `Could not answer: ${e.message}`), ...buttons());
        this.openCard(card);
        return;
      }
      card.classList.add("done");
      opts.replaceChildren(h("span", {}, result));
    };
    const buttons = () => [h("button", { class: "primary", onclick: () => answer(true) }, "Approve"), h("button", { onclick: () => answer(false) }, "Reject")];
    const opts = h("div", { class: "opts" }, buttons());
    const card = h(
      "div",
      { class: "perm link" },
      h("div", { class: "q" }, h("b", {}, adopt ? "Link sessions" : "Unlink sessions")),
      adopt
        ? h("div", { class: "q" }, h("b", {}, parentName), " asks to take ", h("b", {}, childName), " as its sub-session.")
        : h("div", { class: "q" }, h("b", {}, parentName), " asks to release its sub-session ", h("b", {}, childName), "."),
      h("dl", { class: "fields" }, field("Session", childName), adopt ? field("Folder", childCwd) : []),
      ...(!adopt && task ? [h("div", { class: "task" }, task)] : []),
      h(
        "div",
        { class: "note" },
        adopt
          ? `${childName} will be listed under ${parentName} and can report to it. Closing ${parentName} will also close ${childName}.`
          : `${childName} becomes a top-level session and keeps its own sub-sessions.`,
      ),
      opts,
    );
    card._pending = { kind: "link", id: requestId };
    this.append(card);
    this.openCard(card);
  }

  /** The bar under the header: this session's parent and sub-sessions from the link tree. */
  renderRelations() {
    const rel = SessionTree.relation(tree, this.sessionId);
    const parent = rel.parent === this.sessionId ? null : rel.parent;
    const parts = [];
    if (parent) parts.push(h("span", { class: "rel" }, h("span", { class: "rel-label" }, "Parent:"), relationChip(parent)));
    else if (rel.parentDeleted) parts.push(h("span", { class: "rel" }, h("span", { class: "rel-label" }, "Parent:"), h("span", { class: "rel-gone" }, "deleted")));
    if (rel.children.length) {
      parts.push(h("span", { class: "rel" }, h("span", { class: "rel-label" }, "Sub-sessions:"), rel.children.map((c) => relationChip(c.id, { child: true, grandchildren: c.grandchildren }))));
    }
    this.relationsEl.replaceChildren(...parts);
    this.relationsEl.hidden = !parts.length;
    this.closeChildrenBtn.hidden = !openDescendants(this.sessionId).length;
    this.renderHoldSwitches();
  }

  /** pendingCards changed: the Communication panel marks the waiting cards (comms-view). */
  cardsChanged() {
    commsRefresh();
  }

  get needsAttention() {
    return !this.dead && this.openCards.size > 0;
  }

  openCard(card) {
    this.setDrawer(false); // the question must be visible (permission, delegation, reopen and link cards)
    this.openCards.add(card);
    const p = card._pending;
    if (p && !this.pendingCards.some((c) => c.kind === p.kind && c.id === p.id)) {
      this.pendingCards.push(p);
      this.cardsChanged();
    }
    renderList();
  }

  closeCard(card) {
    if (this.openCards.delete(card)) renderList();
    const p = card._pending;
    if (p && this.pendingCards.includes(p)) {
      this.pendingCards = this.pendingCards.filter((c) => c !== p);
      this.cardsChanged();
    }
    const g = card._group;
    if (g && ![...this.openCards].some((c) => c._group === g)) {
      g._info.waiting = false;
      g._renderHeader();
    }
  }

  /** The turn is over (all: the process is gone): main no longer waits for its permission questions, except a
   *  subagent's after a turn that was not stopped (ToolCalls.keepCardAtTurnEnd). Delegation cards are not tied to a turn. */
  dismissPermissions({ all = true, stopped = false } = {}) {
    for (const card of [...this.openCards]) {
      if (!all && ToolCalls.keepCardAtTurnEnd({ agentId: card._agentId, stopped })) continue;
      card._dismiss?.();
    }
  }

  /** A new context window: live when Copilot's own option takes it (main answers { configOptions }); otherwise it
   *  needs a new Copilot process: main closes the session, the reopen replays it. */
  async switchContext(sel, previous) {
    if (this.busy || this.dead || this.deleting) {
      sel.value = previous;
      sel._retitle?.();
      if (this.busy && !this.dead && !this.deleting) this.error("Wait until Copilot finishes this turn.");
      return;
    }
    this.setBusy(true);
    this.statusEl.textContent = "Changing the context window…";
    let failure = null;
    try {
      const res = await api.setContextTier(this.sessionId, sel.value);
      if (res?.refused) {
        // nothing was changed or closed: the session stays as it is (main's options as they are now, when it sent
        // them: an update during a failed live set may have rebuilt the selects already)
        if (res.configOptions) this.setConfig(res.configOptions);
        else sel.value = previous;
        sel._retitle?.();
        this.setBusy(false);
        this.error(`Could not change the context window: ${res.refused}`);
        return;
      }
      if (res?.configOptions) {
        this.setConfig(res.configOptions);
        this.setBusy(false);
        this.statusEl.textContent = "Context window changed (no restart needed).";
        return;
      }
    } catch (e) {
      failure = e;
    }
    await this.restarted(failure, "the context window");
  }

  /** Main closed the session for a restart (a new context window or prompt), or failed while doing it: the reopen
   *  replays it, with the failure as an error. */
  async restarted(failure, what) {
    if (failure) await api.closeSession(this.sessionId).catch(() => {}); // closed for sure: the reopen replays it unchanged
    await reopenView(this, failure && `Could not change ${what}: ${failure.message}`);
  }

  /** The header's Setup button: the session's own prompt part and Copilot command in the prompt dialog; "Save and
   *  restart" restarts Copilot with them (main closes the session, the reopen replays it). It also works on a dead
   *  view (a broken command is repaired here): nothing is closed, the reopen starts it again. A refusal keeps the
   *  dialog open with the text; unchanged values close it and restart nothing
   *  (on a dead view they reopen it: the cause may have been fixed elsewhere, in Settings). */
  async editPrompt() {
    if (this.busy || this.deleting || $("#prompt-dialog").open) return;
    let p, s;
    try {
      [p, s] = await Promise.all([api.getPrompt(this.sessionId), api.getSettings()]);
    } catch (e) {
      return this.error(`Could not read this session's setup: ${e.message}`);
    }
    if (this.deleting || views.get(this.sessionId) !== this) return;
    const editor = PromptEditor.createPromptEditor({
      defaultPart: p.defaultPart,
      childPart: p.isChild ? p.childPart : null,
      templates: s.promptTemplates ?? [],
      own: p.own,
      command: { value: p.command, settings: p.settingsCommand, platform: s.platform },
      h,
    });
    let restart = false;
    let failure = null;
    const onOk = async (own, command) => {
      if (this.deleting || views.get(this.sessionId) !== this) return "This session is no longer open here. Open its setup again.";
      if (this.busy) return "Wait until Copilot finishes this turn.";
      const dead = this.dead; // a dead view has no Copilot to close and no turn to hold off
      if (!dead) {
        this.setBusy(true); // nothing starts a turn while main closes the session
        this.statusEl.textContent = "Restarting Copilot with the new setup…";
      }
      try {
        const res = await api.setPrompt(this.sessionId, own, command);
        if (res?.reopen || (res?.unchanged && dead)) return void (restart = true); // a dead view reopens even unchanged
        if (!dead) this.setBusy(false); // refused or unchanged: nothing was closed
        return res?.refused || undefined;
      } catch (e) {
        failure = e; // main may have closed it: the reopen below shows the failure
        restart = true;
      }
    };
    const title = `Setup: ${this.titleEl.textContent || this.cwd}`;
    await PromptEditor.openPromptDialog({ title, okLabel: "Save and restart", note: RESTART_NOTE, editor, onOk });
    if (restart) await this.restarted(failure, "the setup");
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
          // the title: the option's name and its full chosen value (a narrow select cuts it), then the description
          const titleOf = () => [`${c.name}: ${sel.selectedOptions[0]?.textContent ?? ""}`, c.description].filter(Boolean).join("\n");
          const sel = h(
            "select",
            {},
            opts.map((o) => {
              const usage = o._meta?.copilotUsage ? ` (${o._meta.copilotUsage})` : "";
              const opt = h("option", { value: o.value, title: o.description ?? "" }, o.name + usage);
              if (o.value === c.currentValue) opt.selected = true;
              return opt;
            }),
          );
          sel._retitle = () => (sel.title = titleOf());
          sel._retitle();
          sel.addEventListener("change", async () => {
            sel._retitle();
            if (c.id === "context_tier") return this.switchContext(sel, c.currentValue);
            try {
              const updated = await api.setConfig(this.sessionId, c.id, sel.value);
              if (updated) this.setConfig(updated);
            } catch (e) {
              this.error(`Could not change ${c.name}: ${e.message}`);
              sel.value = c.currentValue;
              sel._retitle();
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
      else this.setAgent({ ...this.agentOption, currentValue: value });
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
  async copyThread() {
    this.flush();
    const parts = [`# ${this.title ? shortTitle(this.title) : "Copilot session"}`, `_${this.cwd} · ${this.sessionId}_`];
    for (const el of this.log.children) {
      const t = el._md?.();
      if (t && t.trim()) parts.push(t.trim());
    }
    try {
      await api.copy(parts.join("\n\n"));
      this.statusEl.textContent = "Thread copied to the clipboard as Markdown.";
    } catch (e) {
      this.error(`Could not copy the thread: ${e.message}`);
    }
  }

  // --- the header's ⋯ menu

  /** Opens or closes the ⋯ menu; open, the focus goes to its first item. */
  toggleMore(open = this.moreMenu.hidden) {
    this.moreMenu.hidden = !open;
    this.moreBtn.setAttribute("aria-expanded", String(open));
    this.moreBtn.classList.toggle("open", open);
    if (open) {
      this.moreItems()[0]?.focus();
      document.addEventListener("pointerdown", this.onMoreOutside, true);
    } else document.removeEventListener("pointerdown", this.onMoreOutside, true);
  }

  /** The menu's items that can be used now (shown, enabled). */
  moreItems() {
    return [...this.moreMenu.querySelectorAll("button")].filter((b) => !b.hidden && !b.disabled);
  }

  /** An item click closes the menu; Esc closes it (the focus back on ⋯), Tab closes it, arrows walk the items; a
   *  press outside the menu and the button closes it. */
  bindMoreMenu() {
    this.onMoreOutside = (e) => {
      if (!this.moreMenu.contains(e.target) && !this.moreBtn.contains(e.target)) this.toggleMore(false);
    };
    this.moreMenu.addEventListener("click", (e) => {
      if (!e.target.closest("button")) return;
      this.toggleMore(false);
      // the focus leaves the hidden item: back to the message box (a dialog an item opens takes it from there)
      if (this.moreMenu.contains(document.activeElement) || document.activeElement === document.body) (this.dead ? this.moreBtn : this.input).focus();
    });
    // the focus leaving the menu and its button (Tab, a click elsewhere that takes focus) closes it; a click on the
    // menu's padding moves no focus out, and Esc / arrows keep working from the menu itself
    this.moreMenu.addEventListener("pointerdown", (e) => {
      if (!e.target.closest("button")) e.preventDefault();
    });
    this.moreMenu.addEventListener("focusout", (e) => {
      if (!this.moreMenu.hidden && e.relatedTarget && !this.moreMenu.contains(e.relatedTarget) && e.relatedTarget !== this.moreBtn) this.toggleMore(false);
    });
    this.moreMenu.addEventListener("keydown", (e) => {
      const items = this.moreItems();
      const at = items.indexOf(document.activeElement);
      if (e.key === "Escape") {
        this.toggleMore(false);
        this.moreBtn.focus();
      } else if (e.key === "Tab") {
        this.toggleMore(false);
        this.moreBtn.focus();
        return; // the focus moves on from ⋯ as usual
      } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        const down = e.key === "ArrowDown";
        const next = at < 0 ? (down ? 0 : items.length - 1) : (at + (down ? 1 : -1) + items.length) % items.length;
        items[next]?.focus();
      } else if (e.key === "Home" || e.key === "End") items[e.key === "Home" ? 0 : items.length - 1]?.focus();
      else return;
      e.preventDefault();
      e.stopPropagation(); // Esc here does not also stop the turn
    });
  }

  send() {
    const text = this.input.value.trim();
    if (!text || this.dead || this.deleting) return;
    const cmd = this.agentAvailable() ? SlashCommands.parseAgentCommand(text) : null;
    const rename = SlashCommands.parseRenameCommand(text);
    if (this.busy) {
      // agent changes, /rename and an edit are not queued or held; with the queue setting off and no held typed messages nothing is
      const holdIt = this.holdsTyped();
      if (cmd || rename || this.edit || this.historyOp || !(queueMidTurn || holdIt)) {
        if (cmd || rename) this.statusEl.textContent = "Wait until Copilot finishes this turn.";
        // Send stays enabled with the queue on (or while a turn holds your messages): say why nothing happened (a delete or replace rebuilds the view)
        else if (this.historyOp && (queueMidTurn || holdIt)) {
          this.statusEl.textContent = this.historyOp.description === "edit" ? "Wait until the message has been replaced." : "Wait until the fork or delete of a message has finished.";
        }
        return;
      }
      this.takeInput();
      const command = SlashCommands.isCommandPrompt(text);
      if (holdIt) this.holdTyped(text, command);
      else this.enqueue({ kind: "app", text, prompt: text, command });
      return;
    }
    if (this.edit) return this.sendEdit(text);
    const { recalled, typed } = this.takeInput();
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
        if (recalled) {
          // still the recalled message: Left Shift+Down brings back what was typed before
          this.draft = typed;
          this.setRecalled(recalled);
        }
        this.autosize();
        this.statusEl.textContent = `Unknown agent "${cmd.arg}". Available: ${entries.map((e) => e.name).join(", ")}`;
      }
      return;
    }
    if (rename) {
      this.applyRename(rename.name);
      return;
    }
    this.followUp.userPrompt(); // you take over: a task waiting for its continue prompt is dropped
    this.runPrompt(text, this.userBubble(text), "app");
  }

  /** Clear the box after a send: sending a recalled message as it was brings back what you were typing before. */
  takeInput() {
    const recalled = this.recallEl;
    const typed = this.draft;
    this.input.value = recalled ? typed : "";
    this.setRecalled(null);
    this.draft = "";
    this.autosize();
    this.updatePopup(); // the restored draft may be a "/command"
    return { recalled, typed };
  }

  /** The bubble of a prompt typed in the app: image thumbnails for its @mentions, clickable paths. */
  userBubble(text) {
    const el = bubble("user", text);
    this.mentionThumbs(el, text);
    this.linkPaths(el.querySelector(".body"), this.cwd);
    return el;
  }

  /** Send in edit mode: cut the history before the edited message, rebuild the view from the files and send the
   *  new text there. Relay messages wait until it has started; a failure keeps the text in the box. */
  async sendEdit(text) {
    const refusal = EditMessage.editRefusal(text, { agentAvailable: this.agentAvailable() });
    if (refusal) {
      this.statusEl.textContent = refusal;
      return;
    }
    if (this.historyOp) return;
    const { ordinal, matchText, ownText, draft } = this.edit;
    const prefix = EditMessage.notesPrefix(MessageQueue.unwrap(matchText) ?? matchText, ownText);
    const { sessionId } = this;
    this.historyOp = Symbol("edit"); // the view is replaced below, so the flag never needs releasing
    this.setBusy(true);
    this.statusEl.textContent = "Replacing the message…";
    let failure = null;
    try {
      await api.truncateSession(sessionId, { ordinal, text: matchText, where: "beforeUser" }); // main closes it first
    } catch (e) {
      failure = e;
      await api.closeSession(sessionId).catch(() => {}); // closed for sure: the reopen replays it unchanged
    }
    // the edited message goes as a plain prompt, also after a failed cut (you have taken over): no task is continued
    const v = await reopenView(this, failure && `Could not replace the message: ${failure.message}`, { holdInbox: true, typed: failure ? text : draft, keepFollowUp: false });
    if (failure || !v || v.dead) {
      // the edited text must survive: a failed cut leaves it as a plain draft, a failed reopen too
      const target = v ?? this;
      target.input.value = text;
      target.autosize();
      v?.releaseInbox();
      return;
    }
    // Copilot usually replays the history before answering session/load, but a replayed reply was once seen arriving
    // after it: it would land below the edited prompt and count as its reply. Wait until the replay has gone quiet.
    // locked meanwhile: a send, edit, fork or delete must not get in between the cut and the edited prompt
    v.historyOp = Symbol("edit");
    v.setBusy(true);
    v.statusEl.textContent = "Replacing the message…";
    await v.updatesSettled();
    v.historyOp = false;
    if (views.get(sessionId) !== v) return; // you closed the tab meanwhile: the history is cut, nothing is sent
    if (v.dead) {
      v.input.value = text;
      v.autosize();
      return;
    }
    if (prefix) v.pendingNotes.unshift(prefix); // the replaced message's notes come first, as they did then
    const run = v.runPrompt(text, v.userBubble(text), "app");
    v.releaseInbox(); // runPrompt is busy already: queued relay messages follow its turn
    await run;
  }

  /**
   * @param {"app"|"human"|"relay"} source who wrote the prompt (decides the relay budget and image attachments)
   * @param {{ midTurn?: boolean, answer?: boolean, more?: boolean }} options midTurn: a queued item sent while a
   *   prompt of this view runs; it interrupts the running prompt and continues its turn (one chain = one turn).
   *   answer (default: midTurn): it goes out as an answer prompt (MessageQueue.wrap), more: other items are still
   *   queued behind it (the agent is told not to go back to its task yet). A command is never wrapped.
   */
  async runPrompt(text, bubble, source, delivery = null, { midTurn = false, answer = midTurn, more = false } = {}) {
    this.flush();
    // CLI commands (/context ...) are not recorded in events.jsonl; compare the recorded count to tell
    const isCmd = SlashCommands.isCommandPrompt(text);
    let sent = text;
    // not on a command: text in front of it would turn it into an ordinary prompt, the notes wait for the next one;
    // nor on the continue prompt: it is recognised on replay by its exact text
    if (this.pendingNotes.length && !isCmd && !MessageQueue.isContinuePrompt(text)) {
      sent = this.pendingNotes.join("\n\n") + "\n\n" + text;
      this.pendingNotes = [];
    }
    if (answer && !isCmd) sent = MessageQueue.wrap(sent, { more });
    if (sent !== text) {
      // history records what was sent, so fork/delete match that; the bubble and Left Shift+Up keep what you wrote.
      // Before append: markTurn hands _matchText on to the turn's reply.
      bubble._ownText = bubble._matchText;
      bubble._matchText = () => sent;
    }
    this.append(bubble);
    this.toBottom();
    this.panelToBottom();
    // a mid-turn prompt owns the turn's updates (and is acknowledged) only from its switch point on (the record
    // keeps its delivery until then)
    const record = this.chain.start({ midTurn, delivery });
    // a mid-turn send interrupts the task: it is continued after the answers (undone if the send never took over)
    const undoInterrupt = midTurn ? this.followUp.interrupted() : null;
    this.setBusy(true);
    const before = isCmd ? await api.userMessages(this.sessionId).catch(() => null) : null;
    if (!midTurn) this.delivery = delivery;
    let end = null;
    let failed = false; // the chain ended with this prompt's error
    try {
      const stop = await api.prompt(this.sessionId, sent, source);
      delivery?.returned(); // (a mid-turn one whose marker never came is acknowledged here)
      this.flush();
      // a prompt interrupted by a queued one answers "cancelled": that is not a Stop of yours
      end = this.chain.returned(record, stop);
      if (end.showStopped) this.system("Stopped.");
      else if (stop && stop !== "cancelled" && stop !== "end_turn") this.system(`Turn ended: ${stop}`);
    } catch (e) {
      delivery?.failed(); // (nothing once acknowledged at the switch point)
      if (!end) {
        end = this.chain.failed(record); // before its switch point: the prompts it was to interrupt run on
        failed = true;
        if (end.beforeSwitch) undoInterrupt?.(); // the task was not interrupted
      }
      this.error(e.message);
    } finally {
      if (end?.ended) await this.chainEnded(before, bubble, end.dropped, end.stopped, failed || end.failed);
    }
  }

  /** The last prompt of the chain answered: the turn is over.
   *  dropped: tools in flight when a queued prompt interrupted them, without a switch point to tell;
   *  stopped: you pressed Stop during the chain; failed: it ended with an error. */
  async chainEnded(before, bubble, dropped, stopped, failed = false) {
    this.delivery = null;
    for (const toolCallId of dropped) this.applyTool({ sessionUpdate: "tool_call_update", toolCallId, status: "interrupted" });
    this.settleGroups();
    this.dismissPermissions({ all: false, stopped });
    // the view was closed or its session deleted meanwhile: nothing to update (a refresh would also replace the
    // delete's warning in the status line)
    if (views.get(this.sessionId) !== this) return;
    if (before !== null) {
      const after = await api.userMessages(this.sessionId).catch(() => null);
      if (after === before) this.dropTurn(bubble);
    }
    if (this.chain.active()) return; // a new chain started during the await: it ends the turn itself
    if (!this.dead) this.setBusy(false);
    if (!this.deleting) scheduleRefresh(); // a delete refreshes the list itself
    // after the last answer to queued messages the interrupted task goes on; "pump": the next queued item is answered
    // first (setBusy(false) has scheduled it)
    const { paused, dead, deleting } = this;
    if (this.followUp.afterTurn({ stopped, failed, queued: this.queue.length, paused, dead, deleting }) === "continue") void this.sendContinue();
  }

  cancel() {
    if (!this.busy) return;
    this.chain.stop(); // no mid-turn send while Copilot winds the chain down
    // Stop with items queued pauses the queue (setting on): nothing is delivered until you resume it
    if (this.prompting && MessageQueue.pauseOnStop({ enabled: queueMidTurn, queued: this.queue.length })) {
      this.paused = true;
      this.renderQueue();
      this.showQueueStatus();
    }
    api.cancel(this.sessionId).catch((e) => this.error(e.message));
  }

  loadHoldSwitch() {
    api
      .getHoldReplies(this.sessionId)
      .then((hold) => {
        for (const kind of HeldReplies.SWITCH_KINDS) {
          if (this.holdTouched[kind] || hold?.[kind] !== false) continue;
          this.holdOn[kind] = false;
          this.updateSendBtn();
          for (const item of this.held.filter((i) => i.kind === kind)) this.approveHeld(item); // held while the answer was on its way
        }
        this.renderHeld();
      })
      .catch(() => {}); // unreadable: the default (on) stays
  }

  /** A view that is dead after the open does not keep the broker messages handed to it: the broker delivers them again. Items without a delivery id stay. */
  heldComeBack() {
    const back = this.held.filter((item) => item.deliveryId);
    if (!back.length) return;
    for (const item of back) this.seenDeliveries.delete(item.deliveryId); // the broker delivers them again
    this.system(HeldReplies.comeBackLine(back.length));
    this.held = this.held.filter((item) => !item.deliveryId);
    this.renderHeld();
  }

  markDead({ code, signal, stderr }) {
    this.flush();
    this.dead = true;
    this.settleGroups(); // no ● and no "N subagents running" in a dead view
    this.clearEdit(); // the text stays in the box
    this.dismissPermissions();
    this.renderHeld(); // Approve is off in a dead view; Discard stays
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
  } else {
    r.body.textContent = r.type === "user" ? FileLinks.parseRelayHeader(shownUserText(r.text)).display : r.text;
    if (r.type === "user") r.el.classList.toggle("continue", MessageQueue.isContinuePrompt(r.text)); // the app's continue prompt
    if (final && r.type === "user") linkify(r.body); // a prompt replayed from the history (live ones are bubbles)
  }
  if (r.type === "user") {
    r.el.hidden = !r.text.trim(); // replayed prompts can be empty (e.g. attachments only)
    if (r.el._editAct) r.el._editAct.hidden = !isEditableBubble(r.el); // the replayed text is complete only now
  }
}

// ---------------------------------------------------------------------------
// opening / closing

/** keepSchedules: a session closing in the background must not close the Schedules page (it hides every view). */
function activate(id, { keepSchedules = false } = {}) {
  if (!keepSchedules) Schedules.hide();
  filePreview.close();
  activeId = id;
  for (const [sid, v] of views) {
    v.el.classList.toggle("active", sid === id);
    if (sid !== id) v.toggleMore(false); // a hidden view's ⋯ menu closes
  }
  $("#empty").style.display = id ? "none" : "";
  renderList();
  commsRefresh(); // the shown panel's timers tick
  const v = views.get(id);
  if (v && !v.dead) v.input.focus();
}

let replaySeq = 0;
const replayEnds = new Map(); // id of an open -> resolves its wait for main's acp:replayed (sent after its last update)

/** activate false: resumed in the background (a reopen the user approved in another session's view). */
async function openSession(s, { activate: show = true } = {}) {
  const existing = views.get(s.sessionId);
  if (existing && !existing.dead) return show ? activate(s.sessionId) : undefined;
  if (existing) {
    existing.el.remove();
    existing.stopKeeper();
    views.delete(s.sessionId);
    // resuming a dead view: what was waiting in it moves to the new one (unpaused: a new view), with the delivery
    // ids it took, so the broker's redelivery of a queued report is not taken twice
    s = { ...s, seenDeliveries: s.seenDeliveries ?? existing.seenDeliveries, pendingNotes: s.pendingNotes ?? existing.pendingNotes, held: s.held ?? existing.held, discarded: s.discarded ?? existing.discarded };
  }
  const v = new SessionView(s);
  views.set(s.sessionId, v);
  if (existing?.queue.length) {
    v.queue.push(...existing.queue); // delivered when the resumed session is idle
    v.renderQueue();
  }
  v.setBusy(true); // before flushEarly: an early relay message must wait until the session is open
  flushEarly(v);
  if (show) activate(s.sessionId);
  v.statusEl.textContent = "Resuming session…";
  v.resuming = true;
  const replayId = ++replaySeq;
  const replayed = new Promise((resolve) => replayEnds.set(replayId, resolve));
  try {
    const res = await api.openSession(s.sessionId, s.cwd, replayId);
    await replayed; // the answer may overtake the last replayed updates, the marker cannot
    const times = await api.messageTimes(s.sessionId).catch(() => null); // while still resuming: nothing takes the clock meanwhile
    v.resuming = false;
    v.flush();
    v.applyTimes(times);
    v.settleGroups();
    v.setConfig(res.configOptions);
    v.toBottom();
    v.panelToBottom();
    v.setBusy(false);
    if (!v.log.childElementCount) v.system("No messages yet.");
  } catch (e) {
    await replayed; // a failed load may have replayed too
    const times = await api.messageTimes(s.sessionId).catch(() => null);
    v.resuming = false;
    v.flush(); // the replayed blocks are complete: the dead view shows them with their times
    v.applyTimes(times);
    v.dead = true;
    v.settleGroups(); // what was replayed before the failure keeps no ●
    v.error(`Could not resume this session: ${e.message}`);
    v.heldComeBack();
    v.setBusy(false);
  } finally {
    replayEnds.delete(replayId);
  }
}

/** A new session in cwd (picked when not given): the prompt editor asks for its own prompt part first; Cancel
 *  starts nothing, a start that fails keeps the dialog open with the text and says why. */
async function newSession(cwd) {
  try {
    if ($("#prompt-dialog").open) return; // one editor at a time
    cwd ??= await api.pickDir();
    if (!cwd) return;
    const s = await api.getSettings();
    const editor = PromptEditor.createPromptEditor({ defaultPart: s.defaultPart ?? "", childPart: null, templates: s.promptTemplates ?? [], own: "", command: { value: "", settings: s.effective, platform: s.platform }, h });
    const row = FolderRow.createFolderRow({ value: cwd, pick: (cur) => api.pickDir("Folder for the new session", cur), h });
    let res = null;
    const onOk = async (own, command) => {
      setStatus(`Starting Copilot in ${row.value()}…`);
      row.setDisabled(true);
      try {
        res = await api.newSession(row.value(), own, command);
      } catch (e) {
        row.setDisabled(false);
        return `Could not start the session: ${e.message}`;
      } finally {
        setStatus("");
      }
    };
    const wrapper = h("div", {}, row.el, editor.el);
    if ((await PromptEditor.openPromptDialog({ title: "New session", okLabel: "Start", editor: { ...editor, el: wrapper }, onOk })) == null) return;
    cwd = row.value();
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

/** Remove a session's view and everything the window keeps for it (the session itself is closed by the caller). */
function dropView(id) {
  const v = views.get(id);
  v?.stopKeeper();
  v?.toggleMore(false); // its document listener goes with it
  views.delete(id);
  lastCommands.delete(id);
  lastUsage.delete(id); // a re-opened session must not flash this stale snapshot
  early.delete(id);
  v?.el.remove();
  if (activeId === id) activate([...views.keys()].pop() ?? null, { keepSchedules: true });
  commsRefresh(); // its node is closed now
}

/** Rebuild a closed session's view from its files (after its history changed or a delete failed); queued items
 *  that were waiting in the old view move to the new one, paused if they were (only ▶ or emptying the queue ends a
 *  pause). keepFollowUp: the history is unchanged, so a task waiting to be continued after the answers (paused by
 *  your Stop) still waits; false when the history was cut (the task may be gone with it). */
async function reopenView(old, error, { holdInbox = false, typed, keepFollowUp = true } = {}) {
  const { sessionId, cwd, title, queue, paused, parentSessionId, seenDeliveries, pendingNotes, held, discarded } = old;
  const followUpDue = keepFollowUp && old.followUp.answerDue();
  typed ??= old.recallEl ? old.draft : old.input.value; // what you typed (not a recalled earlier message)
  if (views.get(sessionId) === old) views.delete(sessionId);
  old.el.remove();
  old.stopKeeper();
  old.toggleMore(false);
  // handed over before the replay: a report redelivered while the session reopens must already count as seen
  await openSession({ sessionId, cwd, title, parentSessionId, seenDeliveries, pendingNotes, holdInbox, held, discarded });
  const v = views.get(sessionId);
  if (!v) return;
  if (error) v.error(error);
  const lost = v.dead ? queue.length + v.held.filter((item) => item.typed).length : 0; // your typed held messages go with the queue's
  if (lost) {
    v.held = v.held.filter((item) => !item.typed);
    v.renderHeld();
    v.error(`${lost} queued message(s) waiting for this session were discarded.`);
  }
  if (typed && !v.input.value) {
    v.input.value = typed;
    v.autosize();
  }
  if (queue.length && !v.dead) {
    v.queue.push(...queue);
    v.paused = paused && v.queue.length > 0;
    if (followUpDue) v.followUp.interrupted(); // before the pump below: the items still go as answers
    v.renderQueue();
    v.showQueueStatus();
    v.pump();
  }
  return v;
}

/** Open sub-sessions of id (all generations), deepest first; one being deleted is left to its delete. */
const openDescendants = (id) => SessionTree.closeOrder(tree, id, (c) => views.has(c) && !views.get(c).deleting && !deleting.has(c));

/** The question before closing these views (busy ones, and idle or dead ones with queued messages of yours that would
 *  be lost), or null when there is nothing to ask. question: the text for a single busy session instead of the count. */
function closeQuestion(ids, question) {
  const list = ids.map((id) => views.get(id)).filter(Boolean);
  const isBusy = (v) => v.busy && !v.dead;
  const busy = list.filter(isBusy).length;
  const queued = list.filter((v) => !isBusy(v) && (v.queue.some((item) => item.kind === "app") || v.held.some((item) => item.typed))).length;
  if (!busy && !queued) return null;
  if (!queued) return question ?? (busy === 1 ? "1 session is still working. Stop it and close?" : `${busy} sessions are still working. Stop them and close?`);
  if (busy) return `${busy} session(s) are still working and ${queued} more have queued messages of yours that were not sent. Stop and close them?`;
  const unsent = ids.length === 1 ? "This session has queued messages of yours that were not sent." : `${queued} session(s) have queued messages of yours that were not sent.`;
  return `${unsent} Close and discard them?`;
}

/** Close these views in this order after one question for the busy ones (and those with queued messages of yours);
 *  nothing is closed if you cancel. question: the text for a single busy session instead of the count. */
async function closeViews(ids, question) {
  const ask = closeQuestion(ids, question);
  if (ask && !confirm(ask)) return;
  for (const id of ids) {
    const v = views.get(id);
    if (!v || v.deleting || deleting.has(id)) continue; // a running delete closes it, or restores it if the delete fails
    dropView(id);
    await api.closeSession(id).catch(() => {});
  }
  renderList();
}

/** Close a session's view and every open sub-session below it (they all stay resumable). */
async function closeView(id) {
  const v = views.get(id);
  if (!v || v.deleting) return; // a running delete closes it, or restores it if the delete fails
  const ids = openDescendants(id);
  await closeViews([...ids, id], ids.length ? undefined : "Copilot is still working in this session. Stop it and close?");
}

// ---------------------------------------------------------------------------
// session list

function setStatus(text, isError = false) {
  const el = $("#side-status");
  el.textContent = text;
  el.classList.toggle("error", isError);
}

async function refresh() {
  loadQuota({ force: true });
  const known = links; // only links that existed before the list was asked for are checked against it
  let listed = [];
  let complete = false;
  try {
    ({ sessions: listed, complete } = await api.listSessionsChecked());
    // a list fetched while a delete was running may still contain that session
    sessions = listed.filter((s) => !deleting.has(s.sessionId) && !deletedIds.has(s.sessionId));
    for (const s of sessions) {
      const v = views.get(s.sessionId);
      if (v && s.title && !v.title) v.setTitle(s.title);
    }
    setStatus(`${sessions.length} sessions`);
  } catch (e) {
    setStatus(e.message, true);
  }
  renderList();
  pruneMissing(known, listed, complete);
}

/** Tell the broker which linked sessions are gone from disk (deleted in a terminal, by Copilot's cleanup…). Only
 *  after a successful, complete list; never an open session or one being deleted here (a new session may not be
 *  listed yet, a delete forgets its own links). */
function pruneMissing(known, listed, listOk) {
  const exclude = new Set([...views.keys(), ...deleting, ...deletedIds]);
  const keys = SessionTree.pruneCandidates(known, listed, { listOk, exclude });
  if (keys.length) api.reportMissing(keys).catch((e) => console.warn(`links: ${e.message}`));
}

let refreshTimer;
function scheduleRefresh() {
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(refresh, 1500);
}

function togglePin(id) {
  if (ui.pinned.has(id)) ui.pinned.delete(id);
  else ui.pinned.add(id);
  saveUi();
  renderList();
}

/** The name of a related session (a child's parent in the sidebar, the relation bar): its title, else its relay name
 *  (from its view or its link), else the start of its id. */
function parentLabel(id) {
  const p = views.get(id);
  const title = p?.title || sessions.find((s) => s.sessionId === id)?.title;
  return title ? shortTitle(title) : (p?.relayName ?? tree.link.get(id)?.name ?? id.slice(0, 8));
}

/** A relation bar entry: dot as in the sidebar (hollow when closed); for a child ✓ once it reported, +N sub-sessions. */
function relationChip(id, { child = false, grandchildren = 0 } = {}) {
  const v = views.get(id);
  const open = v && !v.dead;
  const reported = child && tree.link.get(id)?.reported;
  const state = v?.dead ? "Its Copilot process ended" : open ? "Open" : "Closed";
  return h(
    "button",
    { class: "rel-chip", title: `${state}${reported ? ", reported its result" : ""}\n${id}`, onclick: () => openRelative(id) },
    h("span", { class: "dot" + (v?.dead ? " dead" : !open ? " off" : v.busy ? " busy" : "") }),
    h("span", { class: "name" }, parentLabel(id)),
    reported && h("span", { class: "rel-done" }, "✓"),
    grandchildren > 0 && h("span", { class: "count", title: `${grandchildren} sub-session(s)` }, `+${grandchildren}`),
  );
}

/** A relation bar click: show it if open, else resume it as from the sidebar (the click is the approval). */
function openRelative(id) {
  const v = views.get(id);
  if (v && !v.dead) return activate(id);
  if (deleting.has(id)) return setStatus("This session is being deleted.", true);
  const s = sessions.find((x) => x.sessionId === id) ?? (v && { sessionId: id, cwd: v.cwd, title: v.title });
  if (!s) return setStatus("This session is not in Copilot's session list.", true);
  openSession(s);
}

/** showProject: its folder goes into the meta line (in Pinned and Open in app, or its folder differs from its root's).
 *  depth: its level under its parent in the tree (0 = a root, with "child of X" when it has a parent not listed). */
function item(s, v, { showProject = false, depth = 0 } = {}) {
  const heldCount = HeldReplies.sidebarCount({ view: v, brokerHeld: heldByKey, brokerByKind: heldByKindKey, sessionId: s.sessionId });
  const pinned = ui.pinned.has(s.sessionId);
  const parent = tree.parentOf.get(s.sessionId);
  const relation = depth > 0 ? null : parent && parent !== s.sessionId ? `child of ${parentLabel(parent)}` : tree.link.get(s.sessionId)?.parentDeleted ? "parent deleted" : null;
  return h(
    "div",
    { class: "item-row", style: depth > 0 ? `--depth: ${depth}` : null },
    h(
      "button",
      {
        class: "item" + (s.sessionId === activeId ? " active" : ""),
        title: `${s.title ?? ""}\n${s.cwd}\n${s.sessionId}`,
        // opening it now would only make a dead view (main refuses); a failed delete reopens it itself
        onclick: () => (deleting.has(s.sessionId) ? setStatus("This session is being deleted.", true) : openSession(s)),
      },
      h(
        "div",
        { class: "t" },
        depth > 0 && h("span", { class: "branch", "aria-hidden": "true" }, "└"),
        v && h("span", v.dead ? { class: "dot dead", title: "Its Copilot process ended" } : { class: "dot" + (v.busy ? " busy" : "") }),
        h("b", {}, shortTitle(v?.title || s.title)),
        v?.needsAttention && h("span", { class: "attention", title: "Waiting for your answer" }, "!"),
        v?.keeperState?.phase === "countdown" && h("span", { class: "keeper-mark", title: "Compacting soon" }, "⏳"),
        heldCount > 0 && h("span", { class: "held-mark", title: HeldReplies.markTitle(heldCount) }, `⏸ ${heldCount}`),
      ),
      h("div", { class: "m" }, [relation, showProject && baseName(s.cwd), UiState.activityAt(s) ? ago(UiState.activityAt(s)) : "", s.sessionId.slice(0, 8)].filter(Boolean).join(" · ")),
    ),
    h(
      "div",
      { class: "row-actions" },
      h("button", { class: "item-pin" + (pinned ? " pinned" : ""), title: pinned ? "Unpin" : "Pin to top", "aria-pressed": String(pinned), onclick: () => togglePin(s.sessionId) }, "📌"),
      h("button", { class: "item-del danger", title: "Delete this session", onclick: () => deleteSessionFlow({ ...s, title: v?.title || s.title }) }, "🗑"),
    ),
  );
}

const deleting = new Set(); // sessions whose delete is running
const deletedIds = new Set(); // deleted in this run of the app
const DELETE_WARNING =
  "Its whole history is removed from disk and cannot be restored. Files changed by the agent are not reverted. " +
  "Don't use this while the session is open in a terminal Copilot CLI.";
const sessionName = (s) => shortTitle(s.title) || s.sessionId.slice(0, 8);
/** A session to delete by id: its list entry, else what its view knows. */
const sessionById = (id) => {
  const v = views.get(id);
  return sessions.find((x) => x.sessionId === id) ?? { sessionId: id, cwd: v?.cwd, title: v?.title || tree.link.get(id)?.name };
};

/** Delete a whole session from disk after asking; closes its view first. A session with sub-sessions asks in
 *  #delete-tree which of them go too. */
async function deleteSessionFlow(s) {
  if (deleting.has(s.sessionId)) return;
  const refusal = deleteRefusal(s.sessionId);
  if (refusal) return setStatus(refusal, true);
  const v = views.get(s.sessionId);
  const idx = tree; // the tree as asked about: forgetting the deleted keys changes `tree` meanwhile
  const below = SessionTree.descendants(idx, s.sessionId);
  if (!below.length) {
    const ok = confirm(
      `Delete the session "${sessionName(s)}"?\n\n` +
        `${s.cwd ?? ""}\n${s.sessionId}\n\n` +
        (v?.prompting && !v.dead ? "Copilot is still working in it and will be stopped.\n\n" : "") +
        DELETE_WARNING,
    );
    if (!ok) return;
    const r = await deleteOne(s);
    const forgot = r.deleted ? await forgetDeleted(idx, [s.sessionId]) : null;
    setStatus(forgot ? `${r.text}; ${forgot}` : r.text, r.isError || !!forgot);
    if (r.deleted && r.clean && !forgot) scheduleRefresh(); // a refresh would replace a warning with the session count
    return;
  }
  const checked = await askDeleteTree(s, idx, below);
  if (!checked) return;
  // the chosen session first, then the checked sub-sessions deepest first; the first one not deleted stops the rest
  const order = [s, ...SessionTree.closeOrder(idx, s.sessionId, (c) => checked.has(c)).map(sessionById)];
  const deleted = [];
  const warnings = [];
  let failed = null;
  for (const t of order) {
    const r = await deleteOne(t);
    if (!r.deleted) {
      failed = { t, r };
      break;
    }
    deleted.push(t.sessionId);
    if (r.isError) warnings.push(`"${sessionName(t)}": ${r.text}`); // deleted, with a problem
  }
  const parts = [];
  if (deleted.length) {
    const forgot = await forgetDeleted(idx, deleted);
    if (forgot) warnings.push(forgot);
    // kept sub-sessions close with their deleted parent (they stay resumable)
    await closeViews(SessionTree.closeOrder(idx, s.sessionId, (c) => !checked.has(c) && views.has(c) && !views.get(c).deleting && !deleting.has(c)));
    const subs = deleted.length - 1;
    parts.push(`Session "${sessionName(s)}"${subs ? ` and ${subs} sub-session(s)` : ""} deleted`);
  }
  if (failed) {
    const left = order.length - deleted.length - 1;
    parts.push(
      (failed.t === s ? failed.r.text : `"${sessionName(failed.t)}": ${failed.r.text}`) +
        (left ? ` (${left} more checked sub-session(s) were not deleted)` : ""),
    );
  }
  parts.push(...warnings);
  setStatus(parts.join("; "), !!failed || warnings.length > 0);
  if (!failed && !warnings.length) scheduleRefresh();
}

/** Why a session can't be deleted right now, or null. Main would refuse a session that is still resuming, and a
 *  Fork/Delete of a message reopens the session when it is done. */
function deleteRefusal(id) {
  const v = views.get(id);
  if (deleting.has(id)) return "This session is being deleted.";
  if (v?.resuming) return "This session is still opening. Delete it when it has loaded.";
  if (v?.historyOp) return "Wait until the fork or delete of a message has finished.";
  return null;
}

/** Delete one session through main, closing its view; returns { deleted, clean, text, isError } for the status line
 *  (deleted with problems: isError, not clean). */
async function deleteOne(s) {
  const refusal = deleteRefusal(s.sessionId);
  if (refusal) return { deleted: false, text: refusal, isError: true };
  const v = views.get(s.sessionId);
  const name = sessionName(s);
  deleting.add(s.sessionId);
  setStatus("Deleting session…");
  const setDeleting = (on) => {
    if (!v || views.get(s.sessionId) !== v) return;
    v.deleting = on;
    v.setBusy(v.busy); // re-applies the disabled state; a turn ending meanwhile can't re-enable the box
  };
  setDeleting(true);
  const listed = sessions.find((x) => x.sessionId === s.sessionId); // its list entry, put back if it isn't deleted
  try {
    const res = await api.deleteSession(s.sessionId); // main closes the session first
    if (res.refused) {
      // nothing was touched: the session is still open (or still opening) as it was
      setDeleting(false);
      return { deleted: false, text: `Could not delete the session: ${res.refused}`, isError: true };
    }
    if (res.stuck) {
      // closed, but its Copilot process would not exit: main refuses to open it again until that process is gone
      const lost = v && views.get(s.sessionId) === v ? v.unsentCount() : 0;
      dropView(s.sessionId);
      return { deleted: false, text: `Could not delete the session: ${res.stuck}${lost ? ` (${lost} queued message(s) were discarded)` : ""}`, isError: true };
    }
    deletedIds.add(s.sessionId);
    if (ui.pinned.delete(s.sessionId)) saveUi();
    const dropped = v && views.get(s.sessionId) === v ? v.unsentCount() : 0; // queued and held typed messages it never got
    dropView(s.sessionId); // only now: on a failure the session stays visible
    filePreview.forget(s.sessionId);
    sessions = sessions.filter((x) => x.sessionId !== s.sessionId);
    const problems = [
      dropped && `${dropped} queued message(s) waiting for it were discarded`,
      res.leftover && `some files could not be removed yet (retried on the next start): ${res.leftover}`,
      res.store?.error && `its entry in session-store.db could not be removed: ${res.store.error}`,
    ].filter(Boolean);
    return problems.length
      ? { deleted: true, clean: false, text: `Session deleted, but ${problems.join("; ")}`, isError: true }
      : { deleted: true, clean: true, text: `Session "${name}" deleted`, isError: false };
  } catch (e) {
    // main may have closed it before failing: reopen the view from the session's files (as after deleting messages)
    if (v && views.get(s.sessionId) === v) {
      await api.closeSession(s.sessionId).catch(() => {});
      await reopenView(v, `Could not delete the session: ${e.message}`);
    }
    return { deleted: false, text: `Could not delete the session: ${e.message}`, isError: true };
  } finally {
    deleting.delete(s.sessionId);
    // not deleted: a refresh while it ran may have left it out of the list (see refresh)
    if (listed && !deletedIds.has(s.sessionId) && !sessions.some((x) => x.sessionId === s.sessionId)) sessions.push(listed);
    renderList();
  }
}

/** The broker forgets deleted sessions (their links: a child, or a parent whose kept children become "parent deleted";
 *  and their held messages). The sessions are already gone, so a failure is only a warning; returns the text of one that
 *  concerns the tree, else null. */
async function forgetDeleted(idx, ids) {
  if (!ids.length) return null;
  const inTree = ids.some((id) => idx.link.has(id) || idx.childrenOf.has(id));
  try {
    await api.forgetLinks(ids.map((id) => `cli:${id}`)); // every deleted id: the broker also drops the held messages of an unlinked session
    return null;
  } catch (e) {
    if (inTree) return `the sub-session tree could not be updated: ${e.message}`;
    console.warn(`forget links: ${e.message}`); // no link, no tree to update; the broker may be off
    return null;
  }
}

/** #delete-tree: the warning, then the sub-sessions indented by depth, each with its own unchecked "Delete too".
 *  Resolves to the set of checked ids, or null when cancelled (Cancel, Escape). */
function askDeleteTree(s, idx, below) {
  const dlg = $("#delete-tree");
  const v = views.get(s.sessionId);
  $("#del-title").textContent = `Delete the session "${sessionName(s)}"?`;
  $("#del-where").textContent = `${s.cwd ?? ""}\n${s.sessionId}`;
  $("#del-warning").textContent = (v?.prompting && !v.dead ? "Copilot is still working in it and will be stopped.\n\n" : "") + DELETE_WARNING;
  const depth = new Map([[s.sessionId, 0]]);
  const boxes = below.map((id) => {
    depth.set(id, (depth.get(idx.parentOf.get(id)) ?? 0) + 1); // descendants() lists a parent before its children
    const cv = views.get(id);
    const box = h("input", { type: "checkbox", disabled: deleting.has(id) });
    const meta = [deleting.has(id) ? "being deleted" : cv && !cv.dead ? (cv.busy ? "working" : "open") : "closed", id.slice(0, 8)];
    $("#del-list").append(
      h(
        "div",
        { class: "del-row", style: `--depth: ${depth.get(id)}`, title: id },
        h("span", { class: "branch", "aria-hidden": "true" }, "└"),
        h("span", { class: "del-name" }, parentLabel(id)),
        h("span", { class: "del-meta" }, meta.join(" · ")),
        h("label", {}, box, "Delete too"),
      ),
    );
    return [id, box];
  });
  dlg.returnValue = ""; // Escape keeps the previous value
  dlg.showModal();
  return new Promise((resolve) => {
    dlg.addEventListener(
      "close",
      () => {
        $("#del-list").replaceChildren();
        resolve(dlg.returnValue === "delete" ? new Set(boxes.filter(([, b]) => b.checked).map(([id]) => id)) : null);
      },
      { once: true },
    );
  });
}

// Sidebar state kept across restarts: pinned sessions, collapsed project folders, chat text scale, the activity
// panel's width and collapsed state.
const UI_KEY = "copilot-sessions.ui.v1";
function loadUi() {
  let raw = {};
  try {
    raw = JSON.parse(localStorage.getItem(UI_KEY) ?? "{}") ?? {};
  } catch {}
  const set = (a) => new Set(Array.isArray(a) ? a.filter((x) => typeof x === "string") : []);
  return {
    pinned: set(raw.pinned),
    collapsed: set(raw.collapsed),
    chatScale: Number.isFinite(raw.chatScale) ? raw.chatScale : 1,
    panelWidth: Number.isFinite(raw.panelWidth) ? raw.panelWidth : UiState.PANEL.def, // the activity panel's width, every view's
    panelCollapsed: raw.panelCollapsed === true, // applies to the wide layout only
    rightPanel: raw.rightPanel === "comms" ? "comms" : "activity", // which panel holds the right-hand slot
    commsSplit: Number.isFinite(raw.commsSplit) && raw.commsSplit >= 0 && raw.commsSplit <= 1 ? raw.commsSplit : 0.5, // the graph's share of the Communication panel
    commsSplitSet: raw.commsSplitSet === true, // you dragged the split: until then the graph gets the height it needs
  };
}
const ui = loadUi();
// The image viewer, opened from a thumbnail: wheel zooms around the cursor, drag pans, double-click toggles fit / 100 %.
const viewer = (() => {
  const el = $("#viewer");
  const stage = $(".viewer-stage", el);
  const img = $("img", stage);
  const cap = $(".viewer-cap", el);
  const zoomEl = $(".viewer-zoom", el);
  let list = [];
  let index = 0;
  let st = { scale: 1, x: 0, y: 0 };
  let fitted = true;
  let opener = null;
  let drag = null;
  const apply = () => {
    img.style.transform = `translate(${st.x}px, ${st.y}px) scale(${st.scale})`;
    zoomEl.textContent = `${Math.round(st.scale * 100)} %`;
  };
  const box = () => stage.getBoundingClientRect();
  const fit = () => {
    const b = box();
    const s = UiState.fitScale(img.naturalWidth, img.naturalHeight, b.width, b.height);
    st = { scale: s, x: (b.width - img.naturalWidth * s) / 2, y: (b.height - img.naturalHeight * s) / 2 };
    fitted = true;
    apply();
  };
  const zoomBy = (factor, cx, cy) => {
    const b = box();
    st = UiState.zoomAt(st, factor, cx ?? b.width / 2, cy ?? b.height / 2);
    fitted = false;
    apply();
  };
  const show = (i) => {
    index = (i + list.length) % list.length;
    const it = list[index];
    img.onload = fit;
    img.src = it.src;
    img.alt = it.name ?? "";
    cap.textContent = list.length > 1 ? `${it.name} · ${index + 1} / ${list.length}` : (it.name ?? "");
    for (const b of el.querySelectorAll('[data-act="prev"], [data-act="next"]')) b.hidden = list.length < 2;
  };
  const toggleFull = () => (document.fullscreenElement ? document.exitFullscreen() : el.requestFullscreen()).catch(() => {});
  const v = {
    isOpen: false,
    open(images, i = 0, from = null) {
      if (!images.length) return;
      list = images;
      opener = from;
      el.hidden = false;
      v.isOpen = true;
      show(i);
      el.focus();
    },
    close() {
      if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
      el.hidden = true;
      v.isOpen = false;
      img.removeAttribute("src");
      opener?.isConnected && opener.focus();
      opener = null;
    },
  };
  const actions = {
    prev: () => show(index - 1),
    next: () => show(index + 1),
    out: () => zoomBy(1 / 1.25),
    in: () => zoomBy(1.25),
    fit,
    full: toggleFull,
    close: v.close,
  };
  $(".viewer-bar", el).addEventListener("click", (e) => {
    const act = e.target.closest("button")?.dataset.act;
    if (act) actions[act]();
  });
  stage.addEventListener(
    "wheel",
    (e) => {
      e.preventDefault();
      if (!e.deltaY) return;
      const b = box();
      zoomBy(e.deltaY < 0 ? 1.15 : 1 / 1.15, e.clientX - b.left, e.clientY - b.top);
    },
    { passive: false },
  );
  stage.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    drag = { x: e.clientX, y: e.clientY, sx: st.x, sy: st.y, moved: false, onImage: onImage(e) };
    stage.setPointerCapture(e.pointerId);
    stage.classList.add("grabbing");
  });
  stage.addEventListener("pointermove", (e) => {
    if (!drag) return;
    const dx = e.clientX - drag.x;
    const dy = e.clientY - drag.y;
    if (Math.abs(dx) + Math.abs(dy) > 3) drag.moved = true;
    if (!drag.moved) return;
    st = { ...st, x: drag.sx + dx, y: drag.sy + dy };
    fitted = false;
    apply();
  });
  const endDrag = () => {
    const d = drag;
    drag = null;
    stage.classList.remove("grabbing");
    return d;
  };
  stage.addEventListener("pointerup", () => {
    const d = endDrag();
    if (d && !d.moved && !d.onImage) v.close(); // a plain click on the dark backdrop
  });
  stage.addEventListener("pointercancel", endDrag);
  // (with the pointer captured by the stage, clicks target the stage: test the position, not e.target)
  const onImage = (e) => {
    const r = img.getBoundingClientRect();
    return e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom;
  };
  stage.addEventListener("dblclick", (e) => {
    if (!onImage(e)) return;
    const b = box();
    if (fitted) zoomBy(1 / st.scale, e.clientX - b.left, e.clientY - b.top);
    else fit();
  });
  const refit = () => v.isOpen && fitted && fit();
  document.addEventListener("fullscreenchange", refit);
  window.addEventListener("resize", refit);
  // while it is open the viewer has the keyboard: no chat shortcuts (recall, zoom, Ctrl+N) underneath
  document.addEventListener(
    "keydown",
    (e) => {
      if (!v.isOpen) return;
      e.stopImmediatePropagation();
      const key = { "+": "in", "=": "in", "-": "out", _: "out", 0: "fit", f: "full", F: "full", ArrowLeft: "prev", ArrowRight: "next" }[e.key];
      if (e.key === "Escape") {
        e.preventDefault();
        if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
        else v.close();
      } else if (key && !(list.length < 2 && (key === "prev" || key === "next"))) {
        e.preventDefault();
        actions[key]();
      } else if (e.key === "Tab") e.preventDefault(); // focus stays in the viewer
    },
    true,
  );
  return v;
})();
function saveUi() {
  try {
    const { pinned, collapsed, chatScale, panelWidth, panelCollapsed, rightPanel, commsSplit, commsSplitSet } = ui;
    localStorage.setItem(UI_KEY, JSON.stringify({ pinned: [...pinned], collapsed: [...collapsed], chatScale, panelWidth, panelCollapsed, rightPanel, commsSplit, commsSplitSet }));
  } catch {}
}
/** The activity panel's stored width or collapsed state changed: every view lays its panel out again. */
function layoutPanels() {
  for (const v of views.values()) v.layoutPanel();
}
/** The right-hand slot's choice changed: stored, and every view re-evaluates what it shows. */
function setRightPanel(kind) {
  ui.rightPanel = kind;
  saveUi();
  for (const v of views.values()) v.updatePanelShown();
}
/** The Communication panel's content changed (a graph or log input, a pending card): every view showing it redraws,
 *  once for a burst of calls (and safe to call while a view is being built: it draws once it is registered). */
function commsRefresh() {
  if (commsQueued) return;
  commsQueued = true;
  setTimeout(drawComms, 0);
}
/** The bare id of the top of id's tree (cycle-safe). */
function commsRootOf(id) {
  const seen = new Set([id]);
  let cur = id;
  for (let p = tree.parentOf.get(cur); p != null && !seen.has(p); p = tree.parentOf.get(cur)) seen.add((cur = p));
  return cur;
}
const commsKeysOf = (rootId) => [rootId, ...SessionTree.descendants(tree, rootId)].map((id) => `cli:${id}`);
/** Facts of the sessions open in this app for CommsModel.build's `live` (they override what links and peers say). */
function commsLive() {
  const live = {};
  for (const [id, v] of views) {
    const k = v.keeperState;
    live[id] = {
      online: !v.dead, busy: !v.dead && v.busy === true, busySince: v.busy === true ? v.busySince ?? undefined : undefined, ctx: lastUsage.get(id)?.context ?? undefined,
      keeper: k && ["pinging", "countdown", "compacting"].includes(k.phase) ? k : undefined, cards: v.pendingCards,
      name: v.relayName || (v.title ? shortTitle(v.title) : undefined), // for a node the broker names nowhere (an older one)
    };
  }
  return live;
}
function drawComms() {
  commsQueued = false;
  clearTimeout(commsTicker);
  commsTicker = null;
  let tick = false;
  const live = commsLive();
  for (const v of views.values()) {
    if (v.panelKind !== "comms") continue;
    const rootKey = `cli:${commsRootOf(v.sessionId)}`;
    if (v.commsRoot !== rootKey) Object.assign(v, { commsRoot: rootKey, commsFilter: null }); // another tree: no filter
    const cached = commsByRoot.get(rootKey);
    // not fetched yet, or (in a panel on screen) a failed / older broker's answer of more than 5 s ago: the broker may
    // be back or restarted; what the panel shows stays until the answer comes
    if (!cached || ((cached.error || cached.unsupported) && Date.now() - cached.at > 5000 && commsOnScreen(v))) fetchComms(rootKey);
    const entry = commsByRoot.get(rootKey);
    const comms = entry?.events ? { root: rootKey, keys: [...entry.keys], events: entry.events, peers: entry.peers } : null;
    const model = CommsModel.build({ comms, links, heldByKind: heldByKindKey, current: v.sessionId, live, now: Date.now(), filter: v.commsFilter });
    v.commsView ??= CommsView.create({
      h, el: v.commsBody, on: {
        openSession: (id) => openRelative(id),
        fetchText: (id) => api.getCommsText(v.sessionId, id).then((r) => (typeof r?.text === "string" ? r.text : Promise.reject(new Error(r?.error ?? "not found")))),
        filter: (f) => {
          v.commsFilter = f;
          commsRefresh();
        },
        split: (ratio, done) => {
          ui.commsSplit = ratio;
          if (done) {
            ui.commsSplitSet = true; // your share from now on, not the graph's needed height
            saveUi();
            commsRefresh(); // every view's panel takes the new split
          }
        },
        autoSplit: () => {
          ui.commsSplitSet = false; // the graph's needed height again, in every view
          saveUi();
          commsRefresh();
        },
      },
    });
    const note = entry?.loading ? "Loading the message history…" : entry?.error ? `Could not load the message history: ${entry.error}` : null;
    v.commsView.render(model, { split: ui.commsSplit, autoSplit: !ui.commsSplitSet, filter: v.commsFilter, note });
    if (v.el.classList.contains("active") && CommsView.hasTimer(model)) tick = true;
  }
  if (tick) commsTicker = setTimeout(commsRefresh, 1000);
}
/** The view's Communication panel is on the screen (its view active, the panel neither collapsed nor a closed drawer). */
const commsOnScreen = (v) => v.panelKind === "comms" && v.el.classList.contains("active") && v.commsPanel.checkVisibility();
/** Fetches the log of the tree whose root is rootKey; what it held (the events, a failure or an older broker's note)
 *  stays shown until the answer comes; only the first load shows "Loading…". */
function fetchComms(rootKey) {
  if (commsFetching.has(rootKey)) return;
  const pushed = [];
  commsFetching.set(rootKey, pushed);
  const held = commsByRoot.get(rootKey);
  if (!held || held.loading) commsByRoot.set(rootKey, { loading: true, keys: new Set(commsKeysOf(rootKey.slice(4))) });
  const done = (r) => {
    if (commsFetching.get(rootKey) !== pushed) return;
    commsFetching.delete(rootKey);
    const at = Date.now();
    const prev = commsByRoot.get(rootKey);
    if (r?.unsupported) commsByRoot.set(rootKey, { unsupported: true, at });
    else if (!Array.isArray(r?.events)) {
      if (!prev?.events) commsByRoot.set(rootKey, { error: r?.error ?? "no answer", at });
      // a failed first load is tried once more in 5 s; later failures only when a panel on screen draws it (drawComms)
      if (prev?.loading) setTimeout(() => commsByRoot.get(rootKey)?.error && fetchComms(rootKey), 5000);
    } else {
      const ids = new Set(r.events.map((e) => e.id));
      const events = [...r.events, ...pushed.filter((e) => !ids.has(e.id))]; // what came while the broker answered
      for (const e of events) ids.add(e.id);
      const keys = new Set([...(Array.isArray(r.keys) ? r.keys : []), ...commsKeysOf(rootKey.slice(4))]);
      commsByRoot.set(rootKey, { root: rootKey, keys, events, peers: r.peers ?? {}, ids, at, tree: commsTreeOf(rootKey) });
    }
    if (commsStale.delete(rootKey) && commsByRoot.has(rootKey)) commsRefetchSoon(rootKey); // the links changed meanwhile
    commsRefresh();
  };
  api.getComms(rootKey.slice(4)).then(done, (e) => done({ error: e.message }));
}
/** The sessions of the tree under rootKey as this app's links see them (to tell whether it gained or lost any). */
const commsTreeOf = (rootKey) => commsKeysOf(rootKey.slice(4)).sort().join(" ");
/** The tree's log fetched again soon: at once when the last answer is 2 s old, else when it is (one timer per tree);
 *  a fetch running now is followed by another once it answers. */
function commsRefetchSoon(rootKey) {
  if (commsSoon.has(rootKey)) return;
  const wait = Math.max(0, (commsByRoot.get(rootKey)?.at ?? 0) + 2000 - Date.now());
  commsSoon.set(rootKey, setTimeout(() => {
    commsSoon.delete(rootKey);
    if (!commsByRoot.get(rootKey)?.events) return; // dropped, or not loaded (a first load or a failure has its own retry)
    if (commsFetching.has(rootKey)) commsStale.add(rootKey);
    else fetchComms(rootKey);
  }, wait));
}
/** The links changed: a cached tree whose root is no longer a root is dropped (fetched again under its new root when
 *  shown); a loaded tree is fetched again (at most every 2 s) when it gained or lost sessions, and on every change
 *  while a panel shows it (links_changed follows every peer change: the root's and outside nodes' online/busy come
 *  from the answer's peers). A failed or older broker's answer is retried by a panel on screen (drawComms). */
function commsLinksChanged() {
  const shown = new Set([...views.values()].filter((v) => v.panelKind === "comms").map((v) => `cli:${commsRootOf(v.sessionId)}`));
  for (const [rootKey, entry] of commsByRoot) {
    const id = rootKey.slice(4);
    if (commsRootOf(id) !== id || !tree.childrenOf.get(id)?.length) {
      commsByRoot.delete(rootKey);
      continue;
    }
    if (!shown.has(rootKey) && entry.tree === commsTreeOf(rootKey)) continue;
    if (commsFetching.has(rootKey)) commsStale.add(rootKey); // its answer may predate the change
    else if (entry.events) commsRefetchSoon(rootKey);
  }
  commsRefresh();
}
function setPanelCollapsed(collapsed) {
  ui.panelCollapsed = collapsed;
  saveUi();
  layoutPanels();
  if (!collapsed) commsRefresh(); // a Communication panel back on screen retries a failed load (drawComms)
}

/** Collapse / expand one project in place (no re-render, so the transition runs). */
function toggleGroup(cwd, header, items) {
  // while filtering every folder is shown expanded and the stored state stays as it was (a toggle you can't see
  // would surprise you when the filter is cleared)
  if ($("#search").value.trim()) return setStatus("Clear the filter to collapse or expand folders.");
  const collapsed = !ui.collapsed.has(cwd);
  if (collapsed) ui.collapsed.add(cwd);
  else ui.collapsed.delete(cwd);
  saveUi();
  header.classList.toggle("collapsed", collapsed);
  header.setAttribute("aria-expanded", String(!collapsed));
  items.classList.toggle("collapsed", collapsed);
  items.inert = collapsed;
}

function groupBlock(g) {
  const items = h("div", { class: "group-items" + (g.collapsed ? " collapsed" : "") }, h("div", {}, ...rowItems(g.rows)));
  items.inert = g.collapsed;
  const header = h(
    "div",
    {
      class: "group-title toggle" + (g.collapsed ? " collapsed" : ""),
      title: g.cwd,
      role: "button",
      tabindex: "0",
      "aria-expanded": String(!g.collapsed),
      onclick: () => toggleGroup(g.cwd, header, items),
      onkeydown: (e) => {
        if (e.target !== header || (e.key !== "Enter" && e.key !== " ")) return;
        e.preventDefault();
        toggleGroup(g.cwd, header, items);
      },
    },
    h("span", { class: "chev" }, "▸"),
    h("span", { class: "name" }, baseName(g.cwd)),
    h("span", { class: "count" }, String(g.count)),
    h(
      "button",
      {
        class: "new-here",
        title: `New session in ${g.cwd}`,
        onclick: (e) => {
          e.stopPropagation();
          newSession(g.cwd);
        },
      },
      "+",
    ),
  );
  return [header, items];
}

/** The model's rows (UiState.listModel) as sidebar items. */
function rowItems(rows) {
  return rows.map(({ s, depth, showProject }) => item(s, views.get(s.sessionId), { depth, showProject }));
}

/** Also redraws every view's relation bar: its dots and the Close all sub-sessions button follow the open views. */
function renderList() {
  const q = $("#search").value.trim().toLowerCase();
  const out = [];

  for (const v of views.values()) v.renderRelations();

  // the listed sessions plus the open views Copilot does not list (a child just created, say)
  const listed = new Set(sessions.map((s) => s.sessionId));
  const unlisted = [...views.values()].filter((v) => !listed.has(v.sessionId)).map((v) => ({ sessionId: v.sessionId, cwd: v.cwd, title: v.title }));
  const model = UiState.listModel([...sessions, ...unlisted], { pinned: ui.pinned, open: new Set(views.keys()), collapsed: ui.collapsed, query: q, tree });
  if (model.pinned.length) out.push(h("div", { class: "group-title" }, h("span", {}, "📌 Pinned")), ...rowItems(model.pinned));
  if (model.open.length) out.push(h("div", { class: "group-title" }, h("span", {}, "Open in app")), ...rowItems(model.open));
  for (const g of model.groups) out.push(...groupBlock(g));
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
    `May carry arguments; the system shell runs it and the app adds --acp --stdio at the end.\n` +
    `Quote a path with spaces, or give the path alone, e.g. ${example}\n` +
    (s.platform === "win32" ? `${PromptEditor.WINDOWS_QUOTES}\n` : "") +
    `A session can have its own command in its Setup. Find Copilot with: ${s.platform === "win32" ? "where copilot" : "which copilot"}`;
  renderStorage();
  $("#set-relay").checked = s.relay;
  $("#set-queue").checked = s.queueMidTurn;
  $("#set-keeper").checked = s.cacheKeeper?.enabled === true;
  $("#set-keeper-pings").value = s.cacheKeeper?.pings ?? "";
  $("#set-keeper-min").value = s.cacheKeeper ? s.cacheKeeper.minContext / 1000 : "";
  $("#set-context").value = s.contextTier;
  $("#set-activity").value = s.activityPanel ?? "off";
  $("#set-relay").disabled = !s.relayAvailable;
  $("#set-relay-hint").textContent = s.relayAvailable
    ? `Open sessions can message each other and terminal sessions through the broker at ${s.relayUrl}. Applies to sessions opened after saving.`
    : "relay-client.mjs is missing from this build, so the relay is not available.";
  brokerRepoDefault = s.brokerRepoDefault;
  $("#set-broker-repo").value = s.brokerRepo || s.brokerRepoDefault;
  $("#set-broker-repo").placeholder = s.brokerRepoDefault;
  renderPromptSettings(s);
  renderBroker(await api.brokerStatus().catch(() => null));
  $("#settings").returnValue = ""; // Escape keeps the previous value, which may be the last Save's
  $("#settings").showModal();
}
// "Prompts" section: the default part and the child part (defaultDefault / childDefault: it shows the built-in text
// and is saved as none, so a later version's text reaches it), and one row per template (the id stays with its row)
let defaultPartDefault = "";
let defaultDefault = true;
let childPartDefault = "";
let childDefault = true;
function renderPromptSettings(s) {
  defaultPartDefault = s.defaultPartDefault ?? "";
  childPartDefault = s.childPartDefault ?? "";
  setDefaultPart(s.promptDefault ?? defaultPartDefault, s.promptDefault == null);
  setChildPart(s.promptChild ?? childPartDefault, s.promptChild == null);
  $("#set-templates").replaceChildren(...(s.promptTemplates ?? []).map(templateRow));
  $("#set-prompt-note").textContent = SETTINGS_NOTE;
}
function setDefaultPart(text, isDefault) {
  $("#set-prompt-default").value = text;
  defaultDefault = isDefault;
  $("#set-prompt-default-restore").disabled = isDefault;
}
function setChildPart(text, isDefault) {
  $("#set-prompt-child").value = text;
  childDefault = isDefault;
  $("#set-prompt-child-restore").disabled = isDefault;
}
function templateRow({ id, name, text }) {
  const row = h(
    "div",
    { class: "tpl-row" },
    h("input", { class: "tpl-name", spellcheck: "false", placeholder: "Name", "aria-label": "Template name" }),
    h("button", { type: "button", class: "tpl-delete danger", title: "Delete this template", onclick: () => row.remove() }, "Delete"),
    h("textarea", { class: "tpl-text", rows: "3", spellcheck: "false", placeholder: "The text it puts into a session's own part", "aria-label": "Template text" }),
  );
  row._id = id;
  const nameInput = row.querySelector(".tpl-name");
  nameInput.value = name;
  // Enter would submit the Settings form through its first button (Cancel) and discard the visit: go to the text
  nameInput.addEventListener("keydown", (e) => {
    if (e.key !== "Enter" || e.isComposing) return;
    e.preventDefault();
    row.querySelector(".tpl-text").focus();
  });
  row.querySelector(".tpl-text").value = text;
  return row;
}
const promptTemplatesOfForm = () => [...$("#set-templates").querySelectorAll(".tpl-row")].map((r) => ({ id: r._id, name: r.querySelector(".tpl-name").value, text: r.querySelector(".tpl-text").value }));
$("#set-prompt-default").addEventListener("input", () => setDefaultPart($("#set-prompt-default").value, false));
$("#set-prompt-default-restore").addEventListener("click", () => setDefaultPart(defaultPartDefault, true));
$("#set-prompt-child").addEventListener("input", () => setChildPart($("#set-prompt-child").value, false));
$("#set-prompt-child-restore").addEventListener("click", () => setChildPart(childPartDefault, true));
$("#set-template-add").addEventListener("click", () => {
  const row = templateRow({ id: crypto.randomUUID(), name: `Template ${$("#set-templates").childElementCount + 1}`, text: "" });
  $("#set-templates").append(row);
  row.querySelector(".tpl-name").select();
});
// "Relay broker" section: one row per step of the restart run, the summary, the button locked while it runs
let brokerRepoDefault = "";
function renderBroker(st) {
  if (!st) return;
  $("#broker-steps").replaceChildren(
    ...st.steps.map((step) => {
      const row = BrokerRestart.stepRow(step);
      return h("li", { class: row.cls }, h("span", { class: "mark" }, row.mark), h("span", {}, row.text));
    }),
  );
  $("#broker-summary").textContent = st.summary;
  $("#broker-restart").disabled = st.running;
}
api.onBrokerRestart(renderBroker);
$("#set-broker-browse").addEventListener("click", async () => {
  const dir = await api.pickDir("copilot-relay repository").catch(() => null);
  if (dir) $("#set-broker-repo").value = dir;
});
$("#broker-restart").addEventListener("click", async () => {
  try {
    const q = BrokerRestart.restartQuestion(await api.brokerStatus());
    if (q && !confirm(q)) return;
    await api.brokerRestart($("#set-broker-repo").value);
  } catch (err) {
    $("#broker-summary").textContent = err.message;
  }
});
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
  await api.setSettings({
    copilotCommand: $("#set-command").value,
    relay: $("#set-relay").checked,
    contextTier: $("#set-context").value,
    queueMidTurn: $("#set-queue").checked,
    cacheKeeper: CacheKeeper.settingsOfForm({ enabled: $("#set-keeper").checked, pings: $("#set-keeper-pings").value, minContextK: $("#set-keeper-min").value }),
    activityPanel: $("#set-activity").value,
    brokerRepo: $("#set-broker-repo").value.trim() === brokerRepoDefault ? "" : $("#set-broker-repo").value,
    promptDefault: defaultDefault ? null : $("#set-prompt-default").value, // null: back to the built-in text
    promptChild: childDefault ? null : $("#set-prompt-child").value, // null: back to the built-in text
    promptTemplates: promptTemplatesOfForm(),
  });
  queueMidTurn = $("#set-queue").checked;
  activityPanel = $("#set-activity").value;
  for (const v of views.values()) v.settingChanged();
  refresh();
});

// ---------------------------------------------------------------------------
// wiring

const lastCommands = new Map(); // latest availableCommands per session (updates can precede the view)
api.onUpdate(({ sessionId, update }) => {
  if (update?.sessionUpdate === "available_commands_update") lastCommands.set(sessionId, update.availableCommands ?? []);
  views.get(sessionId)?.onUpdate(update);
});
api.onReplayed(({ replayId }) => replayEnds.get(replayId)?.());
api.onPermission((p) => views.get(p.sessionId)?.permission(p));
// the cache keeper's state: the chip in the view and the ⏳ mark in the list (a view reads keeperGet when it opens)
api.onKeeperState((st) => views.get(st.sessionId)?.keeperUpdate(st));
api.onExit((e) => views.get(e.sessionId)?.markDead(e));
api.onNotice((n) => views.get(n.sessionId)?.system(n.text));

// relay events can arrive before the view exists (right after session/new) – keep them until it does
const early = new Map();
const forView = (sessionId, fn) => {
  const v = views.get(sessionId);
  if (v) return fn(v);
  if (deletedIds.has(sessionId)) return; // no view will ever take these
  if (!early.has(sessionId)) early.set(sessionId, []);
  early.get(sessionId).push(fn);
};
function flushEarly(v) {
  if (lastUsage.has(v.sessionId)) v.usage(lastUsage.get(v.sessionId));
  if (lastCommands.has(v.sessionId)) v.setCommands(lastCommands.get(v.sessionId));
  for (const fn of early.get(v.sessionId) ?? []) fn(v);
  early.delete(v.sessionId);
}
api.onRelayMessage((m) => forView(m.sessionId, (v) => v.incoming(m)));
api.onRelayStatus((s) => forView(s.sessionId, (v) => v.relayStatus(s)));

// delegated sessions: only the app's approval answers a request (see delegation:answer in main)
api.onDelegationRequest((r) => {
  // a card with no view is not on screen: said in the log (main.log takes the window's warnings)
  if (!views.has(r.parentSessionId))
    console.warn(`[delegation] session_request ${r.requestId}: no view for session ${r.parentSessionId}${deletedIds.has(r.parentSessionId) ? " (deleted, dropped)" : " (kept until it opens)"}`);
  forView(r.parentSessionId, (v) => v.delegationCard(r));
});
api.onDelegationCreated(({ sessionId, cwd, configOptions, parentSessionId, title }) => {
  // as in newSession, but the view is not activated: approving a child doesn't take you away from what is on screen
  if (views.has(sessionId)) return;
  const v = new SessionView({ sessionId, cwd, title, parentSessionId });
  views.set(sessionId, v);
  flushEarly(v);
  v.setConfig(configOptions);
  v.system(`New session in ${cwd}`);
  if (!v.busy) v.setBusy(false); // (an early message may already have started its turn)
  scheduleRefresh();
});
// a relative messaged a closed session: the card goes to the sender's view (which may not exist yet)
api.onReopenRequest((r) => forView(r.sessionId, (v) => v.reopenCard(r)));
api.onLinkRequest((r) => forView(r.sessionId, (v) => v.linkCard(r)));

// the sub-session tree: the cached links at once, the broker's fresh ones (and every change) through onLinks
let freshLinks = false;
function setLinks(next) {
  const list = Array.isArray(next) ? next : next?.links;
  links = Array.isArray(list) ? list : [];
  heldByKey = (!Array.isArray(next) && next?.held) || {};
  heldByKindKey = (!Array.isArray(next) && next?.heldByKind) || {};
  tree = SessionTree.index(links);
  for (const v of views.values()) v.updatePanelShown(); // a session may have joined or left a tree
  commsLinksChanged();
  renderList(); // redraws the relation bars too
}
api.onLinks((l) => {
  freshLinks = true;
  setLinks(l);
});
api
  .getLinks()
  .then((l) => freshLinks || setLinks(l))
  .catch((e) => console.warn(`links: ${e.message}`));

api.onDelegationClosed(({ sessionId }) => {
  dropView(sessionId); // safe for a view that was never built (a failed creation)
  renderList();
});

// the sidebar quota line: live figure from main ({ line, tooltip }), or nothing when there is none
function showQuota(view) {
  const q = $("#side-quota");
  q.textContent = view ? view.line : "";
  q.title = view ? view.tooltip : "";
  q.hidden = !view;
}
const loadQuota = (opts) => api.quotaGet(opts).then(showQuota, () => {});
api.onQuota(showQuota);
loadQuota();

// latest usage per session, so a re-opened/replaced view starts with it; sidebar shows the latest quota line
const lastUsage = new Map();
api.onUsage(({ sessionId, view }) => {
  lastUsage.set(sessionId, view);
  forView(sessionId, (v) => v.usage(view));
  commsRefresh(); // the node's context bar
});
// a communication event of any tree: appended (once) to every cached tree it belongs to
api.onCommsEvent((event) => {
  if (!event?.id) return;
  let changed = false;
  for (const [rootKey, entry] of commsByRoot) {
    const pushed = commsFetching.get(rootKey);
    const mine = event.kind === "status" ? !!pushed || !!entry.ids?.has(event.ref) : !!(entry.keys?.has(event.fromKey) || entry.keys?.has(event.toKey));
    if (!mine) continue;
    if (pushed && !pushed.some((e) => e.id === event.id)) pushed.push(event);
    if (entry.ids && !entry.ids.has(event.id)) {
      entry.ids.add(event.id);
      entry.events.push(event);
      changed = true;
    }
  }
  if (changed) commsRefresh();
});

$("#btn-new").addEventListener("click", () => newSession());
$("#btn-new-2").addEventListener("click", () => newSession());
$("#btn-refresh").addEventListener("click", refresh);
$("#btn-settings").addEventListener("click", openSettings);
// the page is a modal dialog over the whole window; activeId stays, so the session is there again when it closes
$("#btn-schedules").addEventListener("click", () => {
  filePreview.close();
  Schedules.show();
});
Schedules.init();
// a notification click: the same path as ⏰, straight to the run (from any state, a session or an open job form too).
// Registered at load time, so the message main sends after a fresh window's did-finish-load is not missed.
function openJobRun({ jobId, runId }) {
  filePreview.close();
  if (viewer.isOpen) viewer.close(); // a fixed overlay: the modal page would cover it, its keys would still act
  Schedules.openRun(jobId, runId);
}
api.onJobOpenRun(openJobRun);
$("#search").addEventListener("input", renderList);
// Left Shift for message recall (an arrow key's event doesn't say which Shift is down). Tracked on the whole document,
// in the capture phase, so a Shift pressed before the message box got focus counts; reset whenever it can't be down.
const leftShift = { down: false };
const trackShift = (e) => {
  if (e.code === "ShiftLeft") leftShift.down = e.type === "keydown";
  // a Left Shift released where the page doesn't see it (inside a confirm() dialog) must not turn a later
  // Right Shift+arrow into a recall
  else if (!e.shiftKey || (e.code === "ShiftRight" && e.type === "keydown")) leftShift.down = false;
};
document.addEventListener("keydown", trackShift, true);
document.addEventListener("keyup", trackShift, true);
window.addEventListener("blur", () => (leftShift.down = false));

// Left Ctrl for the chat text size, tracked like Left Shift (a wheel event doesn't say which Ctrl is down)
const leftCtrl = { down: false };
const trackCtrl = (e) => {
  if (e.code === "ControlLeft") leftCtrl.down = e.type === "keydown";
  else if (!e.ctrlKey || (e.code === "ControlRight" && e.type === "keydown")) leftCtrl.down = false;
};
document.addEventListener("keydown", trackCtrl, true);
document.addEventListener("keyup", trackCtrl, true);
window.addEventListener("blur", () => (leftCtrl.down = false));

const applyChatScale = () => document.documentElement.style.setProperty("--chat-scale", String(ui.chatScale));
let scaleNote; // { el, text, timer }: the status line text the size note covers for a moment
function changeChatScale(dir) {
  const next = UiState.stepScale(ui.chatScale, dir);
  const atLimit = next === ui.chatScale && dir !== 0;
  ui.chatScale = next;
  saveUi();
  applyChatScale();
  const el = views.get(activeId)?.statusEl ?? $("#side-status");
  if (scaleNote?.el !== el) {
    if (scaleNote) scaleNote.el.textContent = scaleNote.text;
    scaleNote = { el, text: el.textContent };
  }
  clearTimeout(scaleNote.timer);
  const limit = atLimit ? (dir > 0 ? " (max)" : " (min)") : "";
  el.textContent = `Chat text ${Math.round(next * 100)} %${limit}`;
  const note = el.textContent;
  scaleNote.timer = setTimeout(() => {
    if (el.textContent === note) el.textContent = scaleNote.text; // unless something else wrote there meanwhile
    scaleNote = null;
  }, 1500);
}
applyChatScale();

// Ctrl+wheel and Ctrl + +/-/0 never zoom the whole window; with Left Ctrl they change the chat text size.
// (The image viewer handles its own wheel and keys while it is open.)
document.addEventListener(
  "wheel",
  (e) => {
    if (!e.ctrlKey) return;
    e.preventDefault();
    if (leftCtrl.down && !viewer.isOpen && !filePreview.isOpen && e.deltaY) changeChatScale(e.deltaY < 0 ? 1 : -1);
  },
  { passive: false, capture: true },
);
const ZOOM_KEYS = { "+": 1, "=": 1, "-": -1, _: -1, 0: 0, NumpadAdd: 1, NumpadSubtract: -1, Numpad0: 0 };
document.addEventListener(
  "keydown",
  (e) => {
    if (!e.ctrlKey || e.altKey || e.metaKey) return;
    const dir = ZOOM_KEYS[e.code] ?? ZOOM_KEYS[e.key];
    if (dir === undefined) return;
    e.preventDefault();
    if (leftCtrl.down && !viewer.isOpen && !filePreview.isOpen) changeChatScale(dir);
  },
  true,
);

document.addEventListener("keydown", (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "n") {
    e.preventDefault();
    newSession();
  }
});
setInterval(renderList, 60_000); // keep "x min ago" fresh
setStatus("Loading sessions…");
refresh();
