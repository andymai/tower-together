import { useEffect } from "react";
import type { GameScene } from "../game/GameScene";

function isTextInput(target: EventTarget | null): boolean {
	if (!(target instanceof HTMLElement)) return false;
	const tag = target.tagName;
	if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
	if (target.isContentEditable) return true;
	return false;
}

/**
 * Single-letter hotkeys for the SimTower-style view presets.
 * Suppressed while focus is inside an input/textarea/contenteditable so the
 * tower-rename field can accept the literal letters.
 */
export function useViewPresetHotkeys(
	sceneRef: React.MutableRefObject<GameScene | null>,
): void {
	useEffect(() => {
		const onKeyDown = (event: KeyboardEvent) => {
			if (event.ctrlKey || event.metaKey || event.altKey) return;
			if (isTextInput(event.target)) return;
			const scene = sceneRef.current;
			if (!scene) return;
			switch (event.key) {
				case "f":
				case "F":
					scene.applyPresetFit();
					event.preventDefault();
					break;
				case "1":
					scene.applyPresetActualSize();
					event.preventDefault();
					break;
				case "l":
				case "L":
					scene.applyPresetLobby();
					event.preventDefault();
					break;
			}
		};
		window.addEventListener("keydown", onKeyDown);
		return () => {
			window.removeEventListener("keydown", onKeyDown);
		};
	}, [sceneRef]);
}
