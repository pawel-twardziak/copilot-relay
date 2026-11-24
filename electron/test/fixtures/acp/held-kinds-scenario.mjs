// The scenario of the UI check held-kinds-e2e (scripts/ui-check/checks.mjs): like link-scenario.mjs every prompt plays
// { relay: "prompt" } ("send_message <to> <text>" and "adopt_session <name>" call that relay tool), but the third prompt
// of a session then asks a permission and waits for its answer, so that turn runs for as long as the check needs.
const quick = [{ relay: "prompt" }];
const waiting = [
  { relay: "prompt" },
  { u: { sessionUpdate: "tool_call", toolCallId: "w1", title: "echo ok", kind: "execute", status: "pending" } },
  { perm: { toolCallId: "w1", title: "echo ok", kind: "execute", status: "pending" } },
  { u: { sessionUpdate: "tool_call_update", toolCallId: "w1", status: "completed" } },
  { end: "end_turn" },
];

export default { prompts: [quick, quick, waiting, ...Array.from({ length: 97 }, () => quick)] };
