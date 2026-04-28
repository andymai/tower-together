#!/usr/bin/env node
// Sweep stored 'classic' towers and migrate them to 'core' via the
// /api/towers/:id/migrate-to-core endpoint. Designed to run against a
// staging or production worker deployment after the soak window
// confirms 'core' parity.
//
// Reads tower IDs from stdin (one per line) and POSTs to each.
// Reports a summary: total, migrated, already-core, errors.
//
// Usage:
//   echo "tower-abc\ntower-def" | node scripts/migrate-classic-towers.mjs https://your-worker.example.com
//   cat ids.txt | node scripts/migrate-classic-towers.mjs http://localhost:8787
//
// Source of tower ids is intentionally external — the worker has no
// "list all towers" endpoint, by design (privacy, scalability).
// Operationally, you'd derive the list from the registry DO or an
// out-of-band log of towers created before the cutover.

import { stdin } from "node:process";
import { createInterface } from "node:readline";

const baseUrl = process.argv[2];
if (!baseUrl) {
	console.error(
		"usage: node scripts/migrate-classic-towers.mjs <worker-base-url>",
	);
	process.exit(2);
}

const concurrency = Number(process.env.MIGRATE_CONCURRENCY ?? 8);

async function migrateOne(towerId) {
	const url = `${baseUrl.replace(/\/$/, "")}/api/towers/${encodeURIComponent(
		towerId,
	)}/migrate-to-core`;
	const res = await fetch(url, { method: "POST" });
	if (!res.ok) {
		const text = await res.text();
		return { towerId, status: "error", code: res.status, message: text };
	}
	const body = await res.json();
	return {
		towerId,
		status: body.migrated ? "migrated" : "already-core",
	};
}

async function run() {
	const ids = [];
	const rl = createInterface({ input: stdin });
	for await (const line of rl) {
		const id = line.trim();
		if (id) ids.push(id);
	}
	if (ids.length === 0) {
		console.error("no tower ids on stdin");
		process.exit(2);
	}

	console.log(`migrating ${ids.length} towers (concurrency=${concurrency})…`);

	const summary = { total: ids.length, migrated: 0, alreadyCore: 0, errors: 0 };
	const queue = ids.slice();
	const workers = Array.from({ length: concurrency }, async () => {
		while (queue.length > 0) {
			const id = queue.shift();
			if (!id) break;
			try {
				const result = await migrateOne(id);
				if (result.status === "migrated") summary.migrated += 1;
				else if (result.status === "already-core") summary.alreadyCore += 1;
				else {
					summary.errors += 1;
					console.error(`  error ${result.code} on ${id}: ${result.message}`);
				}
			} catch (err) {
				summary.errors += 1;
				console.error(`  exception on ${id}: ${err.message ?? err}`);
			}
		}
	});
	await Promise.all(workers);

	console.log(
		`done — migrated=${summary.migrated} already-core=${summary.alreadyCore} errors=${summary.errors} total=${summary.total}`,
	);
	process.exit(summary.errors > 0 ? 1 : 0);
}

run();
