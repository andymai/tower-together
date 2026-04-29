// Bit-packed encoding of `SimRecord`'s identity tuple into a `u64` so
// it can ride along on `Rider.tag` in elevator-core. Replaces the
// bridge-side `Map<RiderId, simId>` — every rider-bearing event drained
// via `WasmSim.drainEvents` now carries `tag`, and we decode it back to
// the same shape `simKey(sim)` produces.
//
// Layout (low to high):
//   bits  0–9   homeColumn  (10 bits → 0–1023; GRID_WIDTH = 375)
//   bits 10–17  floorAnchor (8 bits  → 0–255;  GRID_HEIGHT = 120)
//   bits 18–25  familyCode  (8 bits  → 0–255;  max observed ~50)
//   bits 26–33  baseOffset  (8 bits  → 0–255;  max observed = 56)
//   bit  40     marker = 1
//
// The marker bit guarantees the encoded tag is non-zero even when every
// component is 0 — `0` is reserved by elevator-core as the "untagged"
// sentinel. With marker at bit 40 the entire encoding fits in 41 bits,
// well below `Number.MAX_SAFE_INTEGER` (2^53 − 1) so the tag survives
// the wasm DTO's `tag: number` representation losslessly.

import type { SimRecord } from "../world";

const HOME_COLUMN_BITS = 10n;
const HOME_COLUMN_MASK = (1n << HOME_COLUMN_BITS) - 1n; // 0x3ff
const FLOOR_ANCHOR_BITS = 8n;
const FLOOR_ANCHOR_MASK = (1n << FLOOR_ANCHOR_BITS) - 1n; // 0xff
const FAMILY_CODE_BITS = 8n;
const FAMILY_CODE_MASK = (1n << FAMILY_CODE_BITS) - 1n; // 0xff
const BASE_OFFSET_BITS = 8n;
const BASE_OFFSET_MASK = (1n << BASE_OFFSET_BITS) - 1n; // 0xff

const FLOOR_ANCHOR_SHIFT = HOME_COLUMN_BITS; // 10
const FAMILY_CODE_SHIFT = FLOOR_ANCHOR_SHIFT + FLOOR_ANCHOR_BITS; // 18
const BASE_OFFSET_SHIFT = FAMILY_CODE_SHIFT + FAMILY_CODE_BITS; // 26
const MARKER_BIT = 1n << 40n;

/**
 * Encode the four identity fields of a `SimRecord` (the same tuple
 * `simKey()` projects to a string) into a `u64` tag suitable for
 * `WasmSim.setRiderTag`. Lossless and reversible: pair with
 * {@link decodeSimIdTag}. Returns `bigint` because the wasm-bindgen
 * setter takes `bigint`.
 */
export function encodeSimIdTag(sim: SimRecord): bigint {
	const column = BigInt(sim.homeColumn) & HOME_COLUMN_MASK;
	const anchor =
		(BigInt(sim.floorAnchor) & FLOOR_ANCHOR_MASK) << FLOOR_ANCHOR_SHIFT;
	const family =
		(BigInt(sim.familyCode) & FAMILY_CODE_MASK) << FAMILY_CODE_SHIFT;
	const offset =
		(BigInt(sim.baseOffset) & BASE_OFFSET_MASK) << BASE_OFFSET_SHIFT;
	return MARKER_BIT | offset | family | anchor | column;
}

/**
 * Decode a tag previously produced by {@link encodeSimIdTag} back into
 * the `${floorAnchor}:${homeColumn}:${familyCode}:${baseOffset}` string
 * shape that `simKey()` emits. Returns `undefined` for `0` (the
 * untagged sentinel) and for tags missing the marker bit (riders the
 * bridge didn't spawn — e.g. someone called `setTrafficRate(>0)` and
 * elevator-core synthesized them).
 *
 * Accepts both `number` (the wasm DTO's `tag` field type) and `bigint`
 * (the engine API's setter type) so callers can pass either without
 * boilerplate.
 */
export function decodeSimIdTag(tag: number | bigint): string | undefined {
	const t = typeof tag === "bigint" ? tag : BigInt(tag);
	if (t === 0n) return undefined;
	if ((t & MARKER_BIT) === 0n) return undefined;
	const column = Number(t & HOME_COLUMN_MASK);
	const anchor = Number((t >> FLOOR_ANCHOR_SHIFT) & FLOOR_ANCHOR_MASK);
	const family = Number((t >> FAMILY_CODE_SHIFT) & FAMILY_CODE_MASK);
	const offset = Number((t >> BASE_OFFSET_SHIFT) & BASE_OFFSET_MASK);
	return `${anchor}:${column}:${family}:${offset}`;
}
