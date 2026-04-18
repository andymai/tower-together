import Phaser from "phaser";
import { getTowerZoom, setTowerZoom } from "../lib/storage";
import {
	type CarrierCarStateData,
	GRID_HEIGHT,
	GRID_WIDTH,
	type SimStateData,
	TILE_WIDTHS,
	UNDERGROUND_FLOORS,
	UNDERGROUND_Y,
} from "../types";
import { CloudManager } from "./clouds";
import {
	CAR_COLOR,
	COLOR_HOVER,
	COLOR_UNDERGROUND,
	DEFAULT_TICK_INTERVAL_MS,
	ENTITY_STRESS_COLORS,
	LABEL_PANEL_WIDTH,
	MAX_ZOOM,
	MIN_ZOOM,
	TILE_COLORS,
	TILE_HEIGHT,
	TILE_LABEL_COLORS,
	TILE_LABELS,
	TILE_WIDTH,
} from "./gameSceneConstants";
import {
	anchorX,
	computeShiftFill,
	getHoverBounds,
	type PlacementAnchor,
} from "./gameScenePlacement";
import {
	collectElevatorColumnsByFloor,
	getCarBounds,
	getDisplayedCars,
	getQueuedSimLayout,
	getQueuedSimQueueKey,
	isSimAscending,
	type PresentationClock,
	type TimedSnapshot,
} from "./gameSceneTransport";
import { buildOccupancyByCar, isQueuedSim } from "./transportSelectors";

export type CellClickHandler = (x: number, y: number, shift: boolean) => void;
export type CellInspectHandler = (x: number, y: number) => void;

function hashSimVariant(id: string, modulus: number): number {
	let h = 0;
	for (let i = 0; i < id.length; i += 1) {
		h = (h * 31 + id.charCodeAt(i)) | 0;
	}
	return Math.abs(h) % modulus;
}

type RoomTextureConfig = {
	files: string[];
	heightTiles?: number;
};

const ROOM_TEXTURES: Partial<Record<string, RoomTextureConfig>> = {
	office: {
		files: [
			"office.svg",
			"office1.svg",
			"office2.svg",
			"office3.svg",
			"office4.svg",
		],
	},
	condo: { files: ["condo.svg"] },
	restaurant: {
		files: [
			"restaurant0.svg",
			"restaurant1.svg",
			"restaurant2.svg",
			"restaurant3.svg",
			"restaurant4.svg",
		],
	},
	fastFood: {
		files: ["fastFood.svg", "fastFood1.svg", "fastFood2.svg", "fastFood3.svg"],
	},
	retail: { files: ["retail.svg"] },
	hotelSingle: {
		files: ["hotelSingle.svg", "hotelSingle1.svg", "hotelSingle2.svg"],
	},
	hotelTwin: {
		files: ["hotelTwin.svg", "hotelTwin1.svg", "hotelTwin2.svg"],
	},
	hotelSuite: {
		files: ["hotelSuite.svg", "hotelSuite1.svg", "hotelSuite2.svg"],
	},
	cinema: { files: ["cinema.svg"], heightTiles: 2 },
	partyHall: { files: ["partyHall.svg"], heightTiles: 2 },
	recyclingCenterUpper: {
		files: [
			"recyclingCenter0.svg",
			"recyclingCenter1.svg",
			"recyclingCenter2.svg",
			"recyclingCenter3.svg",
			"recyclingCenter4.svg",
		],
		heightTiles: 2,
	},
	parking: { files: ["parking.svg"] },
	security: { files: ["security.svg"] },
	metro: { files: ["metro.svg"] },
	housekeeping: { files: ["housekeeping.svg"] },
	medical: { files: ["medical.svg"] },
};

export class GameScene extends Phaser.Scene {
	private static readonly UNDERGROUND_TEXTURE_KEY = "underground";

	private cellGraphics!: Phaser.GameObjects.Graphics;
	private simGraphics!: Phaser.GameObjects.Graphics;
	private simSprites: Phaser.GameObjects.Sprite[] = [];
	private carGraphicsList: Phaser.GameObjects.Graphics[] = [];
	private undergroundBackground: Phaser.GameObjects.TileSprite | null = null;

	private hoverGraphics!: Phaser.GameObjects.Graphics;
	private cloudManager!: CloudManager;
	private floorLabelBg!: Phaser.GameObjects.Rectangle;
	private floorLabels: Phaser.GameObjects.Text[] = [];
	private tileLabels: Phaser.GameObjects.Text[] = [];
	private carLabels: Phaser.GameObjects.Text[] = [];
	private roomSprites: (
		| Phaser.GameObjects.Sprite
		| Phaser.GameObjects.TileSprite
	)[] = [];
	private roomTexturesLoaded = false;
	private evalActiveFlagMap: Map<string, number> = new Map();
	private unitStatusMap: Map<string, number> = new Map();
	private evalLevelMap: Map<string, number> = new Map();
	private evalScoreMap: Map<string, number> = new Map();
	private evalBadgeLabels: Phaser.GameObjects.Text[] = [];

	// Stores every occupied cell: "x,y" -> tileType (including extension cells)
	private grid: Map<string, string> = new Map();
	// Keys of anchor cells only (used for rendering)
	private anchorSet: Set<string> = new Set();
	// Overlay tiles (e.g. stairs) keyed by "x,y"
	private overlayGrid: Map<string, string> = new Map();
	private previousSimSnapshot: TimedSnapshot<SimStateData> | null = null;
	private currentSimSnapshot: TimedSnapshot<SimStateData> | null = null;
	private previousCarrierSnapshot: TimedSnapshot<CarrierCarStateData> | null =
		null;
	private currentCarrierSnapshot: TimedSnapshot<CarrierCarStateData> | null =
		null;
	private presentationClock: PresentationClock = {
		simTime: 0,
		receivedAtMs: 0,
		tickIntervalMs: DEFAULT_TICK_INTERVAL_MS,
	};

