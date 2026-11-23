// The context window tier of a session: Copilot's "default" (200k) or "long_context" (1M). Copilot only takes it as
// a start flag (`copilot --acp --context long_context`), so the app picks the flag per process: from the session's
// override if it has one, else from the Settings default. The window shows it as a synthetic "Context" select.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";

export const CONTEXT_OPTION_ID = "context_tier";
export const INHERIT = "inherit"; // the select's value for "follow the Settings default"

const TIERS = ["default", "long_context"];
const LABEL = { default: "200k", long_context: "1M" };

/** A valid tier, or null. */
export function normalizeTier(value) {
  return TIERS.includes(value) ? value : null;
}

/** A value the Context select can send: a tier, or INHERIT. */
export function isContextChoice(value) {
  return value === INHERIT || normalizeTier(value) !== null;
}

export function effectiveTier(override, globalDefault) {
  return normalizeTier(override) ?? normalizeTier(globalDefault) ?? "default";
}

export function tierArgs(tier) {
  return tier === "long_context" ? ["--context", "long_context"] : [];
}

export function contextOption(override, globalDefault) {
  return {
    id: CONTEXT_OPTION_ID,
    name: "Context",
    category: "_context",
    type: "select",
    description:
      "Context window for this session. 1M needs a model with a long-context tier (e.g. Claude Sonnet 5.5) and may cost more. " +
      "Changing it restarts this session's Copilot.",
    currentValue: normalizeTier(override) ?? INHERIT,
    options: [
      { value: INHERIT, name: `Default (${LABEL[effectiveTier(null, globalDefault)]})` },
      { value: "default", name: LABEL.default },
      { value: "long_context", name: LABEL.long_context },
    ],
  };
}

/** Copilot's config options plus the Context select (an earlier copy of it is replaced). */
export function withContextOption(configOptions, override, globalDefault) {
  const own = Array.isArray(configOptions) ? configOptions.filter((o) => o?.id !== CONTEXT_OPTION_ID) : [];
  return [...own, contextOption(override, globalDefault)];
}

/** Per-session overrides in a small JSON file ({ [sessionId]: tier }); no entry means "follow Settings".
 *  `set` throws when the file can't be written; `copy` and `delete` are bookkeeping after a fork / delete that
 *  already succeeded, so a failed write there is only logged. */
export function createTierStore(file) {
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
    const tier = normalizeTier(value);
    if (tier) data[id] = tier;
    else if (id in data) delete data[id];
    else return;
    write(data);
  };
  const bestEffort = (fn) => {
    try {
      fn();
    } catch (e) {
      console.warn(`[context-tier] could not write ${file}: ${e.message}`);
    }
  };
  return {
    get: (id) => normalizeTier(read()[id]),
    set: put,
    delete: (id) => bestEffort(() => put(id, null)),
    copy: (fromId, toId) => bestEffort(() => put(toId, read()[fromId])),
  };
}

/**
 * Save a setting that only takes effect with a new Copilot process, and close the session's process: refusals come
 * back as { refused } before anything changes, so the window keeps the session as it is. Otherwise `save()` runs and
 * the session's process is closed ({ reopen: true }: the caller reopens it, which starts Copilot with the new
 * setting). A failed close calls `restore(prev)` and rethrows.
 * @param {{ prev: unknown, save: () => void, restore: (prev: unknown) => void,
 *           refusal: () => string | null, close: () => Promise<void> }} o
 */
export async function saveAndReopen({ prev, save, restore, refusal, close }) {
  const refused = refusal();
  if (refused) return { refused };
  save();
  try {
    await close();
  } catch (e) {
    restore(prev);
    throw e;
  }
  return { reopen: true };
}

/**
 * Switch a session's context window (see saveAndReopen); a failed close restores the previous override.
 * @param {{ sessionId: string, value: unknown, tiers: ReturnType<typeof createTierStore>,
 *           refusal: () => string | null, close: () => Promise<void> }} o
 */
export async function switchTier({ sessionId, value, tiers, refusal, close }) {
  if (!isContextChoice(value)) return { refused: `Unknown context window: ${value}` };
  return saveAndReopen({
    prev: tiers.get(sessionId),
    save: () => tiers.set(sessionId, value),
    restore: (prev) => tiers.set(sessionId, prev ?? INHERIT),
    refusal,
    close,
  });
}
