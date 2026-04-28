// Shadow-mode diff buffer. Captures elevator-core side-effects on each
// tick (events drained, position deltas vs the classic engine) so we
// can validate that the bridge is actually doing the right thing
// without letting it drive gameplay yet. PR 3 ships read-only;
// PR 4 acts on the events directly.
//
// Storage is a small ring buffer scoped per-bridge — bounded so a
// long-running shadow session doesn't grow without limit. Diffs are
// inspected by tests and (eventually) by the dev panel.

const DEFAULT_CAPACITY = 256;

export type ShadowDiffKind =
	| "rider-exited"
	| "rider-abandoned"
	| "rider-rejected"
	| "route-invalidated"
	| "elevator-arrived";

export interface ShadowDiffEntry {
	tick: number;
	kind: ShadowDiffKind;
	/** Free-form payload for the kind. */
	detail: Record<string, unknown>;
}

export class ShadowDiffBuffer {
	private readonly capacity: number;
	private readonly entries: ShadowDiffEntry[] = [];
	private writeIndex = 0;

	constructor(capacity: number = DEFAULT_CAPACITY) {
		this.capacity = capacity;
	}

	push(entry: ShadowDiffEntry): void {
		if (this.entries.length < this.capacity) {
			this.entries.push(entry);
			this.writeIndex = this.entries.length % this.capacity;
		} else {
			this.entries[this.writeIndex] = entry;
			this.writeIndex = (this.writeIndex + 1) % this.capacity;
		}
	}

	/** Snapshot of the buffer in chronological order. */
	snapshot(): ShadowDiffEntry[] {
		if (this.entries.length < this.capacity) {
			return [...this.entries];
		}
		// When the ring has wrapped, writeIndex is the oldest slot.
		return [
			...this.entries.slice(this.writeIndex),
			...this.entries.slice(0, this.writeIndex),
		];
	}

	clear(): void {
		this.entries.length = 0;
		this.writeIndex = 0;
	}

	get size(): number {
		return this.entries.length;
	}
}