	private hoveredCell: { x: number; y: number } | null = null;
	private selectedTool: string = "floor";
	private onCellClick: CellClickHandler | null = null;
	private onCellInspect: CellInspectHandler | null = null;

	// Pan state
	private isPanning = false;
	private panStartX = 0;
	private panStartY = 0;
	private camStartX = 0;
	private camStartY = 0;

	// Arrow-key pan
	private arrowKeys!: Phaser.Types.Input.Keyboard.CursorKeys;

	// Drag-to-paint state
	private isDragging = false;
	private draggedCells = new Set<string>();

	// Last non-shift placement anchor (for shift-fill)
	private lastPlacedAnchor: PlacementAnchor | null = null;

	// Shift key state (for preview)
	private isShiftHeld = false;

	private towerId: string;

	constructor(towerId: string) {
		super({ key: "GameScene" });
		this.towerId = towerId;
	}

	setOnCellClick(handler: CellClickHandler): void {
		this.onCellClick = handler;
	}

	setOnCellInspect(handler: CellInspectHandler): void {
		this.onCellInspect = handler;
	}

	setSelectedTool(tool: string): void {
		this.selectedTool = tool;
		this.drawHover(); // refresh hover preview width
	}

	setLastPlaced(x: number, y: number, tileType: string): void {
		this.lastPlacedAnchor = { x, y, tileType };
	}

	/** Check whether the cell at (x, y) has an elevator overlay. */
	hasElevatorOverlayAt(x: number, y: number): boolean {
		return this.overlayGrid.get(`${x},${y}`) === "elevator";
	}

	/** Compute shift-fill positions between lastPlacedAnchor and (clickX, clickY).
	 *  Fills every row in the Y range.  Within each row tiles are packed left (if the
	 *  last-placed anchor is to the left of the click) or right (if to the right),
	 *  skipping any already-occupied cells. */
	computeShiftFill(
		clickX: number,
		clickY: number,
	): Array<{ x: number; y: number }> {
		return computeShiftFill(
			clickX,
			clickY,
			this.selectedTool,
			this.lastPlacedAnchor,
			this.grid,
		);
	}

	applyInitState(
		cells: Array<{
			x: number;
			y: number;
			tileType: string;
			isAnchor: boolean;
			isOverlay?: boolean;
			evalActiveFlag?: number;
			unitStatus?: number;
			evalLevel?: number;
			evalScore?: number;
		}>,
		simTime: number,
		sims: SimStateData[] = [],
		carriers: CarrierCarStateData[] = [],
	): void {
		this.grid.clear();
		this.anchorSet.clear();
		this.overlayGrid.clear();
		this.evalActiveFlagMap.clear();
		this.unitStatusMap.clear();
		this.evalLevelMap.clear();
		this.evalScoreMap.clear();
		for (const cell of cells) {
			const key = `${cell.x},${cell.y}`;
			if (cell.isOverlay) {
				if (cell.tileType !== "empty") this.overlayGrid.set(key, cell.tileType);
			} else if (cell.tileType !== "empty") {
				this.grid.set(key, cell.tileType);
				if (cell.isAnchor) this.anchorSet.add(key);
				if (cell.evalActiveFlag !== undefined)
					this.evalActiveFlagMap.set(key, cell.evalActiveFlag);
				if (cell.unitStatus !== undefined)
					this.unitStatusMap.set(key, cell.unitStatus);
				if (cell.evalLevel !== undefined)
					this.evalLevelMap.set(key, cell.evalLevel);
				if (cell.evalScore !== undefined)
					this.evalScoreMap.set(key, cell.evalScore);
			}
		}
		this.previousSimSnapshot = null;
		this.currentSimSnapshot = { simTime, items: sims };
		this.previousCarrierSnapshot = null;
		this.currentCarrierSnapshot = { simTime, items: carriers };
		this.presentationClock = {
			simTime,
			receivedAtMs: performance.now(),
			tickIntervalMs: DEFAULT_TICK_INTERVAL_MS,
		};
		this.drawAllCells();
	}

	applyPatch(
		cells: Array<{
			x: number;
			y: number;
			tileType: string;
			isAnchor: boolean;
			isOverlay?: boolean;
			evalActiveFlag?: number;
			unitStatus?: number;
			evalLevel?: number;
			evalScore?: number;
		}>,
	): void {
		for (const cell of cells) {
			const key = `${cell.x},${cell.y}`;
			if (cell.isOverlay) {
				if (cell.tileType === "empty") {
					this.overlayGrid.delete(key);
				} else {
					this.overlayGrid.set(key, cell.tileType);
				}
			} else if (cell.tileType === "empty") {
				this.grid.delete(key);
				this.anchorSet.delete(key);
				this.evalActiveFlagMap.delete(key);
				this.unitStatusMap.delete(key);
				this.evalLevelMap.delete(key);
				this.evalScoreMap.delete(key);
			} else {
				this.grid.set(key, cell.tileType);
				if (cell.isAnchor) {
					this.anchorSet.add(key);
				} else {
					this.anchorSet.delete(key);
				}
				if (cell.evalActiveFlag !== undefined)
					this.evalActiveFlagMap.set(key, cell.evalActiveFlag);
				if (cell.unitStatus !== undefined)
					this.unitStatusMap.set(key, cell.unitStatus);
				if (cell.evalLevel !== undefined)
					this.evalLevelMap.set(key, cell.evalLevel);
				if (cell.evalScore !== undefined)
					this.evalScoreMap.set(key, cell.evalScore);
			}
		}
		this.drawAllCells();
	}

	applySims(simTime: number, sims: SimStateData[]): void {
		this.previousSimSnapshot = this.currentSimSnapshot;
		this.currentSimSnapshot = { simTime, items: sims };
		this.drawDynamicOverlays();
	}

	applyCarriers(simTime: number, carriers: CarrierCarStateData[]): void {
		this.previousCarrierSnapshot = this.currentCarrierSnapshot;
		this.currentCarrierSnapshot = { simTime, items: carriers };
		this.drawDynamicOverlays();
	}

