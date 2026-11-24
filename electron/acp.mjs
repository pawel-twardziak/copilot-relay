// Generic ACP (Agent Client Protocol v1) connection to `copilot --acp --stdio` (NDJSON JSON-RPC).
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { shellLine } from "./copilot-command.mjs";
import { killTree } from "./job-runner.mjs";

const isWin = process.platform === "win32";
const KILL_GRACE_MS = 3000; // POSIX: SIGTERM to the group, then SIGKILL

export class AcpConnection extends EventEmitter {
  #killing = false; // kill() or forceKill() was called
  #graceTimer = null;

  /**
   * @param {object} o
   * @param {string} o.command  the Copilot command line as the user wrote it (the shell runs it)
   * @param {string} o.cwd      working directory of the process
   * @param {object} [o.env]
   * @param {string[]} [o.args]  extra arguments after `--acp --stdio` (e.g. the context tier flag)
   * @param {number} [o.pollMs]  POSIX: how often the process group is checked after the shell was ended by a signal
   */
  constructor({ command, cwd, env = process.env, args = [], pollMs = 50 }) {
    super();
    Object.assign(this, { command, cwd, env, args, pollMs });
    this.nextId = 0;
    this.pending = new Map();
    this.exited = false;
    this.stderrTail = "";
  }

  /** Spawn the agent through the system shell and run `initialize`. Resolves with the agent's capabilities. On POSIX
   *  the shell leads a process group of its own, which kill() and forceKill() signal as a whole. */
  async start() {
    this.proc = spawn(shellLine(this.command, ["--acp", "--stdio", ...this.args]), {
      cwd: this.cwd,
      env: this.env,
      stdio: ["pipe", "pipe", "pipe"],
      shell: true,
      detached: !isWin,
      windowsHide: true,
    });
    const spawned = new Promise((resolve, reject) => {
      this.proc.once("spawn", resolve);
      this.proc.once("error", reject);
    });
    this.proc.on("error", (e) => this.#fail(e));
    this.proc.on("exit", (code, signal) => {
      // An exit code means the shell waited for its command, so Copilot is gone. A signal (a kill of the group, or
      // anyone's) may have ended only the shell: Copilot is gone once the group is empty, and is made to go.
      if (isWin || signal === null) return this.#exit(code, signal);
      if (!this.#killing) this.kill();
      this.#whenGroupEmpty(() => this.#exit(code, signal));
    });
    this.proc.stderr.on("data", (d) => {
      this.stderrTail = (this.stderrTail + d).slice(-4000);
    });
    this.proc.stdin.on("error", () => {}); // EPIPE after the agent died is reported through "exit"

    let buf = "";
    this.proc.stdout.setEncoding("utf8");
    this.proc.stdout.on("data", (chunk) => {
      buf += chunk;
      let nl;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        let msg;
        try {
          msg = JSON.parse(line);
        } catch {
          continue;
        }
        this.#onMessage(msg);
      }
    });

    await spawned;
    this.init = await this.request("initialize", {
      protocolVersion: 1,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
      clientInfo: { name: "copilot-relay-desktop", version: "0.1.0" },
    });
    return this.init;
  }

  request(method, params) {
    if (this.exited) return Promise.reject(new Error("copilot is not running"));
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.#send({ jsonrpc: "2.0", id, method, params });
    });
  }

  notify(method, params) {
    if (!this.exited) this.#send({ jsonrpc: "2.0", method, params });
  }

  /** Answer a request the agent sent us (e.g. session/request_permission). */
  respond(id, result) {
    if (!this.exited) this.#send({ jsonrpc: "2.0", id, result });
  }

  /** Stop the agent. Windows: the whole tree of the shell wrapper (taskkill /T /F). POSIX: SIGTERM to the process
   *  group, and SIGKILL to it after KILL_GRACE_MS unless it is gone by then. */
  kill() {
    if (!this.#stopping()) return;
    if (isWin) return killTree(this.proc);
    killTree(this.proc, "SIGTERM");
    this.#graceTimer ??= setTimeout(() => !this.exited && killTree(this.proc, "SIGKILL"), KILL_GRACE_MS).unref();
  }

  /** Stop the agent at once. Windows: as kill(). POSIX: SIGKILL to the process group. */
  forceKill() {
    if (!this.#stopping()) return;
    killTree(this.proc, isWin ? undefined : "SIGKILL");
  }

  // Closes the input and tells whether there is a process to signal (never signal without a pid: -0 is our group).
  #stopping() {
    if (!this.proc || this.exited) return false;
    this.#killing = true;
    try {
      this.proc.stdin.end();
    } catch {}
    return typeof this.proc.pid === "number";
  }

  // POSIX: calls `done` once no process is left in the group the shell led (kill(-pgid, 0) fails with ESRCH). The
  // timer is not unref'd: it runs only until the exit, and whoever waits for that exit may have nothing else to keep
  // the process alive once the agent's pipes have closed.
  #whenGroupEmpty(done) {
    const check = () => {
      try {
        process.kill(-this.proc.pid, 0);
      } catch (e) {
        if (e.code === "ESRCH") return done();
      }
      setTimeout(check, this.pollMs);
    };
    check();
  }

  #exit(code, signal) {
    this.exited = true;
    clearTimeout(this.#graceTimer);
    const err = new Error(`copilot exited (${code ?? signal})${this.stderrTail ? `: ${this.stderrTail.trim().slice(-500)}` : ""}`);
    Object.assign(err, { exitCode: code, signal });
    this.#fail(err);
    this.emit("exit", { code, signal, stderr: this.stderrTail });
  }

  #fail(err) {
    for (const { reject } of this.pending.values()) reject(err);
    this.pending.clear();
  }

  #onMessage(msg) {
    if (msg.id != null && !msg.method) {
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      if (msg.error) {
        const e = new Error(msg.error.message ?? JSON.stringify(msg.error));
        e.code = msg.error.code; // e.g. ACP's auth_required
        e.data = msg.error.data;
        p.reject(e);
      } else p.resolve(msg.result);
      return;
    }
    if (msg.method && msg.id == null) {
      this.emit("notification", msg.method, msg.params);
      return;
    }
    if (msg.method) {
      if (this.listenerCount(`request:${msg.method}`)) this.emit(`request:${msg.method}`, msg.id, msg.params);
      else this.#send({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: `Method not supported: ${msg.method}` } });
    }
  }

  #send(obj) {
    this.proc.stdin.write(JSON.stringify(obj) + "\n");
  }
}
