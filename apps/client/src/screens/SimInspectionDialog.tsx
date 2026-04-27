import type { SimStateData } from "../types";
import { gameScreenStyles as styles } from "./gameScreenStyles";

const FAMILY_LABELS: Record<number, string> = {
	3: "Hotel Guest",
	4: "Hotel Guest",
	5: "Hotel Guest",
	6: "Restaurant Visitor",
	7: "Office Worker",
	9: "Condo Resident",
	10: "Retail Visitor",
	12: "Fast Food Visitor",
	15: "Housekeeping Staff",
	18: "Cinema Visitor",
	20: "Recycling Staff",
	21: "Recycling Staff",
	24: "Driver",
	29: "Party Hall Visitor",
};

const STATE_LABELS: Record<number, string> = {
	0: "Commute",
	1: "Active",
	3: "Arrived",
	4: "Checkout Queue",
	5: "Departure",
	16: "Transition",
	32: "Morning Gate",
	33: "At Work",
	34: "Venue Trip",
	36: "Hotel Parked",
	37: "Night A",
	38: "Night B",
	39: "Parked",
};

const STRESS_LABELS: Record<SimStateData["stressLevel"], string> = {
	low: "Low",
	medium: "Medium",
	high: "High",
};

interface Props {
	sim: SimStateData | null;
	onClose: () => void;
}

function formatFloor(floor: number): string {
	return String(floor - 10);
}

function formatState(code: number): string {
	const inTransit = (code & 0x40) !== 0;
	const baseCode = code & ~0x40;
	const label =
		STATE_LABELS[baseCode] ?? `0x${baseCode.toString(16).padStart(2, "0")}`;
	return inTransit ? `${label} (Transit)` : label;
}

export function SimInspectionDialog({ sim, onClose }: Props) {
	if (!sim) return null;

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
						{FAMILY_LABELS[sim.familyCode] ?? "Queued Sim"}
					</span>
					<button type="button" style={styles.inspectClose} onClick={onClose}>
						&times;
					</button>
				</div>

				<div style={styles.inspectSection}>
					<div style={styles.inspectRow}>
						<span style={styles.inspectLabel}>Sim</span>
						<span style={styles.inspectValue}>{sim.id.slice(0, 8)}</span>
					</div>
					<div style={styles.inspectRow}>
						<span style={styles.inspectLabel}>Current Trip Stress</span>
						<span style={styles.inspectValue}>
							{sim.currentTripStressTicks} (
							{STRESS_LABELS[sim.currentTripStressLevel]})
						</span>
					</div>
					<div style={styles.inspectRow}>
						<span style={styles.inspectLabel}>Trip Average Stress</span>
						<span style={styles.inspectValue}>
							{sim.averageTripStressTicks}
						</span>
					</div>
					<div style={styles.inspectRow}>
						<span style={styles.inspectLabel}>State</span>
						<span style={styles.inspectValue}>
							{formatState(sim.stateCode)}
						</span>
					</div>
				</div>

				<div style={styles.inspectSection}>
					<div style={styles.inspectRow}>
						<span style={styles.inspectLabel}>From Floor</span>
						<span style={styles.inspectValue}>
							{formatFloor(sim.floorAnchor)}
						</span>
					</div>
					<div style={styles.inspectRow}>
						<span style={styles.inspectLabel}>To Floor</span>
						<span style={styles.inspectValue}>
							{formatFloor(sim.selectedFloor)}
						</span>
					</div>
					<div style={styles.inspectRow}>
						<span style={styles.inspectLabel}>Home Column</span>
						<span style={styles.inspectValue}>{sim.homeColumn}</span>
					</div>
				</div>

				<div style={styles.inspectSection}>
					<div style={styles.inspectRow}>
						<span style={styles.inspectLabel}>Trips</span>
						<span style={styles.inspectValue}>{sim.tripCount}</span>
					</div>
					<div style={styles.inspectRow}>
						<span style={styles.inspectLabel}>Stored Elapsed</span>
						<span style={styles.inspectValue}>{sim.elapsedTicks}</span>
					</div>
					<div style={styles.inspectRow}>
						<span style={styles.inspectLabel}>Accumulated</span>
						<span style={styles.inspectValue}>{sim.accumulatedTicks}</span>
					</div>
				</div>
			</div>
		</div>
	);
}
