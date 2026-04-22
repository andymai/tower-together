import type { SimCommand } from "../../../worker/src/sim/commands";
import { type SimSnapshot, TowerSim } from "../../../worker/src/sim/index";
import type {
	CarrierCarStateData,
	CellData,
	ResolvedInputBatch,
	SimStateData,
} from "../types";

const BASE_TICK_INTERVAL_MS = 50;

function cloneSnapshot(snapshot: SimSnapshot): SimSnapshot {
	return structuredClone(snapshot);
}

type RenderState = {
	simTime: number;
	cash: number;
	population: number;
	starCount: number;
	cells: CellData[];
	sims: SimStateData[];
	carriers: CarrierCarStateData[];
};

type SessionSettings = {
	freeBuild: boolean;
	speedMultiplier: 1 | 3 | 10;
};

type PendingLocalBatch = {
	clientSeq: number;
	inputs: SimCommand[];
	predictedTick: number;
};

type AuthoritativeFrame = {
	serverTick: number;
	batches: ResolvedInputBatch[];
};

type TickUpdate = Omit<RenderState, "cells"> & {
	cellPatches: CellData[];
	receivedAtMs: number;
	tickIntervalMs: number;
};

interface TowerLockstepSessionOptions {
	playerId: string;
	onReset: (state: RenderState, timing: { receivedAtMs: number }) => void;
	onTick: (state: TickUpdate) => void;
}

export class TowerLockstepSession {
	private readonly playerId: string;
	private readonly onReset: TowerLockstepSessionOptions["onReset"];
	private readonly onTick: TowerLockstepSessionOptions["onTick"];
	private sim: TowerSim | null = null;
	private timer: ReturnType<typeof setInterval> | null = null;
	private baseSnapshot: SimSnapshot | null = null;
	private baseTick = 0;
	private predictedTick = 0;
	private settings: SessionSettings = {
		freeBuild: false,
		speedMultiplier: 1,
	};
	private readonly authoritativeFrames = new Map<number, AuthoritativeFrame>();
	private readonly pendingLocalBatches = new Map<number, PendingLocalBatch>();

	constructor({ playerId, onReset, onTick }: TowerLockstepSessionOptions) {
		this.playerId = playerId;
		this.onReset = onReset;
		this.onTick = onTick;
	}

	initialize(snapshot: SimSnapshot, settings: SessionSettings): void {
		this.baseSnapshot = cloneSnapshot(snapshot);
		this.baseTick = this.baseSnapshot.time.totalTicks;
		this.predictedTick = this.baseTick;
		this.settings = settings;
		this.authoritativeFrames.clear();
		this.pendingLocalBatches.clear();
		this.sim = TowerSim.fromSnapshot(cloneSnapshot(this.baseSnapshot));
		this.sim.freeBuild = settings.freeBuild;
		this.emitReset();
		this.restartTimer();
	}

	dispose(): void {
		if (this.timer !== null) {
			clearInterval(this.timer);
			this.timer = null;
		}
	}

	updateSettings(settings: Partial<SessionSettings>): void {
		this.settings = {
			...this.settings,
			...settings,
		};
		if (this.sim) {
			this.sim.freeBuild = this.settings.freeBuild;
		}
		if (settings.speedMultiplier !== undefined) {
			this.restartTimer();
		}
	}

	applyCheckpoint(snapshot: SimSnapshot, settings: SessionSettings): void {
		this.baseSnapshot = cloneSnapshot(snapshot);
		this.baseTick = this.baseSnapshot.time.totalTicks;
		this.settings = settings;
		for (const tick of [...this.authoritativeFrames.keys()]) {
			if (tick <= this.baseTick) {
				this.authoritativeFrames.delete(tick);
			}
		}
		for (const [clientSeq, batch] of this.pendingLocalBatches) {
			if (batch.predictedTick <= this.baseTick) {
				this.pendingLocalBatches.delete(clientSeq);
			}
		}
		this.replayTo(Math.max(this.predictedTick, this.baseTick));
		this.restartTimer();
	}

	applyAuthoritativeBatch(frame: AuthoritativeFrame): void {
		if (frame.serverTick <= this.baseTick) {
			return;
		}
		this.authoritativeFrames.set(frame.serverTick, frame);
		for (const batch of frame.batches) {
			if (batch.playerId === this.playerId) {
				this.pendingLocalBatches.delete(batch.clientSeq);
			}
		}
		this.replayTo(Math.max(this.predictedTick, frame.serverTick));
	}

