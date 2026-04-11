# Parity Notes

This document tracks the remaining gaps that could affect exact replay parity or polish.

## Tier 1: Mechanically Important Gaps

- none currently confirmed after the latest binary-grounded pass

## Tier 2: Interaction Gaps

- exact editor-side behavior for elevator schedule editing
- exact prompt/notification sequencing in all edge cases
- some demolish-time post-cancellation behavior when actors were already in flight

## Tier 3: Cosmetic Gaps

- text/resource mapping that has no simulation effect
- palette/visual refresh timing
- UI-only labels and warnings beyond their simulation triggers

## Guidance

When an unresolved point does not affect simulation state, prefer a simpler implementation.

When an unresolved point could affect deterministic outcomes, isolate it behind a small subsystem boundary so it can be corrected later without changing the broader engine model.
