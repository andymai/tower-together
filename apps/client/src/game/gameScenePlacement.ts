import {
	GRID_HEIGHT,
	GRID_WIDTH,
	TILE_WIDTHS,
	UNDERGROUND_FLOORS,
	UNDERGROUND_Y,
} from "../types";
import { TILE_HEIGHT, TILE_WIDTH } from "./gameSceneConstants";

export interface PlacementAnchor {
	x: number;
	y: number;
	tileType: string;
}

export interface HoverBounds {
	x: number;
	y: number;
	width: number;
	height: number;
}

export function isElevatorTileType(tool: string): boolean {
	return (
		tool === "elevator" ||
		tool === "elevatorExpress" ||
		tool === "elevatorService"
	);
}

/** Max contiguous shaft floors for non-express elevator types. */
export const ELEVATOR_MAX_SHAFT_FLOORS = 31;

export function contiguousShaftExtent(
	x: number,
	y: number,
	tileType: string,
	overlays: Map<string, string>,
): { topY: number; bottomY: number } {
	let topY = y;
	let bottomY = y;
	while (topY > 0 && overlays.get(`${x},${topY - 1}`) === tileType) topY -= 1;
	while (
		bottomY < GRID_HEIGHT - 1 &&
		overlays.get(`${x},${bottomY + 1}`) === tileType
	)
		bottomY += 1;
	return { topY, bottomY };
}

export function computeShiftFill(
	clickX: number,
	clickY: number,
	selectedTool: string,
	lastPlacedAnchor: PlacementAnchor | null,
	grid: Map<string, string>,
	overlays: Map<string, string> = new Map(),
): Array<{ x: number; y: number }> {
	if (!lastPlacedAnchor || selectedTool === "empty") return [];
	const { x: lastX, y: lastY, tileType: lastType } = lastPlacedAnchor;
	if (lastType !== selectedTool) return [];

	const tileWidth = TILE_WIDTHS[selectedTool] ?? 1;
	const lastTileWidth = TILE_WIDTHS[lastType] ?? 1;
	// Elevator shafts are columnar; pin shift-fill to the anchor column so any
	// off-axis hover still produces a clean vertical span.
	const effectiveClickX = isElevatorTileType(selectedTool) ? lastX : clickX;
	const yMin = Math.min(lastY, clickY);
	const yMax = Math.max(lastY, clickY);

	if (isElevatorTileType(selectedTool)) {
		const results: Array<{ x: number; y: number }> = [];
		if (lastX < 0 || lastX + tileWidth - 1 >= GRID_WIDTH) return results;

		// Express shafts have no length limit; standard/service cap the total
		// contiguous shaft at ELEVATOR_MAX_SHAFT_FLOORS floors.
		let clampedYMin = Math.max(0, yMin);
		let clampedYMax = Math.min(GRID_HEIGHT - 1, yMax);
		if (selectedTool !== "elevatorExpress") {
			const { topY, bottomY } = contiguousShaftExtent(
				lastX,
				lastY,
				selectedTool,
				overlays,
			);
			const existingCount = bottomY - topY + 1;
			const remaining = Math.max(0, ELEVATOR_MAX_SHAFT_FLOORS - existingCount);
			if (clampedYMin < topY) {
				clampedYMin = Math.max(clampedYMin, topY - remaining);
			}
			if (clampedYMax > bottomY) {
				clampedYMax = Math.min(clampedYMax, bottomY + remaining);
			}
		}

		for (let y = clampedYMax; y >= clampedYMin; y--) {
			if (y === lastY) continue;
			if (overlays.get(`${lastX},${y}`) === selectedTool) continue;
			results.push({ x: lastX, y });
		}
		return results;
	}

	// Shared tentative set so earlier rows provide support for later ones.
	const tentative = new Set<string>();
	const results: Array<{ x: number; y: number }> = [];

	// Above-ground: iterate bottom-to-top (high y first) since support comes
	// from below. Underground: iterate top-to-bottom since support hangs from
	// above. Pick by anchor row so the row adjacent to the anchor is placed
	// first and feeds support into the rest.
	const undergroundFill = lastY >= UNDERGROUND_Y;
	const yStart = undergroundFill ? yMin : yMax;
	const yEnd = undergroundFill ? yMax : yMin;
	const yStep = undergroundFill ? 1 : -1;
	if (lastX < effectiveClickX) {
		const fillEnd = effectiveClickX;
		for (let y = yStart; undergroundFill ? y <= yEnd : y >= yEnd; y += yStep) {
			const fillStart = y === lastY ? lastX + lastTileWidth : lastX;
			if (fillStart > fillEnd) continue;
			results.push(
				...packLeft(
					fillStart,
					fillEnd,
					y,
					tileWidth,
					selectedTool,
					grid,
					tentative,
				),
			);
		}
	} else if (lastX > effectiveClickX) {
		const fillStart = effectiveClickX;
		for (let y = yStart; undergroundFill ? y <= yEnd : y >= yEnd; y += yStep) {
			const fillEnd = y === lastY ? lastX - 1 : lastX + lastTileWidth - 1;
			if (fillStart > fillEnd) continue;
			results.push(
				...packRight(
					fillStart,
					fillEnd,
					y,
					tileWidth,
					selectedTool,
					grid,
					tentative,
				),
			);
		}
	} else {
		// Same X column — pure vertical fill.
		for (let y = yStart; undergroundFill ? y <= yEnd : y >= yEnd; y += yStep) {
			if (y === lastY) continue;
			if (cellsAvailable(lastX, y, tileWidth, tentative, selectedTool, grid)) {
				results.push({ x: lastX, y });
				for (let dx = 0; dx < tileWidth; dx++) {
					tentative.add(`${lastX + dx},${y}`);
				}
			}
		}
	}

	return results;
}

