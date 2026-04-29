import { useCallback, useEffect, useRef, useState } from "react";
import type { GameScene } from "../game/GameScene";
import { TILE_HEIGHT, TILE_WIDTH } from "../game/gameSceneConstants";
import { getTowerView, setTowerView } from "../lib/storage";
import { GRID_HEIGHT, GRID_WIDTH, UNDERGROUND_Y } from "../types";

const MINIMAP_WIDTH = 130;
// Match world aspect so the minimap is a true scale-down of the canvas
// (sx === sy, building proportions match what the user sees in-game).
const MINIMAP_HEIGHT = Math.round(
	(MINIMAP_WIDTH * GRID_HEIGHT * TILE_HEIGHT) / (GRID_WIDTH * TILE_WIDTH),
);
const PADDING = 8;
const PIXEL_RATIO = window.devicePixelRatio || 1;

const MINIMAP_SKY_FILL = "#243c5c";
const MINIMAP_UNDERGROUND_FILL = "#3a2a18";

interface Props {
	towerId: string;
	sceneRef: React.MutableRefObject<GameScene | null>;
	sceneReady: boolean;
}

type MinimapTab = "edit" | "eval";

const TAB_LABELS: Record<MinimapTab, string> = { edit: "Edit", eval: "Eval" };
const TAB_IDS: readonly MinimapTab[] = ["edit", "eval"];

const FALLBACK_FILL = "#9aa8b8";
const EVAL_TAB_COLORS: Record<number, string> = {
	0: "#dd3333", // Terrible — red
	1: "#dd9b00", // Good — yellow/amber
	2: "#4488ff", // Excellent — blue
};

function cellFill(tab: MinimapTab, evalLevel: number | undefined): string {
	if (tab !== "eval" || evalLevel === undefined) return FALLBACK_FILL;
	return EVAL_TAB_COLORS[evalLevel] ?? FALLBACK_FILL;
}

