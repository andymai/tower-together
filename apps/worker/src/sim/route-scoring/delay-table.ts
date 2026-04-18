// 1288:e62c g_per_stop_even_parity_delay
// 1288:e62e g_per_stop_odd_parity_delay
//
// Parity-based per-stop delay lookup used by `resolveSimRouteBetweenFloors`
// when a sim walks a special-link segment. Indexed by
// `segment.modeAndSpan & 1` (bit 0 = stairs-cost parity).
//
// Magnitudes preserved from the pre-refactor TS (16 for escalator,
// 35 for stairs). The binary's SIMTOWER.EX_ initializer populates these
// words at load time; static analysis via pyghidra reads 0 at these
// addresses (uninitialized BSS), so the values cannot be verified
// statically. TODO(1288:e62c, 1288:e62e): capture the runtime-initialized
// values via the emulator (`python -m simtower.emulator`) and swap in the
// binary values if they differ from 16/35.

/**
 * `perStopParityDelay[0]` = even-parity (escalator) per-stop stress.
 * `perStopParityDelay[1]` = odd-parity (stairs) per-stop stress.
 */
export const perStopParityDelay: readonly [number, number] = [16, 35];
