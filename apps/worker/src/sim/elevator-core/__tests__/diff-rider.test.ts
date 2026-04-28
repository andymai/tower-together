import { describe, expect, it } from "vitest";
import { RiderIndex, ShadowDiffBuffer } from "../index";

describe("RiderIndex", () => {
	it("links and looks up bidirectionally", () => {
		const idx = new RiderIndex();
		idx.link(7n, "sim:42");
		expect(idx.simIdFor(7n)).toBe("sim:42");
		expect(idx.riderRefFor("sim:42")).toBe(7n);
	});

	it("relinking the same simId drops the previous rider mapping", () => {
		const idx = new RiderIndex();
		idx.link(1n, "sim:1");
		idx.link(2n, "sim:1");
		expect(idx.simIdFor(1n)).toBeUndefined();
		expect(idx.simIdFor(2n)).toBe("sim:1");
		expect(idx.riderRefFor("sim:1")).toBe(2n);
	});

	it("unlinkRider removes both directions", () => {
		const idx = new RiderIndex();
		idx.link(7n, "sim:42");
		expect(idx.unlinkRider(7n)).toBe("sim:42");
		expect(idx.simIdFor(7n)).toBeUndefined();
		expect(idx.riderRefFor("sim:42")).toBeUndefined();
	});
});

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
