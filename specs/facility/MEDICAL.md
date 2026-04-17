# Medical Center

Family `13` (`0x0d`) is the medical family.

The medical center exists in the shipped game as a fully wired gameplay system
without any player-facing placement path. There is no build-menu entry, no
placement cost, and no tile art exposed for it, but every runtime subsystem that
would use a medical center — service queue, sim routing, UI inspect panel, star
progression gate, failure notification — is implemented and active. Any mod or
reimplementation that exposes a medical-family object will immediately pick up
working gameplay behavior.

## High-Level Identity

A medical center is a **service destination** for office workers.

- one medical center represents one clinic tenant
- workers from placed offices periodically visit a medical center after work
- medical presence is required for star progression past `3`
- an office tower without any medical center triggers a "medical demanded"
  banner whenever an office worker's medical trip fails
- medical centers are long-dwell, low-traffic destinations compared to fast food
  or entertainment

## What The Player Should Experience

From the player's point of view:

1. Without any medical center, once the tower reaches star `3`, office workers
   periodically attempt medical trips. Each failed attempt shows a "Medical
   Center demanded near Lobby" banner and blocks that day's star advancement.
2. Once a medical center is placed, the banner stops firing, pending medical
   trips resolve normally, and star advancement from `3` to `4` (and `4` to `5`)
   can proceed on the next day the qualitative gates are satisfied.
3. A placed medical center shows a pending-visitor count in its inspect panel.
   That count rises as workers queue to visit and falls as they are served.
4. Demolishing the only medical center mid-day invalidates every in-flight
   medical trip. Sims that were en route treat the destination as gone, the
   banner fires for each, and the daily flag clears again.

The key gameplay rule is that medical is **a qualitative gate tied to actual
service access**, not just a presence flag. The tower must keep medical
demand-answerable, not just medical-placed.

## Placement

Up to 10 concurrently-placed medical centers are supported.

## Demand Generation

Medical demand comes exclusively from placed offices.

At the end of each office worker's workday (the same end-of-workday transition
that normally sends the worker home via the lobby):

- if the tower is at star `< 3`, the worker always goes home
- if the tower is at star `>= 3`, the worker has roughly a **1-in-10 chance**
  per workday of taking a medical trip instead of going straight home
- medical trips are chosen independently per worker per day; there is no tower-
  wide cap, no per-worker cooldown, and no per-office rate limit

For a tower with many offices at star `>= 3`, this produces a steady stream of
medical trips each day, roughly proportional to office population.

## Trip Resolution

When a worker starts a medical trip it attempts to pick a target medical center
from the set of placed centers, weighted toward the worker's zone. The trip
then resolves in one of three ways:

- **no medical center available.** The worker cannot find any target. Fire the
  "Medical Center demanded near Lobby" banner, clear the daily flag, abandon
  the trip.
- **target valid, queue has space.** The worker joins the chosen center's
  pending-visitor queue. Later in the day, the center serves the worker; the
  pending count decrements; the worker returns to normal state.
- **target was deleted mid-trip.** The worker's chosen center no longer exists.
  Treat as the no-medical-available case: fire the banner, clear the daily
  flag, abandon the trip.

An additional safety valve exists for long-queued workers: if a worker has been
waiting in a medical queue for an extended period (the original game uses a
fixed retry count of `40`), the worker gives up waiting and proceeds as if
served. This prevents permanent sim-lock when demand greatly exceeds capacity.

## Progression Gate

The daily "office medical service ok" flag is consulted by the qualitative
star-advancement check on star transitions `3 -> 4` and `4 -> 5`:

- the flag is latched to `true` at the start of each simulated day, provided
  the tower is at star `>= 3`
- the flag is cleared the first time an office worker's medical trip fails
  that day (no center available or target deleted)
- if the flag is `false` when the star check runs, advancement is blocked and
  the "Medical Center demanded near Lobby" banner re-fires (once per day,
  guarded by the shared once-per-day notification flag)

Because the flag only clears on failed medical trips, a tower with adequate
medical coverage will advance normally. A tower without medical at star `>= 3`
will have the flag cleared within the first workday's end-of-shift ticks and
stay blocked until medical is placed.

## Notifications

Medical uses exactly one notification string: **"Medical Center demanded near
Lobby"**. It fires in two situations, both of which are the same underlying
event (a failed medical trip):

- during the day, when an individual office worker's medical trip cannot
  resolve (no center, or target deleted)
- at star transition, when the daily flag is found clear

The player sees the banner pile on during any day at star `>= 3` without
medical, because every office worker that rolls a medical trip that day fires
it independently.

## Economics

Medical centers have **no recurring income and no maintenance cost** in the
shipped game. Both the payout table and the expense table have zero entries
for family `13`. Placing a medical center adds no per-day line item to the
ledger, and serving visitors produces no revenue.

This is consistent with the rest of the medical system being exposed only as
a gate on star progression: the facility costs nothing to keep operating and
produces nothing directly; its value to the player is entirely that it
satisfies office-worker medical demand and unblocks the star `3` and star `4`
qualitative gates.

A reimplementation that gives medical an unlockable build-menu entry should
decide its own price, income, and upkeep policy; none are defined by the
original data.

## Inspect Panel

A placed medical center exposes a pending-visitor count in its selected-object
inspect panel. The count reflects the number of workers currently queued at
that specific center. When the queue drains to zero the display refreshes to
zero; when it overflows the safety-valve threshold, waiting workers depart and
the count falls.

## Authoritative Parity

The implementation details below are what the shipped game actually does,
captured for tick-for-tick parity work. A clean reimplementation should prefer
the high-level model above.

- Per-workday medical-trip roll: `star_count >= 3 && sample_lcg15() % 10 == 0`.
- Service-request table is 10 fixed slots of `(source_floor, subtype_index,
  retry_counter, _pad)`. Slot allocation is first-fit scan.
- Retry-counter overflow threshold is `0x28` (`40`). Overflow path returns
  status `2` and the worker accepts the visit.
- Daily flag is a single byte, latched by the day-start rebuild when
  `star_count > 2`, cleared by the failure stub.
- Medical is the only facility family that flows through the "service link"
  allocator. All other services route through the separate service-request
  allocator used by fast food and similar demand queues.
- The zone key used to weight target selection is
  `(source_floor - 9) / 15`, mapping the tower's working floors into a handful
  of zones, with a global fallback bucket if the zone's bucket is empty.
