import { useCallback, useEffect, useRef, useState } from "react";
import type { GameScene } from "../game/GameScene";

const TRACK_THICKNESS = 8;
const MIN_THUMB_PX = 24;
const HIDE_DELAY_MS = 1200;

interface Props {
	sceneRef: React.MutableRefObject<GameScene | null>;
	sceneReady: boolean;
}

interface Geometry {
	verticalThumb: { top: number; height: number; trackHeight: number } | null;
	horizontalThumb: { left: number; width: number; trackWidth: number } | null;
}

/**
 * Thin auto-hide scrollbars overlaying the Phaser canvas. Driven by the
 * scene's camera state via getCameraView()/setCameraScroll(). Auto-hides
 * after a short idle period unless the user is hovering the canvas.
 */
export function CanvasScrollbars({ sceneRef, sceneReady }: Props) {
	const [visible, setVisible] = useState(false);
	const [geometry, setGeometry] = useState<Geometry>({
		verticalThumb: null,
		horizontalThumb: null,
	});
	const containerRef = useRef<HTMLDivElement | null>(null);
	const hideTimerRef = useRef<number | null>(null);
	const dragStateRef = useRef<{
		axis: "x" | "y";
		startClient: number;
		startScroll: number;
	} | null>(null);

	const showAndQueueHide = useCallback(() => {
		setVisible(true);
		if (hideTimerRef.current !== null) {
			window.clearTimeout(hideTimerRef.current);
		}
		hideTimerRef.current = window.setTimeout(() => {
			setVisible(false);
			hideTimerRef.current = null;
		}, HIDE_DELAY_MS);
	}, []);

	// Poll camera state on rAF to keep thumb positions in sync, and reveal
	// the scrollbars whenever the camera moves.
	useEffect(() => {
		if (!sceneReady) return;
		let raf = 0;
		let lastSig = "";
		const tick = () => {
			const scene = sceneRef.current;
			const container = containerRef.current;
			if (scene && container) {
				const view = scene.getCameraView();
				if (view.ready) {
					const rect = container.getBoundingClientRect();
					const trackHeight = rect.height - TRACK_THICKNESS;
					const trackWidth = rect.width - TRACK_THICKNESS;
					const verticalRatio = view.viewHeight / view.worldHeight;
					const horizontalRatio = view.viewWidth / view.worldWidth;
					const verticalThumb =
						verticalRatio < 1
							? {
									top: (view.scrollY / view.worldHeight) * trackHeight,
									height: Math.max(MIN_THUMB_PX, verticalRatio * trackHeight),
									trackHeight,
								}
							: null;
					const horizontalThumb =
						horizontalRatio < 1
							? {
									left: (view.scrollX / view.worldWidth) * trackWidth,
									width: Math.max(MIN_THUMB_PX, horizontalRatio * trackWidth),
									trackWidth,
								}
							: null;
					const sig = `${verticalThumb?.top ?? -1}|${verticalThumb?.height ?? -1}|${horizontalThumb?.left ?? -1}|${horizontalThumb?.width ?? -1}|${trackHeight}|${trackWidth}`;
					if (sig !== lastSig) {
						lastSig = sig;
						setGeometry({ verticalThumb, horizontalThumb });
						showAndQueueHide();
					}
				}
			}
			raf = requestAnimationFrame(tick);
		};
		raf = requestAnimationFrame(tick);
		return () => {
			cancelAnimationFrame(raf);
		};
	}, [sceneRef, sceneReady, showAndQueueHide]);

	useEffect(() => {
		return () => {
			if (hideTimerRef.current !== null) {
				window.clearTimeout(hideTimerRef.current);
			}
		};
	}, []);

	const handleThumbPointerDown = useCallback(
		(axis: "x" | "y") => (event: React.PointerEvent<HTMLDivElement>) => {
			event.preventDefault();
			event.stopPropagation();
			const scene = sceneRef.current;
			if (!scene) return;
			const view = scene.getCameraView();
			if (!view.ready) return;
			(event.target as Element).setPointerCapture(event.pointerId);
			dragStateRef.current = {
				axis,
				startClient: axis === "x" ? event.clientX : event.clientY,
				startScroll: axis === "x" ? view.scrollX : view.scrollY,
			};
		},
		[sceneRef],
	);

	const handleThumbPointerMove = useCallback(
		(event: React.PointerEvent<HTMLDivElement>) => {
			const drag = dragStateRef.current;
			const scene = sceneRef.current;
			const container = containerRef.current;
			if (!drag || !scene || !container) return;
			const view = scene.getCameraView();
			if (!view.ready) return;
			const rect = container.getBoundingClientRect();
			if (drag.axis === "x") {
				const trackWidth = rect.width - TRACK_THICKNESS;
				const dx = event.clientX - drag.startClient;
				const worldDelta = (dx / trackWidth) * view.worldWidth;
				scene.setCameraScroll(drag.startScroll + worldDelta, view.scrollY);
			} else {
				const trackHeight = rect.height - TRACK_THICKNESS;
				const dy = event.clientY - drag.startClient;
				const worldDelta = (dy / trackHeight) * view.worldHeight;
				scene.setCameraScroll(view.scrollX, drag.startScroll + worldDelta);
			}
		},
		[sceneRef],
	);

	const handleThumbPointerUp = useCallback(
		(event: React.PointerEvent<HTMLDivElement>) => {
			if (dragStateRef.current) {
				sceneRef.current?.persistCameraView();
			}
			dragStateRef.current = null;
			(event.target as Element).releasePointerCapture(event.pointerId);
		},
		[sceneRef],
	);

	const opacity = visible ? 1 : 0;
	// Tracks are always pointer-transparent so the canvas underneath keeps
	// receiving build/inspect clicks at the edges. Only the thumb intercepts.
	const trackBaseStyle: React.CSSProperties = {
		position: "absolute",
		background: "rgba(20, 28, 38, 0.45)",
		opacity,
		transition: "opacity 250ms ease-out",
		pointerEvents: "none",
	};
	const thumbStyle: React.CSSProperties = {
		position: "absolute",
		background: "rgba(170, 184, 194, 0.85)",
		borderRadius: 4,
		cursor: "grab",
		pointerEvents: visible ? "auto" : "none",
	};

	return (
		<div
			ref={containerRef}
			style={{
				position: "absolute",
				inset: 0,
				pointerEvents: "none",
			}}
			onPointerMove={showAndQueueHide}
		>
			{geometry.verticalThumb && (
				<div
					style={{
						...trackBaseStyle,
						top: 0,
						right: 0,
						width: TRACK_THICKNESS,
						height: geometry.verticalThumb.trackHeight,
					}}
				>
					<div
						style={{
							...thumbStyle,
							top: geometry.verticalThumb.top,
							right: 1,
							width: TRACK_THICKNESS - 2,
							height: geometry.verticalThumb.height,
						}}
						onPointerDown={handleThumbPointerDown("y")}
						onPointerMove={handleThumbPointerMove}
						onPointerUp={handleThumbPointerUp}
						onPointerCancel={handleThumbPointerUp}
					/>
				</div>
			)}
			{geometry.horizontalThumb && (
				<div
					style={{
						...trackBaseStyle,
						left: 0,
						bottom: 0,
						width: geometry.horizontalThumb.trackWidth,
						height: TRACK_THICKNESS,
					}}
				>
					<div
						style={{
							...thumbStyle,
							left: geometry.horizontalThumb.left,
							bottom: 1,
							width: geometry.horizontalThumb.width,
							height: TRACK_THICKNESS - 2,
						}}
						onPointerDown={handleThumbPointerDown("x")}
						onPointerMove={handleThumbPointerMove}
						onPointerUp={handleThumbPointerUp}
						onPointerCancel={handleThumbPointerUp}
					/>
				</div>
			)}
		</div>
	);
}
