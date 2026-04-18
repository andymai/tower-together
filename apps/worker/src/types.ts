import type { SimCommand } from "./sim/commands";
import type { SimSnapshot } from "./sim/index";

// ─── WebSocket messages from client ──────────────────────────────────────────

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
	speedCounter: number;
	doorWaitCounter: number;
	directionFlag: number;
	dwellCounter: number;
	assignedCount: number;
	prevFloor: number;
	arrivalSeen: number;
	arrivalTick: number;
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
			};
			carrierInfo?: {
				carrierId: number;
				carrierMode: 0 | 1 | 2;
				topServedFloor: number;
				bottomServedFloor: number;
				carCount: number;
				maxCars: number;
				servedFloors: number[];
			};
	  }
	| { type: "pong" };
