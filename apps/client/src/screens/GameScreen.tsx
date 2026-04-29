import { useCallback, useEffect, useRef, useState } from "react";
import type { GameScene } from "../game/GameScene";
import { PhaserGame } from "../game/PhaserGame";
import { buildTransportMetrics } from "../game/transportSelectors";
import type { TowerSocket } from "../lib/socket";
import type { SelectedTool, SimStateData } from "../types";
import { getTileStarRequirement } from "../types";
import { CellInspectionDialog } from "./CellInspectionDialog";
import { GameBuildPanel } from "./GameBuildPanel";
import { GameDebugPanel } from "./GameDebugPanel";
import { GamePromptModal } from "./GamePromptModal";
import { GameToasts } from "./GameToasts";
import type { GameToolbarClockHandle } from "./GameToolbar";
import { GameToolbar } from "./GameToolbar";
import { gameScreenStyles as styles } from "./gameScreenStyles";
import type { Toast } from "./gameScreenTypes";
import { SimInspectionDialog } from "./SimInspectionDialog";
import { StarUpgradeDialog } from "./StarUpgradeDialog";
import { useTowerSession } from "./useTowerSession";

interface Props {
	playerId: string;
	displayName: string;
	socket: TowerSocket;
	towerId: string;
	initialTool?: SelectedTool;
	onLeave: () => void;
}

let toastCounter = 0;

