import type { Types } from "phaser";
import { Game, AUTO as PhaserAUTO, Scale } from "phaser";
import { memo, useEffect, useRef } from "react";
import type { SimStateData } from "../types";
import { GameScene } from "./GameScene";

interface Props {
	towerId: string;
	onCellClick: (x: number, y: number, shift: boolean) => void;
	onCellInspect: (x: number, y: number) => void;
	onQueuedSimInspect: (sim: SimStateData) => void;
	selectedTool: string;
	sceneRef: React.MutableRefObject<GameScene | null>;
}

export const PhaserGame = memo(function PhaserGame({
	towerId,
	onCellClick,
	onCellInspect,
	onQueuedSimInspect,
	selectedTool,
	sceneRef,
}: Props) {
	const containerRef = useRef<HTMLDivElement>(null);
	const gameRef = useRef<Game | null>(null);

	useEffect(() => {
		if (!containerRef.current) return;

		const scene = new GameScene(towerId);
		sceneRef.current = scene;

		const config: Types.Core.GameConfig = {
			type: PhaserAUTO,
			parent: containerRef.current,
			backgroundColor: "#1a1a1a",
			render: {
				antialias: true,
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

		gameRef.current = new Game(config);

		return () => {
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

	return <div ref={containerRef} style={{ width: "100%", height: "100%" }} />;
});
