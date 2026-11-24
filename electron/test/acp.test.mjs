// Tests for electron/acp.mjs against fake agents started through the system shell.
import assert from "node:assert/strict";
import { chmodSync, copyFileSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { AcpConnection } from "../acp.mjs";

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "acp");
const NODE = `"${process.execPath}"`;
const agent = (file, extra = "") => `${NODE} "${path.join(FIXTURES, file)}"${extra}`;
const posixOnly = { skip: process.platform === "win32" && "POSIX process groups" };
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const exitOf = (conn) => new Promise((r) => conn.once("exit", r));
const cwd = process.cwd();

/** Starts a connection, returns the agent's `initialize` result, and kills it (waiting until it is gone). */
async function initOf(opts) {
  const conn = new AcpConnection({ cwd, ...opts });
  try {
    return await conn.start();
  } finally {
    const gone = conn.exited || typeof conn.proc?.pid !== "number" ? null : exitOf(conn); // a failed spawn sends no exit
    conn.kill();
    await gone;
  }
}

test("starts the agent with --acp --stdio", async () => {
  assert.deepEqual((await initOf({ command: agent("fake-agent.mjs") })).argv, ["--acp", "--stdio"]);
});

test("passes extra args after --acp --stdio", async () => {
  assert.deepEqual((await initOf({ command: agent("fake-agent.mjs"), args: ["--context", "long_context"] })).argv, [
    "--acp",
    "--stdio",
    "--context",
    "long_context",
  ]);
});

test("arguments in the command come before --acp --stdio", async () => {
  assert.deepEqual((await initOf({ command: agent("fake-agent.mjs", ' --tag "one two"') })).argv, ["--tag", "one two", "--acp", "--stdio"]);
});

test("an existing file with a space in its path starts unquoted", posixOnly, async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "acp test "));
  try {
    const copied = path.join(dir, "fake-agent.mjs");
    copyFileSync(path.join(FIXTURES, "fake-agent.mjs"), copied);
    chmodSync(copied, 0o755);
    assert.deepEqual((await initOf({ command: copied })).argv, ["--acp", "--stdio"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a variable before the command reaches the agent", posixOnly, async () => {
  assert.equal((await initOf({ command: `FOO=bar ${agent("fake-agent.mjs")}` })).foo, "bar");
});

test("a wrapper's own output does not break the start", async () => {
  assert.deepEqual((await initOf({ command: `echo banner && ${agent("fake-agent.mjs")}` })).argv, ["--acp", "--stdio"]);
});

test("a command that exits without speaking ACP fails the start", async () => {
  await assert.rejects(new AcpConnection({ command: "echo hi", cwd }).start(), /copilot exited \(0\)/);
});

test("a missing program fails with exit code 127", posixOnly, async () => {
  // dash says "not found", bash (as sh) "No such file or directory"
  await assert.rejects(
    new AcpConnection({ command: "/nonexistent/copilot-x", cwd }).start(),
    (e) => e.exitCode === 127 && e.signal === null && /not found|No such file/.test(e.message),
  );
});

test("kill ends the agent and what it started", posixOnly, async () => {
  const conn = new AcpConnection({ command: agent("stubborn-agent.mjs"), cwd });
  const { pid, childPid } = await conn.start();
  const gone = exitOf(conn);
  conn.kill();
  await gone; // stubborn: comes after the SIGKILL at 3 s
  assert.equal(conn.exited, true);
  assert.equal(alive(pid), false);
  assert.equal(alive(childPid), false);
});

test("exit waits for the group when the shell was ended by a signal", posixOnly, async () => {
  const conn = new AcpConnection({ command: agent("stubborn-agent.mjs"), cwd });
  const { pid, childPid } = await conn.start();
  let exited = false;
  conn.once("exit", () => (exited = true));
  process.kill(conn.proc.pid, "SIGKILL"); // the shell only, from outside
  await new Promise((r) => setTimeout(r, 300));
  if (conn.proc.pid !== pid) assert.equal(exited, false, "the agent still runs"); // a shell that exec'd is the agent
  if (!conn.exited) await exitOf(conn);
  assert.equal(alive(pid), false);
  assert.equal(alive(childPid), false);
});

test("a shell that replaced itself with the agent: exit waits for what the agent started", posixOnly, async () => {
  // bash as sh does this on its own; dash only on `exec`
  const conn = new AcpConnection({ command: `exec ${agent("stubborn-agent.mjs")}`, cwd });
  const { pid, childPid } = await conn.start();
  assert.equal(conn.proc.pid, pid);
  const gone = exitOf(conn);
  process.kill(pid, "SIGKILL"); // the agent only, from outside: its child is left in the group
  assert.deepEqual(await gone, { code: null, signal: "SIGKILL", stderr: "" });
  assert.equal(alive(childPid), false);
});

test("forceKill ends a stubborn agent at once", posixOnly, async () => {
  const conn = new AcpConnection({ command: agent("stubborn-agent.mjs"), cwd });
  const { pid, childPid } = await conn.start();
  const t = Date.now();
  const gone = exitOf(conn);
  conn.forceKill();
  await gone;
  assert.ok(Date.now() - t < 2000);
  assert.equal(alive(pid), false);
  assert.equal(alive(childPid), false);
});

test("pending requests fail with the exit code and signal", posixOnly, async () => {
  const conn = new AcpConnection({ command: agent("stubborn-agent.mjs"), cwd });
  await conn.start();
  const pending = conn.request("never/answered", {});
  conn.forceKill();
  await assert.rejects(pending, (e) => e.signal === "SIGKILL" && e.exitCode === null && /copilot exited \(SIGKILL\)/.test(e.message));
});

test("kill and forceKill without a process do nothing", () => {
  const conn = new AcpConnection({ command: "copilot", cwd });
  assert.doesNotThrow(() => {
    conn.kill();
    conn.forceKill();
  });
  assert.equal(conn.exited, false);
});
