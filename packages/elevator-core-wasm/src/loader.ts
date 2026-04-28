// Lazy loaders for the WASM module. Cloudflare Workers needs the `nodejs`
// target (synchronous instantiation, no top-level await over fetch); Vite's
// browser bundle needs the `web` target. Both load lazily so a tower that
// uses the classic engine never pays the WASM compile cost.
//
// Returns the wasm-bindgen module's full namespace; the WasmSim class is
// `module.WasmSim`. Consumers usually destructure:
//
//   const { WasmSim } = await loadElevatorCore();
//
// The `web` loader requires `init()` to be called (wasm-bindgen target=web
// signature). vite-plugin-wasm + vite-plugin-top-level-await are configured
// in apps/client/vite.config.ts to make this transparent.

export type ElevatorCoreModule = typeof import("../dist/node/elevator_wasm");

let webPromise: Promise<ElevatorCoreModule> | null = null;
let nodePromise: Promise<ElevatorCoreModule> | null = null;

export function loadElevatorCore(): Promise<ElevatorCoreModule> {
	if (!webPromise) {
		webPromise = (async () => {
			const mod = await import("../dist/web/elevator_wasm");
			// wasm-bindgen target=web requires init(); vite-plugin-wasm wires
			// the URL through automatically. The module's default export is
			// the init function.
			const initFn = (mod as unknown as { default: () => Promise<unknown> })
				.default;
			if (typeof initFn === "function") {
				await initFn();
			}
			return mod as unknown as ElevatorCoreModule;
		})();
	}
	return webPromise;
}

export function loadElevatorCoreNode(): Promise<ElevatorCoreModule> {
	if (!nodePromise) {
		nodePromise = import(
			"../dist/node/elevator_wasm"
		) as Promise<ElevatorCoreModule>;
	}
	return nodePromise;
}
