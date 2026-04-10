import {
	GRID_HEIGHT,
	GRID_WIDTH,
	TILE_WIDTHS,
	UNDERGROUND_FLOORS,
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

export function computeShiftFill(
	clickX: number,
	clickY: number,
	selectedTool: string,
	lastPlacedAnchor: PlacementAnchor | null,
	grid: Map<string, string>,
): Array<{ x: number; y: number }> {
	if (!lastPlacedAnchor || selectedTool === "empty") return [];
	const { x: lastX, y: lastY, tileType: lastType } = lastPlacedAnchor;
	if (lastType !== selectedTool) return [];

	const tileWidth = TILE_WIDTHS[selectedTool] ?? 1;
	const lastTileWidth = TILE_WIDTHS[lastType] ?? 1;
	const yMin = Math.min(lastY, clickY);
	const yMax = Math.max(lastY, clickY);
	const results: Array<{ x: number; y: number }> = [];

	if (lastX < clickX) {
		const fillEnd = clickX;
		for (let y = yMin; y <= yMax; y++) {
			const fillStart = y === lastY ? lastX + lastTileWidth : lastX;
			if (fillStart > fillEnd) continue;
			results.push(
				...packLeft(fillStart, fillEnd, y, tileWidth, selectedTool, grid),
			);
		}
	} else if (lastX > clickX) {
		const fillStart = clickX;
		for (let y = yMin; y <= yMax; y++) {
			const fillEnd = y === lastY ? lastX - 1 : lastX + lastTileWidth - 1;
			if (fillStart > fillEnd) continue;
			results.push(
				...packRight(fillStart, fillEnd, y, tileWidth, selectedTool, grid),
			);
		}
	}

	return results;
}

export function getHoverBounds(
	x: number,
	y: number,
	selectedTool: string,
): HoverBounds | null {
	if (y < 0 || y >= GRID_HEIGHT) return null;
	if (selectedTool === "lobby" && !isValidLobbyRow(y)) return null;

	const width = selectedTool !== "empty" ? (TILE_WIDTHS[selectedTool] ?? 1) : 1;
	const heightCells = selectedTool === "stairs" ? 2 : 1;
	const startX = Math.max(0, x);
	const endX = Math.min(GRID_WIDTH - 1, x + width - 1);
	const startY = Math.max(0, y - heightCells + 1);
	if (startX > endX) return null;

	return {
		x: startX * TILE_WIDTH + 1,
		y: startY * TILE_HEIGHT + 1,
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
): Array<{ x: number; y: number }> {
	const placements: Array<{ x: number; y: number }> = [];
	const tentative = new Set<string>();
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
): Array<{ x: number; y: number }> {
	const placements: Array<{ x: number; y: number }> = [];
	const tentative = new Set<string>();
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
	if (selectedTool === "stairs") return false;
	if (selectedTool === "lobby" && !isValidLobbyRow(y)) return false;

	const needsSupport = selectedTool !== "lobby";
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
			if (y + 1 >= GRID_HEIGHT || !grid.has(`${x + dx},${y + 1}`)) {
				return false;
			}
		}
	}
	return true;
}

function isValidLobbyRow(y: number): boolean {
	const floorsAboveGround = GRID_HEIGHT - 1 - UNDERGROUND_FLOORS - y;
	return floorsAboveGround >= 0 && floorsAboveGround % 15 === 0;
}
