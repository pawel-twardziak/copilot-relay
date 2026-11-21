// Count of session/prompt requests pending per session. A queued message can start a second prompt while the
// first is still running, so a boolean would be reset by whichever finishes first. `entry.prompting` stays a
// number that is truthy while any prompt is pending.

/** Count one more pending prompt. True when it is the first (the session just became busy). */
export function beginPrompt(entry) {
  entry.prompting = (entry.prompting || 0) + 1;
  return entry.prompting === 1;
}

/** One prompt finished. True when none is pending any more. */
export function endPrompt(entry) {
  if (!entry.prompting) return false;
  entry.prompting -= 1;
  return entry.prompting === 0;
}
