// What of a user message is shown and searchable. Loaded as a classic <script> (sets globalThis.MessageText) and via
// require() in tests and the content-search worker.
(() => {
  const MQ = globalThis.MessageQueue ?? require("./message-queue.js");
  const FL = globalThis.FileLinks ?? require("./file-links.js");

  /** Text of a replayed user message as the user sees it: a queued message comes back wrapped, the app's continue
   *  prompt as its label. */
  const shownUserText = (raw) => (MQ.isContinuePrompt(raw) ? MQ.CONTINUE_LABEL : MQ.unwrap(raw) ?? raw);

  /** The text without a leading `[from <name>]` line and, when present, the `[folder "…"]` line after it. */
  function relayBody(text) {
    const s = String(text ?? "");
    const from = FL.FROM_LINE.exec(s);
    if (!from) return s;
    const rest = s.slice(from[0].length);
    const folder = FL.FOLDER_LINE.exec(rest);
    return folder ? rest.slice(folder[0].length) : rest;
  }

  /** What a search looks at in a replayed user message: shown text without the relay sender header. */
  const searchableUserText = (raw) => relayBody(shownUserText(raw));

  const MessageText = { shownUserText, relayBody, searchableUserText };
  globalThis.MessageText = MessageText;
  if (typeof module !== "undefined") module.exports = MessageText;
})();
