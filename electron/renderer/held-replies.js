// Pure rules for held child replies (no DOM): the wait note on an approved reply, the sidebar count, the titles
// and whether the approval switch shows. Loaded as a classic <script> (sets globalThis.HeldReplies) and via
// require() in tests.
"use strict";

// a reply that waited this long for the user's approval gets the wait note
const WAIT_NOTE_MS = 60000;

/** The prompt sent for an approved reply: unchanged under the threshold, else with the wait note (N whole minutes, at least 1). */
function approvedPrompt(prompt, arrivedAt, now) {
  if (now - arrivedAt < WAIT_NOTE_MS) return prompt;
  const minutes = Math.max(1, Math.floor((now - arrivedAt) / WAIT_NOTE_MS));
  const note = `(This reply waited ${minutes} min for your user's approval. The list of your children above may be out of date: call list_sessions for their current state.)`;
  return `${prompt}\n\n${note}`;
}

/** The held count of a session in the sidebar: the open view's list, else the broker's count for `cli:<sessionId>`. */
function sidebarCount({ view, brokerHeld, sessionId }) {
  if (view) return view.held.length;
  return brokerHeld?.[`cli:${sessionId}`] ?? 0;
}

const markTitle = (n) => (n === 1 ? "1 reply from sub-sessions waits for your approval" : `${n} replies from sub-sessions wait for your approval`);

const listTitle = (n) => `Replies from sub-sessions (${n})`;

/** The approval switch shows for a session with children or with held replies. */
const showSwitch = ({ hasChildren, held }) => hasChildren || held > 0;

const HeldReplies = { WAIT_NOTE_MS, approvedPrompt, sidebarCount, markTitle, listTitle, showSwitch };
globalThis.HeldReplies = HeldReplies;
if (typeof module !== "undefined") module.exports = HeldReplies;
