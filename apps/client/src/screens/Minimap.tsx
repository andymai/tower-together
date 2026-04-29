import { useCallback, useEffect, useRef, useState } from "react";
import type { GameScene } from "../game/GameScene";
import { TILE_HEIGHT, TILE_WIDTH } from "../game/gameSceneConstants";
import { getTowerView, setTowerView } from "../lib/storage";
import { UNDERGROUND_Y } from "../types";

const MINIMAP_WIDTH = 130;
const MINIMAP_HEIGHT = 200;
const PADDING = 8;
const PIXEL_RATIO = window.devicePixelRatio || 1;

interface Props {
	towerId: string;
	sceneRef: React.MutableRefObject<GameScene | null>;
	sceneReady: boolean;
}

export function Minimap({ towerId, sceneRef, sceneReady }: Props) {
	const [collapsed, setCollapsed] = useState<boolean>(
		() => getTowerView(towerId).minimapCollapsed === true,
	);
	const [pos, setPos] = useState<{ x: number; y: number } | null>(
		() => getTowerView(towerId).minimapPos ?? null,
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

	const toggleCollapsed = useCallback(() => {
		setCollapsed((prev) => {
			const next = !prev;
			setTowerView(towerId, { minimapCollapsed: next });
			return next;
		});
	}, [towerId]);

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

	const handlePanelPointerDown = useCallback(
		(event: React.PointerEvent<HTMLDivElement>) => {
			// Ignore drags that originate on a button or the canvas.
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
			// Materialize current position so subsequent moves animate from here
			// even if we were anchored bottom-left by default.
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

	// Re-clamp on viewport resize so the panel doesn't get stranded off-screen.
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

		const cellRev = scene.getCellRevision();
		const viewSig = `${view.scrollX}|${view.scrollY}|${view.zoom}|${view.viewWidth}|${view.viewHeight}`;
		if (
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

		// Background (matches container so border is the only visible chrome).
		ctx.fillStyle = "#181818";
		ctx.fillRect(0, 0, cssW, cssH);

		// Tower silhouette: tile cells as gray rectangles.
		ctx.fillStyle = "#9aa8b8";
		const tileW = Math.max(1, TILE_WIDTH * sx);
		const tileH = Math.max(1, TILE_HEIGHT * sy);
		for (const cell of scene.iterateOccupiedCells()) {
			const px = cell.x * TILE_WIDTH * sx;
			const py = cell.y * TILE_HEIGHT * sy;
			ctx.fillRect(px, py, tileW, tileH);
		}

		// Ground line (top of underground rows)
		const groundY = (UNDERGROUND_Y * TILE_HEIGHT * cssH) / worldH;
		ctx.strokeStyle = "rgba(74, 222, 128, 0.4)";
		ctx.lineWidth = 1;
		ctx.beginPath();
		ctx.moveTo(0, groundY);
		ctx.lineTo(cssW, groundY);
		ctx.stroke();

		// Viewport rectangle, clipped jointly so a partially off-world rect
		// shows only the visible portion instead of being translated.
		const rx = view.scrollX * sx;
		const ry = view.scrollY * sy;
		const rw = view.viewWidth * sx;
		const rh = view.viewHeight * sy;
		const x0 = Math.max(0, rx);
		const y0 = Math.max(0, ry);
		const x1 = Math.min(cssW, rx + rw);
		const y1 = Math.min(cssH, ry + rh);
		if (x1 > x0 && y1 > y0) {
			ctx.strokeStyle = "#facc15";
			ctx.lineWidth = 1.5;
			ctx.strokeRect(x0, y0, x1 - x0, y1 - y0);
		}
	}, [sceneRef]);

	// Animation loop: poll scene state every frame while uncollapsed.
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

	// Reset cached signatures when the scene becomes ready, forcing a redraw.
	useEffect(() => {
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
		...(collapsed ? styles.containerCollapsed : styles.container),
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
			<div
				style={
					collapsed ? { ...styles.header, borderBottom: "none" } : styles.header
				}
				title="Drag to reposition"
			>
				<button
					type="button"
					style={styles.collapseBtn}
					onClick={toggleCollapsed}
					title={collapsed ? "Show minimap" : "Hide minimap"}
				>
					{collapsed ? "▴ Map" : "▾ Map"}
				</button>
				{!collapsed && (
					<div style={styles.presetButtons}>
						<button
							type="button"
							style={styles.presetBtn}
							onClick={() => sceneRef.current?.applyPresetFit()}
							title="Fit tower (F)"
						>
							Fit
						</button>
						<button
							type="button"
							style={styles.presetBtn}
							onClick={() => sceneRef.current?.applyPresetActualSize()}
							title="Actual size (1)"
						>
							1×
						</button>
						<button
							type="button"
							style={styles.presetBtn}
							onClick={() => sceneRef.current?.applyPresetLobby()}
							title="Jump to lobby (L)"
						>
							Lobby
						</button>
					</div>
				)}
			</div>
			{!collapsed && (
				<canvas
					ref={(el) => {
						canvasRef.current = el;
						if (el) {
							el.width = MINIMAP_WIDTH * PIXEL_RATIO;
							el.height = MINIMAP_HEIGHT * PIXEL_RATIO;
						}
					}}
					style={styles.canvas}
					onPointerDown={handlePointerDown}
					onPointerMove={handlePointerMove}
					onPointerUp={handlePointerUp}
					onPointerCancel={handlePointerUp}
				/>
			)}
		</div>
	);
}

// Minimal styling to match the README's reverse-engineered-tool aesthetic:
// no blur, no rounded corners, no drop shadow — just a 1px border, a single
// solid background, and small monospace-feeling controls.
const containerBase: React.CSSProperties = {
	position: "absolute",
	bottom: PADDING,
	left: PADDING,
	zIndex: 70,
	background: "#181818",
	border: "1px solid #444",
	pointerEvents: "auto",
};

const styles = {
	container: {
		...containerBase,
		display: "flex",
		flexDirection: "column",
	},
	containerCollapsed: {
		...containerBase,
	},
	header: {
		display: "flex",
		alignItems: "center",
		justifyContent: "space-between",
		gap: 8,
		padding: "2px 4px",
		borderBottom: "1px solid #333",
		cursor: "grab",
		touchAction: "none",
	},
	collapseBtn: {
		background: "transparent",
		border: "none",
		color: "#bbb",
		fontSize: 10,
		fontWeight: 600,
		letterSpacing: "0.04em",
		textTransform: "uppercase",
		cursor: "pointer",
		padding: 0,
	},
	presetButtons: {
		display: "flex",
		gap: 6,
	},
	presetBtn: {
		padding: 0,
		border: "none",
		background: "transparent",
		color: "#888",
		fontSize: 10,
		fontWeight: 500,
		cursor: "pointer",
	},
	canvas: {
		display: "block",
		width: MINIMAP_WIDTH,
		height: MINIMAP_HEIGHT,
		cursor: "crosshair",
		touchAction: "none",
	},
} as const satisfies Record<string, React.CSSProperties>;
