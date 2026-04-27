import {
	CINEMA_CLASSIC_MOVIE_COST,
	CINEMA_NEW_MOVIE_COST,
	MOVIE_TITLES,
} from "../../../worker/src/sim/resources";
import type { LobbyMode } from "../../../worker/src/sim/world";
import {
	CARRIER_CAR_CONSTRUCTION_COST,
	type CarrierCarStateData,
	GRID_HEIGHT,
	type SimStateData,
} from "../types";
import { gameScreenStyles as styles } from "./gameScreenStyles";
import type { CellInfoData } from "./gameScreenTypes";

// Rent per checkout/activation event, indexed by rent level (0=highest → 3=lowest).
// Mirrors YEN_1001 in apps/worker/src/sim/resources.ts.
const RENT_AMOUNTS_BY_FAMILY: Record<number, number[]> = {
	3: [3000, 2000, 1500, 500],
	4: [4500, 3000, 2000, 800],
	5: [9000, 6000, 4000, 1500],
	7: [15000, 10000, 5000, 2000],
	9: [200000, 150000, 100000, 40000],
	10: [20000, 15000, 10000, 4000],
};
const CARRIER_MODE_LABELS: Record<number, string> = {
	0: "Express",
	1: "Standard",
	2: "Service",
};
const RENT_ADJUSTABLE_FAMILIES = new Set(
	Object.keys(RENT_AMOUNTS_BY_FAMILY).map(Number),
);
const FAMILY_LABELS: Record<number, string> = {
	3: "Hotel (Single)",
	4: "Hotel (Twin)",
	5: "Hotel (Suite)",
	6: "Restaurant",
	7: "Office",
	9: "Condo",
	10: "Retail",
	12: "Fast Food",
	18: "Cinema",
	20: "Security",
	21: "Housekeeping",
	29: "Party Hall",
};

const HOTEL_FAMILIES = new Set([3, 4, 5]);

function getFacilityStatus(info: {
	objectTypeCode: number;
	unitStatus: number;
	venueAvailability?: number;
	housekeepingClaimedFlag?: number;
}): string | null {
	if (HOTEL_FAMILIES.has(info.objectTypeCode)) {
		if (info.unitStatus < 0x18) return "Occupied";
		if (info.unitStatus < 0x28) return "Vacant";
		if (info.unitStatus >= 0x38) return "Infested";
		if (info.housekeepingClaimedFlag) return "Dirty (being cleaned)";
		return "Dirty";
	}
	if (info.objectTypeCode === 9) {
		return info.unitStatus > 0x17 ? "For Sale" : "Sold";
	}
	if (info.objectTypeCode === 7) {
		return info.unitStatus > 0x0f ? "For Rent" : "Occupied";
	}
	if (info.objectTypeCode === 10) {
		return info.venueAvailability === 0xff ? "Unrented" : "Open";
	}
	return null;
}

const STRESS_COLORS: Record<SimStateData["stressLevel"], string> = {
	low: "#4ade80",
	medium: "#facc15",
	high: "#f87171",
};

interface Props {
	inspectedCell: CellInfoData | null;
	sims: SimStateData[];
	carriers: CarrierCarStateData[];
	lobbyMode: LobbyMode;
	onClose: () => void;
	onSetRentLevel: (x: number, y: number, rentLevel: number) => void;
	onAddElevatorCar: (x: number, y: number) => void;
	onRemoveElevatorCar: (x: number) => void;
	onSetElevatorDwellDelay: (x: number, value: number) => void;
	onSetElevatorWaitingCarResponse: (x: number, value: number) => void;
	onSetElevatorHomeFloor: (x: number, carIndex: number, floor: number) => void;
	onToggleElevatorFloorStop: (x: number, floor: number) => void;
	onSetCinemaMoviePool: (x: number, y: number, pool: "classic" | "new") => void;
	onInspectCell: (x: number, y: number) => void;
	onPatchInspectedCell: (updater: (cell: CellInfoData) => CellInfoData) => void;
}

