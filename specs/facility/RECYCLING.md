# Recycling Center

Binary evidence: `update_recycling_center_state` (`0x10900000`),
`reset_recycling_center_daily` (`0x109001d1`),
`compute_recycling_required_tier` (`0x10900250`),
`validate_recycling_center_stack_overlap` (`0x109002c8`), and
`delete_recycling_center_paired_floor` (`0x1090038d`).

## Identity

The recycling center is a paired two-floor placed-object stack:

- type `0x14`: upper floor
- type `0x15`: lower floor

`g_recycling_center_count` counts placed stacks, not individual floor halves. It is
incremented on placement and decremented when demolition removes the paired stack.

## Placement

Recycling centers are below-grade facilities. The first placed recycling center is
accepted without an adjacency check when `g_recycling_center_count == 0`.

After the first stack, `validate_recycling_center_stack_overlap` requires the proposed
center to overlap an existing live `0x14`/`0x15` recycling-center object within the
floor search band from `anchor - 2` through `anchor + 1`. This implements the manual
rule that recycling centers must be placed adjacent to one another.

## Adequacy

`update_recycling_center_state(checkpoint_tier)` is guarded by `star_count > 2`.
When no recycling center exists, it emits notification `3`, clears
`g_recycling_adequate_flag`, and does not sweep objects.

Otherwise it computes:

```text
required_tier = compute_recycling_required_tier()
```

`compute_recycling_required_tier` divides total population-ledger activity by
`g_recycling_center_count` and maps the quotient:

- `< 500`: tier `1`
- `< 1000`: tier `2`
- `< 1500`: tier `3`
- `< 2000`: tier `4`
- `< 2500`: tier `5`
- otherwise: tier `6`

If `checkpoint_tier < required_tier`, the applied tier is clamped to
`checkpoint_tier` and `g_recycling_adequate_flag` is cleared. If the failing checkpoint
is tier `5`, notification `4` is emitted for full recycling centers. Otherwise, the
applied tier is the required tier and `g_recycling_adequate_flag` is set.

The object sweep writes the applied tier to `stay_phase` and marks live `0x14`/`0x15`
objects dirty. During an inadequate pass, objects already at `stay_phase == 5` are
left unchanged.

## Scheduler

The scheduler uses three daily adequacy passes:

- tick `1600`: `update_recycling_center_state(0)`, a midday reset that always clears
  adequacy when a center exists
- tick `2000`: `update_recycling_center_state(2)`, the tier-2 check
- tick `2566`: `update_recycling_center_state(5)`, the final tier-5 check

Tick `32` separately calls `reset_recycling_center_daily`, which sweeps only the lower
floor type `0x15` and resets `stay_phase` from `6` to `0`, marking the object dirty.

## Progression

`g_recycling_adequate_flag` is a qualitative star gate. The normal star-advancement
path requires it for `3 -> 4` and `4 -> 5`.
