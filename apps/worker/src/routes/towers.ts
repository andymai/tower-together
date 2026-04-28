import { Hono } from "hono";
import type { ElevatorEngine } from "../sim/world";
import {
	fetchTowerInfo,
	initializeTower,
	migrateTowerToCore,
} from "../tower-service";

interface Env {
	TOWER_ROOM: DurableObjectNamespace;
	/**
	 * Defaults the per-tower `elevatorEngine` flag at creation when the
	 * client doesn't specify one. `"development"` defaults to `'core'`
	 * so the dev team eats their own dogfood; everything else defaults
	 * to `'classic'`. Set in `wrangler.toml` per environment.
	 */
	ENVIRONMENT?: string;
}

export const towersRouter = new Hono<{ Bindings: Env }>();

function generateTowerId(): string {
	const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
	let id = "";
	for (let i = 0; i < 8; i++) {
		id += chars[Math.floor(Math.random() * chars.length)];
	}
	return id;
}

function defaultEngine(env: Env): ElevatorEngine {
	return env.ENVIRONMENT === "development" ? "core" : "classic";
}

// POST /api/towers - create a new tower
towersRouter.post("/towers", async (c) => {
	const body = await c.req
		.json<{ name?: string; elevatorEngine?: string }>()
		.catch(() => ({}) as { name?: string; elevatorEngine?: string });
	const name = body.name ?? "My Tower";
	const towerId = generateTowerId();

	let elevatorEngine: ElevatorEngine;
	if (body.elevatorEngine === "core" || body.elevatorEngine === "classic") {
		elevatorEngine = body.elevatorEngine;
	} else if (body.elevatorEngine === undefined) {
		elevatorEngine = defaultEngine(c.env);
	} else {
		return c.json(
			{ error: `Invalid elevatorEngine: ${body.elevatorEngine}` },
			400,
		);
	}

	const res = await initializeTower(c.env, towerId, name, elevatorEngine);
	if (!res.ok) {
		const err = await res.json<{ error: string }>();
		return c.json({ error: err.error ?? "Failed to initialize tower" }, 500);
	}

	return c.json({ towerId, name, elevatorEngine }, 201);
});

// GET /api/towers/:id - get tower info
towersRouter.get("/towers/:id", async (c) => {
	const towerId = c.req.param("id");

	const res = await fetchTowerInfo(c.env, towerId);
	if (!res.ok) {
		const err = await res.json<{ error: string }>();
		return c.json(
			{ error: err.error ?? "Tower not found" },
			res.status as 404 | 500,
		);
	}

	const info = await res.json();
	return c.json(info);
});

// POST /api/towers/:id/migrate-to-core — flip a 'classic' tower to
// 'core'. Idempotent on already-core towers. Used as the migration
// sweep before the legacy classic engine is deleted.
towersRouter.post("/towers/:id/migrate-to-core", async (c) => {
	const towerId = c.req.param("id");
	const res = await migrateTowerToCore(c.env, towerId);
	if (!res.ok) {
		const err = await res.json<{ error: string }>();
		return c.json(
			{ error: err.error ?? "Migration failed" },
			res.status as 404 | 500,
		);
	}
	const result = await res.json();
	return c.json(result);
});
