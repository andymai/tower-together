// Mirrors tower-together's `world.carriers` shape into elevator-core's
// Group/Line/Stop/Elevator topology. Idempotent — safe to call after
// every `rebuildCarrierList`. Tracks state on the BridgeHandle so
// re-runs only diff what changed.
//
// Mapping:
//   - 3 Groups (standard/express/service) seeded at bridge creation.
//   - 1 Line per shaft column, scoped to its mode's Group.
//   - 1 Stop per served floor on the line, at position floor * METERS_PER_FLOOR.
//   - 1 Elevator per car on the line, starting at its currentFloor.

import type { CarrierRecord } from "../world";
import { type BridgeHandle, groupForMode } from "./bridge";

/**
 * Vertical separation between floors in elevator-core's continuous
 * coordinate. The choice is arbitrary as long as it's consistent;
 * 4.0m matches the playground RON scenarios so existing TS tests of
 * elevator-core configs remain a reference. The value never escapes
 * the bridge — tower-together's renderer doesn't see it.
 */
export const METERS_PER_FLOOR = 4.0;

function lineKey(column: number): string {
	return `col-${column}`;
}

function stopKey(column: number, floor: number): string {
	return `${column}:${floor}`;
}

function elevatorKey(column: number, carIndex: number): string {
	return `${column}:${carIndex}`;
}

function unwrapU64(
	label: string,
	r: { kind: "ok"; value: number | bigint } | { kind: "err"; error: string },
): bigint {
	if (r.kind === "ok") return BigInt(r.value as number);
	throw new Error(`${label}: ${r.error}`);
}

function unwrapVoid(
	label: string,
	r: { kind: "ok" } | { kind: "err"; error: string },
): void {
	if (r.kind === "err") {
		throw new Error(`${label}: ${r.error}`);
	}
}

/**
 * Reconcile the elevator-core topology with the current
 * `world.carriers` array. Adds new lines/stops/elevators, removes
 * stale ones, leaves untouched anything still in place.
 */
export function syncTopology(
	handle: BridgeHandle,
	carriers: ReadonlyArray<CarrierRecord>,
): void {
	const desiredLines = new Set<number>();
	const desiredStops = new Set<string>();
	const desiredElevators = new Set<string>();

	for (const carrier of carriers) {
		desiredLines.add(carrier.column);

		const groupId = groupForMode(handle, carrier.carrierMode);

		// Ensure the line exists.
		let lineRef = handle.lineByColumn.get(carrier.column);
		if (lineRef === undefined) {
			lineRef = unwrapU64(
				`addLine col=${carrier.column}`,
				handle.sim.addLine(
					groupId,
					lineKey(carrier.column),
					carrier.bottomServedFloor * METERS_PER_FLOOR,
					carrier.topServedFloor * METERS_PER_FLOOR,
					null,
				),
			);
			handle.lineByColumn.set(carrier.column, lineRef);
		} else {
			// Update the line's range if the carrier shrank/extended.
			unwrapVoid(
				`setLineRange col=${carrier.column}`,
				handle.sim.setLineRange(
					lineRef,
					carrier.bottomServedFloor * METERS_PER_FLOOR,
					carrier.topServedFloor * METERS_PER_FLOOR,
				),
			);
		}

		// Ensure each served floor has a stop.
		for (
			let floor = carrier.bottomServedFloor;
			floor <= carrier.topServedFloor;
			floor++
		) {
			const key = stopKey(carrier.column, floor);
			desiredStops.add(key);
			if (handle.stopByFloor.has(key)) continue;
			const stopRef = unwrapU64(
				`addStop col=${carrier.column} floor=${floor}`,
				handle.sim.addStop(lineRef, `f${floor}`, floor * METERS_PER_FLOOR),
			);
			handle.stopByFloor.set(key, stopRef);
		}

		// Ensure each car has an elevator.
		carrier.cars.forEach((car, carIndex) => {
			const key = elevatorKey(carrier.column, carIndex);
			desiredElevators.add(key);
			if (handle.elevatorByCar.has(key)) return;
			const elevatorRef = unwrapU64(
				`addElevator col=${carrier.column} car=${carIndex}`,
				handle.sim.addElevator(
					lineRef as bigint,
					car.currentFloor * METERS_PER_FLOOR,
					null,
					null,
				),
			);
			handle.elevatorByCar.set(key, elevatorRef);
		});
	}

	// Remove anything no longer desired. Order matters: elevators
	// before stops before lines, since elevator-core's removal cascade
	// would otherwise leave dangling refs.
	for (const [key, elevatorRef] of handle.elevatorByCar) {
		if (desiredElevators.has(key)) continue;
		unwrapVoid(`removeElevator ${key}`, handle.sim.removeElevator(elevatorRef));
		handle.elevatorByCar.delete(key);
	}
	for (const [key, stopRef] of handle.stopByFloor) {
		if (desiredStops.has(key)) continue;
		unwrapVoid(`removeStop ${key}`, handle.sim.removeStop(stopRef));
		handle.stopByFloor.delete(key);
	}
	for (const [column, lineRef] of handle.lineByColumn) {
		if (desiredLines.has(column)) continue;
		unwrapVoid(`removeLine col=${column}`, handle.sim.removeLine(lineRef));
		handle.lineByColumn.delete(column);
	}
}
