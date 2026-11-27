// Message search across sessions. The scan runs in search-worker.mjs (a worker thread) with an in-memory cache;
// this is its main-side handle: one outstanding answer per query, an older query is answered { cancelled: true }.
import { Worker } from "node:worker_threads";
import { copilotHome } from "./history.mjs";

/** createContentSearch().search(query, ids) -> { cancelled: true } | { cancelled: false, sessions, more };
 *  close() ends the worker. The worker starts with the first query and is restarted once after an error exit. */
export function createContentSearch({ workerUrl = new URL("./search-worker.mjs", import.meta.url), env = process.env } = {}) {
  let worker = null;
  let seq = 0;
  let restarts = 0;
  let closed = false;
  const pending = new Map(); // seq -> { post, resolve, reject }

  function start() {
    const w = new Worker(workerUrl, { env });
    w.on("message", (reply) => {
      const p = pending.get(reply.seq);
      if (!p) return;
      pending.delete(reply.seq);
      restarts = 0;
      p.resolve(reply.cancelled ? { cancelled: true } : reply.result);
    });
    w.on("error", () => {}); // the exit event follows and handles it
    w.on("exit", (code) => {
      if (worker !== w) return;
      worker = null;
      if (closed || !pending.size) return;
      if (code !== 0 && restarts++ < 1) {
        // an older query in flight is cancelled by the newer one anyway: resend only the newest
        const newest = Math.max(...pending.keys());
        for (const [s, p] of pending) if (s !== newest) { pending.delete(s); p.resolve({ cancelled: true }); }
        pending.get(newest).post();
        return;
      }
      for (const p of pending.values()) p.reject(new Error("content search worker stopped"));
      pending.clear();
    });
    return w;
  }

  function search(query, ids) {
    if (closed) return Promise.reject(new Error("content search is closed"));
    const mySeq = ++seq;
    return new Promise((resolve, reject) => {
      const post = () => {
        worker ??= start();
        worker.postMessage({ seq: mySeq, query, ids, copilotHome: copilotHome() });
      };
      pending.set(mySeq, { post, resolve, reject });
      post();
    });
  }

  async function close() {
    closed = true;
    const w = worker;
    worker = null;
    for (const p of pending.values()) p.resolve({ cancelled: true });
    pending.clear();
    await w?.terminate();
  }

  return { search, close };
}
