import type { ServerMessage } from "../types";

export class TowerRoomSessions {
	private readonly sockets = new Set<WebSocket>();

	add(socket: WebSocket): void {
		this.sockets.add(socket);
	}

	remove(socket: WebSocket): void {
		this.sockets.delete(socket);
	}

	get size(): number {
		return this.sockets.size;
	}

	broadcast(message: ServerMessage, exclude?: WebSocket): void {
		for (const socket of this.sockets) {
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
