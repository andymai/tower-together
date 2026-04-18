import type { ConnectionStatus } from "../types";
import { gameScreenStyles as styles } from "./gameScreenStyles";

interface Props {
	isRenaming: boolean;
	aliasInput: string;
	aliasError: string;
	aliasSaving: boolean;
	towerId: string;
	towerName: string;
	cash: number;
	dateLabel: string;
	playerCount: number;
	connectionStatus: ConnectionStatus;
	onAliasInputChange: (value: string) => void;
	onRenameStart: () => void;
	onRenameCancel: () => void;
	onRenameSubmit: () => void;
	onReconnect: () => void;
	onLeave: () => void;
}

export function GameToolbar({
	isRenaming,
	aliasInput,
	aliasError,
	aliasSaving,
	towerId,
	towerName,
	cash,
	dateLabel,
	playerCount,
	connectionStatus,
	onAliasInputChange,
	onRenameStart,
	onRenameCancel,
	onRenameSubmit,
	onReconnect,
	onLeave,
}: Props) {
	const statusColor =
		connectionStatus === "connected"
			? "#4ade80"
			: connectionStatus === "connecting"
				? "#facc15"
				: "#f87171";
	const statusText =
		connectionStatus === "connected"
			? "Connected"
			: connectionStatus === "connecting"
				? "Connecting…"
				: "Disconnected";

	return (
		<div style={styles.toolbar}>
			<div style={styles.toolbarLeft}>
				{isRenaming ? (
					<form
						style={styles.renameForm}
						onSubmit={(event) => {
							event.preventDefault();
							onRenameSubmit();
						}}
					>
						<input
							style={styles.renameInput}
							value={aliasInput}
							onChange={(event) => onAliasInputChange(event.target.value)}
							placeholder="alias..."
							disabled={aliasSaving}
						/>
						<button
							style={styles.renameSave}
							type="submit"
							disabled={aliasSaving}
						>
							{aliasSaving ? "..." : "Save"}
						</button>
						<button
							style={styles.renameCancel}
							type="button"
							onClick={onRenameCancel}
						>
							Cancel
						</button>
						{aliasError && <span style={styles.renameError}>{aliasError}</span>}
					</form>
				) : (
					<button
						type="button"
						style={styles.towerLabel}
						title={`${towerName} (click to rename)`}
						onClick={onRenameStart}
					>
						{towerName || towerId}
					</button>
				)}
			</div>

			<div style={styles.toolbarRight}>
				<span style={styles.cashDisplay}>${cash.toLocaleString()}</span>
				<span style={styles.statItem}>{dateLabel}</span>
				<span style={styles.statItem}>
					{playerCount} player{playerCount !== 1 ? "s" : ""}
				</span>
				<span style={styles.toolbarStatus}>
					<span style={{ ...styles.statusDot, background: statusColor }} />
					<span style={styles.statItem}>{statusText}</span>
					{connectionStatus === "disconnected" && (
						<button
							type="button"
							style={styles.reconnectBtn}
							onClick={onReconnect}
						>
							Reconnect
						</button>
					)}
				</span>
				<button type="button" style={styles.leaveBtn} onClick={onLeave}>
					Leave
				</button>
			</div>
		</div>
	);
}
