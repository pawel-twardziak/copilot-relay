// Helpers of the SDK probe: report sanitising, CLI lookup, a minimal ACP client, an MCP stub server, a PNG maker.
import { spawn, spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";

export const isWin = process.platform === "win32";
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Rejects with a labelled error when `promise` does not settle within `ms`. */
export function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timeout after ${ms} ms: ${label}`)), ms);
  });
  return Promise.race([Promise.resolve(promise), timeout]).finally(() => clearTimeout(timer));
}

// ---------------------------------------------------------------------------------------------------------------
// Sanitising: the report leaves the corporate machine, so secrets are cut and long texts are shortened.

// keys that end with a secret-like word (accessToken, github_token), not counters such as tokenLimit or staticTokens
// and account names (login)
const SECRET_KEY = /(token|secret|password|passwd|authorization|cookie|api[-_]?key|credentials?|assignmentcontext|login)$/i;
const SECRET_TEXT = [
  /gh[pousr]_[A-Za-z0-9]{16,}/g,
  /github_pat_[A-Za-z0-9_]{16,}/g,
  /Bearer\s+[A-Za-z0-9._~+/=-]{12,}/gi,
  /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}/g,
];
const HOME = os.homedir();

export function cleanText(text, max = 300) {
  let s = String(text);
  for (const re of SECRET_TEXT) s = s.replace(re, "[redacted]");
  if (HOME && HOME.length > 3) {
    s = s.split(HOME).join("~");
    // Windows paths also show up with forward slashes (diffs, URLs)
    const forward = HOME.replace(/\\/g, "/");
    if (forward !== HOME) s = s.split(forward).join("~");
  }
  return s.length > max ? `${s.slice(0, max)}… (+${s.length - max} chars)` : s;
}

/** A JSON-safe copy of `value`: secrets cut, long strings and long arrays shortened, depth limited. */
export function sanitize(value, { max = 300, depth = 7, items = 40 } = {}) {
  const seen = new WeakSet();
  const walk = (v, d, key) => {
    if (v == null || typeof v === "boolean" || typeof v === "number") return v;
    if (typeof v === "bigint") return String(v);
    if (typeof v === "string") return key && SECRET_KEY.test(key) ? "[redacted]" : cleanText(v, max);
    if (typeof v === "function") return "[function]";
    if (v instanceof Date) return v.toISOString();
    if (v instanceof Error) return errorInfo(v);
    if (typeof v !== "object") return String(v);
    if (seen.has(v)) return "[circular]";
    if (d <= 0) return Array.isArray(v) ? `[array of ${v.length}]` : "[object]";
    seen.add(v);
    if (Array.isArray(v)) {
      const out = v.slice(0, items).map((x) => walk(x, d - 1, key));
      if (v.length > items) out.push(`… (+${v.length - items} items)`);
      return out;
    }
    const out = {};
    for (const [k, x] of Object.entries(v)) out[k] = walk(x, d - 1, k);
    return out;
  };
  return walk(value, depth, "");
}

export function errorInfo(e) {
  if (!(e instanceof Error)) return { message: cleanText(typeof e === "string" ? e : JSON.stringify(e) ?? String(e), 600) };
  const out = { name: e.name, message: cleanText(e.message, 900) };
  for (const k of ["code", "errno", "syscall", "data"]) if (e[k] != null) out[k] = sanitize(e[k], { max: 400, depth: 4 });
  if (e.stack) out.stack = cleanText(e.stack.split("\n").slice(1, 5).join(" | "), 700);
  if (e.cause) out.cause = errorInfo(e.cause);
  return out;
}

/** Short description of a value's shape, for results that are too big or too private to keep whole. */
export function shape(v) {
  if (Array.isArray(v)) return `array(${v.length})${v.length ? ` of ${shape(v[0])}` : ""}`;
  if (v && typeof v === "object") return `{${Object.keys(v).slice(0, 14).join(",")}${Object.keys(v).length > 14 ? ",…" : ""}}`;
  return v === null ? "null" : typeof v;
}

// ---------------------------------------------------------------------------------------------------------------
// Copilot CLI lookup. The SDK starts the runtime without a shell, so an npm `copilot.cmd` shim cannot be started
// directly on Windows: the JavaScript file behind the shim is a second candidate.

function which(name) {
  const res = spawnSync(isWin ? "where" : "which", [name], { encoding: "utf8", windowsHide: true });
  if (res.status !== 0 || !res.stdout) return [];
  return res.stdout.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
}

/** The JavaScript entry file an npm shim (`copilot.cmd`, `copilot`) starts, or null. */
export function shimTarget(shimPath) {
  let text;
  try {
    const st = fs.statSync(shimPath);
    if (st.size > 20_000) return null; // a real binary, not a shim
    text = fs.readFileSync(shimPath, "utf8");
  } catch {
    return null;
  }
  const m = text.match(/["'%$\w\\/:~.-]*?(node_modules[\\/]@github[\\/]copilot[\\/][\w\\/.-]+?\.js)/);
  if (!m) return null;
  const target = path.join(path.dirname(shimPath), m[1].replace(/[\\/]/g, path.sep));
  return fs.existsSync(target) ? target : null;
}

/**
 * Finds the installed Copilot CLI. Returns `{ command, executable, script, candidates }`:
 * `command` is what the app would run (through a shell on Windows), `executable` is a file the SDK can spawn
 * directly (or null), `script` is the JavaScript entry behind an npm shim (or null).
 */
export function resolveCli(explicit) {
  const wanted = explicit || process.env.COPILOT_CLI_PATH || process.env.COPILOT_PATH || "copilot";
  const isPath = path.isAbsolute(wanted) || /[\\/]/.test(wanted);
  const candidates = isPath ? [wanted] : which(wanted);
  const exists = candidates.filter((c) => fs.existsSync(c));
  const directly = (c) => (isWin ? /\.exe$/i.test(c) : true);
  const executable = exists.find((c) => directly(c) && !shimTarget(c)) ?? null;
  let script = null;
  for (const c of exists) {
    let real = c;
    try {
      real = fs.realpathSync(c); // npm on Linux and macOS links `copilot` to the .js file
    } catch {}
    script = /\.js$/i.test(real) ? real : shimTarget(c);
    if (script) break;
  }
  // a bare name stays a bare name: the app runs it through a shell on Windows, which finds copilot.cmd
  return { wanted, command: isPath ? (exists[0] ?? wanted) : wanted, executable, script, candidates: exists };
}

export function cliVersion(command) {
  const cmd = isWin && /\s/.test(command) && !command.startsWith('"') ? `"${command}"` : command;
  const res = spawnSync(cmd, ["--version"], { encoding: "utf8", shell: isWin, windowsHide: true, timeout: 30_000 });
  if (res.error) return { error: res.error.message };
  return { status: res.status, text: cleanText(`${res.stdout ?? ""}${res.stderr ?? ""}`.trim(), 300) };
}

// ---------------------------------------------------------------------------------------------------------------
// Minimal ACP client: the baseline the SDK is compared with. It starts the CLI the same way the app does.

export class Acp extends EventEmitter {
  constructor({ command, cwd, args = [], env = process.env }) {
    super();
    Object.assign(this, { command, cwd, args, env });
    this.nextId = 0;
    this.pending = new Map();
    this.notifications = [];
    this.exited = false;
    this.stderr = "";
  }

  async start() {
    const cmd = isWin && /\s/.test(this.command) && !this.command.startsWith('"') ? `"${this.command}"` : this.command;
    this.proc = spawn(cmd, ["--acp", "--stdio", ...this.args], {
      cwd: this.cwd,
      env: this.env,
      stdio: ["pipe", "pipe", "pipe"],
      shell: isWin,
      windowsHide: true,
    });
    const spawned = new Promise((resolve, reject) => {
      this.proc.once("spawn", resolve);
      this.proc.once("error", reject);
    });
    const fail = (err) => {
      for (const p of this.pending.values()) p.reject(err);
      this.pending.clear();
    };
    this.proc.on("error", fail);
    this.proc.on("exit", (code, signal) => {
      this.exited = true;
      fail(new Error(`copilot --acp exited (${code ?? signal}): ${cleanText(this.stderr.trim().slice(-400), 400)}`));
    });
    this.proc.stderr.on("data", (d) => (this.stderr = (this.stderr + d).slice(-4000)));
    this.proc.stdin.on("error", () => {});
    let buf = "";
    this.proc.stdout.setEncoding("utf8");
    this.proc.stdout.on("data", (chunk) => {
      buf += chunk;
      let nl;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        try {
          this.#onMessage(JSON.parse(line));
        } catch {}
      }
    });
    await spawned;
    return this.request("initialize", {
      protocolVersion: 1,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
      clientInfo: { name: "copilot-relay-sdk-probe", version: "0.0.0" },
    });
  }

  #onMessage(msg) {
    if (msg.id != null && !msg.method) {
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      if (msg.error) p.reject(Object.assign(new Error(msg.error.message ?? JSON.stringify(msg.error)), { code: msg.error.code, data: msg.error.data }));
      else p.resolve(msg.result);
    } else if (msg.method && msg.id == null) {
      this.notifications.push({ method: msg.method, params: msg.params });
      this.emit("notification", msg.method, msg.params);
    } else if (msg.method) {
      // the baseline never lets the agent act: every permission request is cancelled
      if (msg.method === "session/request_permission") this.#send({ jsonrpc: "2.0", id: msg.id, result: { outcome: { outcome: "cancelled" } } });
      else this.#send({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: `Method not supported: ${msg.method}` } });
    }
  }

  #send(obj) {
    if (!this.exited) this.proc.stdin.write(`${JSON.stringify(obj)}\n`);
  }

  request(method, params) {
    if (this.exited) return Promise.reject(new Error("copilot --acp is not running"));
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.#send({ jsonrpc: "2.0", id, method, params });
    });
  }

  async kill() {
    if (!this.proc || this.exited) return;
    const gone = new Promise((r) => this.proc.once("exit", r));
    try {
      this.proc.stdin.end();
    } catch {}
    if (isWin) spawn("taskkill", ["/pid", String(this.proc.pid), "/T", "/F"], { windowsHide: true }).on("error", () => {});
    else this.proc.kill("SIGTERM");
    await Promise.race([gone, sleep(4000)]);
    if (!this.exited && !isWin) this.proc.kill("SIGKILL");
  }
}

/** ACP `configOptions` as `{ id, name, category, current, values: [{ value, name }] }`. */
export function summarizeConfigOptions(configOptions) {
  return (Array.isArray(configOptions) ? configOptions : []).map((o) => {
    const flat = [];
    for (const x of o.options ?? []) {
      if (Array.isArray(x?.options)) for (const y of x.options) flat.push({ value: y.value, name: y.name, group: x.name ?? x.group });
      else flat.push({ value: x?.value, name: x?.name });
    }
    return { id: o.id, name: o.name, category: o.category, type: o.type, current: o.currentValue, values: flat };
  });
}

// ---------------------------------------------------------------------------------------------------------------
// MCP stub: a stateless streamable-HTTP server with one tool, standing in for the relay broker's /mcp endpoint.

export async function startMcpStub(nonce) {
  const seen = { requests: [], calls: [], headers: [], urls: [] };
  const tools = [
    {
      name: "probe_echo",
      description: "Returns the given text together with a probe marker.",
      inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
    },
  ];
  const answer = (msg) => {
    const ok = (result) => ({ jsonrpc: "2.0", id: msg.id, result });
    switch (msg.method) {
      case "initialize":
        return ok({
          protocolVersion: msg.params?.protocolVersion ?? "2025-03-26",
          capabilities: { tools: {} },
          serverInfo: { name: "sdk-probe-stub", version: "0.0.0" },
        });
      case "ping":
        return ok({});
      case "tools/list":
        return ok({ tools });
      case "tools/call": {
        seen.calls.push({ name: msg.params?.name, arguments: msg.params?.arguments });
        const text = `pong:${msg.params?.arguments?.text ?? ""}:${nonce}`;
        return ok({ content: [{ type: "text", text }], isError: false });
      }
      default:
        return msg.id == null ? null : { jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: `Method not found: ${msg.method}` } };
    }
  };
  const server = http.createServer((req, res) => {
    seen.urls.push(req.url);
    seen.headers.push({ "x-probe": req.headers["x-probe"] ?? null, accept: req.headers.accept ?? null, method: req.method });
    if (req.method !== "POST") {
      res.writeHead(405, { allow: "POST" }).end();
      return;
    }
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      let msg;
      try {
        msg = JSON.parse(body);
      } catch {
        res.writeHead(400).end();
        return;
      }
      const list = Array.isArray(msg) ? msg : [msg];
      for (const m of list) seen.requests.push(m.method ?? "(response)");
      const replies = list.map(answer).filter(Boolean);
      if (!replies.length) {
        res.writeHead(202).end();
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(Array.isArray(msg) ? replies : replies[0]));
    });
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const { port } = server.address();
  return {
    url: `http://127.0.0.1:${port}/mcp?peer=probe-alias`,
    seen,
    close: () => new Promise((r) => server.close(() => r())),
  };
}

// ---------------------------------------------------------------------------------------------------------------

function crc32(buf) {
  let c = ~0;
  for (const b of buf) {
    c ^= b;
    for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0xedb88320 : c >>> 1;
  }
  return ~c >>> 0;
}

/** A solid-colour PNG as a Buffer. */
export function solidPng(size, [r, g, b]) {
  const chunk = (type, data) => {
    const head = Buffer.alloc(8);
    head.writeUInt32BE(data.length, 0);
    head.write(type, 4, "latin1");
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
    return Buffer.concat([head, data, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr.set([8, 2, 0, 0, 0], 8); // 8 bits, RGB
  const row = Buffer.concat([Buffer.from([0]), Buffer.from(Array.from({ length: size }, () => [r, g, b]).flat())]);
  const raw = Buffer.concat(Array.from({ length: size }, () => row));
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", zlib.deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

/** Removes a directory tree; never throws (Windows keeps files locked for a moment after a process exits). */
export function rmrf(dir) {
  try {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
    return true;
  } catch {
    return false;
  }
}
