// Generic ACP (Agent Client Protocol v1) connection to `copilot --acp --stdio` (NDJSON JSON-RPC).
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";

const isWin = process.platform === "win32";

export class AcpConnection extends EventEmitter {
  /**
   * @param {object} o
   * @param {string} o.command  Copilot executable ("copilot" or an absolute path)
   * @param {string} o.cwd      working directory of the process
   * @param {object} [o.env]
   */
  constructor({ command, cwd, env = process.env }) {
    super();
    Object.assign(this, { command, cwd, env });
    this.nextId = 0;
    this.pending = new Map();
    this.exited = false;
    this.stderrTail = "";
  }

  /** Spawn the agent and run `initialize`. Resolves with the agent's capabilities. */
  async start() {
    // npm installs `copilot.cmd` on Windows, which only starts through a shell; quote paths with spaces
    const cmd = isWin && /\s/.test(this.command) && !this.command.startsWith('"') ? `"${this.command}"` : this.command;
    this.proc = spawn(cmd, ["--acp", "--stdio"], {
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
    this.proc.on("error", (e) => this.#fail(e));
    this.proc.on("exit", (code, signal) => {
      this.exited = true;
      this.#fail(new Error(`copilot exited (${code ?? signal})${this.stderrTail ? `: ${this.stderrTail.trim().slice(-500)}` : ""}`));
      this.emit("exit", { code, signal, stderr: this.stderrTail });
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

  /** Stop the agent. On Windows the process is a shell wrapper, so kill the whole tree. */
  kill() {
    if (!this.proc || this.exited) return;
    try {
      this.proc.stdin.end();
    } catch {}
    if (isWin) {
      spawn("taskkill", ["/pid", String(this.proc.pid), "/T", "/F"], { windowsHide: true }).on("error", () => {});
    } else {
      this.proc.kill("SIGTERM");
      setTimeout(() => !this.exited && this.proc.kill("SIGKILL"), 3000).unref();
    }
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
