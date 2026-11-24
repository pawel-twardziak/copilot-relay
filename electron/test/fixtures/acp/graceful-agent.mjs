#!/usr/bin/env node
// An ACP agent for tests that exits with code 0 on SIGTERM, leaving a child of its own (in its process group) that
// ignores SIGTERM; answers `initialize` with both pids (once the child ignores SIGTERM) and no other request.
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createInterface } from "node:readline";
process.on("SIGTERM", () => process.exit(0));
const child = spawn(process.execPath, ["-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000); console.log('ready')"], {
  stdio: ["ignore", "pipe", "ignore"],
});
const ready = once(child.stdout, "data");
createInterface({ input: process.stdin }).on("line", async (line) => {
  const msg = JSON.parse(line);
  if (msg.method === "initialize") {
    await ready;
    const result = { pid: process.pid, childPid: child.pid };
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result }) + "\n");
  }
});
