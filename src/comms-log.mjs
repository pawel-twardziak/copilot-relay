// Durable, append-only log of messages between sessions, in $XDG_STATE_HOME/copilot-relay/communications.jsonl.
// One JSON line per event; the line holds the (cut) text, memory holds only the public event and the line's byte
// position, so `text(id)` reads it back on demand. A crash may leave a half-written last line: it is skipped and cut off.
import { randomUUID } from "node:crypto";
import { appendFileSync, closeSync, mkdirSync, openSync, readFileSync, readSync, renameSync, truncateSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { stateFile } from "./name-store.mjs";

const TEXT_MAX = 65536;
const PREVIEW_MAX = 300;
const REWRITE_DELAY_MS = 1000;
const NL = 10;

export class CommsLog {
  constructor({ file = process.env.COPILOT_RELAY_COMMS_FILE ?? stateFile("communications.jsonl"), newId = randomUUID, now = Date.now, cap = 50000 } = {}) {
    this.file = file;
    this.newId = newId;
    this.now = now;
    this.items = []; // { event, offset, length } in append order
    this.byId = new Map(); // message id -> item
    this.last = new Map(); // message id -> last status
    this.size = 0; // bytes in the file
    this.listeners = [];
    this.timer = null;
    this.pending = false; // a purge is waiting for its rewrite
    this.#load(cap);
  }

  /** Write a message line; returns the public event (preview and size, no text). */
  append({ id, kind, fromKey, toKey, from, to, text, status, fallback }) {
    const full = String(text ?? "");
    const cut = full.length > TEXT_MAX ? `${full.slice(0, TEXT_MAX)}…` : full;
    const event = {
      id: id ?? this.newId(), ts: this.now(), kind, fromKey, toKey, from, to,
      size: full.length,
      preview: full.length > PREVIEW_MAX ? `${full.slice(0, PREVIEW_MAX)}…` : full,
      status,
      ...(fallback ? { fallback: true } : {}),
    };
    const { preview, ...rest } = event;
    this.#write(event, JSON.stringify({ ...rest, text: cut }));
    return event;
  }

  /** Record a status change of message `ref`; null when it is unknown or "delivered" is not due. */
  status(ref, status) {
    const prev = this.last.get(ref);
    if (prev === undefined) return null;
    if (status === "delivered" && prev !== "queued" && prev !== "awaiting-reopen") return null;
    const event = { id: this.newId(), ts: this.now(), kind: "status", ref, status };
    this.#write(event, JSON.stringify(event));
    return event;
  }

  lastStatus(id) {
    return this.last.get(id);
  }

  /** Messages from or to any of `keys`, each followed by its status events, in append order. */
  eventsOf(keys) {
    const set = new Set(keys);
    const ids = new Set();
    const out = [];
    for (const { event: e } of this.items) {
      if (e.kind === "status") {
        if (ids.has(e.ref)) out.push(e);
      } else if (set.has(e.fromKey) || set.has(e.toKey)) {
        ids.add(e.id);
        out.push(e);
      }
    }
    return out;
  }

  /** The stored (cut) text of a message, read from the file; null when unknown. */
  text(id) {
    const item = this.byId.get(id);
    if (!item) return null;
    const buf = Buffer.alloc(item.length);
    const fd = openSync(this.file, "r");
    try {
      readSync(fd, buf, 0, item.length, item.offset);
    } finally {
      closeSync(fd);
    }
    return JSON.parse(buf.toString("utf8")).text ?? "";
  }

  /** Forget the key's messages and their status events; the file is rewritten soon (see flush). Returns how many. */
  purge(key) {
    const gone = new Set();
    for (const { event: e } of this.items) if (e.kind !== "status" && (e.fromKey === key || e.toKey === key)) gone.add(e.id);
    const kept = this.items.filter(({ event: e }) => (e.kind === "status" ? !gone.has(e.ref) : !gone.has(e.id)));
    const n = this.items.length - kept.length;
    if (!n) return 0;
    this.#keepOnly(kept);
    this.pending = true;
    this.#schedule();
    return n;
  }

  /**
   * Rewrite the file now when a purge is waiting for it (otherwise a debounced timer does it); a no-op when nothing is
   * pending. Never throws: false when the rewrite failed (memory and the old file stay as they were; pending stays set).
   */
  flush() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (!this.pending) return true;
    try {
      this.#rewrite();
      this.pending = false;
      return true;
    } catch (e) {
      console.warn(`comms log ${this.file}: rewrite failed (${e.message}); kept the old file`);
      try {
        unlinkSync(`${this.file}.tmp`);
      } catch {
        // no stale tmp file, or not removable
      }
      return false;
    }
  }

  onAppend(fn) {
    this.listeners.push(fn);
  }

  #write(event, text) {
    const data = `${text}\n`;
    mkdirSync(path.dirname(this.file), { recursive: true });
    appendFileSync(this.file, data);
    const length = Buffer.byteLength(data);
    this.#index(event, this.size, length);
    this.size += length;
    for (const fn of this.listeners) {
      try {
        fn(event);
      } catch {
        // a listener must not break the log
      }
    }
  }

  #index(event, offset, length) {
    const item = { event, offset, length };
    this.items.push(item);
    if (event.kind === "status") {
      if (this.last.has(event.ref)) this.last.set(event.ref, event.status);
    } else {
      this.byId.set(event.id, item);
      this.last.set(event.id, event.status);
    }
  }

  #keepOnly(kept) {
    this.items = [];
    this.byId = new Map();
    this.last = new Map();
    for (const { event, offset, length } of kept) this.#index(event, offset, length);
  }

  #schedule() {
    if (this.timer) return;
    this.timer = setTimeout(() => this.flush(), REWRITE_DELAY_MS);
    this.timer.unref();
  }

  /** Write the kept lines to file.tmp and rename it over the file; offsets are renumbered. */
  #rewrite() {
    let old = Buffer.alloc(0);
    try {
      old = readFileSync(this.file);
    } catch (e) {
      if (e?.code !== "ENOENT") throw e;
    }
    const parts = [];
    let offset = 0;
    const moved = this.items.map(({ event, offset: from, length }) => {
      parts.push(old.subarray(from, from + length));
      const item = { event, offset, length };
      offset += length;
      return item;
    });
    mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, Buffer.concat(parts));
    renameSync(tmp, this.file);
    this.size = offset;
    this.#keepOnly(moved);
  }

  #load(cap) {
    let buf;
    try {
      buf = readFileSync(this.file);
    } catch (e) {
      // only a missing file means "start empty"
      if (e?.code !== "ENOENT") throw e;
      return;
    }
    // a file that does not end with a newline has a half-written tail: cut it off so the next line starts fresh
    const end = buf.lastIndexOf(NL) + 1;
    if (end < buf.length) truncateSync(this.file, end);
    this.size = end;
    let start = 0;
    while (start < end) {
      const nl = buf.indexOf(NL, start);
      const length = nl + 1 - start;
      try {
        const o = JSON.parse(buf.toString("utf8", start, nl));
        if (o && typeof o === "object" && o.id !== undefined && o.kind !== undefined) {
          const { text, ...event } = o;
          if (event.kind !== "status") {
            const full = String(text ?? "");
            event.preview = full.length > PREVIEW_MAX ? `${full.slice(0, PREVIEW_MAX)}…` : full;
          }
          this.#index(event, start, length);
        }
      } catch {
        // a corrupt line is skipped
      }
      start = nl + 1;
    }
    if (this.items.length > cap) {
      this.#keepOnly(this.items.slice(-cap));
      this.#rewrite();
    }
  }
}
