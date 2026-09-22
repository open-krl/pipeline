// tests/build/build.test.ts

import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { StationMasterResponseSchema } from "@/api/schemas";
import { executeBuild } from "@/build/build";
import { foldArchive } from "@/build/fold";
import { persistBuildResult } from "@/build/persist";
import type { RawArchive, RawSnapshot } from "@/build/types";
import * as schema from "@/db/tables";

const FIXTURES_DIR = join(import.meta.dir, "../fixtures");
const TEST_SCRATCH_DIR = join(process.cwd(), "scratch/test_build_env");

describe("Build Stage Integration Suite", () => {
	const stationsRaw = JSON.parse(
		readFileSync(join(FIXTURES_DIR, "stations.json"), "utf8"),
	);
	const stationsPayload = StationMasterResponseSchema.parse(stationsRaw);

	it("persistBuildResult writes FoldResult to SQLite and enables foreign keys and queries", () => {
		const tempDir = join(TEST_SCRATCH_DIR, "persist-test");
		mkdirSync(tempDir, { recursive: true });
		const dbPath = join(tempDir, "test.db");

		try {
			const mockSnapshot: RawSnapshot = {
				id: 1,
				manifest: {
					timetable_version: 1,
					snapshot_id: 1,
					snapshot_date: "2026-09-17",
					day_type: "weekday",
					region_scope: "jabodetabek",
					station_master_hash: "hash",
					board_response_hash: "board",
					fetched_at: "2026-09-17T03:00:00Z",
					status: "complete",
				},
				archiveCommit: "1234567890abcdef",
				stations: stationsPayload,
				boards: new Map([
					[
						"BKS",
						{
							status: 200,
							data: [
								{
									train_id: "5552A",
									ka_name: "COMMUTER LINE CIKARANG",
									route_name: "KAMPUNGBANDAN-CIKARANG",
									dest: "CIKARANG",
									time_est: "16:24:00",
									color: "#0084D8",
									dest_time: "16:45:00",
								},
							],
						},
					],
					[
						"KPB",
						{
							status: 200,
							data: [
								{
									train_id: "5552A",
									ka_name: "COMMUTER LINE CIKARANG",
									route_name: "KAMPUNGBANDAN-CIKARANG",
									dest: "CIKARANG",
									time_est: "15:39:00",
									color: "#0084D8",
									dest_time: "16:45:00",
								},
							],
						},
					],
				]),
			};

			const train5552ARaw = JSON.parse(
				readFileSync(join(FIXTURES_DIR, "train_id_5552A.json"), "utf8"),
			);

			const archive: RawArchive = {
				timetableVersion: 1,
				snapshots: [mockSnapshot],
				itineraries: new Map([
					[
						"5552A",
						{
							train_id: "5552A",
							observations: {
								weekday: {
									fetched_at: "2026-09-17T03:00:00Z",
									payload_hash: "hash5552A",
									stops: train5552ARaw.data,
								},
							},
						},
					],
				]),
				stationCoordinates: new Map([["BKS", { lat: -6.2361, lon: 106.9995 }]]),
				holidays: [
					{
						holiday_date: "2026-01-01",
						name: "Tahun Baru",
						is_collective_leave: false,
					},
				],
			};

			const foldResult = foldArchive(archive);
			persistBuildResult(dbPath, foldResult);

			// Connect and verify using Drizzle
			const sqlite = new Database(dbPath);
			const db = drizzle({ client: sqlite });

			// 1. Verify stations
			const stationsCount = db.select().from(schema.stations).all().length;
			expect(stationsCount).toBe(foldResult.stations.length);

			// 2. Verify snapshot
			const snaps = db.select().from(schema.snapshots).all();
			expect(snaps.length).toBe(1);
			expect(snaps[0].archive_commit).toBe("1234567890abcdef");

			// 3. Verify trip
			const trip = db
				.select()
				.from(schema.trips)
				.where(eq(schema.trips.trip_id, "5552A"))
				.get();
			expect(trip).toBeDefined();
			expect(trip?.total_stops).toBe(18);
			expect(trip?.origin_station_id).toBe("KPB");
			expect(trip?.dest_station_id).toBe("CKR");

			// 4. Verify calendar
			const cal = db
				.select()
				.from(schema.tripCalendar)
				.where(eq(schema.tripCalendar.trip_id, "5552A"))
				.get();
			expect(cal).toBeDefined();
			expect(cal?.runs_weekday).toBe(1);
			expect(cal?.calendar_state).toBe("provisional");

			// 5. Verify trip stops
			const stops = db
				.select()
				.from(schema.tripStops)
				.where(eq(schema.tripStops.trip_id, "5552A"))
				.all();
			expect(stops.length).toBe(18);
			expect(stops[0].arrival_secs).toBeNull();
			expect(stops[17].departure_secs).toBeNull();

			// 6. Verify holidays
			const hols = db.select().from(schema.holidays).all();
			expect(hols.length).toBe(1);

			sqlite.close();
		} finally {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("executeBuild runs end-to-end build from directory structure", async () => {
		const tempDir = join(TEST_SCRATCH_DIR, "exec-test");
		mkdirSync(tempDir, { recursive: true });

		try {
			// Set up raw directory layout
			const dataDir = join(tempDir, "raw");
			const snapDir = join(dataDir, "1", "captures", "1");
			const boardsDir = join(snapDir, "boards");
			const itinDir = join(dataDir, "1", "itineraries");
			mkdirSync(boardsDir, { recursive: true });
			mkdirSync(itinDir, { recursive: true });

			// Write manifest.json
			writeFileSync(
				join(snapDir, "manifest.json"),
				JSON.stringify({
					timetable_version: 1,
					snapshot_id: 1,
					snapshot_date: "2026-09-17",
					day_type: "weekday",
					region_scope: "jabodetabek",
					station_master_hash: "a".repeat(64),
					board_response_hash: "b".repeat(64),
					fetched_at: "2026-09-17T03:00:00Z",
					status: "complete",
				}),
			);

			// Write stations.json
			writeFileSync(
				join(snapDir, "stations.json"),
				JSON.stringify(stationsPayload),
			);

			// Write boards (KPB and BKS)
			writeFileSync(
				join(boardsDir, "KPB.json"),
				JSON.stringify({
					status: 200,
					data: [
						{
							train_id: "5552A",
							ka_name: "COMMUTER LINE CIKARANG",
							route_name: "KAMPUNGBANDAN-CIKARANG",
							dest: "CIKARANG",
							time_est: "15:39:00",
							color: "#0084D8",
							dest_time: "16:45:00",
						},
					],
				}),
			);

			writeFileSync(
				join(boardsDir, "BKS.json"),
				JSON.stringify({
					status: 200,
					data: [
						{
							train_id: "5552A",
							ka_name: "COMMUTER LINE CIKARANG",
							route_name: "KAMPUNGBANDAN-CIKARANG",
							dest: "CIKARANG",
							time_est: "16:24:00",
							color: "#0084D8",
							dest_time: "16:45:00",
						},
					],
				}),
			);

			// Write 5552A itinerary envelope
			const train5552ARaw = JSON.parse(
				readFileSync(join(FIXTURES_DIR, "train_id_5552A.json"), "utf8"),
			);
			writeFileSync(
				join(itinDir, "5552A.json"),
				JSON.stringify({
					train_id: "5552A",
					observations: {
						weekday: {
							fetched_at: "2026-09-17T03:00:00Z",
							payload_hash: "c".repeat(64),
							stops: train5552ARaw.data,
						},
					},
				}),
			);

			// Execute Build
			const outDir = join(tempDir, "build");
			const result = await executeBuild({
				dataDir,
				outDir,
				version: 1,
				cwd: tempDir,
			});

			expect(result.timetableVersion).toBe(1);
			expect(result.snapshotsFolded).toBe(1);
			expect(result.stats.totalTrips).toBe(1);
			expect(result.stats.itineraryTrips).toBe(1);
			expect(result.stats.calendarResolved).toBe(false);

			// Verify created SQLite file exists
			const sqlite = new Database(result.dbPath);
			const db = drizzle({ client: sqlite });
			const trips = db.select().from(schema.trips).all();
			expect(trips.length).toBe(1);
			expect(trips[0].trip_id).toBe("5552A");
			sqlite.close();
		} finally {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});
});
