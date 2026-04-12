import { addCashflowFromFamilyResource, type LedgerState } from "../ledger";
import {
	FAMILY_HOTEL_SINGLE,
	FAMILY_HOTEL_SUITE,
	FAMILY_HOTEL_TWIN,
} from "../resources";
import type { TimeState } from "../time";
import type { EntityRecord, PlacedObjectRecord, WorldState } from "../world";
import {
	dispatchCommercialVenueVisit,
	findObjectForEntity,
	findSiblingEntities,
	finishCommercialVenueDwell,
	finishCommercialVenueTrip,
	resolveSimRouteBetweenFloors,
	tryAssignParkingService,
} from "./index";
import {
	ACTIVATION_TICK_CAP,
	COMMERCIAL_DWELL_STATE,
	COMMERCIAL_FAMILIES,
	LOBBY_FLOOR,
	STATE_ACTIVE,
	STATE_CHECKOUT_QUEUE,
	STATE_COMMUTE,
	STATE_DEPARTURE,
	STATE_HOTEL_PARKED,
	STATE_TRANSITION,
	STATE_VENUE_TRIP,
} from "./states";

function activateHotelStay(
	world: WorldState,
	entity: EntityRecord,
	time: TimeState,
): void {
	const object = findObjectForEntity(world, entity);
	if (!object) return;

	// Route requirement: actual route must succeed, not just structural check.
	const directionFlag = entity.floorAnchor > LOBBY_FLOOR ? 0 : 1;
	const result = resolveSimRouteBetweenFloors(
		world,
		entity,
		LOBBY_FLOOR,
		entity.floorAnchor,
		directionFlag,
		time,
	);
	if (result === -1 || result === 0) {
		return;
	}

	entity.originFloor = LOBBY_FLOOR;
	object.unitStatus = time.daypartIndex < 4 ? 0 : 8;
	object.needsRefreshFlag = 1;

	if (result === 3) {
		// Same-floor: immediate arrival
		entity.stateCode = STATE_ACTIVE;
		entity.selectedFloor = entity.floorAnchor;
	} else {
		// In-transit: commute to room, arrival handled by dispatchEntityArrival
		entity.stateCode = STATE_COMMUTE;
		entity.selectedFloor = LOBBY_FLOOR;
		entity.destinationFloor = entity.floorAnchor;
	}
}

export function checkoutHotelStay(
	world: WorldState,
	ledger: LedgerState,
	time: TimeState,
	entity: EntityRecord,
	object: PlacedObjectRecord,
): void {
	const siblings = findSiblingEntities(world, entity);
	const lastSibling = siblings.reduce(
		(max, sibling) => Math.max(max, sibling.baseOffset),
		0,
	);
	if (entity.baseOffset !== lastSibling) {
		entity.stateCode = STATE_CHECKOUT_QUEUE;
		return;
	}

	const tileName =
		object.objectTypeCode === FAMILY_HOTEL_SINGLE
			? "hotelSingle"
			: object.objectTypeCode === FAMILY_HOTEL_TWIN
				? "hotelTwin"
				: "hotelSuite";
	addCashflowFromFamilyResource(
		ledger,
		tileName,
		object.rentLevel,
		object.objectTypeCode,
	);
	world.gateFlags.family345SaleCount += 1;
	const saleCount = world.gateFlags.family345SaleCount;
	if (
		(saleCount < 20 && saleCount % 2 === 0) ||
		(saleCount >= 20 && saleCount % 8 === 0)
	) {
		world.gateFlags.newspaperTrigger = 1;
	} else {
		world.gateFlags.newspaperTrigger = 0;
	}
	for (const sibling of siblings) sibling.stateCode = STATE_HOTEL_PARKED;
	object.unitStatus = time.daypartIndex < 4 ? 0x28 : 0x30;
	object.evalActiveFlag = 0;
	object.activationTickCount = 0;
	object.needsRefreshFlag = 1;
}

export function processHotelEntity(
	world: WorldState,
	ledger: LedgerState,
	time: TimeState,
	entity: EntityRecord,
): void {
	const object = findObjectForEntity(world, entity);
	if (!object) return;

	switch (entity.stateCode) {
		case STATE_HOTEL_PARKED:
			activateHotelStay(world, entity, time);
			return;
		case STATE_ACTIVE: {
			if (time.daypartIndex >= 4) {
				if (object.unitStatus === 0 || object.unitStatus === 8) {
					object.unitStatus = STATE_TRANSITION;
				}
				entity.destinationFloor = LOBBY_FLOOR;
				entity.selectedFloor = entity.floorAnchor;
				entity.stateCode = STATE_DEPARTURE;
				return;
			}
			// Hotel suite parking demand: eligible when occupied (unitStatus != 0)
			if (
				entity.familyCode === FAMILY_HOTEL_SUITE &&
				time.starCount > 2 &&
				object.unitStatus !== 0
			) {
				tryAssignParkingService(world, time, entity);
			}
			dispatchCommercialVenueVisit(world, time, entity, {
				venueFamilies: COMMERCIAL_FAMILIES,
				returnState: STATE_ACTIVE,
				onVenueReserved: () => {
					object.activationTickCount = Math.min(
						ACTIVATION_TICK_CAP,
						object.activationTickCount + 1,
					);
				},
			});
			return;
		}
		case STATE_COMMUTE:
			// In transit from lobby to room; arrival handled by dispatchEntityArrival
			return;
		case STATE_VENUE_TRIP:
			finishCommercialVenueTrip(entity, STATE_ACTIVE);
			return;
		case STATE_DEPARTURE:
		case STATE_CHECKOUT_QUEUE:
			if (entity.selectedFloor !== LOBBY_FLOOR) return;
			if (object.unitStatus === 0 || object.unitStatus === 8) {
				object.unitStatus = STATE_TRANSITION;
				object.needsRefreshFlag = 1;
				return;
			}
			if (object.unitStatus === STATE_TRANSITION) {
				object.unitStatus =
					object.objectTypeCode === FAMILY_HOTEL_SINGLE ? 1 : 2;
				object.needsRefreshFlag = 1;
				return;
			}
			if ((object.unitStatus & 0x07) > 1) {
				object.unitStatus -= 1;
				object.needsRefreshFlag = 1;
				return;
			}
			checkoutHotelStay(world, ledger, time, entity, object);
			return;
		case COMMERCIAL_DWELL_STATE:
			finishCommercialVenueDwell(entity, time, STATE_ACTIVE);
			return;
		default:
			entity.stateCode = STATE_HOTEL_PARKED;
	}
}
