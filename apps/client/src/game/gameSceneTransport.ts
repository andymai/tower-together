import type { SimRecord } from "../../../worker/src/sim/index";
import type { CarrierCarStateData } from "../types";
import { GRID_HEIGHT, TILE_WIDTHS } from "../types";
import {
	FAMILY_POPULATION,
	FAMILY_WIDTHS,
	STATIC_TILE_GAP_X,
	TILE_HEIGHT,
	TILE_WIDTH,
} from "./gameSceneConstants";

export interface TimedSnapshot<T> {
	simTime: number;
	items: T[];
}

export interface PresentationClock {
	simTime: number;
	receivedAtMs: number;
	tickIntervalMs: number;
}

export interface QueuedSimLayout {
	gridX: number;
	gridY: number;
}

export function getPresentationTime(
	presentationClock: PresentationClock,
	now = performance.now(),
): number {
	const elapsedMs = Math.max(0, now - presentationClock.receivedAtMs);
	const tickIntervalMs = Math.max(1, presentationClock.tickIntervalMs);
	return presentationClock.simTime + Math.min(1, elapsedMs / tickIntervalMs);
}

export function getSnapshotProgress(
	presentationClock: PresentationClock,
	now = performance.now(),
): number {
	const elapsedMs = Math.max(0, now - presentationClock.receivedAtMs);
	const tickIntervalMs = Math.max(1, presentationClock.tickIntervalMs);
	return Math.min(1, elapsedMs / tickIntervalMs);
}

// Packed key for (carrierId, carIndex). Car indexes are small (<1024); carrier
// ids stay well within safe-integer range after multiplication.
export function packCarKey(carrierId: number, carIndex: number): number {
	return carrierId * 1024 + carIndex;
}

export function shouldInterpolateCars(
	current: TimedSnapshot<CarrierCarStateData> | null,
	previous: TimedSnapshot<CarrierCarStateData> | null,
	presentationClock: PresentationClock,
): boolean {
	return Boolean(
		current &&
			previous &&
			previous.simTime < current.simTime &&
			presentationClock.simTime === current.simTime,
	);
}

export function fillPrevCarIndex(
	previous: TimedSnapshot<CarrierCarStateData> | null,
	out: Map<number, CarrierCarStateData>,
): void {
	out.clear();
	if (!previous) return;
	for (const car of previous.items) {
		out.set(packCarKey(car.carrierId, car.carIndex), car);
	}
}

export function interpolatedFloor(
	car: CarrierCarStateData,
	from: CarrierCarStateData | undefined,
	progress: number,
): number {
	if (!from) return car.currentFloor;
	const fromDirSign = from.prevFloor > from.currentFloor ? 1 : -1;
	const toDirSign = car.prevFloor > car.currentFloor ? 1 : -1;
	const fromEffective =
		from.currentFloor + (fromDirSign * from.settleCounter) / 6;
	const toEffective = car.currentFloor + (toDirSign * car.settleCounter) / 6;
	return fromEffective + (toEffective - fromEffective) * progress;
}

export function collectElevatorColumnsByFloor(
	overlayGrid: Map<string, string>,
): Map<number, number[]> {
	const result = new Map<number, number[]>();
	for (const [key, type] of overlayGrid) {
		if (type !== "elevator") continue;
		const [x, y] = key.split(",").map(Number);
		const floor = GRID_HEIGHT - 1 - y;
		const columns = result.get(floor);
		if (columns) {
			if (!columns.includes(x)) columns.push(x);
		} else {
			result.set(floor, [x]);
		}
	}

	for (const columns of result.values()) {
		columns.sort((a, b) => a - b);
	}
	return result;
}

/** Sim sprite footprint expressed in grid cells (must match GameScene render). */
export const SIM_QUEUE_SPACING_CELLS = 0.8;
const SIM_QUEUE_START_GAP = 0.2;
/** Upper bound on sims queued at a single elevator/floor/direction. */
export const SIM_QUEUE_MAX_SIZE = 40;
const ELEVATOR_STROKE_CELLS = 1;
const QUEUE_START_OFFSET = 0.1 + ELEVATOR_STROKE_CELLS / 2;

