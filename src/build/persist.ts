// src/build/persist.ts
import { mkdirSync } from "node:fs";
import * as path from "node:path";
import { initDb } from "../db/connection";
import * as schema from "../db/tables";
import type { FoldResult } from "./types";

const BATCH_SIZE = 200;

function batchInsert<T>(
	items: T[],
	batchSize: number,
	inserter: (chunk: T[]) => void,
): void {
	for (let i = 0; i < items.length; i += batchSize) {
		const chunk = items.slice(i, i + batchSize);
		if (chunk.length > 0) {
			inserter(chunk);
		}
	}
}

/**
 * Atomically writes the complete FoldResult to SQLite in a single transaction.
 */
export function persistBuildResult(
	dbPath: string,
	foldResult: FoldResult,
	schemaPath?: string,
): void {
	const dir = path.dirname(dbPath);
	mkdirSync(dir, { recursive: true });

	const { sqlite, db } = initDb(dbPath, schemaPath);

	try {
		db.transaction((tx) => {
			// 1. Stations
			if (foldResult.stations.length > 0) {
				batchInsert(foldResult.stations, BATCH_SIZE, (chunk) => {
					tx.insert(schema.stations).values(chunk).run();
				});
			}

			// 2. Snapshots
			if (foldResult.snapshots.length > 0) {
				batchInsert(foldResult.snapshots, BATCH_SIZE, (chunk) => {
					tx.insert(schema.snapshots).values(chunk).run();
				});
			}

			// 3. Trips
			if (foldResult.trips.length > 0) {
				batchInsert(foldResult.trips, BATCH_SIZE, (chunk) => {
					tx.insert(schema.trips).values(chunk).run();
				});
			}

			// 4. Trip Calendar
			if (foldResult.tripCalendar.length > 0) {
				batchInsert(foldResult.tripCalendar, BATCH_SIZE, (chunk) => {
					tx.insert(schema.tripCalendar).values(chunk).run();
				});
			}

			// 5. Trip Stops
			if (foldResult.tripStops.length > 0) {
				batchInsert(foldResult.tripStops, BATCH_SIZE, (chunk) => {
					tx.insert(schema.tripStops).values(chunk).run();
				});
			}

			// 6. Holidays
			if (foldResult.holidays.length > 0) {
				batchInsert(foldResult.holidays, BATCH_SIZE, (chunk) => {
					tx.insert(schema.holidays).values(chunk).run();
				});
			}

			// 7. Quarantined Trips
			if (foldResult.quarantinedTrips.length > 0) {
				batchInsert(foldResult.quarantinedTrips, BATCH_SIZE, (chunk) => {
					tx.insert(schema.quarantinedTrips).values(chunk).run();
				});
			}
		});
	} finally {
		sqlite.close();
	}
}
