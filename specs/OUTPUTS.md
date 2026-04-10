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
- the notification uses a shared timed on-screen message slot rather than a modal prompt

Exact UI presentation is implementation-defined. Timing relative to simulation state changes is not.

## Prompts

Prompts pause the relevant gameplay flow until the player responds. Typical prompt families:

- bomb ransom
- fire response
- demolition confirmations when active traffic would be disrupted

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