	setPresentationClock(
		simTime: number,
		receivedAtMs: number,
		tickIntervalMs = DEFAULT_TICK_INTERVAL_MS,
	): void {
		this.presentationClock = {
			simTime,
			receivedAtMs,
			tickIntervalMs:
				tickIntervalMs > 0 ? tickIntervalMs : DEFAULT_TICK_INTERVAL_MS,
		};
	}

	create(): void {
		const totalWidth = GRID_WIDTH * TILE_WIDTH;

		// Restore the previously-saved zoom for this tower, or fit-to-width on first visit.
		const savedZoom = getTowerZoom(this.towerId);
		const initialZoom = Phaser.Math.Clamp(
			savedZoom ?? this.scale.width / totalWidth,
			MIN_ZOOM,
			MAX_ZOOM,
		);
		this.cameras.main.setZoom(initialZoom);
		this.cameras.main.centerOn(
			totalWidth / 2,
			(UNDERGROUND_Y - 8) * TILE_HEIGHT,
		);

		this.cellGraphics = this.add.graphics();
		this.simGraphics = this.add.graphics();
		this.hoverGraphics = this.add.graphics();

		// Depth ordering: sky (0) -> clouds (1) -> cells (2) -> overlays (3-4)
		this.cellGraphics.setDepth(2);
		this.simGraphics.setDepth(3);
		this.hoverGraphics.setDepth(4);

		this.arrowKeys =
			this.input.keyboard?.createCursorKeys() as Phaser.Types.Input.Keyboard.CursorKeys;

		this.drawSky();
		this.loadUndergroundTexture();
		this.drawUndergroundBackground();
		this.drawAllCells();

		this.cloudManager = new CloudManager(this, 1);
		this.cloudManager.loadTextures();

		this.loadRoomTextures();

		this.setupInput();
		this.setupFloorLabels();
	}

	update(_time: number, delta: number): void {
		const cam = this.cameras.main;
		const PAN_SPEED = 6 / cam.zoom;
		if (this.arrowKeys.left.isDown) cam.scrollX -= PAN_SPEED;
		if (this.arrowKeys.right.isDown) cam.scrollX += PAN_SPEED;
		if (this.arrowKeys.up.isDown) cam.scrollY -= PAN_SPEED;
		if (this.arrowKeys.down.isDown) cam.scrollY += PAN_SPEED;

		this.cloudManager.update(delta);
		this.updateFloorLabels();
		this.drawDynamicOverlays();
	}

	private setupFloorLabels(): void {
		// Very tall rectangle so it always covers the full viewport height regardless of camera position
		this.floorLabelBg = this.add.rectangle(
			0,
			0,
			LABEL_PANEL_WIDTH,
			1_000_000,
			0x000000,
			0.55,
		);
		this.floorLabelBg.setOrigin(0, 0.5);
		this.floorLabelBg.setScrollFactor(0, 0);
		this.floorLabelBg.setDepth(10);

		for (let i = 0; i < GRID_HEIGHT; i++) {
			const uiLabel = GRID_HEIGHT - 1 - i - UNDERGROUND_FLOORS;
			const isUnderground = i >= UNDERGROUND_Y;
			const text = this.add.text(
				0,
				i * TILE_HEIGHT + TILE_HEIGHT / 2,
				String(uiLabel),
				{
					fontSize: "11px",
					fontFamily: "Arial, sans-serif",
					fontStyle: "bold",
					color: isUnderground ? "#886644" : "#5588aa",
					align: "center",
					resolution: window.devicePixelRatio * 4,
				},
			);
			text.setScrollFactor(0, 1);
			text.setDepth(11);
			text.setOrigin(0.5, 0.5);
			this.floorLabels.push(text);
		}
	}

	private updateFloorLabels(): void {
		const cam = this.cameras.main;
		const zoom = cam.zoom;
		// Camera pivots zoom around the screen center, so with scrollFactor(0):
		//   screenX = halfW + zoom * (worldX - halfW)
		// Inverse: worldX = halfW + (screenX - halfW) / zoom
		const halfW = this.scale.width / 2;

		// bg.width is in world units; rendered screen width = LABEL_PANEL_WIDTH * zoom (expands when zoomed in)
		this.floorLabelBg.x = halfW * (1 - 1 / zoom);
		this.floorLabelBg.width = LABEL_PANEL_WIDTH;

		// label center in screen space = LABEL_PANEL_WIDTH * zoom / 2
		const labelX = halfW * (1 - 1 / zoom) + LABEL_PANEL_WIDTH / 2;
		for (let i = 0; i < GRID_HEIGHT; i++) {
			const label = this.floorLabels[i];
			if (!label) continue;
			label.setX(labelX);
		}
	}

	private drawSky(): void {
		const skyW = GRID_WIDTH * TILE_WIDTH;
		const skyH = UNDERGROUND_Y * TILE_HEIGHT;

		// Build a 1-pixel-wide vertical gradient on an offscreen canvas.
		const canvas = document.createElement("canvas");
		canvas.width = 1;
		canvas.height = skyH;
		const ctx = canvas.getContext("2d");
		if (!ctx) return;
		const grad = ctx.createLinearGradient(0, 0, 0, skyH);
		grad.addColorStop(0, "#1a3a6e"); // deep blue at top
		grad.addColorStop(0.6, "#5ba8d4"); // mid sky
		grad.addColorStop(1, "#b4ddf0"); // pale horizon
		ctx.fillStyle = grad;
		ctx.fillRect(0, 0, 1, skyH);

		// Create a Phaser texture from the canvas and stretch it across the sky.
		if (this.textures.exists("skyGradient")) {
			this.textures.remove("skyGradient");
		}
		this.textures.addCanvas("skyGradient", canvas);
		const sky = this.add.image(0, 0, "skyGradient");
		sky.setOrigin(0, 0);
		sky.setDisplaySize(skyW, skyH);
		sky.setDepth(0);
	}

