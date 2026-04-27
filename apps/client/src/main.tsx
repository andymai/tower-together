import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";

const CRASH_LOG_KEY = "tower_together_crash_log";

function appendCrashLog(entry: Record<string, unknown>): void {
	try {
		const raw = localStorage.getItem(CRASH_LOG_KEY);
		const existing = raw ? (JSON.parse(raw) as unknown[]) : [];
		const stamped = {
			t: new Date().toISOString(),
			url: location.href,
			...entry,
		};
		const next = [...existing, stamped].slice(-20);
		localStorage.setItem(CRASH_LOG_KEY, JSON.stringify(next));
	} catch {
		// Storage may be unavailable (private mode, quota); nothing to do.
	}
}

window.addEventListener("error", (e) => {
	appendCrashLog({
		kind: "error",
		message: e.message,
		filename: e.filename,
		lineno: e.lineno,
		colno: e.colno,
		stack: e.error instanceof Error ? e.error.stack : undefined,
	});
});

window.addEventListener("unhandledrejection", (e) => {
	const reason = e.reason;
	appendCrashLog({
		kind: "unhandledrejection",
		message: reason instanceof Error ? reason.message : String(reason),
		stack: reason instanceof Error ? reason.stack : undefined,
	});
});

const root = document.getElementById("root");
if (!root) throw new Error("No #root element found");

createRoot(root).render(
	<StrictMode>
		<App />
	</StrictMode>,
);
