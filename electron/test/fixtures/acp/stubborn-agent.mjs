#!/usr/bin/env node
// An ACP agent for tests that ignores SIGTERM and has a child of its own (in its process group); answers
// `initialize` with both pids and no other request. Only SIGKILL ends it; its child ends on either signal.
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
process.on("SIGTERM", () => {});
setInterval(() => {}, 1000); // also outlives its closed input and its child
const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
createInterface({ input: process.stdin }).on("line", (line) => {
  const msg = JSON.parse(line);
  if (msg.method === "initialize") {
    const result = { pid: process.pid, childPid: child.pid };
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result }) + "\n");
  }
});
