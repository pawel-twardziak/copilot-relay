// End to end: a real broker started from a temp copy of the repo is updated and replaced by the restart run while two
// connected sessions keep working. Git never touches anything but the temp clone; npm is not run (no network).
import assert from "node:assert/strict";
import { appendFileSync, cpSync, existsSync, lstatSync, mkdtempSync, readFileSync, realpathSync, rmSync, rmdirSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { realEffects, reconnectClients, runRestart, sameFolder } from "../broker-restart.mjs";
import { startBroker, until } from "./broker-helper.mjs";
import { isolatedRun, repoWithRemote } from "./git-helper.mjs";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const COPIED = ["server.mjs", "src", "public", "scripts", "extension", "package.json", "package-lock.json", ".gitignore"];

test("the run updates a repo copy and replaces its running broker", { timeout: 60_000 }, async (t) => {
  const { tmp, repo, git, upstream } = await repoWithRemote(t, "copilot-relay");
  for (const name of COPIED) {
    cpSync(path.join(ROOT, name), path.join(repo, name), { recursive: true, filter: (src) => path.basename(src) !== "node_modules" });
  }
  // Not the developer's file: a local startupSessions entry would start real agents. The run's broker reads this one.
  writeFileSync(path.join(repo, "relay.config.json"), "{}\n");
  await git("add", ".");
  await git("commit", "-m", "copy of the app");
  await git("push", "origin", "main");
  // .gitignore's `node_modules/` does not match a link: keep it out of `git status` (and out of the run's stash).
  appendFileSync(path.join(repo, ".git", "info", "exclude"), "node_modules\n");
  const link = path.join(repo, "node_modules");
  symlinkSync(path.join(ROOT, "node_modules"), link, "junction");
  // From here on the link exists: whatever throws, the finally removes the link itself before the helper's recursive
  // cleanup of the temp folder could follow it into this checkout's node_modules.
  let old;
  try {
    await upstream("MARK.txt", "x");

    const copilotHome = path.join(tmp, "copilot-home");
    const stateDir = mkdtempSync(path.join(os.tmpdir(), "broker-e2e-"));
    t.after(() => rmSync(stateDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
    old = await startBroker(t, { script: path.join(repo, "server.mjs") });
    const a = await old.connect("cli:e2e-a", { name: "alpha" });
    const b = await old.connect("cli:e2e-b", { name: "beta" });
    await a.client.send(b.client.name, "before");
    await until(() => b.got.some((m) => m.text === "before"), "the message before the restart");

    const npmCalls = [];
    const fx = realEffects({ reconnect: (ms) => reconnectClients([a.client, b.client], ms) });
    const realSpawn = fx.spawnBroker;
    // Every command goes through the git isolation; `npm ci` is only recorded (no network in tests).
    // Fails closed: anything that is not npm ci, git, the node probe or the install script is refused, never run.
    fx.run = (program, args, opts = {}) => {
      if (opts.label === "npm ci" || args.at(-1) === "ci") {
        npmCalls.push({ program, args, cwd: opts.cwd });
        return Promise.resolve({ stdout: "", stderr: "" });
      }
      const install = path.join(repo, "scripts", "install-extension.mjs");
      const known = program === "git" || (program === "node" && args[0] === "-p") || (args[0] !== undefined && path.resolve(args[0]) === install);
      if (!known) return Promise.reject(new Error(`the test does not run: ${program} ${args.join(" ")}`));
      return isolatedRun(program, args, opts);
    };
    fx.spawnBroker = (node, script, opts) => realSpawn(node, script, {
      ...opts,
      env: { ...opts.env, COPILOT_RELAY_NAMES_FILE: path.join(stateDir, "names.json"), COPILOT_RELAY_DELEGATIONS_FILE: path.join(stateDir, "delegations.json"), COPILOT_RELAY_COMMS_FILE: path.join(stateDir, "communications.jsonl") },
    });

    const out = await runRestart({ repo, url: old.url, copilotHome }, fx);
    const shown = JSON.stringify(out.steps, null, 1);
    assert.equal(out.ok, true, shown);
    for (const s of out.steps) assert.ok(s.status === "done" && !s.warning, shown);
    assert.equal(await old.exited, 0);

    const h = await (await fetch(`${old.url}/health`)).json();
    assert.notEqual(h.pid, old.proc.pid);
    assert.ok(sameFolder(h.root, repo), h.root);
    assert.ok(existsSync(path.join(repo, "MARK.txt")));
    assert.equal(realpathSync(link), realpathSync(path.join(ROOT, "node_modules")));

    const cfg = JSON.parse(readFileSync(path.join(copilotHome, "extensions", "copilot-relay", "config.json"), "utf8"));
    assert.equal(cfg.url, old.url);
    assert.ok(sameFolder(path.dirname(cfg.brokerScript), repo), cfg.brokerScript);
    assert.equal(npmCalls.length, 1);
    assert.equal(npmCalls[0].cwd, repo);
    assert.equal(out.steps[5].detail, "2 of 2 sessions reconnected");

    await b.client.send(a.client.name, "after");
    await until(() => a.got.some((m) => m.text === "after"), "the message after the restart");
  } finally {
    // The broker the run started is not a child of the test: stop it here, before the temp folders go. Nothing in
    // here may throw over an earlier error.
    try {
      if (old) {
        const answers = () => fetch(`${old.url}/health`, { signal: AbortSignal.timeout(1000) }).then((r) => r.json(), () => null);
        await fetch(`${old.url}/api/shutdown`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}", signal: AbortSignal.timeout(2000) }).catch(() => {});
        await until(async () => !(await answers()), "the new broker to stop", 10_000).catch(async () => {
          const h = await answers();
          if (h?.pid) process.kill(h.pid);
        });
      }
    } catch { /* the folders are removed next */ }
    try {
      // Only the link itself: never the folder it points to.
      if (lstatSync(link, { throwIfNoEntry: false })) (process.platform === "win32" ? rmdirSync : unlinkSync)(link);
    } catch { /* the helper's cleanup tries again */ }
  }
});