	private loadUndergroundTexture(): void {
		if (this.textures.exists(GameScene.UNDERGROUND_TEXTURE_KEY)) return;
		this.load.image(GameScene.UNDERGROUND_TEXTURE_KEY, "/underground2.png");
		this.load.once("complete", () => {
			this.drawUndergroundBackground();
			this.drawAllCells();
		});
		this.load.start();
	}

	private drawUndergroundBackground(): void {
		const backgroundWidth = GRID_WIDTH * TILE_WIDTH;
		const backgroundHeight = (GRID_HEIGHT - UNDERGROUND_Y) * TILE_HEIGHT;
		const backgroundY = UNDERGROUND_Y * TILE_HEIGHT;

		if (!this.textures.exists(GameScene.UNDERGROUND_TEXTURE_KEY)) {
			this.undergroundBackground?.destroy();
			this.undergroundBackground = null;
			return;
		}

		const frame = this.textures.getFrame(GameScene.UNDERGROUND_TEXTURE_KEY);
		if (!frame) return;
		const tileScale = backgroundHeight / frame.height;
		const tileWidth = (frame.width / frame.height) * backgroundHeight;
		const tileScaleX = tileWidth / frame.width;

		if (!this.undergroundBackground) {
			this.undergroundBackground = this.add.tileSprite(
				0,
				backgroundY,
				backgroundWidth,
				backgroundHeight,
				GameScene.UNDERGROUND_TEXTURE_KEY,
			);
			this.undergroundBackground.setOrigin(0, 0);
			this.undergroundBackground.setDepth(1);
		} else {
			this.undergroundBackground.setPosition(0, backgroundY);
			this.undergroundBackground.setSize(backgroundWidth, backgroundHeight);
		}
		this.undergroundBackground.setTileScale(tileScaleX, tileScale);
	}

	private static readonly ROOM_SVG_SCALE = 16;

	/** Tile types that use the for-sale banner instead of for-rent. */
	private static readonly FOR_SALE_TYPES = new Set(["condo"]);

	private getRoomVariantIndex(tileType: string, x: number, y: number): number {
		const config = ROOM_TEXTURES[tileType];
		if (!config || config.files.length <= 1) return 0;
		const normalizedY = tileType === "recyclingCenterLower" ? y - 1 : y;
		return Math.abs((x * 31 + normalizedY * 17) % config.files.length);
	}

	private getRoomTextureKey(
		tileType: string,
		x: number,
		y: number,
	): string | null {
		const config = ROOM_TEXTURES[tileType];
		if (!config) return null;
		return `room_${tileType}_${this.getRoomVariantIndex(tileType, x, y)}`;
	}

	private isRecyclingCenterLowerCovered(x: number, y: number): boolean {
		return this.grid.get(`${x},${y - 1}`) === "recyclingCenterUpper";
	}

	private hasRoomArt(tileType: string, x: number, y: number): boolean {
		if (
			tileType === "recyclingCenterLower" &&
			this.isRecyclingCenterLowerCovered(x, y)
		) {
			const upperKey = this.getRoomTextureKey("recyclingCenterUpper", x, y - 1);
			return upperKey !== null && this.textures.exists(upperKey);
		}

		const textureKey = this.getRoomTextureKey(tileType, x, y);
		return textureKey !== null && this.textures.exists(textureKey);
	}

	private loadRoomTextures(): void {
		const s = GameScene.ROOM_SVG_SCALE;
		for (const [room, config] of Object.entries(ROOM_TEXTURES)) {
			const heightTiles = config?.heightTiles ?? 1;
			for (const [index, file] of config?.files?.entries() ?? []) {
				this.load.svg(`room_${room}_${index}`, `/rooms/${file}`, {
					width: (TILE_WIDTHS[room] ?? 1) * TILE_WIDTH * s,
					height: TILE_HEIGHT * heightTiles * s,
				});
			}
		}
		// Lobby SVG is tiled horizontally across contiguous runs; load at its
		// native 2:1 aspect (one repeat = 2 tiles wide × 1 tile tall).
		this.load.svg("room_lobby", "/rooms/lobby.svg", {
			width: 2 * TILE_HEIGHT * s,
			height: TILE_HEIGHT * s,
		});
		// Stairs / escalator render as a parallelogram bridging the placement
		// floor and 1/3 up the floor above; load at that extended height.
		const bridgeH = (TILE_HEIGHT + TILE_HEIGHT / 3) * s;
		for (const bridge of ["stairs", "escalator"]) {
			this.load.svg(`room_${bridge}`, `/rooms/${bridge}.svg`, {
				width: (TILE_WIDTHS[bridge] ?? 1) * TILE_WIDTH * s,
				height: bridgeH,
			});
		}
		// Stick-figure sprites for queued sims. Low stress has 4 skin-tone
		// variants; medium/high tint the entire figure. Rasterized extra-hi-res
		// (viewBox 6×20) so the sprite stays crisp even at MAX_ZOOM.
		const simScale = 32;
		for (const level of ["low-0", "low-1", "low-2", "low-3"] as const) {
			this.load.svg(`sim_figure_${level}`, `/rooms/sim-${level}.svg`, {
				width: 6 * simScale,
				height: 20 * simScale,
			});
		}
		for (const level of ["medium", "high"] as const) {
			this.load.svg(`sim_figure_${level}`, `/rooms/sim-${level}.svg`, {
				width: 6 * simScale,
				height: 20 * simScale,
			});
		}
		// Banner SVGs share the same 9:4 aspect ratio.
		// Load at high resolution for crisp rendering when zoomed in.
		const bannerW = 180 * 4;
		const bannerH = 80 * 4;
		this.load.svg("for_rent", "/rooms/for-rent.svg", {
			width: bannerW,
			height: bannerH,
		});
		this.load.svg("for_sale", "/rooms/for-sale.svg", {
			width: bannerW,
			height: bannerH,
		});
		this.load.once("complete", () => {
			this.roomTexturesLoaded = true;
			this.drawAllCells();
		});
		this.load.start();
	}

