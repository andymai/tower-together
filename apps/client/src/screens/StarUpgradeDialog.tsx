import { Star } from "lucide-react";
import { gameScreenStyles as styles } from "./gameScreenStyles";

interface Props {
	newStarCount: number;
	onDismiss: () => void;
}

function rankLabel(starCount: number): string {
	if (starCount >= 6) return "TOWER";
	return `${starCount}-Star Tower`;
}

export function StarUpgradeDialog({ newStarCount, onDismiss }: Props) {
	const filled = Math.min(newStarCount, 5);
	return (
		<div style={{ ...styles.modalOverlay, zIndex: 300 }}>
			<div style={styles.modal}>
				<div
					style={{ display: "flex", gap: 4, color: "#facc15" }}
					role="img"
					aria-label={`New rating ${newStarCount} stars`}
				>
					{[1, 2, 3, 4, 5].map((slot) => (
						<Star
							key={`upgrade-star-${slot}`}
							size={28}
							strokeWidth={1.8}
							fill={slot <= filled ? "currentColor" : "none"}
						/>
					))}
				</div>
				<div style={styles.modalTitle}>Tower Upgraded!</div>
				<div style={styles.modalMessage}>
					Your tower has been promoted to {rankLabel(newStarCount)}.
				</div>
				<div style={styles.modalButtons}>
					<button type="button" style={styles.modalAccept} onClick={onDismiss}>
						Continue
					</button>
				</div>
			</div>
		</div>
	);
}
