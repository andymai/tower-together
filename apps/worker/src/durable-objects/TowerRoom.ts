import { DurableObject } from "cloudflare:workers";
import {
	isSessionMessage,
	parseClientMessage,
	toSimCommand,
} from "../protocol";
import { TowerSim } from "../sim/index";
import { getTileStarRequirement, STARTING_CASH } from "../sim/resources";
import { createInitialSnapshot } from "../sim/snapshot";
import type { ResolvedInputBatch, ServerMessage } from "../types";
import {
	type QueuedInputBatch,
	resolveQueuedInputBatches,
	shouldEmitCheckpoint,
} from "./lockstep";
import { TowerRoomRepository } from "./TowerRoomRepository";
import { findStaleSessions, TowerRoomSessions } from "./TowerRoomSessions";

interface Env {
	TOWER_ROOM: DurableObjectNamespace;
}

export class TowerRoom extends DurableObject<Env> {
	private static readonly CHECKPOINT_INTERVAL_TICKS = 500;
	/** Ticks between idle-sweeps (at 50ms tick = 10s, at 3x tick ≈ 3.3s). */
	private static readonly IDLE_SWEEP_EVERY_TICKS = 200;
	/** Sockets silent for longer than this are considered dead. */
	private static readonly IDLE_TIMEOUT_MS = 45_000;

