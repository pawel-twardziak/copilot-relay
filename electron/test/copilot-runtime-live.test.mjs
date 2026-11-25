import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { test } from "node:test";
import { createCopilotRuntime } from "../copilot-runtime.mjs";

test("live: getQuota through the real CLI", { skip: process.env.COPILOT_LIVE_TEST !== "1", timeout: 60_000 }, async () => {
  const pids = [];
  const rt = createCopilotRuntime({ spawn: (...a) => { const c = spawn(...a); pids.push(c.pid); return c; } });
  const quota = await rt.withClient({ command: "copilot" }, (client) => client.rpc.account.getQuota({}));
  assert.equal(typeof quota.quotaSnapshots, "object");
  assert.ok(quota.quotaSnapshots);
  assert.equal(pids.length, 1);
  await rt.stopAll();
  assert.throws(() => process.kill(pids[0], 0), { code: "ESRCH" });
});
