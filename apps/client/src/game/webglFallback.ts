const WEBGL_ACTIVE_KEY = "tower-together:webgl-active";
const WEBGL_DISABLE_UNTIL_KEY = "tower-together:disable-webgl-until";
const DISABLE_WEBGL_FOR_MS = 60 * 60 * 1000;

function safeStorage(): Storage | null {
	try {
		return typeof window !== "undefined" ? window.localStorage : null;
	} catch {
		return null;
	}
}

export function shouldForceCanvasFallback(): boolean {
	const storage = safeStorage();
	if (!storage) return false;

	const disabledUntil = Number(storage.getItem(WEBGL_DISABLE_UNTIL_KEY) || 0);
	if (Date.now() < disabledUntil) return true;

	const previousActive = storage.getItem(WEBGL_ACTIVE_KEY);
	if (previousActive) {
		storage.setItem(
			WEBGL_DISABLE_UNTIL_KEY,
			String(Date.now() + DISABLE_WEBGL_FOR_MS),
		);
		storage.removeItem(WEBGL_ACTIVE_KEY);
		return true;
	}

	return false;
}

export function canCreateWebGL(): boolean {
	if (typeof document === "undefined") return false;
	const probe = document.createElement("canvas");
	try {
		const gl =
			probe.getContext("webgl2", { failIfMajorPerformanceCaveat: true }) ||
			probe.getContext("webgl", { failIfMajorPerformanceCaveat: true }) ||
			probe.getContext("experimental-webgl");
		return !!gl;
	} catch {
		return false;
	}
}

export function markWebGLActive(): void {
	safeStorage()?.setItem(WEBGL_ACTIVE_KEY, String(Date.now()));
}

export function clearWebGLActive(): void {
	safeStorage()?.removeItem(WEBGL_ACTIVE_KEY);
}

export function disableWebGLForAWhile(): void {
	const storage = safeStorage();
	if (!storage) return;
	storage.setItem(
		WEBGL_DISABLE_UNTIL_KEY,
		String(Date.now() + DISABLE_WEBGL_FOR_MS),
	);
	storage.removeItem(WEBGL_ACTIVE_KEY);
}
