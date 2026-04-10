# Implementation Review Report

_Generated 2026-04-10_

## Executive Summary

The core simulation engine (Phases 1-3) is substantially complete. Phase 4 (entity behaviors, events, UI) is partially done. The specs are thorough — most Tier 0-2 gaps are marked resolved — but several implementation areas still need work or spec clarification.

---

## What's Implemented

### Fully Implemented
- **Grid/floor model**: 120 floors (-10..109), 375-tile horizontal span
- **Time system**: 2600-tick days, 7 dayparts, calendar phase flag, LCG PRNG
- **Tile placement & demolition**: 20+ tile types with validation (cost, occupancy, adjacency)
- **Three-ledger economy**: Cash balance, primary/secondary/tertiary ledgers, 3-day rollover, expense sweep
- **PlacedObjectRecord**: Full 18-byte structure with all fields
- **Checkpoint scheduler**: 18+ checkpoint bodies firing at spec-defined tick offsets
- **Carrier system**: Multi-car elevators (up to 8 cars), 3 modes (express/standard/service), floor queues, route slots
- **Special links**: Raw stairs/escalators (64-slot table), derived transfer records, reachability masks
- **Transfer groups**: Concourse routing with carrier membership
- **Walkability flags**: Per-floor connectivity for routing
- **Route selection**: Local vs express mode scoring, candidate priority
- **Entity population**: Hotel (1/2/3), office (6), condo (3), cathedral eval (40)
- **Entity state machines**: Hotel, office, condo, cathedral evaluation lifecycles
- **Commercial venues**: Capacity tracking, availability states, visit counters
- **Bomb & fire events**: Core trigger logic, blast/spread mechanics
- **Star progression**: Gates for 1-5 stars, cathedral evaluation
- **Multiplayer**: WebSocket protocol, presence tracking, optimistic client updates
- **Client rendering**: Phaser 3 grid, entity dots, carrier cars, camera controls

---

## Gaps: What Still Needs Implementation

### High Priority (Core Gameplay)

| # | Area | Spec Reference | Status | Notes |
|---|------|---------------|--------|-------|
| 1 | **Event UI prompts** | EVENTS.md (bomb ransom, fire rescue) | Not implemented | No modal/prompt system exists. Bomb auto-refuses; fire helicopter mechanics stubbed. Need client-side prompt flow + server command for player decisions. |
| 2 | **Elevator editor** | COMMANDS.md (toggle served floor, remove car, extend shaft) | Not implemented | Spec defines toggle-floor, remove-car, demolish-shaft, extend-top/bottom commands. No UI or command handlers exist. |
| 3 | **Variant/rent tier adjustment** | ECONOMY.md (variant_index 0-3) | Not implemented | Players should be able to adjust pricing tiers on facilities. No UI or command handler. |
| 4 | **Security guard patrol (bomb defusal)** | EVENTS.md (security patrol) | Partially stubbed | Guard route-to-bomb and defusal check not fully implemented. |
| 5 | **Helicopter rescue (fire)** | EVENTS.md (fire helicopter) | Stubbed | Fire spread works but rescue/extinguish mechanics are incomplete. |
| 6 | **Demolition confirmation prompts** | COMMANDS.md, OUTPUTS.md | Not implemented | Spec requires confirmation for non-removable families. |

### Medium Priority (Behavioral Completeness)

| # | Area | Spec Reference | Status | Notes |
|---|------|---------------|--------|-------|
| 7 | **Checkpoint stubs** | TIME.md checkpoints | Partially stubbed | `checkpoint_entertainment_phase1` (0x5dc), `checkpoint_afternoon_notification` (0x6a4), `checkpoint_end_of_day` (0x9f6) are stubs. |
| 8 | **Hotel vacancy claimant (family 0x0f)** | HELPERS.md | Needs verification | Search scope (modulo-6 floor group), claim timing (tick < 0x05dc), qualified room check (stay_phase 0x28/0x30). |
| 9 | **Hotel guest venue visits (family 0x21)** | HELPERS.md | Needs verification | Venue selection (uniform retail/restaurant/fast-food), min-stay enforcement, route from hotel_floor+2. |
| 10 | **Office worker stagger** | OFFICE.md (base_offset gating) | Needs verification | 6 workers staggered by base_offset; base_offset==1 special return behavior. |
| 11 | **Condo sale/refund** | CONDO.md | Needs verification | Sale fires once on first successful route while unsold. Refund at 3-day cadence when pairing_status==0. |
| 12 | **Entertainment phases** | ENTERTAINMENT.md | Partially implemented | Phase budget, link_age_counter, paired vs single-link cycles at checkpoints 0x3e8/0x4b0/0x578/0x5dc/0x640. |
| 13 | **Parking expense model** | PARKING.md | Incomplete | Expense = (right-left) * tier_rate / 10. Excluded band logic. Demand history rebuild. |
| 14 | **News events** | EVENTS.md (random news) | Not implemented | Low per-tick chance after checkpoint 0x0f0 in dayparts 0-5. |
| 15 | **Notification system** | OUTPUTS.md | Minimal | Morning/afternoon/end-of-day notifications, route-failure suppression cache — mostly stubs. |

