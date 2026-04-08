// ─── WebSocket messages from client ──────────────────────────────────────────

export type ClientMessage =
	| { type: "join_tower"; playerId: string; displayName: string }
	| { type: "place_tile"; x: number; y: number; tileType: string }
	| { type: "remove_tile"; x: number; y: number }
	| { type: "ping" };

// ─── WebSocket messages to client ────────────────────────────────────────────

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
