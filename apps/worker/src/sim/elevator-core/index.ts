// Public surface of the elevator-core bridge. Other code in
// `apps/worker/src/sim/` should import only from this barrel —
// internals (bridge handle, rider index, diff buffer, loader) are
// re-exported for tests but not part of the stable contract.

export {
	type BridgeHandle,
	type BridgeStepResult,
	type CarrierModeGroups,
	type CreateBridgeOptions,
	captureBridgePostcard,
	carPositionInFloors,
	createBridge,
	disposeBridge,
	ensureBridge,
	getBridge,
	groupForMode,
	refToSlot,
	stepBridge,
} from "./bridge";
export {
	ShadowDiffBuffer,
	type ShadowDiffEntry,
	type ShadowDiffKind,
} from "./diff";
export { type ElevatorCoreModule, loadBridgeWasm } from "./loader";
export { RiderIndex } from "./rider-index";
export { syncRiderSpawn } from "./rider-sync";
export { METERS_PER_FLOOR, syncTopology } from "./topology-sync";
