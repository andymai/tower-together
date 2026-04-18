import type { Dispatch, SetStateAction } from "react";
import { useEffect, useRef, useState } from "react";
import type { GameScene } from "../game/GameScene";
import type { TowerSocket } from "../lib/socket";
import type { ConnectionStatus } from "../types";
import type { ActivePrompt, CellInfoData } from "./gameScreenTypes";
import {
	INITIAL_TOWER_SESSION_STATE,
	TowerSessionController,
	type TowerSessionState,
} from "./towerSessionController";

interface UseTowerSessionOptions {
	playerId: string;
	displayName: string;
	socket: TowerSocket;
	sceneRef: React.MutableRefObject<GameScene | null>;
	addToast: (message: string, variant?: "error" | "info") => void;
}

interface UseTowerSessionResult {
	connectionStatus: ConnectionStatus;
	simTime: number;
	cash: number;
	population: number;
	starCount: number;
	playerCount: number;
	towerName: string;
	setTowerName: (value: string) => void;
	sims: TowerSessionState["sims"];
	carriers: TowerSessionState["carriers"];
	speedMultiplier: 1 | 3 | 10;
	freeBuild: boolean;
	activePrompt: ActivePrompt | null;
	inspectedCell: CellInfoData | null;
	setInspectedCell: Dispatch<SetStateAction<CellInfoData | null>>;
	sendTileCommand: (
		x: number,
		y: number,
		tileType: string,
		shift: boolean,
	) => void;
	inspectCell: (x: number, y: number) => void;
	respondToPrompt: (accepted: boolean) => void;
	setSpeedMultiplier: (multiplier: 1 | 3 | 10) => void;
	setStarCount: (starCount: 1 | 2 | 3 | 4 | 5 | 6) => void;
	setFreeBuild: (enabled: boolean) => void;
	setRentLevel: (x: number, y: number, rentLevel: number) => void;
	addElevatorCar: (x: number, y: number) => void;
	removeElevatorCar: (x: number) => void;
	reconnect: () => void;
}

export function useTowerSession({
	playerId,
	displayName,
	socket,
	sceneRef,
	addToast,
}: UseTowerSessionOptions): UseTowerSessionResult {
	const [state, setState] = useState<TowerSessionState>(
		INITIAL_TOWER_SESSION_STATE,
	);
	const controllerRef = useRef<TowerSessionController | null>(null);

	if (controllerRef.current === null) {
		controllerRef.current = new TowerSessionController({
			playerId,
			displayName,
			socket,
			getScene: () => sceneRef.current,
			addToast,
			onStateChange: (nextState) => {
				setState(nextState);
			},
		});
	}

	useEffect(() => {
		const controller = controllerRef.current;
		controller?.start();
		return () => {
			controller?.dispose();
		};
	}, []);

	return {
		...state,
		setTowerName: (value) => controllerRef.current?.setTowerName(value),
		setInspectedCell: (updater) =>
			controllerRef.current?.setInspectedCell(updater),
		sendTileCommand: (x, y, tileType, shift) =>
			controllerRef.current?.sendTileCommand(x, y, tileType, shift),
		inspectCell: (x, y) => controllerRef.current?.inspectCell(x, y),
		respondToPrompt: (accepted) =>
			controllerRef.current?.respondToPrompt(accepted),
		setSpeedMultiplier: (multiplier) =>
			controllerRef.current?.setSpeedMultiplier(multiplier),
		setStarCount: (starCount) => controllerRef.current?.setStarCount(starCount),
		setFreeBuild: (enabled) => controllerRef.current?.setFreeBuild(enabled),
		setRentLevel: (x, y, rentLevel) =>
			controllerRef.current?.setRentLevel(x, y, rentLevel),
		addElevatorCar: (x, y) => controllerRef.current?.addElevatorCar(x, y),
		removeElevatorCar: (x) => controllerRef.current?.removeElevatorCar(x),
		reconnect: () => controllerRef.current?.reconnect(),
	};
}
