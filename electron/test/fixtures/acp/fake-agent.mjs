#!/usr/bin/env node
// A minimal ACP agent for tests: answers `initialize` with the arguments it was started with.
import { createInterface } from "node:readline";
createInterface({ input: process.stdin }).on("line", (line) => {
  const msg = JSON.parse(line);
  if (msg.method === "initialize") process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { argv: process.argv.slice(2) } }) + "\n");
});
