// Bidirectional Map<simId, RiderId> for the bridge. Lives on the
// BridgeHandle (not in the snapshot) — the snapshot's postcard already
// carries the elevator-core side; this map carries the TS side of the
// linkage so arrival events can dispatch back to the right family
// handler.
//
// Decision: a TS Map (not elevator-core extension storage) avoids the
// serde round-trip cost on every snapshot and lets us invalidate
// linkages naturally on cancel/reroute.

export class RiderIndex {
	private readonly riderToSim = new Map<bigint, string>();
	private readonly simToRider = new Map<string, bigint>();

	link(riderRef: bigint, simId: string): void {
		// If a sim already has a rider (e.g. a re-spawn after cancellation),
		// drop the old linkage so simToRider stays exclusive.
		const prevRider = this.simToRider.get(simId);
		if (prevRider !== undefined) {
			this.riderToSim.delete(prevRider);
		}
		this.riderToSim.set(riderRef, simId);
		this.simToRider.set(simId, riderRef);
	}

	simIdFor(riderRef: bigint): string | undefined {
		return this.riderToSim.get(riderRef);
	}

	riderRefFor(simId: string): bigint | undefined {
		return this.simToRider.get(simId);
	}

	unlinkRider(riderRef: bigint): string | undefined {
		const simId = this.riderToSim.get(riderRef);
		if (simId !== undefined) {
			this.riderToSim.delete(riderRef);
			this.simToRider.delete(simId);
		}
		return simId;
	}

	unlinkSim(simId: string): bigint | undefined {
		const riderRef = this.simToRider.get(simId);
		if (riderRef !== undefined) {
			this.simToRider.delete(simId);
			this.riderToSim.delete(riderRef);
		}
		return riderRef;
	}

	clear(): void {
		this.riderToSim.clear();
		this.simToRider.clear();
	}

	get size(): number {
		return this.riderToSim.size;
	}
}