	private clearRoomSprites(): void {
		for (const sprite of this.roomSprites) sprite.destroy();
		this.roomSprites = [];
	}

	private drawAllCells(): void {
		const g = this.cellGraphics;
		g.clear();
		this.clearTileLabels();
		this.clearRoomSprites();
		for (const lbl of this.evalBadgeLabels) lbl.destroy();
		this.evalBadgeLabels = [];

		if (!this.undergroundBackground) {
			g.fillStyle(COLOR_UNDERGROUND, 1);
			g.fillRect(
				0,
				UNDERGROUND_Y * TILE_HEIGHT,
				GRID_WIDTH * TILE_WIDTH,
				(GRID_HEIGHT - UNDERGROUND_Y) * TILE_HEIGHT,
			);
		}

		// Tile types that should be merged into contiguous runs per row.
		const MERGE_TYPES = new Set(["floor", "lobby"]);

		// Draw non-merge anchor tiles (hotel tiles etc.) individually.
		for (const key of this.anchorSet) {
			const tileType = this.grid.get(key);
			if (!tileType || MERGE_TYPES.has(tileType)) continue;

			const [x, y] = key.split(",").map(Number);
			const w = TILE_WIDTHS[tileType] ?? 1;

			if (
				tileType === "recyclingCenterLower" &&
				this.roomTexturesLoaded &&
				this.hasRoomArt(tileType, x, y)
			) {
				continue;
			}

			const texKey = this.getRoomTextureKey(tileType, x, y);
			const heightTiles = ROOM_TEXTURES[tileType]?.heightTiles ?? 1;
			if (
				this.roomTexturesLoaded &&
				texKey !== null &&
				this.textures.exists(texKey)
			) {
				const sprite = this.add.sprite(
					x * TILE_WIDTH + 1,
					y * TILE_HEIGHT + 1,
					texKey,
				);
				sprite.setOrigin(0, 0);
				sprite.setDisplaySize(
					w * TILE_WIDTH - 1,
					heightTiles * TILE_HEIGHT - 1,
				);
				sprite.setDepth(1.5);
				this.roomSprites.push(sprite);
			} else {
				const color = TILE_COLORS[tileType];
				if (!color) continue;
				g.fillStyle(color, 1);
				g.fillRect(
					x * TILE_WIDTH + 1,
					y * TILE_HEIGHT + 1,
					w * TILE_WIDTH - 1,
					TILE_HEIGHT - 1,
				);
			}

			// "For Rent" / "For Sale" banner on inactive facilities
			const evalFlag = this.evalActiveFlagMap.get(key);
			const unitStatus = this.unitStatusMap.get(key);
			const isHotel =
				tileType === "hotelSingle" ||
				tileType === "hotelTwin" ||
				tileType === "hotelSuite";
			let showInactiveBanner: boolean;
			if (tileType === "office") {
				showInactiveBanner = (unitStatus ?? 0) > 0x0f;
			} else if (isHotel) {
				showInactiveBanner = (unitStatus ?? 0) >= 0x18;
			} else if (tileType === "condo") {
				showInactiveBanner = (unitStatus ?? 0) > 0x17;
			} else {
				showInactiveBanner = evalFlag === 0;
			}
			if (this.roomTexturesLoaded && showInactiveBanner) {
				const bannerKey = GameScene.FOR_SALE_TYPES.has(tileType)
					? "for_sale"
					: "for_rent";
				if (this.textures.exists(bannerKey)) {
					const tileW = w * TILE_WIDTH - 1;
					const tileH = TILE_HEIGHT - 1;
					// Fit banner inside tile without stretching (9:4 aspect ratio)
					const bannerAspect = 9 / 4;
					const tileAspect = tileW / tileH;
					let bw: number;
					let bh: number;
					if (tileAspect > bannerAspect) {
						bh = tileH;
						bw = tileH * bannerAspect;
					} else {
						bw = tileW;
						bh = tileW / bannerAspect;
					}
					const banner = this.add.sprite(
						x * TILE_WIDTH + 1 + (tileW - bw) / 2,
						y * TILE_HEIGHT + 1 + (tileH - bh) / 2,
						bannerKey,
					);
					banner.setOrigin(0, 0);
					banner.setDisplaySize(bw, bh);
					banner.setDepth(1.75);
					banner.texture.setFilter(Phaser.Textures.FilterMode.LINEAR);
					this.roomSprites.push(banner);
				}
			}

			// Eval score pill badge (blue=A, yellow=B, red=C)
			const evalLevel = this.evalLevelMap.get(key);
			const evalScore = this.evalScoreMap.get(key);
			if (
				evalLevel !== undefined &&
				evalLevel <= 2 &&
				evalScore !== undefined &&
				evalScore >= 0
			) {
				const badgeColor =
					evalLevel === 2 ? 0x4488ff : evalLevel === 1 ? 0xddcc00 : 0xdd3333;
				const scoreLabel = String(evalScore);
				const pillH = TILE_HEIGHT * 0.55;
				const pillW = Math.max(pillH * 1.4, pillH * 0.8 * scoreLabel.length);
				const pillR = pillH / 2;
				const px = x * TILE_WIDTH + 2;
				const py = y * TILE_HEIGHT + 1 + (TILE_HEIGHT - 1 - pillH) / 2;
				g.fillStyle(badgeColor, 1);
				g.fillRoundedRect(px, py, pillW, pillH, pillR);
				const label = this.add.text(
					px + pillW / 2,
					py + pillH / 2,
					scoreLabel,
					{
						fontSize: `${Math.round(pillH * 0.75)}px`,
						fontFamily: "Arial, sans-serif",
						fontStyle: "bold",
						color: "#ffffff",
						resolution: window.devicePixelRatio * 4,
					},
				);
				label.setOrigin(0.5, 0.5);
				label.setDepth(5);
				this.evalBadgeLabels.push(label);
			}
		}

		// Draw floor/lobby as merged runs per row.
		for (let y = 0; y < GRID_HEIGHT; y++) {
			let runStart = -1;
			let runType: string | null = null;
			for (let x = 0; x <= GRID_WIDTH; x++) {
				const cellType =
					x < GRID_WIDTH ? (this.grid.get(`${x},${y}`) ?? null) : null;
				const isMerge = cellType !== null && MERGE_TYPES.has(cellType);
				if (isMerge && cellType === runType) {
					// extend current run
				} else {
					if (runStart !== -1 && runType !== null) {
						const texKey = `room_${runType}`;
						const runPxX = runStart * TILE_WIDTH + 1;
						const runPxY = y * TILE_HEIGHT + 1;
						const runPxW = (x - runStart) * TILE_WIDTH - 1;
						const runPxH = TILE_HEIGHT - 1;
						if (
							this.roomTexturesLoaded &&
							this.textures.exists(texKey) &&
							runType === "lobby"
						) {
							const tex = this.textures.get(texKey).getSourceImage();
							const tileSprite = this.add.tileSprite(
								runPxX,
								runPxY,
								runPxW,
								runPxH,
								texKey,
							);
							tileSprite.setOrigin(0, 0);
							// One SVG repeat spans 2*TILE_HEIGHT screen px (native 2:1 aspect).
							tileSprite.tileScaleX = (2 * TILE_HEIGHT) / tex.width;
							tileSprite.tileScaleY = TILE_HEIGHT / tex.height;
							tileSprite.setDepth(1.5);
							this.roomSprites.push(tileSprite);
						} else {
							const color = TILE_COLORS[runType];
							if (color) {
								g.fillStyle(color, 1);
								g.fillRect(runPxX, runPxY, runPxW, runPxH);
							}
						}
					}
					runStart = isMerge ? x : -1;
					runType = isMerge ? cellType : null;
				}
			}
		}

		// Draw overlay tiles on top of base tiles.
		const shaftRows = new Map<string, number[]>();
		for (const [key, type] of this.overlayGrid) {
			const [x, y] = key.split(",").map(Number);
			if (type === "stairs" || type === "escalator") {
				this.drawBridgeOverlay(g, type, x, y);
			} else {
				const shaftKey = `${type}:${x}`;
				const rows = shaftRows.get(shaftKey);
				if (rows) {
					rows.push(y);
				} else {
					shaftRows.set(shaftKey, [y]);
				}
			}
		}

		for (const [shaftKey, rows] of shaftRows) {
			const [type, xText] = shaftKey.split(":");
			const x = Number(xText);
			const width = TILE_WIDTHS[type] ?? 1;
			g.lineStyle(2, 0x222222, 1.0);
			const sortedRows = rows.slice().sort((a, b) => a - b);
			let runStart = sortedRows[0];
			let previousRow = sortedRows[0];
			for (let i = 1; i < sortedRows.length; i++) {
				const row = sortedRows[i];
				if (row === previousRow + 1) {
					previousRow = row;
					continue;
				}
				g.strokeRect(
					x * TILE_WIDTH + 1,
					runStart * TILE_HEIGHT + 1,
					width * TILE_WIDTH - 2,
					(previousRow - runStart + 1) * TILE_HEIGHT - 2,
				);
				runStart = row;
				previousRow = row;
			}
			g.strokeRect(
				x * TILE_WIDTH + 1,
				runStart * TILE_HEIGHT + 1,
				width * TILE_WIDTH - 2,
				(previousRow - runStart + 1) * TILE_HEIGHT - 2,
			);
		}

		this.drawTileLabels();
		this.drawDynamicOverlays();
	}

