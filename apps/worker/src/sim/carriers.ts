import { RingBuffer } from "./ring-buffer";
import { resolveTransferFloor } from "./routing";
import type { TimeState } from "./time";
import {
	type CarrierCar,
	type CarrierFloorQueue,
	type CarrierRecord,
	GRID_HEIGHT,
	type WorldState,
	yToFloor,
} from "./world";

/**
 * Optional callback invoked synchronously from inside the carrier tick when an
 * sim is unloaded at its destination. Mirrors the binary's
 * `dispatch_destination_queue_entries` path, which calls the family state
 * handler directly during the carrier tick instead of via a separate later
 * sweep over `completedRouteIds`.
 */
export type CarrierArrivalCallback = (
	routeId: string,
	arrivalFloor: number,
) => void;

export type CarrierBoardingCallback = (
	routeId: string,
	sourceFloor: number,
) => void;

const DEPARTURE_SEQUENCE_TICKS = 5;
const QUEUE_CAPACITY = 40;
const ACTIVE_SLOT_CAPACITY = 42;

function getScheduleIndex(time: TimeState): number {
	return time.weekendFlag * 7 + time.daypartIndex;
}

function createFloorQueue(): CarrierFloorQueue {
	return {
		up: new RingBuffer<string>(QUEUE_CAPACITY, ""),
		down: new RingBuffer<string>(QUEUE_CAPACITY, ""),
	};
}

function getCarCapacity(carrier: CarrierRecord): number {
	return carrier.assignmentCapacity;
}

function findRoute(carrier: CarrierRecord, routeId: string) {
	return carrier.pendingRoutes.find((route) => route.simId === routeId);
}

function getQueueState(carrier: CarrierRecord, floor: number) {
	const slot = floorToSlot(carrier, floor);
	if (slot < 0 || slot >= carrier.floorQueues.length) return null;
	return carrier.floorQueues[slot] ?? null;
}

function getDirectionQueue(
	queue: CarrierFloorQueue,
	directionFlag: number,
): RingBuffer<string> {
	return directionFlag === 1 ? queue.up : queue.down;
}

function activeSlotLimit(carrier: CarrierRecord): number {
	return Math.min(ACTIVE_SLOT_CAPACITY, carrier.assignmentCapacity);
}

function syncPendingRouteIds(car: CarrierCar): void {
	car.pendingRouteIds = car.activeRouteSlots
		.filter((slot) => slot.active)
		.map((slot) => slot.routeId);
}

