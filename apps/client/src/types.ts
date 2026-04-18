import type { SimCommand } from "../../worker/src/sim/commands";
import type { SimSnapshot } from "../../worker/src/sim/index";
import {
	getTileStarRequirement as getWorkerTileStarRequirement,
	STARTING_CASH as WORKER_STARTING_CASH,
	TILE_COSTS as WORKER_TILE_COSTS,
	TILE_STAR_REQUIREMENTS as WORKER_TILE_STAR_REQUIREMENTS,
	TILE_WIDTHS as WORKER_TILE_WIDTHS,
} from "../../worker/src/sim/resources";
import {
	GRID_HEIGHT,
	GRID_WIDTH,
	GROUND_Y,
	UNDERGROUND_FLOORS,
	UNDERGROUND_Y,
} from "../../worker/src/sim/world";

// ─── Grid constants (shared with apps/worker/src/sim) ────────────────────────

export { GRID_HEIGHT, GRID_WIDTH, GROUND_Y, UNDERGROUND_FLOORS, UNDERGROUND_Y };

// ─── Time constants (must match apps/worker/src/sim/time.ts) ─────────────────

/** Ticks per in-game day. */
export const DAY_TICK_MAX = 2600;

// ─── Tile registry (must match apps/worker/src/sim/resources.ts) ─────────────

export type TileType =
	| "empty"
	// Infrastructure
	| "floor"
	| "lobby"
	| "stairs"
	| "elevator"
	| "elevatorExpress"
	| "elevatorService"
	| "escalator"
	// Hotels
	| "hotelSingle"
	| "hotelTwin"
	| "hotelSuite"
	// Commercial
	| "restaurant"
	| "fastFood"
	| "retail"
	// Office / Condo
	| "office"
	| "condo"
	// Entertainment
	| "cinema"
	| "partyHall"
	// Services
	| "recyclingCenter"
	| "recyclingCenterUpper"
	| "recyclingCenterLower"
	| "parking"
	| "metro"
	| "housekeeping";

export type SelectedTool = TileType | "inspect";

export type ConnectionStatus = "connecting" | "connected" | "disconnected";

/** Width in grid cells for each placeable tile type. */
export const TILE_WIDTHS: Record<string, number> = WORKER_TILE_WIDTHS;

/** Construction cost in dollars. */
export const TILE_COSTS: Record<string, number> = WORKER_TILE_COSTS;
export const TILE_STAR_REQUIREMENTS: Record<string, number> =
	WORKER_TILE_STAR_REQUIREMENTS;
export const STARTING_CASH = WORKER_STARTING_CASH;
export const getTileStarRequirement = getWorkerTileStarRequirement;

// ─── Wire protocol ────────────────────────────────────────────────────────────

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
	  }
	| { type: "presence_update"; playerCount: number }
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
			promptKind: "bomb_ransom" | "fire_rescue";
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
				venueAvailability?: number;
			};
			carrierInfo?: {
				carrierId: number;
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

export type ClientMessage =
	| { type: "join_tower"; playerId: string; displayName: string }
	| { type: "input_batch"; clientSeq: number; inputs: SimCommand[] }
	| { type: "ping" }
	| { type: "set_speed"; multiplier: 1 | 3 | 10 }
	| { type: "set_star_count"; starCount: 1 | 2 | 3 | 4 | 5 | 6 }
	| { type: "prompt_response"; promptId: string; accepted: boolean }
	| { type: "query_cell"; x: number; y: number }
	| { type: "set_rent_level"; x: number; y: number; rentLevel: number }
	| { type: "add_elevator_car"; x: number; y: number }
	| { type: "remove_elevator_car"; x: number }
	| { type: "set_free_build"; enabled: boolean };
