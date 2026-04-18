import { useCallback, useEffect, useRef, useState } from "react";
import type { GameScene } from "../game/GameScene";
import { PhaserGame } from "../game/PhaserGame";
import { buildTransportMetrics } from "../game/transportSelectors";
import type { TowerSocket } from "../lib/socket";
import type { SelectedTool, SimStateData } from "../types";
import { DAY_TICK_MAX, getTileStarRequirement } from "../types";
import { CellInspectionDialog } from "./CellInspectionDialog";
import { GameBuildPanel } from "./GameBuildPanel";
import { GameDebugPanel } from "./GameDebugPanel";
import { GameInspectPanel } from "./GameInspectPanel";
import { GamePromptModal } from "./GamePromptModal";
import { GameToasts } from "./GameToasts";
import { GameToolbar } from "./GameToolbar";
import { gameScreenStyles as styles } from "./gameScreenStyles";
import type { Toast } from "./gameScreenTypes";
import { SimInspectionDialog } from "./SimInspectionDialog";
import { useTowerSession } from "./useTowerSession";

interface Props {
	playerId: string;
	displayName: string;
	socket: TowerSocket;
	towerId: string;
	onLeave: () => void;
}

let toastCounter = 0;

function formatSimDate(day: number): string {
	const day0 = Math.max(0, day - 1);
	const year = Math.floor(day0 / 12) + 1;
	const quarter = Math.floor((day0 % 12) / 4) + 1;
	const dow = day0 % 4;
	const weekLabel = dow < 2 ? `WD${dow + 1}` : "WE";
	return `Year ${year} Q${quarter} ${weekLabel}`;
}

function formatSimTimeOfDay(simTime: number): string {
	const dayTick = ((simTime % DAY_TICK_MAX) + DAY_TICK_MAX) % DAY_TICK_MAX;
	const daypartIndex = Math.floor(dayTick / 400);
	const daypartOffset = dayTick - daypartIndex * 400;
	let hours12 = 12;
	let minutes = 0;

	switch (daypartIndex) {
		case 0: {
			const scaledTicks = daypartOffset * 5;
			hours12 = Math.floor(scaledTicks / 400) + 7;
			minutes = Math.floor(((scaledTicks - (hours12 - 7) * 400) * 60) / 400);
			break;
		}
		case 1:
			hours12 = 12;
			minutes = Math.floor((daypartOffset * 60) / 800);
			break;
		case 2:
			hours12 = 12;
			minutes = Math.floor((daypartOffset * 60) / 800) + 30;
			break;
		case 3:
		case 4:
		case 5: {
			const scaledTicks = daypartOffset * 4;
			const hourOffset = Math.floor(scaledTicks / 400);
			hours12 =
				hourOffset + (daypartIndex === 3 ? 1 : daypartIndex === 4 ? 5 : 9);
			minutes = Math.floor(((scaledTicks - hourOffset * 400) * 60) / 400);
			if (hours12 > 12) {
				hours12 -= 12;
			}
			break;
		}
		case 6: {
			const scaledTicks = daypartOffset * 12;
			const hourOffset = Math.floor(scaledTicks / 400);
			hours12 = hourOffset + 1;
			minutes = Math.floor(((scaledTicks - hourOffset * 400) * 60) / 400);
			if (hours12 > 12) {
				hours12 -= 12;
			}
			break;
		}
	}

	if (minutes > 59) {
		minutes = 59;
	}

	const suffix =
		daypartIndex <= 4 || (daypartIndex === 5 && hours12 !== 12) ? "PM" : "AM";
	return `${hours12}:${minutes.toString().padStart(2, "0")} ${suffix}`;
}