function syncRouteSlots(carrier: CarrierRecord, car: CarrierCar): void {
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

function hasActiveSlot(car: CarrierCar, routeId: string): boolean {
	return car.activeRouteSlots.some(
		(slot) => slot.active && slot.routeId === routeId,
	);
}

function addRouteSlot(
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

function resetCarToHome(carrier: CarrierRecord, car: CarrierCar): void {
	const homeFloor = Math.min(
		carrier.topServedFloor,
		Math.max(carrier.bottomServedFloor, car.homeFloor),
	);
	car.currentFloor = homeFloor;
	car.targetFloor = homeFloor;
	car.prevFloor = homeFloor;
	car.speedCounter = 0;
	car.doorWaitCounter = 0;
	car.dwellCounter = 0;
	car.assignedCount = 0;
	car.pendingAssignmentCount = 0;
	car.directionFlag = 1;
	car.arrivalSeen = 0;
	car.arrivalTick = 0;
	car.destinationCountByFloor.fill(0);
	car.nonemptyDestinationCount = 0;
	for (const slot of car.activeRouteSlots) {
		slot.routeId = "";
		slot.sourceFloor = 0xff;
		slot.destinationFloor = 0xff;
		slot.boarded = false;
		slot.active = false;
	}
	car.pendingRouteIds = [];
}

function computeCarMotionMode(
	carrier: CarrierRecord,
	car: CarrierCar,
): 0 | 1 | 2 | 3 {
	const distToTarget = Math.abs(car.currentFloor - car.targetFloor);
	const distFromPrev = Math.abs(car.currentFloor - car.prevFloor);

	// Binary 1098:209f. No firstLeg override — when distFromPrev < 2
	// (including 0 on departure), binary returns mode 0 (stop, stab=5).
	if (carrier.carrierMode === 0) {
		// Express: stop within 2, fast (±3) when both > 4, normal otherwise
		if (distToTarget < 2 || distFromPrev < 2) return 0;
		if (distToTarget > 4 && distFromPrev > 4) return 3;
		return 2;
	}

	// Standard (1) and Service (2): stop within 2, slow-stop within 4
	if (distToTarget < 2 || distFromPrev < 2) return 0;
	if (distToTarget < 4 || distFromPrev < 4) return 1;
	return 2;
}

function advanceCarPositionOneStep(
	carrier: CarrierRecord,
	car: CarrierCar,
	carIndex: number,
): void {
	// Binary 1098:10e4. If already at target on entry, recompute target+direction
	// first (prevFloor = cur latched before recompute). Then compute mode,
	// possibly arm stabilize, step by ±1 or ±3, and clear arrivalSeen.
	if (car.currentFloor === car.targetFloor) {
		car.prevFloor = car.currentFloor;
		recomputeCarTargetAndDirection(carrier, car, carIndex);
	}

	const motionMode = computeCarMotionMode(carrier, car);
	if (motionMode === 0) car.doorWaitCounter = DEPARTURE_SEQUENCE_TICKS;
	else if (motionMode === 1) car.doorWaitCounter = 2;

	// Binary convention: direction==0 → down (cur -= step); direction!=0 → up.
	const stepSize = motionMode === 3 ? 3 : 1;
	const stepDir = car.directionFlag === 0 ? -1 : 1;
	car.currentFloor += stepDir * stepSize;

	if (car.arrivalSeen !== 0) car.arrivalSeen = 0;
}

function recomputeCarTargetAndDirection(
	carrier: CarrierRecord,
	car: CarrierCar,
	carIndex: number,
): void {
	const next = selectNextTarget(car, carrier, carIndex, car.scheduleFlag);
	if (next < carrier.bottomServedFloor || next > carrier.topServedFloor) {
		resetCarToHome(carrier, car);
		return;
	}
	car.targetFloor = next;
	updateCarDirectionFlag(carrier, car);
}

function updateCarDirectionFlag(carrier: CarrierRecord, car: CarrierCar): void {
	const floor = car.currentFloor;
	const prevDir = car.directionFlag;

	if (floor !== car.targetFloor) {
		// Binary 1098:1d2f: floor != target branch sets direction from relation
		// and goto-s past the clear-on-flip check, so no clear fires here.
		car.directionFlag = floor < car.targetFloor ? 1 : 0;
		return;
	}
	if (car.arrivalSeen === 0) return;

	if (floor === carrier.topServedFloor && car.directionFlag === 1) {
		car.directionFlag = 0;
	} else if (floor === carrier.bottomServedFloor && car.directionFlag === 0) {
		car.directionFlag = 1;
	} else if (car.scheduleFlag === 0) {
		// Bidirectional flip gated on schedF == 0. Express modes skip.
		const slot = floorToSlot(carrier, floor);
		if (slot >= 0) {
			const upCalls = (carrier.primaryRouteStatusByFloor[slot] ?? 0) !== 0;
			const downCalls = (carrier.secondaryRouteStatusByFloor[slot] ?? 0) !== 0;
			if (car.directionFlag === 0 && !downCalls && upCalls) {
				car.directionFlag = 1;
			} else if (car.directionFlag === 1 && !upCalls && downCalls) {
				car.directionFlag = 0;
			}
		}
	}

	// Binary 1098:1d2f tail: if direction changed during this call,
	// clear_floor_requests_on_arrival fires at the current floor with the
	// NEW direction. This clears the opposite-direction slot (since clause 2
	// of clear fires when dir==0 for example).
	if (car.directionFlag !== prevDir) {
		clearFloorRequestsOnArrival(carrier, car, floor);
	}
}

export function floorToSlot(carrier: CarrierRecord, floor: number): number {
	if (floor < carrier.bottomServedFloor || floor > carrier.topServedFloor) {
		return -1;
	}
	if (carrier.carrierMode === 0) {
		// Underground floors (0–9) → slots 0–9 by relative offset.
		const rel = floor - carrier.bottomServedFloor;
		if (floor < 10 && rel >= 0 && rel < 10) return rel;
		// Lobbies: floor IDs 10, 25, 40, 55, 70, 85, 100 → slots 10+
		if (floor >= 10 && (floor - 10) % 15 === 0) return (floor - 10) / 15 + 10;
		return -1;
	}
	return floor - carrier.bottomServedFloor;
}

export function carrierServesFloor(
	carrier: CarrierRecord,
	floor: number,
): boolean {
	return floorToSlot(carrier, floor) >= 0;
}

export function makeCarrierCar(
	numSlots: number,
	homeFloor: number,
): CarrierCar {
	return {
		active: true,
		currentFloor: homeFloor,
		doorWaitCounter: 0,
		speedCounter: 0,
		dwellCounter: 0,
		assignedCount: 0,
		pendingAssignmentCount: 0,
		directionFlag: 1,
		targetFloor: homeFloor,
		prevFloor: homeFloor,
		homeFloor,
		scheduleFlag: 0,
		arrivalSeen: 0,
		arrivalTick: 0,
		waitingCount: new Array(numSlots).fill(0),
		destinationCountByFloor: new Array(numSlots).fill(0),
		nonemptyDestinationCount: 0,
		activeRouteSlots: Array.from({ length: ACTIVE_SLOT_CAPACITY }, () => ({
			routeId: "",
			sourceFloor: 0xff,
			destinationFloor: 0xff,
			boarded: false,
			active: false,
		})),
		pendingRouteIds: [],
	};
}

export function makeCarrier(
	id: number,
	col: number,
	mode: 0 | 1 | 2,
	bottom: number,
	top: number,
	numCars = 1,
): CarrierRecord {
	const numSlots = top - bottom + 1;
	const clampedCars = Math.max(1, Math.min(8, numCars));
	const span = Math.max(0, top - bottom);
	const cars = Array.from({ length: clampedCars }, (_, index) => {
		const homeFloor =
			clampedCars === 1
				? bottom
				: bottom + Math.floor((span * index) / (clampedCars - 1));
		return makeCarrierCar(numSlots, Math.min(top, homeFloor));
	});

	return {
		carrierId: id,
		column: col,
		carrierMode: mode,
		topServedFloor: top,
		bottomServedFloor: bottom,
		servedFloorFlags: new Array(14).fill(1),
		primaryRouteStatusByFloor: new Array(numSlots).fill(0),
		secondaryRouteStatusByFloor: new Array(numSlots).fill(0),
		serviceScheduleFlags: new Array(14).fill(1),
		dwellDelay: new Array(14).fill(0),
		expressDirectionFlags: new Array(14).fill(0),
		waitingCarResponseThreshold: 4,
		assignmentCapacity: mode === 0 ? 0x2a : 0x15,
		floorQueues: Array.from({ length: numSlots }, () => createFloorQueue()),
		pendingRoutes: [],
		completedRouteIds: [],
		suppressedFloorAssignments: [],
		cars,
	};
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
function syncAssignmentStatus(carrier: CarrierRecord): void {
	for (const [carIndex, car] of carrier.cars.entries()) {
		syncRouteSlots(carrier, car);
		syncWaitingCount(carrier, car, carIndex);
	}
}

// Mirrors binary clear_floor_requests_on_arrival (1098:13cc). Called when a
// car arrives at a floor. Each clause gates on (schedF != 0 || dir matches)
// && table[floor] != 0, then zeros the slot and decrements the owning car's
// pendingAssignmentCount. Same-car decrement is inline; cross-car goes
// through decrement_car_pending_assignment_count (1098:151c).
function clearFloorRequestsOnArrival(
	carrier: CarrierRecord,
	car: CarrierCar,
	floor: number,
): void {
	const slot = floorToSlot(carrier, floor);
	if (slot < 0) return;

	if (car.scheduleFlag !== 0 || car.directionFlag !== 0) {
		const pri = carrier.primaryRouteStatusByFloor[slot] ?? 0;
		if (pri !== 0) {
			carrier.primaryRouteStatusByFloor[slot] = 0;
			const owner = carrier.cars[pri - 1];
			if (owner && owner.pendingAssignmentCount > 0) {
				owner.pendingAssignmentCount -= 1;
			}
		}
	}

	if (car.scheduleFlag !== 0 || car.directionFlag === 0) {
		const sec = carrier.secondaryRouteStatusByFloor[slot] ?? 0;
		if (sec !== 0) {
			carrier.secondaryRouteStatusByFloor[slot] = 0;
			const owner = carrier.cars[sec - 1];
			if (owner && owner.pendingAssignmentCount > 0) {
				owner.pendingAssignmentCount -= 1;
			}
		}
	}
}

// Mirrors binary find_best_available_car_for_floor (1098:0dfc).
// Binary returns (int return_value, int *param_4). The caller
// assign_car_to_floor_request gates all its writes on `return_value != 0`.
// Cases that return 0 (fullAssign=false): A/B (same-floor, doors closed,
// scheduleFlag||dirMatch), C (idle-home candidate already at floor), D (dead).
// Normal path and degenerate: return 1 with param_4 set (fullAssign=true).
function findBestAvailableCarForFloor(
	carrier: CarrierRecord,
	floor: number,
	directionFlag: number,
): { carIndex: number; fullAssign: boolean } {
	let bestIdleHomeCost = Number.POSITIVE_INFINITY;
	let bestIdleHomeIndex = -1;
	let bestForwardCost = Number.POSITIVE_INFINITY;
	let bestForwardIndex = -1;
	let bestWrapCost = Number.POSITIVE_INFINITY;
	let bestWrapIndex = -1;

	for (const [carIndex, car] of carrier.cars.entries()) {
		if (!car.active) continue;
		if (car.assignedCount >= getCarCapacity(carrier)) continue;

		// Cases A/B: car at floor with doors closed, and either scheduleFlag is
		// set or direction already matches. Binary returns 0 immediately.
		if (car.currentFloor === floor && car.doorWaitCounter === 0) {
			if (car.scheduleFlag !== 0 || car.directionFlag === directionFlag) {
				return { carIndex, fullAssign: false };
			}
			// else fall through to idle-home / forward / wrap accumulation
		}

		const distance = Math.abs(car.currentFloor - floor);

		const isIdleHome =
			car.pendingAssignmentCount === 0 &&
			car.nonemptyDestinationCount === 0 &&
			car.doorWaitCounter === 0 &&
			car.currentFloor === car.homeFloor;

		if (isIdleHome) {
			// Case C: idle-home candidate already at floor
			if (distance === 0) return { carIndex, fullAssign: false };
			if (distance < bestIdleHomeCost) {
				bestIdleHomeCost = distance;
				bestIdleHomeIndex = carIndex;
			}
			continue;
		}

		if (car.directionFlag === directionFlag) {
			const forward =
				directionFlag === 1
					? floor - car.currentFloor
					: car.currentFloor - floor;
			if (forward >= 0) {
				if (forward < bestForwardCost) {
					bestForwardCost = forward;
					bestForwardIndex = carIndex;
				}
				continue;
			}
			// Past sweep end: wrap
			const cost =
				directionFlag === 1
					? car.targetFloor - car.currentFloor + (car.targetFloor - floor)
					: car.currentFloor - car.targetFloor + (floor - car.targetFloor);
			if (cost < bestWrapCost) {
				bestWrapCost = cost;
				bestWrapIndex = carIndex;
			}
			continue;
		}

		// Opposite direction: wrap via turn floor. Binary 1098:0fe0 branches on
		// (request floor vs turnFloor), not (request floor vs currentFloor): if
		// the request lies on the car's return leg past its reversal point, cost
		// is the wrap distance; otherwise the car passes the request going the
		// wrong way and the cost is the direct separation.
		const turnFloor = car.targetFloor;
		let cost: number;
		if (directionFlag === 1) {
			if (turnFloor < floor) {
				cost = car.currentFloor + floor - 2 * turnFloor;
			} else {
				cost = car.currentFloor - floor;
			}
		} else {
			if (floor < turnFloor) {
				cost = 2 * turnFloor - car.currentFloor - floor;
			} else {
				cost = floor - car.currentFloor;
			}
		}
		if (cost < bestWrapCost) {
			bestWrapCost = cost;
			bestWrapIndex = carIndex;
		}
	}

	let bestMovingCost: number;
	let bestMovingIndex: number;
	if (bestForwardIndex >= 0) {
		bestMovingCost = bestForwardCost;
		bestMovingIndex = bestForwardIndex;
	} else {
		bestMovingCost = bestWrapCost;
		bestMovingIndex = bestWrapIndex;
	}

	if (bestIdleHomeIndex >= 0 && bestMovingIndex >= 0) {
		if (
			bestMovingCost - bestIdleHomeCost <
			carrier.waitingCarResponseThreshold
		) {
			return { carIndex: bestMovingIndex, fullAssign: true };
		}
		return { carIndex: bestIdleHomeIndex, fullAssign: true };
	}
	if (bestIdleHomeIndex >= 0)
		return { carIndex: bestIdleHomeIndex, fullAssign: true };
	if (bestMovingIndex >= 0)
		return { carIndex: bestMovingIndex, fullAssign: true };

	// Degenerate: binary writes param_4=0 and returns 1
	return { carIndex: 0, fullAssign: true };
}

function clearSimRouteById(world: WorldState, simId: string): void {
	for (const sim of world.sims) {
		const key = `${sim.floorAnchor}:${sim.homeColumn}:${sim.familyCode}:${sim.baseOffset}`;
		if (key !== simId) continue;
		sim.route = { mode: "idle" };
		sim.routeRetryDelay = 0;
		return;
	}
}

// Mirrors binary assign_car_to_floor_request (1098:0a4c). Top gate: for
// direction=1 (UP) requires primary[floor]==0; for direction=0 (DOWN)
// requires secondary[floor]==0. On fullAssign, writes table slot, increments
// pac, and recomputes target+direction — all unconditionally.
function assignCarToFloorRequest(
	carrier: CarrierRecord,
	floor: number,
	directionFlag: number,
): void {
	const slot = floorToSlot(carrier, floor);
	if (slot < 0) return;
	const table =
		directionFlag === 1
			? carrier.primaryRouteStatusByFloor
			: carrier.secondaryRouteStatusByFloor;
	if ((table[slot] ?? 0) !== 0) return;

	const result = findBestAvailableCarForFloor(carrier, floor, directionFlag);
	if (result.carIndex < 0) return;
	if (!result.fullAssign) return;

	const carIndex = result.carIndex;
	for (const route of carrier.pendingRoutes) {
		if (route.boarded) continue;
		if (route.sourceFloor !== floor || route.directionFlag !== directionFlag)
			continue;
		if (route.assignedCarIndex >= 0) continue;
		route.assignedCarIndex = carIndex;
	}
	const car = carrier.cars[carIndex];
	table[slot] = carIndex + 1;
	car.pendingAssignmentCount += 1;
	recomputeCarTargetAndDirection(carrier, car, carIndex);
}

function processUnitTravelQueue(
	world: WorldState,
	carrier: CarrierRecord,
	car: CarrierCar,
	carIndex: number,
	time: TimeState,
): void {
	// When schedule is disabled, car does not pick up passengers
	const scheduleIndex = getScheduleIndex(time);
	if ((carrier.serviceScheduleFlags[scheduleIndex] ?? 1) === 0) return;

	let remainingSlots = Math.max(0, getCarCapacity(carrier) - car.assignedCount);
	if (remainingSlots === 0) return;

	const floorQueueState = getQueueState(carrier, car.currentFloor);
	if (!floorQueueState) return;
	const floorQueue: CarrierFloorQueue = floorQueueState;

	// Binary 1218:0351 flip-during-dwell: when the car's current-direction
	// queue is empty, no routes are in-flight (pac==0), and no onboard riders
	// (ndc==0), check the opposite direction. If that queue has entries, flip
	// the car's direction flag and drain from the flipped direction.
	const qCurBuf = getDirectionQueue(floorQueue, car.directionFlag);
	if (
		qCurBuf.size === 0 &&
		car.pendingAssignmentCount === 0 &&
		car.nonemptyDestinationCount === 0
	) {
		const oppositeDirection = car.directionFlag === 1 ? 0 : 1;
		const qOppBuf = getDirectionQueue(floorQueue, oppositeDirection);
		if (qOppBuf.size !== 0) {
			car.directionFlag = oppositeDirection;
		}
	}

	// Binary 1218:0351: pop cap per direction is 1 unless dwellCounter == 1
	// exactly (then cap = remainingSlots).
	const popCap = car.dwellCounter === 1 ? remainingSlots : 1;

	function drainDirection(directionFlag: number): void {
		const buf = getDirectionQueue(floorQueue, directionFlag);
		const traceOn =
			(globalThis as { __DRAIN_TRACE__?: boolean }).__DRAIN_TRACE__ === true;
		if (traceOn) {
			// biome-ignore lint/suspicious/noExplicitAny: scratch
			const peek = (buf as any).peekAll?.() ?? [];
			console.log(
				`[drain] dt=${time.dayTick} car.fl=${car.currentFloor} dw=${car.dwellCounter} dir=${directionFlag} qLen=${buf.size} popCap=${popCap} remSlots=${remainingSlots} queue=[${peek
					.map((id: string) => {
						const r = findRoute(carrier, id);
						return r
							? `${id}→${r.destinationFloor}(ci=${r.assignedCarIndex}${r.boarded ? "B" : ""})`
							: id;
					})
					.join(",")}]`,
			);
		}
		// Binary drains directly from the floor queue; we also accept routes
		// with ci=-1 (unassigned by cases A/B/C) and routes previously
		// assigned to this car index.
		const assignedRoutes = buf
			.peekAll()
			.map((routeId) => findRoute(carrier, routeId))
			.filter(
				(route): route is NonNullable<typeof route> =>
					route !== undefined &&
					!route.boarded &&
					(route.assignedCarIndex === carIndex ||
						route.assignedCarIndex === -1) &&
					!hasActiveSlot(car, route.simId),
			);
		for (const route of assignedRoutes.slice(
			0,
			Math.min(popCap, remainingSlots),
		)) {
			buf.pop();
			const resolvedFloor = resolveTransferFloor(
				world,
				carrier.carrierId,
				car.currentFloor,
				route.destinationFloor,
			);
			if (resolvedFloor < 0) {
				carrier.pendingRoutes = carrier.pendingRoutes.filter(
					(candidate) => candidate.simId !== route.simId,
				);
				clearSimRouteById(world, route.simId);
				continue;
			}
			route.destinationFloor = resolvedFloor;
			if (addRouteSlot(carrier, car, route)) remainingSlots -= 1;
		}
	}

	const primaryDirection = car.directionFlag;
	drainDirection(primaryDirection);

	// Binary: alternate-direction opportunistic drain when scheduleFlag != 0.
	if (car.scheduleFlag !== 0 && remainingSlots > 0) {
		const oppositeDirection = primaryDirection === 1 ? 0 : 1;
		drainDirection(oppositeDirection);
	}

	syncAssignmentStatus(carrier);
}

/**
 * Binary `select_next_target_floor` @ 1098:1553. Multi-phase directional
 * scan that distinguishes queued riders (destination queue) from assignment
 * slots (up/down call pickups) and gates assignment targets on capacity.
 */
function selectNextTarget(
	car: CarrierCar,
	carrier: CarrierRecord,
	carIndex: number,
	expressDirectionFlag: number,
): number {
	// Binary idle check: arrivalTick == 0 && pendingDestCount == 0.
	// Also gate on pendingAssignmentCount because dayTick can be 0 at the
	// start of a day, making arrivalTick indistinguishable from "never set".
	if (
		car.arrivalTick === 0 &&
		car.nonemptyDestinationCount === 0 &&
		car.pendingAssignmentCount === 0
	) {
		return car.homeFloor;
	}

	// When a normal-mode car has finished all work, the binary keeps it parked
	// at home so the A1/B dwell cycle can continue without resetting the
	// arrival latch on every 5→0 transition.
	if (
		expressDirectionFlag === 0 &&
		car.nonemptyDestinationCount === 0 &&
		car.pendingAssignmentCount === 0
	) {
		return car.homeFloor;
	}

	const underCapacity = car.assignedCount !== getCarCapacity(carrier);

	function hasQueuedRider(floor: number): boolean {
		const slot = floorToSlot(carrier, floor);
		return slot >= 0 && (car.destinationCountByFloor[slot] ?? 0) > 0;
	}
	function hasUpSlot(floor: number): boolean {
		const slot = floorToSlot(carrier, floor);
		return (
			slot >= 0 && carrier.primaryRouteStatusByFloor[slot] === carIndex + 1
		);
	}
	function hasDownSlot(floor: number): boolean {
		const slot = floorToSlot(carrier, floor);
		return (
			slot >= 0 && carrier.secondaryRouteStatusByFloor[slot] === carIndex + 1
		);
	}

	// schedMode 1: express-up. Scan downward for work, fallback = top.
	if (expressDirectionFlag === 1) {
		const gate =
			(car.directionFlag !== 0 &&
				(car.currentFloor !== carrier.topServedFloor ||
					car.doorWaitCounter !== 0)) ||
			(car.directionFlag === 0 &&
				car.currentFloor === carrier.bottomServedFloor &&
				car.doorWaitCounter === 0);
		if (gate) {
			for (let f = car.currentFloor; f >= carrier.bottomServedFloor; f--) {
				if (hasQueuedRider(f)) return f;
				if (underCapacity && (hasDownSlot(f) || hasUpSlot(f))) return f;
			}
		}
		return carrier.topServedFloor;
	}

	// schedMode 2: express-down. Scan upward for work, fallback = bottom.
	if (expressDirectionFlag === 2) {
		const gate =
			(car.directionFlag === 0 &&
				(car.currentFloor !== carrier.bottomServedFloor ||
					car.doorWaitCounter !== 0)) ||
			(car.directionFlag !== 0 &&
				car.currentFloor === carrier.topServedFloor &&
				car.doorWaitCounter === 0);
		if (gate) {
			for (let f = car.currentFloor; f <= carrier.topServedFloor; f++) {
				if (hasQueuedRider(f)) return f;
				if (underCapacity && (hasUpSlot(f) || hasDownSlot(f))) return f;
			}
		}
		return carrier.bottomServedFloor;
	}

	// schedMode 0: bidirectional sweep
	if (car.directionFlag === 0) {
		// Going down — phase 1: cur→bottom for queued OR downSlot
		for (let f = car.currentFloor; f >= carrier.bottomServedFloor; f--) {
			if (hasQueuedRider(f)) return f;
			if (underCapacity && hasDownSlot(f)) return f;
		}
		// Phase 2: bottom→cur for upSlot (capacity-gated)
		if (underCapacity) {
			for (let f = carrier.bottomServedFloor; f <= car.currentFloor; f++) {
				if (hasUpSlot(f)) return f;
			}
		}
		// Phase 3: cur+1→top for upSlot (capacity-gated) OR queued
		for (let f = car.currentFloor + 1; f <= carrier.topServedFloor; f++) {
			if (underCapacity && hasUpSlot(f)) return f;
			if (hasQueuedRider(f)) return f;
		}
		// Phase 4: top→cur+1 for downSlot (capacity-gated)
		if (underCapacity) {
			for (let f = carrier.topServedFloor; f > car.currentFloor; f--) {
				if (hasDownSlot(f)) return f;
			}
		}
	} else {
		// Going up — phase 1: cur→top for queued OR upSlot
		for (let f = car.currentFloor; f <= carrier.topServedFloor; f++) {
			if (hasQueuedRider(f)) return f;
			if (underCapacity && hasUpSlot(f)) return f;
		}
		// Phase 2: top→cur for downSlot (capacity-gated)
		if (underCapacity) {
			for (let f = carrier.topServedFloor; f >= car.currentFloor; f--) {
				if (hasDownSlot(f)) return f;
			}
		}
		// Phase 3: cur-1→bottom for downSlot (capacity-gated) OR queued
		for (let f = car.currentFloor - 1; f >= carrier.bottomServedFloor; f--) {
			if (underCapacity && hasDownSlot(f)) return f;
			if (hasQueuedRider(f)) return f;
		}
		// Phase 4: bottom→cur-1 for upSlot (capacity-gated)
		if (underCapacity) {
			for (let f = carrier.bottomServedFloor; f < car.currentFloor; f++) {
				if (hasUpSlot(f)) return f;
			}
		}
	}

	return -1;
}

function loadScheduleFlag(
	carrier: CarrierRecord,
	car: CarrierCar,
	time: TimeState,
): void {
	if (
		car.currentFloor !== carrier.bottomServedFloor &&
		car.currentFloor !== carrier.topServedFloor
	) {
		return;
	}
	car.scheduleFlag = carrier.expressDirectionFlags[getScheduleIndex(time)] ?? 0;
}

function shouldCarDepart(
	carrier: CarrierRecord,
	car: CarrierCar,
	time: TimeState,
): boolean {
	// Binary 1098:23a5. Force-depart when full, when schedule multiplier is 0,
	// or when stopped at a non-home, non-lobby/express floor. Otherwise wait
	// until arrival-to-now delta exceeds multiplier * 30 ticks.
	if (car.assignedCount >= getCarCapacity(carrier)) return true;
	const multiplier = carrier.dwellDelay[getScheduleIndex(time)] ?? 1;
	if (multiplier === 0) return true;
	if (car.currentFloor !== car.homeFloor) {
		const isLobbyOrExpress =
			car.currentFloor === 10 ||
			(car.currentFloor > 10 && (car.currentFloor - 10) % 15 === 0);
		if (!isLobbyOrExpress) return true;
	}
	return Math.abs(time.dayTick - car.arrivalTick) > multiplier * 30;
}

function boardAndUnloadRoutes(
	carrier: CarrierRecord,
	car: CarrierCar,
	carIndex: number,
	allowUnload: boolean,
	onArrival?: CarrierArrivalCallback,
	onBoarding?: CarrierBoardingCallback,
): boolean {
	let changed = false;
	const limit = activeSlotLimit(carrier);
	const arrivals: Array<{ routeId: string; floor: number }> = [];

	if (allowUnload) {
		for (let index = 0; index < limit; index++) {
			const slot = car.activeRouteSlots[index];
			if (!slot?.active || !slot.boarded) continue;
			if (slot.destinationFloor !== car.currentFloor) continue;
			const arrivedRouteId = slot.routeId;
			const arrivedFloor = slot.destinationFloor;
			car.assignedCount = Math.max(0, car.assignedCount - 1);
			const destinationSlot = floorToSlot(carrier, slot.destinationFloor);
			if (destinationSlot >= 0) {
				const prev = car.destinationCountByFloor[destinationSlot] ?? 0;
				car.destinationCountByFloor[destinationSlot] = Math.max(0, prev - 1);
				if (prev === 1) {
					car.nonemptyDestinationCount = Math.max(
						0,
						car.nonemptyDestinationCount - 1,
					);
				}
			}
			slot.active = false;
			carrier.pendingRoutes = carrier.pendingRoutes.filter(
				(candidate) => candidate.simId !== arrivedRouteId,
			);
			if (!carrier.completedRouteIds.includes(arrivedRouteId)) {
				carrier.completedRouteIds.push(arrivedRouteId);
			}
			arrivals.push({ routeId: arrivedRouteId, floor: arrivedFloor });
			changed = true;
		}

		if (onArrival) {
			for (const arrival of arrivals) {
				onArrival(arrival.routeId, arrival.floor);
			}
		}
	}
	for (let index = 0; index < limit; index++) {
		const slot = car.activeRouteSlots[index];
		if (car.assignedCount >= getCarCapacity(carrier)) break;
		if (!slot?.active || slot.boarded) continue;
		const route = findRoute(carrier, slot.routeId);
		if (!route || route.boarded) continue;
		if (route.assignedCarIndex !== carIndex && route.assignedCarIndex !== -1)
			continue;
		if (route.sourceFloor !== car.currentFloor) continue;
		route.assignedCarIndex = carIndex;
		route.boarded = true;
		slot.boarded = true;
		car.assignedCount += 1;
		if (onBoarding) onBoarding(route.simId, route.sourceFloor);
		const destinationSlot = floorToSlot(carrier, route.destinationFloor);
		if (destinationSlot >= 0) {
			const prev = car.destinationCountByFloor[destinationSlot] ?? 0;
			car.destinationCountByFloor[destinationSlot] = prev + 1;
			if (prev === 0) car.nonemptyDestinationCount += 1;
		}
		changed = true;
	}
	if (changed) {
		for (const slot of car.activeRouteSlots) {
			if (!slot.active) {
				slot.routeId = "";
				slot.sourceFloor = 0xff;
				slot.destinationFloor = 0xff;
				slot.boarded = false;
			}
		}
		syncPendingRouteIds(car);
		syncAssignmentStatus(carrier);
	}
	return changed;
}

/**
 * Pass 1 of the per-tick carrier update, mirroring the binary's
 * `advance_carrier_car_state` (1098:06fb). Runs before pass 2
 * (`dispatchAndBoardCar`), which handles unload/boarding.
 *
 * State counters correspond to the binary's car struct fields:
 *   doorWaitCounter ↔ -0x5d (stabilize after a motion step)
 *   dwellCounter    ↔ -0x5c (dwell/boarding at a stop; 5 = just arrived)
 */
function advanceCarrierCarState(
	car: CarrierCar,
	carrier: CarrierRecord,
	carIndex: number,
	time: TimeState,
): void {
	if (!car.active) return;

	if (
		car.currentFloor < carrier.bottomServedFloor ||
		car.currentFloor > carrier.topServedFloor
	) {
		resetCarToHome(carrier, car);
		return;
	}

	// Branch C (1098:06fb): stabilize countdown. While nonzero, the car is
	// mid-motion-cycle. Decrement only if recomputed mode is still 0;
	// otherwise snap to 0 (fast-cancel).
	if (car.doorWaitCounter > 0) {
		if (computeCarMotionMode(carrier, car) === 0) car.doorWaitCounter--;
		else car.doorWaitCounter = 0;
		return;
	}

	if (car.dwellCounter === 0) {
		// Branch A. A1 (arrival / idle-at-target) fires when target == cur and
		// either the per-car destination queue has riders for this floor, or the
		// car is not full. A1 is level-triggered: as long as the gate holds the
		// next A1 fire (after B's 5-tick countdown) refreshes dwell back to 5.
		const currentSlot = floorToSlot(carrier, car.currentFloor);
		const hasQueuedRider =
			currentSlot >= 0 && (car.destinationCountByFloor[currentSlot] ?? 0) > 0;
		const underCapacity = car.assignedCount !== getCarCapacity(carrier);

		if (
			car.targetFloor === car.currentFloor &&
			(hasQueuedRider || underCapacity)
		) {
			// A1
			if (
				car.currentFloor === carrier.topServedFloor ||
				car.currentFloor === carrier.bottomServedFloor
			) {
				loadScheduleFlag(carrier, car, time);
			}
			clearFloorRequestsOnArrival(carrier, car, car.currentFloor);
			car.dwellCounter = DEPARTURE_SEQUENCE_TICKS;
			if (car.arrivalSeen === 0) {
				car.arrivalTick = time.dayTick;
			}
			car.arrivalSeen = 1;
			return;
		}

		// A2 — motion step. Binary 1098:06fb A2 calls cancel_stale_floor_assignment
		// (1098:0d15), which is visual-grid housekeeping only — it does NOT touch
		// route-status tables or pac. Those are persistent state.
		const departFloor = car.currentFloor;
		const departSlot = floorToSlot(carrier, departFloor);
		const queue = departSlot >= 0 ? carrier.floorQueues[departSlot] : null;
		const hasUpRequest =
			queue != null &&
			!queue.up.isEmpty &&
			(carrier.primaryRouteStatusByFloor[departSlot] ?? 0) === 0;
		const hasDownRequest =
			queue != null &&
			!queue.down.isEmpty &&
			(carrier.secondaryRouteStatusByFloor[departSlot] ?? 0) === 0;
		advanceCarPositionOneStep(carrier, car, carIndex);
		if (hasUpRequest) assignCarToFloorRequest(carrier, departFloor, 1);
		if (hasDownRequest) assignCarToFloorRequest(carrier, departFloor, 0);
		return;
	}

	// Branch B — dwell countdown. Decrement unconditionally; on 0 transition,
	// latch prevFloor, recompute target+direction, and check departure gate.
	// If depart gate says "wait", pin dwell=1 so this path runs again next tick.
	car.dwellCounter--;
	if (car.dwellCounter === 0) {
		car.prevFloor = car.currentFloor;
		recomputeCarTargetAndDirection(carrier, car, carIndex);
		if (!shouldCarDepart(carrier, car, time)) {
			car.dwellCounter = 1;
		}
	}
}

/**
 * Pass 2 of the per-tick carrier update, mirroring the binary's
 * `dispatch_carrier_car_arrivals` + `process_unit_travel_queue`
 * (1218:07a6 / 1218:0883). Runs after all cars have completed pass 1.
 *
 * The binary gates unload on -0x5c == 5 (first dwell tick). We fold boarding
 * (which the binary runs unconditionally in its own helper) into the same
 * call so it happens on the same tick as arrival.
 */
function dispatchAndBoardCar(
	world: WorldState,
	car: CarrierCar,
	carrier: CarrierRecord,
	carIndex: number,
	time: TimeState,
	onArrival?: CarrierArrivalCallback,
	onBoarding?: CarrierBoardingCallback,
): void {
	if (!car.active) return;
	// Binary `process_unit_travel_queue` (1218:0351) gates the queue pop on
	// `(car[-0x5c] & 1) != 0` — only runs when dwellCounter is odd. This
	// creates the 1-tick lag between route enqueue (at dwell=4) and boarding
	// (at dwell=3). Unload (`dispatch_carrier_car_arrivals`) is gated on
	// dwell == 5 (first dwell tick).
	if ((car.dwellCounter & 1) !== 0) {
		processUnitTravelQueue(world, carrier, car, carIndex, time);
	}
	boardAndUnloadRoutes(
		carrier,
		car,
		carIndex,
		car.dwellCounter === DEPARTURE_SEQUENCE_TICKS,
		onArrival,
		onBoarding,
	);
}

export function tickAllCarriers(
	world: WorldState,
	time: TimeState,
	onArrival?: CarrierArrivalCallback,
	onBoarding?: CarrierBoardingCallback,
): void {
	for (const carrier of world.carriers) {
		carrier.completedRouteIds = [];
		syncAssignmentStatus(carrier);
		// Pass 1: state advance for every car (binary `advance_carrier_car_state`).
		for (const [carIndex, car] of carrier.cars.entries()) {
			advanceCarrierCarState(car, carrier, carIndex, time);
		}
		// Pass 2: unload + boarding for every car (binary
		// `dispatch_carrier_car_arrivals` + `process_unit_travel_queue`).
		for (const [carIndex, car] of carrier.cars.entries()) {
			dispatchAndBoardCar(
				world,
				car,
				carrier,
				carIndex,
				time,
				onArrival,
				onBoarding,
			);
		}
	}
}

/**
 * End-of-day carrier flush (checkpoint 0x9f6).
 * Drains all floor queues and clears pending route tracking. The binary
 * leaves per-car state (dwell counter, current/target floor, cycle phase)
 * untouched at the day boundary — resetting mid-cycle would shift the
 * reselect cadence and desynchronize dispatch from the binary.
 */
export function flushCarriersEndOfDay(world: WorldState): void {
	for (const carrier of world.carriers) {
		for (const queue of carrier.floorQueues.values()) {
			queue.up.head = 0;
			queue.up.count = 0;
			queue.down.head = 0;
			queue.down.count = 0;
		}
		carrier.pendingRoutes = [];
		carrier.completedRouteIds = [];
	}
}

export function rebuildCarrierList(world: WorldState): void {
	const columns = new Map<number, { floors: Set<number>; mode: 0 | 1 | 2 }>();
	const overlayKeys = new Set<string>([
		...Object.keys(world.overlays),
		...Object.keys(world.overlayToAnchor),
	]);

	for (const key of overlayKeys) {
		const anchorKey = world.overlayToAnchor[key] ?? key;
		const type = world.overlays[anchorKey];
		let mode: 0 | 1 | 2;
		if (type === "elevator") mode = 1;
		else if (type === "elevatorExpress") mode = 0;
		else if (type === "elevatorService") mode = 2;
		else continue;

		const [anchorXStr] = anchorKey.split(",");
		const [, yStr] = key.split(",");
		const x = Number(anchorXStr);
		const y = Number(yStr);
		const floor = yToFloor(y);

		if (!columns.has(x)) columns.set(x, { floors: new Set(), mode });
		columns.get(x)?.floors.add(floor);
	}

	const newCarriers: CarrierRecord[] = [];
	let id = 0;

	for (const [col, { floors, mode }] of columns) {
		const sorted = [...floors].sort((a, b) => a - b);
		const bottom = sorted[0];
		const top = sorted[sorted.length - 1];
		const numSlots = top - bottom + 1;

		const existing = world.carriers.find((carrier) => carrier.column === col);
		if (existing) {
			existing.carrierId = id++;
			existing.carrierMode = mode;
			existing.topServedFloor = top;
			existing.bottomServedFloor = bottom;
			existing.waitingCarResponseThreshold ??= 4;
			existing.assignmentCapacity ??= mode === 0 ? 0x2a : 0x15;
			if (existing.servedFloorFlags.length !== 14) {
				existing.servedFloorFlags = new Array(14).fill(1);
			}
			if (existing.serviceScheduleFlags.length !== 14) {
				existing.serviceScheduleFlags = new Array(14).fill(1);
			}
			if (
				!Array.isArray(existing.dwellDelay) ||
				existing.dwellDelay.length !== 14
			) {
				existing.dwellDelay = new Array(14).fill(0);
			}
			if (
				!Array.isArray(existing.expressDirectionFlags) ||
				existing.expressDirectionFlags.length !== 14
			) {
				existing.expressDirectionFlags = new Array(14).fill(0);
			}
			existing.completedRouteIds ??= [];
			existing.suppressedFloorAssignments ??= [];
			if (existing.primaryRouteStatusByFloor.length !== numSlots) {
				existing.primaryRouteStatusByFloor = new Array(numSlots).fill(0);
				existing.secondaryRouteStatusByFloor = new Array(numSlots).fill(0);
			}
			if (existing.floorQueues.length !== numSlots) {
				existing.floorQueues = Array.from({ length: numSlots }, () =>
					createFloorQueue(),
				);
			}
			for (const car of existing.cars) {
				if (car.waitingCount.length !== numSlots) {
					car.waitingCount = new Array(numSlots).fill(0);
				}
				if (car.destinationCountByFloor.length !== numSlots) {
					car.destinationCountByFloor = new Array(numSlots).fill(0);
				}
				car.nonemptyDestinationCount ??= 0;
				car.activeRouteSlots ??= Array.from(
					{ length: ACTIVE_SLOT_CAPACITY },
					() => ({
						routeId: "",
						sourceFloor: 0xff,
						destinationFloor: 0xff,
						boarded: false,
						active: false,
					}),
				);
				car.homeFloor = Math.min(top, Math.max(bottom, car.homeFloor));
				if (car.currentFloor < bottom || car.currentFloor > top) {
					resetCarToHome(existing, car);
				}
				syncRouteSlots(existing, car);
			}
			newCarriers.push(existing);
		} else {
			newCarriers.push(makeCarrier(id++, col, mode, bottom, top));
		}
	}

	world.carriers = newCarriers;
	for (const carrier of world.carriers) {
		syncAssignmentStatus(carrier);
	}
}

export function initCarrierState(world: WorldState): void {
	world.carriers ??= [];
	world.floorWalkabilityFlags ??= new Array(GRID_HEIGHT).fill(0);
	world.transferGroupCache ??= new Array(GRID_HEIGHT).fill(0);
}

/**
 * Mirrors the binary's pop_unit_queue_request + pendingRoute removal triggered
 * by `dispatch_queued_route_until_request` (1218:1981) when
 * `maybe_dispatch_queued_route_after_wait` (1228:15a0) times the sim out from
 * a carrier ride. Removes the sim's pending route and any matching floor-queue
 * entry, then resyncs derived car state.
 */
export function evictCarrierRoute(carrier: CarrierRecord, simId: string): void {
	const route = findRoute(carrier, simId);
	if (!route) return;
	const floorQueue = getQueueState(carrier, route.sourceFloor);
	if (floorQueue) {
		const buf = getDirectionQueue(floorQueue, route.directionFlag);
		const remaining: string[] = [];
		while (!buf.isEmpty) {
			const popped = buf.pop();
			if (popped !== simId) remaining.push(popped as string);
		}
		for (const id of remaining) buf.push(id);
	}
	carrier.pendingRoutes = carrier.pendingRoutes.filter(
		(candidate) => candidate.simId !== simId,
	);
	syncAssignmentStatus(carrier);
}

export function enqueueCarrierRoute(
	carrier: CarrierRecord,
	simId: string,
	sourceFloor: number,
	destinationFloor: number,
	directionFlag: number,
): boolean {
	const traceOn =
		(globalThis as { __DRAIN_TRACE__?: boolean }).__DRAIN_TRACE__ === true;
	const dup = carrier.pendingRoutes.some((route) => route.simId === simId);
	if (traceOn) {
		console.log(
			`[enq] sim=${simId} src=${sourceFloor} dst=${destinationFloor} dir=${directionFlag}${dup ? " DEDUP" : ""}`,
		);
	}
	if (dup) return true;
	const floorQueue = getQueueState(carrier, sourceFloor);
	const directionQueue = floorQueue
		? getDirectionQueue(floorQueue, directionFlag)
		: null;
	const wasDirectionQueueEmpty = directionQueue?.isEmpty ?? false;
	if (!directionQueue?.push(simId)) {
		return false;
	}
	const route = {
		simId,
		sourceFloor,
		destinationFloor,
		boarded: false,
		directionFlag,
		assignedCarIndex: -1,
	};
	carrier.pendingRoutes.push(route);
	if (wasDirectionQueueEmpty) {
		assignCarToFloorRequest(carrier, sourceFloor, directionFlag);
	}
	syncAssignmentStatus(carrier);
	return true;
}
