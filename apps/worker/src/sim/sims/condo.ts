import { addCashflowFromFamilyResource, type LedgerState } from "../ledger";
import type { TimeState } from "../time";
import type { EntityRecord, WorldState } from "../world";
import {
	dispatchCommercialVenueVisit,
	findObjectForEntity,
	finishCommercialVenueDwell,
	finishCommercialVenueTrip,
	recomputeObjectOperationalStatus,
} from "./index";
import {
	CONDO_SELECTOR_FAST_FOOD,
	CONDO_SELECTOR_RESTAURANT,
	STATE_ACTIVE,
	STATE_PARKED,
	STATE_VENUE_TRIP,
	UNIT_STATUS_CONDO_VACANT,
} from "./states";

export function processCondoEntity(
	world: WorldState,
	ledger: LedgerState,
	time: TimeState,
	entity: EntityRecord,
): void {
	const object = findObjectForEntity(world, entity);
	if (!object) return;

	if (entity.stateCode === STATE_PARKED) entity.stateCode = STATE_ACTIVE;
	if (finishCommercialVenueDwell(entity, time, STATE_ACTIVE)) return;
	if (entity.stateCode === STATE_ACTIVE) {
		dispatchCommercialVenueVisit(world, time, entity, {
			venueFamilies:
				entity.baseOffset % 4 === 0
					? CONDO_SELECTOR_RESTAURANT
					: CONDO_SELECTOR_FAST_FOOD,
			returnState: STATE_ACTIVE,
			unavailableState: STATE_PARKED,
			skipPenaltyOnUnavailable: true,
			onVenueReserved: () => {
				if (object.unitStatus < UNIT_STATUS_CONDO_VACANT) return;
				object.unitStatus = time.daypartIndex < 4 ? 0x08 : 0x00;
				object.needsRefreshFlag = 1;
				if (entity.baseOffset !== 0) return;
				addCashflowFromFamilyResource(
					ledger,
					"condo",
					object.rentLevel,
					object.objectTypeCode,
				);
			},
		});
	} else if (entity.stateCode === STATE_VENUE_TRIP) {
		finishCommercialVenueTrip(entity, STATE_ACTIVE);
	}

	recomputeObjectOperationalStatus(world, time, entity, object);
}
