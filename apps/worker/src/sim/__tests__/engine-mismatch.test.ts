import { describe, expect, it } from "vitest";
import { STARTING_CASH } from "../resources";
import {
	assertEngineMatches,
	createInitialSnapshot,
	EngineMismatchError,
	normalizeSnapshot,
	type SimSnapshot,
} from "../snapshot";

describe("engine stamping + assertEngineMatches", () => {
	it("createInitialSnapshot defaults to classic when no engine specified", () => {
		const snap = createInitialSnapshot("tower-1", "Test", STARTING_CASH);
		expect(snap.world.elevatorEngine).toBe("classic");
		expect(snap.world.elevatorCoreVersion).toBeNull();
		expect(snap.world.elevatorCorePostcard).toBeNull();
	});

	it("createInitialSnapshot honors explicit engine choice", () => {
		const classic = createInitialSnapshot("a", "A", STARTING_CASH, {
			elevatorEngine: "classic",
		});
		expect(classic.world.elevatorEngine).toBe("classic");
		expect(classic.world.elevatorCoreVersion).toBeNull();

		const core = createInitialSnapshot("b", "B", STARTING_CASH, {
			elevatorEngine: "core",
		});
		expect(core.world.elevatorEngine).toBe("core");
		// PR 2 leaves the version null (no actual WasmSim plumbed yet);
		// PR 3 wires it through.
		expect(core.world.elevatorCoreVersion).toBeNull();
		expect(core.world.elevatorCorePostcard).toBeNull();
	});

	it("assertEngineMatches passes when stamps line up", () => {
		const snap = createInitialSnapshot("a", "A", STARTING_CASH, {
			elevatorEngine: "classic",
		});
		expect(() => assertEngineMatches(snap, "classic")).not.toThrow();
	});

	it("assertEngineMatches throws EngineMismatchError on mismatch", () => {
		const classic = createInitialSnapshot("a", "A", STARTING_CASH, {
			elevatorEngine: "classic",
		});
		expect(() => assertEngineMatches(classic, "core")).toThrow(
			EngineMismatchError,
		);

		const core = createInitialSnapshot("b", "B", STARTING_CASH, {
			elevatorEngine: "core",
		});
		expect(() => assertEngineMatches(core, "classic")).toThrow(
			EngineMismatchError,
		);
	});

	it("EngineMismatchError carries both engine names", () => {
		const snap = createInitialSnapshot("a", "A", STARTING_CASH, {
			elevatorEngine: "core",
		});
		try {
			assertEngineMatches(snap, "classic");
			expect.fail("should have thrown");
		} catch (err) {
			expect(err).toBeInstanceOf(EngineMismatchError);
			const mismatch = err as EngineMismatchError;
			expect(mismatch.snapshotEngine).toBe("core");
			expect(mismatch.runtimeEngine).toBe("classic");
		}
	});

	it("normalizeSnapshot duck-types legacy snapshots to classic", () => {
		// Build a snapshot the way createInitialSnapshot does, then strip
		// the new engine fields to simulate a snapshot persisted before
		// this PR landed.
		const snap = createInitialSnapshot("legacy", "Legacy", STARTING_CASH);
		const legacy = JSON.parse(JSON.stringify(snap)) as SimSnapshot;
		const legacyWorld = legacy.world as unknown as Record<string, unknown>;
		delete legacyWorld.elevatorEngine;
		delete legacyWorld.elevatorCoreVersion;
		delete legacyWorld.elevatorCorePostcard;

		const normalized = normalizeSnapshot(legacy);
		expect(normalized.world.elevatorEngine).toBe("classic");
		expect(normalized.world.elevatorCoreVersion).toBeNull();
		expect(normalized.world.elevatorCorePostcard).toBeNull();
	});
});
