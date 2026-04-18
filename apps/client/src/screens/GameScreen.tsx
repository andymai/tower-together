import { useCallback, useRef, useState } from "react";
import type { GameScene } from "../game/GameScene";
import { PhaserGame } from "../game/PhaserGame";
import { buildTransportMetrics } from "../game/transportSelectors";
import type { TowerSocket } from "../lib/socket";
import type { SelectedTool } from "../types";
import { DAY_TICK_MAX } from "../types";
import { CellInspectionDialog } from "./CellInspectionDialog";
import { GameBuildPanel } from "./GameBuildPanel";
import { GameDebugPanel } from "./GameDebugPanel";
import { GameInspectPanel } from "./GameInspectPanel";
import { GamePromptModal } from "./GamePromptModal";
import { GameToasts } from "./GameToasts";
import { GameToolbar } from "./GameToolbar";
import { gameScreenStyles as styles } from "./gameScreenStyles";
import type { Toast } from "./gameScreenTypes";
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
			if (selectedTool === "inspect") {
				inspectCell(x, y);
				return;
			}
			sendTileCommand(x, y, selectedTool, shift);
		},
		[selectedTool, sendTileCommand, inspectCell],
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
		const alias = aliasInput.trim().toLowerCase();
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
			window.history.replaceState(null, "", `/${alias}`);
		} catch {
			setAliasError("Network error");
		} finally {
			setAliasSaving(false);
		}
	}, [aliasInput, setTowerName, towerId]);

	const day = Math.floor(simTime / DAY_TICK_MAX) + 1;
	const dateLabel = formatSimDate(day);
	const metrics = buildTransportMetrics(sims, carriers);

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
				dateLabel={dateLabel}
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
					onCellInspect={inspectCell}
					selectedTool={selectedTool}
					sceneRef={sceneRef}
				/>
				<div style={styles.rightPanelStack}>
					<GameBuildPanel
						selectedTool={selectedTool}
						onToolSelect={setSelectedTool}
					/>
					{import.meta.env.DEV && (
						<GameDebugPanel
							metrics={metrics}
							speedMultiplier={speedMultiplier}
							onSpeedChange={setSpeedMultiplier}
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
				onInspectCell={inspectCell}
				onPatchInspectedCell={handlePatchInspectedCell}
			/>

			<GameToasts toasts={toasts} />
		</div>
	);
}
