import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { attachRendererLog, createFileLog, LOG_LINE_MAX, logLine, teeConsole } from "../main-log.mjs";

let dir;
beforeEach(() => (dir = mkdtempSync(path.join(os.tmpdir(), "main-log-"))));
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const at = new Date("2026-11-27T15:30:00.000Z");

test("a line has the time, the level and the console's own formatting", () => {
  assert.equal(logLine("warn", ["[delegation] session_request: %s", "boom"], at), "2026-11-27T15:30:00.000Z WARN  [delegation] session_request: boom\n");
  const err = new Error("bad");
  const line = logLine("error", ["failed:", err], at);
  assert.match(line, /^2026-11-27T15:30:00\.000Z ERROR failed: Error: bad\n {5,}at /); // the stack, indented under its line
});

test("a very long message is cut", () => {
  const line = logLine("log", ["x".repeat(LOG_LINE_MAX + 50)], at);
  assert.ok(line.length < LOG_LINE_MAX + 100);
  assert.match(line, /… \(\d+ chars\)\n$/);
});

test("lines are appended to the file, its folder is made", () => {
  const file = path.join(dir, "logs", "main.log");
  const log = createFileLog(file, { now: () => at });
  log.write("log", ["one"]);
  log.write("error", ["two"]);
  assert.equal(readFileSync(file, "utf8"), `${at.toISOString()} LOG   one\n${at.toISOString()} ERROR two\n`);
});

test("a full file becomes main.old.log at start and while writing", () => {
  const file = path.join(dir, "main.log");
  const old = path.join(dir, "main.old.log");
  writeFileSync(file, "x".repeat(200));
  const log = createFileLog(file, { maxBytes: 100, now: () => at });
  assert.equal(readFileSync(old, "utf8"), "x".repeat(200)); // too big already: moved before the first line
  assert.equal(existsSync(file), false);
  log.write("log", ["a".repeat(60)]);
  log.write("log", ["b".repeat(60)]); // would pass 100 bytes: the file moves first
  assert.match(readFileSync(old, "utf8"), /a{60}/);
  assert.match(readFileSync(file, "utf8"), /^\S+ LOG {3}b{60}\n$/);
});

test("a failing write loses the line and nothing else", () => {
  const fs = {
    mkdirSync() {},
    statSync() {
      throw new Error("ENOENT");
    },
    renameSync() {},
    appendFileSync() {
      throw new Error("EACCES");
    },
  };
  const log = createFileLog(path.join(dir, "main.log"), { fs });
  assert.doesNotThrow(() => log.write("log", ["lost"]));
});

test("the console still prints and the file gets each level", () => {
  const printed = [];
  const target = Object.fromEntries(["log", "info", "warn", "error", "debug"].map((l) => [l, (...a) => printed.push([l, ...a])]));
  const written = [];
  teeConsole({ write: (level, args) => written.push([level, ...args]) }, target);
  target.warn("w", 1);
  target.error("e");
  target.log("l");
  assert.deepEqual(printed, [["warn", "w", 1], ["error", "e"], ["log", "l"]]);
  assert.deepEqual(written, [["warn", "w", 1], ["error", "e"], ["log", "l"]]);
});

test("a console that cannot print still writes the file", () => {
  const target = {
    log() {
      throw new Error("EPIPE");
    },
  };
  const written = [];
  teeConsole({ write: (level, args) => written.push([level, ...args]) }, target, ["log"]);
  assert.doesNotThrow(() => target.log("kept"));
  assert.deepEqual(written, [["log", "kept"]]);
});

test("the window's warnings, errors and crashes go to the file; its info does not", () => {
  const wc = new EventEmitter();
  const written = [];
  attachRendererLog(wc, { write: (level, args) => written.push([level, ...args]) });
  wc.emit("console-message", { level: "info", message: "hello", sourceId: "app.js", lineNumber: 1 });
  wc.emit("console-message", { level: "warning", message: "careful", sourceId: "file:///x/app.js", lineNumber: 10 });
  wc.emit("console-message", { level: "error", message: "TypeError: x is undefined", sourceId: "file:///x/app.js", lineNumber: 2310 });
  wc.emit("render-process-gone", {}, { reason: "crashed", exitCode: 3 });
  wc.emit("preload-error", {}, "/x/preload.cjs", new Error("no"));
  assert.deepEqual(written.slice(0, 2), [
    ["warn", "[renderer] careful (file:///x/app.js:10)"],
    ["error", "[renderer] TypeError: x is undefined (file:///x/app.js:2310)"],
  ]);
  assert.deepEqual(written[2], ["error", "[renderer] the window's process is gone: crashed (exit code 3)"]);
  assert.equal(written[3][0], "error");
  assert.equal(written[3][1], "[renderer] the preload script /x/preload.cjs failed:");
  assert.equal(written[3][2].message, "no");
});