export function Minimap({ towerId, sceneRef, sceneReady }: Props) {
	const [collapsed, setCollapsed] = useState<boolean>(
		() => getTowerView(towerId).minimapCollapsed === true,
	);
	const [pos, setPos] = useState<{ x: number; y: number } | null>(
		() => getTowerView(towerId).minimapPos ?? null,
	);
	const [activeTab, setActiveTab] = useState<MinimapTab>(
		() => getTowerView(towerId).minimapTab ?? "edit",
	);
	const setActiveTabPersisted = useCallback(
		(tab: MinimapTab) => {
			setActiveTab(tab);
			setTowerView(towerId, { minimapTab: tab });
		},
		[towerId],
	);
	const canvasRef = useRef<HTMLCanvasElement | null>(null);
	const panelRef = useRef<HTMLDivElement | null>(null);
	const lastCellRevisionRef = useRef<number>(-1);
	const lastViewSigRef = useRef<string>("");
	const draggingRef = useRef<boolean>(false);
	const panDragRef = useRef<{
		pointerId: number;
		offsetX: number;
		offsetY: number;
	} | null>(null);

	const clampPos = useCallback((x: number, y: number) => {
		const panel = panelRef.current;
		const w = panel?.offsetWidth ?? MINIMAP_WIDTH + 16;
		const h = panel?.offsetHeight ?? MINIMAP_HEIGHT + 40;
		const maxX = Math.max(0, window.innerWidth - w);
		const maxY = Math.max(0, window.innerHeight - h);
		return {
			x: Math.max(0, Math.min(maxX, x)),
			y: Math.max(0, Math.min(maxY, y)),
		};
	}, []);

	const toggleCollapsed = useCallback(() => {
		setCollapsed((prev) => {
			const next = !prev;
			setTowerView(towerId, { minimapCollapsed: next });
			return next;
		});
		// Re-clamp after layout: collapsed is title-bar-only, expanded adds
		// tabs + canvas, so offsetHeight changes by an order of magnitude.
		requestAnimationFrame(() => {
			setPos((current) => (current ? clampPos(current.x, current.y) : current));
		});
	}, [towerId, clampPos]);

	const handlePanelPointerDown = useCallback(
		(event: React.PointerEvent<HTMLDivElement>) => {
			const target = event.target as HTMLElement;
			if (target.closest("button") || target.closest("canvas")) return;
			const panel = panelRef.current;
			if (!panel) return;
			const rect = panel.getBoundingClientRect();
			(event.currentTarget as Element).setPointerCapture(event.pointerId);
			panDragRef.current = {
				pointerId: event.pointerId,
				offsetX: event.clientX - rect.left,
				offsetY: event.clientY - rect.top,
			};
			// Materialize the bottom-left default into an absolute position
			// so subsequent moves animate from the current screen rect.
			setPos(clampPos(rect.left, rect.top));
		},
		[clampPos],
	);

	const handlePanelPointerMove = useCallback(
		(event: React.PointerEvent<HTMLDivElement>) => {
			const drag = panDragRef.current;
			if (!drag) return;
			setPos(
				clampPos(event.clientX - drag.offsetX, event.clientY - drag.offsetY),
			);
		},
		[clampPos],
	);

	const handlePanelPointerUp = useCallback(
		(event: React.PointerEvent<HTMLDivElement>) => {
			const drag = panDragRef.current;
			if (!drag) return;
			panDragRef.current = null;
			(event.currentTarget as Element).releasePointerCapture(drag.pointerId);
			setPos((current) => {
				if (current) setTowerView(towerId, { minimapPos: current });
				return current;
			});
		},
		[towerId],
	);

	useEffect(() => {
		const onResize = () => {
			setPos((current) => (current ? clampPos(current.x, current.y) : current));
		};
		window.addEventListener("resize", onResize);
		return () => window.removeEventListener("resize", onResize);
	}, [clampPos]);

	const renderMinimap = useCallback(() => {
		const canvas = canvasRef.current;
		const scene = sceneRef.current;
		if (!canvas || !scene) return;

		const view = scene.getCameraView();
		if (!view.ready) return;

		// Keep backing buffer in sync with CSS dims. Required because module
		// constants (MINIMAP_HEIGHT, PIXEL_RATIO) can change via hot reload or
		// monitor swap without re-firing the mount-time useEffect — a stale
		// buffer makes the browser stretch-compress every drawn coordinate.
		// Steady-state is a no-op; the inequality guards prevent flicker.
		const expectedW = MINIMAP_WIDTH * PIXEL_RATIO;
		const expectedH = MINIMAP_HEIGHT * PIXEL_RATIO;
		let bufferResized = false;
		if (canvas.width !== expectedW) {
			canvas.width = expectedW;
			bufferResized = true;
		}
		if (canvas.height !== expectedH) {
			canvas.height = expectedH;
			bufferResized = true;
		}

		const cellRev = scene.getCellRevision();
		const viewSig = `${view.scrollX}|${view.scrollY}|${view.zoom}|${view.viewWidth}|${view.viewHeight}|${activeTab}`;
		if (
			!bufferResized &&
			cellRev === lastCellRevisionRef.current &&
			viewSig === lastViewSigRef.current
		) {
			return;
		}
		lastCellRevisionRef.current = cellRev;
		lastViewSigRef.current = viewSig;

		const ctx = canvas.getContext("2d");
		if (!ctx) return;

		const cssW = MINIMAP_WIDTH;
		const cssH = MINIMAP_HEIGHT;
		const worldW = view.worldWidth;
		const worldH = view.worldHeight;
		const sx = cssW / worldW;
		const sy = cssH / worldH;

		ctx.setTransform(PIXEL_RATIO, 0, 0, PIXEL_RATIO, 0, 0);
		ctx.clearRect(0, 0, cssW, cssH);

		// Sky above ground, dirt below — the color transition is the ground
		// plane, mirroring the canvas's sky/underground regions exactly.
		const groundY = (UNDERGROUND_Y * TILE_HEIGHT * cssH) / worldH;
		ctx.fillStyle = MINIMAP_SKY_FILL;
		ctx.fillRect(0, 0, cssW, groundY);
		ctx.fillStyle = MINIMAP_UNDERGROUND_FILL;
		ctx.fillRect(0, groundY, cssW, cssH - groundY);

		// Sub-pixel cell sizes are intentional: with TILE_WIDTH * sx ≈ 0.35,
		// clamping to 1px would (a) bloat the silhouette ~30% horizontally and
		// (b) make the Eval tab show only the iteration-last cell's color in
		// any overlap region. Canvas anti-aliasing blends adjacent cells
		// additively, which is the correct semantics for a downscaled map.
		const tileW = TILE_WIDTH * sx;
		const tileH = TILE_HEIGHT * sy;
		for (const cell of scene.iterateOccupiedCells()) {
			ctx.fillStyle = cellFill(activeTab, cell.evalLevel);
			ctx.fillRect(
				cell.x * TILE_WIDTH * sx,
				cell.y * TILE_HEIGHT * sy,
				tileW,
				tileH,
			);
		}

		// Clip jointly so a partially off-world rect shows only the visible
		// portion instead of being translated. Snap to integer pixels with a
		// 0.5 offset so the 1px stroke aligns to the pixel grid (no AA blur).
		const rx = view.scrollX * sx;
		const ry = view.scrollY * sy;
		const rw = view.viewWidth * sx;
		const rh = view.viewHeight * sy;
		const x0 = Math.max(0, rx);
		const y0 = Math.max(0, ry);
		const x1 = Math.min(cssW, rx + rw);
		const y1 = Math.min(cssH, ry + rh);
		if (x1 > x0 && y1 > y0) {
			const left = Math.round(x0) + 0.5;
			const top = Math.round(y0) + 0.5;
			const right = Math.round(x1) - 0.5;
			const bottom = Math.round(y1) - 0.5;
			ctx.strokeStyle = "#facc15";
			ctx.lineWidth = 1;
			ctx.strokeRect(
				left,
				top,
				Math.max(1, right - left),
				Math.max(1, bottom - top),
			);
		}
	}, [sceneRef, activeTab]);

	useEffect(() => {
		if (collapsed || !sceneReady) return;
		let raf = 0;
		const tick = () => {
			renderMinimap();
			raf = requestAnimationFrame(tick);
		};
		raf = requestAnimationFrame(tick);
		return () => {
			cancelAnimationFrame(raf);
		};
	}, [collapsed, renderMinimap, sceneReady]);

	useEffect(() => {
		// Force a redraw on (re)mount of the scene.
		if (sceneReady) {
			lastCellRevisionRef.current = -1;
			lastViewSigRef.current = "";
		}
	}, [sceneReady]);

	const jumpToMinimapPoint = useCallback(
		(clientX: number, clientY: number) => {
			const canvas = canvasRef.current;
			const scene = sceneRef.current;
			if (!canvas || !scene) return;
			const rect = canvas.getBoundingClientRect();
			const localX = clientX - rect.left;
			const localY = clientY - rect.top;
			const fracX = localX / rect.width;
			const fracY = localY / rect.height;
			const view = scene.getCameraView();
			if (!view.ready) return;
			const worldX = fracX * view.worldWidth;
			const worldY = fracY * view.worldHeight;
			scene.centerCameraOnWorld(worldX, worldY);
		},
		[sceneRef],
	);

	const handlePointerDown = useCallback(
		(event: React.PointerEvent<HTMLCanvasElement>) => {
			event.preventDefault();
			(event.target as Element).setPointerCapture(event.pointerId);
			draggingRef.current = true;
			jumpToMinimapPoint(event.clientX, event.clientY);
		},
		[jumpToMinimapPoint],
	);

	const handlePointerMove = useCallback(
		(event: React.PointerEvent<HTMLCanvasElement>) => {
			if (!draggingRef.current) return;
			jumpToMinimapPoint(event.clientX, event.clientY);
		},
		[jumpToMinimapPoint],
	);

	const handlePointerUp = useCallback(
		(event: React.PointerEvent<HTMLCanvasElement>) => {
			if (draggingRef.current) {
				sceneRef.current?.persistCameraView();
			}
			draggingRef.current = false;
			(event.target as Element).releasePointerCapture(event.pointerId);
		},
		[sceneRef],
	);

	const containerStyle: React.CSSProperties = {
		...styles.container,
		...(pos
			? { left: pos.x, top: pos.y, bottom: "auto", right: "auto" }
			: null),
	};

	return (
		<div
			ref={panelRef}
			style={containerStyle}
			onPointerDown={handlePanelPointerDown}
			onPointerMove={handlePanelPointerMove}
			onPointerUp={handlePanelPointerUp}
			onPointerCancel={handlePanelPointerUp}
		>
			<div style={styles.header} title="Drag to reposition">
				<span style={styles.titleLabel}>Map</span>
				<button
					type="button"
					style={styles.closeBtn}
					onClick={toggleCollapsed}
					title={collapsed ? "Show map" : "Close map"}
					aria-label={collapsed ? "Show map" : "Close map"}
				>
					{collapsed ? "▲" : "✕"}
				</button>
			</div>
			{!collapsed && (
				<>
					<div style={styles.tabBar}>
						{TAB_IDS.map((id) => {
							const active = activeTab === id;
							return (
								<button
									key={id}
									type="button"
									style={
										active ? { ...styles.tab, ...styles.tabActive } : styles.tab
									}
									onClick={() => setActiveTabPersisted(id)}
								>
									{TAB_LABELS[id]}
								</button>
							);
						})}
					</div>
					<div style={styles.canvasWrapper}>
						<canvas
							ref={canvasRef}
							style={styles.canvas}
							onPointerDown={handlePointerDown}
							onPointerMove={handlePointerMove}
							onPointerUp={handlePointerUp}
							onPointerCancel={handlePointerUp}
						/>
					</div>
				</>
			)}
		</div>
	);
}

