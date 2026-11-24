// Scenarios that send prompts (each costs model requests): turns, agents, prompts, permissions, MCP, abort, queue,
// resume, truncate, fork, attachments, sub-agents, questions to the user, crash recovery. Cleanup comes last.
import fs from "node:fs";
import path from "node:path";
import { Acp, cleanText, errorInfo, rmrf, sanitize, sleep, solidPng, startMcpStub, withTimeout } from "./lib.mjs";
import { G, Skip, cleanupTmp, close, getClient, idle, open, resumeOptions, sessionFiles, stopClient, turn, watcher, workspace } from "./core.mjs";

const LONG_PROMPT = "Write the numbers from 1 to 250, one per line, and nothing else. Do not use any tools.";
const has = (text, needle) => String(text ?? "").toLowerCase().includes(String(needle).toLowerCase());
const best = () => (G.best.enableConfigDiscovery === undefined ? {} : { enableConfigDiscovery: G.best.enableConfigDiscovery });
const attempt = async (label, fn, ms = 30_000) => {
  try {
    return { ok: true, result: sanitize(await withTimeout(fn(), ms, label), { depth: 4, max: 160 }) };
  } catch (e) {
    return { ok: false, error: cleanText(e?.message ?? String(e), 400) };
  }
};
/** Waits for the model to start answering (first streamed chunk), or 4 s. */
const started = (w, from) => w.waitFor((e) => /^assistant\.(message_delta|reasoning_delta|streaming_delta)$/.test(e.type), 25_000, from).catch(() => sleep(4000));

