import { describe, expect, it, vi } from "vitest";

if (typeof requestAnimationFrame === "undefined") {
	globalThis.requestAnimationFrame = (cb) => {
		setTimeout(cb, 0);
		return 0;
	};
}

import {
	INITIAL_TOWER_SESSION_STATE,
	TowerSessionController,
	type TowerSessionScene,
	type TowerSessionSocket,
	type TowerSessionState,
} from "../../../client/src/screens/towerSessionController";
import type {
	ClientMessage,
	ConnectionStatus,
	ServerMessage,
} from "../../../client/src/types";
import { createInitialSnapshot } from "../sim/snapshot";
import { GROUND_Y } from "../sim/world";

class FakeSocket implements TowerSessionSocket {
	readonly sent: ClientMessage[] = [];
	private messageListener: ((msg: ServerMessage) => void) | null = null;
	private statusListener: ((status: ConnectionStatus) => void) | null = null;

	send(msg: ClientMessage): void {
		this.sent.push(msg);
	}

	reconnect(): void {}

	onMessage(listener: (msg: ServerMessage) => void): () => void {
		this.messageListener = listener;
		return () => {
			if (this.messageListener === listener) {
				this.messageListener = null;
			}
		};
	}

	onStatus(listener: (status: ConnectionStatus) => void): () => void {
		this.statusListener = listener;
		listener("connecting");
		return () => {
			if (this.statusListener === listener) {
				this.statusListener = null;
			}
		};
	}

	emitMessage(msg: ServerMessage): void {
		this.messageListener?.(msg);
	}

	emitStatus(status: ConnectionStatus): void {
		this.statusListener?.(status);
	}
}

function createFakeScene(): TowerSessionScene {
	return {
		applyInitState: vi.fn(),
		applyPatch: vi.fn(),
		applySims: vi.fn(),
		applyCarriers: vi.fn(),
		setPresentationClock: vi.fn(),
		computeShiftFill: vi.fn(() => []),
		setLastPlaced: vi.fn(),
		hasElevatorOverlayAt: vi.fn(() => false),
	};
}

function createSnapshot() {
	const snapshot = createInitialSnapshot("tower-test", "Tower Test", 2_000_000);
	snapshot.world.cells[`0,${GROUND_Y}`] = "lobby";
	return snapshot;
}

describe("TowerSessionController with mocked server", () => {
	it("joins on connect, sends batched input, and rolls back from an authoritative rejection", () => {
		vi.useFakeTimers();
		try {
			const socket = new FakeSocket();
			const scene = createFakeScene();
			const toasts: string[] = [];
			const states: TowerSessionState[] = [INITIAL_TOWER_SESSION_STATE];
			let lastSimTime = 0;
			const controller = new TowerSessionController({
				towerId: "tower-test",
				playerId: "player-1",
				displayName: "Tester",
				socket,
				getScene: () => scene,
				addToast: (message) => {
					toasts.push(message);
				},
				onStateChange: (state) => {
					states.push(state);
				},
				onSimTime: (simTime) => {
					lastSimTime = simTime;
				},
				onEconomy: () => {},
			});

			controller.start();
			socket.emitStatus("connected");

			expect(socket.sent.at(-1)).toEqual({
				type: "join_tower",
				playerId: "player-1",
				displayName: "Tester",
			});

			socket.emitMessage({
				type: "init_state",
				towerId: "tower-test",
				name: "Tower Test",
				simTime: 0,
				snapshot: createSnapshot(),
				speedMultiplier: 1,
				freeBuild: true,
				cash: 2_000_000,
				population: 0,
				starCount: 1,
				width: 375,
				height: 120,
			});

			controller.sendTileCommand(0, GROUND_Y, "empty", false);

			expect(socket.sent.at(-1)).toEqual({
				type: "input_batch",
				clientSeq: 1,
				inputs: [{ type: "remove_tile", x: 0, y: GROUND_Y }],
			});

			vi.advanceTimersByTime(50);

			socket.emitMessage({
				type: "authoritative_batch",
				serverTick: 1,
				batches: [
					{
						playerId: "player-1",
						clientSeq: 1,
						inputs: [],
						rejectedReason: "Server rejected removal",
					},
				],
			});

			expect(toasts).toContain("Server rejected removal");
			expect(lastSimTime).toBe(1);
			expect(states.at(-1)?.connectionStatus).toBe("connected");
			expect(states.at(-1)?.towerName).toBe("Tower Test");
			expect(states.at(-1)?.speedMultiplier).toBe(1);
			expect(scene.applyInitState).toHaveBeenCalled();
			expect(vi.mocked(scene.applyInitState).mock.calls.at(-1)?.[0]).toEqual(
				expect.arrayContaining([
					expect.objectContaining({
						x: 0,
						y: GROUND_Y,
						tileType: "lobby",
					}),
				]),
			);
			expect(scene.setPresentationClock).toHaveBeenCalled();

			controller.dispose();
		} finally {
			vi.useRealTimers();
		}
	});

	it("applies mocked session settings and prompt messages from the server", () => {
		const socket = new FakeSocket();
		const scene = createFakeScene();
		const states: TowerSessionState[] = [];
		const controller = new TowerSessionController({
			towerId: "tower-test",
			playerId: "player-1",
			displayName: "Tester",
			socket,
			getScene: () => scene,
			addToast: () => {},
			onStateChange: (state) => {
				states.push(state);
			},
			onSimTime: () => {},
			onEconomy: () => {},
		});

		controller.start();
		socket.emitMessage({
			type: "session_settings",
			speedMultiplier: 3,
			freeBuild: true,
		});
		socket.emitMessage({
			type: "prompt",
			promptId: "prompt-1",
			promptKind: "bomb_ransom",
			message: "Pay now?",
			cost: 1000,
		});
		socket.emitMessage({
			type: "prompt_dismissed",
			promptId: "prompt-1",
		});

		expect(states.at(-1)?.speedMultiplier).toBe(3);
		expect(states.at(-1)?.freeBuild).toBe(true);
		expect(states.at(-1)?.activePrompt).toBeNull();

		controller.dispose();
	});
});
