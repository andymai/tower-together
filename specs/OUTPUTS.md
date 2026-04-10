# Outputs

The simulation emits:

- notifications
- modal prompts
- cash-change events
- state-change events

## Notifications

Notifications are emitted at:

- morning
- afternoon
- end of day
- notable event triggers
- some facility-state transitions

Recovered route-failure notification behavior:

- a failed route request may emit a visible route-failure notification when the caller enables feedback
- repeated failures from the same source floor are suppressed by a per-source-floor cache until that cache is cleared
- new-game initialization clears that cache
- `rebuild_route_reachability_tables()` also clears that cache before rebuilding carrier/special-link reachability, so topology edits re-enable route-failure popups even within the same save/day
- the notification uses a shared timed on-screen message slot rather than a modal prompt

Exact UI presentation is implementation-defined. Timing relative to simulation state changes is not.

Recovered notification resource mapping:

- `show_popup_notification()` loads popup art through the Windows resource-loader thunk `Ordinal_5(..., type=2, id=popup_code, hInstance=0x2d0c)`, so notification IDs are not direct counted-string IDs
- in the NE resource table, those bitmap IDs are stored with the high bit set; logical popup `0x2712` appears as raw resource id `0xa712`, `0x0568` appears as `0x8568`, and so on
- extracted bitmap-backed notification IDs confirmed directly from the binary resource table include:
  - news / preview-strip family: `0x568`, `0x569`, `0x5a8`, `0x628`, `0x629`, `0x668`, `0x6a8`, `0x6a9`, `0xb28`
  - general event popup family: `0x2710`, `0x2711`, `0x2712`, `0x2713`, `0x2714`, `0x2715`, `0x2716`
- the extracted bitmap manifest gives useful asset-name labels for some of those IDs:
  - `0x568` -> restaurant preview strip
  - `0x569` -> restaurant range popup
  - `0x5a8` -> office preview strip
  - `0x628` / `0x629` -> condo preview/range popup
  - `0x668` -> retail-shop preview strip
  - `0x6a8` / `0x6a9` -> parking-space preview/range popup
  - `0xb28` -> party-hall preview strip
- for the `0x271x` block, the binary caller graph is the reliable label source even where extracted filenames remain generic:
  - `0x2712`, `0x271b`, `0x271c`: general tower / empty-sample news variants
  - `0x2713`: bomb ransom prompt
  - `0x2714`: bomb detonation result
  - `0x2716`: fire-rescue prompt family
  - `0x2718`: star-rating / Tower award popup
  - `0x2719`: ongoing fire notification
  - `0x271a`: VIP special-visitor activation popup
  - `0x271e`: bomb/fire active-status reminder
  - `0x271f`: bomb ransom paid result

Recovered clean-room rule:

- model notifications by logical popup code, not by raw NE resource id
- preserve the event-to-popup mapping above when parity matters
- exact localized wording and pixel art are presentation data, not simulation state

## Prompts

Prompts pause the relevant gameplay flow until the player responds.

Recovered blocking prompt families:

- bomb ransom
- fire response
- demolition confirmations when active traffic would be disrupted

Recovered modal-but-acknowledgement-only dialogs:

- bomb armed / search-start status (`0xbcd`, `0xbce`)
- bomb cleanup outcome (`0xbcf`, `0xbd0`)
- treasure payout dialog (`0xbe0`)

Recovered non-simulation informational dialogs:

- selected-object / inspector dialogs (`0x2fb`, `0x2fc`) from `FUN_1108_0000`; these are UI inspection dialogs, not simulation prompts

Clean-room prompt-response command surface:

- `bomb_ransom_decision`: pay or refuse
- `fire_rescue_decision`: dispatch helicopter or decline
- `carrier_edit_confirmation`: confirm or cancel the destructive carrier edit guarded by prompt `0x3ed`

Dialogs outside those three classes may still be modal in the original UI, but they do not
represent branching simulation decisions in the recovered game logic.

Recovered headless rule:

- when a blocking prompt is emitted, the current tick finishes collecting outputs
- no later simulation tick should advance until a prompt-response command is applied
- prompt-response side effects apply first, then normal stepping may resume

## Tick Output Order

For one headless tick:

1. apply commands
2. update any immediate derived state required by those commands
3. run simulation work
4. collect cash changes
5. collect state changes
6. collect notifications
7. emit any new prompts
8. if a blocking prompt was emitted, stop further advancement until a response command is applied
