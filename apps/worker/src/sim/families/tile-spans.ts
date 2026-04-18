// 1228:0fc2 rebuild_all_sim_tile_spans
// 1228:1018 update_sim_tile_span
//
// Per-sim tile-span tracking — the binary rebuilds the full span table at day
// 0x9c4 and updates individual spans on tile edits. No direct TS counterpart;
// tile positions are derived on-the-fly from `floorAnchor` + `selectedFloor`.
//
// TODO: binary 1228:0fc2 — port rebuild to TS.
// TODO: binary 1228:1018 — port per-sim update to TS.

import type { SimRecord, WorldState } from "../world";

export function rebuildAllSimTileSpans(_world: WorldState): void {
	// TODO: binary 1228:0fc2 — not yet ported.
}

export function updateSimTileSpan(_world: WorldState, _sim: SimRecord): void {
	// TODO: binary 1228:1018 — not yet ported.
}
