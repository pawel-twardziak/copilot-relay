// The context window tier of a session: Copilot's "default" (200k) or "long_context" (1M). Copilot only takes it as
// a start flag (`copilot --acp --context long_context`), so the app picks the flag per process: from the session's
// override if it has one, else from the Settings default. The window shows it as a synthetic "Context" select.
// Copilot 1.0.116+ also offers a context option of its own for supported models: the window never shows it (one
// select, which shows Copilot's live value when it differs), and a switch goes through it live when it can
// (nativeContextOption, nativeValueFor).
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

/** Copilot's own context option among its config options, or null. Its real id was not seen (only the changelog of
 *  1.0.116 tells it exists), so: first a select (not ours) with a long_context value; else one whose id, category
 *  or name says "context" and whose values tell both tiers apart. Anything else is left alone. */
export function nativeContextOption(configOptions) {
  if (!Array.isArray(configOptions)) return null;
  const selects = configOptions.filter((o) => o?.id !== CONTEXT_OPTION_ID && o?.type === "select" && Array.isArray(o.options));
  const byValue = selects.find((o) => o.options.some((x) => x?.value === "long_context"));
  if (byValue) return byValue;
  return (
    selects.find((o) => {
      if (![o.id, o.category, o.name].some((t) => typeof t === "string" && /context/i.test(t))) return false;
      const short = nativeValueFor(o, "default");
      const long = nativeValueFor(o, "long_context");
      return short != null && long != null && short !== long;
    }) ?? null
  );
}

/** The tier Copilot's option is set to now, or null when its value is not one of the two. */
export function nativeTierOf(option) {
  if (option?.currentValue == null) return null;
  return TIERS.find((t) => nativeValueFor(option, t) === option.currentValue) ?? null;
}

/** The value of Copilot's option for a tier, or null when none can be told apart: the tier's own value first, then a
 *  value or name with 1M / long (long_context) or 200k / default without them (default). */
export function nativeValueFor(option, tier) {
  if (!option || !Array.isArray(option.options) || !normalizeTier(tier)) return null;
  const opts = option.options.filter((o) => typeof o?.value === "string");
  const exact = opts.find((o) => o.value === tier);
  if (exact) return exact.value;
  const text = (o) => `${o.value} ${o.name ?? ""}`;
  const long = (o) => /long|\b1\s?m\b/i.test(text(o));
  const match = tier === "long_context" ? opts.filter(long) : opts.filter((o) => !long(o) && /default|\b200\s?k\b/i.test(text(o)));
  return match.length === 1 ? match[0].value : null;
}

export function contextOption(override, globalDefault) {
  return {
    id: CONTEXT_OPTION_ID,
    name: "Context",
    category: "_context",
    type: "select",
    description:
      "Context window for this session. 1M needs a model with a long-context tier (e.g. Claude Sonnet 5.5) and may cost more. " +
      "Changing it restarts this session's Copilot, unless Copilot can switch it for the current model.",
    currentValue: normalizeTier(override) ?? INHERIT,
    options: [
      { value: INHERIT, name: `Default (${LABEL[effectiveTier(null, globalDefault)]})` },
      { value: "default", name: LABEL.default },
      { value: "long_context", name: LABEL.long_context },
    ],
  };
}

/** Copilot's config options plus the Context select (an earlier copy of it is replaced); Copilot's own context option
 *  is left out, so the window has one. */
export function withContextOption(configOptions, override, globalDefault) {
  const native = nativeContextOption(configOptions);
  const own = Array.isArray(configOptions) ? configOptions.filter((o) => o?.id !== CONTEXT_OPTION_ID && o !== native) : [];
  const ours = contextOption(override, globalDefault);
  // Copilot's live tier wins when it differs (a model change or Copilot itself reset it): the select shows the truth,
  // and picking the other tier again repairs it
  const live = nativeTierOf(native);
  if (live && live !== effectiveTier(override, globalDefault)) ours.currentValue = live;
  return [...own, ours];
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
 * Switch a session's context window. With `live` (Copilot's own option can take the new tier): the override is saved,
 * then `live()` sets the option and its config options come back as { configOptions }; no restart. A failed save or
 * set comes back as { refused } with the override as it was (a failed set restores it). Without `live`:
 * saveAndReopen, where a failed close restores the previous override.
 * @param {{ sessionId: string, value: unknown, tiers: ReturnType<typeof createTierStore>,
 *           refusal: () => string | null, close: () => Promise<void>, live?: (() => Promise<unknown>) | null }} o
 */
export async function switchTier({ sessionId, value, tiers, refusal, close, live }) {
  if (!isContextChoice(value)) return { refused: `Unknown context window: ${value}` };
  if (live) {
    const refused = refusal();
    if (refused) return { refused };
    const prev = tiers.get(sessionId);
    const message = (e) => e?.message ?? String(e);
    try {
      tiers.set(sessionId, value);
    } catch (e) {
      return { refused: message(e) };
    }
    try {
      return { configOptions: await live() };
    } catch (e) {
      try {
        tiers.set(sessionId, prev ?? INHERIT);
      } catch (again) {
        console.error(`[context] could not restore the context window of ${sessionId}: ${message(again)}`);
      }
      return { refused: message(e) };
    }
  }
  return saveAndReopen({
    prev: tiers.get(sessionId),
    save: () => tiers.set(sessionId, value),
    restore: (prev) => tiers.set(sessionId, prev ?? INHERIT),
    refusal,
    close,
  });
}
