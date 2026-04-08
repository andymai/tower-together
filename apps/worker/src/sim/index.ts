import type { ClientMessage } from "../types";
import { advanceOneTick, createTimeState, type TimeState } from "./time";
import { GRID_HEIGHT, GRID_WIDTH, isValidLobbyY, type WorldState } from "./world";
import {
	HOTEL_DAILY_INCOME,
	STARTING_CASH,
	TILE_COSTS,
	TILE_WIDTHS,
	VALID_TILE_TYPES,
} from "./resources";

// ─── Public types ─────────────────────────────────────────────────────────────

export type CellPatch = {
	x: number;
	y: number;
	tileType: string;
	isAnchor: boolean;
	isOverlay?: boolean;
};

export interface CommandResult {
	accepted: boolean;
	patch?: CellPatch[];
	reason?: string;
	economyChanged?: boolean;
}

export interface StepResult {
	simTime: number;
	economyChanged?: boolean;
}

export interface SimSnapshot {
	time: TimeState;
	world: WorldState;
}

// ─── TowerSim ─────────────────────────────────────────────────────────────────

export class TowerSim {
	private time: TimeState;
	private world: WorldState;

	private constructor(time: TimeState, world: WorldState) {
		this.time = time;
		this.world = world;
	}

	// ── Factory methods ────────────────────────────────────────────────────────

	static create(towerId: string, name: string): TowerSim {
		const time = createTimeState();
		const world: WorldState = {
			towerId,
			name,
			width: GRID_WIDTH,
			height: GRID_HEIGHT,
			cash: STARTING_CASH,
			cells: {},
			cellToAnchor: {},
			overlays: {},
			overlayToAnchor: {},
		};
		return new TowerSim(time, world);
	}

	static from_snapshot(snap: SimSnapshot): TowerSim {
		// Migrate old saves: expand grid if it was shorter
		if (snap.world.height < GRID_HEIGHT) snap.world.height = GRID_HEIGHT;
		return new TowerSim(snap.time, snap.world);
	}

	// ── Tick ──────────────────────────────────────────────────────────────────

	step(): StepResult {
		const { time, incomeCheckpoint } = advanceOneTick(this.time);
		this.time = time;

		let economyChanged = false;
		if (incomeCheckpoint) {
			economyChanged = this.collectPlaceholderIncome();
		}

		return { simTime: this.time.total_ticks, economyChanged };
	}

	/**
	 * Placeholder: add flat daily rates for hotel tiles until entity checkout AI
	 * is implemented in Phase 4.
	 */
	private collectPlaceholderIncome(): boolean {
		let income = 0;
		for (const [key, tileType] of Object.entries(this.world.cells)) {
			if (this.world.cellToAnchor[key]) continue; // skip extension cells
			const rate = HOTEL_DAILY_INCOME[tileType];
			if (rate) income += rate;
		}
		if (income > 0) {
			this.world.cash = Math.min(99_999_999, this.world.cash + income);
			return true;
		}
		return false;
	}

	// ── Commands ──────────────────────────────────────────────────────────────

	submit_command(cmd: ClientMessage): CommandResult {
		switch (cmd.type) {
			case "place_tile":
				return this.handlePlaceTile(cmd.x, cmd.y, cmd.tileType);
			case "remove_tile":
				return this.handleRemoveTile(cmd.x, cmd.y);
			case "join_tower":
			case "ping":
				return { accepted: true };
		}
	}