	private drawDynamicOverlays(): void {
		this.drawSims();
		this.drawCars();
	}

	private clearTileLabels(): void {
		for (const label of this.tileLabels) label.destroy();
		this.tileLabels = [];
	}

	private clearCarLabels(): void {
		for (const label of this.carLabels) label.destroy();
		this.carLabels = [];
	}

	private drawTileLabels(): void {
		for (const key of this.anchorSet) {
			const tileType = this.grid.get(key);
			if (!tileType) continue;

			const labelText = TILE_LABELS[tileType];
			if (!labelText) continue;
			const [x, y] = key.split(",").map(Number);
			if (this.roomTexturesLoaded && this.hasRoomArt(tileType, x, y)) continue;

			const width = TILE_WIDTHS[tileType] ?? 1;
			const label = this.add.text(
				(x + width / 2) * TILE_WIDTH,
				(y + 0.5) * TILE_HEIGHT,
				labelText,
				{
					fontSize: "11px",
					fontFamily: "Arial, sans-serif",
					fontStyle: "bold",
					color: TILE_LABEL_COLORS[tileType] ?? "#ffffff",
					resolution: window.devicePixelRatio * 4,
				},
			);
			label.setOrigin(0.5, 0.5);
			label.setDepth(5);
			this.tileLabels.push(label);
		}
	}

