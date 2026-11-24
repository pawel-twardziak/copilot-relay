// Pure rules for held messages of every kind (child, parent, other, user; no DOM): the wait note on an approved
// message, the sidebar count, the titles and whether an approval switch shows. Loaded as a classic <script> (sets
// globalThis.HeldReplies) and via require() in tests.
"use strict";

// a message that waited this long for the user's approval gets the wait note
const WAIT_NOTE_MS = 60000;

const KINDS = ["parent", "other", "user", "child"]; // the order of the lists
const SWITCH_KINDS = ["child", "parent", "other", "user"]; // the order of the switches

/** The held kind of a message: "child" for a child's reply, else its `heldAs` (parent, other, user), else null. */
function kindOf(m) {
  if (m?.fromChild === true) return "child";
  return m?.heldAs === "parent" || m?.heldAs === "other" || m?.heldAs === "user" ? m.heldAs : null;
}

/** Whether a message of `kind` waits in its list: the switch is on and it has a delivery id; a user message only during a turn or when it comes back. */
function shouldHold({ kind, on, deliveryId, prompting, cameBack }) {
  if (!kind || !on || !deliveryId) return false;
  return kind === "user" ? !!(prompting || cameBack) : true;
}

/** The prompt sent for an approved message: unchanged under the threshold, else with the wait note of its kind (N whole minutes, at least 1). */
function approvedPrompt(prompt, arrivedAt, now, kind = "child") {
  if (now - arrivedAt < WAIT_NOTE_MS || kind === "user") return prompt;
  const minutes = Math.max(1, Math.floor((now - arrivedAt) / WAIT_NOTE_MS));
  const notes = {
    child: `(This reply waited ${minutes} min for your user's approval. The list of your children above may be out of date: call list_sessions for their current state.)`,
    parent: `(This message waited ${minutes} min for your user's approval. The list of your relatives above may be out of date: call list_sessions for their current state.)`,
    other: `(This message waited ${minutes} min for your user's approval.)`,
  };
  return notes[kind] ? `${prompt}\n\n${notes[kind]}` : prompt;
}

/** The held count of a session in the sidebar: the open view's list, else the broker's counts by kind, else its old total for `cli:<sessionId>`. */
function sidebarCount({ view, brokerHeld, brokerByKind, sessionId }) {
  if (view) return view.held.length;
  const byKind = brokerByKind?.[`cli:${sessionId}`];
  if (byKind) return Object.values(byKind).reduce((sum, n) => sum + (n || 0), 0);
  return brokerHeld?.[`cli:${sessionId}`] ?? 0;
}

const markTitle = (n) => (n === 1 ? "1 message waits for your approval" : `${n} messages wait for your approval`);

/** The line in a view that is dead after the open: its held messages are delivered again once the session is open. */
const comeBackLine = (n) => (n === 1 ? "1 held message will come back when the session is open again." : `${n} held messages will come back when the session is open again.`);

const LIST_TITLES = { parent: "Orders from parent", other: "Other sessions", user: "Your messages", child: "Replies from sub-sessions" };
const SWITCH_LABELS = { child: "Sub-session replies", parent: "Parent orders", other: "Other sessions", user: "My messages while busy" };

const listTitle = (kind, n) => `${LIST_TITLES[kind]} (${n})`;
const switchLabel = (kind) => SWITCH_LABELS[kind];

/** The system line after a held message is discarded. */
function discardLine(kind, from) {
  if (kind === "user") return "Discarded your message.";
  const what = { child: "a reply", parent: "an order", other: "a message" }[kind];
  return `Discarded ${what} from ${from}.`;
}

/** Whether the approval switch of `kind` shows: with held items of the kind, else when the relation that makes the kind possible exists. */
function showSwitch({ kind, hasChildren, hasParent, onRelay, held }) {
  if (held > 0) return true;
  if (kind === "child") return !!hasChildren;
  if (kind === "parent") return !!hasParent;
  if (kind === "other") return !!onRelay;
  return kind === "user";
}

/** Inserts `item` into `list` ordered by arrivedAt (oldest first), after any item with an equal time (stable). Returns `list`. */
function insertByArrival(list, item) {
  let i = list.length;
  while (i > 0 && list[i - 1].arrivedAt > item.arrivedAt) i--;
  list.splice(i, 0, item);
  return list;
}

const HeldReplies = { KINDS, SWITCH_KINDS, kindOf, shouldHold, insertByArrival, WAIT_NOTE_MS, approvedPrompt, sidebarCount, markTitle, listTitle, switchLabel, discardLine, comeBackLine, showSwitch };
globalThis.HeldReplies = HeldReplies;
if (typeof module !== "undefined") module.exports = HeldReplies;
