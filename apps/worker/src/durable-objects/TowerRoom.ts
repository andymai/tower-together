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
import { TowerRoomSessions } from "./TowerRoomSessions";

interface Env {
	TOWER_ROOM: DurableObjectNamespace;
}

export class TowerRoom extends DurableObject<Env> {
	private static readonly CHECKPOINT_INTERVAL_TICKS = 500;

	private sim: TowerSim | null = null;
	private tickTimer: ReturnType<typeof setInterval> | null = null;
	private speedMultiplier: 1 | 3 | 10 = 1;
	private freeBuild = false;
	private isRunning = false;
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
			this.broadcast({
				type: "presence_update",
				playerCount: this.sessions.size,
			});
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

		if (isSessionMessage(msg) && msg.type === "set_speed") {
			this.speedMultiplier = msg.multiplier;
			if (this.isRunning) this.restartTick();
			this.broadcast({
				type: "session_settings",
				speedMultiplier: this.speedMultiplier,
				freeBuild: this.freeBuild,
			});
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
			this.broadcast({
				type: "session_settings",
				speedMultiplier: this.speedMultiplier,
				freeBuild: this.freeBuild,
			});
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
			this.stopTick();
			this.persistSim();
		} else {
			this.broadcast({
				type: "presence_update",
				playerCount: this.sessions.size,
			});
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

		if (
			shouldEmitCheckpoint(result.simTime, TowerRoom.CHECKPOINT_INTERVAL_TICKS)
		) {
			this.broadcastCheckpoint();
			this.persistSim();
			return;
		}

		if (result.simTime % 30 === 0) this.persistSim();
	}

	// ─── Helpers ─────────────────────────────────────────────────────────────────

	private broadcast(msg: ServerMessage, exclude?: WebSocket): void {
		this.sessions.broadcast(msg, exclude);
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