### Low Priority (Polish / Tier 3)

| # | Area | Spec Reference | Status |
|---|------|---------------|--------|
| 16 | Lobby placement rules | GAPS.md Tier 3 | Not refined |
| 17 | Landing footprint validation | GAPS.md Tier 3 | Not refined |
| 18 | Sidecar catalog completeness | GAPS.md Tier 3 | Partial |
| 19 | Notification queuing & ordering | GAPS.md Tier 3 | Not implemented |
| 20 | RNG call-site parity | GAPS.md Tier 3 | Not verified |
| 21 | Variant index range enforcement | GAPS.md Tier 3 | Not verified |
| 22 | Save/Load persistence | SAVE-LOAD.md | Not implemented (full state snapshot exists, but no file-based save/load) |

---

## Open Questions for Binary Reverse Engineering

These are areas where the spec is ambiguous, incomplete, or marked with uncertainty, and where further RE would provide clarity:

### Critical
1. **Entity route_mode field semantics** (+0x06 word): The exact routing mode selection logic is ambiguous. How does the binary decide between local stairs, express, and carrier fallback in edge cases? What are the tie-breaking rules when multiple carriers score equally?

2. **Carrier departure threshold**: Spec says `abs(day_tick - departure_timestamp) > schedule_flag * 30`, but is `departure_timestamp` set at first boarding or queue activation? What happens at daypart boundaries?

3. **Fire spread tuning delay**: The per-floor spread rate is described as "tuning delay" but the exact tick counts per floor aren't specified. What are the actual values from the binary?

4. **Queue-full retry behavior**: When an entity encounters a full queue (40 entries), the spec says 5-tick wait, but what's the max retry count before abandoning? Does the entity try alternate carriers?

### Important
5. **Commercial venue capacity selection**: "Phase A/B/override" capacity seeds — how exactly does the binary select between these three values? What triggers the override?

6. **Entertainment link_age_counter**: How is this counter initialized and when does it wrap? The paired budget calculation (`link_age_counter / 3`) needs clearer lifecycle documentation.

7. **Parking coverage propagation**: "Ramps propagate across nearby spaces, can cross max 3-tile gaps" — what's the exact algorithm? BFS? Linear scan? Does it cross floors?

8. **Hotel sibling sync**: "Single resets to 1, twin/suite reset to 2" — is this the stay counter or something else? The exact field and reset timing need confirmation.

9. **Evaluation visitor arrival check**: "All 40 in state 0x03 before tick 800" — is this strictly all 40, or is there a threshold? What happens if some visitors fail to route?

### Nice to Have
10. **RNG call sites**: The LCG is specified, but the exact call order across all subsystems affects reproducibility. Documenting the call sequence from the binary would enable deterministic replay.

11. **Notification text/resource mapping**: Tier 3 gap — the actual notification strings and resource IDs from the binary.

12. **Palette/visual timing**: Not gameplay-critical but affects feel. What are the exact color transitions and timing for day/night cycles in the original?

13. **News event probability table**: "Low per-tick chance" — what are the actual probabilities per star level?

---

## Recommended Next Steps

1. **Implement event UI prompts** (#1) — biggest gameplay gap; bombs and fires are hollow without player interaction.
2. **Implement elevator editor** (#2) — players can't customize elevator behavior, which is a core SimTower mechanic.
3. **Fill checkpoint stubs** (#7) — entertainment phase and end-of-day logic affect facility income.
4. **Verify entity behaviors** (#8-12) — the state machines are in place but edge cases from the spec may not be handled.
5. **Request RE clarification** on items 1-4 above (critical RE questions) to unblock accurate implementation.
6. **Implement save/load** (#22) — game state is lost on server restart.
