import { describe, expect, it } from "vitest";
import { findStaleSessions, TowerRoomSessions } from "./TowerRoomSessions";

function makeFakeSocket(): WebSocket {
	// The registry never invokes WebSocket methods in these tests — it only uses
	// identity equality and stores the reference as a Map key.
	return {} as unknown as WebSocket;
}

describe("TowerRoomSessions", () => {
	it("records lastSeenAt on add and updates it on touch", () => {
		const sessions = new TowerRoomSessions();
		const socket = makeFakeSocket();
		sessions.add(socket, 1_000);
		expect(sessions.getLastSeenAt(socket)).toBe(1_000);

		sessions.touch(socket, 5_000);
		expect(sessions.getLastSeenAt(socket)).toBe(5_000);
	});

	it("touch() on an unknown socket is a no-op", () => {
		const sessions = new TowerRoomSessions();
		const known = makeFakeSocket();
		const stranger = makeFakeSocket();
		sessions.add(known, 100);
		sessions.touch(stranger, 999);
		expect(sessions.getLastSeenAt(known)).toBe(100);
		expect(sessions.getLastSeenAt(stranger)).toBeNull();
	});

	it("tracks active state and exposes activeSize", () => {
		const sessions = new TowerRoomSessions();
		const a = makeFakeSocket();
		const b = makeFakeSocket();
		sessions.add(a);
		sessions.add(b);
		expect(sessions.activeSize).toBe(2);
		expect(sessions.setActive(a, false)).toBe(true);
		expect(sessions.activeSize).toBe(1);
		// No-op transition still reports previous value.
		expect(sessions.setActive(a, false)).toBe(false);
		expect(sessions.setActive(a, true)).toBe(false);
		expect(sessions.activeSize).toBe(2);
	});
});

describe("findStaleSessions", () => {
	it("returns sockets whose lastSeenAt is older than maxIdleMs", () => {
		const sessions = new TowerRoomSessions();
		const fresh = makeFakeSocket();
		const stale = makeFakeSocket();
		sessions.add(fresh, 9_000);
		sessions.add(stale, 1_000);

		const result = findStaleSessions(sessions.records(), 50_000, 45_000);
		expect(result).toEqual([stale]);
	});

	it("returns empty array when all sessions are fresh", () => {
		const sessions = new TowerRoomSessions();
		sessions.add(makeFakeSocket(), 9_000);
		sessions.add(makeFakeSocket(), 10_000);
		expect(findStaleSessions(sessions.records(), 20_000, 45_000)).toEqual([]);
	});

	it("boundary: exactly maxIdleMs old is not stale (strictly greater)", () => {
		const sessions = new TowerRoomSessions();
		const socket = makeFakeSocket();
		sessions.add(socket, 0);
		expect(findStaleSessions(sessions.records(), 45_000, 45_000)).toEqual([]);
		expect(findStaleSessions(sessions.records(), 45_001, 45_000)).toEqual([
			socket,
		]);
	});
});