export function GameScreen({
	playerId,
	displayName,
	socket,
	towerId,
	onLeave,
}: Props) {
	const [selectedTool, setSelectedTool] = useState<SelectedTool>("floor");
	const [isRenaming, setIsRenaming] = useState(false);
	const [aliasInput, setAliasInput] = useState("");
	const [aliasError, setAliasError] = useState("");
	const [aliasSaving, setAliasSaving] = useState(false);
	const [toasts, setToasts] = useState<Toast[]>([]);
	const [inspectedSim, setInspectedSim] = useState<SimStateData | null>(null);
	const sceneRef = useRef<GameScene | null>(null);

	const addToast = useCallback(
		(message: string, variant: "error" | "info" = "error") => {
			const id = ++toastCounter;
			setToasts((prev) => [...prev, { id, message, variant }]);
			const duration = variant === "info" ? 8000 : 3000;
			setTimeout(() => {
				setToasts((prev) => prev.filter((toast) => toast.id !== id));
			}, duration);
		},
		[],
	);

	const {
		connectionStatus,
		simTime,
		cash,
		population,
		starCount,
		playerCount,
		towerName,
		setTowerName,
		sims,
		carriers,
		speedMultiplier,
		freeBuild,
		activePrompt,
		inspectedCell,
		setInspectedCell,
		sendTileCommand,
		inspectCell,
		respondToPrompt,
		setSpeedMultiplier,
		setStarCount,
		setFreeBuild,
		setRentLevel,
		addElevatorCar,
		removeElevatorCar,
		reconnect,
	} = useTowerSession({
		playerId,
		displayName,
		socket,
		sceneRef,
		addToast,
	});

	const handleCellClick = useCallback(
		(x: number, y: number, shift: boolean) => {
			setInspectedSim(null);
			if (selectedTool === "inspect") {
				inspectCell(x, y);
				return;
			}
			sendTileCommand(x, y, selectedTool, shift);
		},
		[selectedTool, sendTileCommand, inspectCell],
	);

	const handleQueuedSimInspect = useCallback(
		(sim: SimStateData) => {
			setInspectedCell(null);
			setInspectedSim(sim);
		},
		[setInspectedCell],
	);

	const handleCellInspect = useCallback(
		(x: number, y: number) => {
			setInspectedSim(null);
			inspectCell(x, y);
		},
		[inspectCell],
	);

	const handlePatchInspectedCell = useCallback(
		(
			updater: (
				cell: NonNullable<typeof inspectedCell>,
			) => NonNullable<typeof inspectedCell>,
		) => {
			setInspectedCell((prev) => (prev ? updater(prev) : prev));
		},
		[setInspectedCell],
	);

	const handleRenameStart = useCallback(() => {
		setAliasInput(towerName === towerId ? "" : towerName);
		setAliasError("");
		setIsRenaming(true);
	}, [towerId, towerName]);

	const handleRenameCancel = useCallback(() => {
		setIsRenaming(false);
		setAliasError("");
	}, []);

	const handleAliasInputChange = useCallback((value: string) => {
		setAliasInput(value);
		setAliasError("");
	}, []);

	const handleSetAlias = useCallback(async () => {
		const alias = aliasInput.trim();
		if (!alias) return;
		setAliasSaving(true);
		setAliasError("");
		try {
			const response = await fetch(`/api/towers/${towerId}/alias`, {
				method: "PUT",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ alias }),
			});
			if (!response.ok) {
				const error = (await response.json()) as { error: string };
				setAliasError(error.error || "Failed to set alias");
				return;
			}
			setTowerName(alias);
			setIsRenaming(false);
			window.history.replaceState(null, "", `/${encodeURIComponent(alias)}`);
		} catch {
			setAliasError("Network error");
		} finally {
			setAliasSaving(false);
		}
	}, [aliasInput, setTowerName, towerId]);

	const day = Math.floor(simTime / DAY_TICK_MAX) + 1;
	const dateLabel = formatSimDate(day);
	const timeOfDayLabel = formatSimTimeOfDay(simTime);
	const metrics = buildTransportMetrics(sims, carriers);

	useEffect(() => {
		if (
			selectedTool !== "inspect" &&
			!freeBuild &&
			starCount < getTileStarRequirement(selectedTool)
		) {
			setSelectedTool("floor");
		}
	}, [freeBuild, selectedTool, starCount]);

	return (
		<div style={styles.container}>
			<GameToolbar
				isRenaming={isRenaming}
				aliasInput={aliasInput}
				aliasError={aliasError}
				aliasSaving={aliasSaving}
				towerId={towerId}
				towerName={towerName}
				cash={cash ?? 0}
				population={population}
				starCount={starCount}
				dateLabel={dateLabel}
				timeOfDayLabel={timeOfDayLabel}
				playerCount={playerCount}
				connectionStatus={connectionStatus}
				onAliasInputChange={handleAliasInputChange}
				onRenameStart={handleRenameStart}
				onRenameCancel={handleRenameCancel}
				onRenameSubmit={handleSetAlias}
				onReconnect={reconnect}
				onLeave={onLeave}
			/>

			<div style={styles.canvasWrapper}>
				<PhaserGame
					towerId={towerId}
					onCellClick={handleCellClick}
					onCellInspect={handleCellInspect}
					onQueuedSimInspect={handleQueuedSimInspect}
					selectedTool={selectedTool}
					sceneRef={sceneRef}
				/>
				<div style={styles.rightPanelStack}>
					<GameBuildPanel
						starCount={starCount}
						freeBuild={freeBuild}
						selectedTool={selectedTool}
						onToolSelect={setSelectedTool}
					/>
					{import.meta.env.DEV && (
						<GameDebugPanel
							metrics={metrics}
							speedMultiplier={speedMultiplier}
							onSpeedChange={setSpeedMultiplier}
							starCount={starCount}
							onStarCountChange={setStarCount}
							freeBuild={freeBuild}
							onFreeBuildChange={setFreeBuild}
						/>
					)}
					{selectedTool === "inspect" && <GameInspectPanel sims={sims} />}
				</div>
			</div>

			{activePrompt && (
				<GamePromptModal prompt={activePrompt} onRespond={respondToPrompt} />
			)}

			<CellInspectionDialog
				inspectedCell={inspectedCell}
				sims={sims}
				onClose={() => setInspectedCell(null)}
				onSetRentLevel={setRentLevel}
				onAddElevatorCar={addElevatorCar}
				onRemoveElevatorCar={removeElevatorCar}
				onInspectCell={handleCellInspect}
				onPatchInspectedCell={handlePatchInspectedCell}
			/>

			<SimInspectionDialog
				sim={inspectedSim}
				onClose={() => setInspectedSim(null)}
			/>

			<GameToasts toasts={toasts} />
		</div>
	);
}
