// The scenario of the cache keeper's UI checks (scripts/ui-check/checks.mjs: keeper-*). The session's model option is
// MODEL. Every prompt reports a context of 160000 tokens, writes a usage checkpoint whose cache for MODEL expires
// TTL_MS later (the keeper reads it from Copilot's history file), answers and ends. A keep-alive ping answers "."
// after $SCRIPTED_KEEPER_PING_WAIT_MS (0 without it), /compact answers as Copilot does, any other prompt
// "Answer to <prompt>.".
import { KEEPALIVE_MARKER } from "../../../cache-keeper.mjs";

const MODEL = "claude-opus-5.5";
const TTL_MS = 9000;
const COMPACT_REPLY = "Compacted conversation history and removed 4 messages and 900 tokens.";
const pingWaitMs = Number(process.env.SCRIPTED_KEEPER_PING_WAIT_MS ?? 0);

const chunk = (n, text) => ({ u: { sessionUpdate: "agent_message_chunk", messageId: `a${n}`, content: { type: "text", text } } });

export default {
  configOptions: [
    {
      id: "model",
      name: "Model",
      type: "select",
      currentValue: MODEL,
      options: [{ value: MODEL, name: MODEL }],
    },
  ],
  prompts: (text, n) => {
    const ping = text.startsWith(KEEPALIVE_MARKER);
    const answer = ping ? "." : text.startsWith("/compact") ? COMPACT_REPLY : `Answer to ${text}.`;
    return [
      ...(ping && pingWaitMs > 0 ? [{ wait: pingWaitMs }] : []),
      { u: { sessionUpdate: "usage_update", used: 160000, size: 200000 } },
      { checkpoint: { ttlMs: TTL_MS, model: MODEL } },
      chunk(n, answer),
      { end: "end_turn" },
    ];
  },
};