export const llmScenarios = [
  {
    id: "turn",
    title: "A plain turn in the repository: streaming, event types, usage, history on disk",
    llm: true,
    async run(s) {
      const client = await getClient();
      const { session, w } = await open(client, { cwd: G.cwd, policy: "read-only", extra: best() });
      try {
        const r = await turn(session, w, "Reply with exactly: PROBE-OK. Do not use any tools.");
        s.data.reply = cleanText(r.text, 200);
        s.data.ms = r.ms;
        s.data.firstDeltaMs = r.firstDeltaMs;
        s.data.deltas = r.deltas;
        s.data.eventTypes = w.histogram();
        s.data.usageEvent = sanitize(w.of("assistant.usage").at(-1)?.data, { depth: 3, max: 80 });
        s.data.usageInfo = sanitize(w.of("session.usage_info").at(-1)?.data, { depth: 2 });
        s.data.metrics = await attempt("usage.getMetrics", () => session.rpc.usage.getMetrics({}));
        s.data.model = w.of("assistant.message").at(-1)?.data?.model ?? null;
        const stored = await session.getEvents();
        s.data.getEvents = { count: stored.length, types: [...new Set(stored.map((e) => e.type))], keys: Object.keys(stored[0] ?? {}) };
        await close(session);
        await sleep(400);
        const files = sessionFiles(session.sessionId);
        s.data.files = files;
        s.check("Turn completes and the reply arrives", has(r.text, "PROBE-OK"), `${r.ms} ms, model ${s.data.model ?? "?"}`);
        s.check("Reply is streamed in chunks (assistant.message_delta)", r.deltas > 0, r.deltas ? `${r.deltas} chunks, first after ${r.firstDeltaMs} ms` : "no chunks: the app would show the reply at once");
        s.check("Token usage is reported per call (assistant.usage)", Boolean(s.data.usageEvent), s.data.usageEvent ? `in ${s.data.usageEvent.inputTokens}, out ${s.data.usageEvent.outputTokens}` : "");
        s.check("events.jsonl and workspace.yaml are still written (the app reads them: usage, last activity, fork, cut)", files.exists && files.eventsLines > 0 && files.files.includes("workspace.yaml"), files.exists ? `${files.eventsLines} lines; files: ${files.files.join(", ")}` : "no session-state directory");
        const fileTypes = Object.keys(files.eventTypes ?? {});
        s.check("events.jsonl keeps the event names the app parses (user.message, assistant.message)", fileTypes.includes("user.message") && fileTypes.includes("assistant.message"), fileTypes.join(", "));
        s.saveEvents("turn", w);
      } finally {
        await close(session);
      }
    },
  },

  {
    id: "agents",
    title: "Agents: select a company agent, an agent defined inline, an agent from an explicit folder",
    llm: true,
    async run(s) {
      const client = await getClient();
      // (a) a custom agent the runtime discovered for the repository
      const invocable = G.customAgents.filter((a) => a.userInvocable !== false);
      const wanted = G.opt.agent ? G.customAgents.find((a) => [a.name, a.id, a.displayName].some((x) => String(x ?? "").toLowerCase() === G.opt.agent.toLowerCase())) : invocable[0];
      if (G.opt.agent && !wanted) s.note(`--agent ${G.opt.agent} was not found among: ${G.customAgents.map((a) => a.name).join(", ") || "(none)"}`);
      if (wanted) {
        const { session, w } = await open(client, { cwd: G.cwd, policy: "read-only", extra: best() });
        try {
          s.data.discovered = { agent: wanted.name, source: wanted.source };
          s.data.discovered.select = await attempt("agent.select", () => session.rpc.agent.select({ name: wanted.name }));
          s.data.discovered.current = await attempt("agent.getCurrent", () => session.rpc.agent.getCurrent());
          const r = await turn(session, w, "In one short sentence: which agent or role are you acting as right now? Do not use any tools.");
          s.data.discovered.reply = cleanText(r.text, 300);
          s.data.discovered.agentEvents = [...new Set(w.events.filter((e) => /agent/i.test(e.type ?? "")).map((e) => e.type))];
          s.data.discovered.toolRequests = w.permissions.map((p) => p.kind);
          s.data.discovered.deselect = await attempt("agent.deselect", () => session.rpc.agent.deselect());
          s.check(`Company agent can be selected and answers (${wanted.name}, source ${wanted.source})`, s.data.discovered.select.ok && r.text.length > 0, s.data.discovered.select.error ?? cleanText(r.text, 140));
          s.saveEvents("agent-discovered", w);
        } finally {
          await close(session);
        }
      } else {
        s.check("Company agent can be selected and answers", null, "no custom agent was discovered in --cwd (see the discovery scenario)");
      }

      // (b) an agent the app passes inline: the fallback when the runtime does not discover company agents
      {
        const { session, w } = await open(client, {
          cwd: workspace("agent-inline"),
          extra: { agents: { definitions: [{ name: "probe-inline", displayName: "Probe inline", description: "Probe agent", prompt: "You are the probe agent. Whatever the user writes, reply with exactly: QUOKKA-9", tools: [] }], selected: "probe-inline" } },
        });
        try {
          s.data.inline = { current: await attempt("agent.getCurrent", () => session.rpc.agent.getCurrent()) };
          const r = await turn(session, w, "Hello, who are you?");
          s.data.inline.reply = cleanText(r.text, 200);
          s.check("Agent passed inline (agents.definitions + selected) is used", has(r.text, "QUOKKA-9"), cleanText(r.text, 120));
        } finally {
          await close(session);
        }
      }

      // (c) an agent file in a folder the app names explicitly
      {
        const dir = workspace("agent-dir");
        const agents = path.join(dir, "agents");
        fs.mkdirSync(agents, { recursive: true });
        fs.writeFileSync(path.join(agents, "probe-dir.agent.md"), "---\nname: probe-dir\ndescription: Probe agent loaded from an explicit folder\n---\n\nYou are the probe agent. Whatever the user writes, reply with exactly: WOMBAT-3\n");
        const { session, w } = await open(client, { cwd: dir, extra: { agents: { directories: [agents] } } });
        try {
          const list = await attempt("agent.list", () => session.rpc.agent.list({}));
          const found = (list.result?.agents ?? []).find((a) => a.name === "probe-dir");
          s.data.directory = { listed: Boolean(found), source: found?.source, listError: list.error };
          if (found) {
            s.data.directory.select = await attempt("agent.select", () => session.rpc.agent.select({ name: "probe-dir" }));
            const r = await turn(session, w, "Hello, who are you?");
            s.data.directory.reply = cleanText(r.text, 200);
            s.check("Agent from an explicit folder (agents.directories) is listed and used", has(r.text, "WOMBAT-3"), cleanText(r.text, 120));
          } else {
            s.check("Agent from an explicit folder (agents.directories) is listed and used", false, list.error ?? "not listed");
          }
        } finally {
          await close(session);
        }
      }
    },
  },

  {
    id: "prompts",
    title: "Session prompt (the app's own instructions): env variable as today, instructions.directories, systemMessage",
    llm: true,
    async run(s) {
      const ask = "What is the probe code word from your instructions? Answer with the code word only, or NONE. Do not use any tools.";
      const promptDir = (word) => {
        const dir = workspace("prompt");
        const inst = path.join(dir, ".github", "instructions");
        fs.mkdirSync(inst, { recursive: true });
        fs.writeFileSync(path.join(inst, "session.instructions.md"), `The probe code word is ${word}. When asked for the probe code word, answer with it.\n`);
        return dir;
      };
      const run = async (label, word, client, extra) => {
        const { session, w } = await open(client, { cwd: workspace("prompt-ws"), extra });
        try {
          const r = await turn(session, w, ask);
          s.data[label] = { reply: cleanText(r.text, 120), instructionEvents: w.of("instruction.update").length };
          return has(r.text, word);
        } finally {
          await close(session);
        }
      };
      // (a) exactly what the app does today: COPILOT_CUSTOM_INSTRUCTIONS_DIRS on the process. One process per session.
      const dirA = promptDir("ZEBRA-7");
      const user = process.env.COPILOT_CUSTOM_INSTRUCTIONS_DIRS;
      const own = await getClient("coding-agent", { fresh: true, env: { ...process.env, COPILOT_CUSTOM_INSTRUCTIONS_DIRS: user ? `${user},${dirA}` : dirA } });
      try {
        s.check("Session prompt through COPILOT_CUSTOM_INSTRUCTIONS_DIRS on the runtime process (as today)", await run("env", "ZEBRA-7", own, {}), s.data.env?.reply);
      } finally {
        await stopClient(own);
      }
      // (b) and (c): per session, so several sessions could share one runtime process
      const client = await getClient();
      s.check("Session prompt through instructions.directories (per session)", await run("directories", "OKAPI-5", client, { instructions: { directories: [promptDir("OKAPI-5")] } }), s.data.directories?.reply);
      s.check("Session prompt through systemMessage append (per session)", await run("systemMessage", "LEMUR-2", client, { systemMessage: { mode: "append", content: "The probe code word is LEMUR-2. When asked for the probe code word, answer with it." } }), s.data.systemMessage?.reply);
    },
  },

  {
    id: "permissions",
    title: "Permissions: delayed answer, reject with feedback, remember for the session, pending request answered later",
    llm: true,
    async run(s) {
      const client = await getClient();
      const dir = workspace("perm");
      const shellPrompt = "Run this exact shell command and report its output in one line: node --version";

      // (a) the handler answers after a delay, as a person clicking a card does
      {
        const { session, w } = await open(client, { cwd: dir, policy: async () => (await sleep(10_000), { kind: "approve-once" }) });
        try {
          const r = await turn(session, w, shellPrompt);
          const kinds = w.permissions.map((p) => p.kind);
          s.data.shell = { reply: cleanText(r.text, 160), kinds, request: w.permissions[0]?.request, requestKeys: w.permissions[0]?.keys, permissionEvents: [...new Set(w.events.filter((e) => /permission/.test(e.type ?? "")).map((e) => e.type))], toolEvents: [...new Set(w.events.filter((e) => /^tool\./.test(e.type ?? "")).map((e) => e.type))] };
          s.data.shell.toolStart = sanitize(w.of("tool.execution_start")[0]?.data, { depth: 3, max: 160 });
          s.data.shell.toolComplete = sanitize(w.of("tool.execution_complete")[0]?.data, { depth: 3, max: 160 });
          s.check("Shell command asks for permission and runs after an approval given 10 s later", kinds.includes("shell") && /v?\d+\.\d+/.test(r.text), `kinds: ${kinds.join(", ") || "none"}; reply: ${cleanText(r.text, 80)}`);
          s.check("Permission request says whether company policy requires a person (managedApprovalRequired)", null, `value: ${JSON.stringify(w.permissions[0]?.managedApprovalRequired)}`);
          s.saveEvents("permission-shell", w);

          // (b) reject with a text for the model
          const file = path.join(dir, "probe-write.txt");
          const reject = await (async () => {
            const { session: s2, w: w2 } = await open(client, { cwd: dir, policy: (req) => (req.kind === "read" ? { kind: "approve-once" } : { kind: "reject", feedback: "Denied by the probe with code REJECT-51. Do not retry; report the denial code." }) });
            try {
              const r2 = await turn(s2, w2, "Create a file named probe-write.txt in the current directory containing the single word hello. Then tell me in one line what happened.");
              return { reply: cleanText(r2.text, 200), kinds: w2.permissions.map((p) => p.kind), request: w2.permissions.find((p) => p.kind !== "read")?.request, fileExists: fs.existsSync(file) };
            } finally {
              await close(s2);
            }
          })();
          s.data.reject = reject;
          s.check("Rejected write does not happen", reject.kinds.some((k) => k !== "read") && !reject.fileExists, `kinds: ${reject.kinds.join(", ") || "none"}; file exists: ${reject.fileExists}`);
          s.check("Reject feedback reaches the model", has(reject.reply, "REJECT-51"), reject.reply);
        } finally {
          await close(session);
        }
      }

      // (c) approve for the session: the decision carries the rule to remember, built from the request
      {
        const rule = (req) => (req.kind === "shell" ? { kind: "commands", commandIdentifiers: (req.commands ?? []).map((c) => c.identifier) } : undefined);
        const { session, w } = await open(client, { cwd: dir, policy: (req) => ({ kind: "approve-for-session", ...(rule(req) ? { approval: rule(req) } : {}) }) });
        try {
          await turn(session, w, shellPrompt);
          const first = w.permissions.length;
          await turn(session, w, shellPrompt);
          s.data.forSession = { firstTurnRequests: first, secondTurnRequests: w.permissions.length - first, results: w.permissions.map((p) => p.result), canOfferSessionApproval: w.permissions[0]?.request?.canOfferSessionApproval ?? null };
          s.check("approve-for-session with a rule is remembered (no second question)", first > 0 && w.permissions.length === first, `requests: first turn ${first}, second turn ${w.permissions.length - first}; rule: ${JSON.stringify(w.permissions[0]?.result?.approval ?? null)}`);
        } catch (e) {
          s.data.forSession = { error: errorInfo(e) };
          s.check("approve-for-session with a rule is remembered (no second question)", false, cleanText(e.message, 200));
        } finally {
          await close(session);
        }
      }

      // (d1) no handler at all: does the request wait for an answer, or is it denied at once?
      {
        const { session, w } = await open(client, { cwd: dir, policy: null });
        try {
          const from = w.mark();
          await session.send({ prompt: shellPrompt });
          const ev = await w.waitFor((e) => e.type === "permission.requested" || e.type === "session.idle", G.opt.turnTimeout, from);
          const failure = w.of("tool.execution_complete", from).find((e) => e.data?.success === false)?.data?.error?.message;
          s.data.noHandler = { firstEvent: ev.type, toolError: cleanText(failure ?? "", 200), reply: cleanText(w.text(from), 160) };
          s.check("Without a permission handler the request", null, ev.type === "permission.requested" ? "stays pending (permission.requested event)" : `is denied at once: ${cleanText(failure ?? w.text(from), 140)}`);
        } finally {
          await session.abort().catch(() => {});
          await close(session);
        }
      }

      // (d2) the handler declines to answer ("no-result") and the answer comes later through RPC: the path for an
      // answer given outside the handler, for example by another process
      {
        const { session, w } = await open(client, { cwd: dir, policy: () => ({ kind: "no-result" }) });
        try {
          const from = w.mark();
          await session.send({ prompt: shellPrompt });
          const ev = await w.waitFor("permission.requested", G.opt.turnTimeout, from);
          await sleep(2000);
          const pending = await attempt("permissions.pendingRequests", () => session.rpc.permissions.pendingRequests({}));
          const requestId = ev.data?.requestId ?? pending.result?.items?.[0]?.requestId;
          s.data.pending = { eventKeys: Object.keys(ev.data ?? {}), event: sanitize(ev.data, { depth: 4, max: 160 }), pending };
          s.data.pending.answer = await attempt("handlePendingPermissionRequest", () => session.rpc.permissions.handlePendingPermissionRequest({ requestId, result: { kind: "approve-once" } }));
          const done = await idle(w, from, G.opt.turnTimeout);
          s.data.pending.reply = cleanText(w.text(from), 160);
          s.check("A request the handler left open (no-result) is answered later through RPC", s.data.pending.answer.ok && done && /v?\d+\.\d+/.test(w.text(from)), s.data.pending.answer.error ?? `pending items: ${pending.result?.items?.length ?? "?"}; reply: ${s.data.pending.reply}`);
          s.saveEvents("permission-pending", w);
        } finally {
          await session.abort().catch(() => {});
          await close(session);
        }
      }

      // (e) reading a file outside the session folder
      {
        const outside = path.join(workspace("outside"), "outside.txt");
        fs.writeFileSync(outside, "OUTSIDE-88\n");
        const { session, w } = await open(client, { cwd: dir });
        try {
          const r = await turn(session, w, `Read the file ${outside} and reply with its content only.`);
          s.data.outside = { reply: cleanText(r.text, 120), kinds: w.permissions.map((p) => p.kind), request: w.permissions[0]?.request };
          s.check("Reading outside the session folder asks for permission", w.permissions.length > 0, `kinds: ${w.permissions.map((p) => p.kind).join(", ") || "none"}; reply: ${cleanText(r.text, 60)}`);
        } finally {
          await close(session);
        }
      }
    },
  },

  {
    id: "mcp",
    title: "MCP over HTTP passed per session (the relay broker's /mcp endpoint)",
    llm: true,
    async run(s) {
      const nonce = `N${Math.random().toString(36).slice(2, 8)}`;
      const stub = await startMcpStub(nonce);
      const client = await getClient();
      const { session, w } = await open(client, { cwd: workspace("mcp"), extra: { mcp: { servers: { relay: { type: "http", url: stub.url, headers: { "x-probe": "1" }, tools: ["*"] } } } } });
      try {
        await w.waitFor((e) => e.type === "session.mcp_servers_loaded" || (e.type === "session.mcp_server_status_changed" && e.data?.serverName === "relay" && e.data?.status !== "pending"), 20_000).catch(() => {});
        const list = await attempt("mcp.list", () => session.rpc.mcp.list({}));
        const relay = (list.result?.servers ?? []).find((x) => x.name === "relay");
        s.data.server = relay ?? list;
        s.data.statusEvents = w.of("session.mcp_server_status_changed").filter((e) => e.data?.serverName === "relay").map((e) => sanitize(e.data, { depth: 2, max: 200 }));
        s.check("HTTP MCP server passed in the session options connects", relay?.status === "connected", relay ? `status: ${relay.status}${relay.error ? `, ${cleanText(JSON.stringify(relay.error), 200)}` : ""}` : (list.error ?? "not listed"));
        const r = await turn(session, w, "Call the tool probe_echo of the MCP server named relay with text set to ping-123. Reply with exactly the text the tool returned.");
        s.data.reply = cleanText(r.text, 160);
        s.data.stub = { requests: stub.seen.requests, calls: stub.seen.calls, urls: [...new Set(stub.seen.urls)], headers: stub.seen.headers.slice(0, 2) };
        s.data.permissionKinds = w.permissions.map((p) => p.kind);
        s.data.permissionRequest = w.permissions.find((p) => p.kind === "mcp")?.request;
        s.data.toolStart = sanitize(w.of("tool.execution_start").at(-1)?.data, { depth: 3, max: 160 });
        s.check("The model calls the MCP tool and gets its result", stub.seen.calls.length > 0 && has(r.text, nonce), `calls: ${stub.seen.calls.length}; reply: ${cleanText(r.text, 80)}`);
        s.check("MCP tool call asks for permission (kind mcp)", w.permissions.some((p) => p.kind === "mcp"), `kinds: ${s.data.permissionKinds.join(", ") || "none"}`);
        s.check("Custom headers and the URL query reach the MCP server", stub.seen.headers.some((h) => h["x-probe"] === "1") && stub.seen.urls.some((u) => u.includes("peer=probe-alias")), JSON.stringify(s.data.stub.urls));
        s.saveEvents("mcp", w);
      } finally {
        await close(session);
        await stub.close();
      }
    },
  },

  {
    id: "abort",
    title: "Cancel a running turn (session/cancel) and continue in the same session",
    llm: true,
    async run(s) {
      const client = await getClient();
      const { session, w } = await open(client, { cwd: workspace("abort") });
      try {
        const from = w.mark();
        await session.send({ prompt: LONG_PROMPT });
        await started(w, from);
        const t0 = Date.now();
        s.data.abort = await attempt("session.abort", () => session.abort());
        const done = await idle(w, from, 30_000);
        s.data.idleAfterMs = done ? Date.now() - t0 : null;
        s.data.eventsAfterAbort = w.histogram(from);
        s.data.abortEvents = w.events.slice(from).filter((e) => /abort|cancel|interrupt/i.test(e.type ?? "")).map((e) => ({ type: e.type, data: sanitize(e.data, { depth: 2, max: 100 }) }));
        const text = w.text(from);
        s.check("abort() stops the running turn", s.data.abort.ok && done && !/\b250\b/.test(text), done ? `idle after ${s.data.idleAfterMs} ms` : "the session did not report idle within 30 s");
        const r = await turn(session, w, "Reply with exactly: AFTER-ABORT. Do not use any tools.");
        s.check("The session works after an abort", has(r.text, "AFTER-ABORT"), cleanText(r.text, 80));
        s.saveEvents("abort", w);
      } finally {
        await close(session);
      }
    },
  },

  {
    id: "queue",
    title: "Messages sent while a turn runs: queue, take back from the queue, steering",
    llm: true,
    async run(s) {
      const client = await getClient();
      const { session, w } = await open(client, { cwd: workspace("queue") });
      try {
        const from = w.mark();
        await session.send({ prompt: LONG_PROMPT });
        await started(w, from);
        const p1 = "Reply with exactly: QUEUED-ONE. Do not use any tools.";
        const p2 = "Reply with exactly: QUEUED-TWO. Do not use any tools.";
        const id1 = await session.send({ prompt: p1, mode: "enqueue" });
        const id2 = await session.send({ prompt: p2, mode: "enqueue" });
        s.data.sendReturns = { id1: typeof id1, id2: typeof id2 };
        s.data.pendingItems = await attempt("queue.pendingItems", () => session.rpc.queue.pendingItems({}));
        s.data.withdraw = await attempt("queue.withdrawMessage", () => session.rpc.queue.withdrawMessage({ messageId: id2, expectedPrompt: p2 }));
        if (!s.data.withdraw.ok || s.data.withdraw.result?.removed === false) s.data.removeMostRecent = await attempt("queue.removeMostRecent", () => session.rpc.queue.removeMostRecent({}));
        s.data.pendingAfterWithdraw = await attempt("queue.pendingItems", () => session.rpc.queue.pendingItems({}));
        const steerAt = w.mark();
        s.data.steer = await attempt("send immediate", () => session.send({ prompt: "Stop counting now. End your current answer with the word STEERED.", mode: "immediate" }));
        await w.waitFor((e) => e.type === "assistant.message" && has(e.data?.content, "QUEUED-ONE"), G.opt.turnTimeout, from).catch(() => {});
        await idle(w, w.events.findLastIndex((e) => e.type === "assistant.message"), 60_000);
        await sleep(1500);
        const text = w.text(from);
        s.data.userMessages = w.of("user.message", from).map((e) => ({ content: cleanText(e.data?.content, 60), delivery: e.data?.delivery, source: e.data?.source }));
        s.data.queueEvents = [...new Set(w.events.slice(from).filter((e) => /queue|pending|steer/i.test(e.type ?? "")).map((e) => e.type))];
        s.data.steeringSeen = w.events.slice(steerAt).some((e) => e.type === "user.message" && has(e.data?.content, "STEERED"));
        s.check("A message queued during a turn runs after it (mode enqueue)", has(text, "QUEUED-ONE"), s.data.pendingItems.ok ? `pending items seen: ${s.data.pendingItems.result?.items?.length ?? "?"}` : s.data.pendingItems.error);
        s.check("A queued message can be taken back before it runs", !has(text, "QUEUED-TWO") && (s.data.withdraw.result?.removed === true || s.data.removeMostRecent?.ok === true), s.data.withdraw.ok ? JSON.stringify(s.data.withdraw.result) : s.data.withdraw.error);
        // a text-only turn has no tool call to inject at, so "immediate" may only jump the queue: that is a fact
        // to read, not proof of steering. Only a delivery other than "queued" or "idle" counts as injected.
        const steered = s.data.userMessages.find((m) => has(m.content, "Stop counting"));
        const injected = Boolean(steered) && !["queued", "idle"].includes(steered.delivery);
        s.check("A message sent with mode immediate is accepted", s.data.steer.ok && Boolean(steered), s.data.steer.error ?? `delivery: ${steered?.delivery ?? "never delivered"}`);
        s.check("… and is injected into the running turn (not only moved to the front of the queue)", injected ? true : null, injected ? `delivery: ${steered.delivery}` : `not shown: delivered as "${steered?.delivery ?? "?"}", ${s.data.userMessages.findIndex((m) => m === steered) < s.data.userMessages.findIndex((m) => has(m.content, "QUEUED-ONE")) ? "before" : "after"} the queued message`);
        s.saveEvents("queue", w);
      } finally {
        await session.abort().catch(() => {});
        await close(session);
      }
    },
  },

  {
    id: "resume",
    title: "Resume: same runtime, after a runtime restart (app restart), and the same session through ACP",
    llm: true,
    async run(s) {
      const dir = workspace("resume");
      const client = await getClient("coding-agent", { fresh: true });
      let id;
      try {
        const { session, w } = await open(client, { cwd: dir });
        id = session.sessionId;
        const r = await turn(session, w, "Remember the code word MANGO-4. Reply with exactly: STORED. Do not use any tools.");
        s.data.stored = cleanText(r.text, 60);
        await close(session);
        // warm: the same runtime process
        const w2 = watcher();
        const again = await withTimeout(client.resumeSession(id, resumeOptions(w2, { cwd: dir })), 90_000, "resumeSession (warm)");
        const ev = await again.getEvents();
        s.data.warm = { events: ev.length, types: [...new Set(ev.map((e) => e.type))], replayedThroughOnEvent: w2.events.length };
        s.check("Session resumes in the same runtime and returns its history (getEvents)", ev.some((e) => e.type === "user.message") && ev.some((e) => e.type === "assistant.message"), `${ev.length} events`);
        await close(again);
      } finally {
        await stopClient(client);
      }
      // cold: a new runtime process, as after an app restart
      const client2 = await getClient("coding-agent", { fresh: true });
      try {
        const w3 = watcher();
        const cold = await withTimeout(client2.resumeSession(id, resumeOptions(w3, { cwd: dir })), 90_000, "resumeSession (cold)");
        s.data.cold = { transcriptRecovery: sanitize(cold.transcriptRecovery ?? null), eventsBeforeTurn: w3.histogram() };
        const r = await turn(cold, w3, "What code word did I ask you to remember? Reply with the code word only. Do not use any tools.");
        s.data.cold.reply = cleanText(r.text, 80);
        s.check("Session resumes after a runtime restart with its context", has(r.text, "MANGO-4"), cleanText(r.text, 80));
        await close(cold);
      } finally {
        await stopClient(client2);
      }
      // the same session through ACP: old and new app versions could work on the same sessions
      const acp = new Acp({ command: G.cli.command, cwd: dir });
      try {
        await withTimeout(acp.start(), 60_000, "ACP initialize");
        await withTimeout(acp.request("session/load", { sessionId: id, cwd: dir, mcpServers: [] }), 90_000, "ACP session/load");
        await sleep(500);
        const kinds = {};
        for (const n of acp.notifications) kinds[n.params?.update?.sessionUpdate ?? n.method] = (kinds[n.params?.update?.sessionUpdate ?? n.method] ?? 0) + 1;
        s.data.acpLoad = kinds;
        s.check("A session created through the SDK loads through ACP (mixed use is possible)", (kinds.user_message_chunk ?? 0) > 0 && (kinds.agent_message_chunk ?? 0) > 0, JSON.stringify(kinds));
      } catch (e) {
        s.data.acpLoad = { error: errorInfo(e) };
        s.check("A session created through the SDK loads through ACP (mixed use is possible)", false, cleanText(e.message, 200));
      } finally {
        await acp.kill();
      }
    },
  },

  {
    id: "history",
    title: "Fork a session at a message and cut the history at a message (today: the app edits events.jsonl)",
    llm: true,
    async run(s) {
      const dir = workspace("history");
      const client = await getClient();
      const ask = "List every code word I asked you to remember so far, comma separated, nothing else. Do not use any tools.";
      const { session, w } = await open(client, { cwd: dir });
      const id = session.sessionId;
      try {
        await turn(session, w, "Remember the code word ALPHA-1. Reply with exactly: STORED-1. Do not use any tools.");
        await turn(session, w, "Remember the code word BRAVO-2. Reply with exactly: STORED-2. Do not use any tools.");
        const events = await session.getEvents();
        const users = events.filter((e) => e.type === "user.message");
        s.data.userMessageIds = users.map((e) => Boolean(e.id));
        const second = users[1];
        if (!second?.id) throw new Error("the second user.message has no event id to fork or cut at");
        s.data.rewindPoints = await attempt("history.listRewindPoints", () => session.rpc.history.listRewindPoints({}));
        s.data.linesBefore = sessionFiles(id).eventsLines;

        // fork at the second message: the copy must know ALPHA-1 only
        s.data.fork = await attempt("sessions.fork", () => client.rpc.sessions.fork({ sessionId: id, toEventId: second.id, name: "sdk-probe fork" }));
        const forkId = s.data.fork.result?.sessionId;
        if (forkId) {
          G.sessions.add(forkId);
          const wf = watcher();
          const fork = await withTimeout(client.resumeSession(forkId, resumeOptions(wf, { cwd: dir })), 90_000, "resumeSession (fork)");
          try {
            const r = await turn(fork, wf, ask);
            s.data.forkReply = cleanText(r.text, 100);
            s.data.forkFiles = sessionFiles(forkId);
            s.check("Fork at a message: the copy has the history before that message only", has(r.text, "ALPHA-1") && !has(r.text, "BRAVO-2"), cleanText(r.text, 100));
          } finally {
            await close(fork);
          }
        } else {
          s.check("Fork at a message: the copy has the history before that message only", false, s.data.fork.error ?? "no session id returned");
        }
        const parentAfterFork = await session.getEvents();
        const messages = (list) => list.filter((e) => e.type === "user.message" || e.type === "assistant.message").length;
        const added = parentAfterFork.slice(events.length).map((e) => e.type);
        s.check("Fork leaves the source session's messages untouched", messages(parentAfterFork) === messages(events), `${events.length} -> ${parentAfterFork.length} events${added.length ? `; added to the source: ${added.join(", ")}` : ""}`);

        // cut the source session at the second message
        s.data.truncate = await attempt("history.truncate", () => session.rpc.history.truncate({ eventId: second.id }));
        const after = await session.getEvents();
        s.data.eventsAfterTruncate = { before: events.length, after: after.length };
        const r = await turn(session, w, ask);
        s.data.truncateReply = cleanText(r.text, 100);
        s.data.linesAfter = sessionFiles(id).eventsLines;
        s.data.filesAfter = sessionFiles(id).files;
        s.check("Cut at a message on a live session: later turns are forgotten", s.data.truncate.ok && has(r.text, "ALPHA-1") && !has(r.text, "BRAVO-2"), s.data.truncate.error ?? `removed ${s.data.truncate.result?.eventsRemoved} events; reply: ${cleanText(r.text, 80)}`);
        s.saveEvents("history", w);
      } finally {
        await close(session);
      }
    },
  },

  {
    id: "attachments",
    title: "Attachments: a pasted image (blob) and a file",
    llm: true,
    async run(s) {
      const dir = workspace("attach");
      const note = path.join(dir, "note.txt");
      fs.writeFileSync(note, "The secret word in this file is PLATYPUS-6.\n");
      const client = await getClient();
      const { session, w } = await open(client, { cwd: dir });
      try {
        const image = await attempt("turn with image", () => turn(session, w, { prompt: "What is the dominant colour of the attached image? Answer with one word. Do not use any tools.", attachments: [{ type: "blob", data: solidPng(32, [220, 20, 20]).toString("base64"), mimeType: "image/png", displayName: "probe.png" }] }), G.opt.turnTimeout + 20_000);
        s.data.image = image.ok ? { reply: image.result.text } : image;
        s.check("Image attachment (base64 blob, as the app pastes images) is seen by the model", image.ok && has(image.result.text, "red"), image.ok ? image.result.text : image.error);
        const file = await attempt("turn with file", () => turn(session, w, { prompt: "What is the secret word in the attached file? Answer with the word only.", attachments: [{ type: "file", path: note, displayName: "note.txt" }] }), G.opt.turnTimeout + 20_000);
        s.data.file = file.ok ? { reply: file.result.text, permissionKinds: w.permissions.map((p) => p.kind) } : file;
        s.check("File attachment is read", file.ok && has(file.result.text, "PLATYPUS-6"), file.ok ? file.result.text : file.error);
        s.data.userMessageAttachments = sanitize(w.of("user.message").map((e) => e.data?.attachments), { depth: 4, max: 60 });
      } finally {
        await close(session);
      }
    },
  },

  {
    id: "subagents",
    title: "Sub-agents: events the app's sub-session tree and activity groups need",
    llm: true,
    async run(s) {
      const dir = workspace("sub");
      for (const n of ["one.txt", "two.txt", "three.txt"]) fs.writeFileSync(path.join(dir, n), `${n}\n`);
      const client = await getClient();
      const { session, w } = await open(client, { cwd: dir, extra: { events: { includeSubAgentStreamingEvents: true } } });
      try {
        const r = await turn(session, w, "Delegate this to a sub-agent with the task tool (use the explore agent): count the .txt files in the current directory. Then reply with the number only.", { timeout: G.opt.turnTimeout * 2 });
        const sub = w.events.filter((e) => /subagent/i.test(e.type ?? ""));
        s.data.reply = cleanText(r.text, 80);
        s.data.subagentEventTypes = [...new Set(sub.map((e) => e.type))];
        s.data.subagentSample = sanitize(sub[0]?.data, { depth: 3, max: 160 });
        s.data.eventsWithAgentId = w.events.filter((e) => e.raw?.agentId || e.data?.agentId).length;
        s.data.eventsWithParentToolCallId = w.events.filter((e) => e.data?.parentToolCallId).length;
        s.data.toolNames = [...new Set(w.of("tool.execution_start").map((e) => e.data?.toolName))];
        s.data.eventTypes = w.histogram();
        s.check("Sub-agent start and end are reported as events", s.data.subagentEventTypes.length > 0, s.data.subagentEventTypes.join(", ") || `no subagent events; tools used: ${s.data.toolNames.join(", ")}`);
        s.check("Sub-agent activity can be tied to its parent tool call", s.data.eventsWithParentToolCallId > 0 || s.data.eventsWithAgentId > 0, `events with parentToolCallId: ${s.data.eventsWithParentToolCallId}, with agentId: ${s.data.eventsWithAgentId}`);
        s.saveEvents("subagents", w);
      } finally {
        await close(session);
      }
    },
  },

  {
    id: "ask-user",
    title: "Questions from the agent to the user (ask_user), which ACP does not pass to the app",
    llm: true,
    async run(s) {
      const asked = [];
      const client = await getClient();
      const { session, w } = await open(client, {
        cwd: workspace("ask"),
        extra: { interaction: { onUserInputRequest: async (request) => (asked.push(sanitize(request, { depth: 3, max: 200 })), { answer: "teal", wasFreeform: true }) } },
      });
      try {
        const r = await turn(session, w, "Use the ask_user tool to ask me what my favourite colour is. Then reply with exactly my answer.");
        s.data.requests = asked;
        s.data.reply = cleanText(r.text, 80);
        s.check("The agent can ask the user a question and gets the answer", asked.length > 0 && has(r.text, "teal"), asked.length ? `question: ${cleanText(asked[0]?.question, 80)}` : `no question arrived; reply: ${cleanText(r.text, 80)}`);
      } finally {
        await close(session);
      }
    },
  },

  {
    id: "crash",
    title: "Runtime killed in the middle of a turn: resume in a new runtime",
    llm: true,
    async run(s) {
      const dir = workspace("crash");
      const client = await getClient("coding-agent", { fresh: true });
      let id;
      try {
        const { session, w } = await open(client, { cwd: dir });
        id = session.sessionId;
        await turn(session, w, "Remember the code word KIWI-8. Reply with exactly: STORED. Do not use any tools.");
        const from = w.mark();
        await session.send({ prompt: LONG_PROMPT });
        await started(w, from);
      } finally {
        await stopClient(client, { force: true });
      }
      const client2 = await getClient("coding-agent", { fresh: true });
      try {
        const w2 = watcher();
        const session = await withTimeout(client2.resumeSession(id, resumeOptions(w2, { cwd: dir })), 90_000, "resumeSession after a kill");
        s.data.transcriptRecovery = sanitize(session.transcriptRecovery ?? null);
        s.data.eventsOnResume = w2.histogram();
        const r = await turn(session, w2, "What code word did I ask you to remember? Reply with the code word only. Do not use any tools.");
        s.data.reply = cleanText(r.text, 80);
        s.check("After the runtime is killed mid-turn the session resumes and keeps its context", has(r.text, "KIWI-8"), cleanText(r.text, 80));
        await close(session);
      } finally {
        await stopClient(client2);
      }
    },
  },

  {
    id: "cleanup",
    title: "Delete the probe's sessions (deleteSession instead of removing files by hand)",
    async run(s) {
      if (G.opt.keep) throw new Skip("--keep: the probe's sessions and temporary folders stay");
      for (const c of [...G.clients.values(), ...G.extraClients]) await stopClient(c);
      const client = await getClient("coding-agent", { fresh: true });
      const result = { deleted: 0, failed: [], leftOnDisk: [] };
      try {
        for (const id of G.sessions) {
          try {
            await withTimeout(client.deleteSession(id), 30_000, "deleteSession");
            result.deleted++;
          } catch (e) {
            // a session that was never stored (no prompt) has nothing to delete
            if (sessionFiles(id).exists) result.failed.push({ id, error: cleanText(e.message, 200) });
          }
        }
        await sleep(500);
        for (const id of G.sessions) if (sessionFiles(id).exists) result.leftOnDisk.push(id);
        const left = (await client.listSessions().catch(() => [])).filter((m) => G.sessions.has(m.sessionId)).map((m) => m.sessionId);
        result.stillListed = left;
        s.data.result = result;
        s.data.acpSessionDeleted = G.acp?.sessionId ? !sessionFiles(G.acp.sessionId).exists : null;
        s.check("deleteSession removes the session from disk and from the list", result.failed.length === 0 && result.leftOnDisk.length === 0 && left.length === 0, `${result.deleted} of ${G.sessions.size} deleted; left on disk: ${result.leftOnDisk.length}; still listed: ${left.length}`);
        // what the SDK could not remove is removed the way the app does it today, so the probe leaves nothing behind
        for (const id of result.leftOnDisk) rmrf(path.join(G.copilotHome, "session-state", id));
      } finally {
        await stopClient(client);
      }
      s.data.tmpRemoved = cleanupTmp();
    },
  },
];
