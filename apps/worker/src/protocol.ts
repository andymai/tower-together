import type { SimCommand } from "./sim/commands";
import type { ClientMessage } from "./types";

export type SessionMessage = Extract<
	ClientMessage,
	| { type: "join_tower" }
	| { type: "ping" }
	| { type: "set_speed" }
	| { type: "set_paused" }
	| { type: "set_star_count" }
	| { type: "set_free_build" }
	| { type: "set_active" }
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
		msg.type === "set_paused" ||
		msg.type === "set_star_count" ||
		msg.type === "set_free_build" ||
		msg.type === "set_active" ||
		msg.type === "query_cell"
	);
}

export function toSimCommand(msg: ClientMessage): SimCommand | null {
	switch (msg.type) {
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
			return { type: "remove_elevator_car", x: msg.x, y: msg.y };
		case "set_cinema_movie_pool":
			return {
				type: "set_cinema_movie_pool",
				x: msg.x,
				y: msg.y,
				pool: msg.pool,
			};
		case "input_batch":
		case "join_tower":
		case "ping":
		case "set_speed":
		case "set_paused":
		case "set_star_count":
		case "set_free_build":
		case "set_active":
		case "query_cell":
			return null;
	}
}
