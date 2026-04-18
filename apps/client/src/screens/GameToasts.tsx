import { memo } from "react";
import { gameScreenStyles as styles } from "./gameScreenStyles";
import type { Toast } from "./gameScreenTypes";

interface Props {
	toasts: Toast[];
}

export const GameToasts = memo(function GameToasts({ toasts }: Props) {
	if (toasts.length === 0) {
		return null;
	}

	return (
		<div style={styles.toastContainer}>
			{toasts.map((toast) => (
				<div
					key={toast.id}
					style={
						toast.variant === "info" ? styles.toastInfo : styles.toastError
					}
				>
					{toast.message}
				</div>
			))}
		</div>
	);
});
