// The UI checks run by scripts/ui-check/run.mjs: { name, scenario?, modes?, settings?, sessionId?, broker?, run(app) },
// each throwing on failure. app is a driver (driver.mjs) launched with the check's scenario (default
// panel-scenario.mjs), settings, sessionId and broker, its mode already set.
import assert from "node:assert/strict";
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, readlinkSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { LATE_TEXT } from "../../electron/test/fixtures/acp/late-group-scenario.mjs";
import { PARTS } from "../../electron/test/fixtures/acp/panel-scroll-scenario.mjs";
import { RUNNING_TITLE } from "../../electron/test/fixtures/acp/tool-split-scenario.mjs";
import { CHILD_PART } from "../../electron/session-prompts.mjs";
import { REMINDER } from "../../electron/delegation.mjs";
import { gitIn } from "../../electron/test/git-helper.mjs";
import { launch, until } from "./driver.mjs";

// the notes of the prompt editor in a running session and of Settings (global constraints: RESTART_NOTE, SETTINGS_NOTE)
const RESTART_NOTE = "Saving restarts this session's Copilot. The history stays.";
const SETUP_TITLE = "This session's prompt and Copilot command (saving restarts its Copilot)";
const SETTINGS_NOTE = "Changes here reach a running session the next time its Copilot starts.";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const FIXTURES = path.join(ROOT, "electron", "test", "fixtures", "acp");
const SCRIPTED_AGENT = path.join(FIXTURES, "scripted-agent.mjs"); // the command settings.json holds in a launch
export const PANEL_SCENARIO = path.join(FIXTURES, "panel-scenario.mjs");
const BASELINE_DIR = path.join(ROOT, "electron", "test", "fixtures", "ui-baseline");

let recording = false;
/** run.mjs --record: the baseline checks write their file instead of comparing with it. */
export const setRecording = (on) => (recording = on);

/** The dump equals electron/test/fixtures/ui-baseline/<name>.json (the v0.15.0 chat), or is recorded there. */
function baseline(name, dump) {
  const file = path.join(BASELINE_DIR, `${name}.json`);
  if (recording) return writeFileSync(file, JSON.stringify(dump, null, 2) + "\n");
  if (!existsSync(file)) throw new Error(`no baseline ${path.relative(ROOT, file)}: run node scripts/ui-check/run.mjs --record`);
  assert.deepStrictEqual(dump, readBaseline(name));
}
const readBaseline = (name) => JSON.parse(readFileSync(path.join(BASELINE_DIR, `${name}.json`), "utf8"));

/** The three prompts of panel-scenario.mjs, the second one's permission answered. */
async function playScenario(app) {
  await app.newSession();
  await app.send("Look around.");
  await app.idle();
  await app.send("Run both checks.");
  await app.answerPermission();
  await app.idle();
  await app.send("Anything else?");
  await app.idle();
}

const V = `views.get("scripted-work")`; // the view of the scenario's session (driver.mjs: newSession)
const HISTORY_ID = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee"; // a session Copilot's history files can belong to (a UUID)
const WAIT_SCENARIO = path.join(FIXTURES, "panel-wait-scenario.mjs");
const SPLIT_SCENARIO = path.join(FIXTURES, "tool-split-scenario.mjs");
const CHANGES_SCENARIO = path.join(FIXTURES, "changes-scenario.mjs");
const LINK_SCENARIO = path.join(FIXTURES, "link-scenario.mjs");
const CHILD_PROMPT_SCENARIO = path.join(FIXTURES, "child-prompt-scenario.mjs");
const PERMISSION_WAIT_SCENARIO = path.join(FIXTURES, "permission-wait-scenario.mjs");
const PANEL_MODES = ["subagents", "all"];
const savedMode = (app) => app.ev(`api.getSettings().then((s) => s.activityPanel)`);

/** What breaks "every group's body is where the mode says" in the page, one message each (none: it holds): inline
 *  the body is inside its group, in a panel mode inside the group's entry in panelBody; the entries are those of the
 *  log's panel groups, in log order; the panel is hidden exactly when it has no entry. */
function placementErrors(app, mode) {
  return app.ev(`(() => {
    const v = ${V}, mode = ${JSON.stringify(mode)}, errors = [];
    const groups = [...v.log.querySelectorAll(":scope > .group")];
    const inPanel = (g) => mode === "all" || (mode === "subagents" && g._info.kind === "subagent");
    groups.forEach((g, i) => {
      const name = "group " + i + " (" + g._info.kind + ", " + JSON.stringify(g._info.title) + ")";
      if (inPanel(g)) {
        if (!g._entry || g._body.parentNode !== g._entry || g._entry.parentNode !== v.panelBody) errors.push(name + ": its body is not in its entry in the panel");
        if (!g.classList.contains("in-panel")) errors.push(name + ": no class in-panel");
      } else {
        if (g._body.parentNode !== g) errors.push(name + ": its body is not inside it");
        if (g.classList.contains("in-panel")) errors.push(name + ": class in-panel");
        if (g._entry?.isConnected) errors.push(name + ": its entry is in the page");
      }
    });
    const entries = [...v.panelBody.children];
    const expected = groups.filter(inPanel).map((g) => g._entry);
    if (entries.length !== expected.length || entries.some((e, i) => e !== expected[i])) errors.push("the panel's entries are not those of the log's panel groups in log order");
    if (v.panel.hidden !== !entries.length) errors.push("panel.hidden is " + v.panel.hidden + " with " + entries.length + " entries");
    if (v.activityBtn.hidden !== !entries.length) errors.push("the Activity button's hidden is " + v.activityBtn.hidden + " with " + entries.length + " entries");
    return errors;
  })()`);
}
const assertPlacement = async (app, mode, when) => assert.deepStrictEqual(await placementErrors(app, mode), [], `placement in mode ${mode} ${when}`);

/** The sync subagent's last message block in panel-wait-scenario (null before its first half arrived). */
const HALF_BLOCK = `([...${V}.log.querySelectorAll(":scope > .group.subagent")].flatMap((g) => [...g._body.querySelectorAll(".msg.agent")]).find((b) => b.textContent.includes("a.txt has")) ?? null)`;
/** The first prompt of panel-wait-scenario until its subagent stops halfway through its last message. */
async function untilHalfway(app) {
  await app.newSession();
  await app.send("Look around.");
  await app.check(`!!${HALF_BLOCK}`, "the subagent's message to stop halfway");
  assert.equal(await app.ev(`${HALF_BLOCK}._md().trim()`), "a.txt has", "the pause of panel-wait-scenario");
}

// --- scrolling (panel-scroll-scenario.mjs, in a window 500 px high so that the log and the panel overflow)
const SCROLL_SCENARIO = path.join(FIXTURES, "panel-scroll-scenario.mjs");
const LOG = `${V}.log`;
const PANEL = `${V}.panelBody`;
const FIRST_GROUP = `${V}.log.querySelector(":scope > .group")`; // the work group (the thought and the tool)
const SUB_GROUP = `${V}.log.querySelector(":scope > .group.subagent")`;
/** The subagent's message block (null before it exists). */
const SUB_BLOCK = `(${SUB_GROUP}?._body.querySelector(".msg.agent") ?? null)`;
/** dist: how far (px) the scroller is from its bottom; over: how much its content is taller than it; top: scrollTop. */
const scrollState = (app, el) => app.ev(`(() => { const e = ${el}; return { top: e.scrollTop, dist: e.scrollHeight - e.scrollTop - e.clientHeight, over: e.scrollHeight - e.clientHeight }; })()`);
const frames = (app) => app.ev("new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))");
/** Scrolls el as you would (the app sees only the scroll event), then waits for that event to have been handled. */
async function scrollTo(app, el, top) {
  await app.ev(`${el}.scrollTop = ${top}`);
  await frames(app);
}
const untilPart = (app, k) => app.check(`!!${SUB_BLOCK}?.textContent.includes("Part ${k}.")`, `the subagent's part ${k}`);
async function assertAtBottom(app, el, what) {
  const s = await scrollState(app, el);
  assert.ok(s.dist <= 2, `${what}: ${s.dist} px from the bottom`);
  return s;
}
/** The first prompt of panel-scroll-scenario in the short window, until the subagent's group exists. */
async function untilSubagent(app) {
  await app.resize(1280, 500);
  await app.newSession();
  await app.send("Explain the files.");
  await app.check(`!!${SUB_GROUP}`, "the subagent's group");
}
/** A recorded history (the scripted agent's .scripted-agent.json updates) of n turns, each a question, a work group
 *  (a thought, a tool), a sync task with its subagent's message (a subagent group) and a two-paragraph answer. */
function longHistory(n) {
  const para = words(3, "The answer goes on about the folder, its files and what each of them holds.");
  return Array.from({ length: n }, (_, i) => {
    const agentId = `66666666-6666-4666-8666-${String(i).padStart(12, "0")}`;
    const text = (messageId, t, meta) => ({ sessionUpdate: "agent_message_chunk", messageId, content: { type: "text", text: t }, ...meta });
    return [
      { sessionUpdate: "user_message_chunk", content: { type: "text", text: `Question ${i}` } },
      { sessionUpdate: "agent_thought_chunk", messageId: `th${i}`, content: { type: "text", text: `Thinking ${i}` } },
      { sessionUpdate: "tool_call", toolCallId: `ls${i}`, title: "ls", kind: "execute", status: "completed", rawInput: { command: "ls" } },
      {
        sessionUpdate: "tool_call",
        toolCallId: `task${i}`,
        title: "Explain the files",
        kind: "other",
        status: "pending",
        rawInput: { agent_type: "explore", name: `explain-${i}`, description: "Explain the files", prompt: "Explain the files.", mode: "sync" },
      },
      text(`s${i}`, `Subagent ${i}. ${para}`, { _meta: { "github.com/copilot": { agentId } } }),
      { sessionUpdate: "tool_call_update", toolCallId: `task${i}`, status: "completed", content: [{ type: "content", content: { type: "text", text: "Explained." } }], rawOutput: { content: "Explained." } },
      text(`m${i}`, `Answer ${i}. ${para}\n\n${para}`),
    ];
  }).flat();
}
const words = (n, line) => Array.from({ length: n }, () => line).join(" ");
/** Opens the subagent's entry as a mode switch carries an open group over: not a click, which stops the follow. */
const openSubEntry = (app) => app.ev(`${SUB_GROUP}._entry.open = true`);
/** In a panel mode (the subagent's body is in the panel): its entry open, the panel scrolled to its end, following. */
async function followingPanel(app) {
  await openSubEntry(app);
  await frames(app);
  await scrollTo(app, PANEL, `${PANEL}.scrollHeight`);
  assert.equal(await app.ev(`${V}.panelFollow`), true, "the panel follows");
}

// --- width, collapse and the narrow drawer (Task 5)
// a folder that does not exist: the broker-restart check restarts nothing
const NO_BROKER_REPO = path.join(os.tmpdir(), "copilot-relay-ui-check-no-such-repo");
const LONG_WAIT_SCENARIO = path.join(FIXTURES, "panel-long-wait-scenario.mjs");
/** The view's panel as you see it: its width in real pixels, 0 when it is not shown. */
const panelWidth = (app, v = V) => app.ev(`(() => { const p = ${v}.panel; return p.checkVisibility() ? Math.round(p.getBoundingClientRect().width) : 0; })()`);
const shown = (app, el) => app.ev(`${el}.checkVisibility()`);
/** Drags the view's handle dx px (negative: left) with the pointer, as you would; then waits for the layout. */
async function dragHandle(app, dx, v = V) {
  await app.ev(`(() => {
    const h = ${v}.panelHandle, r = h.getBoundingClientRect();
    const x = r.left + r.width / 2, y = r.top + r.height / 2;
    const ev = (type, clientX) => new PointerEvent(type, { bubbles: true, cancelable: true, pointerId: 1, isPrimary: true, pointerType: "mouse", button: 0, buttons: type === "pointerup" ? 0 : 1, clientX, clientY: y });
    h.dispatchEvent(ev("pointerdown", x));
    const dx = ${dx};
    document.elementFromPoint(x + dx / 2, y)?.dispatchEvent(ev("pointermove", x + dx / 2));
    document.body.dispatchEvent(ev("pointermove", x + dx));
    document.body.dispatchEvent(ev("pointerup", x + dx));
  })()`);
  await frames(app);
}
const panelButton = (v = V) => `${v}.panel.querySelector(".panel-head button")`;
/** Clicks the panel head's button (collapse, or close the drawer). */
async function panelHeadButton(app, v = V) {
  await app.ev(`${panelButton(v)}.click()`);
  await frames(app);
}
async function activityButton(app, v = V) {
  assert.equal(await shown(app, `${v}.activityBtn`), true, "the Activity button shows");
  await app.ev(`${v}.activityBtn.click()`);
  await frames(app);
}
/** Clicks the first in-panel group's header in the chat. */
async function headerClick(app, v = V) {
  await app.ev(`${v}.log.querySelector(":scope > .group.in-panel > summary").click()`);
  await frames(app);
}
/** The first prompt of panel-scenario in the view. */
async function firstTurn(app) {
  await app.newSession();
  await app.send("Look around.");
  await app.idle();
}
/** A second session (in the launch's folder) that has played panel-scenario's first prompt; it is the active view. */
async function secondView(app) {
  await app.startSession(app.dir); // the parent folder of the scenario's session
  const id = await app.ev(`[...views.keys()].find((id) => id !== "scripted-work") ?? null`);
  assert.ok(id, "a second view");
  const v = `views.get(${JSON.stringify(id)})`;
  await app.ev(`(() => { const v = ${v}; v.input.value = "Look around."; v.input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })); })()`);
  await app.check(`(() => { const v = ${v}; return !v.busy && !!v.panelBody.firstElementChild && Date.now() - (v.lastUpdate ?? 0) > 300; })()`, "the second view's turn");
  await frames(app);
  return { id, v };
}
const activate = async (app, id) => {
  await app.ev(`activate(${JSON.stringify(id)})`);
  await frames(app);
};
/** Closes the app, keeping its folder, and launches it again there with the view of scripted-work open. */
async function relaunch(app, width = 1280) {
  await app.close({ keep: true });
  const again = await launch({ scenario: PANEL_SCENARIO, dir: app.dir, width });
  try {
    await again.ev(`openSession({ sessionId: "scripted-work", cwd: ${JSON.stringify(path.join(app.dir, "work"))} })`, "the session to reopen");
    await again.check(`(() => { const v = ${V}; return v && !v.busy && !v.resuming && !!v.panelBody.firstElementChild && Date.now() - (v.lastUpdate ?? 0) > 300; })()`, "the replay");
    await frames(again);
  } catch (e) {
    await again.close();
    throw e;
  }
  return again;
}
/** In the narrow layout: the drawer's state as you see it. */
const drawerState = (app) => app.ev(`(() => {
  const v = ${V};
  return { narrow: v.row.classList.contains("narrow"), shown: v.panel.checkVisibility(), hidden: v.panel.hidden, logWidth: v.log.offsetWidth, rowWidth: v.row.clientWidth };
})()`);
const storedUi = (app) => app.ev("localStorage.getItem(UI_KEY)");

// --- edit mode, a dead view, Stop, a view switched while hidden, the turn marks (Task 6)
/** What breaks "a panel entry is dimmed exactly when its group in the log comes after the message being edited" (none
 *  while not editing), one message each; with the number of entries dimmed and not. */
const dimState = (app) => app.ev(`(() => {
  const v = ${V}, from = v.edit?.el ?? null, errors = [];
  let dimmed = 0, clear = 0;
  [...v.log.querySelectorAll(":scope > .group")].forEach((g, i) => {
    if (!g._entry) return;
    const after = !!from && !!(from.compareDocumentPosition(g) & Node.DOCUMENT_POSITION_FOLLOWING);
    const dim = g._entry.classList.contains("dim");
    if (dim !== after) errors.push("group " + i + " (" + g._info.kind + "): dim " + dim + ", after the edited message " + after);
    if (!g.classList.contains("in-panel")) return;
    const opacity = getComputedStyle(g._entry).opacity;
    if (opacity !== (after ? "0.45" : "1")) errors.push("group " + i + ": its entry's opacity is " + opacity);
    if (after) dimmed++;
    else clear++;
  });
  return { errors, dimmed, clear };
})()`);
/** The scripted session has no Copilot history to count (its id is no UUID): startEdit's own code, its one history
 *  call (api.countFrom, for the banner) answered in the page. */
async function stubEditCount(app) {
  const ok = await app.ev(`(() => {
    const src = SessionView.prototype.startEdit.toString();
    if (src.split("api.countFrom(").length !== 2) return false;
    window.__countFrom = async () => ({ removedUserMessages: 2, removedEvents: 0 });
    SessionView.prototype.startEdit = (0, eval)("({ " + src.replace("api.countFrom(", "__countFrom(") + " })").startEdit;
    return true;
  })()`);
  assert.equal(ok, true, "startEdit calls api.countFrom once");
}
/** The pids of the scripted agents running in the launch's work folder (the session's Copilot processes). Only the
 *  agent itself (`node …/scripted-agent.mjs`) counts, not the shell that started it (`sh -c '…scripted-agent.mjs' …`). */
function agentPids(app) {
  const work = path.join(app.dir, "work");
  return readdirSync("/proc")
    .filter((p) => /^\d+$/.test(p))
    .filter((p) => {
      try {
        return readlinkSync(`/proc/${p}/cwd`) === work && readFileSync(`/proc/${p}/cmdline`, "utf8").split("\0")[1]?.endsWith("scripted-agent.mjs");
      } catch {
        return false; // gone, or not ours
      }
    })
    .map(Number);
}
/** Every group's mark: in the chat, and in its entry when its body is in the panel (else null). */
const groupMarks = (app) => app.ev(`[...${V}.log.querySelectorAll(":scope > .group")].map((g) => ({
  kind: g._info.kind,
  chat: g.querySelector(":scope > summary .mark").textContent,
  entry: g.classList.contains("in-panel") ? g._entry.querySelector(":scope > summary .mark").textContent : null,
}))`);
/** For each turn (from its user message to the next one): how many of its other log children have Fork and Delete;
 *  and the children with more than one Fork. */
const turnActs = (app) => app.ev(`(() => {
  const counts = [], doubles = [];
  [...${V}.log.children].forEach((e, i) => {
    if (e.classList.contains("msg") && (e.classList.contains("user") || e.classList.contains("relay"))) return counts.push(0);
    if (!counts.length) return;
    const labels = [...e.querySelectorAll(".acts button.act")].map((b) => b.textContent);
    const forks = labels.filter((l) => l === "Fork").length;
    if (forks > 1) doubles.push(i);
    if (forks && labels.includes("Delete")) counts[counts.length - 1]++;
  });
  return { counts, doubles };
})()`);
/** The marks of panel-wait-scenario's groups after a Stop halfway through the sync subagent, as mode off shows them:
 *  the two work groups (before and after the plan) ✓, their tools ended; the subagent ⊘, stopped before its task
 *  ended. */
/** Every work group's header as shown: the leading mark and its class, the title's text and tooltip, the classes of
 *  the marks inside the title; the same for its panel entry (null when its body is not in the panel). */
const workHeaders = (app) => app.ev(`[...${V}.log.querySelectorAll(":scope > .group.work")].map((g) => {
  const head = (s) => {
    const title = s.querySelector(".title");
    return { mark: s.querySelector(".mark").textContent, cls: s.querySelector(".mark").className, text: title.textContent, tip: title.title, inner: [...title.querySelectorAll(".mark")].map((m) => m.className) };
  };
  return { chat: head(g.querySelector(":scope > summary")), entry: g.classList.contains("in-panel") ? head(g._entry.querySelector(":scope > summary")) : null };
})`);
const STOP_MARKS = [
  { kind: "work", chat: "✓" },
  { kind: "work", chat: "✓" },
  { kind: "subagent", chat: "⊘" },
];

/** The changes checks' repository in the launch's work folder: one commit of README.md, b.txt and a .gitignore that
 *  hides the scripted agent's file. git runs only there, isolated and with a test identity. */
async function changesRepo(app) {
  const work = path.join(app.dir, "work");
  writeFileSync(path.join(work, "README.md"), "# work\n");
  writeFileSync(path.join(work, "b.txt"), "b\n");
  writeFileSync(path.join(work, ".gitignore"), ".scripted-agent.json\n");
  await gitIn(work, ["init", "-q", "-b", "main"]);
  await gitIn(work, ["add", "README.md", "b.txt", ".gitignore"]);
  await gitIn(work, ["commit", "-q", "-m", "first"]);
  return work;
}

/** A new session's turn of changes-scenario.mjs, then notes.txt as its edit wrote it, recorded as touched. */
async function notesWritten(app, work) {
  const id = await app.newSession();
  await app.send("Write the notes.");
  await app.idle();
  // written after the turn: it did not exist at the start point
  writeFileSync(path.join(work, "notes.txt"), "hello\n");
  await app.check(`api.changesList(${JSON.stringify(id)}).then((l) => l.repos[0]?.files.some((f) => f.path === "notes.txt" && f.touched))`, "the edit to be recorded");
  return id;
}

const FP = `document.querySelector("#file-preview")`;
/** The changes browser's list: per group its name and rows (state letter, marks, path, selected). */
const fpGroups = (app) => app.ev(`[...${FP}.querySelectorAll(".fp-group")].map((g) => ({
  name: g.querySelector(".fp-group-name").textContent,
  rows: [...g.querySelectorAll(".fp-row")].map((r) => ({
    state: r.querySelector(".fp-state").textContent,
    flags: [...r.querySelectorAll(".fp-flag")].map((f) => f.textContent).join(""),
    path: r.querySelector(".fp-row-path").textContent,
    active: r.classList.contains("active"),
  })),
}))`);
const fpRow = (rel) => `[...${FP}.querySelectorAll(".fp-row")].find((r) => r.querySelector(".fp-row-path").textContent === ${JSON.stringify(rel)})`;
const fpArrow = (rel) => `${fpRow(rel)}.querySelector(".fp-arrow")`;
/** The block of commit rows under rel's row (null when it is folded). */
const fpCommitsOf = (rel) => `(() => { const b = ${fpRow(rel)}?.nextElementSibling; return b?.classList.contains("fp-commits") ? b : null; })()`;
/** The commit rows under rel's row: label and selected. */
const fpCommits = (app, rel) => app.ev(`[...(${fpCommitsOf(rel)}?.querySelectorAll(".fp-commit") ?? [])].map((c) => ({ label: c.textContent, active: c.classList.contains("active") }))`);
const fpDiffTypes = (app) => app.ev(`[...${FP}.querySelectorAll(".fp-diff .dv-line")].map((l) => l.className.replace("dv-line ", ""))`);
const fpListed = (app) => app.check(`!${FP}.hidden && ${FP}.querySelector(".fp-loading").hidden && ${FP}.querySelectorAll(".fp-row").length > 0`, "the list of changes");
/** Clicks the row of rel and waits for its diff (or a message) in the diff pane. */
async function fpSelect(app, rel) {
  await app.ev(`${fpRow(rel)}.click()`);
  await app.check(`${fpRow(rel)}.classList.contains("active") && !!${FP}.querySelector(".fp-diff .dv, .fp-diff .fp-msg")`, `the diff of ${rel}`);
}

