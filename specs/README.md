# Simulation Spec

This directory is the implementation-facing simulation spec. It is organized by subsystem instead of by source-discovery order.

## Core Docs

- `OVERVIEW.md`: scope, parity goals, and headless-engine assumptions
- `DATA-MODEL.md`: shared records, identifiers, and state fields
- `TIME.md`: tick model, scheduler, checkpoints, and daily resets
- `ROUTING.md`: route selection, walkability, transfer logic, and delays
- `ELEVATORS.md`: carrier records, car behavior, queues, and boarding
- `PEOPLE.md`: shared runtime-actor model and state-code conventions
- `FACILITIES.md`: facility taxonomy and shared readiness/support rules
- `ECONOMY.md`: costs, payouts, expenses, ledgers, and pricing
- `GAME-STATE.md`: star progression, global flags, and tower-level state
- `EVENTS.md`: bomb, fire, and other simulation events
- `SAVE-LOAD.md`: persisted state
- `COMMANDS.md`: build, demolish, pricing, prompts, and elevator editing
- `OUTPUTS.md`: notifications, prompts, and simulation outputs
- `PARITY-NOTES.md`: unresolved details and known approximation boundaries
- `GAPS.md`: concrete blockers and open questions for fully faithful reimplementation

## Facility Docs

- `facility/README.md`: facility-family index
- `facility/HOTEL.md`
- `facility/OFFICE.md`
- `facility/CONDO.md`
- `facility/COMMERCIAL.md`
- `facility/ENTERTAINMENT.md`
- `facility/LOBBY.md`
- `facility/PARKING.md`
- `facility/RECYCLING.md`
- `facility/METRO.md`
- `facility/EVALUATION.md`
- `facility/HOTEL.md`
- `facility/HOUSEKEEPING.md`
