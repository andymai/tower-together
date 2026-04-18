import type { TransportMetrics } from "../game/transportSelectors";
import { gameScreenStyles as styles } from "./gameScreenStyles";

interface Props {
	metrics: TransportMetrics;
	speedMultiplier: 1 | 3 | 10;
	onSpeedChange: (multiplier: 1 | 3 | 10) => void;
	starCount: number;
	onStarCountChange: (starCount: 1 | 2 | 3 | 4 | 5 | 6) => void;
	freeBuild: boolean;
	onFreeBuildChange: (enabled: boolean) => void;
}

export function GameDebugPanel({
	metrics,
	speedMultiplier,
	onSpeedChange,
	starCount,
	onStarCountChange,
	freeBuild,
	onFreeBuildChange,
}: Props) {
	return (
		<div style={styles.debugPanel}>
			<div style={styles.debugTitle}>Debug</div>
			<div style={styles.debugRow}>
				<span>Speed</span>
				<span style={styles.speedButtons}>
					{([1, 3, 10] as const).map((multiplier) => (
						<button
							key={multiplier}
							type="button"
							style={{
								...styles.speedButton,
								...(speedMultiplier === multiplier
									? styles.speedButtonActive
									: {}),
							}}
							onClick={() => onSpeedChange(multiplier)}
						>
							{multiplier}x
						</button>
					))}
				</span>
			</div>
			<div style={styles.debugRow}>
				<span>Stars</span>
				<span style={styles.speedButtons}>
					{([1, 2, 3, 4, 5, 6] as const).map((value) => (
						<button
							key={value}
							type="button"
							style={{
								...styles.speedButton,
								...(starCount === value ? styles.speedButtonActive : {}),
							}}
							onClick={() => onStarCountChange(value)}
						>
							{value}
						</button>
					))}
				</span>
			</div>
			<div style={styles.debugRow}>
				<label style={{ display: "flex", alignItems: "center", gap: 6 }}>
					<input
						type="checkbox"
						checked={freeBuild}
						onChange={(e) => onFreeBuildChange(e.target.checked)}
					/>
					<span>Free build</span>
				</label>
			</div>
			<div style={styles.debugRow}>
				<span>Total population</span>
				<strong>{metrics.totalPopulation}</strong>
			</div>
			<div style={styles.debugRow}>
				<span>Queued</span>
				<strong>{metrics.queuedSims}</strong>
			</div>
			<div style={styles.debugRow}>
				<span>Boarded</span>
				<strong>{metrics.boardedSims}</strong>
			</div>
			<div style={styles.debugRow}>
				<span>Active trips</span>
				<strong>{metrics.activeTrips}</strong>
			</div>
			<div style={styles.debugRow}>
				<span>Cars</span>
				<strong>{metrics.totalCars}</strong>
			</div>
			<div style={styles.debugRow}>
				<span>Moving cars</span>
				<strong>{metrics.movingCars}</strong>
			</div>
			<div style={styles.debugRow}>
				<span>Door wait cars</span>
				<strong>{metrics.doorWaitCars}</strong>
			</div>
			<div style={styles.debugRow}>
				<span>Peak car load</span>
				<strong>{metrics.peakCarLoad}</strong>
			</div>
		</div>
	);
}
