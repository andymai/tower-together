import type { ServerMessage } from "../types";

type SessionRecord = {
	socket: WebSocket;
	playerId: string | null;
	displayName: string | null;
};

export class TowerRoomSessions {
	private readonly sessions = new Map<WebSocket, SessionRecord>();

	add(socket: WebSocket): void {
		this.sessions.set(socket, {
			socket,
			playerId: null,
			displayName: null,
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

	getPlayerId(socket: WebSocket): string | null {
		return this.sessions.get(socket)?.playerId ?? null;
	}

	get size(): number {
		return this.sessions.size;
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
