// Minimal ACP (Agent Client Protocol v1) client over NDJSON/stdio for `copilot --acp --stdio`.
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";

export class AcpAgent extends EventEmitter {
  /**
   * @param {object} o
   * @param {string} o.name      agent id used for routing ("architekt")
   * @param {string} o.role      short role description injected into first prompt
   * @param {string} o.cwd       working directory for the session
   * @param {Array}  o.mcpServers ACP mcpServers list for session/new
   * @param {string} [o.command] defaults to "copilot"
   * @param {string[]} [o.args]  extra CLI args (e.g. ["--model", "gpt-5.6-luna"])
   * @param {object} [o.env]     environment for the copilot process
   */
  constructor({ name, role, cwd, mcpServers, command = "copilot", args = [], env = process.env }) {
    super();
    Object.assign(this, { name, role, cwd, mcpServers, command, args, env });
    this.queue = [];          // pending prompts (strings)
    this.busy = false;        // a session/prompt is in flight
    this.sessionId = null;
    this.nextId = 0;
    this.pending = new Map(); // our outgoing request id -> {resolve, reject}
    this.permissionWaiters = new Map(); // agent's request id -> respond fn
    this.introduced = false;
  }

  async start() {
    this.proc = spawn(this.command, ["--acp", "--stdio", ...this.args], {
      cwd: this.cwd,
      env: this.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.proc.on("exit", (code) => {
      this.emit("status", { state: "exited", code });
      for (const { reject } of this.pending.values()) reject(new Error(`agent exited (${code})`));
      this.pending.clear();
    });
    this.proc.stderr.on("data", (d) => this.emit("log", d.toString()));

    let buf = "";
    this.proc.stdout.on("data", (chunk) => {
      buf += chunk;
      let nl;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        let msg;
        try { msg = JSON.parse(line); } catch { this.emit("log", `bad json: ${line}`); continue; }
        this.#onMessage(msg);
      }
    });

    await this.#request("initialize", {
      protocolVersion: 1,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
    });
    const res = await this.#request("session/new", { cwd: this.cwd, mcpServers: this.mcpServers });
    this.sessionId = res.sessionId;
    this.emit("status", { state: "idle", sessionId: this.sessionId });
  }

  /** Enqueue a prompt; delivered when the session is idle (ACP does not queue itself). */
  enqueue(text) {
    this.queue.push(text);
    this.emit("queue", this.queue.length);
    this.#pump();
  }

  /** Answer a pending session/request_permission. optionId=null → cancelled. */
  answerPermission(reqId, optionId) {
    const respond = this.permissionWaiters.get(reqId);
    if (!respond) return false;
    this.permissionWaiters.delete(reqId);
    respond(optionId ? { outcome: { outcome: "selected", optionId } } : { outcome: { outcome: "cancelled" } });
    return true;
  }

  cancel() {
    if (this.sessionId) this.#notify("session/cancel", { sessionId: this.sessionId });
  }

  stop() {
    this.proc?.kill();
  }

  async #pump() {
    if (this.busy || !this.sessionId || this.queue.length === 0) return;
    this.busy = true;
    let text = this.queue.shift();
    this.emit("queue", this.queue.length);
    if (!this.introduced) {
      text = `${this.role}\n\n---\n\n${text}`;
      this.introduced = true;
    }
    this.emit("status", { state: "working" });
    try {
      const res = await this.#request("session/prompt", {
        sessionId: this.sessionId,
        prompt: [{ type: "text", text }],
      });
      this.emit("turn_end", res.stopReason);
    } catch (e) {
      this.emit("error", e);
    } finally {
      this.busy = false;
      this.emit("status", { state: "idle" });
      this.#pump();
    }
  }

  #onMessage(msg) {
    // Response to one of our requests
    if (msg.id != null && (msg.result !== undefined || msg.error !== undefined) && !msg.method) {
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      msg.error ? p.reject(new Error(msg.error.message ?? JSON.stringify(msg.error))) : p.resolve(msg.result);
      return;
    }
    // Notification from agent
    if (msg.method === "session/update") {
      this.emit("update", msg.params.update);
      return;
    }
    // Request from agent
    if (msg.method && msg.id != null) {
      const respond = (result) => this.#send({ jsonrpc: "2.0", id: msg.id, result });
      if (msg.method === "session/request_permission") {
        const reqId = `${this.name}:${msg.id}`;
        this.permissionWaiters.set(reqId, respond);
        this.emit("permission", { reqId, toolCall: msg.params.toolCall, options: msg.params.options });
        return;
      }
      this.#send({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: `unsupported: ${msg.method}` } });
    }
  }

  #request(method, params) {
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.#send({ jsonrpc: "2.0", id, method, params });
    });
  }

  #notify(method, params) {
    this.#send({ jsonrpc: "2.0", method, params });
  }

  #send(obj) {
    this.proc.stdin.write(JSON.stringify(obj) + "\n");
  }
}
