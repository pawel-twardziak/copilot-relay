# Compact header and one context select: deferred findings

**Sources:** the task review and the re-review of its fix round (Opus 5.5, high), and the final whole-branch review
(Fable 5.2, medium) of `feat/compact-header`. Execution was inline.

Spec: `docs/superpowers/specs/2026-11-27-compact-header-design.md`.

None of these blocked the merge. Line numbers were taken at the review and may drift.

**Fixed on the branch, so not listed below:**
- The native-option heuristic no longer takes an unrelated "context" option.
- A failed live switch no longer leaves the header showing the new tier.
- The select shows Copilot's live tier.
- The live set has a deadline and holds `historyBusy`.
- The always-explicit `--context default` was dropped. It would have overridden a user's own `--context`.
- The ⋯ menu now closes when its view is hidden, dropped or reopened, and on focus leaving it.
- The arrow keys work from no focused item.
- Tooltips are refreshed after a revert.
- After a reset by Copilot or a late answer, the override follows Copilot's own change of its tier, including a reset
  in the answer to a model change. It does not follow during a load's replay.
- A live set whose answer has no options shows the new tier.
- After a menu item, the focus goes back to the message box.
- At a narrow width the selects wrap instead of being clipped.

## A. Worth doing first

1. **Copilot's own context option was never seen: its id, values and behaviour are unverified.**
   - Where: `nativeContextOption`, `nativeValueFor`, `nativeTierOf` (`electron/context-tier.mjs`);
     `liveTierSwitch` (`electron/main.mjs`).
   - The local account offers only the `auto` model, so Copilot 1.0.116+ never listed the option here. The match is a
     heuristic: a `long_context` value, or a "context" id, category or name whose values tell 200k and 1M apart.
   - On the corp PC, with a Claude model that has a long-context tier, check:
     - that the header shows one Context select;
     - that 200k → 1M changes live, with the status "Context window changed (no restart needed)", and that the meter's
       size follows after the next turn;
     - what `session/new` returns for the option (id, category, values). Record it in the code comment and tighten
       the match.
   - Proposal: a probe in `scripts/sdk-probe` (or the scratch `acp-opts.mjs` approach: `initialize`, `session/new`,
     `session/set_config_option` model) that prints the option, run on the corp PC.
2. **Does a live set write Copilot's own saved tier?**
   - Copilot's changelog says the ACP option works "without changing your saved defaults". This is not verified.
   - If it does write it, a live switch would also change the user's terminal `copilot` and the app's own spawns that
     pass no `--context`: the lister (`getLister`, `main.mjs` ~418) and the headless runtime (`copilot-runtime.mjs`).
   - Proposal: check `~/.copilot/settings.json` (`contextTier`) before and after a live switch on the corp PC.

## B. Window and wording

3. **The context meter keeps the old window size after a live switch** until Copilot's next `usage_update`
   (`usageChip`, `app.js`). Proposal: on `{ configOptions }` from `setContextTier`, scale the meter's total to the new
   tier (200k / 1M) until the next update.
4. **Native values other than the two tiers cannot be picked.** A native option with, say, a 500k value is hidden
   (it matches by its `long_context` value), and only 200k and 1M are offered. Proposal: when such values show up on
   the corp PC, add them to the app's select, or show the native option instead of ours.
5. **The relay chip's rename `<input>` has a different height** from the 26 px header controls while you edit it
   (`style.css`, `.head` rules). Proposal: `.head input { height: 26px; font-size: 12px; }`.
6. **The ⋯ menu's focus mark is only a background change** (`.more-menu button:focus-visible`, `style.css`).
   Proposal: keep the background and add an inset `box-shadow` in `--accent` for keyboard focus.

## C. Small behaviour

7. **A menu item that becomes disabled while focused** (Setup when a relay turn starts with the menu open) drops the
   focus to `body`. Esc and the arrow keys then no longer reach the menu. A click anywhere still closes it.
   Proposal: listen for keys on `document` while the menu is open.
8. **The stored choice is not followed when Copilot's option first shows up with another tier.**
   - Example: the override is 1M, and the session switches to a model that has a long-context tier while Copilot
     shows 200k. The select shows 200k (Copilot's live tier) while the override stays 1M.
   - Choosing 1M switches it live. Choosing 200k fires no change event, because it is already the shown value, so the
     next start goes back to 1M. This is deliberate: it keeps the user's 1M choice through a model without the tier.
   - Proposal: on the first showing, set Copilot's option live to the stored tier (an "enforce at first sight", with
     the deadline and a guard against a loop), or mark the mismatch in the label, e.g. "200k (saved: 1M)".
9. **Default-tier starts take Copilot's own saved tier.** `tierArgs` passes no flag for 200k. If the user's terminal
   Copilot saved 1M, a "Default (200k)" session runs 1M. The select shows 1M only for models that offer Copilot's
   option. Proposal: the enforce in item 8 at open, or a probe of whether `--context default` is safe with the
   corp CLI and wrappers.
10. **`historyBusy` is a shared Set.** The live set adds to it and deletes from it, as the restart path's close
    already did. A truncate that overlapped it over IPC would lose its mark early. The renderer stays busy during
    the switch, so this is not reachable from the window. A delete or a Setup refused during a live switch says
    "Wait until the delete of a message has finished." Proposal: a separate `contextBusy` set with its own text.
11. **A native option with a `long_context` value is hidden even when its 200k value cannot be mapped** (e.g.
    "standard"). A 200k pick then takes the restart path. Acceptable until the real values are known (item 1).

12. **One row only for a plain session at 1280 px.** With the keeper chip, or a tree session with a relay chip,
    Activity and Communication (about 1110 px of controls), the header takes two rows, and the title takes the spare
    width of row 1. One row would need a window of about 1435 px. This is still fewer rows than before.
    - Where: `style.css` `.head` rules (~100-116).
    - Proposal: a title basis of 100 px and tighter gaps; or Activity / Communication as icon buttons with titles.

## D. Tests and housekeeping

13. **The restart path of the Context select has no UI check** (a session without Copilot's option: switch → the view
   reopens with `--context long_context`). This was missing before this branch too.
14. **No UI check presses a real Tab in the ⋯ menu** (the driver has no Tab helper). Unit coverage exists only for
    `context-tier.mjs`. Nor are `followedTier` with a real late answer or a real reset after a model change.
15. **`header-one-context` proves the live path only through the status text, the view and the process.** It does not
    assert that the agent's `context_size` became `long_context`. It also does not cover the refused branch, the
    timeout branch, or a model change that resets the option, in the window. Proposal: let the scripted agent write
    its options to `.scripted-agent.json` and read them in the check. Add a scenario whose model set resets
    `context_size`.
16. **Not run:** Windows and macOS (menu positioning, focus), and the corp PC (item 1).