const containerBase: React.CSSProperties = {
	position: "absolute",
	bottom: PADDING,
	left: PADDING,
	zIndex: 70,
	background: "rgba(14, 18, 24, 0.9)",
	border: "1px solid rgba(123, 148, 170, 0.35)",
	backdropFilter: "blur(6px)",
	pointerEvents: "auto",
};

const styles = {
	container: {
		...containerBase,
		borderRadius: 8,
		display: "flex",
		flexDirection: "column",
	},
	header: {
		display: "flex",
		alignItems: "center",
		justifyContent: "space-between",
		gap: 8,
		padding: "4px 6px 4px 10px",
		cursor: "grab",
		touchAction: "none",
	},
	titleLabel: {
		color: "#d9e7f2",
		fontSize: 11,
		fontWeight: 700,
		letterSpacing: "0.08em",
		textTransform: "uppercase",
	},
	closeBtn: {
		background: "transparent",
		border: "none",
		color: "#aab8c2",
		fontSize: 14,
		lineHeight: 1,
		cursor: "pointer",
		padding: "0 4px",
	},
	tabBar: {
		display: "flex",
		gap: 0,
		padding: "0 6px",
		borderBottom: "1px solid rgba(123, 148, 170, 0.2)",
	},
	tab: {
		padding: "3px 10px",
		border: "none",
		background: "transparent",
		color: "#7b8a99",
		fontSize: 10,
		fontWeight: 600,
		letterSpacing: "0.04em",
		textTransform: "uppercase",
		cursor: "pointer",
		borderBottom: "2px solid transparent",
	},
	tabActive: {
		color: "#d9e7f2",
		borderBottom: "2px solid #3b82f6",
	},
	canvasWrapper: {
		padding: 6,
	},
	canvas: {
		display: "block",
		width: MINIMAP_WIDTH,
		height: MINIMAP_HEIGHT,
		borderRadius: 4,
		cursor: "crosshair",
		touchAction: "none",
	},
} as const satisfies Record<string, React.CSSProperties>;
