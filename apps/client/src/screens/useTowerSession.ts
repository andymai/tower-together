import type { Dispatch, SetStateAction } from "react";
import { useEffect, useRef, useState } from "react";
import type { GameScene } from "../game/GameScene";
import type { TowerSocket } from "../lib/socket";
import { getTowerToolbarCache } from "../lib/storage";
import type { ConnectionStatus } from "../types";
import type { ActivePrompt, CellInfoData } from "./gameScreenTypes";
import {
	INITIAL_TOWER_SESSION_STATE,
	TowerSessionController,
	type TowerSessionState,
} from "./towerSessionController";

interface UseTowerSessionOptions {
	towerId: string;
	playerId: string;
	displayName: string;
	socket: TowerSocket;
	sceneRef: React.RefObject<GameScene | null>;
	addToast: (message: string, variant?: "error" | "info") => void;
	onSimTime: (simTime: number) => void;
	onEconomy: (cash: number, population: number) => void;
}

interface UseTowerSessionResult {
	connectionStatus: ConnectionStatus;
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
	sceneReady: boolean;
	lobbyExists: boolean;
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
	removeElevatorShaft: (x: number, topY: number, bottomY: number) => void;
	setElevatorDwellDelay: (x: number, value: number) => void;
	setElevatorWaitingCarResponse: (x: number, value: number) => void;
	setElevatorHomeFloor: (x: number, carIndex: number, floor: number) => void;
	toggleElevatorFloorStop: (x: number, floor: number) => void;
	setCinemaMoviePool: (x: number, y: number, pool: "classic" | "new") => void;
	reconnect: () => void;
}

export function useTowerSession({
	towerId,
	playerId,
	displayName,
	socket,
	sceneRef,
	addToast,
	onSimTime,
	onEconomy,
}: UseTowerSessionOptions): UseTowerSessionResult {
	const initialCacheRef = useRef(getTowerToolbarCache(towerId));
	const [state, setState] = useState<TowerSessionState>(() => {
		const cache = initialCacheRef.current;
		return {
			...INITIAL_TOWER_SESSION_STATE,
			towerName: cache.towerName ?? INITIAL_TOWER_SESSION_STATE.towerName,
			starCount: cache.starCount ?? INITIAL_TOWER_SESSION_STATE.starCount,
		};
	});
	const controllerRef = useRef<TowerSessionController | null>(null);
	const onSimTimeRef = useRef(onSimTime);
	onSimTimeRef.current = onSimTime;
	const onEconomyRef = useRef(onEconomy);
	onEconomyRef.current = onEconomy;

	if (controllerRef.current === null) {
		controllerRef.current = new TowerSessionController({
			towerId,
			playerId,
			displayName,
			socket,
			getScene: () => sceneRef.current,
			addToast,
			onStateChange: (nextState) => {
				setState(nextState);
			},
			onSimTime: (simTime) => onSimTimeRef.current(simTime),
			onEconomy: (cash, population) => onEconomyRef.current(cash, population),
		});
	}

	useEffect(() => {
		const { cash, population } = initialCacheRef.current;
		if (cash != null && population != null) {
			onEconomyRef.current(cash, population);
		}
		const controller = controllerRef.current;
		controller?.start();
		return () => {
			controller?.dispose();
		};
		// eslint-disable-next-line react-hooks/exhaustive-deps
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
		removeElevatorShaft: (x, topY, bottomY) =>
			controllerRef.current?.removeElevatorShaft(x, topY, bottomY),
		setElevatorDwellDelay: (x, value) =>
			controllerRef.current?.setElevatorDwellDelay(x, value),
		setElevatorWaitingCarResponse: (x, value) =>
			controllerRef.current?.setElevatorWaitingCarResponse(x, value),
		setElevatorHomeFloor: (x, carIndex, floor) =>
			controllerRef.current?.setElevatorHomeFloor(x, carIndex, floor),
		toggleElevatorFloorStop: (x, floor) =>
			controllerRef.current?.toggleElevatorFloorStop(x, floor),
		setCinemaMoviePool: (x, y, pool) =>
			controllerRef.current?.setCinemaMoviePool(x, y, pool),
		reconnect: () => controllerRef.current?.reconnect(),
	};
}
