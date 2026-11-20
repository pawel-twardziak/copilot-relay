// Tests for electron/acp.mjs against a fake agent (a script, so POSIX only: Windows starts it through a shell).
import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { AcpConnection } from "../acp.mjs";

const FAKE = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "acp", "fake-agent.mjs");
const posixOnly = { skip: process.platform === "win32" && "the fake agent is a shebang script" };

async function argvOf(opts) {
  const conn = new AcpConnection({ command: FAKE, cwd: process.cwd(), ...opts });
  try {
    return (await conn.start()).argv;
  } finally {
    conn.kill();
  }
}

test("starts the agent with --acp --stdio", posixOnly, async () => {
  assert.deepEqual(await argvOf({}), ["--acp", "--stdio"]);
});

test("passes extra args after --acp --stdio", posixOnly, async () => {
  assert.deepEqual(await argvOf({ args: ["--context", "long_context"] }), ["--acp", "--stdio", "--context", "long_context"]);
});
