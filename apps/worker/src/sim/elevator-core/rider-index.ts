// Bidirectional Map<simId, RiderId> for the bridge. Lives on the
// BridgeHandle (not in the snapshot) — the snapshot's postcard already
// carries the elevator-core side; this map carries the TS side of the
// linkage so arrival events can dispatch back to the right family
// handler.
//
// Decision: a TS Map (not elevator-core extension storage) avoids the
// serde round-trip cost on every snapshot and lets us invalidate
// linkages naturally on cancel/reroute.
//
// Key shape: elevator-core EventDtos report rider ids as u32 slot
// ids (low 32 bits of the slotmap FFI encoding), but addStop /
// spawnRiderByRef return full u64 entity refs. The index keeps both
// keyings — the BigInt ref for cancellation paths that already have
// the full ref in hand, and the slot-only number for the event-drain
// path where we only have what elevator-core hands us.

import { refToSlot } from "./bridge";

export class RiderIndex {
	private readonly slotToSim = new Map<number, string>();
	private readonly simToRider = new Map<string, bigint>();

	link(riderRef: bigint, simId: string): void {
		// If a sim already has a rider (e.g. a re-spawn after cancellation),
		// drop the old linkage so simToRider stays exclusive.
		const prevRider = this.simToRider.get(simId);
		if (prevRider !== undefined) {
			this.slotToSim.delete(refToSlot(prevRider));
		}
		this.slotToSim.set(refToSlot(riderRef), simId);
		this.simToRider.set(simId, riderRef);
	}

	simIdFor(riderRef: bigint): string | undefined {
		return this.slotToSim.get(refToSlot(riderRef));
	}

	simIdForSlot(slot: number): string | undefined {
		return this.slotToSim.get(slot);
	}

	riderRefFor(simId: string): bigint | undefined {
		return this.simToRider.get(simId);
	}

	unlinkRider(riderRef: bigint): string | undefined {
		return this.unlinkRiderBySlot(refToSlot(riderRef));
	}

	unlinkRiderBySlot(slot: number): string | undefined {
		const simId = this.slotToSim.get(slot);
		if (simId !== undefined) {
			this.slotToSim.delete(slot);
			this.simToRider.delete(simId);
		}
		return simId;
	}

	unlinkSim(simId: string): bigint | undefined {
		const riderRef = this.simToRider.get(simId);
		if (riderRef !== undefined) {
			this.simToRider.delete(simId);
			this.slotToSim.delete(refToSlot(riderRef));
		}
		return riderRef;
	}

	clear(): void {
		this.slotToSim.clear();
		this.simToRider.clear();
	}

	get size(): number {
		return this.slotToSim.size;
	}
}
