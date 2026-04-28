// Re-exports the auto-generated wasm-bindgen surface for direct use.
// The actual module path is selected at consumer-import time via the
// `./web` or `./node` exports map; this barrel just provides type
// re-exports for code that wants to talk about the surface without
// pinning a target.
//
// Import shape for consumers:
//   import init, { WasmSim } from "@tower-together/elevator-core-wasm/web";
//   import { WasmSim } from "@tower-together/elevator-core-wasm/node";

export type {
	WasmBytesResult,
	WasmSim,
	WasmU32Result,
	WasmU64Result,
	WasmVoidResult,
} from "./types";