	private drawSims(): void {
		const g = this.simGraphics;
		g.clear();
		const queueIndices = new Map<string, number>();
		const elevatorColumnsByFloor = collectElevatorColumnsByFloor(
			this.overlayGrid,
		);
		const simSnapshot = this.currentSimSnapshot ??
			this.previousSimSnapshot ?? { simTime: 0, items: [] };
		const hasTexture =
			this.roomTexturesLoaded && this.textures.exists("sim_figure_low-0");
		// Aspect matches the SVG viewBox (6×20) so the figure isn't stretched.
		const simWidthPx = 0.75 * TILE_WIDTH;
		const simHeightPx = simWidthPx * (20 / 6);

		let usedCount = 0;
		for (const sim of simSnapshot.items) {
			if (!isQueuedSim(sim)) continue;
			const queueKey = getQueuedSimQueueKey(sim, elevatorColumnsByFloor);
			const queueIndex = queueIndices.get(queueKey) ?? 0;
			queueIndices.set(queueKey, queueIndex + 1);
			const { gridX, gridY } = getQueuedSimLayout(
				sim,
				elevatorColumnsByFloor,
				queueIndex,
			);
			const px = gridX * TILE_WIDTH;
			const py = (gridY + 0.5) * TILE_HEIGHT;
			const textureKey =
				sim.stressLevel === "low"
					? `sim_figure_low-${hashSimVariant(sim.id, 4)}`
					: `sim_figure_${sim.stressLevel}`;

			if (hasTexture) {
				let sprite = this.simSprites[usedCount];
				if (!sprite) {
					sprite = this.add.sprite(0, 0, textureKey);
					sprite.setOrigin(0.5, 1);
					sprite.setDepth(3);
					sprite.texture.setFilter(Phaser.Textures.FilterMode.LINEAR);
					this.simSprites.push(sprite);
				} else if (sprite.texture.key !== textureKey) {
					sprite.setTexture(textureKey);
					sprite.texture.setFilter(Phaser.Textures.FilterMode.LINEAR);
				}
				sprite.setVisible(true);
				sprite.setPosition(px, py);
				sprite.setDisplaySize(simWidthPx, simHeightPx);
				sprite.setFlipX(!isSimAscending(sim));
				usedCount += 1;
			} else {
				const color = ENTITY_STRESS_COLORS[sim.stressLevel] ?? 0x111111;
				g.fillStyle(color, 1);
				g.fillRect(
					px - simWidthPx / 2,
					py - simHeightPx,
					simWidthPx,
					simHeightPx,
				);
			}
		}

		for (let i = usedCount; i < this.simSprites.length; i += 1) {
			this.simSprites[i]?.setVisible(false);
		}
	}

	private drawCars(): void {
		for (const g of this.carGraphicsList) g.destroy();
		this.carGraphicsList = [];
		this.clearCarLabels();
		const simSnapshot = this.currentSimSnapshot ??
			this.previousSimSnapshot ?? { simTime: 0, items: [] };
		const occupancyByCar = buildOccupancyByCar(simSnapshot.items);

		let carIndex = 0;
		for (const car of getDisplayedCars(
			this.currentCarrierSnapshot,
			this.previousCarrierSnapshot,
			this.presentationClock,
		)) {
			const { x, y, width, height } = getCarBounds(car);
			const occupancy =
				occupancyByCar.get(`${car.carrierId}:${car.carIndex}`) ?? 0;

			// Each car (rect + label) gets a unique depth slice so cars never
			// interleave with other cars' labels.
			const depth = 3 + carIndex * 0.01;
			const g = this.add.graphics();
			g.setDepth(depth);
			g.fillStyle(CAR_COLOR, 1);
			g.fillRect(x, y, width, height);
			g.lineStyle(1, 0x6b5a1b, 1);
			g.strokeRect(x, y, width, height);
			this.carGraphicsList.push(g);
			this.drawCarOccupancyLabel(x, y, width, height, occupancy, depth);
			carIndex += 1;
		}
	}

	private drawCarOccupancyLabel(
		x: number,
		y: number,
		width: number,
		height: number,
		occupancy: number,
		depth: number,
	): void {
		const label = this.add.text(
			x + width / 2,
			y + height / 2,
			String(occupancy),
			{
				fontSize: "8px",
				fontFamily: "Arial, sans-serif",
				fontStyle: "bold",
				color: "#3b2d00",
				resolution: window.devicePixelRatio * 4,
			},
		);
		label.setOrigin(0.5, 0.5);
		label.setDepth(depth + 0.005);
		this.carLabels.push(label);
	}

	/** Draw a stairs or escalator overlay bridging the floor at (gx,gy) and
	 *  the floor above (gy-1). Rendered as an SVG sprite whose transparent
	 *  regions leave the underlying cells visible; the asset's parallelogram
	 *  fills its viewBox, matching the bridge's bounding box exactly. Falls
	 *  back to a filled parallelogram if the texture is not yet loaded. */
	private drawBridgeOverlay(
		g: Phaser.GameObjects.Graphics,
		type: "stairs" | "escalator",
		gx: number,
		gy: number,
	): void {
		const width = TILE_WIDTHS[type] ?? 1;
		const cellW = TILE_WIDTH * width;
		const startX = gx * TILE_WIDTH;
		const bottomY = (gy + 1) * TILE_HEIGHT;
		const topY = gy * TILE_HEIGHT - TILE_HEIGHT / 3;
		const heightPx = bottomY - topY;

		const texKey = `room_${type}`;
		if (this.roomTexturesLoaded && this.textures.exists(texKey)) {
			const sprite = this.add.sprite(startX, topY, texKey);
			sprite.setOrigin(0, 0);
			sprite.setDisplaySize(cellW, heightPx);
			sprite.setDepth(1.75);
			sprite.texture.setFilter(Phaser.Textures.FilterMode.LINEAR);
			this.roomSprites.push(sprite);
			return;
		}

		// Fallback: filled parallelogram matching the SVG's internal shape.
		const edgeW = cellW / 6;
		g.fillStyle(0xffffff, 1);
		g.beginPath();
		g.moveTo(startX, bottomY);
		g.lineTo(startX + edgeW, bottomY);
		g.lineTo(startX + cellW, topY);
		g.lineTo(startX + cellW - edgeW, topY);
		g.closePath();
		g.fillPath();
	}

	private drawHover(): void {
		const g = this.hoverGraphics;
		if (!g) return;
		g.clear();
		if (!this.hoveredCell) return;

		if (
			this.isShiftHeld &&
			this.lastPlacedAnchor &&
			this.selectedTool !== "empty"
		) {
			this.drawShiftPreview();
			return;
		}

		const { x, y } = this.hoveredCell;
		const hoverBounds = getHoverBounds(x, y, this.selectedTool);
		if (!hoverBounds) return;

		g.fillStyle(COLOR_HOVER, 0.2);
		g.lineStyle(1, COLOR_HOVER, 0.9);
		g.fillRect(
			hoverBounds.x,
			hoverBounds.y,
			hoverBounds.width,
			hoverBounds.height,
		);
		g.strokeRect(
			hoverBounds.x,
			hoverBounds.y,
			hoverBounds.width,
			hoverBounds.height,
		);
	}

