import { useEffect, useRef } from "react";
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
 * tower-rename field can accept the literal letters, and while a modal/
 * dialog is open so the keys don't pan the camera under the modal.
 */
export function useViewPresetHotkeys(
	sceneRef: React.MutableRefObject<GameScene | null>,
	enabled: boolean,
): void {
	const enabledRef = useRef(enabled);
	enabledRef.current = enabled;

	useEffect(() => {
		const onKeyDown = (event: KeyboardEvent) => {
			if (!enabledRef.current) return;
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
