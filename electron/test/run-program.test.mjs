// Tests for running an external program with a timeout.
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { runProgram } from "../run-program.mjs";

const node = process.execPath;

test("output is returned", async () => {
  const r = await runProgram(node, ["-e", "console.log('hi')"]);
  assert.equal(r.stdout, "hi\n");
  assert.equal(r.stderr, "");
});
test("env and cwd reach the program", async () => {
  const cwd = os.tmpdir();
  const r = await runProgram(node, ["-e", "console.log(process.env.RP_X);console.log(process.cwd())"], { cwd, env: { RP_X: "val" } });
  const [x, dir] = r.stdout.trim().split(/\r?\n/);
  assert.equal(x, "val");
  assert.equal(path.resolve(dir), path.resolve(cwd));
});
test("non-zero exit rejects with the stderr tail", async () => {
  await assert.rejects(runProgram(node, ["-e", "console.error('boom');process.exit(3)"]), (e) => {
    assert.equal(e.code, "EXIT");
    assert.match(e.message, /failed \(exit 3\): boom/);
    assert.equal(e.stderr.trim(), "boom");
    return true;
  });
});
test("label defaults to program and first argument, or is given", async () => {
  await assert.rejects(runProgram(node, [path.join("a", "b.js"), "x"]), /^Error: node b\.js failed/);
  await assert.rejects(runProgram(node, ["-e", "process.exit(1)"], { label: "npm ci" }), /^Error: npm ci failed \(exit 1\)/);
});
test("missing program rejects with ENOENT", async () => {
  await assert.rejects(runProgram("no-such-program-xyz", []), (e) => {
    assert.equal(e.code, "ENOENT");
    assert.match(e.message, /no-such-program-xyz was not found/);
    return true;
  });
});
test("timeout rejects and ends the process", async () => {
  const t0 = Date.now();
  await assert.rejects(runProgram(node, ["-e", "setTimeout(()=>{},60000)"], { timeoutMs: 300 }), (e) => {
    assert.equal(e.code, "TIMEOUT");
    assert.match(e.message, /did not finish in 0\.3 s/);
    return true;
  });
  assert.ok(Date.now() - t0 < 5000);
});
test("output is capped to its last 64 KiB", async () => {
  const r = await runProgram(node, ["-e", "process.stdout.write('a'.repeat(100000)+'END')"]);
  assert.equal(r.stdout.length, 64 * 1024);
  assert.ok(r.stdout.endsWith("END"));
});
test("a missing cwd is reported as a missing folder, not a missing program", async () => {
  const cwd = path.join(os.tmpdir(), "no-such-folder-xyz");
  await assert.rejects(runProgram(process.execPath, ["-e", "1"], { cwd }), (e) => {
    assert.equal(e.code, "NOCWD");
    assert.equal(e.message, `Folder does not exist: ${cwd}`);
    return true;
  });
});
