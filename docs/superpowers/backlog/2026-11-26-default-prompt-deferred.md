# Built-in default prompt part: deferred findings

**Sources:** the task review (opus, high) of `feat/default-prompt`. The change is small and ran inline, without a
spec or plan: the built-in `DEFAULT_PART` (`electron/session-prompts.mjs`) tells a session to delegate specialised,
self-contained work to child sessions with `create_session`.

None of these blocked the merge. Line numbers were taken at the review and may drift.

**Fixed on the branch, so not listed below:**
- **Old installs:** versions before this one stored `promptDefault: ""` on every Settings save (the form's empty
  field), which now means "no default part". `migratePromptDefault` drops such a "" once at start; a save by this
  version marks the key with `promptDefaultExplicit`, so a "" the user saves now stays.
- **Relay off:** the built-in text names `create_session`, which only a session with the relay has. Without the relay
  (`relayConfig().enabled` false) a session gets no built-in text; a text of the user's own applies always.
- **README:** `electron/README.md`, "Session prompts", describes the default part's built-in text.

## A. Worth doing first

- None.

## B. Window and wording

1. **The built-in text is not checked against a real Copilot model.** Whether sessions really delegate more (and not
   too much: each child is a card to approve) is unverified. Manual check on this machine and on the corp PC: start a
   session, give it a task with research + implementation, see whether it proposes children and how it writes their
   tasks. Adjust the wording of `DEFAULT_PART` from what happens.
2. **The Settings form shows the built-in text with the relay off**, though sessions then do not get it. The hint
   under the field says so ("applies only with copilot-relay on"); the field itself does not change.

## C. Small behaviour

1. **Every session with the relay now writes a prompt folder** (`connect`, `electron/main.mjs:347-358`). Before, only
   sessions with a prompt did. A data folder whose path contains a comma (e.g. a Windows profile "Kowalski, Jan")
   makes `instructionsEnv` throw, and the session does not start. The error says the path has a comma but not that
   emptying the default part (with no own or child part) avoids it. Proposal: add that workaround to the error text,
   or quote the path if `COPILOT_CUSTOM_INSTRUCTIONS_DIRS` allows it (unverified).
2. **The migration cannot tell a deliberate old "" from the form's default.** A user who emptied the default part on
   purpose before this version gets the built-in text once and has to empty the field again. Accepted: the old form
   could not express the difference.

## D. Tests and housekeeping

1. `docs/superpowers/specs/2026-11-23-session-prompts-design.md:94` and
   `docs/superpowers/plans/2026-11-23-session-prompts.md:29` still say `promptDefault` is "" by default. They are
   historical documents; left as they are.
2. The built-in text with the relay on reaching a normal (non-child) session is covered only through the child
   (`child-prompt-built-in-default`, with a broker) and by unit tests; there is no UI check of a top-level session
   with the relay on.
3. Not run: Windows, macOS, the corp PC.