	queueLocalBatch(clientSeq: number, inputs: SimCommand[]): string | null {
		if (inputs.length === 0 || !this.sim) {
			return null;
		}
		const preview = TowerSim.fromSnapshot(this.sim.saveState());
		preview.freeBuild = this.settings.freeBuild;
		const targetTick = this.predictedTick + 1;
		const queuedForTick = [...this.pendingLocalBatches.values()]
			.filter((batch) => batch.predictedTick === targetTick)
			.sort((left, right) => left.clientSeq - right.clientSeq);
		for (const batch of queuedForTick) {
			for (const command of batch.inputs) {
				preview.submitCommand(command);
			}
		}
		for (const command of inputs) {
			const result = preview.submitCommand(command);
			if (!result.accepted) {
				return result.reason ?? "Command rejected";
			}
		}
		this.pendingLocalBatches.set(clientSeq, {
			clientSeq,
			inputs,
			predictedTick: targetTick,
		});
		return null;
	}

	setStarCount(starCount: 1 | 2 | 3 | 4 | 5 | 6): void {
		if (!this.sim) {
			return;
		}
		this.sim.setStarCount(starCount);
		this.emitReset();
	}

	private restartTimer(): void {
		if (this.timer !== null) {
			clearInterval(this.timer);
			this.timer = null;
		}
		if (!this.sim) {
			return;
		}
		const interval = Math.max(
			1,
			Math.round(BASE_TICK_INTERVAL_MS / this.settings.speedMultiplier),
		);
		this.timer = setInterval(() => {
			this.advanceOneTick();
		}, interval);
	}

	private advanceOneTick(): void {
		if (!this.sim) {
			return;
		}
		this.predictedTick += 1;
		const cellPatches: CellData[] = [];
		this.applyInputsForTick(
			cellPatches,
			this.authoritativeFrames.get(this.predictedTick)?.batches ?? [],
			(batch) => batch.inputs,
		);
		this.applyInputsForTick(
			cellPatches,
			[...this.pendingLocalBatches.values()],
			(batch) =>
				batch.predictedTick === this.predictedTick ? batch.inputs : [],
		);
		const stepResult = this.sim.step();
		cellPatches.push(...stepResult.cellPatches);
		this.emitTick(cellPatches);
	}

	private replayTo(targetTick: number): void {
		if (!this.baseSnapshot) {
			return;
		}
		const sim = TowerSim.fromSnapshot(this.baseSnapshot);
		sim.freeBuild = this.settings.freeBuild;
		for (let tick = this.baseTick + 1; tick <= targetTick; tick += 1) {
			this.applyInputsForTick(
				null,
				this.authoritativeFrames.get(tick)?.batches ?? [],
				(batch) => batch.inputs,
				sim,
			);
			this.applyInputsForTick(
				null,
				[...this.pendingLocalBatches.values()],
				(batch) => (batch.predictedTick === tick ? batch.inputs : []),
				sim,
			);
			sim.step();
		}
		this.sim = sim;
		this.predictedTick = Math.max(targetTick, this.baseTick);
		this.emitReset();
	}

	private applyInputsForTick<TBatch>(
		cellPatches: CellData[] | null,
		batches: TBatch[],
		getInputs: (batch: TBatch) => SimCommand[],
		sim = this.sim,
	): void {
		if (!sim) {
			return;
		}
		for (const batch of batches) {
			for (const command of getInputs(batch)) {
				const result = sim.submitCommand(command);
				if (!result.accepted || !cellPatches) {
					continue;
				}
				cellPatches.push(...(result.patch ?? []));
			}
		}
	}

	private emitReset(): void {
		if (!this.sim) {
			return;
		}
		this.onReset(this.captureState(), {
			receivedAtMs: performance.now(),
		});
	}

	private emitTick(cellPatches: CellData[]): void {
		if (!this.sim) {
			return;
		}
		this.onTick({
			simTime: this.sim.simTime,
			cash: this.sim.cash,
			population: this.sim.population,
			starCount: this.sim.starCount,
			sims: this.sim.simsToArray(),
			carriers: this.sim.carriersToArray(),
			cellPatches,
			receivedAtMs: performance.now(),
			tickIntervalMs: BASE_TICK_INTERVAL_MS / this.settings.speedMultiplier,
		});
	}

	private captureState(): RenderState {
		if (!this.sim) {
			throw new Error("Lockstep session not initialized");
		}
		return {
			simTime: this.sim.simTime,
			cash: this.sim.cash,
			population: this.sim.population,
			starCount: this.sim.starCount,
			cells: this.sim.cellsToArray(),
			sims: this.sim.simsToArray(),
			carriers: this.sim.carriersToArray(),
		};
	}
}
