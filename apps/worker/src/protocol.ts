import type { SimCommand } from "./sim/commands";
import type { ClientMessage } from "./types";

export type SessionMessage = Extract<
	ClientMessage,
	{ type: "join_tower" } | { type: "ping" } | { type: "set_speed" }
>;

export function parseClientMessage(
	raw: string | ArrayBuffer,
): ClientMessage | null {
	try {
		return JSON.parse(
			typeof raw === "string" ? raw : new TextDecoder().decode(raw),
		) as ClientMessage;
	} catch {
		return null;
	}
}

export function isSessionMessage(msg: ClientMessage): msg is SessionMessage {
	return (
		msg.type === "join_tower" || msg.type === "ping" || msg.type === "set_speed"
	);
}

export function toSimCommand(msg: ClientMessage): SimCommand | null {
	switch (msg.type) {
		case "place_tile":
			return {
				type: "place_tile",
				x: msg.x,
				y: msg.y,
				tileType: msg.tileType,
			};
		case "remove_tile":
			return { type: "remove_tile", x: msg.x, y: msg.y };
		case "prompt_response":
			return {
				type: "prompt_response",
				promptId: msg.promptId,
				accepted: msg.accepted,
			};
		case "join_tower":
		case "ping":
		case "set_speed":
			return null;
	}
}
