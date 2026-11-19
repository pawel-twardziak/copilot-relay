// Tests for running one scheduled script (exit, env, timeout, tree kill, abort, output cap).
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { startRun } from "../job-runner.mjs";
import { RESULT_CAP, TAIL_SLACK, finishRun } from "../jobs.mjs";

const node = (code) => `"${process.execPath}" -e ${JSON.stringify(code)}`;
const base = { cwd: os.tmpdir(), env: {}, timeoutMs: 10_000, jobName: "t", runId: "r1" };

test("exit code, stdout and stderr", async () => {
  const r = await startRun({ ...base, command: node("console.log('hi');console.error('oops');process.exit(3)") }).done;
  assert.equal(r.reason, "exit"); assert.equal(r.exitCode, 3);
  assert.equal(String(r.stdout).trim(), "hi"); assert.equal(String(r.stderr).trim(), "oops");
  assert.equal(r.error, null); assert.ok(r.durationMs >= 0);
});
test("env and $JOB_RESULT", async () => {
  const r = await startRun({ ...base, env: { FOO: "bar" }, command: node(
    "require('fs').writeFileSync(process.env.JOB_RESULT, process.env.FOO + ' ' + process.env.JOB_NAME + ' ' + process.env.JOB_RUN_ID)") }).done;
  assert.equal(String(r.resultText), "bar t r1");
  assert.equal(r.resultTruncated, false);
});
test("result folder is removed after the run", async () => {
  const r = await startRun({ ...base, command: node("console.log(process.env.JOB_RESULT)") }).done;
  assert.equal(fs.existsSync(path.dirname(String(r.stdout).trim())), false);
});
test("timeout kills the whole tree", async () => {
  const r = await startRun({ ...base, timeoutMs: 500, command: node(
    `const c=require('child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});` +
    `console.log(c.pid);setInterval(()=>{},1000)`) }).done;
  assert.equal(r.reason, "timeout");
  const grandchild = Number(String(r.stdout).trim());
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
  // the last write arrives alone, as a chunk smaller than the kept tail
  const r = await startRun({ ...base, command: node(
    "const b='x'.repeat(1<<20);for(let i=0;i<30;i++)process.stdout.write(b);" +
    "setTimeout(()=>process.stdout.write('y'.repeat(8192)+'END'),300)") }).done;
  assert.equal(r.stdoutTruncated, true);
  assert.ok(String(r.stdout).endsWith("y".repeat(8192) + "END"));
  assert.equal(r.stdout.length, 65536 + 4096);
});
test("a multi-byte secret cut by the output cap leaves no fragment", async () => {
  const secret = "\u{1F511}abcdefghijklmnopqrstuvwxyz0123";
  // the kept tail starts one byte into the secret, with no newline anywhere; masking the later copies shrinks the
  // text below RESULT_CAP, so the final cap does not hide the start
  const after = RESULT_CAP + TAIL_SLACK - (Buffer.byteLength(secret) - 1);
  const s = JSON.stringify(secret);
  const r = await startRun({ ...base, command: node(
    `const m=(${s}+'z').repeat(300);process.stdout.write('x'.repeat(1000)+${s}+'z'.repeat(${after}-Buffer.byteLength(m))+m)`) }).done;
  assert.equal(r.stdoutTruncated, true);
  const run = finishRun(r, { jobId: "j", runId: "r1", trigger: "manual", startedAt: "", secrets: [secret] });
  for (let i = 0; i + 4 <= secret.length; i++) assert.ok(!run.stdout.includes(secret.slice(i, i + 4)), run.stdout.slice(0, 20));
  assert.ok(run.stdout.startsWith("z"));
});
test("resolves even when the result folder cannot be fully removed", async (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "job-runner-test-"));
  const info = path.join(tmp, "dir");
  t.after(() => {
    const dir = fs.existsSync(info) ? fs.readFileSync(info, "utf8") : "";
    if (dir) {
      try { fs.chmodSync(path.join(dir, "ro"), 0o700); } catch { /* ignore */ }
      fs.rmSync(dir, { recursive: true, force: true });
    }
    fs.rmSync(tmp, { recursive: true, force: true });
  });
  const r = await startRun({ ...base, env: { INFO: info }, command: node(
    "const fs=require('fs'),p=require('path');const dir=p.dirname(process.env.JOB_RESULT);fs.writeFileSync(process.env.INFO,dir);" +
    "const d=p.join(dir,'ro');fs.mkdirSync(d);fs.writeFileSync(p.join(d,'f'),'x');fs.chmodSync(d,0o500)") }).done;
  assert.equal(r.reason, "exit");
  assert.equal(r.exitCode, 0);
});
test("a background grandchild holding the pipes does not delay or change the result", async () => {
  const t0 = Date.now();
  const r = await startRun({ ...base, command: node(
    `const c=require('child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'inherit'});` +
    `c.unref();console.log('started '+c.pid)`) }).done;
  assert.ok(Date.now() - t0 < 4000);
  assert.equal(r.reason, "exit"); assert.equal(r.exitCode, 0);
  assert.match(String(r.stdout), /started \d+/);
  const grandchild = Number(String(r.stdout).match(/started (\d+)/)[1]);
  await new Promise((res) => setTimeout(res, 300));
  assert.throws(() => process.kill(grandchild, 0));
});
test("abort({ force: true }) kills a job that ignores SIGTERM at once and removes its folder", async (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "job-runner-test-"));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const info = path.join(tmp, "info");
  const h = startRun({ ...base, env: { INFO: info }, command: node(
    "process.on('SIGTERM',()=>{});require('fs').writeFileSync(process.env.INFO,process.env.JOB_RESULT);setInterval(()=>{},1000)") });
  while (!fs.existsSync(info) || fs.readFileSync(info, "utf8") === "") await new Promise((r) => setTimeout(r, 20));
  const resultDir = path.dirname(fs.readFileSync(info, "utf8"));
  const t0 = Date.now();
  h.abort({ force: true });
  assert.equal(fs.existsSync(resultDir), false); // removed synchronously
  const r = await h.done;
  assert.equal(r.reason, "aborted");
  assert.ok(Date.now() - t0 < 1500, `took ${Date.now() - t0} ms`);
});
test("reports the signal that killed the script", { skip: process.platform === "win32" }, async () => {
  const r = await startRun({ ...base, command: "kill -9 $$" }).done;
  assert.equal(r.exitCode, null);
  assert.equal(r.signal, "SIGKILL");
});
