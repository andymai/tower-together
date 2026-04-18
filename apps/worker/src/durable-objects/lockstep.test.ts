import { describe, expect, it, vi } from "vitest";
import { TowerLockstepSession } from "../../../client/src/lib/lockstepSession";
import { TowerSim } from "../sim";
import { createInitialSnapshot } from "../sim/snapshot";
import { GROUND_Y } from "../sim/world";
import { resolveQueuedInputBatches, shouldEmitCheckpoint } from "./lockstep";

function createSupportedSnapshot() {
	const snapshot = createInitialSnapshot("tower-test", "Tower Test", 2_000_000);
	snapshot.world.cells[`0,${GROUND_Y}`] = "lobby";
	return snapshot;
}

describe("lockstep helpers", () => {
	it("resolves authoritative batches and preserves accepted commands when a later command is rejected", () => {
		const sim = TowerSim.create("tower-test", "Tower Test");
		const promptDismissed = vi.fn();

		const resolved = resolveQueuedInputBatches(
			sim,
			[
				{
					playerId: "player-1",
					clientSeq: 10,
					inputs: [
						{ type: "place_tile", x: 0, y: GROUND_Y, tileType: "lobby" },
						{ type: "place_tile", x: 0, y: GROUND_Y - 1, tileType: "office" },
						{
							type: "prompt_response",
							promptId: "prompt-1",
							accepted: true,
						},
					],
				},
			],
			{
				freeBuild: false,
				getPlacementRejectionReason: (tileType) =>
					tileType === "office" ? "Requires 2 stars" : null,
				onPromptDismissed: promptDismissed,
			},
		);

		expect(resolved).toEqual([
			{
				playerId: "player-1",
				clientSeq: 10,
				inputs: [
					{ type: "place_tile", x: 0, y: GROUND_Y, tileType: "lobby" },
					{
						type: "prompt_response",
						promptId: "prompt-1",
						accepted: true,
					},
				],
				rejectedReason: "Requires 2 stars",
			},
		]);
		expect(sim.cellsToArray()).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					x: 0,
					y: GROUND_Y,
					tileType: "lobby",
				}),
			]),
		);
		expect(sim.cellsToArray()).not.toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					x: 0,
					y: GROUND_Y - 1,
					tileType: "office",
				}),
			]),
		);
		expect(promptDismissed).toHaveBeenCalledWith("prompt-1");
	});

	it("emits checkpoints only at positive multiples of the configured interval", () => {
		expect(shouldEmitCheckpoint(0, 500)).toBe(false);
		expect(shouldEmitCheckpoint(499, 500)).toBe(false);
		expect(shouldEmitCheckpoint(500, 500)).toBe(true);
		expect(shouldEmitCheckpoint(1000, 500)).toBe(true);
	});
});

describe("TowerLockstepSession integration", () => {
	it("predicts locally and rolls back when the authoritative batch rejects the queued input", () => {
		vi.useFakeTimers();
		try {
			const resets: Array<{
				simTime: number;
				cells: ReturnType<TowerSim["cellsToArray"]>;
			}> = [];
			const ticks: Array<{
				simTime: number;
				cells: ReturnType<TowerSim["cellsToArray"]>;
			}> = [];
			const session = new TowerLockstepSession({
				playerId: "player-1",
				onReset: (state) => {
					resets.push({ simTime: state.simTime, cells: state.cells });
				},
				onTick: (state) => {
					ticks.push({ simTime: state.simTime, cells: state.cells });
				},
			});

			const snapshot = createSupportedSnapshot();
			session.initialize(snapshot, {
				freeBuild: true,
				speedMultiplier: 1,
			});

			expect(
				session.queueLocalBatch(1, [
					{
						type: "remove_tile",
						x: 0,
						y: GROUND_Y,
					},
				]),
			).toBeNull();

			vi.advanceTimersByTime(50);

			expect(ticks.at(-1)?.cells).not.toEqual(
				expect.arrayContaining([
					expect.objectContaining({
						x: 0,
						y: GROUND_Y,
						tileType: "lobby",
					}),
				]),
			);

			session.applyAuthoritativeBatch({
				serverTick: 1,
				batches: [
					{
						playerId: "player-1",
						clientSeq: 1,
						inputs: [],
						rejectedReason: "Requires 2 stars",
					},
				],
			});

			expect(resets.at(-1)?.simTime).toBe(1);
			expect(resets.at(-1)?.cells).toEqual(
				expect.arrayContaining([
					expect.objectContaining({
						x: 0,
						y: GROUND_Y,
						tileType: "lobby",
					}),
				]),
			);

			session.dispose();
		} finally {
			vi.useRealTimers();
		}
	});

	it("replays to the checkpoint snapshot and converges on later authoritative ticks", () => {
		vi.useFakeTimers();
		try {
			const resets: number[] = [];
			const ticks: number[] = [];
			const session = new TowerLockstepSession({
				playerId: "player-1",
				onReset: (state) => {
					resets.push(state.simTime);
				},
				onTick: (state) => {
					ticks.push(state.simTime);
				},
			});
			const initial = createInitialSnapshot(
				"tower-test",
				"Tower Test",
				2_000_000,
			);
			session.initialize(initial, {
				freeBuild: false,
				speedMultiplier: 1,
			});

			const serverSim = TowerSim.fromSnapshot(initial);
			serverSim.step();
			serverSim.step();
			const checkpoint = serverSim.saveState();

			session.applyCheckpoint(checkpoint, {
				freeBuild: false,
				speedMultiplier: 1,
			});
			vi.advanceTimersByTime(50);

			expect(resets.at(-1)).toBe(2);
			expect(ticks.at(-1)).toBe(3);

			session.dispose();
		} finally {
			vi.useRealTimers();
		}
	});
});
