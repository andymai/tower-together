const PLAYER_ID_KEY = "tower_together_player_id";
const DISPLAY_NAME_KEY = "tower_together_display_name";
const RECENT_TOWERS_KEY = "tower_together_recent_towers";
const TOWER_VIEW_KEY_PREFIX = "tower_together_view_";
const TOWER_TOOLBAR_KEY_PREFIX = "tower_together_toolbar_";

export function getPlayerId(): string | null {
	return localStorage.getItem(PLAYER_ID_KEY);
}

export function getDisplayName(): string | null {
	return localStorage.getItem(DISPLAY_NAME_KEY);
}

export function savePlayer(playerId: string, displayName: string): void {
	localStorage.setItem(PLAYER_ID_KEY, playerId);
	localStorage.setItem(DISPLAY_NAME_KEY, displayName);
}

export function clearPlayer(): void {
	localStorage.removeItem(PLAYER_ID_KEY);
	localStorage.removeItem(DISPLAY_NAME_KEY);
}

export function getRecentTowers(): string[] {
	try {
		const raw = localStorage.getItem(RECENT_TOWERS_KEY);
		if (!raw) return [];
		return JSON.parse(raw) as string[];
	} catch {
		return [];
	}
}

export function addRecentTower(towerId: string): void {
	const existing = getRecentTowers();
	const updated = [towerId, ...existing.filter((id) => id !== towerId)].slice(
		0,
		5,
	);
	localStorage.setItem(RECENT_TOWERS_KEY, JSON.stringify(updated));
}

interface TowerView {
	zoom?: number;
	scrollX?: number;
	scrollY?: number;
	minimapCollapsed?: boolean;
	/** Viewport pixel coords for the top-left of the minimap panel. */
	minimapPos?: { x: number; y: number };
	/** Which minimap tab is active: silhouette ("edit") or eval-colored ("eval"). */
	minimapTab?: "edit" | "eval";
}

export function getTowerView(towerId: string): TowerView {
	try {
		const raw = localStorage.getItem(`${TOWER_VIEW_KEY_PREFIX}${towerId}`);
		if (!raw) return {};
		return JSON.parse(raw) as TowerView;
	} catch {
		return {};
	}
}

export function setTowerView(towerId: string, patch: TowerView): void {
	try {
		const existing = getTowerView(towerId);
		localStorage.setItem(
			`${TOWER_VIEW_KEY_PREFIX}${towerId}`,
			JSON.stringify({ ...existing, ...patch }),
		);
	} catch {
		// storage unavailable — silently ignore
	}
}

export interface TowerToolbarCache {
	towerName?: string;
	starCount?: number;
	cash?: number;
	population?: number;
}

export function getTowerToolbarCache(towerId: string): TowerToolbarCache {
	try {
		const raw = localStorage.getItem(`${TOWER_TOOLBAR_KEY_PREFIX}${towerId}`);
		if (!raw) return {};
		return JSON.parse(raw) as TowerToolbarCache;
	} catch {
		return {};
	}
}

export function setTowerToolbarCache(
	towerId: string,
	patch: TowerToolbarCache,
): void {
	try {
		const existing = getTowerToolbarCache(towerId);
		localStorage.setItem(
			`${TOWER_TOOLBAR_KEY_PREFIX}${towerId}`,
			JSON.stringify({ ...existing, ...patch }),
		);
	} catch {
		// storage unavailable — silently ignore
	}
}

export function generateUUID(): string {
	if (typeof crypto !== "undefined" && crypto.randomUUID) {
		return crypto.randomUUID();
	}
	// Fallback
	return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
		const r = (Math.random() * 16) | 0;
		const v = c === "x" ? r : (r & 0x3) | 0x8;
		return v.toString(16);
	});
}
