// Scenarios that cost no model requests: environment, ACP baseline, runtime start, discovery, listing, settings.
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Acp, cleanText, cliVersion, errorInfo, isWin, sanitize, sleep, summarizeConfigOptions, withTimeout } from "./lib.mjs";
import { G, Skip, close, getClient, open, rpcInventory, sessionFiles, workspace } from "./core.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const lower = (x) => String(x ?? "").toLowerCase();

function listNames(dir, re) {
  try {
    return fs.readdirSync(dir).filter((n) => re.test(n)).slice(0, 60);
  } catch {
    return null;
  }
}

/** Runs `probe.mjs --variant-check <name>` in a child process, so a crashing runtime cannot take the probe down. */
function variantCheck(name) {
  return new Promise((resolve) => {
    const args = [path.join(here, "probe.mjs"), "--variant-check", name];
    if (G.opt.cli) args.push("--cli", G.opt.cli);
    const child = spawn(process.execPath, args, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err = (err + d).slice(-3000)));
    const timer = setTimeout(() => child.kill(), 120_000);
    child.on("error", (e) => resolve({ ok: false, error: errorInfo(e) }));
    child.on("exit", (code, signal) => {
      clearTimeout(timer);
      const m = out.match(/@@VARIANT@@(.*)/);
      if (m) {
        try {
          resolve(JSON.parse(m[1]));
          return;
        } catch {}
      }
      resolve({ ok: false, error: { message: `child exited (${code ?? signal}) without a result`, stderr: cleanText(err.trim(), 600) } });
    });
  });
}

/** What one session sees: agents, MCP servers, skills, managed settings. */
async function describeSession(session, w) {
  const out = {};
  // MCP servers and skills load in the background after the session starts (lazily without config discovery)
  await w.waitFor("session.mcp_servers_loaded", 3500).catch(() => {});
  try {
    const { agents = [] } = await withTimeout(session.rpc.agent.list({ includeBuiltInAgents: true }), 15_000, "agent.list");
    out.agents = agents.map((a) => ({ name: a.name, id: a.id, displayName: a.displayName, source: a.source, userInvocable: a.userInvocable, hasPath: Boolean(a.path), model: a.model }));
  } catch (e) {
    out.agentsError = cleanText(e.message, 300);
  }
  try {
    const { servers = [] } = await withTimeout(session.rpc.mcp.list({}), 15_000, "mcp.list");
    out.mcpServers = servers.map((x) => ({ name: x.name, status: x.status, source: x.source ?? x.configSource }));
  } catch (e) {
    out.mcpError = cleanText(e.message, 300);
  }
  const updated = w.of("session.custom_agents_updated").at(-1)?.data;
  if (updated) out.customAgentsEvent = sanitize(updated, { depth: 4, max: 120, items: 40 });
  try {
    const { skills = [] } = await withTimeout(session.rpc.skills.list({}), 15_000, "skills.list");
    out.skills = skills.map((x) => ({ name: x.name, source: x.source })).slice(0, 80);
  } catch (e) {
    out.skillsError = cleanText(e.message, 300);
  }
  try {
    const { sources = [] } = await withTimeout(session.rpc.instructions.getSources({}), 15_000, "instructions.getSources");
    out.instructionSources = sources.map((x) => sanitize({ type: x.type, location: x.location, label: x.label, path: x.sourcePath ?? x.path, id: x.id }, { max: 140 })).slice(0, 40);
  } catch (e) {
    out.instructionsError = cleanText(e.message, 300);
  }
  const managed = w.of("session.managed_settings_resolved").at(-1)?.data;
  if (managed) out.managedSettings = sanitize(managed, { depth: 3, max: 160 });
  out.eventTypesBeforeFirstTurn = w.histogram();
  return out;
}

const customOf = (d) => (d?.agents ?? []).filter((a) => a.source !== "builtin");