export function GameScreen({
	playerId,
	displayName,
	socket,
	towerId,
	initialTool,
	onLeave,
}: Props) {
	const [selectedTool, setSelectedTool] = useState<SelectedTool>(
		initialTool ?? "inspect",
	);
	const [isRenaming, setIsRenaming] = useState(false);
	const [aliasInput, setAliasInput] = useState("");
	const [aliasError, setAliasError] = useState("");
	const [aliasSaving, setAliasSaving] = useState(false);
	const [toasts, setToasts] = useState<Toast[]>([]);
	const [inspectedSim, setInspectedSim] = useState<SimStateData | null>(null);
	const [stressBadgesEnabled, setStressBadgesEnabled] = useState(true);
	const [soundMuted, setSoundMuted] = useState(false);
	const [pendingShaftErase, setPendingShaftErase] = useState<{
		x: number;
		topY: number;
		bottomY: number;
	} | null>(null);
	const sceneRef = useRef<GameScene | null>(null);
	const clockRef = useRef<GameToolbarClockHandle | null>(null);
	const lastCashRef = useRef<number | null>(null);

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
		starCount,
		playerCount,
		towerName,
		setTowerName,
		sims,
		carriers,
		speedMultiplier,
		freeBuild,
		activePrompt,
		starUpgrade,
		dismissStarUpgrade,
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
		removeElevatorShaft,
		setElevatorDwellDelay,
		setElevatorWaitingCarResponse,
		setElevatorHomeFloor,
		toggleElevatorFloorStop,
		setCinemaMoviePool,
		reconnect,
		sceneReady,
		lobbyExists,
		lobbyMode,
	} = useTowerSession({
		towerId,
		playerId,
		displayName,
		socket,
		sceneRef,
		addToast,
		onSimTime: (simTime) => clockRef.current?.update(simTime),
		onEconomy: (cash, population) => {
			clockRef.current?.updateEconomy(cash, population);
			const prev = lastCashRef.current;
			if (prev !== null && cash > prev) sceneRef.current?.playKaching();
			lastCashRef.current = cash;
		},
	});

	const handleCellClick = useCallback(
		(x: number, y: number, shift: boolean) => {
			setInspectedSim(null);
			if (selectedTool === "inspect") {
				inspectCell(x, y);
				return;
			}
			if (selectedTool === "empty") {
				const shaft = sceneRef.current?.getElevatorShaftAt(x, y);
				if (shaft && y !== shaft.topY && y !== shaft.bottomY) {
					setPendingShaftErase({
						x,
						topY: shaft.topY,
						bottomY: shaft.bottomY,
					});
					return;
				}
			}
			sendTileCommand(x, y, selectedTool, shift);
		},
		[selectedTool, sendTileCommand, inspectCell],
	);

	const handleConfirmShaftErase = useCallback(() => {
		if (!pendingShaftErase) return;
		removeElevatorShaft(
			pendingShaftErase.x,
			pendingShaftErase.topY,
			pendingShaftErase.bottomY,
		);
		setPendingShaftErase(null);
	}, [pendingShaftErase, removeElevatorShaft]);

	const handleCancelShaftErase = useCallback(() => {
		setPendingShaftErase(null);
	}, []);

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

	useEffect(() => {
		if (
			selectedTool !== "inspect" &&
			!freeBuild &&
			starCount < getTileStarRequirement(selectedTool)
		) {
			setSelectedTool("inspect");
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
				ref={clockRef}
				starCount={starCount}
				playerCount={playerCount}
				connectionStatus={connectionStatus}
				speedMultiplier={speedMultiplier}
				soundMuted={soundMuted}
				onSpeedChange={setSpeedMultiplier}
				onSoundMutedChange={setSoundMuted}
				onAliasInputChange={handleAliasInputChange}
				onRenameStart={handleRenameStart}
				onRenameCancel={handleRenameCancel}
				onRenameSubmit={handleSetAlias}
				onReconnect={reconnect}
				onLeave={onLeave}
			/>

			<div style={styles.canvasWrapper}>
				{!sceneReady && (
					<div style={styles.loadingOverlay}>
						<div style={styles.loadingSpinner} />
					</div>
				)}
				<PhaserGame
					towerId={towerId}
					onCellClick={handleCellClick}
					onCellInspect={handleCellInspect}
					onQueuedSimInspect={handleQueuedSimInspect}
					selectedTool={selectedTool}
					stressBadgesEnabled={stressBadgesEnabled}
					soundMuted={soundMuted}
					sceneRef={sceneRef}
				/>
				{sceneReady && initialTool === "lobby" && !lobbyExists && (
					<div style={styles.tutorialOverlay}>
						<div style={styles.tutorialBanner}>
							<div style={styles.tutorialTitle}>Welcome to your tower</div>
							<div style={styles.tutorialMessage}>
								Click the highlighted ground floor below to build your first
								Lobby.
							</div>
							<div style={styles.tutorialHint}>
								Tip: Hold Shift while clicking to batch-build a row of tiles.
							</div>
						</div>
						<div style={styles.tutorialArrow}>▼</div>
					</div>
				)}
				<div style={styles.rightPanelStack}>
					<GameBuildPanel
						starCount={starCount}
						freeBuild={freeBuild}
						selectedTool={selectedTool}
						onToolSelect={setSelectedTool}
					/>
					{import.meta.env.DEV && (
						<GameDebugPanel
							metrics={buildTransportMetrics(sims, carriers)}
							starCount={starCount}
							onStarCountChange={setStarCount}
							freeBuild={freeBuild}
							onFreeBuildChange={setFreeBuild}
							stressBadgesEnabled={stressBadgesEnabled}
							onStressBadgesEnabledChange={setStressBadgesEnabled}
						/>
					)}
				</div>
			</div>

			{activePrompt && (
				<GamePromptModal prompt={activePrompt} onRespond={respondToPrompt} />
			)}

			{starUpgrade && (
				<StarUpgradeDialog
					newStarCount={starUpgrade.newStarCount}
					onDismiss={dismissStarUpgrade}
				/>
			)}

			{pendingShaftErase && (
				<div style={{ ...styles.modalOverlay, zIndex: 300 }}>
					<div style={styles.modal}>
						<div style={styles.modalTitle}>Delete elevator shaft?</div>
						<div style={styles.modalMessage}>
							Erasing a middle floor will remove the entire shaft from floor{" "}
							{pendingShaftErase.topY} to {pendingShaftErase.bottomY}.
						</div>
						<div style={styles.modalButtons}>
							<button
								type="button"
								style={styles.modalAccept}
								onClick={handleConfirmShaftErase}
							>
								Delete shaft
							</button>
							<button
								type="button"
								style={styles.modalDecline}
								onClick={handleCancelShaftErase}
							>
								Cancel
							</button>
						</div>
					</div>
				</div>
			)}

			<CellInspectionDialog
				inspectedCell={inspectedCell}
				sims={sims}
				carriers={carriers}
				lobbyMode={lobbyMode}
				onClose={() => setInspectedCell(null)}
				onSetRentLevel={setRentLevel}
				onAddElevatorCar={addElevatorCar}
				onRemoveElevatorCar={removeElevatorCar}
				onSetElevatorDwellDelay={setElevatorDwellDelay}
				onSetElevatorWaitingCarResponse={setElevatorWaitingCarResponse}
				onSetElevatorHomeFloor={setElevatorHomeFloor}
				onToggleElevatorFloorStop={toggleElevatorFloorStop}
				onSetCinemaMoviePool={setCinemaMoviePool}
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
