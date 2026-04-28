import type { SimCommand } from "./sim/commands";
import type { SimSnapshot } from "./sim/index";

// ─── WebSocket messages from client ──────────────────────────────────────────

export type ClientMessage =
	| { type: "join_tower"; playerId: string; displayName: string }
	| {
			type: "input_batch";
			clientSeq: number;
			targetTick: number;
			inputs: SimCommand[];
	  }
	| { type: "ping" }
	| { type: "set_speed"; multiplier: 1 | 3 | 10 }
	| { type: "set_paused"; paused: boolean }
	| { type: "set_star_count"; starCount: 1 | 2 | 3 | 4 | 5 | 6 }
	| { type: "prompt_response"; promptId: string; accepted: boolean }
	| { type: "query_cell"; x: number; y: number }
	| { type: "set_rent_level"; x: number; y: number; rentLevel: number }
	| { type: "add_elevator_car"; x: number; y: number }
	| { type: "remove_elevator_car"; x: number; y: number }
	| {
			type: "set_cinema_movie_pool";
			x: number;
			y: number;
			pool: "classic" | "new";
	  }
	| { type: "set_free_build"; enabled: boolean }
	| { type: "set_active"; active: boolean };

// ─── WebSocket messages to client ────────────────────────────────────────────

export type CellData = {
	x: number;
	y: number;
	tileType: string;
	isAnchor: boolean;
	isOverlay?: boolean;
	evalActiveFlag?: number;
	unitStatus?: number;
};

export type SimStateData = {
	id: string;
	floorAnchor: number;
	selectedFloor: number;
	destinationFloor: number;
	homeColumn: number;
	baseOffset: number;
	familyCode: number;
	stateCode: number;
	routeMode: number;
	carrierId: number | null;
	assignedCarIndex: number;
	boardedOnCarrier: boolean;
	currentTripStressTicks: number;
	currentTripStressLevel: "low" | "medium" | "high";
	averageTripStressTicks: number;
	stressLevel: "low" | "medium" | "high";
	tripCount: number;
	accumulatedTicks: number;
	elapsedTicks: number;
};

export type CarrierCarStateData = {
	carrierId: number;
	carIndex: number;
	carCount: number;
	column: number;
	carrierMode: 0 | 1 | 2;
	currentFloor: number;
	targetFloor: number;
	settleCounter: number;
	directionFlag: number;
	dwellCounter: number;
	assignedCount: number;
	prevFloor: number;
	arrivalSeen: number;
	arrivalTick: number;
	homeFloor: number;
	active: boolean;
};

export type ResolvedInputBatch = {
	playerId: string;
	clientSeq: number;
	inputs: SimCommand[];
	rejectedReason?: string;
};

export type ServerMessage =
	| {
			type: "init_state";
			towerId: string;
			name: string;
			simTime: number;
			snapshot: SimSnapshot;
			speedMultiplier: 1 | 3 | 10;
			freeBuild: boolean;
			paused: boolean;
			cash: number;
			population: number;
			starCount: number;
			width: number;
			height: number;
	  }
	| {
			type: "authoritative_batch";
			serverTick: number;
			batches: ResolvedInputBatch[];
			/**
			 * Cheap u32 checksum of the server's lockstep-relevant TS state
			 * AFTER applying the resolved batches. Clients compare against
			 * their local `TowerSim.lockstepChecksum` after replay; on
			 * mismatch they log and force a checkpoint reapply. Drift
			 * detection between full 500-tick checkpoints.
			 */
			checksum: number;
	  }
	| { type: "presence_update"; playerCount: number; activeCount: number }
	| {
			type: "checkpoint";
			serverTick: number;
			snapshot: SimSnapshot;
			speedMultiplier: 1 | 3 | 10;
			freeBuild: boolean;
	  }
	| {
			type: "session_settings";
			speedMultiplier: 1 | 3 | 10;
			freeBuild: boolean;
			paused: boolean;
	  }
	| {
			type: "economy_update";
			cash: number;
			population: number;
			starCount: number;
	  }
	| { type: "notification"; kind: string; message: string }
	| {
			type: "prompt";
			promptId: string;
			promptKind: "bomb_ransom" | "fire_rescue" | "carrier_edit_confirmation";
			message: string;
			cost?: number;
	  }
	| { type: "prompt_dismissed"; promptId: string }
	| {
			type: "cell_info";
			x: number;
			y: number;
			anchorX: number;
			tileType: string;
			objectInfo?: {
				objectTypeCode: number;
				rentLevel: number;
				evalLevel: number;
				unitStatus: number;
				activationTickCount: number;
				housekeepingClaimedFlag?: number;
			};
			cinemaInfo?: {
				selector: number;
				linkAgeCounter: number;
				attendanceCounter: number;
				linkPhaseState: number;
			};
			carrierInfo?: {
				carrierId: number;
				column: number;
				carrierMode: 0 | 1 | 2;
				topServedFloor: number;
				bottomServedFloor: number;
				carCount: number;
				maxCars: number;
				servedFloors: number[];
				dwellDelay: number;
				waitingCarResponseThreshold: number;
				stopFloorEnabled: boolean[];
				carInfos: { homeFloor: number; active: boolean }[];
			};
	  }
	| { type: "pong" };
