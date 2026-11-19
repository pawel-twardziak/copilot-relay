// Tests for running one scheduled script (exit, env, timeout, tree kill, abort, output cap).
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { startRun } from "../job-runner.mjs";

const node = (code) => `"${process.execPath}" -e ${JSON.stringify(code)}`;
const base = { cwd: os.tmpdir(), env: {}, timeoutMs: 10_000, jobName: "t", runId: "r1" };

test("exit code, stdout and stderr", async () => {
  const r = await startRun({ ...base, command: node("console.log('hi');console.error('oops');process.exit(3)") }).done;
  assert.equal(r.reason, "exit"); assert.equal(r.exitCode, 3);
  assert.equal(r.stdout.trim(), "hi"); assert.equal(r.stderr.trim(), "oops");
  assert.equal(r.error, null); assert.ok(r.durationMs >= 0);
});
test("env and $JOB_RESULT", async () => {
  const r = await startRun({ ...base, env: { FOO: "bar" }, command: node(
    "require('fs').writeFileSync(process.env.JOB_RESULT, process.env.FOO + ' ' + process.env.JOB_NAME + ' ' + process.env.JOB_RUN_ID)") }).done;
  assert.equal(r.resultText, "bar t r1");
  assert.equal(r.resultTruncated, false);
});
test("result folder is removed after the run", async () => {
  const r = await startRun({ ...base, command: node("console.log(process.env.JOB_RESULT)") }).done;
  assert.equal(fs.existsSync(path.dirname(r.stdout.trim())), false);
});
test("timeout kills the whole tree", async () => {
  const r = await startRun({ ...base, timeoutMs: 500, command: node(
    `const c=require('child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});` +
    `console.log(c.pid);setInterval(()=>{},1000)`) }).done;
  assert.equal(r.reason, "timeout");
  const grandchild = Number(r.stdout.trim());
  await new Promise((res) => setTimeout(res, 300));
  assert.throws(() => process.kill(grandchild, 0)); // gone
});
test("abort resolves as aborted", async () => {
  const h = startRun({ ...base, command: node("setInterval(()=>{},1000)") });
  setTimeout(() => h.abort(), 200);
  assert.equal((await h.done).reason, "aborted");
});
test("missing folder", async () => {
  const r = await startRun({ ...base, cwd: path.join(os.tmpdir(), "no-such-dir-xyz"), command: "echo x" }).done;
  assert.equal(r.reason, "exit");
  assert.equal(r.exitCode, null); assert.match(r.error, /^Folder does not exist: /);
});
test("caps a flood of output to the tail", async () => {
  const r = await startRun({ ...base, command: node(
    "const b='x'.repeat(1<<20);for(let i=0;i<30;i++)process.stdout.write(b);process.stdout.write('END')") }).done;
  assert.equal(r.stdoutTruncated, true);
  assert.ok(r.stdout.endsWith("END"));
  assert.ok(Buffer.byteLength(r.stdout) <= 65536 + 4096);
});
