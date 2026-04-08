interface TowerRoomEnv {
	TOWER_ROOM: DurableObjectNamespace;
}

interface TowerRegistryEnv {
	TOWER_REGISTRY: DurableObjectNamespace;
}

type TowerEnv = TowerRoomEnv & TowerRegistryEnv;

export interface TowerInfo {
	towerId: string;
	name: string;
	simTime: number;
	cash: number;
	width: number;
	height: number;
	playerCount: number;
}

export function getTowerRoomStub(
	env: TowerRoomEnv,
	towerId: string,
): DurableObjectStub {
	return env.TOWER_ROOM.get(env.TOWER_ROOM.idFromName(towerId));
}

export function getTowerRegistryStub(env: TowerRegistryEnv): DurableObjectStub {
	return env.TOWER_REGISTRY.get(env.TOWER_REGISTRY.idFromName("global"));
}

export async function fetchTowerInfo(
	env: TowerRoomEnv,
	towerId: string,
): Promise<Response> {
	return getTowerRoomStub(env, towerId).fetch("http://do/info");
}

export async function initializeTower(
	env: TowerRoomEnv,
	towerId: string,
	name: string,
): Promise<Response> {
	const initUrl = new URL("http://do/init");
	initUrl.searchParams.set("towerId", towerId);
	initUrl.searchParams.set("name", name);
	return getTowerRoomStub(env, towerId).fetch(initUrl.toString(), {
		method: "POST",
	});
}

export async function resolveTowerAlias(
	env: TowerRegistryEnv,
	alias: string,
): Promise<Response> {
	const resolveUrl = new URL("http://do/resolve");
	resolveUrl.searchParams.set("alias", alias);
	return getTowerRegistryStub(env).fetch(resolveUrl.toString());
}

export async function assignTowerAlias(
	env: TowerEnv,
	alias: string,
	towerId: string,
): Promise<Response> {
	const setUrl = new URL("http://do/set-alias");
	setUrl.searchParams.set("alias", alias);
	setUrl.searchParams.set("towerId", towerId);
	return getTowerRegistryStub(env).fetch(setUrl.toString(), { method: "PUT" });
}
