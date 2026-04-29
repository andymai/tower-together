import type { Types } from "phaser";
import {
	Game,
	AUTO as PhaserAUTO,
	CANVAS as PhaserCANVAS,
	Scale,
} from "phaser";
import { memo, useEffect, useRef } from "react";
import type { SimStateData } from "../types";
import { GameScene } from "./GameScene";
import {
	canCreateWebGL,
	clearWebGLActive,
	disableWebGLForAWhile,
	markWebGLActive,
	shouldForceCanvasFallback,
} from "./webglFallback";

interface Props {
	towerId: string;
	onCellClick: (x: number, y: number, shift: boolean) => void;
	onCellInspect: (x: number, y: number) => void;
	onQueuedSimInspect: (sim: SimStateData) => void;
	selectedTool: string;
	stressBadgesEnabled: boolean;
	soundMuted: boolean;
	sceneRef: React.MutableRefObject<GameScene | null>;
}

export const PhaserGame = memo(function PhaserGame({
	towerId,
	onCellClick,
	onCellInspect,
	onQueuedSimInspect,
	selectedTool,
	stressBadgesEnabled,
	soundMuted,
	sceneRef,
}: Props) {
	const containerRef = useRef<HTMLDivElement>(null);
	const gameRef = useRef<Game | null>(null);
	const soundMutedRef = useRef(soundMuted);
	soundMutedRef.current = soundMuted;

	useEffect(() => {
		const container = containerRef.current;
		if (!container) return;

		let disposed = false;
		let usingFallback = false;

		const buildGame = (forceCanvas: boolean): Game => {
			const scene = new GameScene(towerId);
			scene.setSoundMuted(soundMutedRef.current);
			sceneRef.current = scene;

			const config: Types.Core.GameConfig = {
				type: forceCanvas ? PhaserCANVAS : PhaserAUTO,
				parent: container,
				backgroundColor: "#1a1a1a",
				render: {
					antialias: true,
					powerPreference: "low-power",
				},
				scale: {
					mode: Scale.RESIZE,
					autoCenter: Scale.CENTER_BOTH,
					width: "100%",
					height: "100%",
				},
				scene,
				disableContextMenu: false,
			};

			return new Game(config);
		};

		const fallBackToCanvas = (reason: string) => {
			if (disposed || usingFallback) return;
			usingFallback = true;

			console.warn("Phaser: falling back to 2D canvas:", reason);
			disableWebGLForAWhile();

			const previous = gameRef.current;
			gameRef.current = null;
			sceneRef.current = null;
			previous?.destroy(true);

			if (disposed) return;
			gameRef.current = buildGame(true);
		};

		const forceCanvas = shouldForceCanvasFallback() || !canCreateWebGL();
		const game = buildGame(forceCanvas);
		gameRef.current = game;

		// Phaser sets renderType after boot; check it once ready.
		// 1 = CANVAS, 2 = WEBGL.
		const onBoot = () => {
			if (disposed) return;
			const isWebGL = game.config.renderType === 2;
			if (!isWebGL) return;

			markWebGLActive();

			const canvas = game.canvas;

			canvas.addEventListener(
				"webglcontextlost",
				(event) => {
					event.preventDefault();
					fallBackToCanvas("webglcontextlost");
				},
				false,
			);
		};

		game.events.once("ready", onBoot);

		const onPageHide = () => {
			clearWebGLActive();
		};
		const onVisibility = () => {
			if (document.visibilityState === "hidden") {
				clearWebGLActive();
			} else if (!usingFallback && game.config.renderType === 2) {
				markWebGLActive();
			}
		};

		window.addEventListener("pagehide", onPageHide);
		document.addEventListener("visibilitychange", onVisibility);

		return () => {
			disposed = true;
			window.removeEventListener("pagehide", onPageHide);
			document.removeEventListener("visibilitychange", onVisibility);
			clearWebGLActive();
			sceneRef.current = null;
			gameRef.current?.destroy(true);
			gameRef.current = null;
		};
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [sceneRef, towerId]);

	useEffect(() => {
		sceneRef.current?.setOnCellClick(onCellClick);
	}, [onCellClick, sceneRef]);

	useEffect(() => {
		sceneRef.current?.setOnCellInspect(onCellInspect);
	}, [onCellInspect, sceneRef]);

	useEffect(() => {
		sceneRef.current?.setOnQueuedSimInspect(onQueuedSimInspect);
	}, [onQueuedSimInspect, sceneRef]);

	useEffect(() => {
		sceneRef.current?.setSelectedTool(selectedTool);
	}, [selectedTool, sceneRef]);

	useEffect(() => {
		sceneRef.current?.setStressBadgesEnabled(stressBadgesEnabled);
	}, [stressBadgesEnabled, sceneRef]);

	useEffect(() => {
		sceneRef.current?.setSoundMuted(soundMuted);
	}, [soundMuted, sceneRef]);

	return <div ref={containerRef} style={{ width: "100%", height: "100%" }} />;
});
