// The window's side of the reply fallback (no DOM): a session whose agent has no relay tools gets a note in its prompt,
// and the app forwards its last reply to the sender (see electron/fallback.mjs and
// docs/superpowers/specs/2026-11-27-relay-fallback-design.md). Here: the chain's origin, the note's strip for the
// bubble, the card's and the system lines' wording and whether the switch shows.
// Loaded as a classic <script> (sets globalThis.Fallback) and via require() in tests. The note itself is built in
// main (electron/relay-tools.mjs, ESM, which a classic script cannot import): its marker and wording are copied here,
// and a test keeps the two equal. In a function: classic scripts share one scope (held-replies.js has a showSwitch).
(function () {
  "use strict";

  const NOTE_MARK = "[relay fallback]";
  // the note main appends (relay-tools.mjs fallbackNote): HEAD, the recipient's name, then one of the TAILS
  const HEAD = `${NOTE_MARK}\nYou cannot use the relay tools in this session. Your last message of this turn is sent to "`;
  const tail = (as) => `" as your ${as}, so end the turn with the result itself, or a short summary. Ignore any instruction to use report_result or send_message, here or in your instructions.`;
  const TAILS = [tail("report"), tail("reply")];

  const isNote = (s) => s.startsWith(HEAD) && TAILS.some((t) => s.length >= HEAD.length + t.length && s.endsWith(t));

  /** The text without a trailing note block ("\n\n" + the whole note, to the end); any other text is unchanged. */
  function stripNote(text) {
    const s = String(text);
    const sep = `\n\n${NOTE_MARK}\n`;
    // from the last marker back: the latest one that starts a whole note (a name may contain the marker too)
    for (let i = s.lastIndexOf(sep); i >= 0; i = i > 0 ? s.lastIndexOf(sep, i - 1) : -1) {
      if (isNote(s.slice(i + 2))) return s.slice(0, i);
    }
    return text;
  }

  /** Who a chain's answer goes to: the sender of a relay item with a peer key (none for the broker's own notices), the
   *  owner for a turn typed in the app, else nobody (null). Commands and the continue prompt start no chain. */
  function originOf(item, source) {
    if (item?.kind === "relay") return typeof item.fromKey === "string" && item.fromKey ? { kind: "relay", fromKey: item.fromKey, fromName: item.from ?? "" } : null;
    return source === "app" ? { kind: "owner" } : null;
  }

  /** A custom agent is set (an "agent" option with a non-empty value): only then can the session lack the relay tools
   *  (the default agent always has them), so only then is main asked for the note. */
  const customAgent = (agentOption) => !!agentOption?.currentValue;

  /**
   * The reply fallback's part of one prompt. A chain is the prompt a message starts, the messages delivered into it
   * mid-turn, the answers to queued messages while the interrupted task waits (`answer`), and the continue prompt.
   * Returns { meta, asksNote, starts, fbSeq }: meta for main ({ seq, first, origin } or null), whether to ask main for
   * the note, whether this prompt starts a chain (the caller ends the running one first), the view's chain after it.
   * A follow-up prompt (mid-turn, answer, continue) carries the running chain's id, with or without an origin of its
   * own, so main counts it; outside a chain it has none (it never starts one). A command or a message without a
   * sender to answer starts no chain.
   */
  function promptMeta({ fbSeq, midTurn, isContinue, isCmd, answer, item, source, customAgent: custom, newId }) {
    if (midTurn || isContinue || answer) {
      return { meta: fbSeq ? { seq: fbSeq.id, first: false, origin: fbSeq.origin } : null, asksNote: false, starts: false, fbSeq: fbSeq ?? null };
    }
    const origin = isCmd ? null : originOf(item, source);
    if (!origin) return { meta: null, asksNote: false, starts: true, fbSeq: null };
    const next = { id: newId(), origin };
    return { meta: { seq: next.id, first: true, origin }, asksNote: !!custom, starts: true, fbSeq: next };
  }

  /** Whether the chain is over when its renderer chain ended: not while the continue prompt follows or answers to
   *  queued messages are still due (the interrupted task waits); always after a Stop or an error. */
  const chainEnds = ({ afterTurn, answerDue, stopped, failed }) => {
    if (stopped || failed) return true;
    if (afterTurn === "continue") return false;
    return !answerDue;
  };

  const as = (kind) => (kind === "report" ? "as its report" : "as a message");

  /** The question on a pending forward's card. */
  const cardText = ({ toName, kind }) => `This session has no relay tools. Send this reply to "${toName}" ${as(kind)}?`;

  /** The system line after a forward went out, with the broker's answer. */
  const sentLine = ({ toName, kind, result }) => `Sent this reply to "${toName}" ${as(kind)} (no relay tools).${result ? ` Relay: ${result}` : ""}`;

  /** The system line after Don't send. */
  const droppedLine = ({ toName }) => `Did not send this reply to "${toName}".`;

  // on a card whose forward a broker without the route refused (nothing was sent another way)
  const OLD_BROKER = "The relay broker is too old for this. Update it in Settings → Relay.";

  /** On a card whose forward did not get through (the card stays, Send tries again). */
  const notSentLine = (error) => `Not sent: ${error}`;

  const SWITCH_LABEL = "Forwarded replies";
  const SWITCH_TITLE = "This session's agent has no relay tools: the app forwards its replies. On: each waits here for your approval";

  /** The "fallback" switch after "Approve:" shows when the session cannot answer with the relay tools or has a forward waiting. */
  const showSwitch = ({ cannotAnswer, pending } = {}) => !!cannotAnswer || (pending ?? 0) > 0;

  const Fallback = { NOTE_MARK, stripNote, originOf, customAgent, promptMeta, chainEnds, cardText, sentLine, droppedLine, OLD_BROKER, notSentLine, SWITCH_LABEL, SWITCH_TITLE, showSwitch };
  globalThis.Fallback = Fallback;
  if (typeof module !== "undefined") module.exports = Fallback;
})();
