// Pure helpers for editing a message in place (no DOM).
// Loaded as a classic <script> (sets globalThis.EditMessage) and via require() in tests.
"use strict";

/** A relay message from another session, as the broker writes it ("[from <name>]\n…"). */
const RELAY_PREFIX = /^\[from [^\]\n]+\]\n/;

/** Whether a user/relay bubble is yours: Left Shift+Up/Down recalls it and Edit is offered on it.
 *  A message you typed in the relay GUI is yours (relay + human); replayed relay messages start with RELAY_PREFIX. */
function isOwnMessage({ relay, human, hidden, text }) {
  if (relay && !human) return false;
  return !hidden && Boolean(text.trim()) && !RELAY_PREFIX.test(text);
}

/** The notes runPrompt put in front of your text (notes.join("\n\n") + "\n\n" + text), without the separator. */
function notesPrefix(matchText, ownText) {
  if (ownText == null || matchText === ownText) return "";
  const tail = "\n\n" + ownText;
  return matchText.endsWith(tail) ? matchText.slice(0, -tail.length) : "";
}

const COMMAND_REFUSAL = "Commands can't replace a message. Cancel the edit to run a command.";

/** Why `text` can't be sent as an edit, or null. Every command (/agent, /rename and the CLI ones) starts with "/":
 *  a CLI command is not recorded in events.jsonl, so cutting the history for it would leave nothing in its place. */
function editRefusal(text, { agentAvailable } = {}) {
  const S = globalThis.SlashCommands ?? require("./commands.js");
  const local = S.parseRenameCommand(text) || (agentAvailable && S.parseAgentCommand(text));
  return local || S.isCommandPrompt(text) ? COMMAND_REFUSAL : null;
}

function editBanner(n) {
  return `Editing a message. Sending replaces it and everything after it (${n} message${n === 1 ? "" : "s"}). Files changed by the agent are not reverted. Esc to cancel.`;
}

const EditMessage = { RELAY_PREFIX, isOwnMessage, notesPrefix, editRefusal, editBanner };
globalThis.EditMessage = EditMessage;
if (typeof module !== "undefined") module.exports = EditMessage;
