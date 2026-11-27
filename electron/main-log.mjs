// The main process's log file (userData/logs/main.log). A packaged app has no console on Windows (and the portable
// build cannot even be started with its output redirected), so the console's lines also go to this file, and so do
// the window's warnings, errors and crashes. One older file is kept (main.old.log); a line that cannot be written is
// lost, nothing else happens.
import { appendFileSync, mkdirSync, renameSync, statSync } from "node:fs";
import path from "node:path";
import { format } from "node:util";

export const LOG_MAX = 5 * 1024 * 1024;
export const LOG_LINE_MAX = 16 * 1024;
const LEVELS = ["log", "info", "warn", "error", "debug"];

/** One line of the file: time, level and the text as the console formats it; further lines of it (a stack) indented. */
export function logLine(level, args, now = new Date()) {
  let text = format(...args);
  if (text.length > LOG_LINE_MAX) text = `${text.slice(0, LOG_LINE_MAX)}… (${text.length} chars)`;
  return `${now.toISOString()} ${level.toUpperCase().padEnd(5)} ${text.replace(/\r?\n/g, "\n    ")}\n`;
}

/** Appends lines to `file` (made with its folder). A file that reaches `maxBytes` becomes `<name>.old.log`, at start
 *  or before the line that would pass it. Synchronous: few lines, and none is lost when the process dies. */
export function createFileLog(file, { maxBytes = LOG_MAX, fs = { appendFileSync, mkdirSync, renameSync, statSync }, now = () => new Date() } = {}) {
  const old = `${file.replace(/\.log$/, "")}.old.log`;
  let size = 0;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
  } catch {
    /* the first write fails as well: the lines are lost */
  }
  try {
    size = fs.statSync(file).size;
  } catch {
    size = 0;
  }
  const rotate = () => {
    try {
      fs.renameSync(file, old); // replaces an earlier old file
    } catch {
      /* the file keeps growing rather than losing lines */
    }
    size = 0;
  };
  if (size >= maxBytes) rotate();
  return {
    file,
    write(level, args) {
      const line = logLine(level, args, now());
      const bytes = Buffer.byteLength(line);
      if (size > 0 && size + bytes > maxBytes) rotate();
      try {
        fs.appendFileSync(file, line);
        size += bytes;
      } catch {
        /* a full or locked disk: this line is lost */
      }
    },
  };
}

/** The console's methods also write to `log`; the console still prints (a console that cannot print is ignored). */
export function teeConsole(log, target = console, levels = LEVELS) {
  for (const level of levels) {
    const print = target[level].bind(target);
    target[level] = (...args) => {
      log.write(level, args);
      try {
        print(...args);
      } catch {
        /* no console (a closed pipe): the file has the line */
      }
    };
  }
}

/** The window's console warnings and errors, a crash of its process and a failed preload go to `log`. */
export function attachRendererLog(webContents, log) {
  webContents.on("console-message", (details) => {
    const level = details?.level === "error" ? "error" : details?.level === "warning" ? "warn" : null;
    if (level) log.write(level, [`[renderer] ${details.message} (${details.sourceId}:${details.lineNumber})`]);
  });
  webContents.on("render-process-gone", (_event, details) => {
    log.write("error", [`[renderer] the window's process is gone: ${details?.reason} (exit code ${details?.exitCode})`]);
  });
  webContents.on("preload-error", (_event, preloadPath, error) => {
    log.write("error", [`[renderer] the preload script ${preloadPath} failed:`, error]);
  });
}