/** Convert a cursor cell X to the left-edge anchor X so the facility is centred on the cursor. */
export function anchorX(cursorX: number, selectedTool: string): number {
	const width = TILE_WIDTHS[selectedTool] ?? 1;
	return cursorX - Math.floor((width - 1) / 2);
}

export function getHoverBounds(
	cursorX: number,
	y: number,
	selectedTool: string,
): HoverBounds | null {
	if (y < 0 || y >= GRID_HEIGHT) return null;
	if (selectedTool === "lobby" && !isValidLobbyRow(y)) return null;

	const width = selectedTool !== "empty" ? (TILE_WIDTHS[selectedTool] ?? 1) : 1;
	const x = anchorX(cursorX, selectedTool);
	const heightCells =
		selectedTool === "stairs" ||
		selectedTool === "escalator" ||
		selectedTool === "cinema" ||
		selectedTool === "partyHall" ||
		selectedTool === "recyclingCenter"
			? 2
			: 1;
	const startX = Math.max(0, x);
	const endX = Math.min(GRID_WIDTH - 1, x + width - 1);
	const startY = Math.max(0, y - heightCells + 1);
	if (startX > endX) return null;

	return {
		x: startX * TILE_WIDTH,
		y: startY * TILE_HEIGHT,
		width: (endX - startX + 1) * TILE_WIDTH - 1,
		height: (y - startY + 1) * TILE_HEIGHT - 1,
	};
}

function packLeft(
	fillStart: number,
	fillEnd: number,
	y: number,
	tileWidth: number,
	selectedTool: string,
	grid: Map<string, string>,
	tentative: Set<string>,
): Array<{ x: number; y: number }> {
	const placements: Array<{ x: number; y: number }> = [];
	let x = fillStart;
	while (x <= fillEnd && x + tileWidth - 1 < GRID_WIDTH) {
		if (cellsAvailable(x, y, tileWidth, tentative, selectedTool, grid)) {
			placements.push({ x, y });
			for (let dx = 0; dx < tileWidth; dx++) {
				tentative.add(`${x + dx},${y}`);
			}
			x += tileWidth;
		} else {
			x += 1;
		}
	}
	return placements;
}

function packRight(
	fillStart: number,
	fillEnd: number,
	y: number,
	tileWidth: number,
	selectedTool: string,
	grid: Map<string, string>,
	tentative: Set<string>,
): Array<{ x: number; y: number }> {
	const placements: Array<{ x: number; y: number }> = [];
	let x = Math.min(fillEnd, GRID_WIDTH - tileWidth);
	while (x >= fillStart) {
		if (cellsAvailable(x, y, tileWidth, tentative, selectedTool, grid)) {
			placements.unshift({ x, y });
			for (let dx = 0; dx < tileWidth; dx++) {
				tentative.add(`${x + dx},${y}`);
			}
			x -= tileWidth;
		} else {
			x -= 1;
		}
	}
	return placements;
}

function cellsAvailable(
	x: number,
	y: number,
	tileWidth: number,
	tentative: Set<string>,
	selectedTool: string,
	grid: Map<string, string>,
): boolean {
	if (
		selectedTool === "stairs" ||
		selectedTool === "escalator" ||
		selectedTool === "cinema" ||
		selectedTool === "partyHall" ||
		selectedTool === "recyclingCenter"
	)
		return false;
	if (selectedTool === "lobby" && !isValidLobbyRow(y)) return false;

	const needsSupport = !(selectedTool === "lobby" && isGroundFloor(y));
	const canReplaceFloor = selectedTool !== "floor";
	for (let dx = 0; dx < tileWidth; dx++) {
		const key = `${x + dx},${y}`;
		if (tentative.has(key)) return false;
		if (grid.has(key)) {
			if (canReplaceFloor && grid.get(key) === "floor") {
				// A floor can be upgraded in place.
			} else {
				return false;
			}
		}

		if (needsSupport) {
			// Above-ground tiles rest on the row below; underground tiles hang
			// from the row above (mirrors the server check in commands.ts).
			const supportY = y >= UNDERGROUND_Y ? y - 1 : y + 1;
			const supportKey = `${x + dx},${supportY}`;
			if (
				supportY < 0 ||
				supportY >= GRID_HEIGHT ||
				(!grid.has(supportKey) && !tentative.has(supportKey))
			) {
				return false;
			}
		}
	}
	return true;
}

function isValidLobbyRow(y: number): boolean {
	const floorsAboveGround = GRID_HEIGHT - 1 - UNDERGROUND_FLOORS - y;
	return (
		floorsAboveGround >= 0 &&
		(floorsAboveGround === 0 || floorsAboveGround % 15 === 14)
	);
}

function isGroundFloor(y: number): boolean {
	return GRID_HEIGHT - 1 - UNDERGROUND_FLOORS - y === 0;
}
