import { Star } from "lucide-react";
import { forwardRef, memo, useImperativeHandle, useRef } from "react";
import type { ConnectionStatus } from "../types";
import { DAY_TICK_MAX } from "../types";
import { gameScreenStyles as styles } from "./gameScreenStyles";

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
		(daypartIndex === 0 && hours12 < 12) ||
		(daypartIndex === 5 && hours12 < 9) ||
		daypartIndex === 6
			? "AM"
			: "PM";
	return `${hours12}:${minutes.toString().padStart(2, "0")} ${suffix}`;
}

export interface GameToolbarClockHandle {
	update: (simTime: number) => void;
	updateEconomy: (cash: number, population: number) => void;
}

interface Props {
	isRenaming: boolean;
	aliasInput: string;
	aliasError: string;
	aliasSaving: boolean;
	towerId: string;
	towerName: string;
	starCount: number;
	playerCount: number;
	connectionStatus: ConnectionStatus;
	onAliasInputChange: (value: string) => void;
	onRenameStart: () => void;
	onRenameCancel: () => void;
	onRenameSubmit: () => void;
	onReconnect: () => void;
	onLeave: () => void;
}

export const GameToolbar = memo(
	forwardRef<GameToolbarClockHandle, Props>(function GameToolbar(
		{
			isRenaming,
			aliasInput,
			aliasError,
			aliasSaving,
			towerId,
			towerName,
			starCount,
			playerCount,
			connectionStatus,
			onAliasInputChange,
			onRenameStart,
			onRenameCancel,
			onRenameSubmit,
			onReconnect,
			onLeave,
		}: Props,
		ref,
	) {
		const dateSpanRef = useRef<HTMLSpanElement>(null);
		const timeSpanRef = useRef<HTMLSpanElement>(null);
		const cashSpanRef = useRef<HTMLSpanElement>(null);
		const popSpanRef = useRef<HTMLSpanElement>(null);

		useImperativeHandle(
			ref,
			() => ({
				updateEconomy(cash: number, population: number) {
					if (cashSpanRef.current) {
						cashSpanRef.current.textContent = `$${cash.toLocaleString()}`;
					}
					if (popSpanRef.current) {
						popSpanRef.current.textContent = `Pop ${population.toLocaleString()}`;
					}
				},
				update(simTime: number) {
					const day = Math.floor(simTime / DAY_TICK_MAX) + 1;
					const dayTick =
						((simTime % DAY_TICK_MAX) + DAY_TICK_MAX) % DAY_TICK_MAX;
					if (dateSpanRef.current) {
						dateSpanRef.current.textContent = formatSimDate(day);
					}
					if (timeSpanRef.current) {
						const timeText = formatSimTimeOfDay(simTime);
						timeSpanRef.current.textContent = import.meta.env.DEV
							? `${timeText} (${dayTick})`
							: timeText;
					}
				},
			}),
			[],
		);
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
							{aliasError && (
								<span style={styles.renameError}>{aliasError}</span>
							)}
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
					<span style={styles.cashCluster}>
						<span ref={cashSpanRef} style={styles.cashDisplay} />
						<span ref={popSpanRef} style={styles.populationDisplay} />
						<span
							style={styles.starDisplay}
							role="img"
							aria-label={`Tower rating ${starCount} of 5`}
						>
							{[1, 2, 3, 4, 5].map((slot) => {
								return (
									<Star
										key={`star-${slot}`}
										size={14}
										strokeWidth={1.8}
										fill={slot <= starCount ? "currentColor" : "none"}
									/>
								);
							})}
						</span>
					</span>
					<span ref={dateSpanRef} style={styles.calendarItem} />
					<span ref={timeSpanRef} style={styles.calendarItem} />
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
	}),
);
