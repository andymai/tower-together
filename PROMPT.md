You are building a behavior-identical, tick-for-tick replica of SimTower, a 1993 Windows 3.1 game. The reimplementation is in TypeScript using Cloudflare Workers.

INSTRUCTIONS (IMPORTANT):
- Our strategy is to make gameplay traces and ensure they match between the original binary and our reimplementation. The test is at `apps/worker/src/sim/trace.test.ts`.
- Fix divergences in each trace in temporal order. A later divergence might represent a downstream consequence of an earlier divergence.
- When diagnosing a divergence, think about whether there might have been a hidden divergence in an earlier tick. If needed, create a bespoke script that checks other parts of the game state to ensure it matched up until the first observed divergence. You want to find the root cause.
- Don't worry about breaking existing behavior. You may have to make dramatic changes to the TypeScript code in order to fully match binary behavior.
- There is a partial, imperfect spec in `specs/` for the simulation details.
- Use both static and dynamic analysis of the original binary to understand its behavior and make the reimplementation match exactly.
- Static analysis: use the `pyghidra` skill on project dir analysis-2825a3c53f, project name 2825a3c53f, program SIMTOWER.EX_. Note that state machine functions often have jump tables the decompilers fail on; you'll have to disassemble the jump instruction and read the table manually.
- Dynamic analysis: use `simtower/emulator.py` and add additional hooks to inspect whatever you want to inspect.
- Use subagents aggressively to complete static and dynamic analysis tasks. It's very important to rotect the main context window from pollution with large quantities of disassembly or decompilation output or trace data.

Basic facts about the binary:
- Days work a little strangely. Tick count ranges from 0-2599, and dayCounter increments at tick 2300. Day 0 starts at tick 2533 and then rolls over to tick 0 and up to tick 2299 before turning to day 1.