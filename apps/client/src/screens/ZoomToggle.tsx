import { useEffect, useState } from "react";
import type { GameScene } from "../game/GameScene";
import { TILE_HEIGHT } from "../game/gameSceneConstants";
import { GRID_HEIGHT } from "../types";

interface Props {
	sceneRef: React.MutableRefObject<GameScene | null>;
	sceneReady: boolean;
}

/**
 * SimTower's "Zoom box" was a single binary toggle in the top-right of the
 * Edit window between normal and full-screen view. We mirror that intent:
 * one button that toggles between fit-to-tower and 1× zoom.
 */
export function ZoomToggle({ sceneRef, sceneReady }: Props) {
	const [isFit, setIsFit] = useState(false);

	// Poll camera zoom to keep the label honest if the user changes zoom via
	// wheel/pinch/scrollbars/minimap.
	useEffect(() => {
		if (!sceneReady) return;
		let raf = 0;
		const tick = () => {
			const scene = sceneRef.current;
			if (scene) {
				const view = scene.getCameraView();
				if (view.ready) {
					const fitZoom = view.viewHeight
						? scene.scale.height / (GRID_HEIGHT * TILE_HEIGHT)
						: 0;
					// Halfway-threshold heuristic between fitZoom and 1×.
					const threshold = (fitZoom + 1) / 2;
					setIsFit(view.zoom < threshold);
				}
			}
			raf = requestAnimationFrame(tick);
		};
		raf = requestAnimationFrame(tick);
		return () => cancelAnimationFrame(raf);
	}, [sceneRef, sceneReady]);

	const handleClick = () => {
		const scene = sceneRef.current;
		if (!scene) return;
		if (isFit) scene.applyPresetActualSize();
		else scene.applyPresetFit();
	};

	return (
		<button
			type="button"
			onClick={handleClick}
			style={styles.button}
			title={isFit ? "Zoom to actual size (1×)" : "Zoom to fit tower"}
		>
			{isFit ? "1×" : "Fit"}
		</button>
	);
}

const styles = {
	button: {
		// SimTower placed the Zoom box at the top-right of the Edit window,
		// but our top-right is already crowded by the build panel + debug HUD.
		// Top-left is the open corner closest to that mental model.
		position: "absolute",
		top: 12,
		left: 12,
		zIndex: 70,
		width: 36,
		height: 24,
		padding: 0,
		borderRadius: 4,
		border: "1px solid rgba(123, 148, 170, 0.35)",
		background: "rgba(14, 18, 24, 0.9)",
		backdropFilter: "blur(6px)",
		color: "#d9e7f2",
		fontSize: 11,
		fontWeight: 700,
		letterSpacing: "0.04em",
		cursor: "pointer",
		pointerEvents: "auto",
	},
} as const satisfies Record<string, React.CSSProperties>;
