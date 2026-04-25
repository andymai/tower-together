import { useCallback, useEffect, useRef, useState } from "react";
import { TowerSocket } from "./lib/socket";
import { getDisplayName, getPlayerId } from "./lib/storage";
import { GameScreen } from "./screens/GameScreen";
import { GuestScreen } from "./screens/GuestScreen";
import { LobbyScreen } from "./screens/LobbyScreen";
import type { SelectedTool } from "./types";

type Screen = "guest" | "lobby" | "game";
type HistoryMode = "none" | "push" | "replace";

function getSlugFromPath(): string {
	const path = window.location.pathname;
	if (path === "/") return "";
	if (!path.startsWith("/")) return "";

	const slug = path.slice(1);
	if (!slug || slug.includes("/")) return "";

	try {
		return decodeURIComponent(slug);
	} catch {
		return "";
	}
}

function updateHistory(path: string, mode: HistoryMode) {
	if (mode === "push") {
		window.history.pushState(null, "", path);
	} else if (mode === "replace") {
		window.history.replaceState(null, "", path);
	}
}

async function resolveSlug(slug: string): Promise<string | null> {
	try {
		const res = await fetch(`/api/resolve/${encodeURIComponent(slug)}`);
		if (!res.ok) return null;
		const data = (await res.json()) as { towerId: string };
		return data.towerId;
	} catch {
		return null;
	}
}

export function App() {
	const socketRef = useRef<TowerSocket>(new TowerSocket());
	const socket = socketRef.current;
	const [screen, setScreen] = useState<Screen>("guest");
	const [playerId, setPlayerId] = useState<string>("");
	const [displayName, setDisplayName] = useState<string>("");
	const [towerId, setTowerId] = useState<string>("");
	const [initialTool, setInitialTool] = useState<SelectedTool | undefined>(
		undefined,
	);

	const enterTower = useCallback(
		(
			nextTowerId: string,
			historyMode: HistoryMode = "none",
			nextInitialTool?: SelectedTool,
		) => {
			socket.connect(nextTowerId);
			setTowerId(nextTowerId);
			setInitialTool(nextInitialTool);
			setScreen("game");
			updateHistory(`/${nextTowerId}`, historyMode);
		},
		[socket],
	);

	const moveToLobby = useCallback(
		(historyMode: HistoryMode = "none") => {
			socket.disconnect();
			setTowerId("");
			setScreen("lobby");
			updateHistory("/", historyMode);
		},
		[socket],
	);

	const moveToGuest = useCallback(
		(historyMode: HistoryMode = "none") => {
			socket.disconnect();
			setTowerId("");
			setScreen("guest");
			updateHistory("/", historyMode);
		},
		[socket],
	);

	const syncFromLocation = useCallback(
		async (hasPlayer: boolean) => {
			if (!hasPlayer) {
				moveToGuest();
				return;
			}

			const slug = getSlugFromPath();
			if (!slug) {
				moveToLobby();
				return;
			}

			const resolvedTowerId = await resolveSlug(slug);
			if (resolvedTowerId) {
				enterTower(resolvedTowerId);
			} else {
				moveToLobby();
			}
		},
		[enterTower, moveToGuest, moveToLobby],
	);

	useEffect(() => {
		const storedId = getPlayerId();
		const storedName = getDisplayName();
		if (storedId && storedName) {
			setPlayerId(storedId);
			setDisplayName(storedName);
			void syncFromLocation(true);
		}

		return () => {
			socket.disconnect();
		};
	}, [socket, syncFromLocation]);

	useEffect(() => {
		function onPopState() {
			void syncFromLocation(Boolean(playerId && displayName));
		}

		window.addEventListener("popstate", onPopState);
		return () => window.removeEventListener("popstate", onPopState);
	}, [displayName, playerId, syncFromLocation]);

	function handleGuestEnter(id: string, name: string) {
		setPlayerId(id);
		setDisplayName(name);
		void syncFromLocation(true);
	}

	function handleJoinTower(id: string) {
		enterTower(id, "push");
	}

	function handleCreateTower(id: string) {
		enterTower(id, "push", "lobby");
	}

	function handleLeaveGame() {
		moveToLobby("push");
	}

	function handleLogout() {
		setPlayerId("");
		setDisplayName("");
		moveToGuest("push");
	}

	switch (screen) {
		case "guest":
			return <GuestScreen onEnter={handleGuestEnter} />;
		case "lobby":
			return (
				<LobbyScreen
					displayName={displayName}
					onJoinTower={handleJoinTower}
					onCreateTower={handleCreateTower}
					onLogout={handleLogout}
				/>
			);
		case "game":
			return (
				<GameScreen
					playerId={playerId}
					displayName={displayName}
					socket={socket}
					towerId={towerId}
					initialTool={initialTool}
					onLeave={handleLeaveGame}
				/>
			);
	}
}
