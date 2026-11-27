// One prompt whose answer is Markdown (inline code, bold, a list with a link): the history's raw text and the view's
// rendered text differ, for the UI check content-jump-markdown (scripts/ui-check/checks.mjs).
export const ANSWER_MARKDOWN =
  "To run the suite use `npm test` in the **electron** folder, then check `scripts/ui-check/run.mjs` for the rest.\n\n" +
  "- first item, a plain one\n" +
  "- second item with [link text](https://example.com/page) inside\n";

export default {
  prompts: [
    [
      { u: { sessionUpdate: "agent_message_chunk", messageId: "md1", content: { type: "text", text: ANSWER_MARKDOWN } } },
      { end: "end_turn" },
    ],
  ],
};
