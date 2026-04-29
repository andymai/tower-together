import { describe, expect, it } from "vitest";
import { ShadowDiffBuffer } from "../index";

describe("ShadowDiffBuffer", () => {
	it("preserves chronological order under capacity", () => {
		const buf = new ShadowDiffBuffer(4);
		for (let i = 0; i < 3; i++) {
			buf.push({ tick: i, kind: "rider-exited", detail: { i } });
		}
		const snap = buf.snapshot();
		expect(snap.map((e) => e.tick)).toEqual([0, 1, 2]);
	});

	it("wraps around when full, dropping oldest entries", () => {
		const buf = new ShadowDiffBuffer(3);
		for (let i = 0; i < 5; i++) {
			buf.push({ tick: i, kind: "rider-exited", detail: { i } });
		}
		const snap = buf.snapshot();
		// Capacity 3 with 5 pushes → entries 2, 3, 4 in order.
		expect(snap.map((e) => e.tick)).toEqual([2, 3, 4]);
	});

	it("clear empties the buffer", () => {
		const buf = new ShadowDiffBuffer(2);
		buf.push({ tick: 0, kind: "rider-exited", detail: {} });
		buf.clear();
		expect(buf.size).toBe(0);
		expect(buf.snapshot()).toEqual([]);
	});
});
