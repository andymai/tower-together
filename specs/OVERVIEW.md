# Overview

## Purpose

This spec defines a headless simulation core for the tower game. The goal is mechanical parity: the same rules, timing, thresholds, routing outcomes, economy, and progression behavior, even if the reimplementation uses a different UI and persistence format.

## Scope

The spec covers:

- tower state
- runtime actors
- simulation time and scheduler checkpoints
- routing and elevator behavior
- routing demand generation (`DEMAND.md`)
- facility state machines
- income, expenses, and ledgers
- star progression
- events
- save/load-relevant state
- player interventions that mutate simulation state

The spec does not cover:

- rendering
- animation presentation
- sound
- desktop-window behavior
- exact legacy dialog layout

## Non-Negotiable Parity

The following must remain mechanically identical:

- daily checkpoint timing and ordering
- route feasibility rules and route costs
- capacity limits and slot limits
- income and expense amounts
- score thresholds and pairing/readiness transitions
- occupancy lifecycle rules
- star-gate conditions
- event trigger conditions

## Acceptable Implementation Freedom

The following can differ as long as gameplay outcomes stay the same:

- UI model
- serialization format
- internal naming
- display-only state
- notification plumbing

## Headless API Shape

Recommended engine surface:

- `load_state(snapshot)`
- `save_state()`
- `step()`
- `advance_ticks(n)`
- `submit_command(command)`
- `collect_notifications()`

Commands should be applied before the next simulation tick unless a command explicitly states otherwise.
