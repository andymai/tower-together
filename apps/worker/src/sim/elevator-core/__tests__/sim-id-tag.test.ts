import { describe, expect, it } from "vitest";
import type { SimRecord } from "../../world";
import { decodeSimIdTag, encodeSimIdTag } from "../sim-id-tag";

function sim(over: Partial<SimRecord>): SimRecord {
	return {
		floorAnchor: 0,
		homeColumn: 0,
		baseOffset: 0,
		facilitySlot: 0,
		familyCode: 0,
		stateCode: 0,
		// biome-ignore lint/suspicious/noExplicitAny: stub for tag-encode shape only
		route: 0 as any,
		selectedFloor: 0,
		originFloor: 0,
		destinationFloor: -1,
		venueReturnState: 0,
		queueTick: 0,
		elapsedTicks: 0,
		transitTicksRemaining: 0,
		lastDemandTick: -1,
		tripCount: 0,
		accumulatedTicks: 0,
		targetRoomFloor: -1,
		targetRoomColumn: -1,
		spawnFloor: 0,
		postClaimCountdown: 0,
		encodedTargetFloor: 0,
		commercialVenueSlot: -1,
		...over,
	};
}

describe("encodeSimIdTag / decodeSimIdTag", () => {
	it("round-trips an arbitrary sim identity", () => {
		const tag = encodeSimIdTag(
			sim({ floorAnchor: 42, homeColumn: 187, familyCode: 7, baseOffset: 3 }),
		);
		expect(decodeSimIdTag(tag)).toBe("42:187:7:3");
	});

	it("encodes the all-zero identity to a non-zero tag", () => {
		// Marker bit ensures the tag is never the reserved `0` untagged
		// sentinel even when every field is 0.
		const tag = encodeSimIdTag(
			sim({ floorAnchor: 0, homeColumn: 0, familyCode: 0, baseOffset: 0 }),
		);
		expect(tag).not.toBe(0n);
		expect(decodeSimIdTag(tag)).toBe("0:0:0:0");
	});

	it("decodes 0 as undefined (engine's untagged sentinel)", () => {
		expect(decodeSimIdTag(0)).toBeUndefined();
		expect(decodeSimIdTag(0n)).toBeUndefined();
	});

	it("decodes a tag without the marker bit as undefined", () => {
		// Defensive: if some other consumer set a tag without our marker
		// (e.g. a non-tower-together rider that snuck in), don't try to
		// interpret it as a simKey.
		expect(decodeSimIdTag(1n)).toBeUndefined();
	});

	it("accepts both bigint and number on decode", () => {
		const tag = encodeSimIdTag(
			sim({ floorAnchor: 5, homeColumn: 10, familyCode: 9, baseOffset: 1 }),
		);
		expect(decodeSimIdTag(tag)).toBe("5:10:9:1");
		expect(decodeSimIdTag(Number(tag))).toBe("5:10:9:1");
	});

	it("preserves the largest realistic field values", () => {
		// Bounds confirmed by world.ts (GRID_WIDTH=375, GRID_HEIGHT=120),
		// resources.ts (max FAMILY_* code in use ≈ 50), and states.ts
		// (max population per family = 56 → baseOffset ≤ 55).
		const tag = encodeSimIdTag(
			sim({
				floorAnchor: 119,
				homeColumn: 374,
				familyCode: 50,
				baseOffset: 55,
			}),
		);
		expect(decodeSimIdTag(tag)).toBe("119:374:50:55");
		// Stays within the 53-bit safe integer range so the wasm DTO's
		// `tag: number` round-trip is lossless.
		expect(tag).toBeLessThan(BigInt(Number.MAX_SAFE_INTEGER));
	});
});
