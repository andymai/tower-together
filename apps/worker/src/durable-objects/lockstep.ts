import type { SimCommand } from "../sim/commands";
import type { TowerSim } from "../sim/index";
import type { ResolvedInputBatch } from "../types";

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
