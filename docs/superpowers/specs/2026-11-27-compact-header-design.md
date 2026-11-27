# Compact session header, one context selector

## Why

The session header takes 2–3 rows and mixes everyday controls with rarely used and destructive ones. It also shows
two context-window selectors. Copilot CLI 1.0.116 added its own ACP config option for the context size of supported
models. The app still adds its own synthetic "Context" select (`context-tier.mjs`) and filters out only its own id
`context_tier`, so Copilot's option passes through.

## Decisions (owner)

- **Approach A:** one context select. Copilot's own option is hidden. The app's select stays, keeping
  "Default (…)" (follow Settings) / 200k / 1M. When Copilot offers its own option and the chosen tier maps to one
  of its values, the switch is live: `session/set_config_option` and no restart. The choice is still stored as the
  session's override, so the next Copilot start gets the same `--context` flag. Without a live path (the option is
  absent, e.g. a model without a long-context tier, or no value maps), the switch restarts Copilot as today.
- The header becomes one row on a normal window width.

## Design

### Context

- `context-tier.mjs`
  - `nativeContextOption(configOptions)` finds Copilot's option. First choice: a select that is not ours, with a
    `long_context` value. Second choice: a select whose id, category or name matches `/context/i` and whose values
    map both tiers to two different values. Anything else is left alone: it is not hidden and not set. Its real id
    could not be read on this machine (the local account offers only the `auto` model). The heuristic is the call
    made here; the real id goes to the backlog as unverified.
  - `nativeValueFor(option, tier)`: the option value for a tier. An exact value match first, then by value or name:
    long_context ↔ `/long|1m/i`, default ↔ `/default|200k/i` and not long. Otherwise null.
  - `withContextOption` also drops the native option from what the window gets. When the native option's current
    value maps to a tier other than the stored one, the select shows Copilot's live tier. A model change or Copilot
    itself may reset it, and picking the other value repairs it.
  - `tierArgs` is unchanged: `--context long_context` only. An explicit `--context default` was tried and dropped
    after review. It would override a `--context` in the user's own Copilot command, and it could break wrappers or
    older CLIs on every default-tier start. The live value shown above covers the mismatch it was meant to fix,
    whenever Copilot offers its option.
- `main.mjs` `sessions:setContextTier`: if the open entry's raw options contain a native option and
  `nativeValueFor(native, effectiveTier(value, settings))` is not null, it sets that value live, stores the override
  and returns `{ configOptions }` (the view's options). Otherwise it uses today's `switchTier` (restart). The same
  refusals apply to both paths (busy turn, deleting, opening…). The live set holds `historyBusy`, so a delete or a
  restart is refused meanwhile. It has a 15 s deadline. A failed save or set leaves the override as it was and
  comes back as `{ refused, configOptions }`, carrying the options as they are now.
- When Copilot changes its own option by itself (`followedTier`): a model change that resets it, or an answer that
  lands after the deadline. Only a change of a tier Copilot already had is followed, and the stored override takes
  the tier Copilot now runs, so the select and the next start match it. A late answer also sends the window a
  `config_option_update`. An option that first shows up (a model with a long-context tier) leaves the stored choice
  alone.
- `app.js` `switchContext`: a `{ configOptions }` answer updates the selects without a reopen. The status line says
  that the context window changed without a restart.

### Header layout

One row, from left to right:

```
Title ✎ · folder | relay chip | context meter | keeper chip | [selects…] | Changes Activity Communication | ⋯
```

- A `⋯` menu button holds the rare and destructive actions: Setup…, Copy thread, Close all sub-sessions (only in a
  tree), then, after a separator, Close and Delete (red). The view's existing button elements stay (tests and code
  reach them through `promptBtn` and `closeChildrenBtn`). They move into the menu.
- The menu opens below the button and closes on an item click, Esc, a click outside, or a second click on `⋯`.
  Arrow keys move between its items.
- The selects, buttons and chips get the same height and a smaller font and padding. A select is at most 130 px
  wide, and its title shows the option's full name.
- On a narrow window the row still wraps: the selects go to a second row and the title keeps at least 100 px.
- The relations row (Parent / Sub-sessions) stays as it is.

## Non-goals

- No changes to the composer, the status bar or the Settings page.
- No new per-model context logic beyond the mapping above.

## Left to the builder

- The exact sizes and colours, within the existing tokens of `style.css`.
