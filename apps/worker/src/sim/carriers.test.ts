import { describe, expect, it } from "vitest";
import { flushCarriersEndOfDay, makeCarrier } from "./carriers";
import type { WorldState } from "./world";

describe("flushCarriersEndOfDay", () => {
	it("preserves route-ring heads while clearing queue counts", () => {
		const carrier = makeCarrier(0, 100, 1, 10, 19, 1);
		const queue = carrier.floorQueues[0].up;
		for (let i = 0; i < 15; i++) queue.push(`r${i}`);
		for (let i = 0; i < 11; i++) queue.pop();

		expect(queue.head).toBe(11);
		expect(queue.size).toBe(4);

		flushCarriersEndOfDay({
			carriers: [carrier],
		} as WorldState);

		expect(queue.head).toBe(11);
		expect(queue.size).toBe(0);

		queue.push("next");
		expect(queue.head).toBe(11);
		expect(queue.peekAll()).toEqual(["next"]);
	});
});
