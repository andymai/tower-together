# Save And Load

The save format can be implementation-defined, but it must preserve all simulation-relevant state.

## Must Persist

- time counters
- star/progression state
- cash and all ledgers
- placed objects and their family-specific fields
- runtime actors
- sidecar records
- route queues
- per-car active assignments
- RNG state if exact replay parity across save/load is required
- walkability and reachability state, or enough information to rebuild it deterministically
- active event state
- pending prompts if the implementation allows saves during modal states

## Rebuildable State

The implementation may omit derived caches from persistence if they are rebuilt immediately and deterministically on load. Examples:

- walkability flags
- transfer-group cache
- special-link reachability
- facility bucket tables

## Load Semantics

Load should restore a state that can continue ticking without any extra hidden initialization step beyond deterministic cache rebuilds.
