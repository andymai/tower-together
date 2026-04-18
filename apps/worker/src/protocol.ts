import type { SimCommand } from "./sim/commands";
import type { ClientMessage } from "./types";

export type SessionMessage = Extract<
	ClientMessage,
	| { type: "join_tower" }
	| { type: "ping" }
	| { type: "set_speed" }
	| { type: "set_free_build" }
	| { type: "query_cell" }
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
		msg.type === "join_tower" ||
		msg.type === "ping" ||
		msg.type === "set_speed" ||
		msg.type === "set_free_build" ||
		msg.type === "query_cell"
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
		case "set_rent_level":
			return {
				type: "set_rent_level",
				x: msg.x,
				y: msg.y,
				rentLevel: msg.rentLevel,
			};
		case "add_elevator_car":
			return { type: "add_elevator_car", x: msg.x, y: msg.y };
		case "remove_elevator_car":
			return { type: "remove_elevator_car", x: msg.x };
		case "join_tower":
		case "ping":
		case "set_speed":
		case "set_free_build":
		case "query_cell":
			return null;
	}
}