export const freeScenarios = [
  {
    id: "env",
    title: "Environment: Node, SDK, installed CLI, repository under test",
    async run(s) {
      const pkg = JSON.parse(fs.readFileSync(path.join(here, "node_modules", "@microsoft", "copilot-sdk", "package.json"), "utf8"));
      s.data.node = process.version;
      s.data.platform = `${process.platform} ${process.arch} ${os.release()}`;
      s.data.sdk = { name: pkg.name, version: pkg.version, bundledCliVersion: pkg.copilotCliVersion, protocolVersion: G.sdkProtocolVersion };
      s.data.cli = sanitize(G.cli);
      s.data.cliVersion = cliVersion(G.cli.command);
      s.data.copilotHome = cleanText(G.copilotHome);
      // names only, never values
      const watched = ["HTTPS_PROXY", "HTTP_PROXY", "NO_PROXY", "NODE_EXTRA_CA_CERTS", "COPILOT_HOME", "COPILOT_CLI_PATH", "COPILOT_PATH", "GH_HOST", "GH_TOKEN", "GITHUB_TOKEN", "COPILOT_GITHUB_TOKEN", "COPILOT_CUSTOM_INSTRUCTIONS_DIRS"];
      s.data.envSet = watched.filter((n) => process.env[n]);
      s.data.envUnset = watched.filter((n) => !process.env[n]);
      if (process.env.COPILOT_CUSTOM_INSTRUCTIONS_DIRS) s.note("COPILOT_CUSTOM_INSTRUCTIONS_DIRS is set: either in the user's environment, or because the probe was started from inside a Copilot session (for example by an agent in the app). Every probe session reads those instructions too, which can change the replies the turn scenarios check.");
      s.data.cwd = cleanText(G.cwd);
      s.data.repo = {
        isGitRepo: fs.existsSync(path.join(G.cwd, ".git")),
        agentFiles: listNames(path.join(G.cwd, ".github", "agents"), /\.md$/i),
        instructionFiles: listNames(path.join(G.cwd, ".github", "instructions"), /\.md$/i),
        copilotInstructions: fs.existsSync(path.join(G.cwd, ".github", "copilot-instructions.md")),
        agentsMd: fs.existsSync(path.join(G.cwd, "AGENTS.md")),
        skills: listNames(path.join(G.cwd, ".github", "skills"), /./),
      };
      s.data.user = {
        agentFiles: listNames(path.join(G.copilotHome, "agents"), /\.md$/i),
        extensions: listNames(path.join(G.copilotHome, "extensions"), /./),
        mcpConfig: fs.existsSync(path.join(G.copilotHome, "mcp-config.json")),
        plugins: listNames(path.join(G.copilotHome, "installed-plugins"), /./),
      };
      s.check("Copilot CLI found", G.cli.candidates.length > 0, cleanText(G.cli.command));
      s.check("CLI can be started without a shell (an executable, not only a .cmd shim)", Boolean(G.cli.executable), G.cli.executable ? "" : `script behind the shim: ${cleanText(G.cli.script ?? "not found")}`);
      if (isWin && !G.cli.executable) s.note("The SDK spawns the runtime without a shell. With an npm copilot.cmd the app would have to pass the .js entry (variant \"script\") or use the bundled runtime.");
    },
  },

  {
    id: "acp-baseline",
    title: "ACP baseline: what `copilot --acp --stdio` offers today (agents, models, modes)",
    async run(s) {
      const acp = new Acp({ command: G.cli.command, cwd: G.cwd });
      try {
        const init = await withTimeout(acp.start(), 60_000, "ACP initialize");
        s.data.initialize = sanitize({ protocolVersion: init?.protocolVersion, agentInfo: init?.agentInfo, agentCapabilities: init?.agentCapabilities, authMethods: (init?.authMethods ?? []).map((m) => m.id) }, { depth: 5 });
        const res = await withTimeout(acp.request("session/new", { cwd: G.cwd, mcpServers: [] }), 90_000, "ACP session/new");
        await sleep(3000); // available_commands_update and config_option_update arrive after the answer
        let options = summarizeConfigOptions(res?.configOptions);
        for (const n of acp.notifications) {
          const u = n.params?.update;
          if (u?.sessionUpdate === "config_option_update" && Array.isArray(u.configOptions)) options = summarizeConfigOptions(u.configOptions);
        }
        const pick = (re) => options.find((o) => re.test(`${o.id} ${o.category ?? ""}`)) ?? options.find((o) => re.test(o.name ?? ""));
        const agentOpt = pick(/agent/i);
        const modelOpt = pick(/model/i);
        const modeOpt = pick(/mode/i);
        const commands = acp.notifications.map((n) => n.params?.update).filter((u) => u?.sessionUpdate === "available_commands_update").at(-1)?.availableCommands ?? [];
        G.acp = {
          sessionId: res?.sessionId,
          agents: (agentOpt?.values ?? []).map((v) => ({ value: v.value, name: v.name })),
          models: (modelOpt?.values ?? []).map((v) => v.value),
          modes: (modeOpt?.values ?? []).map((v) => v.value),
          commands: commands.map((c) => c.name),
        };
        if (res?.sessionId) G.sessions.add(res.sessionId);
        s.data.sessionNewKeys = Object.keys(res ?? {});
        s.data.configOptions = sanitize(options.map((o) => ({ ...o, values: o.values.map((v) => `${v.value}${v.name && v.name !== v.value ? ` (${v.name})` : ""}`) })), { items: 80, max: 120 });
        s.data.agentOptionId = agentOpt?.id ?? null;
        s.data.commands = G.acp.commands.slice(0, 80);
        s.data.updateKinds = [...new Set(acp.notifications.map((n) => n.params?.update?.sessionUpdate ?? n.method))];
        try {
          const list = await withTimeout(acp.request("session/list", {}), 30_000, "ACP session/list");
          s.data.sessionList = { count: list?.sessions?.length ?? null, keys: Object.keys(list?.sessions?.[0] ?? {}) };
        } catch (e) {
          s.data.sessionListError = cleanText(e.message);
        }
        await Promise.race([acp.request("session/close", { sessionId: res?.sessionId }).catch(() => {}), sleep(2000)]);
        s.check("ACP session starts in the repository", Boolean(res?.sessionId));
        s.check("ACP offers an agent selector (config option \"agent\")", agentOpt ? true : null, agentOpt ? `${G.acp.agents.length} values` : "none: the CLI shows it only when it finds custom agents for this folder");
      } finally {
        await acp.kill();
      }
    },
  },

  {
    id: "runtime-variants",
    title: "Runtime start: installed CLI, its .js entry, bundled runtime, TCP, in-process",
    async run(s) {
      const names = ["cli", "script", "bundled", "tcp", "inprocess"];
      const results = {};
      for (const name of names) {
        if (name === "cli" && !G.cli.executable) results[name] = { ok: false, skipped: "no directly startable executable" };
        else if (name === "script" && !G.cli.script) results[name] = { ok: false, skipped: "no .js entry (not an npm install)" };
        else results[name] = await variantCheck(name);
        const r = results[name];
        console.log(`      ${name.padEnd(9)} ${r.ok ? `ok, start ${r.startMs} ms, runtime ${r.status?.version}, protocol ${r.status?.protocolVersion}` : (r.skipped ?? r.error?.message ?? "failed")}`);
      }
      s.data.variants = results;
      const wanted = G.opt.runtime && G.opt.runtime !== "auto" ? [G.opt.runtime] : ["cli", "script", "bundled"];
      G.variant = wanted.find((n) => results[n]?.ok) ?? null;
      s.data.chosen = G.variant;
      s.check("SDK starts the installed CLI (what the app would use)", Boolean(results.cli?.ok || results.script?.ok), results.cli?.ok ? "executable" : results.script?.ok ? "through the .js entry only" : cleanText(results.cli?.error?.message ?? results.cli?.skipped ?? ""));
      s.check("SDK starts its bundled runtime", Boolean(results.bundled?.ok), results.bundled?.ok ? `runtime ${results.bundled.status?.version}` : cleanText(results.bundled?.error?.message ?? ""));
      s.check("In-process runtime (FFI) loads", Boolean(results.inprocess?.ok), results.inprocess?.ok ? "" : cleanText(results.inprocess?.error?.message ?? ""));
      s.check("Runtime over TCP starts", Boolean(results.tcp?.ok), results.tcp?.ok ? "" : cleanText(results.tcp?.error?.message ?? ""));
      const picked = results[G.variant];
      if (picked) {
        s.check("Signed in (the SDK uses the CLI's login)", picked.auth?.isAuthenticated === true, `${picked.auth?.authType ?? "?"} @ ${picked.auth?.host ?? "?"}`);
        s.check("SDK protocol matches the runtime", picked.status?.protocolVersion === G.sdkProtocolVersion, `SDK ${G.sdkProtocolVersion}, runtime ${picked.status?.protocolVersion}`);
      }
      if (!G.variant) throw new Error("no runtime variant works: every later scenario needs one");
    },
  },

  {
    id: "inventory",
    title: "Read-only RPC inventory: everything the client and a session can list",
    async run(s) {
      const client = await getClient();
      s.data.client = await rpcInventory(client.rpc);
      const { session, w } = await open(client, { cwd: G.cwd, policy: "read-only", extra: G.best.enableConfigDiscovery === undefined ? {} : { enableConfigDiscovery: G.best.enableConfigDiscovery } });
      try {
        s.data.capabilities = sanitize(session.capabilities);
        s.data.session = await rpcInventory(session.rpc);
        s.saveEvents("session", w);
      } finally {
        await close(session);
      }
      const ok = (o) => Object.values(o).filter((x) => x.ok).length;
      s.note(`client.rpc: ${ok(s.data.client)}/${Object.keys(s.data.client).length} read methods answered; session.rpc: ${ok(s.data.session)}/${Object.keys(s.data.session).length}`);
      const ext = s.data.session["extensions.list"] ?? s.data.client["extensions.list"];
      s.check("Runtime lists CLI extensions (the relay extension lives there)", ext?.ok ? true : null, ext?.ok ? ext.shape : cleanText(ext?.error ?? "no extensions.list method"));
    },
  },

  {
    id: "discovery",
    title: "Custom agents, MCP servers and skills: SDK client mode x enableConfigDiscovery, compared with ACP",
    async run(s) {
      const acpAgents = (G.acp?.agents ?? []).filter((a) => a.value != null && a.value !== "" && !/^(default|none)$/i.test(String(a.value)));
      const combos = [];
      // client mode "empty" is left out: it is meant for multi-user servers and refuses to start a session
      // without explicit tools and storage, which is not how the app would use the runtime
      for (const discovery of [undefined, true, false]) combos.push({ mode: "coding-agent", discovery, extra: discovery === undefined ? {} : { enableConfigDiscovery: discovery } });
      const agentsDir = path.join(G.cwd, ".github", "agents");
      if (fs.existsSync(agentsDir)) combos.push({ mode: "coding-agent", discovery: "agents.directories", extra: { agents: { directories: [agentsDir] } } });
      combos.push({ mode: "coding-agent", discovery: "fetchManagedSettings", extra: { github: { fetchManagedSettings: true } } });

      const covered = (d) => {
        const names = new Set(customOf(d).flatMap((a) => [lower(a.name), lower(a.id), lower(a.displayName)]));
        return acpAgents.filter((a) => names.has(lower(a.value)) || names.has(lower(a.name)));
      };
      let best = null;
      for (const c of combos) {
        const key = `${c.mode}/${c.discovery ?? "default"}`;
        let d;
        try {
          const client = await getClient(c.mode);
          const { session, w } = await open(client, { cwd: G.cwd, policy: "read-only", extra: c.extra });
          try {
            d = await describeSession(session, w);
          } finally {
            await close(session);
          }
        } catch (e) {
          d = { error: errorInfo(e) };
        }
        d.customAgents = customOf(d).map((a) => `${a.name} [${a.source}]`);
        d.builtinAgents = (d.agents ?? []).filter((a) => a.source === "builtin").map((a) => a.name);
        d.acpAgentsCovered = `${covered(d).length}/${acpAgents.length}`;
        G.discovery[key] = d;
        console.log(`      ${key.padEnd(34)} custom agents: ${d.error ? `ERROR ${d.error.message}` : d.customAgents.length}, MCP: ${(d.mcpServers ?? []).map((x) => x.name).join(",") || "-"}, skills: ${d.skills?.length ?? "?"}, instruction sources: ${d.instructionSources?.length ?? "?"}`);
        const score = d.error ? -1 : covered(d).length * 1000 + customOf(d).length;
        if (c.mode === "coding-agent" && typeof c.discovery !== "string" && (!best || score > best.score)) best = { score, c, d };
      }
      s.data.acpAgents = acpAgents.map((a) => `${a.value}${a.name && a.name !== a.value ? ` (${a.name})` : ""}`);
      s.data.combos = Object.fromEntries(Object.entries(G.discovery).map(([k, d]) => [k, { ...d, agents: undefined }]));
      if (best) {
        G.best = { enableConfigDiscovery: best.c.discovery };
        G.customAgents = customOf(best.d);
        s.data.best = `coding-agent / enableConfigDiscovery=${best.c.discovery ?? "default"}`;
      }
      const def = G.discovery["coding-agent/default"];
      const on = G.discovery["coding-agent/true"];
      const missing = (d) => acpAgents.filter((a) => !covered(d).includes(a)).map((a) => a.value);
      if (!acpAgents.length) {
        s.check("Company agents listed by ACP are visible through the SDK", null, "ACP listed no custom agents in this folder: run the probe with --cwd pointing at a repository that has them");
      } else {
        const line = (d) => `${covered(d).length}/${acpAgents.length}${missing(d).length ? `, missing: ${missing(d).join(", ")}` : ""}`;
        s.check("Company agents listed by ACP are visible through the SDK", best && covered(best.d).length === acpAgents.length, `${line(best?.d)} with ${s.data.best ?? "no working options"}`);
        s.check("… with default session options", null, line(def));
        s.check("… with enableConfigDiscovery: true", null, line(on));
        const dirs = G.discovery["coding-agent/agents.directories"];
        if (dirs) s.check("… with agents.directories pointing at .github/agents (no config discovery)", null, line(dirs));
      }
      s.check("Agent sources seen", null, [...new Set(Object.values(G.discovery).flatMap((d) => (d.agents ?? []).map((a) => a.source)))].join(", ") || "none");
      const managed = G.discovery["coding-agent/fetchManagedSettings"];
      s.check("Session with github.fetchManagedSettings: true starts", managed && !managed.error, managed?.error ? cleanText(managed.error.message) : `managed settings source: ${managed?.managedSettings?.source ?? "?"}`);
      const anyManaged = Object.values(G.discovery).map((d) => d.managedSettings).find((m) => m && (m.serverManaged || m.deviceManaged || m.clientManaged || m.policyHelperManaged));
      s.check("Managed (company) settings are active on this machine", anyManaged ? true : null, anyManaged ? JSON.stringify(anyManaged).slice(0, 200) : "none reported");
    },
  },

  {
    id: "sessions",
    title: "Session list, metadata, several sessions in one runtime, custom session IDs, files on disk",
    async run(s) {
      const client = await getClient();
      const all = await withTimeout(client.listSessions(), 60_000, "listSessions");
      s.data.total = all.length;
      s.data.metadataKeys = Object.keys(all[0] ?? {});
      s.data.contextKeys = Object.keys(all.find((m) => m.context)?.context ?? {}); // titles and summaries of real sessions are not kept
      const here = await client.listSessions({ workingDirectory: G.cwd }).catch((e) => ({ error: e.message }));
      s.data.filteredByCwd = Array.isArray(here) ? here.length : here;
      s.data.clientNames = [...new Set(all.flatMap((m) => [m.clientName, m.lastClientName]).filter(Boolean))];
      if (G.acp?.sessionId) {
        const meta = await client.getSessionMetadata(G.acp.sessionId).catch(() => undefined);
        const seen = Boolean(meta) || all.some((m) => m.sessionId === G.acp.sessionId);
        s.check("A session created through ACP is visible to the SDK", seen ? true : null, seen ? `clientName: ${meta?.clientName ?? "?"}` : "not listed: the ACP baseline session got no prompt, and such a session is not stored");
      }
      const dirA = workspace("multi-a");
      const dirB = workspace("multi-b");
      const customId = randomUUID();
      const [a, b] = await Promise.all([open(client, { cwd: dirA }), open(client, { cwd: dirB, extra: { sessionId: customId } })]);
      try {
        const [ma, mb] = await Promise.all([client.getSessionMetadata(a.session.sessionId), client.getSessionMetadata(b.session.sessionId)]);
        s.data.multi = { a: sanitize(ma?.context), b: sanitize(mb?.context), startA: a.w.of("session.start")[0]?.data?.context?.cwd && "session.start carries context.cwd" };
        const cwdOf = (x) => x.w.of("session.start")[0]?.data?.context?.cwd;
        s.check("Two sessions with different folders in one runtime process", fs.realpathSync(cwdOf(a) ?? dirA) !== fs.realpathSync(cwdOf(b) ?? dirA), `${cleanText(cwdOf(a) ?? "?")} vs ${cleanText(cwdOf(b) ?? "?")}`);
        s.check("createSession accepts our own session ID", b.session.sessionId === customId, b.session.sessionId === customId ? "" : `got ${b.session.sessionId}`);
        await sleep(500);
        s.data.filesWithoutTurn = sessionFiles(a.session.sessionId);
        s.check("A session without a prompt is stored on disk", null, s.data.filesWithoutTurn.exists ? `yes: ${s.data.filesWithoutTurn.files.join(", ")}` : "no directory yet");
      } finally {
        await close(a.session);
        await close(b.session);
      }
    },
  },

  {
    id: "models",
    title: "Models, context tier (200k / long context) and reasoning effort without restarting the process",
    async run(s) {
      const client = await getClient();
      const { session, w } = await open(client, { cwd: workspace("models") });
      try {
        const clientModels = await client.listModels().catch((e) => ({ error: e.message }));
        s.data.clientListModels = Array.isArray(clientModels) ? clientModels.map((m) => m.id) : clientModels;
        let list = [];
        try {
          const res = await withTimeout(session.rpc.model.list({}), 30_000, "session.rpc.model.list");
          list = res?.list ?? res?.models ?? (Array.isArray(res) ? res : []);
          s.data.sessionModelListKeys = Object.keys(res ?? {});
        } catch (e) {
          s.data.sessionModelListError = cleanText(e.message);
        }
        s.data.sessionModels = list.map((m) => m.id ?? m.modelId ?? m.name);
        const longOnes = list.filter((m) => /long_context|contextTier|context_tier/i.test(JSON.stringify(m)));
        s.data.longContextModels = longOnes.map((m) => m.id ?? m.modelId);
        s.data.sampleModel = sanitize(longOnes[0] ?? list[0], { depth: 5, max: 100 });
        const acpModels = G.acp?.models ?? [];
        const sdkIds = new Set([...s.data.sessionModels, ...(Array.isArray(s.data.clientListModels) ? s.data.clientListModels : [])].map(lower));
        if (acpModels.length) {
          const missing = acpModels.filter((m) => !sdkIds.has(lower(m)));
          s.check("Models offered by ACP are offered by the SDK", missing.length === 0, missing.length ? `missing: ${missing.join(", ")}` : `${acpModels.length} models`);
        }
        s.data.current = await session.rpc.model.getCurrent().catch((e) => ({ error: e.message }));
        const target = G.opt.model ?? longOnes[0]?.id ?? list.find((m) => (m.id ?? "") !== "auto")?.id ?? s.data.current?.modelId ?? list[0]?.id ?? (Array.isArray(clientModels) ? clientModels[0]?.id : undefined);
        s.data.switchTarget = target ?? null;
        if (!target) throw new Skip("no model to switch to");
        const tryTier = async (tier) => {
          const from = w.mark();
          try {
            await withTimeout(session.setModel(target, { contextTier: tier }), 30_000, `setModel(${tier})`);
            const ev = await w.waitFor("session.model_change", 5000, from).catch(() => null);
            return { ok: true, event: sanitize(ev?.data, { depth: 2, max: 80 }), current: await session.rpc.model.getCurrent().catch(() => null) };
          } catch (e) {
            return { ok: false, error: cleanText(e.message, 400) };
          }
        };
        s.data.longContext = await tryTier("long_context");
        s.data.defaultContext = await tryTier("default");
        s.check("Context tier can be changed on a live session (today: process restart with --context)", s.data.longContext.ok && s.data.longContext.event?.contextTier === "long_context", s.data.longContext.ok ? `model ${target}, event contextTier: ${s.data.longContext.event?.contextTier ?? "?"}` : s.data.longContext.error);
        try {
          await withTimeout(session.setModel(target, { reasoningEffort: "low" }), 30_000, "setModel(reasoningEffort)");
          s.data.reasoningEffort = { ok: true };
        } catch (e) {
          s.data.reasoningEffort = { ok: false, error: cleanText(e.message, 300) };
        }
        s.check("Reasoning effort can be set", s.data.reasoningEffort.ok, s.data.reasoningEffort.error ?? "");
        s.saveEvents("models", w);
      } finally {
        await close(session);
      }
    },
  },

  {
    id: "modes",
    title: "Session mode (interactive / plan / autopilot) and permission mode (manual / allow-all)",
    async run(s) {
      const client = await getClient();
      const { session, w } = await open(client, { cwd: workspace("modes") });
      const attempt = async (label, fn) => {
        try {
          return { ok: true, result: sanitize(await withTimeout(fn(), 20_000, label), { depth: 3, max: 120 }) };
        } catch (e) {
          return { ok: false, error: cleanText(e.message, 300) };
        }
      };
      try {
        s.data.acpModes = G.acp?.modes ?? [];
        s.data.modeBefore = await attempt("mode.get", () => session.rpc.mode.get());
        s.data.setPlan = await attempt("mode.set plan", () => session.rpc.mode.set({ mode: "plan" }));
        s.data.modeAfterPlan = await attempt("mode.get", () => session.rpc.mode.get());
        s.data.setAutopilot = await attempt("mode.set autopilot", () => session.rpc.mode.set({ mode: "autopilot" }));
        s.data.setInteractive = await attempt("mode.set interactive", () => session.rpc.mode.set({ mode: "interactive" }));
        s.check("Session mode can be switched (plan and back)", s.data.setPlan.ok && s.data.setInteractive.ok, s.data.setPlan.error ?? `after set: ${JSON.stringify(s.data.modeAfterPlan.result)}`);
        s.check("Autopilot mode is allowed", s.data.setAutopilot.ok, s.data.setAutopilot.error ?? "");
        s.data.permissionMode = await attempt("permissions.getMode", () => session.rpc.permissions.getMode());
        s.data.permissionCapabilities = await attempt("permissions.getCapabilities", () => session.rpc.permissions.getCapabilities());
        s.data.permissionRequired = await attempt("permissions.getRequired", () => session.rpc.permissions.getRequired());
        s.data.setAllowAll = await attempt("permissions.setMode allow-all", () => session.rpc.permissions.setMode({ mode: "allow-all" }));
        s.data.setManual = await attempt("permissions.setMode manual", () => session.rpc.permissions.setMode({ mode: "manual" }));
        const allowed = s.data.setAllowAll.ok && s.data.setAllowAll.result?.success !== false && s.data.setAllowAll.result?.mode === "allow-all";
        s.check("Permission mode allow-all is permitted by policy", allowed, s.data.setAllowAll.error ?? JSON.stringify(s.data.setAllowAll.result));
        s.data.modeEvents = w.events.filter((e) => /mode/.test(e.type ?? "")).map((e) => ({ type: e.type, data: sanitize(e.data, { depth: 2, max: 80 }) }));
      } finally {
        await close(session);
      }
    },
  },
];
