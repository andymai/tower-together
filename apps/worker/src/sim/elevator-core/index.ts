// Public surface of the elevator-core bridge. Other code in
// `apps/worker/src/sim/` should import only from this barrel —
// internals (bridge handle, rider index, diff buffer, loader) are
// re-exported for tests but not part of the stable contract.

export {
	type BridgeHandle,
	type CarrierModeGroups,
	type CreateBridgeOptions,
	captureBridgePostcard,
	createBridge,
	disposeBridge,
	ensureBridge,
	getBridge,
	groupForMode,
	stepBridge,
} from "./bridge";
export {
	ShadowDiffBuffer,
	type ShadowDiffEntry,
	type ShadowDiffKind,
} from "./diff";
export { type ElevatorCoreModule, loadBridgeWasm } from "./loader";
export { RiderIndex } from "./rider-index";
export { METERS_PER_FLOOR, syncTopology } from "./topology-sync";