export function isSimAscending(sim: SimRecord): boolean {
	if (sim.destinationFloor >= 0) {
		return sim.destinationFloor > sim.selectedFloor;
	}
	// Fallback when not in transit: a sim below home is waiting to go up, above
	// is going down. Ties (at-home) default to ascending.
	return sim.floorAnchor >= sim.selectedFloor;
}

export function getQueuedSimLayout(
	sim: SimRecord,
	elevatorColumnsByFloor: Map<number, number[]>,
	queueIndex: number,
): QueuedSimLayout {
	const spanWidth = FAMILY_WIDTHS[sim.familyCode] ?? 1;
	const population = FAMILY_POPULATION[sim.familyCode] ?? 1;
	const slotFraction = (sim.baseOffset + 0.5) / population;
	const fallbackX = sim.homeColumn + slotFraction * spanWidth;
	const elevatorColumn = pickElevatorColumn(sim, elevatorColumnsByFloor);
	const hasSelectedFloorColumns = elevatorColumnsByFloor.has(sim.selectedFloor);
	const shaftWidth = TILE_WIDTHS.elevator ?? 4;
	const shaftRightEdge =
		elevatorColumn + shaftWidth - STATIC_TILE_GAP_X / TILE_WIDTH;
	const ascending = isSimAscending(sim);
	const gridX =
		elevatorColumn === sim.homeColumn && !hasSelectedFloorColumns
			? fallbackX
			: !ascending
				? shaftRightEdge +
					QUEUE_START_OFFSET +
					SIM_QUEUE_START_GAP +
					queueIndex * SIM_QUEUE_SPACING_CELLS
				: elevatorColumn -
					QUEUE_START_OFFSET -
					SIM_QUEUE_START_GAP -
					queueIndex * SIM_QUEUE_SPACING_CELLS;

	return {
		gridX,
		gridY: GRID_HEIGHT - 1 - sim.selectedFloor + 0.5,
	};
}

export function getQueuedSimQueueKey(
	sim: SimRecord,
	elevatorColumnsByFloor: Map<number, number[]>,
): string {
	const dir = isSimAscending(sim) ? "u" : "d";
	return `${sim.selectedFloor}:${pickElevatorColumn(
		sim,
		elevatorColumnsByFloor,
	)}:${dir}`;
}

export interface CarBounds {
	x: number;
	y: number;
	width: number;
	height: number;
}

export function fillCarBounds(
	car: CarrierCarStateData,
	floor: number,
	out: CarBounds,
): void {
	const isExpress = car.carrierMode === 0;
	const shaftTypeKey = isExpress ? "elevatorExpress" : "elevator";
	const shaftWidthCells = TILE_WIDTHS[shaftTypeKey] ?? 4;
	const shaftPixelWidth = shaftWidthCells * TILE_WIDTH - STATIC_TILE_GAP_X;
	const width = isExpress
		? shaftPixelWidth - 6
		: Math.max(6, shaftPixelWidth - 6);
	const height = Math.max(10, Math.floor(TILE_HEIGHT * 0.75));
	out.x = car.column * TILE_WIDTH + (shaftPixelWidth - width) / 2;
	out.y = (GRID_HEIGHT - 1 - floor + 0.5) * TILE_HEIGHT - height / 2;
	out.width = width;
	out.height = height;
}

function pickElevatorColumn(
	sim: SimRecord,
	elevatorColumnsByFloor: Map<number, number[]>,
): number {
	const columns = elevatorColumnsByFloor.get(sim.floorAnchor);
	const selectedColumns = elevatorColumnsByFloor.get(sim.selectedFloor);
	const availableColumns = selectedColumns ?? columns;
	if (!availableColumns || availableColumns.length === 0) {
		return sim.homeColumn;
	}

	let best = availableColumns[0] ?? sim.homeColumn;
	let bestDistance = Math.abs(best - sim.homeColumn);
	for (const column of availableColumns) {
		const distance = Math.abs(column - sim.homeColumn);
		if (distance < bestDistance) {
			best = column;
			bestDistance = distance;
		}
	}
	return best;
}
