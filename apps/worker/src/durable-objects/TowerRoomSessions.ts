import type { ServerMessage } from "../types";

export type SessionRecord = {
	socket: WebSocket;
	playerId: string | null;
	displayName: string | null;
	active: boolean;
	lastSeenAt: number;
};

/** Returns sockets whose `lastSeenAt` is older than `now - maxIdleMs`. */
export function findStaleSessions(
	sessions: Iterable<SessionRecord>,
	now: number,
	maxIdleMs: number,
): WebSocket[] {
	const stale: WebSocket[] = [];
	for (const record of sessions) {
		if (now - record.lastSeenAt > maxIdleMs) {
			stale.push(record.socket);
		}
	}
	return stale;
}

export class TowerRoomSessions {
	private readonly sessions = new Map<WebSocket, SessionRecord>();

	add(socket: WebSocket, now: number = Date.now()): void {
		this.sessions.set(socket, {
			socket,
			playerId: null,
			displayName: null,
			active: true,
			lastSeenAt: now,
		});
	}

	remove(socket: WebSocket): void {
		this.sessions.delete(socket);
	}

	setIdentity(socket: WebSocket, playerId: string, displayName: string): void {
		const existing = this.sessions.get(socket);
		if (!existing) return;
		existing.playerId = playerId;
		existing.displayName = displayName;
	}

	/** Updates `lastSeenAt` for the session. Called on every inbound message. */
	touch(socket: WebSocket, now: number = Date.now()): void {
		const existing = this.sessions.get(socket);
		if (!existing) return;
		existing.lastSeenAt = now;
	}

	/** Returns the previous `active` value, or `null` if the session is unknown. */
	setActive(socket: WebSocket, active: boolean): boolean | null {
		const existing = this.sessions.get(socket);
		if (!existing) return null;
		const previous = existing.active;
		existing.active = active;
		return previous;
	}

	getPlayerId(socket: WebSocket): string | null {
		return this.sessions.get(socket)?.playerId ?? null;
	}

	getLastSeenAt(socket: WebSocket): number | null {
		return this.sessions.get(socket)?.lastSeenAt ?? null;
	}

	isActive(socket: WebSocket): boolean {
		return this.sessions.get(socket)?.active ?? false;
	}

	get size(): number {
		return this.sessions.size;
	}

	get activeSize(): number {
		let count = 0;
		for (const record of this.sessions.values()) {
			if (record.active) count += 1;
		}
		return count;
	}

	records(): IterableIterator<SessionRecord> {
		return this.sessions.values();
	}

	broadcast(message: ServerMessage, exclude?: WebSocket): void {
		for (const { socket } of this.sessions.values()) {
			if (socket !== exclude) this.send(socket, message);
		}
	}

	send(socket: WebSocket, message: ServerMessage): void {
		try {
			socket.send(JSON.stringify(message));
		} catch {
			// Ignore closed sockets; close/error handlers own session cleanup.
		}
	}
}
