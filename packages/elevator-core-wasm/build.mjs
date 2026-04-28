#!/usr/bin/env node

// Build the elevator-wasm crate for both the browser (Vite client bundle)
// and Node-style runtimes (Cloudflare Workers, vitest). Produces two
// parallel sets of artifacts under dist/web/ and dist/node/.
//
// Source path is configurable via ELEVATOR_CORE_PATH (env var); defaults
// to the sibling `~/Git/elevator-core` checkout. CI passes the path
// explicitly so a different layout doesn't silently fall through to a
// stale system copy.

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";

const HERE = new URL(".", import.meta.url).pathname;
const DEFAULT_PATH = resolve(homedir(), "Git/elevator-core");
const ELEVATOR_CORE_PATH = process.env.ELEVATOR_CORE_PATH ?? DEFAULT_PATH;
const CRATE_PATH = resolve(ELEVATOR_CORE_PATH, "crates/elevator-wasm");

if (!existsSync(CRATE_PATH)) {
	console.error(
		`elevator-core not found at ${CRATE_PATH}. ` +
			`Set ELEVATOR_CORE_PATH to the elevator-core checkout root.`,
	);
	process.exit(1);
}

const targets = [
	{ flag: "--target", value: "web", outDir: "dist/web" },
	{ flag: "--target", value: "nodejs", outDir: "dist/node" },
];

for (const target of targets) {
	const outDir = resolve(HERE, target.outDir);
	console.log(`\n→ wasm-pack build --release --target ${target.value}`);
	const result = spawnSync(
		"wasm-pack",
		[
			"build",
			"--release",
			target.flag,
			target.value,
			"--out-dir",
			outDir,
			"--out-name",
			"elevator_wasm",
			CRATE_PATH,
		],
		{
			stdio: "inherit",
			env: {
				...process.env,
				// Workaround for distros (e.g. Fedora 43) that ship libbz2.so.1
				// instead of libbz2.so.1.0 that the bundled wasm-pack binary
				// links against. The user-local symlink at ~/.local/lib is set
				// up at infrastructure-config time; absent it, this is a no-op
				// and wasm-pack uses the system path as before.
				LD_LIBRARY_PATH: process.env.LD_LIBRARY_PATH
					? `${process.env.HOME}/.local/lib:${process.env.LD_LIBRARY_PATH}`
					: `${process.env.HOME}/.local/lib`,
			},
		},
	);
	if (result.status !== 0) {
		console.error(`wasm-pack failed for target ${target.value}`);
		process.exit(result.status ?? 1);
	}
}

console.log("\n✓ elevator-wasm built for web + node targets");