export const checks = [
  {
    name: "baseline-live",
    async run(app) {
      await playScenario(app);
      baseline("live", await app.dump());
    },
  },
  {
    name: "baseline-replay",
    async run(app) {
      await playScenario(app);
      await app.reload();
      baseline("replay", await app.dump());
    },
  },
  {
    // every top-level user/relay/agent message shows HH:MM inside its right padding, clear of its text; one date line
    name: "message-times-live",
    modes: ["off"],
    async run(app) {
      await playScenario(app);
      const r = await app.ev(`(() => {
        const v = ${V};
        const rect = (e) => e.getBoundingClientRect();
        const timed = [...v.log.querySelectorAll(":scope > .msg.user, :scope > .msg.relay, :scope > .msg.agent")].filter((e) => !e.hidden);
        const seps = [...v.log.querySelectorAll(":scope > .day-sep")];
        const bad = (e) => {
          const t = e.querySelector(":scope > .time"), b = e.querySelector(":scope > .body, :scope > .md");
          return !t || !b || rect(t).left < rect(b).right || rect(t).right > rect(e).right || rect(t).top < rect(e).top || rect(t).width === 0;
        };
        return {
          timed: timed.length,
          clocks: timed.map((e) => e.querySelector(":scope > .time")?.textContent ?? null),
          bad: timed.filter(bad).length,
          seps: seps.length,
          sepFirst: seps[0]?.nextElementSibling === timed[0],
          sepText: seps[0]?.textContent === MessageTimes.dayLabel(Date.now()),
          elsewhere: v.el.querySelectorAll(".time").length - timed.length,
        };
      })()`);
      assert.ok(r.timed > 3, "the scenario's three prompts and their answers");
      assert.ok(r.clocks.every((c) => /^\d\d:\d\d$/.test(c ?? "")), JSON.stringify(r.clocks));
      assert.deepEqual({ bad: r.bad, seps: r.seps, sepFirst: r.sepFirst, sepText: r.sepText, elsewhere: r.elsewhere }, { bad: 0, seps: 1, sepFirst: true, sepText: true, elsewhere: 0 });
      // nothing of a message lies under its time: one word, wrapping and unbroken text, relay bubbles, the continue
      // line, and answers that start with a table, an image or code wider than the message
      await app.ev(`(() => {
        const v = ${V};
        const add = (el, name) => { v.flush(); v.append(el); el.dataset.probe = name; };
        add(v.userBubble("ok"), "one word");
        add(v.userBubble("word ".repeat(400)), "wrapping");
        add(v.userBubble("x".repeat(900)), "unbroken");
        add(bubble("relay", "hi", "other"), "relay");
        add(bubble("relay", "relay text ".repeat(200), "a-very-long-session-name-".repeat(12)), "relay, long from");
        add(h("div", { class: "msg user continue" }, h("div", { class: "body" }, MessageQueue.CONTINUE_LABEL)), "continue line");
        const answer = (text, id, name) => { v.stream("agent", text, id); v.flush(); [...v.log.querySelectorAll(":scope > .msg.agent")].at(-1).dataset.probe = name; };
        const cols = Array.from({ length: 40 }, (_, i) => "column_" + i);
        const row = (cells) => "| " + cells.join(" | ") + " |";
        answer([row(cols), row(cols.map(() => "---")), row(cols.map((c) => c + "_value"))].join("\\n"), "probe-table", "wide table first");
        answer("<img src='data:image/svg+xml;utf8,<svg xmlns=%22http://www.w3.org/2000/svg%22 width=%222000%22 height=%2250%22/>' width='2000' height='50'>", "probe-img", "wide image first");
        answer("~~~\\n" + "c".repeat(500) + "\\n~~~", "probe-code", "long code first");
      })()`);
      await app.idle();
      const under = await app.ev(`(() => {
        const v = ${V};
        const hit = (a, b) => a.left < b.right - 0.5 && a.right > b.left + 0.5 && a.top < b.bottom - 0.5 && a.bottom > b.top + 0.5;
        const own = (n) => n.closest(".time, .acts, .copy");
        // what of a rectangle shows: clipped by every scrolling box between its node and the message
        const shown = (q, node, msg) => {
          let r = { left: q.left, right: q.right, top: q.top, bottom: q.bottom };
          for (let p = node; p && p !== msg; p = p.parentElement) {
            if (getComputedStyle(p).overflowX === "visible") continue;
            const c = p.getBoundingClientRect();
            r = { left: Math.max(r.left, c.left), right: Math.min(r.right, c.right), top: Math.max(r.top, c.top), bottom: Math.min(r.bottom, c.bottom) };
          }
          return r;
        };
        const bad = [];
        const probes = [...v.log.querySelectorAll(":scope > [data-probe]")];
        for (const el of probes) {
          const t = el.querySelector(":scope > .time");
          if (!t) { bad.push(el.dataset.probe + ": no time"); continue; }
          const tr = t.getBoundingClientRect();
          let covered = false;
          const tw = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
          for (let n = tw.nextNode(); n && !covered; n = tw.nextNode()) {
            if (!n.data.trim() || own(n.parentElement)) continue;
            const range = document.createRange();
            range.selectNodeContents(n);
            covered = [...range.getClientRects()].some((q) => hit(shown(q, n.parentElement, el), tr));
          }
          for (const d of el.querySelectorAll("table, img, pre")) if (!own(d) && hit(shown(d.getBoundingClientRect(), d.parentElement, el), tr)) covered = true;
          if (covered) bad.push(el.dataset.probe);
        }
        return { probes: probes.length, bad };
      })()`);
      assert.deepEqual(under, { probes: 9, bad: [] });
      // the first message of the next day gets its own date line
      const next = await app.ev(`(() => {
        const v = ${V};
        const el = bubble("user", "after midnight");
        v.log.append(el);
        const d = new Date();
        d.setDate(d.getDate() + 1);
        v.stamp(el, d.getTime());
        v.stamp(el, 0); // a second stamp changes nothing
        return { seps: v.log.querySelectorAll(":scope > .day-sep").length, before: el.previousElementSibling?.className, times: el.querySelectorAll(".time").length };
      })()`);
      assert.deepEqual(next, { seps: 2, before: "day-sep", times: 1 });
    },
  },
  {
    // replayed messages take the times of the history: users by ordinal, agents by messageId; never a shifted time
    name: "message-times-replay",
    modes: ["off"],
    async run(app) {
      await playScenario(app);
      await app.reload();
      const SETUP = `const v = ${V};
        const day = (d, h, m) => new Date(2026, 10, d, h, m).getTime();
        const users = [...v.log.querySelectorAll(":scope > .msg.user")];
        const agents = [...v.log.querySelectorAll(":scope > .msg.agent")].filter((e) => typeof e._messageId === "string");
        const clock = (e) => e.querySelector(":scope > .time")?.textContent ?? null;`;
      const r = await app.ev(`(() => {
        ${SETUP}
        const before = v.el.querySelectorAll(".time, .day-sep").length; // the scripted session has no events.jsonl
        users[1].hidden = true; // an empty replayed prompt: counted, not stamped
        const last = agents.at(-1);
        v.applyTimes({ users: [day(21, 20, 22), day(21, 20, 30), day(22, 9, 5)], agents: Object.fromEntries(agents.map((e) => [e._messageId, e === last ? day(22, 9, 6) : day(21, 20, 23)])) });
        const seps = [...v.log.querySelectorAll(":scope > .day-sep")];
        return {
          before, users: users.length, agents: agents.length > 1,
          userClocks: users.map(clock), agentClocks: [...new Set(agents.map(clock))],
          seps: seps.map((s) => [s.textContent === MessageTimes.dayLabel(day(21, 12, 0)), s.textContent === MessageTimes.dayLabel(day(22, 12, 0)), users.indexOf(s.nextElementSibling)]),
        };
      })()`);
      assert.deepEqual(r, {
        before: 0, users: 3, agents: true,
        userClocks: ["20:22", null, "09:05"], agentClocks: ["20:23", "09:06"],
        seps: [[true, false, 0], [false, true, 2]],
      });
      // one user time too few: no user message is stamped, the agent ones are; a late block of the history keeps its time
      await app.reload();
      const m = await app.ev(`(() => {
        ${SETUP}
        v.applyTimes({ users: [day(21, 20, 22), day(21, 20, 30)], agents: { ...Object.fromEntries(agents.map((e) => [e._messageId, day(21, 20, 23)])), "late-1": day(21, 20, 40) } });
        v.stream("agent", "late", "late-1");
        v.flush();
        const late = [...v.log.querySelectorAll(":scope > .msg.agent")].at(-1);
        return { userClocks: users.map(clock), agentClocks: [...new Set(agents.map(clock))], late: clock(late), seps: v.log.querySelectorAll(":scope > .day-sep").length };
      })()`);
      assert.deepEqual(m, { userClocks: [null, null, null], agentClocks: ["20:23"], late: "20:40", seps: 1 });
    },
  },
  {
    // the real open path: the reopened session's events.jsonl is read (api.messageTimes) and its times are shown
    name: "message-times-history",
    modes: ["off"],
    sessionId: HISTORY_ID,
    async run(app) {
      const v = `views.get(${JSON.stringify(HISTORY_ID)})`;
      await playScenario(app);
      const ids = await app.ev(`[...${v}.log.querySelectorAll(":scope > .msg.agent")].map((e) => e._messageId)`);
      assert.ok(ids.length > 1 && ids.every((id) => typeof id === "string"), JSON.stringify(ids));
      const iso = (d, h, m) => new Date(2026, 10, d, h, m, 30).toISOString();
      const user = (d, h, m) => ({ type: "user.message", data: { content: "x" }, timestamp: iso(d, h, m) });
      const answer = (id, d, h, m) => ({ type: "assistant.message", data: { messageId: id, content: "x" }, timestamp: iso(d, h, m) });
      const dir = path.join(app.dir, "copilot-home", "session-state", HISTORY_ID);
      mkdirSync(dir, { recursive: true });
      const events = [
        { type: "session.start", data: {}, timestamp: iso(21, 9, 0) },
        user(21, 20, 22),
        ...ids.slice(0, -1).map((id) => answer(id, 21, 20, 23)),
        user(21, 23, 58),
        user(22, 9, 5),
        answer(ids.at(-1), 22, 9, 6),
      ];
      writeFileSync(path.join(dir, "events.jsonl"), events.map((e) => JSON.stringify(e)).join("\n") + "\n");
      await app.reload();
      const r = await app.ev(`(() => {
        const v = ${v};
        const clock = (e) => e.querySelector(":scope > .time")?.textContent ?? null;
        const users = [...v.log.querySelectorAll(":scope > .msg.user")];
        const agents = [...v.log.querySelectorAll(":scope > .msg.agent")];
        return {
          userClocks: users.map(clock),
          agentClocks: [...new Set(agents.map(clock))],
          sepsBeforeUser: [...v.log.querySelectorAll(":scope > .day-sep")].map((s) => users.indexOf(s.nextElementSibling)),
        };
      })()`);
      assert.deepEqual(r, { userClocks: ["20:22", "23:58", "09:05"], agentClocks: ["20:23", "09:06"], sepsBeforeUser: [0, 2] });
    },
  },
  {
    // the load replays the whole history, then fails: the dead view shows all of it, settled (the answer must not
    // end the replay before the last update); a few times, as the order of the two used to vary
    name: "failed-load-settles",
    modes: ["off"],
    scenario: path.join(FIXTURES, "failing-load-scenario.mjs"),
    async run(app) {
      await playScenario(app);
      const { thread } = readBaseline("replay");
      for (let i = 1; i <= 6; i++) {
        await app.reload();
        const v = `views.get("scripted-work")`;
        const state = await app.ev(`({ dead: ${v}.dead, running: ${v}.log.querySelectorAll(".mark.running").length, bg: ${v}.bgEl.hidden ? "" : ${v}.bgEl.textContent })`);
        assert.deepStrictEqual(state, { dead: true, running: 0, bg: "" }, `failed load ${i}`);
        const dump = await app.dump();
        assert.equal(dump.thread, thread, `failed load ${i}: the replayed thread`);
        assert.deepStrictEqual(dump.log.at(-1), ["msg error", null, null, false], `failed load ${i}: the error line`);
      }
    },
  },
  {
    // closed while it resumes and opened again: the second view ends its replay (the first open's end must not
    // take the second one's wait, nor end it early)
    name: "reopen-while-resuming",
    modes: ["off"],
    scenario: path.join(FIXTURES, "slow-load-scenario.mjs"),
    async run(app) {
      await playScenario(app);
      const id = JSON.stringify("scripted-work");
      await app.ev(`(async () => {
        window.confirm = () => true; // "still working, close?": yes
        const cwd = views.get(${id}).cwd;
        await closeView(${id});
        openSession({ sessionId: ${id}, cwd });
        await new Promise((r) => setTimeout(r, 500));
        await closeView(${id});
        openSession({ sessionId: ${id}, cwd });
      })()`);
      await app.idle();
      assert.equal(await app.ev(`views.get(${id}).statusEl.textContent === "Resuming session…"`), false);
      assert.deepStrictEqual(await app.dump(), readBaseline("replay"));
    },
  },
  {
    // Save without touching the select keeps the mode, in the page and on disk (a relaunch reads it back)
    name: "save-keeps-mode",
    modes: ["all"],
    async run(app) {
      await app.ev(`document.querySelector("#btn-settings").click()`);
      await app.check(`document.querySelector("#settings").open`, "the Settings dialog");
      await app.ev(`document.querySelector("#set-save").click()`);
      await app.check(`!document.querySelector("#settings").open`, "the Settings dialog to close");
      assert.equal(await app.ev(`api.getSettings().then((s) => s.activityPanel)`), "all");
      await app.close({ keep: true });
      const again = await launch({ scenario: PANEL_SCENARIO, dir: app.dir });
      try {
        assert.equal(await again.ev(`api.getSettings().then((s) => s.activityPanel)`), "all");
        await again.ev(`document.querySelector("#btn-settings").click()`);
        await again.check(`document.querySelector("#settings").open`, "the Settings dialog");
        assert.equal(await again.ev(`document.querySelector("#set-activity").value`), "all");
      } finally {
        await again.close();
      }
    },
  },
  {
    // every group's body is where the mode says, live and after a replay
    name: "panel-placement",
    async run(app) {
      const mode = await savedMode(app);
      await playScenario(app);
      await assertPlacement(app, mode, "live");
      await app.reload();
      await assertPlacement(app, mode, "after the replay");
    },
  },
  {
    // an in-panel group's header in the chat shows its entry; both headers say the same, ⏸ included; the card does not
    // take the focus out of the panel
    name: "header-shows",
    modes: PANEL_MODES,
    async run(app) {
      await app.newSession();
      await app.send("Look around.");
      await app.idle();
      // the focus in the panel (wide layout): an arriving permission card leaves it there
      await app.ev(`${V}.panel.querySelector(".panel-entry > summary").focus()`);
      await app.send("Run both checks.");
      await app.check(`!!${V}.el.querySelector(".perm:not(.done)")`, "a permission card");
      assert.equal(await app.ev(`${V}.panel.contains(document.activeElement)`), true, "the focus still in the panel after the card arrived");
      const waiting = await app.ev(`[...${V}.log.querySelectorAll(":scope > .group")]
        .filter((g) => g.querySelector(":scope > summary .title").textContent.includes("⏸"))
        .map((g) => ({ inPanel: g.classList.contains("in-panel"), entry: g._entry?.querySelector(":scope > summary .title").textContent ?? null }))`);
      assert.equal(waiting.length, 1, "one group header with ⏸ in the chat");
      assert.equal(waiting[0].inPanel, true, "the waiting group is in the panel");
      assert.match(waiting[0].entry ?? "", /⏸/, "its entry's header shows ⏸");
      await app.answerPermission();
      await app.idle();
      await app.send("Anything else?");
      await app.idle();
      const headers = await app.ev(`[...${V}.log.querySelectorAll(":scope > .group.in-panel")].map((g) => {
        const head = (s) => [s.querySelector(".mark").textContent, s.querySelector(".title").textContent];
        return [head(g.querySelector(":scope > summary")), head(g._entry.querySelector(":scope > summary"))];
      })`);
      assert.ok(headers.length > 0, "groups in the panel");
      for (const [chat, entry] of headers) assert.deepStrictEqual(entry, chat, "the entry's header equals the group's header");
      const shown = await app.ev(`(() => {
        const g = ${V}.log.querySelector(":scope > .group.in-panel");
        window.__shown = g;
        g.querySelector(":scope > summary").click();
        return { groupOpen: g.open, entryOpen: g._entry.open, flash: g._entry.classList.contains("flash") };
      })()`);
      assert.deepStrictEqual(shown, { groupOpen: false, entryOpen: true, flash: true });
      await app.check(`!__shown._entry.classList.contains("flash")`, "the highlight to end");
    },
  },
  {
    // all six transitions after the scenario: placement, the chat (baseline), one Fork/Delete bar per group at most,
    // and every open state carried over (one more group opened where it is after each step)
    name: "mode-transitions",
    modes: ["off"],
    async run(app) {
      await playScenario(app);
      const live = readBaseline("live");
      await app.ev(`(() => {
        const v = ${V};
        window.__opened = [v.log.querySelector(":scope > .group.work"), v.log.querySelector(":scope > .group.subagent")];
        for (const g of __opened) g.open = true;
      })()`);
      for (const mode of ["subagents", "all", "off", "all", "subagents", "off"]) {
        const when = `after the switch to ${mode}`;
        await app.setMode(mode);
        await assertPlacement(app, mode, when);
        assert.deepStrictEqual(await app.dump(), live, `the chat ${when}`);
        assert.equal(await app.ev(`[...${V}.el.querySelectorAll(".group")].filter((g) => g.querySelectorAll(".acts").length > 1).length`), 0, `groups with two .acts ${when}`);
        const wrong = await app.ev(`(() => {
          const v = ${V};
          const groups = [...v.log.querySelectorAll(":scope > .group")];
          const wrong = groups.filter((g) => {
            const holder = g._body.parentNode;
            return holder.open !== __opened.includes(g) || (holder !== g && g.open);
          }).map((g) => groups.indexOf(g));
          const next = groups.find((g) => !__opened.includes(g));
          if (next) {
            next._body.parentNode.open = true;
            __opened.push(next);
          }
          return wrong;
        })()`);
        assert.deepStrictEqual(wrong, [], `groups whose open state did not follow their body ${when}`);
      }
    },
  },
  {
    // parallel sync subagents merge while their bodies are in the panel: the source and its entry go, the target's
    // entry takes the open state
    name: "merge-in-panel",
    modes: PANEL_MODES,
    scenario: WAIT_SCENARIO,
    async run(app) {
      const mode = await savedMode(app);
      const tests = `[...${V}.log.querySelectorAll(":scope > .group.subagent")].filter((g) => g._body.textContent.includes("Tests: all pass."))`;
      await app.newSession();
      await app.send("Look around.");
      await app.idle();
      await app.send("Run both checks.");
      await app.check(`${tests}.length === 1 && !!${V}.panelBody && ${tests}[0]._entry?.parentNode === ${V}.panelBody`, "the standalone group's entry");
      assert.equal(await app.ev(`(() => {
        window.__from = ${tests}[0];
        __from._entry.querySelector(":scope > summary").click();
        return __from._entry.open && __from.isConnected;
      })()`), true, "the standalone entry open before the merge");
      await app.answerPermission();
      await app.idle();
      const after = await app.ev(`(() => {
        const v = ${V};
        const groups = [...v.log.querySelectorAll(":scope > .group")];
        const g = ${tests};
        return {
          groups: g.length,
          title: g[0]?._info.title,
          entryOpen: !!g[0]?._entry?.open,
          fromGone: !__from.isConnected && !__from._entry.isConnected,
          detached: [...v.panelBody.children].filter((e) => !groups.some((x) => x._entry === e)).length,
        };
      })()`);
      assert.deepStrictEqual(after, { groups: 1, title: "Check the tests", entryOpen: true, fromGone: true, detached: 0 });
      await assertPlacement(app, mode, "after the merge");
    },
  },
  {
    // the mode switches while a subagent streams: its block moves with the body and gets the rest of its text once
    name: "switch-while-streaming",
    modes: ["off"],
    scenario: WAIT_SCENARIO,
    async run(app) {
      await untilHalfway(app);
      await app.ev(`window.__block = ${HALF_BLOCK}`);
      await app.setMode("all");
      assert.deepStrictEqual(
        await app.ev(`({ same: ${HALF_BLOCK} === __block, text: __block._md().trim(), inPanel: ${V}.panelBody.contains(__block) })`),
        { same: true, text: "a.txt has", inPanel: true },
        "the block in the panel while the subagent still streams",
      );
      await app.idle();
      const blocks = await app.ev(`[...${V}.log.querySelectorAll(":scope > .group.subagent")].flatMap((g) => [...g._body.querySelectorAll(".msg.agent")]).filter((b) => b.textContent.includes("a.txt has")).map((b) => ({ same: b === __block, text: b._md().trim() }))`);
      assert.deepStrictEqual(blocks, [{ same: true, text: "a.txt has two lines." }]);
      await assertPlacement(app, "all", "after the turn");
    },
  },
  {
    // the link and path handler works inside the panel: click and middle click
    name: "panel-links",
    modes: ["all"],
    async run(app) {
      await playScenario(app);
      const calls = await app.ev(`(() => {
        const v = ${V};
        const calls = [];
        v.openLink = (href) => calls.push(href);
        const body = v.log.querySelector(":scope > .group.in-panel")._body;
        const a = document.createElement("a");
        a.setAttribute("href", "https://example.com/doc");
        a.addEventListener("click", (e) => e.preventDefault()); // never navigate the page, whatever the app does
        const p = document.createElement("span");
        p.dataset.path = "a.txt";
        body.append(a, p);
        const ev = (type, button) => new MouseEvent(type, { bubbles: true, cancelable: true, button });
        a.dispatchEvent(ev("click", 0));
        a.dispatchEvent(ev("auxclick", 1));
        p.dispatchEvent(ev("click", 0));
        return calls;
      })()`);
      assert.deepStrictEqual(calls, ["https://example.com/doc", "https://example.com/doc", "a.txt"]);
    },
  },
  {
    // "N subagents running" shows the first running subagent's entry
    name: "running-button",
    modes: ["subagents"],
    scenario: WAIT_SCENARIO,
    async run(app) {
      await untilHalfway(app);
      const shown = await app.ev(`(() => {
        const v = ${V};
        const g = ${HALF_BLOCK}.closest(".panel-entry, .group");
        if (v.bgEl.hidden) return "no running button";
        v.bgEl.click();
        const group = [...v.log.querySelectorAll(":scope > .group")].find((x) => x._entry === g);
        return { entry: g.classList.contains("panel-entry"), entryOpen: g.open, groupOpen: group?.open ?? null };
      })()`);
      assert.deepStrictEqual(shown, { entry: true, entryOpen: true, groupOpen: false });
      await app.idle();
    },
  },
  {
    // a following panel stays at its bottom while a subagent streams into an open entry
    name: "panel-follows",
    modes: ["all"],
    scenario: SCROLL_SCENARIO,
    async run(app) {
      await untilSubagent(app);
      await openSubEntry(app);
      let s;
      for (let k = 1; k <= PARTS; k++) {
        await untilPart(app, k);
        s = await assertAtBottom(app, PANEL, `the panel after part ${k}`);
      }
      assert.ok(s.over > 100, `the panel overflows (${s.over} px)`);
      await app.idle();
    },
  },
  {
    // a group shown from the chat stops the panel's follow (its own scroll does not turn it back on); scrolling to
    // the end follows again; opening an entry by its own header stops it too
    name: "panel-stops-after-show",
    modes: ["all"],
    scenario: SCROLL_SCENARIO,
    async run(app) {
      await untilSubagent(app);
      await openSubEntry(app);
      await untilPart(app, 4);
      const before = await assertAtBottom(app, PANEL, "the panel after part 4");
      assert.ok(before.over > 0, `the panel overflows after part 4 (${before.over} px)`);
      const top = await app.ev(`(() => { ${FIRST_GROUP}.querySelector(":scope > summary").click(); return ${PANEL}.scrollTop; })()`);
      assert.ok(top < before.top, "the shown entry scrolled into view");
      for (const k of [5, 6]) {
        await untilPart(app, k);
        assert.deepStrictEqual(await app.ev(`({ top: ${PANEL}.scrollTop, follow: ${V}.panelFollow })`), { top, follow: false }, `the panel after part ${k}`);
      }
      await scrollTo(app, PANEL, `${PANEL}.scrollHeight`);
      await untilPart(app, 7);
      await assertAtBottom(app, PANEL, "the panel after part 7, scrolled to its end");
      // the work entry's own header: a click closes it, the next one opens it
      await app.ev(`${FIRST_GROUP}._entry.querySelector(":scope > summary").click()`);
      await frames(app);
      const opened = await app.ev(`(() => { ${FIRST_GROUP}._entry.querySelector(":scope > summary").click(); return { top: ${PANEL}.scrollTop, open: ${FIRST_GROUP}._entry.open }; })()`);
      assert.equal(opened.open, true, "the entry opened by its header");
      await untilPart(app, 9);
      assert.deepStrictEqual(await app.ev(`({ top: ${PANEL}.scrollTop, follow: ${V}.panelFollow })`), { top: opened.top, follow: false }, "the panel after part 9");
      await app.idle();
    },
  },
  {
    // a following log keeps its bottom when the panel first shows (the log gets narrower) and through mode switches
    name: "log-keeps-bottom",
    modes: ["subagents"],
    scenario: SCROLL_SCENARIO,
    async run(app) {
      await untilSubagent(app);
      assert.equal(await app.ev(`${V}.panel.hidden`), false, "the panel shows");
      const s = await assertAtBottom(app, LOG, "the log when the first subagent group appears");
      assert.ok(s.over > 100, `the log overflows (${s.over} px)`);
      await app.idle();
      for (const mode of ["off", "subagents"]) {
        await app.setMode(mode);
        await frames(app);
        assert.equal(await app.ev(`${V}.follow`), true, `the log follows after the switch to ${mode}`);
        await assertAtBottom(app, LOG, `the log after the switch to ${mode}`);
      }
      // the panel resized, collapsed and expanded
      const width = await panelWidth(app);
      await dragHandle(app, -60);
      assert.equal(await panelWidth(app), width + 60, "the panel dragged wider");
      for (const [what, act] of [["the drag", () => {}], ["collapsing", () => panelHeadButton(app)], ["expanding", () => activityButton(app)]]) {
        await act();
        await frames(app);
        assert.equal(await app.ev(`${V}.follow`), true, `the log follows after ${what}`);
        await assertAtBottom(app, LOG, `the log after ${what}`);
      }
    },
  },
  {
    // a scrolled-up log stays put while groups are created, a header shows its group and the mode switches
    name: "log-keeps-place",
    modes: ["all"],
    scenario: SCROLL_SCENARIO,
    async run(app) {
      await app.resize(1280, 500);
      await app.newSession();
      await app.send("Explain the files.");
      await app.check(`${LOG}.scrollHeight - ${LOG}.clientHeight > 100`, "the long answer");
      await scrollTo(app, LOG, 0);
      const place = (when) => app.ev(`({ top: ${LOG}.scrollTop, follow: ${V}.follow })`).then((s) => assert.deepStrictEqual(s, { top: 0, follow: false }, `the log ${when}`));
      await place("scrolled to the top");
      await app.check(`!!${SUB_GROUP}`, "the subagent's group");
      await place("when the groups appear");
      await app.ev(`${FIRST_GROUP}.querySelector(":scope > summary").click()`);
      await frames(app);
      await place("after a header showed its group");
      await app.idle();
      await place("after the turn");
      for (const mode of ["subagents", "off", "all"]) {
        await app.setMode(mode);
        await frames(app);
        await place(`after the switch to ${mode}`);
      }
      await dragHandle(app, -60);
      await place("after the panel was dragged wider");
      await panelHeadButton(app);
      assert.equal(await panelWidth(app), 0, "the panel collapsed");
      await place("after the panel collapsed");
      await activityButton(app);
      await place("after the panel expanded");
    },
  },
  {
    // the handle's drag sets the width in real pixels, clamped to [280, row − 480] at every chat scale; every view
    // has it, and it is kept after a relaunch (a window 1600 wide: the row is 1300, the maximum 820)
    name: "panel-width",
    modes: ["all"],
    async run(app) {
      await app.resize(1600, 800);
      await firstTurn(app);
      assert.equal(await app.ev(`${V}.row.clientWidth`), 1300, "the row of a window 1600 wide");
      assert.equal(await panelWidth(app), 420, "the default width");
      await dragHandle(app, -100);
      assert.equal(await panelWidth(app), 520, "dragged 100 px left");
      for (const scale of [1, 0.7, 2]) {
        await app.ev(`(() => { ui.chatScale = ${scale}; applyChatScale(); })()`);
        await frames(app);
        await dragHandle(app, -2000);
        assert.equal(await panelWidth(app), 1300 - 480, `dragged far left at chat scale ${scale}`);
        await dragHandle(app, 2000);
        assert.equal(await panelWidth(app), 280, `dragged far right at chat scale ${scale}`);
      }
      await app.ev(`(() => { ui.chatScale = 1; applyChatScale(); })()`);
      await dragHandle(app, -220);
      assert.equal(await panelWidth(app), 500, "dragged back to 500");
      const { v } = await secondView(app);
      assert.equal(await panelWidth(app, v), 500, "the second view's width");
      await activate(app, "scripted-work");
      assert.equal(await panelWidth(app), 500, "the first view shown again");
      const again = await relaunch(app, 1600);
      try {
        assert.equal(await again.ev("ui.panelWidth"), 500, "the stored width after a relaunch");
        assert.equal(await panelWidth(again), 500, "the width after a relaunch");
      } finally {
        await again.close();
      }
    },
  },
  {
    // the panel head's button collapses the panel in every view, kept after a relaunch; "Activity" and a header
    // click in the chat bring it back
    name: "panel-collapse",
    modes: ["all"],
    async run(app) {
      await firstTurn(app);
      const { id, v } = await secondView(app);
      await activate(app, "scripted-work");
      assert.equal(await panelWidth(app), 420, "the panel shows");
      await panelHeadButton(app);
      assert.equal(await panelWidth(app), 0, "collapsed by its head's button");
      assert.equal(await app.ev(`${V}.log.offsetWidth === ${V}.row.clientWidth`), true, "the log takes the row");
      assert.equal(await app.ev(`${V}.panel.hidden`), false, "panel.hidden: the view still has entries");
      await activate(app, id);
      assert.equal(await panelWidth(app, v), 0, "collapsed in the second view");
      await activate(app, "scripted-work");
      const again = await relaunch(app);
      try {
        assert.equal(await panelWidth(again), 0, "still collapsed after a relaunch");
        await activityButton(again);
        assert.equal(await panelWidth(again), 420, "Activity brings it back");
        assert.equal(await again.ev("ui.panelCollapsed"), false, "stored: not collapsed");
        await panelHeadButton(again);
        assert.equal(await panelWidth(again), 0, "collapsed again");
        await headerClick(again);
        assert.equal(await panelWidth(again), 420, "a header click in the chat brings it back");
        assert.equal(await again.ev(`${V}.log.querySelector(":scope > .group.in-panel")._entry.open`), true, "its entry open");
      } finally {
        await again.close();
      }
    },
  },
  {
    // a view below 760 px (window 900: view 600): the panel is a drawer over the log, closed until shown; crossing
    // between the layouts writes nothing and opens nothing
    name: "drawer",
    modes: ["all"],
    async run(app) {
      await app.resize(900, 800);
      await firstTurn(app);
      const closed = await drawerState(app);
      assert.deepStrictEqual(closed, { narrow: true, shown: false, hidden: false, logWidth: 600, rowWidth: 600 }, "the narrow layout, drawer closed");
      assert.equal(await shown(app, `${V}.activityBtn`), true, "the Activity button shows");
      await headerClick(app);
      const open = await drawerState(app);
      assert.deepStrictEqual(open, { ...closed, shown: true }, "a header click opens the drawer, the log keeps its width");
      const over = await app.ev(`(() => {
        const v = ${V}, p = v.panel.getBoundingClientRect(), r = v.row.getBoundingClientRect();
        return { position: getComputedStyle(v.panel).position, right: p.right === r.right, top: p.top === r.top, bottom: p.bottom === r.bottom, width: Math.round(p.width) };
      })()`);
      assert.deepStrictEqual(over, { position: "absolute", right: true, top: true, bottom: true, width: 420 }, "the drawer over the log's right side");
      await panelHeadButton(app);
      assert.deepStrictEqual(await drawerState(app), closed, "its button closes it");
      await activityButton(app);
      assert.deepStrictEqual(await drawerState(app), open, "Activity opens it");
      await activityButton(app);
      assert.deepStrictEqual(await drawerState(app), closed, "Activity closes it");
      // crossing to the wide layout and back
      const stored = await storedUi(app);
      await app.resize(1280, 800);
      await frames(app);
      assert.equal(await panelWidth(app), 420, "the wide layout shows the panel");
      await app.resize(900, 800);
      await frames(app);
      assert.deepStrictEqual(await drawerState(app), closed, "back in the narrow layout: the drawer stays closed");
      assert.equal(await storedUi(app), stored, "nothing stored by the crossing");
      // collapsed in the wide layout: the narrow one does not open the drawer, the wide one keeps it collapsed
      await app.resize(1280, 800);
      await frames(app);
      await panelHeadButton(app);
      assert.equal(await panelWidth(app), 0, "collapsed");
      const collapsed = await storedUi(app);
      await app.resize(900, 800);
      await frames(app);
      assert.deepStrictEqual(await drawerState(app), closed, "collapsed, then narrow: the drawer closed");
      await app.resize(1280, 800);
      await frames(app);
      assert.equal(await panelWidth(app), 0, "wide again: still collapsed");
      assert.equal(await storedUi(app), collapsed, "nothing stored by the crossings");
    },
  },
  {
    // Esc with the drawer open while a turn runs: inside the drawer it closes the drawer (the turn runs on), in the
    // message box it stops the turn (the drawer stays)
    name: "drawer-esc",
    modes: ["all"],
    scenario: LONG_WAIT_SCENARIO,
    async run(app) {
      await app.resize(900, 800);
      await app.newSession();
      await app.send("Look around.");
      await app.check(`${V}.busy && !!${V}.log.querySelector(":scope > .group.subagent.in-panel")`, "the turn's groups");
      await app.ev(`(() => { const v = ${V}, stop = v.cancel; window.__stops = 0; v.cancel = function () { __stops++; return stop.call(this); }; })()`);
      const esc = (target) => app.ev(`(() => { const t = ${target}; t.focus(); t.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })); })()`);
      const state = () => app.ev(`({ open: ${V}.panel.checkVisibility(), busy: ${V}.busy, stops: __stops })`);
      await headerClick(app);
      assert.deepStrictEqual(await state(), { open: true, busy: true, stops: 0 }, "the drawer open while the turn runs");
      await esc(`${V}.panel.querySelector(".panel-entry > summary")`);
      await frames(app);
      assert.deepStrictEqual(await state(), { open: false, busy: true, stops: 0 }, "Esc inside the drawer closes it, the turn runs on");
      assert.equal(await app.ev(`document.activeElement === ${V}.activityBtn`), true, "the focus back on the Activity button");
      // a double Esc: the second one lands where the focus went, and must not stop the turn
      await esc("document.activeElement");
      await frames(app);
      assert.deepStrictEqual(await state(), { open: false, busy: true, stops: 0 }, "a second Esc after the drawer closed");
      // a held Esc: its repeated keydowns inside the open drawer do nothing
      await activityButton(app);
      await app.ev(`(() => { const t = ${V}.panel.querySelector(".panel-entry > summary"); t.focus(); t.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", repeat: true, bubbles: true, cancelable: true })); })()`);
      await frames(app);
      assert.deepStrictEqual(await state(), { open: true, busy: true, stops: 0 }, "a repeated Esc inside the drawer");
      await esc(`${V}.input`);
      await app.check(`!${V}.busy`, "the turn to stop"); // the scripted agent ends its prompt on session/cancel
      await frames(app);
      assert.deepStrictEqual(await state(), { open: true, busy: false, stops: 1 }, "Esc in the message box stops the turn, the drawer stays");
    },
  },
  {
    // a permission card arriving under an open drawer closes it: the question must be visible
    name: "drawer-permission",
    modes: ["all"],
    async run(app) {
      await app.resize(900, 800);
      await firstTurn(app);
      await headerClick(app);
      assert.equal(await shown(app, `${V}.panel`), true, "the drawer open");
      await app.send("Run both checks.");
      await app.check(`!!${V}.el.querySelector(".perm:not(.done)")`, "a permission card");
      await frames(app);
      assert.equal(await shown(app, `${V}.panel`), false, "the card closed the drawer");
      assert.equal(await shown(app, `${V}.el.querySelector(".perm:not(.done)")`), true, "the card shows");
      await app.answerPermission();
      await app.idle();
      // a delegation card ("New session requested") closes it too (as main would send one: no session is created)
      await headerClick(app);
      assert.equal(await shown(app, `${V}.panel`), true, "the drawer open again");
      await app.ev(`${V}.delegationCard({ requestId: "ui-check", name: "child", task: "A task.", agent: "", model: "", cwd: ${V}.cwd })`);
      await frames(app);
      assert.equal(await shown(app, `${V}.panel`), false, "the delegation card closed the drawer");
      assert.equal(await shown(app, `${V}.el.querySelector(".perm.delegation")`), true, "the delegation card shows");
    },
  },
  {
    // the link and unlink cards (as main would send them: no broker request stands behind them)
    name: "link-card",
    modes: ["off"],
    async run(app) {
      await firstTurn(app);
      await app.ev(`${V}.linkCard({ requestId: "ui-adopt", kind: "adopt", childName: "docs-9f8e7d", childCwd: "/tmp/docs", parentName: "backend-a1b2c3", task: "" })`);
      await frames(app);
      const text = (sel) => app.ev(`${V}.el.querySelector(${JSON.stringify(sel)}).textContent`);
      assert.match(await text(".perm.link"), /Link sessions/);
      assert.match(await text(".perm.link"), /backend-a1b2c3 asks to take docs-9f8e7d as its sub-session\./);
      assert.match(await text(".perm.link"), /Closing backend-a1b2c3 will also close docs-9f8e7d\./);
      // the same id again adds no second card
      await app.ev(`${V}.linkCard({ requestId: "ui-adopt", kind: "adopt", childName: "x", childCwd: "", parentName: "y", task: "" })`);
      assert.equal(await app.ev(`${V}.el.querySelectorAll(".perm.link").length`), 1);
      // the harness runs the app with relay: false, so the session has no relay client and the answer does not
      // arrive (it throws, it is not a 404): the card says so and both buttons come back
      await app.ev(`${V}.el.querySelector(".perm.link button.primary").click()`);
      await app.check(`!!${V}.el.querySelector(".perm.link .opts .err")`, "the answer that did not arrive");
      assert.match(await text(".perm.link .opts"), /Could not answer:.*no longer connected to copilot-relay\./);
      assert.equal(await app.ev(`${V}.el.querySelector(".perm.link").classList.contains("done")`), false, "the card still open");
      assert.deepEqual(await app.ev(`[...${V}.el.querySelectorAll(".perm.link .opts button")].map((b) => b.textContent)`), ["Approve", "Reject"]);
      await app.ev(`${V}.linkCard({ requestId: "ui-release", kind: "release", childName: "docs-9f8e7d", childCwd: "", parentName: "backend-a1b2c3", task: "Update the API reference" })`);
      await frames(app);
      const release = `${V}.el.querySelectorAll(".perm.link")[1].textContent`;
      assert.match(await app.ev(release), /Unlink sessions/);
      assert.match(await app.ev(release), /backend-a1b2c3 asks to release its sub-session docs-9f8e7d\./);
      assert.match(await app.ev(release), /Update the API reference/);
      assert.match(await app.ev(`${V}.el.querySelectorAll(".perm.link")[1].querySelector(".task")?.textContent ?? ""`), /Update the API reference/, "the task sits in .perm.link .task");
      assert.match(await app.ev(release), /becomes a top-level session and keeps its own sub-sessions\./);
    },
  },
  ...[
    ["child-prompt", {}, (own) => `D\n\n${CHILD_PART}\n\n${own}`],
    ["child-prompt-no-child-part", { promptChild: "" }, (own) => `D\n\n${own}`],
  ].map(([name, extra, expected]) => ({
    // create_session through a real broker: the approved child starts with the default part, the child part (unless
    // the setting is empty) and the own part written on the card; its first message carries the reminder
    name,
    modes: ["off"],
    scenario: CHILD_PROMPT_SCENARIO,
    settings: { relay: true, promptDefault: "D", ...extra },
    broker: true,
    async run(app) {
      await app.newSession();
      const work = path.join(app.dir, "work");
      const file = path.join(work, ".scripted-agent.json");
      const saved = () => JSON.parse(readFileSync(file, "utf8"));
      await app.check(`(() => { const v = ${V}; return !!v?.relayName && !v.relayChip.hidden && !v.relayChip.classList.contains("off"); })()`, "the parent to connect to the broker");
      await app.ev(`api.onDelegationRequest((r) => { window.__request = r.requestId; })`);
      await app.send("create_session kid Do-it");
      await app.check(`!!window.__request && !!${V}.el.querySelector(".perm.delegation")`, "the delegation card");
      await app.ev(`api.answerDelegation(window.__request, true, "K")`);
      const CHILD = "scripted-work-2";
      const C = `views.get(${JSON.stringify(CHILD)})`;
      await app.check(`!!${C}`, "the child's view");
      await until(async () => saved().updates.some((u) => JSON.stringify(u).includes("Do-it")), "the child's first message");
      const { starts, updates } = saved();
      assert.equal(starts.length, 2, "the parent's and the child's start");
      assert.deepEqual(starts[1].instructions, [expected("K")]);
      assert.ok(JSON.stringify(updates).includes(REMINDER), "the child's first message carries the reminder");
    },
  })),
  {
    // adopt_session and release_session through a real broker (the driver's: its own port and state files): the
    // agent calls the tool, main carries the card to the window and the answer back, the broker changes the link and
    // tells both sessions. The parent is the driver's session, the child a second one in <app.dir>/child.
    name: "link-e2e",
    modes: ["off"],
    scenario: LINK_SCENARIO,
    settings: { relay: true },
    broker: true,
    async run(app) {
      const PARENT = "scripted-work";
      const CHILD = "scripted-child";
      const C = `views.get(${JSON.stringify(CHILD)})`;
      await app.newSession();
      const childDir = path.join(app.dir, "child");
      mkdirSync(childDir);
      await app.startSession(childDir);
      await app.check(`!!${C} && !${C}.busy`, "the child session");
      await app.ev(`activate(${JSON.stringify(PARENT)})`);
      const connected = (v) => `(() => { const v = ${v}; return !!v?.relayName && !v.relayChip.hidden && !v.relayChip.classList.contains("off"); })()`;
      await app.check(connected(V), "the parent to connect to the broker");
      await app.check(connected(C), "the child to connect to the broker");
      const parentName = await app.ev(`${V}.relayName`);
      const childName = await app.ev(`${C}.relayName`);

      // the broker's own view: a session it lists as online has registered with it
      const online = async (id) => (await (await fetch(`${app.broker.url}/api/peer/list?key=none`)).json()).find((p) => p.key === `cli:${id}`)?.online;
      const linkedOnBroker = async () => (await (await fetch(`${app.broker.url}/api/links`)).json()).links.some((l) => l.key === `cli:${CHILD}` && l.parent === `cli:${PARENT}`);
      const parentOf = () => app.ev(`tree.parentOf.get(${JSON.stringify(CHILD)}) ?? null`);
      const texts = (v, sel) => app.ev(`[...${v}.log.querySelectorAll(${JSON.stringify(sel)})].map((e) => e.textContent)`);
      const childPrompts = () => app.ev(`${C}.log.querySelectorAll(":scope > .msg.user, :scope > .msg.relay").length`);
      const card = (i) => `${V}.el.querySelectorAll(".perm.link")[${i}]`;
      const cardResult = (i) => app.ev(`${card(i)}.querySelector(".opts").textContent`);
      /** Sends the tool's prompt in the parent; the agent's reply (the tool's text) says the user was asked. */
      const ask = async (tool) => {
        const replies = ":scope > .msg.agent > .md"; // the body only: its Markdown is rendered after the element exists
        const before = (await texts(V, replies)).length;
        await app.send(`${tool} ${childName}`);
        await app.check(`!!${V}.log.querySelectorAll(${JSON.stringify(replies)})[${before}]?.textContent.trim()`, `the reply to ${tool}`);
        const reply = (await texts(V, replies))[before];
        assert.match(reply, /^The user was asked to approve it\./, `the reply to ${tool}: ${reply}`);
      };
      /** Waits for link card i to be open (the only open card of the parent), returns its text. */
      const openCard = async (i) => {
        await app.check(`!!${card(i)} && !${card(i)}.classList.contains("done")`, `link card ${i + 1}`);
        await frames(app);
        assert.equal(await app.ev(`${V}.el.querySelectorAll(".perm:not(.done)").length`), 1, "one open card in the parent");
        return app.ev(`${card(i)}.textContent`);
      };
      const click = (i, approve) => app.ev(`${card(i)}.querySelector(${JSON.stringify(approve ? ".opts button.primary" : ".opts button:not(.primary)")}).click()`);
      const answered = async (i) => {
        await app.check(`${card(i)}.classList.contains("done")`, `link card ${i + 1} to be answered`);
        return cardResult(i);
      };
      const notice = (v, sel, text, what) => app.check(`[...${v}.log.querySelectorAll(${JSON.stringify(sel)})].some((e) => e.textContent.includes(${JSON.stringify(text)}))`, what);

      // 1. the request: a card, nothing linked yet
      await ask("adopt_session");
      const adopt = await openCard(0);
      assert.match(adopt, /Link sessions/);
      assert.ok(adopt.includes(childName), adopt);
      assert.equal(await linkedOnBroker(), false, "nothing linked before the answer");

      // 2. approved: linked in the tree and in both views; the child is told without a turn of its own
      const childBefore = await childPrompts();
      await click(0, true);
      assert.equal(await answered(0), "→ Linked");
      await app.check(`tree.parentOf.get(${JSON.stringify(CHILD)}) === ${JSON.stringify(PARENT)}`, "the link in the tree (links:update)");
      assert.equal(await linkedOnBroker(), true, "linked on the broker after the approval");
      await notice(C, ":scope > .msg.system", `The user made this session a child of "${parentName}". "${parentName}" cannot see this chat and waits for your report. When the work you are doing is done, always send it the result (or a short summary, or a note that it is finished) with the report_result tool, exactly once.`, "the child's notice");
      await notice(V, ":scope > .msg.relay", `Session "${childName}" is now your child. It will send you its result with report_result.`, "the parent's notice");
      await app.check(`${C}.parentSessionId === ${JSON.stringify(PARENT)}`, "the child's parentSessionId");
      await frames(app);
      assert.equal(await app.ev(`${C}.busy`), false, "the child started no turn");
      assert.equal(await childPrompts(), childBefore, "no prompt in the child's log");

      // 3. the unlink request
      await app.idle();
      await ask("release_session");
      assert.match(await openCard(1), /Unlink sessions/);

      // 4. rejected: the link stays (checked after the parent's notice, so a links:update would have come)
      await click(1, false);
      assert.equal(await answered(1), "→ Rejected");
      await notice(V, ":scope > .msg.relay", `The user rejected the request to release "${childName}".`, "the parent's notice of the rejection");
      assert.equal(await parentOf(), PARENT, "the child still under the parent");
      assert.equal(await linkedOnBroker(), true, "still linked on the broker after the rejection");

      // 5. asked again and approved: released
      await app.idle();
      await ask("release_session");
      assert.match(await openCard(2), /Unlink sessions/);
      await click(2, true);
      assert.equal(await answered(2), "→ Released");
      await app.check(`tree.parentOf.get(${JSON.stringify(CHILD)}) !== ${JSON.stringify(PARENT)}`, "the link gone from the tree");
      assert.equal(await linkedOnBroker(), false, "unlinked on the broker after the release");
      await app.check(`${C}.parentSessionId === null`, "the child's parentSessionId cleared");
      await notice(C, ":scope > .msg.system", `The user ended the link to "${parentName}". You no longer report to it.`, "the child's notice of the release");

      // 6. the broker restarts while the card is open: its request is gone
      await app.idle();
      await ask("adopt_session");
      await openCard(3);
      await app.broker.restart();
      // the chip alone does not show the gap (it stays "connected" through a short outage: RelayClient logs the lost
      // stream before it clears connected); the new broker lists both sessions once they have registered with it
      await until(async () => (await online(PARENT)) && (await online(CHILD)), "both sessions to register with the restarted broker");
      await app.check(connected(V), "the parent's relay chip connected again");
      await click(3, true);
      assert.equal(await answered(3), "This request is no longer pending.");
      assert.equal(await linkedOnBroker(), false, "nothing linked after the restart");

      // 7. the child closes while the card is open: the broker refuses at approval
      await app.idle();
      await app.check(connected(V), "the parent connected");
      await ask("adopt_session");
      await openCard(4);
      await app.ev(`closeView(${JSON.stringify(CHILD)})`);
      await app.check(`!views.has(${JSON.stringify(CHILD)})`, "the child's view to close");
      await until(async () => (await online(CHILD)) === false, "the broker to see the child offline");
      await click(4, true);
      assert.equal(await answered(4), `Session "${childName}" is closed now. Open it and ask again.`);
      assert.equal(await linkedOnBroker(), false, "nothing linked after the refusal");
    },
  },
  {
    // replies of a child to its parent wait for the user (held): through a real broker the child's send_message and
    // report_result arrive marked fromChild, the parent's view holds them (no turn), approving queues one, the
    // broker's count follows the acknowledgements, a reopened view shows what is still unacknowledged, and the
    // discard acknowledges. The parent is the driver's session, the child a second one in <app.dir>/child.
    name: "held-e2e",
    modes: ["off"],
    scenario: LINK_SCENARIO,
    settings: { relay: true },
    broker: true,
    async run(app) {
      const PARENT = "scripted-work";
      const CHILD = "scripted-child";
      const C = `views.get(${JSON.stringify(CHILD)})`;
      await app.newSession();
      const childDir = path.join(app.dir, "child");
      mkdirSync(childDir);
      await app.startSession(childDir);
      await app.check(`!!${C} && !${C}.busy`, "the child session");
      await app.ev(`activate(${JSON.stringify(PARENT)})`);
      const connected = (v) => `(() => { const v = ${v}; return !!v?.relayName && !v.relayChip.hidden && !v.relayChip.classList.contains("off"); })()`;
      await app.check(connected(V), "the parent to connect to the broker");
      await app.check(connected(C), "the child to connect to the broker");
      const parentName = await app.ev(`${V}.relayName`);
      const childName = await app.ev(`${C}.relayName`);
      const heldOnBroker = async () => (await (await fetch(`${app.broker.url}/api/links`)).json()).held?.[`cli:${PARENT}`] ?? 0;
      const rows = () => app.ev(`${V}.el.querySelectorAll(".held-row").length`);
      const rowTexts = () => app.ev(`[...${V}.el.querySelectorAll(".held-row .held-text")].map((e) => e.textContent.trim())`);
      /** Types into the child's message box and presses Enter (the driver's send is for its own session). */
      const sendInChild = async (text) => {
        const mine = `${C}.log.querySelectorAll(":scope > .msg.user").length`;
        const before = await app.ev(mine);
        await app.ev(`(() => { const v = ${C}; v.input.value = ${JSON.stringify(text)}; v.input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })); })()`);
        await app.check(`${mine} > ${before}`, "the child's message to be sent");
      };
      const parentTurns = () => app.ev(`${V}.log.querySelectorAll(":scope > .msg.user, :scope > .msg.relay").length`);

      // link them: the parent asks for adopt_session, the card is approved
      await app.send(`adopt_session ${childName}`);
      await app.check(`!!${V}.el.querySelector(".perm.link:not(.done)")`, "the link card");
      await app.ev(`${V}.el.querySelector(".perm.link .opts button.primary").click()`);
      await app.check(`${C}.parentSessionId === ${JSON.stringify(PARENT)}`, "the child's parent");
      await app.idle();
      const turns = await parentTurns();

      // 1. send_message from the child: held, no turn in the parent
      await sendInChild(`send_message ${parentName} hello parent`);
      await app.check(`${V}.el.querySelectorAll(".held-row").length === 1`, "one held row in the parent");
      assert.deepEqual(await rowTexts(), ["hello parent"]);
      await until(async () => (await heldOnBroker()) === 1, "the broker to count 1 held reply");
      await frames(app);
      assert.equal(await app.ev(`${V}.busy`), false, "no turn in the parent");
      assert.equal(await parentTurns(), turns, "nothing added to the parent's log");

      // 2. report_result: a second row, oldest on top
      await app.check(`!${C}.busy`, "the child's turn to end");
      await sendInChild("report_result done");
      await app.check(`${V}.el.querySelectorAll(".held-row").length === 2`, "two held rows");
      assert.match((await rowTexts())[0], /^hello parent$/);
      assert.match((await rowTexts())[1], /done/);
      await until(async () => (await heldOnBroker()) === 2, "the broker to count 2 held replies");

      // 3. approve the top row: a parent turn starts and the broker's count drops to 1
      await app.ev(`${V}.el.querySelector(".held-row .held-approve").click()`);
      await app.check(`${V}.log.querySelectorAll(":scope > .msg.user, :scope > .msg.relay").length > ${turns}`, "a turn from the approved reply");
      await app.idle();
      await until(async () => (await heldOnBroker()) === 1, "the broker to count 1 held reply after the approval");
      assert.equal(await rows(), 1, "one row left");

      // 4. the view reopened: the unacknowledged reply is there again
      await app.reload();
      await app.check(`${V}.el.querySelectorAll(".held-row").length === 1`, "the held row after the reopen");
      assert.match((await rowTexts())[0], /done/);

      // 5. discard acknowledges
      await app.ev(`${V}.el.querySelector(".held-row .held-discard").click()`);
      await app.check(`${V}.el.querySelectorAll(".held-row").length === 0`, "the row to go");
      await until(async () => (await heldOnBroker()) === 0, "the broker to count 0 held replies after the discard");
    },
  },
  {
    // a size change alone (nothing appended): a following log, and a following panel with an open entry, keep their
    // bottoms when the window gets narrower (the log's text reflows) and lower
    name: "resize-keeps-bottom",
    scenario: SCROLL_SCENARIO,
    async run(app) {
      const panel = (await savedMode(app)) !== "off";
      await untilSubagent(app);
      await app.idle();
      if (panel) await followingPanel(app);
      assert.equal(await app.ev(`${V}.follow`), true, "the log follows");
      assert.ok((await assertAtBottom(app, LOG, "the log before the resize")).over > 100, "the log overflows");
      if (panel) assert.ok((await assertAtBottom(app, PANEL, "the panel before the resize")).over > 100, "the panel overflows");
      await app.resize(1000, 500);
      await frames(app);
      await assertAtBottom(app, LOG, "the log in a narrower window");
      await app.resize(1000, 400);
      await frames(app);
      await assertAtBottom(app, LOG, "the log in a lower window");
      if (panel) await assertAtBottom(app, PANEL, "the panel in a lower window");
    },
  },
  {
    // the view streams while another view is active: shown again, its following log and panel are at their bottoms
    name: "switch-keeps-bottom",
    scenario: SCROLL_SCENARIO,
    async run(app) {
      const panel = (await savedMode(app)) !== "off";
      await app.resize(1280, 500);
      await app.newSession();
      await app.startSession(app.dir); // a second session, in the launch's folder
      const other = await app.ev(`[...views.keys()].find((id) => id !== "scripted-work") ?? null`);
      assert.ok(other, "a second view");
      await app.ev(`activate("scripted-work")`);
      await app.send("Explain the files.");
      await app.check(`!!${SUB_GROUP}`, "the subagent's group");
      if (panel) await followingPanel(app);
      await app.ev(`activate(${JSON.stringify(other)})`);
      await app.idle();
      assert.equal(await app.ev(`${V}.el.classList.contains("active")`), false, "the view streamed while hidden");
      await app.ev(`activate("scripted-work")`);
      await frames(app);
      assert.ok((await assertAtBottom(app, LOG, "the log shown again")).over > 100, "the log overflows");
      if (panel) assert.ok((await assertAtBottom(app, PANEL, "the panel shown again")).over > 100, "the panel overflows");
    },
  },
  {
    // sending and the end of a replay take the log and the panel to their bottoms
    name: "forced-scroll",
    modes: ["all"],
    scenario: SCROLL_SCENARIO,
    async run(app) {
      await untilSubagent(app);
      await app.idle();
      await openSubEntry(app);
      await frames(app);
      assert.ok((await scrollState(app, PANEL)).over > 100, "the panel overflows");
      await scrollTo(app, PANEL, 0);
      await scrollTo(app, LOG, 0);
      await app.send("Again.");
      await assertAtBottom(app, LOG, "the log after sending");
      await assertAtBottom(app, PANEL, "the panel after sending");
      await app.idle();
      await app.reload();
      await frames(app);
      assert.ok((await scrollState(app, LOG)).over > 100, "the replayed log overflows");
      await assertAtBottom(app, LOG, "the log after the replay");
      await assertAtBottom(app, PANEL, "the panel after the replay");
    },
  },
  ...[
    ["replay-ends-at-bottom", PANEL_SCENARIO],
    ["failed-replay-ends-at-bottom", path.join(FIXTURES, "failing-load-scenario.mjs")],
  ].map(([name, scenario]) => ({
    // a long history opened (a replay, nothing scrolls during it): the log, and in a panel mode the panel, end at
    // their bottoms and follow; also when the load fails after the replay (the dead view's error line is the last)
    name,
    scenario,
    async run(app) {
      const panel = (await savedMode(app)) !== "off";
      await app.resize(1280, 500);
      await app.newSession();
      writeFileSync(path.join(app.dir, "work", ".scripted-agent.json"), JSON.stringify({ sessionId: "scripted-work", updates: longHistory(30) }));
      await app.reload();
      await frames(app);
      const failed = scenario !== PANEL_SCENARIO;
      assert.equal(await app.ev(`${V}.dead`), failed, failed ? "the load failed" : "the load succeeded");
      if (failed) assert.equal(await app.ev(`${LOG}.lastElementChild.className`), "msg error", "the error line is the last");
      assert.deepStrictEqual(await app.ev(`({ follow: ${V}.follow, panelFollow: ${V}.panelFollow })`), { follow: true, panelFollow: true }, "both follow");
      assert.ok((await assertAtBottom(app, LOG, "the log after the replay")).over > 100, "the log overflows");
      if (panel) assert.ok((await assertAtBottom(app, PANEL, "the panel after the replay")).over > 100, "the panel overflows");
    },
  })),
  {
    // editing the second message dims the panel entries of the groups after it, as the log dims those groups; a
    // group created meanwhile is dimmed, a mode switch keeps the rule, cancelling the edit undims everything
    name: "edit-dim",
    modes: ["all"],
    scenario: path.join(FIXTURES, "late-group-scenario.mjs"),
    async run(app) {
      const groups = `${V}.log.querySelectorAll(":scope > .group").length`;
      await playScenario(app);
      await stubEditCount(app);
      assert.deepStrictEqual((await dimState(app)).errors, [], "before the edit");
      const before = await app.ev(groups);
      await app.ev(`${V}.log.querySelectorAll(":scope > .msg.user")[1]._editAct.click()`);
      await app.check(`!!${V}.edit`, "the edit to start");
      await frames(app);
      const editing = await dimState(app);
      assert.deepStrictEqual(editing.errors, [], "editing the second message");
      assert.ok(editing.dimmed > 0 && editing.clear > 0, `entries dimmed and not (${editing.dimmed}, ${editing.clear})`);
      assert.equal(await app.ev(groups), before, "the late group not there yet");
      await app.check(`${groups} > ${before}`, "the late group");
      await frames(app);
      assert.deepStrictEqual((await dimState(app)).errors, [], "after a group was created during the edit");
      assert.equal(await app.ev(`[...${V}.log.querySelectorAll(":scope > .group")].find((g) => g._body.textContent.includes(${JSON.stringify(LATE_TEXT)}))._entry.classList.contains("dim")`), true, "the late group's entry dimmed");
      for (const mode of ["subagents", "off", "all"]) {
        await app.setMode(mode);
        await frames(app);
        assert.equal(await app.ev(`!!${V}.edit`), true, `still editing after the switch to ${mode}`);
        assert.deepStrictEqual((await dimState(app)).errors, [], `after the switch to ${mode}`);
      }
      await app.ev(`${V}.editBar.querySelector("button").click()`);
      await frames(app);
      assert.equal(await app.ev(`!!${V}.edit`), false, "the edit cancelled");
      const cancelled = await dimState(app);
      assert.deepStrictEqual([cancelled.errors, cancelled.dimmed], [[], 0], "after the cancel: no entry dimmed");
    },
  },
  {
    // the agent process killed while a subagent runs: no ● left in the chat or the panel, a mode switch on the dead
    // view keeps the placement, resuming builds the view and its panel again from the replay
    name: "dead-view",
    modes: ["all"],
    scenario: WAIT_SCENARIO,
    async run(app) {
      await untilHalfway(app);
      assert.ok(await app.ev(`!!${V}.panelBody.querySelector(".mark.running")`), "a ● entry in the panel");
      const pids = agentPids(app);
      assert.equal(pids.length, 1, "one agent process for the session");
      process.kill(pids[0], "SIGKILL");
      await app.check(`${V}.dead`, "the view to be dead");
      await frames(app);
      assert.deepStrictEqual(
        await app.ev(`({ chat: ${V}.log.querySelectorAll(".mark.running").length, panel: ${V}.panelBody.querySelectorAll(".mark.running").length, bg: ${V}.bgEl.hidden })`),
        { chat: 0, panel: 0, bg: true },
        "no ● in the dead view",
      );
      await assertPlacement(app, "all", "in the dead view");
      await app.setMode("subagents");
      await assertPlacement(app, "subagents", "after a switch on the dead view");
      await app.setMode("all");
      await assertPlacement(app, "all", "after a switch back on the dead view");
      await app.ev(`window.__dead = ${V}`);
      await app.ev(`openSession({ sessionId: "scripted-work", cwd: ${JSON.stringify(path.join(app.dir, "work"))} })`, "the session to resume");
      await app.idle();
      assert.equal(await app.ev(`${V} !== __dead && !${V}.dead && !__dead.el.isConnected`), true, "a new view");
      assert.ok(await app.ev(`${V}.panelBody.childElementCount`) > 0, "the new view's panel has entries");
      await assertPlacement(app, "all", "after resuming");
    },
  },
  {
    // Stop while a sync subagent streams: the group's header in the chat and its entry in the panel show the marks
    // of mode off
    name: "stop-marks",
    scenario: WAIT_SCENARIO,
    async run(app) {
      const mode = await savedMode(app);
      await untilHalfway(app);
      await app.ev(`${V}.stopBtn.click()`);
      await app.idle();
      const marks = await groupMarks(app);
      assert.deepStrictEqual(marks.map(({ kind, chat }) => ({ kind, chat })), STOP_MARKS, "the marks in the chat");
      for (const m of marks) if (m.entry !== null) assert.equal(m.entry, m.chat, `the ${m.kind} entry's mark`);
      await assertPlacement(app, mode, "after the Stop");
    },
  },
  {
    // the mode switched while another view is active: shown again, the view has its groups where the new mode says
    // and its following log and panel at their bottoms
    name: "inactive-view",
    modes: ["all"],
    scenario: SCROLL_SCENARIO,
    async run(app) {
      await app.resize(1280, 500);
      await app.newSession();
      await app.startSession(app.dir); // a second session, in the launch's folder
      const other = await app.ev(`[...views.keys()].find((id) => id !== "scripted-work") ?? null`);
      assert.ok(other, "a second view");
      await activate(app, "scripted-work");
      await app.send("Explain the files.");
      await app.idle();
      await followingPanel(app);
      for (const mode of ["subagents", "off", "all"]) {
        await activate(app, other);
        await app.setMode(mode);
        assert.equal(await app.ev(`${V}.el.classList.contains("active")`), false, `the view hidden while the mode switched to ${mode}`);
        await activate(app, "scripted-work");
        await assertPlacement(app, mode, `shown again after the switch to ${mode}`);
        assert.equal(await app.ev(`${V}.follow`), true, `the log follows after the switch to ${mode}`);
        assert.ok((await assertAtBottom(app, LOG, `the log shown again after the switch to ${mode}`)).over > 100, "the log overflows");
        if (mode !== "off") assert.ok((await assertAtBottom(app, PANEL, `the panel shown again after the switch to ${mode}`)).over > 100, "the panel overflows");
      }
    },
  },
  {
    // every turn has exactly one Fork/Delete outside its user message, live and after a replay
    name: "one-acts-per-turn",
    async run(app) {
      await playScenario(app);
      assert.deepStrictEqual(await turnActs(app), { counts: [1, 1, 1], doubles: [] }, "live");
      await app.reload();
      assert.deepStrictEqual(await turnActs(app), { counts: [1, 1, 1], doubles: [] }, "after the replay");
    },
  },
  {
    // a work group whose tools ended in different ways shows a count per outcome, each after the first with its own
    // coloured mark; while a tool runs, and when all ended the same way, one mark and "N tools"; the same after a replay
    name: "split-header",
    scenario: SPLIT_SCENARIO,
    async run(app) {
      const tip = "2 · ✗ 1 · ○ 1 · 1 thought";
      const split = { mark: "✓", cls: "mark completed", text: tip, tip, inner: ["mark failed", "mark quiet"] };
      const plain = { mark: "✓", cls: "mark completed", text: "2 tools", tip: "2 tools", inner: [] };
      const all = (await app.ev(`api.getSettings().then((s) => s.activityPanel)`)) === "all"; // the work groups are in the panel
      const assertHeaders = async (what) => {
        const headers = await workHeaders(app);
        assert.deepStrictEqual(headers.map((h) => h.chat), [split, plain], `the two work groups' headers (${what})`);
        for (const h of headers) assert.deepStrictEqual(h.entry, all ? h.chat : null, `the entry's header (${what})`);
      };
      await app.newSession();
      await app.send("Edit both.");
      await app.check(`${V}.log.querySelector(":scope > .group.work > summary .title")?.textContent.includes(${JSON.stringify(RUNNING_TITLE)})`, "the last tool to run");
      const running = `4 tools · 1 thought · ${RUNNING_TITLE}`;
      assert.deepStrictEqual((await workHeaders(app))[0].chat, { mark: "●", cls: "mark running", text: running, tip: running, inner: [] }, "no split while a tool runs");
      await app.idle();
      await app.send("Check them.");
      await app.idle();
      await assertHeaders("live");
      await app.reload();
      await assertHeaders("after the replay");
    },
  },
  {
    // Settings > Relay broker: the question before a restart, and the run's rows. The repository folder does not
    // exist (or, last, the field is empty), so the run stops at its first step: the button is never clicked with a
    // real folder in the field.
    name: "broker-restart",
    modes: ["off"],
    scenario: LONG_WAIT_SCENARIO,
    settings: { brokerRepo: NO_BROKER_REPO },
    async run(app) {
      const rows = () => app.ev(`[...document.querySelectorAll("#broker-steps li")].map((li) => ({ cls: li.className, text: li.textContent }))`);
      const openSettings = async () => {
        await app.ev(`document.querySelector("#btn-settings").click()`);
        await app.check(`document.querySelector("#settings").open`, "the Settings dialog");
        await app.check(`document.querySelector("#set-broker-repo").value !== ""`, "the repository field");
        // safety: nothing below clicks the button unless the field holds the folder that does not exist
        assert.equal(await app.ev(`document.querySelector("#set-broker-repo").value`), NO_BROKER_REPO, "the repository field");
      };
      await app.newSession();
      await openSettings();
      assert.equal(await app.ev(`document.querySelector("#broker-restart").disabled`), false, "the button enabled");
      assert.deepStrictEqual(await rows(), [], "no steps before a run");
      await app.ev(`document.querySelector("#settings").close()`);
      // a working session: the question comes first, and "no" starts nothing
      await app.send("Look around.");
      await app.check(`${V}.busy`, "the turn to run");
      await openSettings();
      await app.ev(`(() => { window.confirm = (m) => ((window.__q = m), false); document.querySelector("#broker-restart").click(); })()`);
      await app.check(`!!window.__q`, "the question");
      assert.match(await app.ev(`window.__q`), /^1 session is working/, "the question");
      assert.deepStrictEqual(await rows(), [], "no step after No");
      await app.ev(`document.querySelector("#settings").close()`);
      await app.ev(`${V}.cancel()`);
      await app.idle();
      // no turn: no question, the run stops at Check
      await openSettings();
      await app.ev(`(() => { window.__q = null; window.confirm = (m) => ((window.__q = m), false); document.querySelector("#broker-restart").click(); })()`);
      await app.check(`document.querySelectorAll("#broker-steps li").length === 6 && !document.querySelector("#broker-restart").disabled`, "the run to stop");
      assert.equal(await app.ev(`window.__q`), null, "no question without working sessions");
      const stopped = await rows();
      assert.equal(stopped[0].cls, "failed");
      assert.ok(stopped[0].text.includes("Check: Not a copilot-relay folder:"), stopped[0].text);
      assert.deepStrictEqual(stopped.slice(1).map((r) => r.cls), ["pending", "pending", "pending", "pending", "pending"]);
      assert.equal(await app.ev(`document.querySelector("#broker-summary").textContent`), "Stopped at Check. The broker was not restarted.");
      // reopened: the same rows and summary
      await app.ev(`document.querySelector("#settings").close()`);
      await openSettings();
      assert.deepStrictEqual(await rows(), stopped, "the rows after reopening");
      assert.equal(await app.ev(`document.querySelector("#broker-summary").textContent`), "Stopped at Check. The broker was not restarted.");
      // an emptied field is refused by Check: no fallback to the default folder
      const emptied = "Check: Set the copilot-relay repository folder first (an absolute path).";
      await app.ev(`document.querySelector("#set-broker-repo").value = ""`);
      // safety: the only other state in which the button is clicked is an empty field
      assert.equal(await app.ev(`document.querySelector("#set-broker-repo").value`), "", "the emptied repository field");
      await app.ev(`(() => { window.confirm = () => false; document.querySelector("#broker-restart").click(); })()`);
      await app.check(`(() => { const li = document.querySelector("#broker-steps li"); return !!li && li.textContent.includes(${JSON.stringify(emptied)}) && !document.querySelector("#broker-restart").disabled; })()`, "the run on an empty field to stop");
      const refused = await rows();
      assert.equal(refused[0].cls, "failed");
      assert.ok(refused[0].text.includes(emptied), refused[0].text);
      assert.deepStrictEqual(refused.slice(1).map((r) => r.cls), ["pending", "pending", "pending", "pending", "pending"]);
      assert.equal(await app.ev(`document.querySelector("#broker-summary").textContent`), "Stopped at Check. The broker was not restarted.");
    },
  },
  {
    // the agent's first tool call records the session folder's repository (start point, the edited file touched) and
    // api.changesList serves it; the replay of a reopen records nothing: the record keeps its time, and a removed
    // repository stays removed. git runs only in the launch's work folder, isolated and with a test identity.
    name: "changes-records",
    modes: ["off"],
    scenario: CHANGES_SCENARIO,
    async run(app) {
      const work = await changesRepo(app);
      const id = await notesWritten(app, work);
      const list = `api.changesList(${JSON.stringify(id)})`;
      const live = await app.ev(list);
      assert.equal(live.repos.length, 1, "one repository");
      const [repo] = live.repos;
      assert.equal(repo.root, realpathSync(work), "the session folder's repository");
      assert.equal(repo.source, "auto");
      assert.equal(repo.error, null);
      assert.deepStrictEqual(repo.files, [{ path: "notes.txt", state: "?", uncommitted: true, committed: false, touched: true, dirtyAtStart: false }]);
      const opened = (p) => `api.changesOpened(${JSON.stringify(id)}, ${JSON.stringify(p)})`;
      const readme = path.join(repo.root, "README.md");
      assert.deepStrictEqual(live.opened, [], "nothing opened yet");
      assert.match(await app.ev(`${opened(readme)}.then(() => "ok", (e) => e.message)`), /not opened in the preview/, "a path that was not read");
      await app.ev(`api.readFile(${JSON.stringify(work)}, "README.md", { viewingCwd: ${JSON.stringify(work)} })`);
      await app.ev(opened(readme));
      assert.deepStrictEqual((await app.ev(list)).opened, [readme], "the opened file");
      await app.reload();
      assert.deepStrictEqual((await app.ev(list)).opened, [readme], "after the replay");
      await app.ev(`api.changesForgetOpened(${JSON.stringify(id)}, ${JSON.stringify(readme)})`);
      assert.deepStrictEqual((await app.ev(list)).opened, [], "forgotten");
      // removed while the session runs: the agent's next edit there records it again, with a later start point
      await app.ev(`api.changesRemove(${JSON.stringify(id)}, ${JSON.stringify(repo.root)})`);
      await app.send("Write the notes again.");
      await app.idle();
      await app.check(`${list}.then((l) => l.repos[0]?.files.some((f) => f.path === "notes.txt" && f.touched))`, "the repository to come back");
      const back = (await app.ev(list)).repos;
      assert.equal(back.length, 1, "one repository after the second edit");
      assert.ok(back[0].at > repo.at, `a later start point: ${back[0].at} after ${repo.at}`);
      await app.reload();
      const replayed = await app.ev(list);
      assert.equal(replayed.repos.length, 1, "one repository after the replay");
      assert.equal(replayed.repos[0].at, back[0].at, "the start point's time after the replay");
      await app.ev(`api.changesRemove(${JSON.stringify(id)}, ${JSON.stringify(repo.root)})`);
      await app.reload();
      assert.deepStrictEqual((await app.ev(list)).repos, [], "a removed repository after another replay");
    },
  },
  {
    // the Changes button opens the browser on the session's repository: rows with their marks, a file that unfolds to
    // its commits and their git diff; a file link in the chat opens that file alone with its row selected; ⟳ keeps the
    // selection and reads the unfolded files' commits again.
    name: "changes-browser",
    modes: ["off"],
    scenario: CHANGES_SCENARIO,
    async run(app) {
      const work = await changesRepo(app);
      await notesWritten(app, work);
      writeFileSync(path.join(work, "README.md"), "# changed\n"); // stays uncommitted
      writeFileSync(path.join(work, "b.txt"), "b\nc\n");
      await gitIn(work, ["add", "b.txt"]);
      await gitIn(work, ["commit", "-q", "-m", "second"]);

      await app.ev(`[...${V}.el.querySelectorAll(".head button")].find((b) => b.textContent === "Changes").click()`);
      await fpListed(app);
      const groups = await fpGroups(app);
      assert.deepStrictEqual(groups.map((g) => g.name), ["work"], "one group named after the session folder");
      assert.deepStrictEqual(groups[0].rows.map(({ state, flags, path: p }) => ({ state, flags, path: p })), [
        { state: "M", flags: "", path: "README.md" },
        { state: "M", flags: "✓", path: "b.txt" },
        { state: "?", flags: "●", path: "notes.txt" },
      ]);

      await fpSelect(app, "README.md");
      assert.equal(await app.ev(`${fpArrow("README.md")}.textContent`), "", "README.md has no commits: no arrow");
      assert.equal(await app.ev(`${fpRow("README.md")}.classList.contains("active")`), true, "README.md's row selected");
      assert.ok((await fpDiffTypes(app)).includes("del") && (await fpDiffTypes(app)).includes("add"), "README.md's diff has a removed and an added line");
      // selected as Ctrl+A does: each line's sign stays on that line in the copied text
      const copied = await app.ev(`(() => { getSelection().selectAllChildren(${FP}.querySelector(".fp-diff .dv")); const t = getSelection().toString(); getSelection().removeAllRanges(); return t; })()`);
      assert.ok(copied.includes("-# work") && copied.includes("+# changed"), `README.md's copied diff: ${JSON.stringify(copied)}`);

      // b.txt has only a commit: its row shows no uncommitted change and does not unfold by itself
      assert.equal(await app.ev(`${fpArrow("b.txt")}.textContent`), "▸", "b.txt's arrow");
      await fpSelect(app, "b.txt");
      assert.equal(await app.ev(`${FP}.querySelector(".fp-diff .fp-msg")?.textContent`), "No changes.", "b.txt's uncommitted version");
      assert.equal(await app.ev(`${FP}.querySelectorAll(".fp-commit").length`), 0, "no commit rows before the arrow is used");

      await app.ev(`${fpArrow("b.txt")}.click()`);
      await app.check(`!!${fpCommitsOf("b.txt")}?.querySelector(".fp-commit")`, "b.txt's commits");
      const commits = await fpCommits(app, "b.txt");
      assert.equal(commits.length, 1, "b.txt has one commit");
      assert.match(commits[0].label, /^[0-9a-f]{7} second$/, "b.txt's commit");
      assert.equal(commits[0].active, false, "the commit is not selected by the unfold");
      assert.equal(await app.ev(`${fpRow("b.txt")}.classList.contains("active")`), true, "b.txt's row stays selected");
      const indent = await app.ev(`(() => {
        const text = document.createRange();
        text.selectNodeContents(${fpCommitsOf("b.txt")}.querySelector(".fp-commit"));
        return { commit: text.getBoundingClientRect().left, name: ${fpRow("b.txt")}.querySelector(".fp-file").getBoundingClientRect().left };
      })()`);
      assert.ok(indent.commit >= indent.name, `the commit starts under its file's name: ${JSON.stringify(indent)}`);

      await app.ev(`${fpCommitsOf("b.txt")}.querySelector(".fp-commit").click()`);
      await app.check(`!!${FP}.querySelector(".fp-diff .dv")`, "b.txt's commit diff");
      assert.equal((await fpCommits(app, "b.txt"))[0].active, true, "the commit selected");
      assert.deepStrictEqual(
        await app.ev(`[${fpRow("b.txt")}.classList.contains("current"), ${fpRow("b.txt")}.classList.contains("active")]`),
        [true, false],
        "b.txt's row carries the weaker mark",
      );
      assert.ok((await fpDiffTypes(app)).includes("add"), "b.txt's commit diff has an added line");

      await fpSelect(app, "notes.txt");
      const types = await fpDiffTypes(app);
      assert.ok(types.length > 0 && types.every((t) => t === "add"), `notes.txt is all added: ${types}`);

      await app.ev(`document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }))`);
      await app.check(`${FP}.hidden`, "the browser to close");
      await app.ev(`${V}.log.querySelector('.diff-path[data-path="notes.txt"]').click()`);
      await app.check(`!${FP}.hidden && ${FP}.querySelector(".fp-content").textContent.includes("hello")`, "notes.txt alone");
      await fpListed(app);
      await app.check(`${fpRow("notes.txt")}.classList.contains("active")`, "notes.txt's row selected");
      assert.equal(await app.ev(`${FP}.querySelector(".fp-diff").hidden`), true, "no diff pane for a file link");
      assert.equal(await app.ev(`${FP}.querySelector(".fp-view button.active")?.dataset.view`), "file", "File for a file link");
      assert.equal(await app.ev(`${FP}.querySelector(".fp-content").hidden`), false, "the file's content");

      // b.txt stays unfolded (the fold state is kept per session) and its commits were read again with the list
      await app.check(`!!${fpCommitsOf("b.txt")}?.querySelector(".fp-commit")`, "b.txt's commits after the link");
      await app.ev(`${fpCommitsOf("b.txt")}.querySelector(".fp-commit").click()`);
      await app.check(`${fpCommitsOf("b.txt")}.querySelector(".fp-commit").classList.contains("active") && !!${FP}.querySelector(".fp-diff .dv")`, "b.txt's commit selected");
      await gitIn(work, ["add", "-A"]);
      await gitIn(work, ["commit", "-q", "-m", "third"]);
      const loader = await app.ev(`(() => { ${FP}.querySelector('[data-act="refresh"]').click(); return !${FP}.querySelector(".fp-loading").hidden; })()`);
      assert.equal(loader, true, "the loader while the list is read");
      await fpListed(app);
      const after = (await fpGroups(app))[0].rows;
      assert.equal(after.find((r) => r.path === "README.md").flags, "✓", "README.md committed");
      assert.equal(await app.ev(`${fpArrow("README.md")}.textContent`), "▸", "README.md's arrow once it has a commit");
      await app.check(`${fpCommitsOf("b.txt")}?.querySelector(".fp-commit")?.classList.contains("active")`, "b.txt's commit still selected after ⟳");
      assert.deepStrictEqual(after.filter((r) => r.active).map((r) => r.path), [], "no file row is the selection after ⟳");

      // an unfold whose answer comes for the list a ⟳ replaces: once the list settles, the commits of the new list
      await app.ev(`(() => { ${fpArrow("README.md")}.click(); ${FP}.querySelector('[data-act="refresh"]').click(); })()`);
      await fpListed(app);
      await app.check(`!!${fpCommitsOf("README.md")}?.querySelector(".fp-commit, .fp-note.err")`, "README.md's commits");
      const readme = await fpCommits(app, "README.md");
      assert.equal(readme.length, 1, `README.md has one commit: ${JSON.stringify(readme)}`);
      assert.ok(readme[0].label.endsWith(" third"), `README.md's commit: ${readme[0].label}`);
      assert.equal(await app.ev(`${FP}.querySelectorAll(".fp-items .fp-note.err").length`), 0, "no error in the list");
    },
  },
  {
    // Diff, File and Both choose the panes, kept with the divider's ratio for the next opening; a commit shows its
    // diff and a file without a diff (a link) the file, for that showing only; a change on disk reads the file and its
    // uncommitted diff again in place, without reading the list again
    name: "changes-split",
    modes: ["off"],
    scenario: CHANGES_SCENARIO,
    async run(app) {
      const work = await changesRepo(app);
      await notesWritten(app, work);
      writeFileSync(path.join(work, "README.md"), "# changed\n"); // stays uncommitted
      writeFileSync(path.join(work, "b.txt"), "b\ncommitted\n"); // committed, no uncommitted change
      await gitIn(work, ["add", "b.txt"]);
      await gitIn(work, ["commit", "-q", "-m", "second"]);
      const openBrowser = async () => {
        await app.ev(`[...${V}.el.querySelectorAll(".head button")].find((b) => b.textContent === "Changes").click()`);
        await fpListed(app);
      };
      const closeBrowser = async () => {
        await app.ev(`document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }))`);
        await app.check(`${FP}.hidden`, "the browser to close");
      };
      const viewBtn = (v) => `${FP}.querySelector('.fp-view button[data-view="${v}"]')`;
      const active = () => app.ev(`[...${FP}.querySelectorAll(".fp-view button.active")].map((b) => b.dataset.view).join()`);
      const stored = () => app.ev(`JSON.parse(localStorage.getItem("copilot-sessions.changes.v1"))`);
      const panes = (a = app) => a.ev(`(() => {
        const w = (s) => { const e = ${FP}.querySelector(s); return e.checkVisibility() ? e.getBoundingClientRect() : null; };
        const d = w(".fp-diff"), c = w(".fp-content"), p = w(".fp-panes");
        return { diff: d?.width ?? 0, content: c?.width ?? 0, beside: !!(d && c && c.left >= d.right), ratio: d ? d.width / p.width : 0 };
      })()`);
      const contentShows = (text) => app.check(`${FP}.querySelector(".fp-content").textContent.includes(${JSON.stringify(text)})`, `the file pane to show ${text}`);

      await openBrowser();
      await fpSelect(app, "README.md");
      assert.deepStrictEqual(await app.ev(`[...${FP}.querySelectorAll(".fp-view button")].map((b) => b.textContent)`), ["Diff", "File", "Both"]);
      assert.equal(await active(), "diff", "Diff on the first opening");
      assert.equal((await panes()).content, 0, "no file pane in Diff");

      await app.ev(`${viewBtn("both")}.click()`);
      await contentShows("changed");
      const split = await panes();
      assert.ok(split.beside && split.diff > 100 && split.content > 100, `Both: the file beside its diff: ${JSON.stringify(split)}`);
      assert.equal(await active(), "both");

      await app.ev(`(() => {
        const s = ${FP}.querySelector(".fp-split"), r = s.getBoundingClientRect();
        const x = r.left + r.width / 2, y = r.top + r.height / 2;
        const ev = (type, clientX) => new PointerEvent(type, { bubbles: true, cancelable: true, pointerId: 1, isPrimary: true, pointerType: "mouse", button: 0, buttons: type === "pointerup" ? 0 : 1, clientX, clientY: y });
        s.dispatchEvent(ev("pointerdown", x));
        document.elementFromPoint(x - 100, y)?.dispatchEvent(ev("pointermove", x - 100));
        document.body.dispatchEvent(ev("pointermove", x - 200));
        document.body.dispatchEvent(ev("pointerup", x - 200));
      })()`);
      await frames(app);
      const dragged = await panes();
      assert.ok(Math.abs(split.diff - 200 - dragged.diff) <= 2, `dragged 200 px left: ${split.diff} → ${dragged.diff}`);
      const afterDrag = await stored();
      assert.deepStrictEqual(afterDrag, { view: "both", ratio: afterDrag.ratio }, "stored: the view and the ratio");
      assert.ok(Math.abs(afterDrag.ratio - dragged.ratio) <= 0.01, `stored ratio ${afterDrag.ratio}, dragged ${dragged.ratio}`);

      await closeBrowser();
      await openBrowser();
      await app.check(`${fpRow("README.md")}.classList.contains("active") && !!${FP}.querySelector(".fp-diff .dv")`, "README.md's diff again");
      await contentShows("changed");
      const again = await panes();
      assert.equal(await active(), "both", "Both after reopening");
      assert.ok(again.content > 100, "the file pane after reopening");
      assert.ok(Math.abs(again.ratio - dragged.ratio) <= 0.01, `the ratio after reopening: ${dragged.ratio} → ${again.ratio}`);

      const adds = `${FP}.querySelectorAll(".fp-diff .dv-line.add").length`;
      const addsBefore = await app.ev(adds);
      await app.ev(`window.__fpRows = [...${FP}.querySelectorAll(".fp-row")]`);
      const t0 = Date.now();
      appendFileSync(path.join(work, "README.md"), "appended on disk\n");
      await contentShows("appended on disk");
      await app.check(`${adds} === ${addsBefore + 1}`, "one more added line in the diff");
      assert.ok(Date.now() - t0 < 2000, `followed the disk in ${Date.now() - t0} ms`);
      const sameRows = await app.ev(`(() => { const now = [...${FP}.querySelectorAll(".fp-row")]; return now.length === window.__fpRows.length && now.every((r, i) => r === window.__fpRows[i]); })()`);
      assert.equal(sameRows, true, "the list's rows are the same nodes");

      // Ctrl+A selects the pane that has the focus; with the diff pane hidden, the file pane
      const selectAllIn = (pane) => app.ev(`(() => {
        (${JSON.stringify(pane)} ? ${FP}.querySelector(${JSON.stringify(pane)}) : ${FP}).focus();
        document.dispatchEvent(new KeyboardEvent("keydown", { key: "a", ctrlKey: true, bubbles: true }));
        const s = getSelection(), where = s.rangeCount ? s.getRangeAt(0).commonAncestorContainer : null;
        const r = { content: !!where && ${FP}.querySelector(".fp-content").contains(where), diff: !!where && ${FP}.querySelector(".fp-diff").contains(where) };
        s.removeAllRanges();
        return r;
      })()`);
      assert.deepStrictEqual(await selectAllIn(".fp-content .fp-md"), { content: true, diff: false }, "Ctrl+A in the file pane");
      assert.deepStrictEqual(await selectAllIn(".fp-diff"), { content: false, diff: true }, "Ctrl+A in the diff pane");

      // a file with only committed changes, edited on disk while selected: its uncommitted diff shows without ⟳
      await fpSelect(app, "b.txt");
      assert.equal(await app.ev(`${FP}.querySelector(".fp-diff .fp-msg")?.textContent`), "No changes.", "b.txt before the edit");
      await contentShows("committed"); // read, so watched
      appendFileSync(path.join(work, "b.txt"), "edited on disk\n");
      await contentShows("edited on disk");
      await app.check(`${FP}.querySelectorAll(".fp-diff .dv .dv-line.add").length > 0`, "b.txt's diff after the edit on disk");

      await app.ev(`${viewBtn("file")}.click()`);
      const fileOnly = await panes();
      assert.ok(fileOnly.diff === 0 && fileOnly.content > 100, `File: the file alone ${JSON.stringify(fileOnly)}`);
      await contentShows("edited on disk");
      assert.equal(await active(), "file");
      assert.equal((await stored()).view, "file", "stored: File");
      assert.deepStrictEqual(await selectAllIn(null), { content: true, diff: false }, "Ctrl+A with the diff pane hidden");
      // edited on disk while the diff pane is hidden: git is asked when the pane shows, not the list's older flags
      appendFileSync(path.join(work, "b.txt"), "edited again\n");
      await contentShows("edited again");
      await app.ev(`${viewBtn("diff")}.click()`);
      await app.check(`[...${FP}.querySelectorAll(".fp-diff .dv-line.add")].some((l) => l.textContent.includes("edited again"))`, "b.txt's diff once its pane shows");
      await app.ev(`${viewBtn("file")}.click()`);

      // a commit shows its diff with File stored; the next row shows the stored view again
      await app.ev(`${fpArrow("b.txt")}.click()`);
      await app.check(`!!${fpCommitsOf("b.txt")}?.querySelector(".fp-commit")`, "b.txt's commits");
      await app.ev(`${fpCommitsOf("b.txt")}.querySelector(".fp-commit").click()`);
      await app.check(`${fpCommitsOf("b.txt")}.querySelector(".fp-commit").classList.contains("active") && !!${FP}.querySelector(".fp-diff .dv")`, "b.txt's commit diff");
      assert.equal(await active(), "diff", "Diff for a commit");
      const commitPanes = await panes();
      assert.ok(commitPanes.diff > 100 && commitPanes.content === 0, `the commit's diff alone ${JSON.stringify(commitPanes)}`);
      assert.equal((await stored()).view, "file", "stored: still File");
      await app.ev(`${fpRow("README.md")}.click()`);
      await app.check(`${fpRow("README.md")}.classList.contains("active")`, "README.md's row selected");
      await contentShows("appended on disk");
      assert.equal(await active(), "file", "File again for a changed file");
      assert.equal((await panes()).diff, 0, "no diff pane in File");

      // a file link shows the file alone with Both stored; Both then shows its diff beside it
      await app.ev(`${viewBtn("both")}.click()`);
      await app.check(`!!${FP}.querySelector(".fp-diff .dv")`, "README.md's diff in Both");
      await closeBrowser();
      await app.ev(`${V}.log.querySelector('.diff-path[data-path="notes.txt"]').click()`);
      await contentShows("hello");
      await fpListed(app);
      await app.check(`${fpRow("notes.txt")}.classList.contains("active")`, "notes.txt's row selected");
      assert.equal(await active(), "file", "File for a file link");
      assert.equal((await panes()).diff, 0, "no diff pane for a file link");
      assert.equal((await stored()).view, "both", "stored: still Both");
      await app.ev(`${viewBtn("both")}.click()`);
      await app.check(`!!${FP}.querySelector(".fp-diff .dv")`, "notes.txt's diff");
      const types = await fpDiffTypes(app);
      assert.ok(types.length > 0 && types.every((t) => t === "add"), `notes.txt is all added: ${types}`);
      const linked = await panes();
      assert.ok(linked.beside && Math.abs(linked.ratio - again.ratio) <= 0.01, `the stored split for the linked file: ${JSON.stringify(linked)}`);
      assert.ok(await app.ev(`${FP}.querySelector(".fp-content").textContent.includes("hello")`), "the linked file beside its diff");

      // a file deleted while its row is on show
      await fpSelect(app, "notes.txt");
      await contentShows("hello");
      rmSync(path.join(work, "notes.txt"));
      await contentShows("This file is deleted.");

      // a file deleted while shown alone, then a click on its row and its file: the pane keeps the note
      writeFileSync(path.join(work, "notes.txt"), "hello\n");
      await app.ev(`${V}.log.querySelector('.diff-path[data-path="notes.txt"]').click()`);
      await contentShows("hello");
      await fpListed(app); // read while notes.txt is there
      rmSync(path.join(work, "notes.txt"));
      await app.check(`!${FP}.querySelector(".fp-content").textContent.includes("hello")`, "the file pane to drop notes.txt's text");
      await fpSelect(app, "notes.txt");
      await app.ev(`${viewBtn("diff")}.click()`); // hide, then show again: the pane is painted from cur
      await app.ev(`${viewBtn("both")}.click()`);
      await contentShows("This file is deleted.");

      // an old stored value, read when the page loads again (a relaunch, the same folder): Show file is Both, with its
      // ratio, which is not the dragged one
      await app.ev(`localStorage.setItem("copilot-sessions.changes.v1", '{"showFile":true,"ratio":0.7}')`);
      await app.close({ keep: true });
      const relaunched = await launch({ scenario: CHANGES_SCENARIO, dir: app.dir });
      try {
        await relaunched.ev(`openSession({ sessionId: "scripted-work", cwd: ${JSON.stringify(work)} })`, "the session to reopen");
        await relaunched.check(`(() => { const v = ${V}; return v && !v.busy && !v.resuming; })()`, "the reopened session");
        await relaunched.ev(`[...${V}.el.querySelectorAll(".head button")].find((b) => b.textContent === "Changes").click()`);
        await fpListed(relaunched);
        await relaunched.ev(`${fpRow("README.md")}.click()`);
        await relaunched.check(`${fpRow("README.md")}.classList.contains("active") && !!${FP}.querySelector(".fp-diff .dv")`, "README.md's diff after the relaunch");
        assert.equal(await relaunched.ev(`[...${FP}.querySelectorAll(".fp-view button.active")].map((b) => b.dataset.view).join()`), "both", "Both from the old Show file");
        const old = await panes(relaunched);
        assert.ok(Math.abs(old.ratio - 0.7) <= 0.01, `the old ratio: ${JSON.stringify(old)}`);
      } finally {
        await relaunched.close();
      }
    },
  },
  {
    // a file opened from a link that the session did not change is listed under Opened files, newest first, until
    // the session changes it or its ✕; its row shows the file as File, read without the confirmation only while it is
    // still the file that was opened
    name: "changes-opened",
    modes: ["off"],
    scenario: CHANGES_SCENARIO,
    async run(app) {
      const work = await changesRepo(app);
      appendFileSync(path.join(work, ".gitignore"), "ig.txt\n");
      await gitIn(work, ["add", ".gitignore"]);
      await gitIn(work, ["commit", "-q", "-m", "ignore"]);
      writeFileSync(path.join(work, "ig.txt"), "ignored\n");
      const id = await notesWritten(app, work);
      writeFileSync(path.join(app.dir, "outside.txt"), "from outside\n");
      const outside = realpathSync(path.join(app.dir, "outside.txt"));
      const real = realpathSync(work);

      const open = (href) => app.ev(`filePreview.open(${V}, ${JSON.stringify(href)})`);
      const openBrowser = async () => {
        await app.ev(`[...${V}.el.querySelectorAll(".head button")].find((b) => b.textContent === "Changes").click()`);
        await fpListed(app);
      };
      const closeBrowser = async () => {
        await app.ev(`document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }))`);
        await app.check(`${FP}.hidden`, "the browser to close");
      };
      const openedRows = () => app.ev(`[...${FP}.querySelectorAll(".fp-opened .fp-row")].map((r) => r.querySelector(".fp-row-path").textContent)`);
      const openedRow = (label) => `[...${FP}.querySelectorAll(".fp-opened .fp-row")].find((r) => r.querySelector(".fp-row-path").textContent === ${JSON.stringify(label)})`;
      const groupRow = (rel) => `[...${FP}.querySelectorAll(".fp-group .fp-row")].find((r) => r.querySelector(".fp-row-path").textContent === ${JSON.stringify(rel)})`;
      const contentShows = (text) => app.check(`${FP}.querySelector(".fp-content").textContent.includes(${JSON.stringify(text)})`, `the file pane to show ${text}`);
      const active = () => app.ev(`[...${FP}.querySelectorAll(".fp-view button.active")].map((b) => b.dataset.view).join()`);
      const stored = () => app.ev(`localStorage.getItem("copilot-sessions.changes.v1")`);
      const confirmShown = `!${FP}.querySelector(".fp-confirm").hidden`;
      const recorded = () => app.ev(`api.changesList(${JSON.stringify(id)}).then((l) => l.opened)`);

      // a file of the repository without changes: listed under Opened files and selected there
      const before = await stored();
      await open("README.md");
      await app.check(`${FP}.querySelector(".fp-content .fp-md h1")?.textContent === "work"`, "README.md rendered");
      await app.check(`${FP}.querySelector(".fp-loading").hidden && !!${openedRow("README.md")}?.classList.contains("active")`, "README.md's opened row selected");
      assert.deepStrictEqual(await openedRows(), ["README.md"], "the opened files after README.md");
      assert.equal(await active(), "file", "File for an opened file");
      assert.equal(await stored(), before, "the stored view unchanged");

      // a file of the changes list: recorded, but selected in its group and not listed under Opened files
      await open("notes.txt");
      await contentShows("hello");
      await app.check(`${FP}.querySelector(".fp-loading").hidden && !!${groupRow("notes.txt")}?.classList.contains("active")`, "notes.txt's row selected in its group");
      assert.deepStrictEqual(await openedRows(), ["README.md"], "notes.txt is not an opened row");
      assert.equal((await recorded())[0], path.join(real, "notes.txt"), "notes.txt recorded first");

      // a file outside the session folder: after the confirmation it is the newest opened row, by its absolute path
      await open(path.join(app.dir, "outside.txt"));
      await app.check(confirmShown, "the confirmation for outside.txt");
      await app.ev(`${FP}.querySelector('[data-act="allow"]').click()`);
      await contentShows("from outside");
      await app.check(`${FP}.querySelector(".fp-loading").hidden && (${openedRow(outside)})?.classList.contains("active") === true`, "outside.txt's opened row selected");
      assert.deepStrictEqual(await openedRows(), [outside, "README.md"], "the opened files, newest first");
      await closeBrowser();
      await openBrowser();
      await app.ev(`${openedRow(outside)}.click()`);
      await contentShows("from outside");
      assert.equal(await app.ev(confirmShown), false, "no confirmation for the file that was opened");

      // Diff on a row without a diff: no changes, and the stored view is Diff
      await app.ev(`${FP}.querySelector('.fp-view button[data-view="diff"]').click()`);
      await app.check(`${FP}.querySelector(".fp-diff .fp-msg")?.textContent === "No changes."`, "No changes. for an opened file");
      assert.equal(JSON.parse(await stored()).view, "diff", "stored: Diff");

      // changed by the session: README.md moves to its group
      writeFileSync(path.join(work, "README.md"), "# changed\n");
      await app.ev(`${FP}.querySelector('[data-act="refresh"]').click()`);
      await app.check(`${FP}.querySelector(".fp-loading").hidden && !!${groupRow("README.md")}`, "README.md in its group");
      assert.deepStrictEqual(await openedRows(), [outside], "README.md is no longer an opened row");

      // deleted: the row says so and stays listed
      await fpSelect(app, "README.md"); // outside.txt is not on show
      rmSync(outside);
      await app.ev(`${openedRow(outside)}.click()`);
      await contentShows("This file is deleted.");
      assert.equal(await active(), "file", "File again for an opened file");
      assert.deepStrictEqual(await openedRows(), [outside], "the deleted file is still listed");

      // ✕ on another opened row: the file on show stays
      await open("b.txt"); // committed, unchanged: an opened row
      await app.check(`${FP}.querySelector(".fp-loading").hidden && !!${openedRow("b.txt")}?.classList.contains("active")`, "b.txt's opened row selected");
      await app.ev(`${openedRow(outside)}.click()`);
      await contentShows("This file is deleted.");
      await app.ev(`${openedRow("b.txt")}.querySelector(".fp-forget").click()`);
      await app.check(`${FP}.querySelector(".fp-loading").hidden && !${openedRow("b.txt")}`, "b.txt's row to go");
      assert.equal(await app.ev(`${openedRow(outside)}.classList.contains("active")`), true, "outside.txt's row still selected");
      await contentShows("This file is deleted.");

      // ✕ takes it off the list, and the file on show from it off show: the first changed file is selected
      await app.ev(`${openedRow(outside)}.querySelector(".fp-forget").click()`);
      await app.check(`${FP}.querySelector(".fp-loading").hidden && !${openedRow(outside)}`, "outside.txt's row to go");
      assert.ok(!(await recorded()).includes(outside), "outside.txt no longer recorded");
      await app.check(`!!${groupRow("README.md")}?.classList.contains("active") && !!${FP}.querySelector(".fp-diff .dv")`, "README.md selected with its diff after the ✕");
      assert.equal(await app.ev(`${FP}.querySelector(".fp-name").textContent`), "README.md", "README.md on show");
      assert.equal(await app.ev(`${FP}.querySelector(".fp-content").textContent.includes("This file is deleted.")`), false, "outside.txt's note is gone");

      // a path on show that now leads outside the session folder: not shown, and its row asks the confirmation, as a
      // link does
      if (process.platform !== "win32") {
        const leadsOut = "This path now leads to a file outside the session folder.";
        const secretShown = `${FP}.textContent.includes("second outside")`;
        await open("ig.txt");
        await contentShows("ignored");
        assert.equal(await app.ev(confirmShown), false, "no confirmation for ig.txt");
        await app.check(`${FP}.querySelector(".fp-loading").hidden && !!${openedRow("ig.txt")}`, "ig.txt's opened row");
        await fpSelect(app, "README.md");
        await app.ev(`${openedRow("ig.txt")}.click()`); // on show from its opened row, so watched
        await contentShows("ignored");
        writeFileSync(path.join(app.dir, "second.txt"), "second outside\n");
        const second = realpathSync(path.join(app.dir, "second.txt"));
        rmSync(path.join(work, "ig.txt"));
        symlinkSync(second, path.join(work, "ig.txt"));
        await app.check(`${FP}.querySelector(".fp-content").textContent.includes(${JSON.stringify(leadsOut)}) || ${secretShown}`, "the watcher's read of ig.txt");
        assert.equal(await app.ev(secretShown), false, "the outside file is not shown by the watcher");
        await contentShows(leadsOut);
        assert.equal(await app.ev(confirmShown), false, "no confirmation from the watcher");
        await app.ev(`${openedRow("ig.txt")}.click()`);
        await app.check(confirmShown, "the confirmation for ig.txt's new target");
        assert.equal(await app.ev(`${FP}.querySelector(".fp-confirm-path").textContent`), second, "the confirmation names the file the path leads to");
        assert.equal(await app.ev(secretShown), false, "the outside file is not shown");
        await app.ev(`${FP}.querySelector('[data-act="deny"]').click()`);
        await contentShows(leadsOut);
        assert.equal(await app.ev(secretShown), false, "the outside file is not shown after Cancel");
        // the browser opened again with ig.txt's row selected: an automatic selection shows the note and asks nothing
        await closeBrowser();
        await openBrowser();
        await app.check(`!!${openedRow("ig.txt")}?.classList.contains("active")`, "ig.txt's row selected again");
        await contentShows(leadsOut);
        assert.equal(await app.ev(confirmShown), false, "no confirmation when the browser opens");
        assert.equal(await app.ev(secretShown), false, "the outside file is not shown when the browser opens");
      }

      // the opened files are kept for the session
      const listed = await openedRows();
      assert.ok(listed.length > 0 || process.platform === "win32", "opened rows before the reload");
      await closeBrowser();
      await app.reload();
      await openBrowser();
      assert.deepStrictEqual(await openedRows(), listed, "the opened rows after the reload");
    },
  },
  {
    // replies from sub-sessions wait in their own list until approved (messages as main sends them: fromChild)
    name: "held-replies",
    modes: ["off"],
    sessionId: HISTORY_ID, // the switch is stored per session id; main accepts only a UUID
    async run(app) {
      const V = `views.get(${JSON.stringify(HISTORY_ID)})`;
      await firstTurn(app);
      const child = (id, from, text = "first\nmore") => app.ev(`${V}.incoming(${JSON.stringify({ from, text, prompt: `P-${id}`, deliveryId: id, fromChild: true, wake: true })})`);
      const rows = () => app.ev(`${V}.el.querySelectorAll(".held-row").length`);
      const shownEl = (sel) => app.ev(`(() => { const e = ${V}.el.querySelector(${JSON.stringify(sel)}); return !!e && !e.hidden && e.offsetParent !== null; })()`);
      const status = () => app.ev(`${V}.statusEl.textContent`);
      const queued = () => app.ev(`${V}.queue.map((i) => i.prompt)`);
      const clickIn = (sel, i = 0) => app.ev(`${V}.el.querySelectorAll(${JSON.stringify(sel)})[${i}].click()`);

      // 1. two replies are held, not queued
      await child("h1", "docs-9f8e7d");
      await child("h2", "tests-41ac0b");
      await frames(app);
      assert.equal(await rows(), 2, "two held rows");
      assert.equal(await app.ev(`${V}.el.querySelector(".held-from").textContent`), "docs-9f8e7d");
      assert.equal(await app.ev(`${V}.el.querySelector(".held-text").textContent`), "first");
      assert.equal(await shownEl(".queue-strip"), false, "the queue stays hidden");
      assert.equal(await status(), "2 replies waiting for approval");
      assert.equal(await app.ev(`document.querySelector(".item.active .held-mark")?.textContent ?? null`), "⏸ 2");
      assert.equal(await shownEl(".held-switch"), true, "the switch shows with held replies");
      // 2. a redelivery is ignored
      await child("h1", "docs-9f8e7d");
      assert.equal(await rows(), 2, "a redelivered held message adds no row");
      // the row expands to the full text (plain text) and back
      await clickIn(".held-text");
      assert.equal(await app.ev(`${V}.el.querySelector(".held-text").textContent`), "first\nmore");
      await clickIn(".held-text");
      assert.equal(await app.ev(`${V}.el.querySelector(".held-text").textContent`), "first");
      // 3. a message that is not from a child goes the old way
      await app.ev(`${V}.setBusy(true)`);
      await app.ev(`${V}.incoming({ from: "relay", text: "note", prompt: "P-note", deliveryId: "n1", wake: true })`);
      assert.equal(await rows(), 2);
      assert.deepEqual(await queued(), ["P-note"]);
      await app.ev(`${V}.queue.length = 0; ${V}.renderQueue(); ${V}.setBusy(false)`);
      // 4. approve the second one: a turn starts
      await clickIn(".held-approve", 1);
      await app.check(`${V}.log.querySelectorAll(":scope > .msg.relay").length === 1`, "the approved reply's turn");
      assert.equal(await rows(), 1);
      assert.equal(await app.ev(`${V}.log.querySelector(":scope > .msg.relay .from").textContent`), "from tests-41ac0b");
      await app.answerPermission(); // the scenario's second prompt asks once
      await app.idle();
      // 5. approving while busy queues it, delivered after the turn
      await app.ev(`${V}.setBusy(true)`);
      await clickIn(".held-approve", 0);
      assert.equal(await rows(), 0);
      assert.equal(await app.ev(`${V}.el.querySelector(".queue-from").textContent`), "from docs-9f8e7d:");
      assert.deepEqual(await queued(), ["P-h1"]);
      await app.ev(`${V}.setBusy(false)`);
      await app.check(`${V}.queue.length === 0 && ${V}.log.querySelectorAll(":scope > .msg.relay").length === 2`, "the queued reply's turn");
      await app.idle();
      // 6. discard
      await child("h3", "docs-9f8e7d");
      await clickIn(".held-discard");
      assert.equal(await rows(), 0);
      assert.ok((await app.ev(`${V}.log.textContent`)).includes("Discarded a reply from docs-9f8e7d."));
      // 7. the switch off moves everything to the queue, in order; later ones go straight there
      await app.ev(`${V}.setBusy(true)`);
      await child("h4", "docs-9f8e7d");
      await child("h5", "tests-41ac0b");
      await app.ev(`${V}.el.querySelector(".held-switch").click()`);
      await app.check(`${V}.holdReplies === false`, "the switch off");
      await frames(app);
      assert.equal(await shownEl(".held"), false, ".held hidden");
      assert.deepEqual(await queued(), ["P-h4", "P-h5"]);
      await child("h6", "docs-9f8e7d");
      assert.deepEqual(await queued(), ["P-h4", "P-h5", "P-h6"]);
      assert.equal(await rows(), 0);
      await app.ev(`${V}.el.querySelector(".held-switch").click()`);
      await app.check(`${V}.holdReplies === true`, "the switch on");
      assert.deepEqual(await queued(), ["P-h4", "P-h5", "P-h6"], "nothing moves back");
      await app.ev(`${V}.queue.length = 0; ${V}.renderQueue(); ${V}.setBusy(false)`);
      // 8. the wait note after a long wait
      await app.ev(`${V}.setBusy(true)`);
      await child("h7", "docs-9f8e7d");
      await app.ev(`(() => { window.__realNow = Date.now; Date.now = () => window.__realNow() + 61000; })()`);
      await clickIn(".held-approve");
      await app.ev(`Date.now = window.__realNow`);
      const [prompt] = await queued();
      assert.ok(prompt.endsWith("call list_sessions for their current state.)"), prompt);
      await app.ev(`${V}.queue.length = 0; ${V}.renderQueue(); ${V}.setBusy(false)`);
      // 9. a dead parent: approving is off, discarding still works
      await child("h8", "docs-9f8e7d");
      await app.ev(`${V}.markDead({ code: 1, signal: null, stderr: "" })`);
      await frames(app);
      assert.equal(await app.ev(`${V}.el.querySelector(".held-approve").disabled`), true);
      assert.equal(await app.ev(`${V}.el.querySelector(".held-discard").disabled`), false);
      // the discard of a dead view does not reach the broker (the harness has no relay client): the id is kept, and a
      // redelivery is dropped, not held again
      await clickIn(".held-discard");
      assert.equal(await rows(), 0);
      assert.equal(await app.ev(`${V}.discarded.has("h8")`), true, "the unconfirmed discard is remembered");
      await child("h8", "docs-9f8e7d");
      assert.equal(await rows(), 0, "a redelivered discarded reply is not held again");
      assert.equal(await app.ev(`${V}.discarded.has("h8")`), true, "still unconfirmed");
    },
  },
  {
    // the session's prompt reaches its Copilot through the instructions folder (the scripted agent records what it
    // was started with): on creation, after "Save and restart", in a fork; a delete drops the own part, and no
    // folder outlives the processes. The session id is a UUID: main takes only those for setPrompt and forks.
    name: "prompt-applied",
    modes: ["off"],
    sessionId: HISTORY_ID,
    settings: { promptDefault: "D" },
    async run(app) {
      const id = JSON.stringify(HISTORY_ID);
      const V = `views.get(${id})`;
      const work = path.join(app.dir, "work");
      const userData = path.join(app.dir, "config", "copilot-relay-desktop");
      const starts = () => JSON.parse(readFileSync(path.join(work, ".scripted-agent.json"), "utf8")).starts ?? [];
      const lastStart = () => starts().at(-1)?.instructions;
      const ownParts = () => {
        try {
          return JSON.parse(readFileSync(path.join(userData, "session-prompts.json"), "utf8"));
        } catch {
          return {};
        }
      };
      const userMessages = () => app.ev(`${V}.log.querySelectorAll(":scope > .msg.user").length`);

      // 1. a new session starts with the default part and its own part
      await app.newSession({ own: "O1" });
      assert.deepEqual(lastStart(), ["D\n\nO1"]);
      assert.equal(ownParts()[HISTORY_ID], "O1");
      await app.send("Look around.");
      await app.idle();
      const n = starts().length;
      // 2. the same text: nothing restarts
      assert.deepEqual(await app.ev(`api.setPrompt(${id}, "O1")`), { unchanged: true });
      assert.equal(starts().length, n, "no new start for an unchanged prompt");
      assert.equal(await app.ev(`${V}.dead`), false);
      // 3. a new text: main closes the session, the reopen starts Copilot with it and replays the chat
      assert.deepEqual(await app.ev(`api.setPrompt(${id}, "O2")`), { reopen: true });
      await app.ev(`reopenView(${V})`, "the session to reopen");
      await app.idle();
      assert.equal(starts().length, n + 1);
      assert.deepEqual(lastStart(), ["D\n\nO2"]);
      assert.equal(await userMessages(), 1, "the reopened chat keeps the earlier turn");
      // 4. a fork keeps the own part (Copilot's history files of the session, written here: the agent keeps none)
      const iso = new Date(2026, 10, 23, 9, 0).toISOString();
      const dir = path.join(app.dir, "copilot-home", "session-state", HISTORY_ID);
      mkdirSync(dir, { recursive: true });
      const events = [
        { type: "session.start", data: { sessionId: HISTORY_ID, context: { cwd: work } }, timestamp: iso },
        { type: "user.message", data: { content: "Look around." }, timestamp: iso },
        { type: "assistant.message", data: { messageId: "m1", content: "x" }, timestamp: iso },
      ];
      writeFileSync(path.join(dir, "events.jsonl"), events.map((e) => JSON.stringify(e)).join("\n") + "\n");
      const fork = await app.ev(`api.forkSession(${id}, { ordinal: 1, text: "Look around.", where: "afterReply" })`);
      assert.notEqual(fork.sessionId, HISTORY_ID);
      assert.equal(ownParts()[fork.sessionId], "O2");
      const F = `views.get(${JSON.stringify(fork.sessionId)})`;
      await app.ev(`openSession({ sessionId: ${JSON.stringify(fork.sessionId)}, cwd: ${JSON.stringify(work)} })`, "the fork to open");
      await app.check(`${F} && !${F}.resuming && !${F}.dead`, "the fork's view");
      // the agent keeps one file per folder, so the fork's start is the last one there
      assert.equal(starts().length, n + 2);
      assert.deepEqual(lastStart(), ["D\n\nO2"]);
      // 5. deleting the fork drops its own part
      const deleted = await app.ev(`api.deleteSession(${JSON.stringify(fork.sessionId)})`);
      assert.ok(!deleted?.refused && !deleted?.stuck, JSON.stringify(deleted));
      assert.equal(fork.sessionId in ownParts(), false);
      assert.equal(ownParts()[HISTORY_ID], "O2");
      // 6. no prompt folder outlives the processes
      const run = path.join(userData, "session-prompts", "run");
      assert.ok(readdirSync(run).length > 0, "the open session's folder exists while it runs");
      await app.close({ keep: true });
      try {
        assert.deepEqual(readdirSync(run), []);
      } finally {
        rmSync(app.dir, { recursive: true, force: true });
      }
    },
  },
  {
    // a new session opens the prompt editor in #prompt-dialog: the default part folded and read-only, a template
    // picked into an empty text area at once, one picked over typed text only after the inline question; Ctrl+Enter
    // starts the session with the text, Cancel starts nothing
    name: "new-session-prompt",
    modes: ["off"],
    settings: { promptDefault: "D", promptTemplates: [{ id: "t1", name: "Rev", text: "Review only." }] },
    async run(app) {
      const work = path.join(app.dir, "work");
      const starts = () => {
        try {
          return JSON.parse(readFileSync(path.join(work, ".scripted-agent.json"), "utf8")).starts ?? [];
        } catch {
          return [];
        }
      };
      const D = `document.querySelector("#prompt-dialog")`;
      const own = () => app.ev(`${D}.querySelector(".pe-own").value`);
      const pick = (id) => app.ev(`(() => { const s = ${D}.querySelector(".pe-template"); s.value = ${JSON.stringify(id)}; s.dispatchEvent(new Event("change", { bubbles: true })); })()`);
      const asking = () => app.ev(`(() => { const a = ${D}.querySelector(".pe-ask"); return !!a && !a.hidden && a.getClientRects().length > 0; })()`);
      const opened = () => app.check(`${D}.open`, "the prompt dialog");

      await app.ev(`(window.__newSession = newSession(${JSON.stringify(work)}), true)`);
      await opened();
      assert.equal(await app.ev(`${D}.querySelector("h2").textContent`), `New session in ${work}`);
      assert.equal(await app.ev(`document.querySelector("#prompt-ok").textContent`), "Start");
      // the folds: the default part, read-only; no child part for a new session
      const folds = await app.ev(`[...${D}.querySelectorAll("details")].map((d) => [d.querySelector("summary").textContent, d.querySelector("pre")?.textContent ?? null, d.open])`);
      assert.deepEqual(folds, [["Default (from Settings)", "D", false]]);
      assert.equal(await app.ev(`${D}.textContent.includes("Working with the parent")`), false);
      // a template into the empty text area: at once
      await pick("t1");
      assert.equal(await own(), "Review only.");
      assert.equal(await asking(), false);
      // over typed text: the inline question, and Keep leaves the text
      await app.ev(`(() => { const t = ${D}.querySelector(".pe-own"); t.value += " Be brief."; t.dispatchEvent(new Event("input", { bubbles: true })); })()`);
      await pick("t1");
      assert.equal(await asking(), true, "the Replace/Keep question");
      assert.equal(await own(), "Review only. Be brief.");
      await app.ev(`${D}.querySelector(".pe-keep").click()`);
      assert.equal(await asking(), false);
      assert.equal(await own(), "Review only. Be brief.");
      // Ctrl+Enter starts the session with the default part and the text
      await app.ev(`${D}.querySelector(".pe-own").dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", ctrlKey: true, bubbles: true }))`);
      await app.ev(`window.__newSession`, "newSession to return");
      await app.check(`(() => { const v = views.get("scripted-work"); return v && !v.busy; })()`, "the new session");
      assert.equal(await app.ev(`${D}.open`), false);
      assert.deepEqual(starts().at(-1)?.instructions, ["D\n\nReview only. Be brief."]);
      // Cancel: no process, no view
      const n = starts().length;
      const shown = await app.ev(`views.size`);
      await app.ev(`(window.__newSession = newSession(${JSON.stringify(work)}), true)`);
      await opened();
      await app.ev(`${D}.querySelector(".pe-own").value = "Never."`);
      await app.ev(`document.querySelector("#prompt-cancel").click()`);
      await app.ev(`window.__newSession`, "newSession to return");
      assert.equal(await app.ev(`${D}.open`), false);
      await new Promise((r) => setTimeout(r, 500)); // a start would have written its entry by now
      assert.equal(starts().length, n, "no Copilot started");
      assert.equal(await app.ev(`views.size`), shown, "no view");
    },
  },
  {
    // a start that fails (a Copilot command that does not exist) keeps the new-session dialog open with the text and
    // says why in it; Cancel then starts nothing
    name: "new-session-start-error",
    modes: ["off"],
    settings: { copilotCommand: "/nonexistent/copilot-ui-check" },
    async run(app) {
      const work = path.join(app.dir, "work");
      const D = `document.querySelector("#prompt-dialog")`;
      const shown = await app.ev(`views.size`);
      await app.ev(`(window.__newSession = newSession(${JSON.stringify(work)}), true)`);
      await app.check(`${D}.open`, "the prompt dialog");
      await app.ev(`(() => { const t = ${D}.querySelector(".pe-own"); t.value = "Keep me."; t.dispatchEvent(new Event("input", { bubbles: true })); })()`);
      await app.ev(`document.querySelector("#prompt-ok").click()`);
      await app.check(`${D}.querySelector("#prompt-note").textContent.startsWith("Could not start the session:")`, "the start error in the dialog");
      const note = await app.ev(`${D}.querySelector("#prompt-note").textContent`);
      assert.match(note, /The program was not found, or cannot be run\./);
      assert.match(note, /This is the command from Settings\./);
      assert.equal(await app.ev(`${D}.open`), true, "the dialog stays open");
      assert.equal(await app.ev(`${D}.querySelector(".pe-own").value`), "Keep me.");
      assert.equal(await app.ev(`document.querySelector("#prompt-ok").disabled`), false, "Start can be pressed again");
      assert.equal(await app.ev(`${D}.querySelector("#prompt-note").classList.contains("err")`), true);
      await app.ev(`document.querySelector("#prompt-cancel").click()`);
      assert.equal(await app.ev(`window.__newSession.then(() => true)`, "newSession to return"), true);
      assert.equal(await app.ev(`${D}.open`), false);
      assert.equal(await app.ev(`views.size`), shown, "no view");
    },
  },
  {
    // a start that never answers (a command that sleeps) ends at the start deadline: the note says so, the dialog
    // stays open with Start and Cancel enabled, and the command's process is gone
    name: "new-session-start-deadline",
    modes: ["off"],
    settings: { copilotCommand: "sh -c 'sleep 30' x" },
    env: { COPILOT_RELAY_START_TIMEOUT_MS: "1000" },
    async run(app) {
      if (process.platform === "win32") return;
      const work = path.join(app.dir, "work");
      const D = `document.querySelector("#prompt-dialog")`;
      const leftovers = () =>
        readdirSync("/proc")
          .filter((p) => /^\d+$/.test(p))
          .filter((p) => {
            try {
              return readlinkSync(`/proc/${p}/cwd`) === work;
            } catch {
              return false; // gone, or not ours
            }
          });
      await app.ev(`(window.__newSession = newSession(${JSON.stringify(work)}), true)`);
      await app.check(`${D}.open`, "the prompt dialog");
      await app.ev(`document.querySelector("#prompt-ok").click()`);
      await app.check(`${D}.querySelector("#prompt-note").textContent.includes("Copilot did not answer within 1 seconds.")`, "the deadline text in the dialog");
      assert.equal(await app.ev(`${D}.open`), true, "the dialog stays open");
      assert.equal(await app.ev(`document.querySelector("#prompt-ok").disabled`), false, "Start can be pressed again");
      assert.equal(await app.ev(`document.querySelector("#prompt-cancel").disabled`), false, "Cancel can be pressed");
      await until(async () => leftovers().length === 0, "the command's process to be gone");
      await app.ev(`document.querySelector("#prompt-cancel").click()`);
      await app.ev(`window.__newSession.then(() => true)`, "newSession to return");
    },
  },
  {
    // a signal sent to the app's main process (Ctrl+C in a terminal, a kill) leaves no Copilot of the launch behind:
    // each Copilot leads its own process group, so the signal does not reach it, but Electron's own handling of the
    // signal quits the app through before-quit, which kills every Copilot; this guards that path. The agent alone
    // would end by itself when the app dies (its stdin closes), so the command leaves a `sleep` behind it in the
    // same group: only a kill of the group removes it.
    name: "signal-kills-copilots",
    modes: ["off"],
    settings: { copilotCommand: `sh -c '"$0" "$@"; sleep 60' ${path.join(ROOT, "electron", "test", "fixtures", "acp", "scripted-agent.mjs")}` },
    async run(app) {
      if (process.platform === "win32") return;
      const work = path.join(app.dir, "work");
      const inWork = () =>
        readdirSync("/proc")
          .filter((p) => /^\d+$/.test(p))
          .filter((p) => {
            try {
              return readlinkSync(`/proc/${p}/cwd`) === work;
            } catch {
              return false; // gone, or not ours
            }
          });
      await app.newSession();
      assert.ok(app.agents().length >= 1, "an agent for the session");
      const main = app.mainPid();
      assert.ok(main, "the app's main process");
      process.kill(main, "SIGTERM");
      await until(async () => !existsSync(`/proc/${main}`), "the app to exit");
      await until(async () => app.agents().length === 0 && inWork().length === 0, "no process of the session to be left after SIGTERM");
    },
  },
  {
    // the child's approval card carries the prompt editor between the task and the buttons: both Settings parts
    // folded (the child one is the built-in text while Settings has none), and Approve starts the child with the text
    // written on it (create_session through a real broker, as in child-prompt); Reject starts nothing
    name: "child-card-prompt",
    modes: ["off"],
    scenario: CHILD_PROMPT_SCENARIO,
    settings: { relay: true, promptDefault: "D", promptTemplates: [{ id: "t1", name: "Rev", text: "Review only." }] },
    broker: true,
    async run(app) {
      await app.newSession();
      const file = path.join(app.dir, "work", ".scripted-agent.json");
      const starts = () => JSON.parse(readFileSync(file, "utf8")).starts ?? [];
      const card = (i) => `${V}.el.querySelectorAll(".perm.delegation")[${i}]`;
      await app.check(`(() => { const v = ${V}; return !!v?.relayName && !v.relayChip.hidden && !v.relayChip.classList.contains("off"); })()`, "the parent to connect to the broker");
      await app.send("create_session kid Do-it");
      await app.check(`!!${card(0)}?.querySelector(".prompt-editor") && !${card(0)}.querySelector(".opts button.primary").disabled`, "the editor on the card");
      // task, editor, buttons in this order
      const order = await app.ev(`[...${card(0)}.children].map((e) => (e.querySelector(".prompt-editor") ? "editor" : e.className))`);
      assert.ok(order.indexOf("task") >= 0 && order.indexOf("task") < order.indexOf("editor") && order.indexOf("editor") < order.indexOf("opts"), JSON.stringify(order));
      const folds = await app.ev(`[...${card(0)}.querySelectorAll("details")].map((d) => [d.querySelector("summary").textContent, d.querySelector("pre")?.textContent ?? null])`);
      assert.deepEqual(folds, [["Default (from Settings)", "D"], ["Working with the parent (from Settings)", CHILD_PART]]);
      assert.deepEqual(await app.ev(`[...${card(0)}.querySelectorAll(".pe-template option")].map((o) => o.textContent)`), ["— none —", "Rev"]);
      await app.ev(`(() => { const t = ${card(0)}.querySelector(".pe-own"); t.value = "K1"; t.dispatchEvent(new Event("input", { bubbles: true })); })()`);
      await app.ev(`${card(0)}.querySelector(".opts button.primary").click()`);
      await app.check(`${card(0)}.classList.contains("done")`, "the card to be answered");
      assert.match(await app.ev(`${card(0)}.querySelector(".opts").textContent`), /Approved/);
      assert.equal(await app.ev(`${card(0)}.querySelector(".pe-own").disabled`), true, "an answered card's text is no longer editable");
      await app.check(`!!views.get("scripted-work-2")`, "the child's view");
      // the parent's and the child's processes share the folder's file, the last one to write it wins: the child's
      // start is checked once it is there
      const childStart = JSON.stringify([`D\n\n${CHILD_PART}\n\nK1`]);
      await until(async () => starts().some((st) => JSON.stringify(st.instructions) === childStart), "the child's start with the card's text");
      await app.idle();
      // Reject: nothing starts, whatever the card holds
      await app.send("create_session kid2 Never");
      await app.check(`!!${card(1)}?.querySelector(".prompt-editor") && !${card(1)}.querySelector(".opts button.primary").disabled`, "the second card's editor");
      await app.ev(`${card(1)}.querySelector(".pe-own").value = "Never."`);
      await app.ev(`[...${card(1)}.querySelectorAll(".opts button")].find((b) => b.textContent === "Reject").click()`);
      await app.check(`${card(1)}.classList.contains("done")`, "the second card to be answered");
      assert.match(await app.ev(`${card(1)}.querySelector(".opts").textContent`), /Rejected/);
      await app.idle();
      await new Promise((r) => setTimeout(r, 500)); // a child would have been created by now
      assert.equal(await app.ev(`views.has("scripted-work-3")`), false, "no child for the rejected request");
      assert.ok(!JSON.stringify(starts()).includes("Never."), "nothing started with the rejected card's text");
    },
  },
  {
    // a delegated child starts with its parent's stored command (not Settings'), keeps it as its own, and its approval
    // card offers no command field. The parent is given its command in the new-session dialog; the scripted agent
    // records every start's arguments in $SCRIPTED_ARGV_FILE.
    name: "child-command-inherited",
    modes: ["off"],
    scenario: CHILD_PROMPT_SCENARIO,
    settings: { relay: true },
    broker: true,
    async run(app) {
      const argvFile = path.join(app.dir, "argv.jsonl");
      const command = `SCRIPTED_ARGV_FILE='${argvFile}' '${SCRIPTED_AGENT}' --tag parent`;
      const lines = () => (existsSync(argvFile) ? readFileSync(argvFile, "utf8").split("\n").filter(Boolean) : []);
      const stored = () => JSON.parse(readFileSync(path.join(app.dir, "config", "copilot-relay-desktop", "session-commands.json"), "utf8"));
      const D = `document.querySelector("#prompt-dialog")`;
      const card = `${V}.el.querySelectorAll(".perm.delegation")[0]`;
      await app.ev(`(window.__newSession = newSession(${JSON.stringify(path.join(app.dir, "work"))}), true)`);
      await app.check(`${D}.open && !!${D}.querySelector(".pe-command")`, "the prompt dialog with the command field");
      await app.ev(`(() => { const t = ${D}.querySelector(".pe-command"); t.value = ${JSON.stringify(command)}; t.dispatchEvent(new Event("input", { bubbles: true })); })()`);
      await app.ev(`document.querySelector("#prompt-ok").click()`);
      await app.ev(`window.__newSession`, "newSession to return");
      await app.check(`!!${V} && !${V}.busy`, "the parent's view");
      await app.check(`!!${V}.relayName && !${V}.relayChip.hidden && !${V}.relayChip.classList.contains("off")`, "the parent to connect to the broker");
      assert.deepEqual(lines().map((l) => JSON.parse(l)), [["--tag", "parent", "--acp", "--stdio"]]);
      // the driver's send needs the session newSession() of the driver made: this one was started by its dialog
      await app.ev(`(() => { const v = ${V}; v.input.value = "create_session kid Do-it"; v.input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })); })()`);
      await app.check(`!!${card}?.querySelector(".prompt-editor") && !${card}.querySelector(".opts button.primary").disabled`, "the card");
      assert.equal(await app.ev(`!!${card}.querySelector(".pe-command")`), false, "no command field on the approval card");
      await app.ev(`${card}.querySelector(".opts button.primary").click()`);
      await app.check(`${card}.classList.contains("done")`, "the card to be answered");
      await app.check(`!!views.get("scripted-work-2")`, "the child's view");
      await until(async () => lines().length === 2, "the child's start");
      assert.deepEqual(JSON.parse(lines()[1]), ["--tag", "parent", "--acp", "--stdio"]);
      assert.equal(stored()["scripted-work-2"], command, "the child's own command is the parent's");
      assert.equal(stored()["scripted-work"], command);
      await app.check(`!${V}.busy`, "the parent to be idle");
    },
  },
  {
    // a parent's command that cannot be run: the child is not created, no view appears, and the parent is told in a
    // relay notice (a message of kind relay in its chat) whose text says where the command comes from. The stored
    // command is replaced in the file while the parent runs (the store reads the file on every use).
    name: "child-command-broken",
    modes: ["off"],
    scenario: CHILD_PROMPT_SCENARIO,
    settings: { relay: true },
    broker: true,
    async run(app) {
      await app.newSession();
      const file = path.join(app.dir, "config", "copilot-relay-desktop", "session-commands.json");
      const card = `${V}.el.querySelectorAll(".perm.delegation")[0]`;
      await app.check(`!!${V}.relayName && !${V}.relayChip.hidden && !${V}.relayChip.classList.contains("off")`, "the parent to connect to the broker");
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(file, JSON.stringify({ "scripted-work": "/nonexistent/copilot-ui-check" }));
      await app.send("create_session kid Do-it");
      await app.check(`!!${card}?.querySelector(".prompt-editor") && !${card}.querySelector(".opts button.primary").disabled`, "the card");
      await app.ev(`${card}.querySelector(".opts button.primary").click()`);
      const notice = `[...${V}.log.querySelectorAll(".msg.relay")].map((e) => e.textContent).join(" ")`;
      await app.check(`${notice}.includes("This is the parent session's command.")`, "the parent to be told why the child did not start");
      const text = await app.ev(notice);
      assert.match(text, /Session "kid" was not created: /);
      assert.ok(text.includes("This is the parent session's command."), text);
      await app.idle();
      assert.equal(await app.ev(`views.has("scripted-work-2")`), false, "no view for the child that did not start");
    },
  },
  {
    // the header's Prompt button: the dialog holds the stored own part, says that saving restarts Copilot, and "Save
    // and restart" reopens the session with the new text; the button follows the busy state; a refusal (main's, or a
    // turn the view started meanwhile) keeps the dialog open with the text. A UUID: main takes only those. Every
    // prompt of the scenario waits for its permission, so a turn runs until the check answers it.
    name: "session-prompt-edit",
    modes: ["off"],
    scenario: PERMISSION_WAIT_SCENARIO,
    sessionId: HISTORY_ID,
    settings: { promptDefault: "D" },
    async run(app) {
      const id = JSON.stringify(HISTORY_ID);
      const V = `views.get(${id})`;
      const work = path.join(app.dir, "work");
      const starts = () => JSON.parse(readFileSync(path.join(work, ".scripted-agent.json"), "utf8")).starts ?? [];
      const D = `document.querySelector("#prompt-dialog")`;
      const btn = `${V}.el.querySelector(".head .prompt-btn")`;
      const note = () => app.ev(`(() => { const n = ${D}.querySelector("#prompt-note"); return n.hidden ? null : n.textContent; })()`);
      const own = () => app.ev(`${D}.querySelector(".pe-own").value`);
      const setOwn = (text) => app.ev(`(() => { const t = ${D}.querySelector(".pe-own"); t.value = ${JSON.stringify(text)}; t.dispatchEvent(new Event("input", { bubbles: true })); })()`);
      const openDialog = async () => {
        await app.ev(`${btn}.click()`);
        await app.check(`${D}.open && !!${D}.querySelector(".pe-own")`, "the prompt dialog");
      };
      const ok = () => app.ev(`document.querySelector("#prompt-ok").click()`);
      const cancel = async () => {
        await app.ev(`document.querySelector("#prompt-cancel").click()`);
        await app.check(`!${D}.open`, "the dialog to close");
      };
      const userMessages = () => app.ev(`${V}.log.querySelectorAll(":scope > .msg.user").length`);
      const WAIT = "Wait until Copilot finishes this turn.";

      await app.newSession({ own: "O1" });
      await app.send("First.");
      await app.answerPermission();
      await app.idle();
      assert.equal(await app.ev(`${btn}.textContent`), "Setup");
      assert.equal(await app.ev(`${btn}.title`), SETUP_TITLE);
      assert.equal(await app.ev(`${btn}.disabled`), false);
      // 1. the dialog: the stored own part, the restart note, "Save and restart"; a top-level session has no child fold
      await openDialog();
      assert.equal(await own(), "O1");
      assert.equal(await note(), RESTART_NOTE);
      assert.equal(await app.ev(`document.querySelector("#prompt-ok").textContent`), "Save and restart");
      assert.deepEqual(await app.ev(`[...${D}.querySelectorAll("details summary")].map((s) => s.textContent)`), ["Default (from Settings)"]);
      // 2. main refuses (it runs a turn the view did not start: the api is frozen, so main is made to refuse for
      // real): the dialog stays open with the text and shows why; nothing restarts, the view is idle again
      const n = starts().length;
      await app.ev(`(window.__turn = api.prompt(${id}, "Second.", "app"), true)`);
      await app.check(`!!${V}.el.querySelector(".perm:not(.done)")`, "main's turn to wait for its permission");
      assert.equal(await app.ev(`${V}.busy`), false, "the view itself is idle");
      await setOwn("O2");
      await ok();
      await app.check(`${D}.querySelector("#prompt-note").textContent === ${JSON.stringify(WAIT)}`, "main's refusal in the dialog");
      assert.equal(await app.ev(`${D}.open`), true, "the dialog stays open");
      assert.equal(await own(), "O2", "the text is kept");
      assert.equal(await app.ev(`${D}.querySelector("#prompt-note").classList.contains("err")`), true);
      assert.equal(await app.ev(`document.querySelector("#prompt-ok").disabled`), false);
      assert.equal(await app.ev(`${V}.busy`), false, "the view is idle again");
      await cancel();
      await app.answerPermission();
      await app.ev(`window.__turn`, "main's turn to end");
      await app.idle();
      // 3. a turn the view starts while the dialog is open: refused in the page, the text kept
      await openDialog();
      assert.equal(await note(), RESTART_NOTE, "a new dialog shows the note again");
      await setOwn("O2");
      await app.ev(`(() => { const v = ${V}; v.input.value = "Third."; v.input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })); })()`);
      await app.check(`${V}.busy && !!${V}.el.querySelector(".perm:not(.done)")`, "the view's turn to wait for its permission");
      await ok();
      await app.check(`${D}.querySelector("#prompt-note").textContent === ${JSON.stringify(WAIT)}`, "the busy refusal");
      assert.equal(await app.ev(`${D}.open`), true);
      assert.equal(await own(), "O2");
      await cancel();
      // 4. the button is disabled while the view is busy
      assert.equal(await app.ev(`${btn}.disabled`), true, "disabled during the turn");
      await app.answerPermission();
      await app.idle();
      assert.equal(await app.ev(`${btn}.disabled`), false, "enabled again after the turn");
      assert.equal(starts().length, n, "nothing restarted so far");
      // 5. an unchanged text: the dialog closes, nothing restarts
      await openDialog();
      assert.equal(await own(), "O1", "a new dialog shows the stored text");
      await ok();
      await app.check(`!${D}.open`, "the dialog to close");
      assert.equal(await app.ev(`${V}.busy`), false);
      assert.equal(starts().length, n);
      // 6. a new text: Save and restart reopens the session with it, the chat replayed
      await openDialog();
      await setOwn("O3");
      await ok();
      await app.check(`!${D}.open`, "the dialog to close");
      await until(async () => starts().length === n + 1, "a new start");
      assert.deepEqual(starts().at(-1).instructions, ["D\n\nO3"]);
      await app.idle();
      assert.equal(await app.ev(`${V}.dead`), false);
      // the three turns, main's one included (live it had no bubble: the view did not send it)
      assert.equal(await userMessages(), 3, "the reopened chat keeps its turns");
      assert.equal(await app.ev(`${btn}.disabled`), false);
      assert.equal(await app.ev(`api.getPrompt(${id}).then((p) => p.own)`), "O3");
    },
  },
  {
    // the command field of the new-session dialog: what is typed there reaches the agent's command line (the scripted
    // agent records its arguments in $SCRIPTED_ARGV_FILE) and is stored for the session
    name: "session-command-new",
    modes: ["off"],
    sessionId: HISTORY_ID,
    async run(app) {
      const work = path.join(app.dir, "work");
      const argvFile = path.join(app.dir, "argv.jsonl");
      const D = `document.querySelector("#prompt-dialog")`;
      const lines = () => (existsSync(argvFile) ? readFileSync(argvFile, "utf8").split("\n").filter(Boolean) : []);
      await app.ev(`(window.__newSession = newSession(${JSON.stringify(work)}), true)`);
      await app.check(`${D}.open && !!${D}.querySelector(".pe-command")`, "the prompt dialog with the command field");
      assert.equal(await app.ev(`${D}.querySelector(".pe-command").placeholder`), `Settings: ${SCRIPTED_AGENT}`);
      await app.ev(`(() => { const t = ${D}.querySelector(".pe-command"); t.value = ${JSON.stringify(`SCRIPTED_ARGV_FILE='${argvFile}' '${SCRIPTED_AGENT}' --tag one`)}; t.dispatchEvent(new Event("input", { bubbles: true })); })()`);
      await app.ev(`document.querySelector("#prompt-ok").click()`);
      await app.ev(`window.__newSession`, "newSession to return");
      await app.check(`views.has(${JSON.stringify(HISTORY_ID)})`, "the view");
      assert.equal(lines().at(-1), JSON.stringify(["--tag", "one", "--acp", "--stdio"]));
      const stored = JSON.parse(readFileSync(path.join(app.dir, "config", "copilot-relay-desktop", "session-commands.json"), "utf8"));
      assert.equal(stored[HISTORY_ID], `SCRIPTED_ARGV_FILE='${argvFile}' '${SCRIPTED_AGENT}' --tag one`);
    },
  },
  {
    // plain Enter in the command field must not submit the form (its first submit button is Cancel, which would
    // close the dialog and lose the text); Ctrl+Enter accepts, as in the text area. Real key events: a synthetic
    // one does not trigger the browser's implicit submission.
    name: "session-command-enter",
    modes: ["off"],
    sessionId: HISTORY_ID,
    async run(app) {
      const work = path.join(app.dir, "work");
      const D = `document.querySelector("#prompt-dialog")`;
      await app.ev(`(window.__newSession = newSession(${JSON.stringify(work)}), true)`);
      await app.check(`${D}.open && !!${D}.querySelector(".pe-command")`, "the prompt dialog");
      await app.ev(`(() => { for (const [sel, text] of [[".pe-own", "Keep me."], [".pe-command", ${JSON.stringify(`'${SCRIPTED_AGENT}' --tag enter`)}]]) { const t = ${D}.querySelector(sel); t.value = text; t.dispatchEvent(new Event("input", { bubbles: true })); } ${D}.querySelector(".pe-command").focus(); })()`);
      await app.pressEnter();
      await app.ev("new Promise((r) => setTimeout(r, 300))");
      assert.equal(await app.ev(`${D}.open`), true, "plain Enter leaves the dialog open");
      assert.equal(await app.ev(`${D}.querySelector(".pe-own").value`), "Keep me.");
      assert.equal(await app.ev(`${D}.querySelector(".pe-command").value`), `'${SCRIPTED_AGENT}' --tag enter`);
      await app.pressEnter({ ctrl: true });
      await app.ev(`window.__newSession`, "newSession to return");
      await app.check(`!${D}.open && views.has(${JSON.stringify(HISTORY_ID)})`, "Ctrl+Enter to start the session");
    },
  },
  {
    // Setup: the command field is empty with the Settings command as placeholder; a new command (and text) restarts
    // Copilot with it, exactly one start; the same values again restart nothing
    name: "session-command-setup",
    modes: ["off"],
    sessionId: HISTORY_ID,
    async run(app) {
      const id = JSON.stringify(HISTORY_ID);
      const V = `views.get(${id})`;
      const argvFile = path.join(app.dir, "argv.jsonl");
      const D = `document.querySelector("#prompt-dialog")`;
      const btn = `${V}.el.querySelector(".head .prompt-btn")`;
      const lines = () => (existsSync(argvFile) ? readFileSync(argvFile, "utf8").split("\n").filter(Boolean) : []);
      const set = (sel, text) => app.ev(`(() => { const t = ${D}.querySelector(${JSON.stringify(sel)}); t.value = ${JSON.stringify(text)}; t.dispatchEvent(new Event("input", { bubbles: true })); })()`);
      const command = `SCRIPTED_ARGV_FILE='${argvFile}' '${SCRIPTED_AGENT}' --tag two`;
      await app.newSession();
      assert.equal(await app.ev(`${btn}.textContent`), "Setup");
      assert.equal(await app.ev(`${btn}.title`), SETUP_TITLE);
      await app.ev(`${btn}.click()`);
      await app.check(`${D}.open && !!${D}.querySelector(".pe-command")`, "the Setup dialog");
      assert.ok((await app.ev(`${D}.querySelector("#prompt-title").textContent`)).startsWith("Setup: "));
      assert.equal(await app.ev(`${D}.querySelector(".pe-command").value`), "");
      assert.equal(await app.ev(`${D}.querySelector(".pe-command").placeholder`), `Settings: ${SCRIPTED_AGENT}`);
      assert.equal(await app.ev(`${D}.querySelector("label.pe-command-row > span").textContent`), "Copilot command");
      await set(".pe-command", command);
      await set(".pe-own", "Own text.");
      await app.ev(`document.querySelector("#prompt-ok").click()`);
      await app.check(`!${D}.open`, "the dialog to close");
      await until(async () => lines().length === 1, "the restart with the new command");
      await app.idle();
      assert.deepEqual(lines().map((l) => JSON.parse(l)), [["--tag", "two", "--acp", "--stdio"]]);
      // unchanged: nothing restarts
      await app.ev(`${btn}.click()`);
      await app.check(`${D}.open`, "the Setup dialog again");
      assert.equal(await app.ev(`${D}.querySelector(".pe-command").value`), command);
      assert.equal(await app.ev(`${D}.querySelector(".pe-own").value`), "Own text.");
      await app.ev(`document.querySelector("#prompt-ok").click()`);
      await app.check(`!${D}.open`, "the dialog to close");
      await app.idle();
      assert.equal(lines().length, 1, "no new start for unchanged values");
    },
  },
  {
    // a broken own command leaves a dead view whose Setup still works: clearing the field brings it back and drops
    // the stored command
    name: "session-command-repair",
    modes: ["off"],
    sessionId: HISTORY_ID,
    async run(app) {
      const id = JSON.stringify(HISTORY_ID);
      const V = `views.get(${id})`;
      const D = `document.querySelector("#prompt-dialog")`;
      const btn = () => `${V}.el.querySelector(".head .prompt-btn")`;
      const storeFile = path.join(app.dir, "config", "copilot-relay-desktop", "session-commands.json");
      const stored = () => (existsSync(storeFile) ? JSON.parse(readFileSync(storeFile, "utf8")) : {});
      const setup = async (command) => {
        await app.ev(`${btn()}.click()`);
        await app.check(`${D}.open && !!${D}.querySelector(".pe-command")`, "the Setup dialog");
        await app.ev(`(() => { const t = ${D}.querySelector(".pe-command"); t.value = ${JSON.stringify(command)}; t.dispatchEvent(new Event("input", { bubbles: true })); })()`);
        await app.ev(`document.querySelector("#prompt-ok").click()`);
        await app.check(`!${D}.open`, "the dialog to close");
      };
      await app.newSession();
      await setup("/nonexistent/copilot-ui-check");
      await app.check(`${V} && ${V}.dead`, "the view to be dead");
      assert.ok((await app.ev(`${V}.el.textContent`)).includes("This is this session's own command."));
      assert.equal(await app.ev(`${btn()}.disabled`), false, "Setup stays available on a dead view");
      assert.equal(stored()[HISTORY_ID], "/nonexistent/copilot-ui-check");
      await setup("");
      await app.check(`${V} && !${V}.dead && !${V}.resuming`, "the view to be alive again");
      assert.equal(HISTORY_ID in stored(), false, "no stored command");
    },
  },
  {
    // a dead view whose cause was fixed elsewhere (the command works now, nothing in the dialog changes): "Save and
    // restart" with unchanged values reopens the view
    name: "session-command-repair-unchanged",
    modes: ["off"],
    sessionId: HISTORY_ID,
    async run(app) {
      const id = JSON.stringify(HISTORY_ID);
      const V = `views.get(${id})`;
      const D = `document.querySelector("#prompt-dialog")`;
      const flag = path.join(app.dir, "agent-ok");
      // starts the scripted agent only while the flag file exists; otherwise it exits at once
      const command = `sh -c 'test -f "$0" || exit 1; exec "$@"' '${flag}' '${SCRIPTED_AGENT}'`;
      await app.newSession();
      await app.ev(`${V}.el.querySelector(".head .prompt-btn").click()`);
      await app.check(`${D}.open && !!${D}.querySelector(".pe-command")`, "the Setup dialog");
      await app.ev(`(() => { const t = ${D}.querySelector(".pe-command"); t.value = ${JSON.stringify(command)}; t.dispatchEvent(new Event("input", { bubbles: true })); })()`);
      await app.ev(`document.querySelector("#prompt-ok").click()`);
      await app.check(`!${D}.open && ${V} && ${V}.dead`, "the view to be dead");
      writeFileSync(flag, "");
      await app.ev(`${V}.el.querySelector(".head .prompt-btn").click()`);
      await app.check(`${D}.open && !!${D}.querySelector(".pe-command")`, "the Setup dialog again");
      await app.ev(`document.querySelector("#prompt-ok").click()`);
      await app.check(`!${D}.open`, "the dialog to close");
      await app.check(`${V} && !${V}.dead && !${V}.resuming`, "the view to be alive again");
    },
  },
  {
    // a fork takes its origin's own command; deleting the fork drops it
    name: "session-command-fork-delete",
    modes: ["off"],
    sessionId: HISTORY_ID,
    async run(app) {
      const id = JSON.stringify(HISTORY_ID);
      const D = `document.querySelector("#prompt-dialog")`;
      const work = path.join(app.dir, "work");
      const storeFile = path.join(app.dir, "config", "copilot-relay-desktop", "session-commands.json");
      const stored = () => JSON.parse(readFileSync(storeFile, "utf8"));
      const command = `'${SCRIPTED_AGENT}' --tag fork`;
      await app.ev(`(window.__newSession = newSession(${JSON.stringify(work)}), true)`);
      await app.check(`${D}.open`, "the prompt dialog");
      await app.ev(`(() => { const t = ${D}.querySelector(".pe-command"); t.value = ${JSON.stringify(command)}; t.dispatchEvent(new Event("input", { bubbles: true })); })()`);
      await app.ev(`document.querySelector("#prompt-ok").click()`);
      await app.ev(`window.__newSession`, "newSession to return");
      await app.check(`views.has(${id}) && !views.get(${id}).busy`, "the view");
      // Copilot's history files of the session, written here: the agent keeps none
      const iso = new Date(2026, 10, 23, 9, 0).toISOString();
      const dir = path.join(app.dir, "copilot-home", "session-state", HISTORY_ID);
      mkdirSync(dir, { recursive: true });
      const events = [
        { type: "session.start", data: { sessionId: HISTORY_ID, context: { cwd: work } }, timestamp: iso },
        { type: "user.message", data: { content: "Look around." }, timestamp: iso },
        { type: "assistant.message", data: { messageId: "m1", content: "x" }, timestamp: iso },
      ];
      writeFileSync(path.join(dir, "events.jsonl"), events.map((e) => JSON.stringify(e)).join("\n") + "\n");
      const fork = await app.ev(`api.forkSession(${id}, { ordinal: 1, text: "Look around.", where: "afterReply" })`);
      assert.notEqual(fork.sessionId, HISTORY_ID);
      assert.equal(stored()[fork.sessionId], command);
      const deleted = await app.ev(`api.deleteSession(${JSON.stringify(fork.sessionId)})`);
      assert.ok(!deleted?.refused && !deleted?.stuck, JSON.stringify(deleted));
      assert.equal(fork.sessionId in stored(), false);
      assert.equal(stored()[HISTORY_ID], command);
    },
  },
  {
    // the Settings hint explains what the command may carry, and the field takes up to 4000 characters
    name: "settings-command-hint",
    modes: ["off"],
    async run(app) {
      await app.ev(`document.querySelector("#btn-settings").click()`);
      await app.check(`document.querySelector("#settings").open`, "the Settings dialog");
      const hint = await app.ev(`document.querySelector("#set-hint").textContent`);
      assert.match(hint, /May carry arguments/);
      assert.match(hint, /--acp --stdio/);
      assert.match(hint, /Currently used:/);
      assert.equal(await app.ev(`document.querySelector("#set-command").maxLength`), 4000);
    },
  },
  {
    // the Settings "Prompts" section: the default part, the child part with "Restore default" (the built-in text,
    // stored as no key), the templates (add, rename, edit, delete); a relaunch with the same folder shows them again
    name: "settings-prompts",
    modes: ["off"],
    async run(app) {
      const S = `document.querySelector("#settings")`;
      const file = path.join(app.dir, "config", "copilot-relay-desktop", "settings.json");
      const onDisk = () => JSON.parse(readFileSync(file, "utf8"));
      const type = (sel, text) => app.ev(`(() => { const t = document.querySelector(${JSON.stringify(sel)}); t.value = ${JSON.stringify(text)}; t.dispatchEvent(new Event("input", { bubbles: true })); })()`);
      const rows = `[...document.querySelectorAll("#set-templates .tpl-row")]`;
      const typeRow = (i, sel, text) => app.ev(`(() => { const t = ${rows}[${i}].querySelector(${JSON.stringify(sel)}); t.value = ${JSON.stringify(text)}; t.dispatchEvent(new Event("input", { bubbles: true })); })()`);
      const openSettings = async (a = app) => {
        await a.ev(`document.querySelector("#btn-settings").click()`);
        await a.check(`${S}.open`, "the Settings dialog");
      };
      const save = async () => {
        await app.ev(`document.querySelector("#set-save").click()`);
        await app.check(`!${S}.open`, "the Settings dialog to close");
      };

      await openSettings();
      assert.ok(await app.ev(`${S}.textContent.includes(${JSON.stringify(SETTINGS_NOTE)})`), "the note under the fields");
      assert.equal(await app.ev(`document.querySelector("#set-prompt-default").value`), "");
      assert.equal(await app.ev(`document.querySelector("#set-prompt-child").value`), CHILD_PART);
      assert.equal(await app.ev(`document.querySelector("#set-prompt-child-restore").disabled`), true, "nothing to restore");
      await type("#set-prompt-default", "DEF");
      await type("#set-prompt-child", "CH");
      assert.equal(await app.ev(`document.querySelector("#set-prompt-child-restore").disabled`), false);
      await app.ev(`document.querySelector("#set-prompt-child-restore").click()`);
      assert.equal(await app.ev(`document.querySelector("#set-prompt-child").value`), CHILD_PART);
      // Enter in a template's name goes to its text; it must not submit the form (its first button is Cancel)
      await app.ev(`document.querySelector("#set-template-add").click()`);
      await app.check(`document.activeElement === ${rows}[0].querySelector(".tpl-name")`, "the new template's name to be focused");
      await app.pressEnter();
      await app.check(`document.activeElement === ${rows}[0].querySelector(".tpl-text")`, "Enter to move to the template's text");
      assert.equal(await app.ev(`${S}.open`), true, "Enter in a template name keeps the Settings dialog open");
      // two templates: the first renamed, the second deleted
      await app.ev(`document.querySelector("#set-template-add").click()`);
      assert.equal(await app.ev(`${rows}.length`), 2);
      await typeRow(0, ".tpl-name", "First");
      await typeRow(0, ".tpl-text", "T1");
      await typeRow(1, ".tpl-name", "Second");
      await typeRow(1, ".tpl-text", "T2");
      await typeRow(0, ".tpl-name", "Renamed");
      await app.ev(`${rows}[1].querySelector(".tpl-delete").click()`);
      assert.equal(await app.ev(`${rows}.length`), 1);
      await save();
      await app.check(`api.getSettings().then((s) => s.promptDefault === "DEF")`, "the Settings to be saved");
      const s = await app.ev(`api.getSettings()`);
      assert.equal(s.promptDefault, "DEF");
      assert.equal(s.promptChild, null);
      assert.equal("promptChild" in onDisk(), false, "Restore default stores no key");
      assert.equal(s.promptTemplates.length, 1);
      assert.deepEqual({ name: s.promptTemplates[0].name, text: s.promptTemplates[0].text }, { name: "Renamed", text: "T1" });
      assert.match(s.promptTemplates[0].id, /^[0-9a-f-]{36}$/);
      // an emptied child part is stored as "" (no child part), and a save that changes nothing keeps everything
      await openSettings();
      await type("#set-prompt-child", "");
      await save();
      await until(async () => onDisk().promptChild === "", "the emptied child part to be saved");
      await openSettings();
      assert.equal(await app.ev(`document.querySelector("#set-prompt-child").value`), "");
      await save();
      assert.deepEqual(await app.ev(`api.getSettings().then((s) => [s.promptDefault, s.promptChild, s.promptTemplates])`), ["DEF", "", s.promptTemplates]);
      // a relaunch with the same folder reads them back, in the page and in the form
      await app.close({ keep: true });
      const again = await launch({ scenario: PANEL_SCENARIO, dir: app.dir });
      try {
        assert.deepEqual(await again.ev(`api.getSettings().then((s) => [s.promptDefault, s.promptChild, s.promptTemplates])`), ["DEF", "", s.promptTemplates]);
        await openSettings(again);
        assert.equal(await again.ev(`document.querySelector("#set-prompt-default").value`), "DEF");
        assert.equal(await again.ev(`document.querySelector("#set-prompt-child").value`), "");
        assert.deepEqual(await again.ev(`${rows}.map((r) => [r.querySelector(".tpl-name").value, r.querySelector(".tpl-text").value])`), [["Renamed", "T1"]]);
      } finally {
        await again.close();
      }
    },
  },
];
