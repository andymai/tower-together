// Carrier-side derived-state sync helpers.
//
// The binary maintains per-car counters (waiting_count[], destination_count[],
// pending_route_ids, slot_destination_floors) incrementally as requests move
// through the queue. The current TS model keeps `pendingRoutes` as the source
// of truth and resyncs the derived counters after each mutation through
// `syncAssignmentStatus`. These helpers live here (not in carriers.ts) so the
// queue/ modules can call them without an import cycle.

import type { CarrierCar, CarrierRecord } from "../world";
import { floorToSlot } from "./slot";

const ACTIVE_SLOT_CAPACITY = 42;

function activeSlotLimit(carrier: CarrierRecord): number {
	return Math.min(ACTIVE_SLOT_CAPACITY, carrier.assignmentCapacity);
}

function findRoute(carrier: CarrierRecord, routeId: string) {
	return carrier.pendingRoutes.find((route) => route.simId === routeId);
}

export function syncPendingRouteIds(car: CarrierCar): void {
	car.pendingRouteIds = car.activeRouteSlots
		.filter((slot) => slot.active)
		.map((slot) => slot.routeId);
}

export function syncRouteSlots(carrier: CarrierRecord, car: CarrierCar): void {
	car.activeRouteSlots = car.activeRouteSlots.filter((slot) => {
		if (!slot.active) return false;
		const route = findRoute(carrier, slot.routeId);
		if (!route) return false;
		slot.sourceFloor = route.sourceFloor;
		slot.destinationFloor = route.destinationFloor;
		slot.boarded = route.boarded;
		return true;
	});
	while (car.activeRouteSlots.length < ACTIVE_SLOT_CAPACITY) {
		car.activeRouteSlots.push({
			routeId: "",
			sourceFloor: 0xff,
			destinationFloor: 0xff,
			boarded: false,
			active: false,
		});
	}
	syncPendingRouteIds(car);
}

export function hasActiveSlot(car: CarrierCar, routeId: string): boolean {
	return car.activeRouteSlots.some(
		(slot) => slot.active && slot.routeId === routeId,
	);
}

export function addRouteSlot(
	carrier: CarrierRecord,
	car: CarrierCar,
	route: CarrierRecord["pendingRoutes"][number],
): boolean {
	if (hasActiveSlot(car, route.simId)) return true;
	const limit = activeSlotLimit(carrier);
	for (let index = 0; index < limit; index++) {
		const slot = car.activeRouteSlots[index];
		if (!slot || slot.active) continue;
		slot.routeId = route.simId;
		slot.sourceFloor = route.sourceFloor;
		slot.destinationFloor = route.destinationFloor;
		slot.boarded = route.boarded;
		slot.active = true;
		syncPendingRouteIds(car);
		return true;
	}
	return false;
}

function syncWaitingCount(
	carrier: CarrierRecord,
	car: CarrierCar,
	carIndex: number,
): void {
	car.waitingCount.fill(0);
	car.destinationCountByFloor.fill(0);
	car.nonemptyDestinationCount = 0;

	for (let slot = 0; slot < carrier.floorQueues.length; slot++) {
		const queue = carrier.floorQueues[slot];
		if (!queue) continue;
		car.waitingCount[slot] = queue.up.size + queue.down.size;
	}

	const limit = activeSlotLimit(carrier);
	for (let index = 0; index < limit; index++) {
		const slotRef = car.activeRouteSlots[index];
		if (!slotRef?.active || !slotRef.boarded) continue;
		const slot = floorToSlot(carrier, slotRef.destinationFloor);
		if (slot < 0 || slot >= car.destinationCountByFloor.length) continue;
		const prev = car.destinationCountByFloor[slot] ?? 0;
		car.destinationCountByFloor[slot] = prev + 1;
		if (prev === 0) car.nonemptyDestinationCount += 1;
	}

	for (const route of carrier.pendingRoutes) {
		if (!route.boarded || route.assignedCarIndex !== carIndex) continue;
		const slot = floorToSlot(carrier, route.destinationFloor);
		if (slot < 0 || slot >= car.destinationCountByFloor.length) continue;
		const prev = car.destinationCountByFloor[slot] ?? 0;
		if (prev === 0) car.nonemptyDestinationCount += 1;
		car.destinationCountByFloor[slot] = prev + 1;
	}
}

// Rebuilds per-car derived state (active route slots, waiting/destination
// counts) from pendingRoutes. Route-status tables and pendingAssignmentCount
// are persistent — the binary keeps them mutated only by
// assign_car_to_floor_request and clear_floor_requests_on_arrival.
export function syncAssignmentStatus(carrier: CarrierRecord): void {
	for (const [carIndex, car] of carrier.cars.entries()) {
		syncRouteSlots(carrier, car);
		syncWaitingCount(carrier, car, carIndex);
	}
}

export function normalizeInactiveSlots(car: CarrierCar): void {
	for (const slot of car.activeRouteSlots) {
		if (!slot.active) {
			slot.routeId = "";
			slot.sourceFloor = 0xff;
			slot.destinationFloor = 0xff;
			slot.boarded = false;
		}
	}
}

export const ACTIVE_SLOT_CAPACITY_CONST = ACTIVE_SLOT_CAPACITY;
export const activeSlotLimitFor = activeSlotLimit;
export const findRouteById = findRoute;