	private drawShiftPreview(): void {
		if (!this.hoveredCell) return;
		const g = this.hoverGraphics;
		const ax = anchorX(this.hoveredCell.x, this.selectedTool);
		const fills = this.computeShiftFill(ax, this.hoveredCell.y);
		if (fills.length === 0) return;

		const tileWidth = TILE_WIDTHS[this.selectedTool] ?? 1;
		const pw = tileWidth * TILE_WIDTH - 1;
		const ph = TILE_HEIGHT - 1;

		g.fillStyle(COLOR_HOVER, 0.12);
		g.lineStyle(1, COLOR_HOVER, 0.75);
		for (const { x, y } of fills) {
			const px = x * TILE_WIDTH + 1;
			const py = y * TILE_HEIGHT + 1;
			g.fillRect(px, py, pw, ph);
			g.strokeRect(px, py, pw, ph);
		}
	}

	private worldToCell(wx: number, wy: number): { x: number; y: number } {
		return {
			x: Math.floor(wx / TILE_WIDTH),
			y: Math.floor(wy / TILE_HEIGHT),
		};
	}

	private setupInput(): void {
		const cam = this.cameras.main;

		this.input.on("pointermove", (pointer: Phaser.Input.Pointer) => {
			const cell = this.worldToCell(pointer.worldX, pointer.worldY);
			const shift = !!(pointer.event as MouseEvent).shiftKey;

			const cellChanged =
				cell.x !== this.hoveredCell?.x || cell.y !== this.hoveredCell?.y;
			const shiftChanged = shift !== this.isShiftHeld;
			this.hoveredCell = cell;
			this.isShiftHeld = shift;
			if (cellChanged || shiftChanged) this.drawHover();

			if (this.isPanning) {
				const dx = pointer.x - this.panStartX;
				const dy = pointer.y - this.panStartY;
				cam.setScroll(
					this.camStartX - dx / cam.zoom,
					this.camStartY - dy / cam.zoom,
				);
			} else if (this.isDragging && pointer.leftButtonDown()) {
				const cellKey = `${cell.x},${cell.y}`;
				if (
					!this.draggedCells.has(cellKey) &&
					cell.x >= 0 &&
					cell.x < GRID_WIDTH &&
					cell.y >= 0 &&
					cell.y < GRID_HEIGHT
				) {
					this.draggedCells.add(cellKey);
					const ax = anchorX(cell.x, this.selectedTool);
					this.onCellClick?.(ax, cell.y, false);
				}
			}
		});

		this.input.on("pointerdown", (pointer: Phaser.Input.Pointer) => {
			if (pointer.rightButtonDown()) {
				const cell = this.worldToCell(pointer.worldX, pointer.worldY);
				if (
					cell.x >= 0 &&
					cell.x < GRID_WIDTH &&
					cell.y >= 0 &&
					cell.y < GRID_HEIGHT
				) {
					this.onCellInspect?.(cell.x, cell.y);
				}
				return;
			}
			if (pointer.middleButtonDown()) {
				this.isPanning = true;
				this.panStartX = pointer.x;
				this.panStartY = pointer.y;
				this.camStartX = cam.scrollX;
				this.camStartY = cam.scrollY;
				return;
			}

			if (pointer.leftButtonDown()) {
				const cell = this.worldToCell(pointer.worldX, pointer.worldY);
				if (
					cell.x < 0 ||
					cell.x >= GRID_WIDTH ||
					cell.y < 0 ||
					cell.y >= GRID_HEIGHT
				)
					return;
				this.isDragging = true;
				this.draggedCells.clear();
				this.draggedCells.add(`${cell.x},${cell.y}`);
				const shift = !!(pointer.event as MouseEvent).shiftKey;
				const ax = anchorX(cell.x, this.selectedTool);
				this.onCellClick?.(ax, cell.y, shift);
			}
		});

		this.input.on("pointerup", (pointer: Phaser.Input.Pointer) => {
			if (!pointer.middleButtonDown() && !pointer.rightButtonDown()) {
				this.isPanning = false;
			}
			this.isDragging = false;
		});

		this.input.on(
			"wheel",
			(
				p: Phaser.Input.Pointer,
				_o: unknown[],
				deltaX: number,
				deltaY: number,
			) => {
				const wheelEvent = p.event as WheelEvent;
				if (wheelEvent.ctrlKey || wheelEvent.shiftKey) {
					// Pinch or shift-modified trackpad scroll -> zoom around mouse position.
					// Use Phaser's camera transform helpers instead of duplicating the math,
					// so the anchor remains stable with RESIZE scaling and centered cameras.
					const oldZoom = cam.zoom;
					const newZoom = Phaser.Math.Clamp(
						oldZoom * (deltaY > 0 ? 0.9 : 1.1),
						MIN_ZOOM,
						MAX_ZOOM,
					);
					if (newZoom === oldZoom) return;
					cam.preRender();
					const worldPointBefore = cam.getWorldPoint(p.x, p.y);
					cam.setZoom(newZoom);
					cam.preRender();
					const worldPointAfter = cam.getWorldPoint(p.x, p.y);
					cam.scrollX += worldPointBefore.x - worldPointAfter.x;
					cam.scrollY += worldPointBefore.y - worldPointAfter.y;
					cam.preRender();
					setTowerZoom(this.towerId, newZoom);
				} else {
					// Two-finger scroll -> pan
					cam.scrollX += deltaX / cam.zoom;
					cam.scrollY += deltaY / cam.zoom;
				}
			},
		);

		this.game.canvas.addEventListener("contextmenu", (e) => e.preventDefault());

		// Redraw hover when shift is pressed/released without moving the mouse
		this.input.keyboard?.on("keydown-SHIFT", () => {
			this.isShiftHeld = true;
			this.drawHover();
		});
		this.input.keyboard?.on("keyup-SHIFT", () => {
			this.isShiftHeld = false;
			this.drawHover();
		});
	}
}