export function CellInspectionDialog({
	inspectedCell,
	sims,
	carriers,
	lobbyMode,
	onClose,
	onSetRentLevel,
	onAddElevatorCar,
	onRemoveElevatorCar,
	onSetElevatorDwellDelay,
	onSetElevatorWaitingCarResponse,
	onSetElevatorHomeFloor,
	onToggleElevatorFloorStop,
	onSetCinemaMoviePool,
	onInspectCell,
	onPatchInspectedCell,
}: Props) {
	if (
		!inspectedCell ||
		(!inspectedCell.objectInfo && !inspectedCell.carrierInfo)
	) {
		return null;
	}

	return (
		<div style={styles.modalOverlay}>
			<button
				type="button"
				aria-label="Close dialog"
				style={styles.modalBackdrop}
				onClick={onClose}
			/>
			<div
				role="dialog"
				aria-modal="true"
				style={styles.inspectDialog}
				onClick={(event) => event.stopPropagation()}
				onKeyDown={() => {}}
			>
				<div style={styles.inspectHeader}>
					<span style={styles.inspectTitle}>
						{inspectedCell.carrierInfo
							? `${CARRIER_MODE_LABELS[inspectedCell.carrierInfo.carrierMode] ?? "Elevator"} Elevator`
							: (FAMILY_LABELS[
									inspectedCell.objectInfo?.objectTypeCode ?? -1
								] ?? inspectedCell.tileType)}
					</span>
					<button type="button" style={styles.inspectClose} onClick={onClose}>
						&times;
					</button>
				</div>

				{inspectedCell.objectInfo &&
					getFacilityStatus(inspectedCell.objectInfo) && (
						<div style={styles.inspectSection}>
							<div style={styles.inspectRow}>
								<span style={styles.inspectLabel}>Status</span>
								<span style={styles.inspectValue}>
									{getFacilityStatus(inspectedCell.objectInfo)}
								</span>
							</div>
						</div>
					)}

				{!inspectedCell.carrierInfo && inspectedCell.cinemaInfo && (
					<div style={styles.inspectSection}>
						<div style={styles.inspectRow}>
							<span style={styles.inspectLabel}>Now Playing</span>
							<span style={styles.inspectValue}>
								{MOVIE_TITLES[inspectedCell.cinemaInfo.selector] ??
									`#${inspectedCell.cinemaInfo.selector}`}
							</span>
						</div>
						<div style={styles.inspectRow}>
							<span style={styles.inspectLabel}>Length of Showing</span>
							<span style={styles.inspectValue}>
								{inspectedCell.cinemaInfo.linkAgeCounter} day
								{inspectedCell.cinemaInfo.linkAgeCounter === 1 ? "" : "s"}
							</span>
						</div>
						<div style={styles.inspectRow}>
							<span style={styles.inspectLabel}>Attendance</span>
							<span style={styles.inspectValue}>
								{inspectedCell.cinemaInfo.attendanceCounter}
							</span>
						</div>
						<div style={styles.carButtons}>
							<button
								type="button"
								style={styles.carButton}
								onClick={() => {
									onSetCinemaMoviePool(
										inspectedCell.x,
										inspectedCell.y,
										"classic",
									);
								}}
							>
								Show a classic ($
								{CINEMA_CLASSIC_MOVIE_COST.toLocaleString()})
							</button>
							<button
								type="button"
								style={styles.carButton}
								onClick={() => {
									onSetCinemaMoviePool(inspectedCell.x, inspectedCell.y, "new");
								}}
							>
								Show a new movie ($
								{CINEMA_NEW_MOVIE_COST.toLocaleString()})
							</button>
						</div>
					</div>
				)}

				{!inspectedCell.carrierInfo &&
					inspectedCell.objectInfo &&
					RENT_ADJUSTABLE_FAMILIES.has(
						inspectedCell.objectInfo.objectTypeCode,
					) && (
						<div style={styles.inspectSection}>
							<div style={styles.inspectLabel}>
								{inspectedCell.objectInfo.objectTypeCode === 9
									? "Sale Price"
									: "Rent"}
							</div>
							<div style={styles.rentButtons}>
								{RENT_AMOUNTS_BY_FAMILY[
									inspectedCell.objectInfo.objectTypeCode
								]?.map((amount, index) => (
									<button
										type="button"
										key={amount}
										style={{
											...styles.rentButton,
											...(inspectedCell.objectInfo?.rentLevel === index
												? styles.rentButtonActive
												: {}),
										}}
										onClick={() => {
											onSetRentLevel(inspectedCell.x, inspectedCell.y, index);
											onPatchInspectedCell((cell) => ({
												...cell,
												objectInfo: cell.objectInfo
													? { ...cell.objectInfo, rentLevel: index }
													: undefined,
											}));
										}}
									>
										${amount.toLocaleString()}
									</button>
								))}
							</div>
						</div>
					)}

				{inspectedCell.carrierInfo &&
					(() => {
						const ci = inspectedCell.carrierInfo;
						const carrierId = ci.carrierId;
						const activeCars = carriers.filter(
							(c) => c.carrierId === carrierId && c.active,
						);
						const { servedFloors, stopFloorEnabled, carInfos } = ci;
						// Express elevators only stop at basement/ground (floors 1–10)
						// and sky lobbies — hide other floors. The sky-lobby cadence
						// follows the world's lobbyMode: perfect-parity → +14 offset,
						// modern → +0 offset within each 15-floor cycle above ground.
						const expressCycleOffset = lobbyMode === "modern" ? 0 : 14;
						const displayFloors =
							ci.carrierMode === 0
								? servedFloors
										.map((floor, fwdIdx) => ({ floor, fwdIdx }))
										.filter(
											({ floor }) =>
												floor <= 10 || (floor - 10) % 15 === expressCycleOffset,
										)
								: servedFloors.map((floor, fwdIdx) => ({ floor, fwdIdx }));

						return (
							<>
								<div style={styles.inspectSection}>
									<div style={styles.inspectRow}>
										<span style={styles.inspectLabel}>Mode</span>
										<span style={styles.inspectValue}>
											{CARRIER_MODE_LABELS[ci.carrierMode] ?? "Unknown"}
										</span>
									</div>
									<div style={styles.inspectRow}>
										<span style={styles.inspectLabel}>Floors</span>
										<span style={styles.inspectValue}>
											{ci.bottomServedFloor - 10} to {ci.topServedFloor - 10}
										</span>
									</div>
								</div>

								{/* Car grid */}
								<div style={styles.inspectSection}>
									<div
										style={{
											maxHeight: 240,
											overflowY: "auto",
											border: "1px solid #333",
											borderRadius: 4,
										}}
									>
										{/* Header row */}
										<div
											style={{
												display: "flex",
												background: "#222",
												borderBottom: "1px solid #333",
												position: "sticky",
												top: 0,
												zIndex: 1,
											}}
										>
											<div style={elevatorGridCell}>
												<span style={{ color: "#888", fontSize: 10 }}>fl</span>
											</div>
											<div style={elevatorGridCell}>
												<span style={{ color: "#888", fontSize: 10 }}>
													stop
												</span>
											</div>
											{activeCars.map((car) => (
												<div key={car.carIndex} style={elevatorGridCell}>
													<span style={{ color: "#888", fontSize: 10 }}>
														{car.carIndex + 1}
													</span>
												</div>
											))}
										</div>
										{/* Floor rows — top to bottom */}
										{[...displayFloors].reverse().map(({ floor, fwdIdx }) => {
											const isStop = stopFloorEnabled[fwdIdx] ?? true;
											return (
												<div
													key={floor}
													style={{
														display: "flex",
														borderBottom: "1px solid #2a2a2a",
													}}
												>
													{/* Floor number */}
													<div style={elevatorGridCell}>
														<span style={{ color: "#888", fontSize: 10 }}>
															{floor - 10}
														</span>
													</div>
													{/* Stop toggle */}
													<button
														type="button"
														style={{
															...elevatorGridCell,
															cursor: "pointer",
															background: "transparent",
															border: "none",
															color: isStop ? "#4ade80" : "#555",
															fontSize: 12,
														}}
														onClick={() => {
															onToggleElevatorFloorStop(ci.column, floor);
															onPatchInspectedCell((cell) => {
																if (!cell.carrierInfo) return cell;
																const next = [
																	...cell.carrierInfo.stopFloorEnabled,
																];
																next[fwdIdx] = !next[fwdIdx];
																return {
																	...cell,
																	carrierInfo: {
																		...cell.carrierInfo,
																		stopFloorEnabled: next,
																	},
																};
															});
														}}
													>
														{isStop ? "●" : "○"}
													</button>
													{/* Per-car cells */}
													{activeCars.map((car) => {
														const isHere = car.currentFloor === floor;
														const homeFloor =
															carInfos[car.carIndex]?.homeFloor ?? floor;
														const isHome = homeFloor === floor;
														return (
															<button
																type="button"
																key={car.carIndex}
																style={{
																	...elevatorGridCell,
																	cursor: "pointer",
																	background: isHome
																		? "rgba(74,222,128,0.08)"
																		: "transparent",
																	border: "none",
																	color: isHere
																		? "#fff"
																		: isHome
																			? "#4ade80"
																			: "transparent",
																	fontSize: 12,
																}}
																title={`Set car ${car.carIndex + 1} home to floor ${floor - 10}`}
																onClick={() => {
																	onSetElevatorHomeFloor(
																		ci.column,
																		car.carIndex,
																		floor,
																	);
																	onPatchInspectedCell((cell) => {
																		if (!cell.carrierInfo) return cell;
																		const next = cell.carrierInfo.carInfos.map(
																			(info, i) =>
																				i === car.carIndex
																					? { ...info, homeFloor: floor }
																					: info,
																		);
																		return {
																			...cell,
																			carrierInfo: {
																				...cell.carrierInfo,
																				carInfos: next,
																			},
																		};
																	});
																}}
															>
																{isHere
																	? car.directionFlag === 1
																		? "▲"
																		: "▼"
																	: isHome
																		? "─"
																		: "·"}
															</button>
														);
													})}
												</div>
											);
										})}
									</div>
								</div>

								{/* Cars add/remove */}
								<div style={styles.inspectSection}>
									<div style={styles.inspectRow}>
										<span style={styles.inspectLabel}>Cars</span>
										<span style={styles.inspectValue}>
											{ci.carCount} / {ci.maxCars}
										</span>
									</div>
									<div style={styles.carButtons}>
										<button
											type="button"
											style={{
												...styles.carButton,
												...(ci.carCount >= 8 ? styles.carButtonDisabled : {}),
											}}
											disabled={ci.carCount >= 8}
											onClick={() => {
												onAddElevatorCar(ci.column, inspectedCell.y);
												onInspectCell(ci.column, inspectedCell.y);
											}}
										>
											+ Add Car ($
											{(
												CARRIER_CAR_CONSTRUCTION_COST[ci.carrierMode] ?? 0
											).toLocaleString()}
											)
										</button>
										<button
											type="button"
											style={{
												...styles.carButton,
												...(activeCars.length <= 1
													? styles.carButtonDisabled
													: {}),
											}}
											disabled={activeCars.length <= 1}
											onClick={() => {
												onRemoveElevatorCar(ci.column);
												onInspectCell(ci.column, inspectedCell.y);
											}}
										>
											- Remove Car
										</button>
									</div>
								</div>

								{/* Dwell Delay */}
								<div style={styles.inspectSection}>
									<div style={styles.inspectLabel}>Dwell Delay</div>
									<div style={styles.carButtons}>
										{[0, 1, 2, 3, 4, 5].map((v) => (
											<button
												type="button"
												key={v}
												style={{
													...styles.carButton,
													...(ci.dwellDelay === v
														? styles.carButtonActive
														: {}),
												}}
												onClick={() => {
													onSetElevatorDwellDelay(ci.column, v);
													onPatchInspectedCell((cell) => ({
														...cell,
														carrierInfo: cell.carrierInfo
															? { ...cell.carrierInfo, dwellDelay: v }
															: undefined,
													}));
												}}
											>
												{v === 0 ? "Instant" : `${v * 30}t`}
											</button>
										))}
									</div>
								</div>

								{/* Waiting Car Response */}
								<div style={styles.inspectSection}>
									<div style={styles.inspectRow}>
										<span style={styles.inspectLabel}>
											Waiting Car Response
										</span>
										<input
											type="number"
											min={0}
											max={99}
											value={ci.waitingCarResponseThreshold}
											style={{
												width: 52,
												background: "#2a2a2a",
												border: "1px solid #555",
												borderRadius: 4,
												color: "#e0e0e0",
												fontSize: 12,
												padding: "3px 6px",
												textAlign: "right",
											}}
											onChange={(e) => {
												const v = Math.max(
													0,
													Math.min(99, Number(e.target.value) || 0),
												);
												onSetElevatorWaitingCarResponse(ci.column, v);
												onPatchInspectedCell((cell) => ({
													...cell,
													carrierInfo: cell.carrierInfo
														? {
																...cell.carrierInfo,
																waitingCarResponseThreshold: v,
															}
														: undefined,
												}));
											}}
										/>
									</div>
								</div>
							</>
						);
					})()}

				{!inspectedCell.carrierInfo &&
					(() => {
						const floor = GRID_HEIGHT - 1 - inspectedCell.y;
						const facilitySims = sims.filter(
							(e) =>
								e.homeColumn === inspectedCell.anchorX &&
								e.floorAnchor === floor,
						);
						if (facilitySims.length === 0) return null;
						const totalTrips = facilitySims.reduce(
							(s, e) => s + e.tripCount,
							0,
						);
						const avgStress =
							facilitySims.reduce(
								(s, e) =>
									s + (e.tripCount > 0 ? e.accumulatedTicks / e.tripCount : 0),
								0,
							) / facilitySims.length;
						return (
							<div style={styles.inspectSection}>
								<div style={styles.inspectLabel}>
									Sims ({facilitySims.length})
								</div>
								<div style={{ ...styles.inspectRow, color: "#e0e0e0" }}>
									<span>Total trips</span>
									<strong>{totalTrips}</strong>
								</div>
								<div style={{ ...styles.inspectRow, color: "#e0e0e0" }}>
									<span>Avg stress</span>
									<strong>{avgStress.toFixed(1)}</strong>
								</div>
								<div style={{ maxHeight: 120, overflowY: "auto" }}>
									{facilitySims.map((e) => (
										<div key={e.id} style={styles.inspectRow}>
											<span style={{ color: "#e0e0e0" }}>
												{e.id.slice(0, 6)} · {e.tripCount}t
											</span>
											<span
												style={{
													color: STRESS_COLORS[e.stressLevel],
												}}
											>
												{e.elapsedTicks}
											</span>
										</div>
									))}
								</div>
							</div>
						);
					})()}
			</div>
		</div>
	);
}

const elevatorGridCell: React.CSSProperties = {
	width: 28,
	minWidth: 28,
	height: 22,
	display: "flex",
	alignItems: "center",
	justifyContent: "center",
	flexShrink: 0,
};
