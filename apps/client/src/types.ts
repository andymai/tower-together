// ─── Grid constants (must match apps/worker/src/sim/world.ts) ────────────────

export const GRID_WIDTH = 64;
export const GRID_HEIGHT = 120;
export const UNDERGROUND_FLOORS = 10;
export const UNDERGROUND_Y = GRID_HEIGHT - UNDERGROUND_FLOORS; // Y=110
export const GROUND_Y = GRID_HEIGHT - 1 - UNDERGROUND_FLOORS; // Y=109

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
	| "escalator"
	// Hotels
	| "hotel_single"
	| "hotel_twin"
	| "hotel_suite"
	// VIP Hotels
	| "vip_single"
	| "vip_twin"
	| "vip_suite"
	// Commercial
	| "restaurant"
	| "fast_food"
	| "retail"
	// Office / Condo
	| "office"
	| "condo"
	// Entertainment
	| "cinema"
	| "entertainment"
	// Services
	| "security"
	| "housekeeping"
	| "parking"
	| "metro"
	| "fire_suppressor";

export type SelectedTool = TileType;

export type ConnectionStatus = "connecting" | "connected" | "disconnected";

/** Width in grid cells for each placeable tile type. */
export const TILE_WIDTHS: Record<string, number> = {
	floor: 1,
	lobby: 1,
	stairs: 2,
	elevator: 1,
	escalator: 1,
	hotel_single: 1,
	hotel_twin: 2,
	hotel_suite: 3,
	vip_single: 1,
	vip_twin: 2,
	vip_suite: 3,
	restaurant: 2,
	fast_food: 2,
	retail: 2,
	office: 6,
	condo: 3,
	cinema: 4,
	entertainment: 4,
	security: 2,
	housekeeping: 2,
	parking: 4,
	metro: 4,
	fire_suppressor: 2,
};

/** Construction cost in dollars. */
export const TILE_COSTS: Record<string, number> = {
	floor: 5_000,
	lobby: 0,
	stairs: 0,
	elevator: 0,
	escalator: 0,
	hotel_single: 50_000,
	hotel_twin: 80_000,
	hotel_suite: 120_000,
	vip_single: 100_000,
	vip_twin: 150_000,
	vip_suite: 225_000,
	restaurant: 500_000,
	fast_food: 200_000,
	retail: 300_000,
	office: 900_000,
	condo: 500_000,
	cinema: 2_000_000,
	entertainment: 500_000,
	security: 500_000,
	housekeeping: 100_000,
	parking: 1_000_000,
	metro: 2_000_000,
	fire_suppressor: 500_000,
};

// ─── Wire protocol ────────────────────────────────────────────────────────────

export type CellData = {
	x: number;
	y: number;
	tileType: string;
	isAnchor: boolean;
	isOverlay?: boolean;
};

export type ServerMessage =
	| {
			type: "init_state";
			towerId: string;
			name: string;
			simTime: number;
			cash: number;
			width: number;
			height: number;
			cells: CellData[];
	  }
	| { type: "state_patch"; cells: CellData[] }
	| {
			type: "command_result";
			accepted: boolean;
			patch?: { cells: CellData[] };
			reason?: string;
	  }
	| { type: "presence_update"; playerCount: number }
	| { type: "time_update"; simTime: number }
	| { type: "economy_update"; cash: number }
	| { type: "pong" };

export type ClientMessage =
	| { type: "join_tower"; playerId: string; displayName: string }
	| { type: "place_tile"; x: number; y: number; tileType: string }
	| { type: "remove_tile"; x: number; y: number }
	| { type: "ping" };
