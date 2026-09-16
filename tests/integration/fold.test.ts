// tests/integration/fold.test.ts
import { describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import {
	ItineraryResponseSchema,
	StationMasterResponseSchema,
} from "../../src/api/schemas";
import { parseHMS, resolveItinerarySecs } from "../../src/core/time";
import { parseTrainId } from "../../src/core/trainid";
import { initDb } from "../../src/db/connection";
import * as schema from "../../src/db/tables";

const FIXTURES_DIR = join(import.meta.dir, "../fixtures");

describe("Milestone 1 Offline Fold Integration Test", () => {
	it("executes an end-to-end offline fold into SQLite from authentic fixtures", () => {
		const tempDir = mkdtempSync(join(tmpdir(), "krl-fold-test-"));
		const dbPath = join(tempDir, "fold_test.db");

		try {
			const { sqlite, db } = initDb(dbPath);

			// 1. Ingest Station Master
			const stationsRaw = JSON.parse(
				readFileSync(join(FIXTURES_DIR, "stations.json"), "utf8"),
			);
			const stationsPayload = StationMasterResponseSchema.parse(stationsRaw);

			// Filter out WIL% section headers
			const validStations = stationsPayload.data.filter(
				(s) => !s.sta_id.startsWith("WIL"),
			);

			for (const st of validStations) {
				db.insert(schema.stations)
					.values({
						sta_id: st.sta_id,
						sta_name: st.sta_name,
						group_wil: st.group_wil,
						fg_enable: st.fg_enable,
						first_seen: "2026-09-17",
						last_seen: "2026-09-17",
					})
					.run();
			}

			const stationRows = db.select().from(schema.stations).all();
			expect(stationRows.length).toBe(validStations.length);

			// 2. Ingest Snapshot
			db.insert(schema.snapshots)
				.values({
					snapshot_id: 1,
					snapshot_date: "2026-09-17",
					day_type: "weekday",
					region_scope: "jabodetabek",
					fetched_at: "2026-09-17T03:00:00Z",
					status: "complete",
					timetable_version: 1,
					archive_commit: "0000000000000000000000000000000000000000",
				})
				.run();

			// 3. Ingest Train 5552A from Itinerary + Board
			const trainRaw = JSON.parse(
				readFileSync(join(FIXTURES_DIR, "train_id_5552A.json"), "utf8"),
			);
			const trainPayload = ItineraryResponseSchema.parse(trainRaw);
			const stops = trainPayload.data;
			expect(stops.length).toBe(18);

			const parsedId = parseTrainId("5552A");
			if (!parsedId) {
				throw new Error("Expected parsedId for 5552A");
			}

			// Resolve stop times
			const resolvedTimes = resolveItinerarySecs(stops);
			const originStop = stops[0];
			const destStop = stops[stops.length - 1];

			const originSecs = parseHMS(originStop.time_est);
			const destSecs = parseHMS(destStop.time_est);

			// Insert Trip
			db.insert(schema.trips)
				.values({
					timetable_version: 1,
					trip_id: parsedId.trip_id,
					base_train_no: parsedId.base_train_no,
					revision: parsedId.revision,
					line_name: originStop.ka_name,
					route_name_raw: "KAMPUNGBANDAN-CIKARANG",
					headsign: destStop.station_name,
					origin_station_id: originStop.station_id,
					dest_station_id: destStop.station_id,
					origin_time: originStop.time_est,
					dest_time: destStop.time_est,
					origin_secs: originSecs,
					dest_secs: destSecs,
					total_stops: stops.length,
					color: originStop.color,
					is_fakultatif: parsedId.is_fakultatif ? 1 : 0,
					source: "itinerary",
					itinerary_status: "200",
					first_seen_snapshot: 1,
					last_seen_snapshot: 1,
				})
				.run();

			// Insert Trip Calendar (provisional weekday fold)
			db.insert(schema.tripCalendar)
				.values({
					timetable_version: 1,
					trip_id: parsedId.trip_id,
					runs_weekday: 1,
					runs_saturday: 0,
					runs_sunday: 0,
					captured_day_types: 1,
					calendar_state: "provisional",
				})
				.run();

			// Insert Trip Stops
			for (let i = 0; i < stops.length; i++) {
				const stop = stops[i];
				const times = resolvedTimes[i];

				db.insert(schema.tripStops)
					.values({
						timetable_version: 1,
						trip_id: parsedId.trip_id,
						stop_sequence: i + 1,
						station_id: stop.station_id,
						time_raw: stop.time_est,
						arrival_secs: times.arrival_secs,
						departure_secs: times.departure_secs,
						is_transit: stop.transit_station ? 1 : 0,
					})
					.run();
			}

			// 4. Verify Relational Queries
			const trip = db
				.select()
				.from(schema.trips)
				.where(eq(schema.trips.trip_id, "5552A"))
				.get();

			expect(trip).toBeDefined();
			expect(trip?.base_train_no).toBe(5552);
			expect(trip?.revision).toBe("A");
			expect(trip?.total_stops).toBe(18);
			expect(trip?.origin_station_id).toBe("KPB");
			expect(trip?.dest_station_id).toBe("CKR");

			const calendar = db
				.select()
				.from(schema.tripCalendar)
				.where(eq(schema.tripCalendar.trip_id, "5552A"))
				.get();

			expect(calendar?.runs_weekday).toBe(1);
			expect(calendar?.calendar_state).toBe("provisional");

			const tripStops = db
				.select()
				.from(schema.tripStops)
				.where(eq(schema.tripStops.trip_id, "5552A"))
				.all();

			expect(tripStops.length).toBe(18);
			expect(tripStops[0].stop_sequence).toBe(1);
			expect(tripStops[0].arrival_secs).toBeNull();
			expect(tripStops[0].departure_secs).toBe(originSecs);
			expect(tripStops[17].departure_secs).toBeNull();

			sqlite.close();
		} finally {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});
});
