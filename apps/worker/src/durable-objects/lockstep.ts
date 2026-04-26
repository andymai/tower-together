import type { SimCommand } from "../sim/commands";
import type { TowerSim } from "../sim/index";
import type { ResolvedInputBatch } from "../types";

const TICK_INTERVAL_MS = 50;
const INPUT_DELAY_MS = 250;

/**
 * Ticks the client schedules ahead of `predictedTick` (and the server clamps
 * inputs into) so that a 250ms RTT round-trip lands the input deterministically
 * at the same tick on every peer. Scales with speed because ticks shrink: at
 * 10x, 50ms wall-clock is 10 ticks, so a 250ms budget becomes 50 ticks.
 */
export function getInputDelayTicks(speedMultiplier: 1 | 3 | 10): number {
	return Math.max(
		1,
		Math.ceil((INPUT_DELAY_MS * speedMultiplier) / TICK_INTERVAL_MS),
	);
}

export interface QueuedInputBatch {
	playerId: string;
	clientSeq: number;
	inputs: SimCommand[];
}

export interface LockstepResolutionOptions {
	freeBuild: boolean;
	getPlacementRejectionReason: (tileType: string) => string | null;
	onPromptDismissed?: (promptId: string) => void;
}

export function resolveQueuedInputBatches(
	sim: TowerSim,
	batches: QueuedInputBatch[],
	options: LockstepResolutionOptions,
): ResolvedInputBatch[] {
	if (batches.length === 0) {
		return [];
	}

	sim.freeBuild = options.freeBuild;

	const resolved: ResolvedInputBatch[] = [];
	for (const batch of batches) {
		const acceptedInputs: SimCommand[] = [];
		let rejectedReason: string | undefined;
		for (const command of batch.inputs) {
			if (command.type === "place_tile") {
				const placementRejectionReason = options.getPlacementRejectionReason(
					command.tileType,
				);
				if (placementRejectionReason) {
					rejectedReason = rejectedReason ?? placementRejectionReason;
					continue;
				}
			}

			const result = sim.submitCommand(command);
			if (!result.accepted) {
				rejectedReason = rejectedReason ?? result.reason ?? "Command rejected";
				continue;
			}

			acceptedInputs.push(command);
			if (command.type === "prompt_response") {
				options.onPromptDismissed?.(command.promptId);
			}
		}

		resolved.push({
			playerId: batch.playerId,
			clientSeq: batch.clientSeq,
			inputs: acceptedInputs,
			...(rejectedReason ? { rejectedReason } : {}),
		});
	}

	return resolved;
}

export function shouldEmitCheckpoint(
	simTime: number,
	intervalTicks: number,
): boolean {
	return simTime > 0 && simTime % intervalTicks === 0;
}
