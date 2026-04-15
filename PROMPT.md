You are building a behavior-identical, tick-for-tick replica of SimTower, a 1993 Windows 3.1 game. The reimplementation is in TypeScript using Cloudflare Workers.
- Our strategy is to make gameplay traces and ensure they match between the original binary and our reimplementation. The test is at `apps/worker/src/sim/trace.test.ts`.
- There is a partial, imperfect spec in `specs/` for the simulation details.
- Use both static and dynamic analysis of the original binary to understand its behavior and make the reimplementation match exactly.
- Static analysis: use the `pyghidra` skill on analysis-2825a3c53f project (SIMTOWER.EX_).
- Dynamic analysis: use `simtower/emulator.py` and add additional hooks to inspect whatever you want to inspect.
