// Target-aware loader for the elevator-wasm module. The bridge expects
// a synchronous `WasmSimCtor` reference, so this module gates the async
// `loadElevatorCoreNode` call behind a one-shot promise and exposes a
// `loadBridgeWasm()` that callers `await` once before constructing a
// bridge. The cached promise means subsequent bridges (e.g. multiple
// towers in the same isolate) reuse the already-loaded module.

import { loadElevatorCoreNode } from "@tower-together/elevator-core-wasm/loader";

type ElevatorCoreModule = Awaited<ReturnType<typeof loadElevatorCoreNode>>;

let cached: Promise<ElevatorCoreModule> | null = null;

export function loadBridgeWasm(): Promise<ElevatorCoreModule> {
	if (!cached) {
		cached = loadElevatorCoreNode();
	}
	return cached;
}

export type { ElevatorCoreModule };
