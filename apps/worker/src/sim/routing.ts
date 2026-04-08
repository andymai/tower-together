import { GRID_HEIGHT, MAX_SPECIAL_LINKS, type WorldState } from "./world";

// ─── Rebuild special-link segment table (§3.1) ────────────────────────────────

/**
 * Populate world.special_links from world.carriers.
 * Each carrier registers one segment covering its full floor span.
 * bit 0 of flags = express carrier (mode 1).
 */
export function rebuild_special_links(world: WorldState): void {
	world.special_links = Array.from({ length: MAX_SPECIAL_LINKS }, () => ({
		active: false,
		flags: 0,
		start_floor: 0,
		height_metric: 0,
		carrier_id: -1,
	}));

	let idx = 0;
	for (const carrier of world.carriers) {
		if (idx >= MAX_SPECIAL_LINKS) break;
		const seg = world.special_links[idx++];
		seg.active = true;
		seg.flags = carrier.carrier_mode === 1 ? 1 : 0; // bit 0 = express
		seg.start_floor = carrier.bottom_served_floor;
		seg.height_metric = carrier.top_served_floor - carrier.bottom_served_floor;
		seg.carrier_id = carrier.carrier_id;
	}
}

// ─── Rebuild floor walkability flags (§3.1) ───────────────────────────────────

/**
 * For every floor covered by at least one active special-link segment:
 *   bit 0 → reachable by a local elevator or escalator
 *   bit 1 → reachable by an express elevator
 */
export function rebuild_walkability_flags(world: WorldState): void {
	world.floor_walkability_flags = new Array(GRID_HEIGHT).fill(0);

	for (const seg of world.special_links) {
		if (!seg.active) continue;
		const bit = (seg.flags & 1) !== 0 ? 2 : 1; // express → bit 1, local → bit 0
		const hi = seg.start_floor + seg.height_metric;
		for (let f = seg.start_floor; f <= hi; f++) {
			if (f >= 0 && f < GRID_HEIGHT) world.floor_walkability_flags[f] |= bit;
		}
	}
}

// ─── Rebuild transfer-group cache (§3.2) ─────────────────────────────────────

/**
 * Each floor's entry is a bitmask of carrier IDs whose range includes that floor.
 * Parking objects (family 0x18 = code 24) are accounted for here too; they don't
 * change the bitmask but mark that floor as an explicit transfer point in Phase 4.
 * Max 32 carriers supported by 32-bit bitmask.
 */
export function rebuild_transfer_group_cache(world: WorldState): void {
	world.transfer_group_cache = new Array(GRID_HEIGHT).fill(0);

	for (const carrier of world.carriers) {
		if (carrier.carrier_id >= 32) continue; // overflow guard
		const bit = 1 << carrier.carrier_id;
		for (
			let f = carrier.bottom_served_floor;
			f <= carrier.top_served_floor;
			f++
		) {
			if (f >= 0 && f < GRID_HEIGHT) world.transfer_group_cache[f] |= bit;
		}
	}
}

// ─── Walkability checks (§3.1) ────────────────────────────────────────────────

/**
 * True if every floor in [from, to] (inclusive) has bit 0 set —
 * i.e., is reachable by at least one local elevator or escalator.
 */
export function is_floor_span_walkable_for_local_route(
	world: WorldState,
	from_floor: number,
	to_floor: number,
): boolean {
	const lo = Math.min(from_floor, to_floor);
	const hi = Math.max(from_floor, to_floor);
	for (let f = lo; f <= hi; f++) {
		if (!(world.floor_walkability_flags[f] & 1)) return false;
	}
	return true;
}

/**
 * True if every floor in [from, to] (inclusive) has bit 1 set —
 * i.e., is reachable by at least one express elevator.
 */
export function is_floor_span_walkable_for_express_route(
	world: WorldState,
	from_floor: number,
	to_floor: number,
): boolean {
	const lo = Math.min(from_floor, to_floor);
	const hi = Math.max(from_floor, to_floor);
	for (let f = lo; f <= hi; f++) {
		if (!(world.floor_walkability_flags[f] & 2)) return false;
	}
	return true;
}

// ─── Route candidate selection (§3.3) ────────────────────────────────────────

export interface RouteCandidate {
	carrier_id: number;
	cost: number;
}

/**
 * Find the lowest-cost route from from_floor to to_floor.
 *
 * Priority order (lower cost wins):
 *   Local special-link  → |Δfloor| × 8
 *   Express special-link → |Δfloor| × 8 + 0x280
 *   Carrier direct       → |Δfloor| × 8 + 0x280
 *   Carrier transfer     → |Δfloor| × 8 + 3000
 *
 * Returns null if no route exists.
 */
export function select_best_route_candidate(
	world: WorldState,
	from_floor: number,
	to_floor: number,
): RouteCandidate | null {
	if (from_floor === to_floor) return null;

	const delta = Math.abs(from_floor - to_floor);
	const lo = Math.min(from_floor, to_floor);
	const hi = Math.max(from_floor, to_floor);
	let best: RouteCandidate | null = null;

	function try_c(carrier_id: number, cost: number): void {
		if (!best || cost < best.cost) best = { carrier_id, cost };
	}

	// Check special-link segments first (covers local + express carriers)
	for (const seg of world.special_links) {
		if (!seg.active) continue;
		if (seg.start_floor > lo || seg.start_floor + seg.height_metric < hi)
			continue;
		const is_express = (seg.flags & 1) !== 0;
		try_c(seg.carrier_id, is_express ? delta * 8 + 0x280 : delta * 8);
	}

	// Check direct carrier connections (safety net if special_links not rebuilt)
	for (const carrier of world.carriers) {
		if (carrier.bottom_served_floor > lo || carrier.top_served_floor < hi)
			continue;
		try_c(carrier.carrier_id, delta * 8 + 0x280);
	}

	// Check transfer routes via transfer_group_cache
	const a_mask = world.transfer_group_cache[from_floor] ?? 0;
	const b_mask = world.transfer_group_cache[to_floor] ?? 0;
	for (let t = 0; t < GRID_HEIGHT; t++) {
		if (t === from_floor || t === to_floor) continue;
		const t_mask = world.transfer_group_cache[t] ?? 0;
		const leg1 = a_mask & t_mask; // carriers covering from_floor → t
		const leg2 = t_mask & b_mask; // carriers covering t → to_floor
		// Valid transfer: leg1 and leg2 non-zero and distinct (different carriers)
		if (leg1 && leg2 && (leg1 & leg2) === 0) {
			try_c(ctz(leg1), delta * 8 + 3000);
			break; // first transfer found is sufficient for cost comparison
		}
	}

	return best;
}

// ─── Internal helpers ─────────────────────────────────────────────────────────

/** Count trailing zeros — index of lowest set bit. */
function ctz(n: number): number {
	if (n === 0) return 32;
	return Math.log2(n & -n) | 0;
}
