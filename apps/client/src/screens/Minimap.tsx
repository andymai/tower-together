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
	const canvasRef = useRef<HTMLCanvasElement | null>(null);
	const lastCellRevisionRef = useRef<number>(-1);
	const lastViewSigRef = useRef<string>("");
	const draggingRef = useRef<boolean>(false);

	const toggleCollapsed = useCallback(() => {
		setCollapsed((prev) => {
			const next = !prev;
			setTowerView(towerId, { minimapCollapsed: next });
			return next;
		});
	}, [towerId]);

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

		// Background
		ctx.fillStyle = "rgba(20, 28, 38, 0.95)";
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

		// Viewport rectangle
		const rx = view.scrollX * sx;
		const ry = view.scrollY * sy;
		const rw = view.viewWidth * sx;
		const rh = view.viewHeight * sy;
		ctx.strokeStyle = "#facc15";
		ctx.lineWidth = 1.5;
		ctx.strokeRect(
			Math.max(0, rx),
			Math.max(0, ry),
			Math.min(cssW, rw),
			Math.min(cssH, rh),
		);
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
			draggingRef.current = false;
			(event.target as Element).releasePointerCapture(event.pointerId);
		},
		[],
	);

	return (
		<div style={collapsed ? styles.containerCollapsed : styles.container}>
			<div style={styles.header}>
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
		padding: 6,
		borderRadius: 8,
		display: "flex",
		flexDirection: "column",
		gap: 6,
	},
	containerCollapsed: {
		...containerBase,
		padding: "4px 6px",
		borderRadius: 6,
	},
	header: {
		display: "flex",
		alignItems: "center",
		justifyContent: "space-between",
		gap: 6,
	},
	collapseBtn: {
		background: "transparent",
		border: "none",
		color: "#aab8c2",
		fontSize: 11,
		fontWeight: 700,
		letterSpacing: "0.06em",
		textTransform: "uppercase",
		cursor: "pointer",
		padding: "2px 4px",
	},
	presetButtons: {
		display: "flex",
		gap: 4,
	},
	presetBtn: {
		padding: "2px 6px",
		borderRadius: 3,
		border: "1px solid rgba(123, 148, 170, 0.4)",
		background: "transparent",
		color: "#aab8c2",
		fontSize: 10,
		fontWeight: 600,
		cursor: "pointer",
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