	private handlePlaceTile(x: number, y: number, tileType: string): CommandResult {
		const w = this.world;

		if (!VALID_TILE_TYPES.has(tileType)) {
			return { accepted: false, reason: "Invalid tile type" };
		}
		if (x < 0 || x >= w.width || y < 0 || y >= w.height) {
			return { accepted: false, reason: "Out of bounds" };
		}

		// ── Stairs: overlay on existing base tiles ──
		if (tileType === "stairs") {
			if (x + 1 >= w.width) {
				return { accepted: false, reason: "Out of bounds" };
			}
			for (let dx = 0; dx < 2; dx++) {
				const key = `${x + dx},${y}`;
				if (!w.cells[key] && !w.cellToAnchor[key]) {
					return { accepted: false, reason: "Stairs require a base tile" };
				}
				if (w.overlays[key] || w.overlayToAnchor[key]) {
					return { accepted: false, reason: "Cell already has an overlay" };
				}
			}
			w.overlays[`${x},${y}`] = "stairs";
			w.overlayToAnchor[`${x + 1},${y}`] = `${x},${y}`;
			const patch: CellPatch[] = [{ x, y, tileType: "stairs", isAnchor: true, isOverlay: true }];
			return { accepted: true, patch };
		}

		// ── Standard tile placement ──
		const tileWidth = TILE_WIDTHS[tileType] ?? 1;
		const cost = TILE_COSTS[tileType] ?? 0;

		if (x + tileWidth - 1 >= w.width) {
			return { accepted: false, reason: "Out of bounds" };
		}
		if (tileType === "lobby" && !isValidLobbyY(y)) {
			return { accepted: false, reason: "Lobby only allowed on ground floor or every 15 floors above" };
		}
		if (cost > w.cash) {
			return { accepted: false, reason: "Insufficient funds" };
		}

		const canReplaceFloor = tileType !== "floor";
		const floorToRemove: string[] = [];
		for (let dx = 0; dx < tileWidth; dx++) {
			const key = `${x + dx},${y}`;
			if (w.cellToAnchor[key]) {
				return { accepted: false, reason: "Cell already occupied" };
			}
			const existing = w.cells[key];
			if (existing) {
				if (canReplaceFloor && existing === "floor") {
					floorToRemove.push(key);
				} else {
					return { accepted: false, reason: "Cell already occupied" };
				}
			}
		}

		// All non-lobby tiles need support from the row below
		if (tileType !== "lobby") {
			for (let dx = 0; dx < tileWidth; dx++) {
				const belowKey = `${x + dx},${y + 1}`;
				if (y + 1 >= w.height || !w.cells[belowKey]) {
					return { accepted: false, reason: "No support below" };
				}
			}
		}

		for (const key of floorToRemove) delete w.cells[key];
		w.cells[`${x},${y}`] = tileType;
		for (let dx = 1; dx < tileWidth; dx++) {
			w.cells[`${x + dx},${y}`] = tileType;
			w.cellToAnchor[`${x + dx},${y}`] = `${x},${y}`;
		}
		w.cash -= cost;

		const patch: CellPatch[] = Array.from({ length: tileWidth }, (_, dx) => ({
			x: x + dx,
			y,
			tileType,
			isAnchor: dx === 0,
		}));

		this.fillRowGaps(y, patch);

		return { accepted: true, patch, economyChanged: cost > 0 };
	}