	private sim: TowerSim | null = null;
	private tickTimer: ReturnType<typeof setInterval> | null = null;
	private speedMultiplier: 1 | 3 | 10 = 1;
	private freeBuild = false;
	private isRunning = false;
	private isPaused = false;
	private readonly queuedInputs = new Map<number, QueuedInputBatch[]>();
	private readonly repository: TowerRoomRepository;
	private readonly sessions = new TowerRoomSessions();

	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
		this.repository = new TowerRoomRepository(this.ctx.storage);
	}

	// ─── Persistence ────────────────────────────────────────────────────────────

	private async initializeTower(towerId: string, name: string): Promise<void> {
		const snapshot = createInitialSnapshot(towerId, name, STARTING_CASH);
		this.repository.initialize(snapshot);
		this.sim = TowerSim.fromSnapshot(snapshot);
	}

	private loadSim(): TowerSim | null {
		const snapshot = this.repository.load();
		return snapshot ? TowerSim.fromSnapshot(snapshot) : null;
	}

	private persistSim(): void {
		if (!this.sim) return;
		this.repository.save(this.sim.saveState());
	}

	private getPlacementRejectionReason(tileType: string): string | null {
		if (!this.sim || this.freeBuild) return null;
		const requiredStars = getTileStarRequirement(tileType);
		if (this.sim.starCount >= requiredStars) return null;
		return `Requires ${requiredStars} star${requiredStars === 1 ? "" : "s"}`;
	}

	// ─── HTTP fetch handler ──────────────────────────────────────────────────────

	async fetch(request: Request): Promise<Response> {
		const url = new URL(request.url);

		if (request.headers.get("Upgrade") === "websocket") {
			const { 0: client, 1: server } = new WebSocketPair();
			server.accept();
			this.sessions.add(server);

			server.addEventListener("message", (evt: MessageEvent) => {
				this.handleMessage(server, evt.data as string | ArrayBuffer);
			});
			server.addEventListener("close", () => {
				this.sessions.remove(server);
				this.handleClose();
			});
			server.addEventListener("error", () => {
				this.sessions.remove(server);
				this.handleClose();
			});

			return new Response(null, { status: 101, webSocket: client });
		}

		const path = url.pathname;

		if (request.method === "POST" && path === "/init") {
			const towerId = url.searchParams.get("towerId");
			const name = url.searchParams.get("name");
			if (!towerId || !name) {
				return Response.json(
					{ error: "Missing towerId or name" },
					{ status: 400 },
				);
			}
			await this.initializeTower(towerId, name);
			return Response.json({ towerId, name });
		}

		if (request.method === "GET" && path === "/info") {
			const sim = this.sim ?? this.loadSim();
			if (!sim)
				return Response.json({ error: "Tower not found" }, { status: 404 });
			return Response.json({
				towerId: sim.towerId,
				name: sim.name,
				simTime: sim.simTime,
				cash: sim.cash,
				population: sim.population,
				starCount: sim.starCount,
				width: sim.width,
				height: sim.height,
				playerCount: this.sessions.size,
			});
		}

		return Response.json({ error: "Not found" }, { status: 404 });
	}

	// ─── WebSocket message handling ──────────────────────────────────────────────

	private handleMessage(ws: WebSocket, raw: string | ArrayBuffer): void {
		// Any inbound traffic proves the socket is still alive.
		this.sessions.touch(ws);

		const msg = parseClientMessage(raw);
		if (!msg) return;

		if (!this.sim) this.sim = this.loadSim();
		if (!this.sim) {
			this.sessions.send(ws, {
				type: "notification",
				kind: "error",
				message: "Tower not initialized",
			});
			return;
		}

		if (isSessionMessage(msg) && msg.type === "join_tower") {
			this.sessions.setIdentity(ws, msg.playerId, msg.displayName);
			const snapshot = this.sim.saveState();
			this.sessions.send(ws, {
				type: "init_state",
				towerId: this.sim.towerId,
				name: this.sim.name,
				simTime: this.sim.simTime,
				snapshot,
				speedMultiplier: this.speedMultiplier,
				freeBuild: this.freeBuild,
				cash: this.sim.cash,
				population: this.sim.population,
				starCount: this.sim.starCount,
				width: this.sim.width,
				height: this.sim.height,
			});
			this.broadcastPresence();
			// New joiner counts as an active session, so make sure the sim is running.
			this.resumeIfNeeded();
			if (!this.isRunning) {
				this.isRunning = true;
				this.startTick();
			}
			return;
		}

		if (isSessionMessage(msg) && msg.type === "ping") {
			this.sessions.send(ws, { type: "pong" });
			return;
		}

		if (isSessionMessage(msg) && msg.type === "set_active") {
			const previous = this.sessions.setActive(ws, msg.active);
			if (previous === null || previous === msg.active) return;
			this.handleActiveCountChanged();
			return;
		}

		if (isSessionMessage(msg) && msg.type === "set_speed") {
			this.speedMultiplier = msg.multiplier;
			if (this.isRunning && !this.isPaused) this.restartTick();
			this.broadcastSessionSettings();
			return;
		}

		if (isSessionMessage(msg) && msg.type === "set_star_count") {
			this.sim.setStarCount(msg.starCount);
			this.broadcastCheckpoint();
			this.persistSim();
			return;
		}

		if (isSessionMessage(msg) && msg.type === "set_free_build") {
			this.freeBuild = msg.enabled;
			this.sim.freeBuild = msg.enabled;
			this.broadcastSessionSettings();
			return;
		}

		if (msg.type === "query_cell") {
			const info = this.sim.queryCell(msg.x, msg.y);
			this.sessions.send(ws, {
				type: "cell_info",
				x: msg.x,
				y: msg.y,
				anchorX: info.anchorX,
				tileType: info.tileType,
				objectInfo: info.objectInfo,
				carrierInfo: info.carrierInfo,
			});
			return;
		}

		if (msg.type === "input_batch") {
			const playerId = this.sessions.getPlayerId(ws);
			if (!playerId || msg.inputs.length === 0) {
				return;
			}
			const targetTick = this.sim.simTime + 1;
			const queue = this.queuedInputs.get(targetTick);
			const queuedBatch = {
				playerId,
				clientSeq: msg.clientSeq,
				inputs: msg.inputs,
			};
			if (queue) {
				queue.push(queuedBatch);
			} else {
				this.queuedInputs.set(targetTick, [queuedBatch]);
			}
			return;
		}

		const command = toSimCommand(msg);
		if (!command) return;
		const playerId = this.sessions.getPlayerId(ws);
		if (!playerId) return;
		const targetTick = this.sim.simTime + 1;
		const queue = this.queuedInputs.get(targetTick);
		const queuedBatch = {
			playerId,
			clientSeq: Date.now(),
			inputs: [command],
		};
		if (queue) {
			queue.push(queuedBatch);
		} else {
			this.queuedInputs.set(targetTick, [queuedBatch]);
		}
	}

	private handleClose(): void {
		if (this.sessions.size === 0) {
			this.isRunning = false;
			this.isPaused = false;
			this.stopTick();
			this.persistSim();
		} else {
			this.broadcastPresence();
			// A departing active session can drop activeCount to 0 — re-evaluate pause.
			this.handleActiveCountChanged();
		}
	}

	// ─── Sim tick ────────────────────────────────────────────────────────────────

	private startTick(): void {
		if (this.tickTimer !== null) return;
		const interval = Math.round(50 / this.speedMultiplier);
		this.tickTimer = setInterval(() => this.tick(), interval);
	}

	private restartTick(): void {
		this.stopTick();
		this.startTick();
	}

	private stopTick(): void {
		if (this.tickTimer !== null) {
			clearInterval(this.tickTimer);
			this.tickTimer = null;
		}
	}

	private tick(): void {
		if (!this.isRunning || !this.sim) return;

		const batches = this.queuedInputs.get(this.sim.simTime + 1) ?? [];
		if (batches.length > 0) {
			this.queuedInputs.delete(this.sim.simTime + 1);
		}
		const resolvedBatches = this.applyQueuedInputs(batches);
		const result = this.sim.step();
		if (resolvedBatches.length > 0) {
			this.broadcast({
				type: "authoritative_batch",
				serverTick: result.simTime,
				batches: resolvedBatches,
			});
		}
		this.broadcastEffects(result);

		if (result.simTime % TowerRoom.IDLE_SWEEP_EVERY_TICKS === 0) {
			this.sweepIdleSessions();
		}

		if (
			shouldEmitCheckpoint(result.simTime, TowerRoom.CHECKPOINT_INTERVAL_TICKS)
		) {
			this.broadcastCheckpoint();
			this.persistSim();
			return;
		}

		if (result.simTime % 30 === 0) this.persistSim();
	}

	// ─── Liveness / idle / pause ────────────────────────────────────────────────

	private sweepIdleSessions(): void {
		const stale = findStaleSessions(
			this.sessions.records(),
			Date.now(),
			TowerRoom.IDLE_TIMEOUT_MS,
		);
		if (stale.length === 0) return;
		for (const socket of stale) {
			this.sessions.remove(socket);
			try {
				socket.close(1001, "idle timeout");
			} catch {
				// Already closed; the close/error handlers will no-op via remove().
			}
		}
		// Closing sockets may mutate playerCount/activeCount, so re-broadcast.
		if (this.sessions.size === 0) {
			this.isRunning = false;
			this.isPaused = false;
			this.stopTick();
			this.persistSim();
			return;
		}
		this.broadcastPresence();
		this.handleActiveCountChanged();
	}

	private handleActiveCountChanged(): void {
		if (this.sessions.size === 0) return;
		const activeCount = this.sessions.activeSize;
		if (activeCount === 0 && !this.isPaused) {
			this.isPaused = true;
			this.stopTick();
			this.broadcastSessionSettings();
			this.broadcastPresence();
			return;
		}
		if (activeCount > 0 && this.isPaused) {
			this.isPaused = false;
			if (this.isRunning) this.startTick();
			this.broadcastSessionSettings();
			this.broadcastPresence();
			return;
		}
		this.broadcastPresence();
	}

	private resumeIfNeeded(): void {
		if (!this.isPaused) return;
		if (this.sessions.activeSize === 0) return;
		this.isPaused = false;
		if (this.isRunning) this.startTick();
		this.broadcastSessionSettings();
	}

	// ─── Helpers ─────────────────────────────────────────────────────────────────

	private broadcast(msg: ServerMessage, exclude?: WebSocket): void {
		this.sessions.broadcast(msg, exclude);
	}

	private broadcastPresence(): void {
		this.broadcast({
			type: "presence_update",
			playerCount: this.sessions.size,
			activeCount: this.sessions.activeSize,
		});
	}

	private broadcastSessionSettings(): void {
		this.broadcast({
			type: "session_settings",
			speedMultiplier: this.speedMultiplier,
			freeBuild: this.freeBuild,
			paused: this.isPaused,
		});
	}

	private broadcastEffects(result: {
		notifications: Array<{ kind: string; message: string }>;
		prompts: Array<{
			promptId: string;
			promptKind: "bomb_ransom" | "fire_rescue" | "carrier_edit_confirmation";
			message: string;
			cost?: number;
		}>;
	}): void {
		for (const n of result.notifications) {
			this.broadcast({
				type: "notification",
				kind: n.kind,
				message: n.message,
			});
		}
		for (const p of result.prompts) {
			this.broadcast({
				type: "prompt",
				promptId: p.promptId,
				promptKind: p.promptKind,
				message: p.message,
				cost: p.cost,
			});
		}
	}

	private applyQueuedInputs(batches: QueuedInputBatch[]): ResolvedInputBatch[] {
		if (!this.sim || batches.length === 0) {
			return [];
		}
		return resolveQueuedInputBatches(this.sim, batches, {
			freeBuild: this.freeBuild,
			getPlacementRejectionReason: (tileType) =>
				this.getPlacementRejectionReason(tileType),
			onPromptDismissed: (promptId) => {
				this.broadcast({
					type: "prompt_dismissed",
					promptId,
				});
			},
		});
	}

	private broadcastCheckpoint(): void {
		if (!this.sim) return;
		this.broadcast({
			type: "checkpoint",
			serverTick: this.sim.simTime,
			snapshot: this.sim.saveState(),
			speedMultiplier: this.speedMultiplier,
			freeBuild: this.freeBuild,
		});
	}
}
