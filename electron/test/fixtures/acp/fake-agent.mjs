#!/usr/bin/env node
// A minimal ACP agent for tests: answers `initialize` with the arguments it was started with, $FOO and its pid.
import { createInterface } from "node:readline";
createInterface({ input: process.stdin }).on("line", (line) => {
  const msg = JSON.parse(line);
  if (msg.method === "initialize") {
    const result = { argv: process.argv.slice(2), foo: process.env.FOO ?? null, pid: process.pid };
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result }) + "\n");
  }
});
