import { useEffect } from "react";

const ZOOM_KEYS = new Set([
	"=",
	"+",
	"-",
	"_",
	"0",
	"Add",
	"Subtract",
	"NumpadAdd",
	"NumpadSubtract",
]);

/**
 * Suppresses browser page-zoom (Ctrl/Cmd +/-/0 and Ctrl+wheel) while the hook
 * is mounted. Phaser's in-game ctrl+wheel zoom keeps working: preventDefault
 * only cancels the browser's default action, not other listeners.
 *
 * Does NOT block on guest/lobby screens — only mount inside GameScreen so
 * accessibility zoom remains available on form pages.
 */
export function useBlockBrowserZoom(): void {
	useEffect(() => {
		const onKeyDown = (event: KeyboardEvent) => {
			if (!(event.ctrlKey || event.metaKey)) return;
			const key = event.key;
			const code = event.code;
			if (ZOOM_KEYS.has(key) || ZOOM_KEYS.has(code)) {
				event.preventDefault();
			}
		};

		const onWheel = (event: WheelEvent) => {
			if (event.ctrlKey || event.metaKey) {
				event.preventDefault();
			}
		};

		window.addEventListener("keydown", onKeyDown, { capture: true });
		window.addEventListener("wheel", onWheel, {
			passive: false,
			capture: true,
		});

		return () => {
			window.removeEventListener("keydown", onKeyDown, { capture: true });
			window.removeEventListener("wheel", onWheel, { capture: true });
		};
	}, []);
}
