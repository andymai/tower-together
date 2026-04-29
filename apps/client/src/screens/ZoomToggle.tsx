import { useEffect, useState } from "react";
import type { GameScene } from "../game/GameScene";
import { TILE_HEIGHT } from "../game/gameSceneConstants";
import { GRID_HEIGHT } from "../types";

interface Props {
	sceneRef: React.MutableRefObject<GameScene | null>;
	sceneReady: boolean;
}

export function ZoomToggle({ sceneRef, sceneReady }: Props) {
	const [isFit, setIsFit] = useState(false);

	useEffect(() => {
		if (!sceneReady) return;
		let raf = 0;
		const tick = () => {
			raf = requestAnimationFrame(tick);
			const scene = sceneRef.current;
			if (!scene) return;
			const view = scene.getCameraView();
			if (!view.ready) return;
			const fitZoom = view.viewHeight
				? scene.scale.height / (GRID_HEIGHT * TILE_HEIGHT)
				: 0;
			setIsFit(view.zoom < (fitZoom + 1) / 2);
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
