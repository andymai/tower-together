import type { EntityStateData } from "../types";
import { gameScreenStyles as styles } from "./gameScreenStyles";

interface Props {
	entities: EntityStateData[];
}

const STATE_LABELS: Record<number, string> = {
	0: "Commute",
	1: "Active",
	3: "Arrived",
	4: "CheckoutQ",
	5: "Departure",
	16: "Transition",
	32: "MorningGate",
	33: "AtWork",
	34: "VenueTrip",
	36: "HotelPark",
	37: "NightA",
	38: "NightB",
	39: "Parked",
};

const STRESS_VALUE: Record<EntityStateData["stressLevel"], number> = {
	low: 0,
	medium: 1,
	high: 2,
};

function stateLabel(code: number): string {
	const inTransit = code & 0x40;
	code &= ~0x40;
	return (
		STATE_LABELS[code] ??
		`0x${code.toString(16).padStart(2, "0")}${inTransit ? " (T)" : ""}`
	);
}

export function GameInspectPanel({ entities }: Props) {
	const avgStress =
		entities.length > 0
			? entities.reduce((sum, e) => sum + STRESS_VALUE[e.stressLevel], 0) /
				entities.length
			: 0;

	return (
		<div style={styles.inspectPanel}>
			<div style={styles.debugTitle}>Inspect</div>
			<div style={styles.debugRow}>
				<span>Population</span>
				<strong>{entities.length}</strong>
			</div>
			<div style={styles.debugRow}>
				<span>Avg stress</span>
				<strong>{avgStress.toFixed(2)}</strong>
			</div>
			<div style={inspectListStyle}>
				{entities.map((e) => (
					<div key={e.id} style={styles.debugRow}>
						<span>
							{e.id.slice(0, 6)} · {stateLabel(e.stateCode)}
						</span>
						<span style={stressColorStyle[e.stressLevel]}>{e.stressLevel}</span>
					</div>
				))}
			</div>
		</div>
	);
}

const inspectListStyle: React.CSSProperties = {
	maxHeight: 300,
	overflowY: "auto",
	display: "flex",
	flexDirection: "column",
	gap: 2,
};

const stressColorStyle: Record<
	EntityStateData["stressLevel"],
	React.CSSProperties
> = {
	low: { color: "#4ade80" },
	medium: { color: "#facc15" },
	high: { color: "#f87171" },
};
