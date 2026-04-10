import type { CarrierCarStateData, EntityStateData } from "../types";

export const ELEVATOR_QUEUE_STATES = new Set([0x04, 0x05]);

export interface TransportMetrics {
	totalPopulation: number;
	queuedEntities: number;
	boardedEntities: number;
	activeTrips: number;
	totalCars: number;
	movingCars: number;
	doorWaitCars: number;
	peakCarLoad: number;
	state22Entities: number;
	checkoutQueueEntities: number;
}

export function isQueuedEntity(entity: EntityStateData): boolean {
	return (
		!entity.boardedOnCarrier &&
		(entity.stateCode === 0x22 ||
			ELEVATOR_QUEUE_STATES.has(entity.stateCode) ||
			entity.routeMode === 2)
	);
}

export function isMovingCar(car: CarrierCarStateData): boolean {
	return car.speedCounter > 0 || car.currentFloor !== car.targetFloor;
}

export function buildOccupancyByCar(
	entities: EntityStateData[],
): Map<string, number> {
	const occupancyByCar = new Map<string, number>();
	for (const entity of entities) {
		if (
			!entity.boardedOnCarrier ||
			entity.carrierId === null ||
			entity.assignedCarIndex < 0
		) {
			continue;
		}

		const key = `${entity.carrierId}:${entity.assignedCarIndex}`;
		occupancyByCar.set(key, (occupancyByCar.get(key) ?? 0) + 1);
	}
	return occupancyByCar;
}

export function buildTransportMetrics(
	entities: EntityStateData[],
	carriers: CarrierCarStateData[],
): TransportMetrics {
	const queuedEntities = entities.filter(isQueuedEntity);
	const boardedEntities = entities.filter((entity) => entity.boardedOnCarrier);
	const occupancyByCar = buildOccupancyByCar(entities);

	return {
		totalPopulation: entities.length,
		queuedEntities: queuedEntities.length,
		boardedEntities: boardedEntities.length,
		activeTrips: entities.filter((entity) => entity.routeMode !== 0).length,
		totalCars: carriers.length,
		movingCars: carriers.filter(isMovingCar).length,
		doorWaitCars: carriers.filter((car) => car.doorWaitCounter > 0).length,
		peakCarLoad: Math.max(0, ...occupancyByCar.values()),
		state22Entities: entities.filter((entity) => entity.stateCode === 0x22)
			.length,
		checkoutQueueEntities: entities.filter((entity) =>
			ELEVATOR_QUEUE_STATES.has(entity.stateCode),
		).length,
	};
}
