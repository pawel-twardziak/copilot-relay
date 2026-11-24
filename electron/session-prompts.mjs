// The system prompt of a session: a default part (Settings), a child part (Settings, only for child sessions) and
// the session's own part. Copilot reads it from a per-process instructions folder named by
// COPILOT_CUSTOM_INSTRUCTIONS_DIRS, so nothing is written to ~/.copilot.
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

export const CHILD_PART =
  "This session is the child of another session, its parent: it either started you with a task (the `[from …]` line of your first message) or the user linked you to it (`list_sessions` shows your parent). The parent cannot see this chat and waits for your report. When your work is done (the task you were given, or the work you were doing when you were linked), always finish with the `report_result` tool, exactly once: the result, or at least a short summary of what you did, or a note that the work is finished. If you could not finish, report that too, with what is missing. Use `send_message` only if you must ask the parent something before you can finish.";

const INSTRUCTIONS_VAR = "COPILOT_CUSTOM_INSTRUCTIONS_DIRS";

/** The non-empty (trimmed) parts joined by a blank line; the child part only for a child session. */
export function composePrompt({ defaultPart, childPart, own, isChild } = {}) {
  const parts = [defaultPart, isChild ? childPart : "", own];
  return parts
    .map((p) => (typeof p === "string" ? p.trim() : ""))
    .filter(Boolean)
    .join("\n\n");
}

/** Absent (not a string) means the built-in text; "" means no child part. */
export function effectiveChildPart(promptChild) {
  return typeof promptChild === "string" ? promptChild : CHILD_PART;
}

/** Well-formed templates only: objects with a string id (first one wins); name and text become strings. */
export function normalizeTemplates(value) {
  if (!Array.isArray(value)) return [];
  const seen = new Set();
  const out = [];
  for (const t of value) {
    if (!t || typeof t !== "object" || typeof t.id !== "string" || seen.has(t.id)) continue;
    seen.add(t.id);
    out.push({ id: t.id, name: typeof t.name === "string" ? t.name : "", text: typeof t.text === "string" ? t.text : "" });
  }
  return out;
}

/** The prompt keys of a settings:set payload, put into next (the settings about to be saved): promptDefault only as
 *  text; promptChild as text, or null to go back to the built-in text (the key is removed); promptTemplates only as
 *  an array (normalized). A key that is absent or of any other type keeps what is stored. Returns next. */
export function applyPromptSettings(next, payload) {
  if (typeof payload.promptDefault === "string") next.promptDefault = payload.promptDefault;
  if (payload.promptChild === null) delete next.promptChild;
  else if (typeof payload.promptChild === "string") next.promptChild = payload.promptChild;
  if (Array.isArray(payload.promptTemplates)) next.promptTemplates = normalizeTemplates(payload.promptTemplates);
  return next;
}

/** Per-session own parts in a small JSON file ({ [sessionId]: string }); "" removes the entry.
 *  `set` throws when the file can't be written; `copy` and `delete` are bookkeeping after a fork / delete that
 *  already succeeded, so a failed write there is only logged. */
export function createPromptStore(file, label = "session-prompts") {
  const read = () => {
    try {
      const data = JSON.parse(readFileSync(file, "utf8"));
      return data && typeof data === "object" && !Array.isArray(data) ? data : {};
    } catch {
      return {};
    }
  };
  const write = (data) => {
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(`${file}.tmp`, JSON.stringify(data, null, 2));
    renameSync(`${file}.tmp`, file);
  };
  const put = (id, value) => {
    const data = read();
    if (typeof value === "string" && value !== "") data[id] = value;
    else if (id in data) delete data[id];
    else return;
    write(data);
  };
  const bestEffort = (fn) => {
    try {
      fn();
    } catch (e) {
      console.warn(`[${label}] could not write ${file}: ${e.message}`);
    }
  };
  return {
    get: (id) => (typeof read()[id] === "string" ? read()[id] : ""),
    set: put,
    delete: (id) => bestEffort(() => put(id, "")),
    copy: (fromId, toId) => bestEffort(() => put(toId, read()[fromId])),
  };
}

/** Writes the prompt as <root>/run/p-XXXX/.github/instructions/session.instructions.md. */
export function writePromptDir(root, prompt) {
  const runDir = path.join(root, "run");
  mkdirSync(runDir, { recursive: true });
  const dir = mkdtempSync(path.join(runDir, "p-"));
  const instructions = path.join(dir, ".github", "instructions");
  mkdirSync(instructions, { recursive: true });
  writeFileSync(path.join(instructions, "session.instructions.md"), `${prompt}\n`);
  return { dir, remove: () => rmSync(dir, { recursive: true, force: true }) };
}

/** Removes the leftovers of earlier runs (called at app start). */
export function clearPromptDirs(root) {
  const runDir = path.join(root, "run");
  let names;
  try {
    names = readdirSync(runDir);
  } catch {
    return;
  }
  for (const n of names) {
    try {
      rmSync(path.join(runDir, n), { recursive: true, force: true });
    } catch (e) {
      console.warn(`Could not remove the prompt folder ${path.join(runDir, n)}: ${e.message}`);
    }
  }
}

/** A copy of env whose instructions directories end with dir (the user's own ones are kept). */
export function instructionsEnv(env, dir) {
  if (dir == null) return { ...env };
  if (dir.includes(",")) throw new Error(`The app's data folder contains a comma, so Copilot cannot be given this session's prompt: ${dir}`);
  const user = env?.[INSTRUCTIONS_VAR];
  return { ...env, [INSTRUCTIONS_VAR]: user ? `${user},${dir}` : dir };
}