	private handleRemoveTile(x: number, y: number): CommandResult {
		const w = this.world;

		if (x < 0 || x >= w.width || y < 0 || y >= w.height) {
			return { accepted: false, reason: "Out of bounds" };
		}
		const clickedKey = `${x},${y}`;

		// Remove overlay first if present
		const overlayAnchorKey =
			w.overlayToAnchor[clickedKey] ?? (w.overlays[clickedKey] ? clickedKey : null);
		if (overlayAnchorKey !== null) {
			const overlayType = w.overlays[overlayAnchorKey];
			const ow = TILE_WIDTHS[overlayType] ?? 1;
			const [ax] = overlayAnchorKey.split(",").map(Number);
			delete w.overlays[overlayAnchorKey];
			for (let dx = 1; dx < ow; dx++) {
				delete w.overlayToAnchor[`${ax + dx},${y}`];
			}
			const [oax, oay] = overlayAnchorKey.split(",").map(Number);
			const patch: CellPatch[] = [{ x: oax, y: oay, tileType: "empty", isAnchor: true, isOverlay: true }];
			return { accepted: true, patch };
		}

		const anchorKey = w.cellToAnchor[clickedKey] ?? clickedKey;
		const tileType = w.cells[anchorKey];
		if (!tileType) {
			return { accepted: false, reason: "Cell is empty" };
		}

		const [ax, ay] = anchorKey.split(",").map(Number);
		const tileWidth = TILE_WIDTHS[tileType] ?? 1;

		// Determine replacement: floor if anything sits above or tile is between neighbours
		let hasAbove = false;
		for (let dx = 0; dx < tileWidth && !hasAbove; dx++) {
			if (w.cells[`${ax + dx},${ay - 1}`]) hasAbove = true;
		}
		let hasLeft = false;
		for (let lx = ax - 1; lx >= 0 && !hasLeft; lx--) {
			if (w.cells[`${lx},${ay}`]) hasLeft = true;
		}
		let hasRight = false;
		for (let rx = ax + tileWidth; rx < w.width && !hasRight; rx++) {
			if (w.cells[`${rx},${ay}`]) hasRight = true;
		}
		const turnToFloor = hasAbove || (hasLeft && hasRight);

		delete w.cells[anchorKey];
		for (let dx = 1; dx < tileWidth; dx++) {
			delete w.cells[`${ax + dx},${ay}`];
			delete w.cellToAnchor[`${ax + dx},${ay}`];
		}

		const patch: CellPatch[] = [];
		for (let dx = 0; dx < tileWidth; dx++) {
			const resultType = turnToFloor ? "floor" : "empty";
			if (turnToFloor) w.cells[`${ax + dx},${ay}`] = "floor";
			patch.push({ x: ax + dx, y: ay, tileType: resultType, isAnchor: true });
		}

		return { accepted: true, patch };
	}

	/** After a placement on row y, fill supported horizontal gaps with free floor tiles. */
	private fillRowGaps(y: number, patch: CellPatch[]): void {
		const w = this.world;
		if (y + 1 >= w.height) return;

		let leftmost = -1;
		let rightmost = -1;
		for (let x = 0; x < w.width; x++) {
			if (w.cells[`${x},${y}`]) {
				if (leftmost === -1) leftmost = x;
				rightmost = x;
			}
		}
		if (leftmost === -1) return;

		for (let x = leftmost; x <= rightmost; x++) {
			const key = `${x},${y}`;
			if (w.cells[key]) continue;
			if (!w.cells[`${x},${y + 1}`]) continue;
			w.cells[key] = "floor";
			patch.push({ x, y, tileType: "floor", isAnchor: true });
		}
	}

	// ── Serialization ──────────────────────────────────────────────────────────

	save_state(): SimSnapshot {
		return { time: { ...this.time }, world: this.cloneWorld() };
	}

	private cloneWorld(): WorldState {
		return {
			towerId: this.world.towerId,
			name: this.world.name,
			width: this.world.width,
			height: this.world.height,
			cash: this.world.cash,
			cells: { ...this.world.cells },
			cellToAnchor: { ...this.world.cellToAnchor },
			overlays: { ...this.world.overlays },
			overlayToAnchor: { ...this.world.overlayToAnchor },
		};
	}

	// ── Accessors for TowerRoom ────────────────────────────────────────────────

	get towerId(): string { return this.world.towerId; }
	get name(): string { return this.world.name; }
	get simTime(): number { return this.time.total_ticks; }
	get cash(): number { return this.world.cash; }
	get width(): number { return this.world.width; }
	get height(): number { return this.world.height; }

	cellsToArray(): CellPatch[] {
		const result: CellPatch[] = [];
		for (const [key, tileType] of Object.entries(this.world.cells)) {
			const [x, y] = key.split(",").map(Number);
			result.push({ x, y, tileType, isAnchor: !this.world.cellToAnchor[key] });
		}
		for (const [key, tileType] of Object.entries(this.world.overlays)) {
			const [x, y] = key.split(",").map(Number);
			result.push({ x, y, tileType, isAnchor: true, isOverlay: true });
		}
		return result;
	}
}
