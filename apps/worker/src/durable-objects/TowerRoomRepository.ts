import { runMigrations } from "../db/migrations";
import type { SimSnapshot } from "../sim/snapshot";

export class TowerRoomRepository {
	constructor(private readonly storage: DurableObjectStorage) {
		runMigrations(this.storage.sql);
	}

	initialize(snapshot: SimSnapshot): void {
		this.save(snapshot);
	}

	load(): SimSnapshot | null {
		const cursor = this.storage.sql.exec(
			"SELECT value FROM tower WHERE key = ?",
			"state",
		);
		const row = cursor.toArray()[0] as { value: string } | undefined;
		if (!row) return null;
		return JSON.parse(row.value) as SimSnapshot;
	}

	save(snapshot: SimSnapshot): void {
		this.storage.sql.exec(
			"INSERT OR REPLACE INTO tower VALUES (?, ?)",
			"state",
			JSON.stringify(snapshot),
		);
	}
}
