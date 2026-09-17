// tests/diagnostic/detect.test.ts

import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import { promises as fs } from "node:fs";
import { type FetchFunction, KciClient } from "../../src/api/client";
import type { DepartureBoardResponse } from "../../src/api/schemas";
import { DRIFT_THRESHOLDS, executeDetect } from "../../src/diagnostic/detect";
import { formatDetectReport } from "../../src/diagnostic/format";

describe("Operational Corridor Drift Probe (§9 Task 6.5, §12)", () => {
	it("exports expected operational drift thresholds", () => {
		expect(DRIFT_THRESHOLDS.maxRelettered).toBe(5);
		expect(DRIFT_THRESHOLDS.minCongruenceRatio).toBe(0.85);
		expect(DRIFT_THRESHOLDS.maxAdded).toBe(5);
		expect(DRIFT_THRESHOLDS.maxWithdrawn).toBe(10);
	});
	function createMockClient(
		liveBoards: Record<string, DepartureBoardResponse>,
	): KciClient {
		const mockFetch: FetchFunction = async (input: RequestInfo | URL) => {
			const urlStr = input instanceof Request ? input.url : String(input);
			const url = new URL(urlStr);
			const stationId = url.searchParams.get("stationid") ?? "";
			const board = liveBoards[stationId];
			if (!board) {
				return new Response(JSON.stringify({ status: 200, data: [] }), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				});
			}
			return new Response(JSON.stringify(board), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});
		};

		return new KciClient({
			baseUrl: "https://mock.kci.id",
			fetchFn: mockFetch,
			pacingMs: 0,
			retryBaseMs: 1,
		});
	}

	it("detects STABLE status when live departures match database baseline", async () => {
		const scratchDir = "scratch";
		await fs.mkdir(scratchDir, { recursive: true });
		const testDbPath = "scratch/test_detect.db";

		const diskDb = new Database(testDbPath);
		diskDb.run(`
			CREATE TABLE trips (
				timetable_version INTEGER NOT NULL,
				trip_id TEXT NOT NULL,
				base_train_no INTEGER NOT NULL,
				line_name TEXT NOT NULL,
				route_name_raw TEXT NOT NULL,
				headsign TEXT NOT NULL,
				dest_station_id TEXT NOT NULL,
				dest_time TEXT NOT NULL,
				color TEXT NOT NULL,
				PRIMARY KEY (timetable_version, trip_id)
			);
			CREATE TABLE trip_stops (
				timetable_version INTEGER NOT NULL,
				trip_id TEXT NOT NULL,
				stop_sequence INTEGER NOT NULL,
				station_id TEXT NOT NULL,
				time_raw TEXT NOT NULL,
				departure_secs INTEGER,
				PRIMARY KEY (timetable_version, trip_id, stop_sequence)
			);
			CREATE TABLE trip_calendar (
				timetable_version INTEGER NOT NULL,
				trip_id TEXT NOT NULL,
				runs_weekday INTEGER NOT NULL,
				runs_saturday INTEGER NOT NULL,
				runs_sunday INTEGER NOT NULL,
				PRIMARY KEY (timetable_version, trip_id)
			);

			-- MRI departure
			INSERT INTO trips VALUES (1, '5001', 5001, 'Commuter Line Bogor', 'JAKK-BOO', 'BOGOR', 'BOO', '07:30:00', '#ED1B24');
			INSERT INTO trip_stops VALUES (1, '5001', 1, 'MRI', '07:00:00', 25200);
			INSERT INTO trip_calendar VALUES (1, '5001', 1, 1, 1);

			-- BKS departure
			INSERT INTO trips VALUES (1, '5101', 5101, 'Commuter Line Cikarang', 'PSE-CKR', 'CIKARANG', 'CKR', '08:45:00', '#0072C6');
			INSERT INTO trip_stops VALUES (1, '5101', 1, 'BKS', '08:00:00', 28800);
			INSERT INTO trip_calendar VALUES (1, '5101', 1, 1, 1);

			-- RK departure
			INSERT INTO trips VALUES (1, '1901', 1901, 'Commuter Line Rangkasbitung', 'THB-RK', 'RANGKASBITUNG', 'RK', '09:30:00', '#2E7D32');
			INSERT INTO trip_stops VALUES (1, '1901', 1, 'RK', '09:00:00', 32400);
			INSERT INTO trip_calendar VALUES (1, '1901', 1, 1, 1);
		`);
		diskDb.close();

		// Live client returns identical departures
		const client = createMockClient({
			MRI: {
				status: 200,
				data: [
					{
						train_id: "5001",
						ka_name: "Commuter Line Bogor",
						route_name: "JAKK-BOO",
						dest: "BOGOR",
						time_est: "07:00:00",
						color: "#ED1B24",
						dest_time: "07:30:00",
					},
				],
			},
			BKS: {
				status: 200,
				data: [
					{
						train_id: "5101",
						ka_name: "Commuter Line Cikarang",
						route_name: "PSE-CKR",
						dest: "CIKARANG",
						time_est: "08:00:00",
						color: "#0072C6",
						dest_time: "08:45:00",
					},
				],
			},
			RK: {
				status: 200,
				data: [
					{
						train_id: "1901",
						ka_name: "Commuter Line Rangkasbitung",
						route_name: "THB-RK",
						dest: "RANGKASBITUNG",
						time_est: "09:00:00",
						color: "#2E7D32",
						dest_time: "09:30:00",
					},
				],
			},
		});

		try {
			const result = await executeDetect({
				client,
				dbPath: testDbPath,
				version: 1,
				dayType: "weekday",
			});

			expect(result.status).toBe("STABLE");
			expect(result.totalExpected).toBe(3);
			expect(result.totalIdentical).toBe(3);
			expect(result.totalRelettered).toBe(0);
			expect(result.totalRetimed).toBe(0);

			const report = formatDetectReport(result);
			expect(report).toContain("Status:               STABLE (Congruent) ✅");
			expect(report).toContain("Congruent Departures: 3 / 3 (100.0%)");
		} finally {
			await fs.unlink(testDbPath).catch(() => {});
		}
	});

	it("detects POTENTIAL_EDITION_DRIFT when corridor exhibits re-lettering drift", async () => {
		const scratchDir = "scratch";
		await fs.mkdir(scratchDir, { recursive: true });
		const testDbPath = "scratch/test_detect_drift.db";

		const diskDb = new Database(testDbPath);
		diskDb.run(`
			CREATE TABLE trips (
				timetable_version INTEGER NOT NULL,
				trip_id TEXT NOT NULL,
				base_train_no INTEGER NOT NULL,
				line_name TEXT NOT NULL,
				route_name_raw TEXT NOT NULL,
				headsign TEXT NOT NULL,
				dest_station_id TEXT NOT NULL,
				dest_time TEXT NOT NULL,
				color TEXT NOT NULL,
				PRIMARY KEY (timetable_version, trip_id)
			);
			CREATE TABLE trip_stops (
				timetable_version INTEGER NOT NULL,
				trip_id TEXT NOT NULL,
				stop_sequence INTEGER NOT NULL,
				station_id TEXT NOT NULL,
				time_raw TEXT NOT NULL,
				departure_secs INTEGER,
				PRIMARY KEY (timetable_version, trip_id, stop_sequence)
			);
			CREATE TABLE trip_calendar (
				timetable_version INTEGER NOT NULL,
				trip_id TEXT NOT NULL,
				runs_weekday INTEGER NOT NULL,
				runs_saturday INTEGER NOT NULL,
				runs_sunday INTEGER NOT NULL,
				PRIMARY KEY (timetable_version, trip_id)
			);
		`);

		// Seed 6 trips in baseline (e.g. 5001A to 5006A)
		for (let i = 1; i <= 6; i++) {
			const tid = `500${i}A`;
			const base = 5000 + i;
			diskDb.run(
				`INSERT INTO trips VALUES (1, '${tid}', ${base}, 'Commuter Line Bogor', 'JAKK-BOO', 'BOGOR', 'BOO', '08:00:00', '#ED1B24')`,
			);
			diskDb.run(
				`INSERT INTO trip_stops VALUES (1, '${tid}', 1, 'MRI', '07:00:00', 25200)`,
			);
			diskDb.run(`INSERT INTO trip_calendar VALUES (1, '${tid}', 1, 1, 1)`);
		}
		diskDb.close();

		// Live returns all 6 relettered from 'A' to 'B' (suffix bump across network)
		const liveMriData = [];
		for (let i = 1; i <= 6; i++) {
			liveMriData.push({
				train_id: `500${i}B`,
				ka_name: "Commuter Line Bogor",
				route_name: "JAKK-BOO",
				dest: "BOGOR",
				time_est: "07:00:00",
				color: "#ED1B24",
				dest_time: "08:00:00",
			});
		}

		const client = createMockClient({
			MRI: { status: 200, data: liveMriData },
			BKS: { status: 200, data: [] },
			RK: { status: 200, data: [] },
		});

		try {
			const result = await executeDetect({
				client,
				dbPath: testDbPath,
				version: 1,
				dayType: "weekday",
			});

			expect(result.status).toBe("POTENTIAL_EDITION_DRIFT");
			expect(result.totalRelettered).toBe(6);
			expect(result.actionRecommendation).toContain("timetable version 2");

			const report = formatDetectReport(result);
			expect(report).toContain("POTENTIAL TIMETABLE EDITION DRIFT ⚠️");
			expect(report).toContain("Re-lettered Services: 6");
		} finally {
			await fs.unlink(testDbPath).catch(() => {});
		}
	});

	it("falls back to raw snapshot baseline when database is absent", async () => {
		const path = await import("node:path");
		const scratchRawDir = "scratch/test_detect_raw";
		const snapDir = path.join(scratchRawDir, "1", "captures", "1");
		const boardsDir = path.join(snapDir, "boards");
		await fs.mkdir(boardsDir, { recursive: true });

		const manifest = {
			snapshot_id: 1,
			timetable_version: 1,
			snapshot_date: "2026-09-17",
			day_type: "weekday",
			region_scope: "jabodetabek",
			fetched_at: "2026-09-17T00:00:00Z",
			status: "complete",
			station_count: 2,
			station_master_hash: "a".repeat(64),
			board_response_hash: "b".repeat(64),
			failed_stations: [],
		};
		await fs.writeFile(
			path.join(snapDir, "manifest.json"),
			JSON.stringify(manifest),
			"utf-8",
		);

		const mriBoard = {
			status: 200 as const,
			data: [
				{
					train_id: "5022D",
					ka_name: "COMMUTER LINE BOGOR",
					route_name: "JAKARTAKOTA-BOGOR",
					dest: "BOGOR",
					time_est: "07:15:00",
					color: "#ED1B24",
					dest_time: "08:50:00",
				},
			],
		};
		const bksBoard = {
			status: 200 as const,
			data: [
				{
					train_id: "5198C",
					ka_name: "COMMUTER LINE CIKARANG",
					route_name: "ANGKE-CIKARANG",
					dest: "CIKARANG",
					time_est: "00:01:00",
					color: "#0072C6",
					dest_time: "00:46:00",
				},
			],
		};
		await fs.writeFile(
			path.join(boardsDir, "MRI.json"),
			JSON.stringify(mriBoard),
			"utf-8",
		);
		await fs.writeFile(
			path.join(boardsDir, "BKS.json"),
			JSON.stringify(bksBoard),
			"utf-8",
		);

		const client = createMockClient({
			MRI: mriBoard,
			BKS: bksBoard,
			RK: { status: 200, data: [] },
		});

		try {
			const result = await executeDetect({
				client,
				dataDir: scratchRawDir,
				version: 1,
				dayType: "weekday",
				stations: ["MRI", "BKS"],
			});

			expect(result.baselineSource).toBe("snapshots");
			expect(result.stations.length).toBe(2);
			expect(result.status).toBe("STABLE");
			expect(result.totalIdentical).toBe(2);
		} finally {
			await fs
				.rm(scratchRawDir, { recursive: true, force: true })
				.catch(() => {});
		}
	});

	it("detects OPERATIONAL_VARIANCE when corridor exhibits bounded retiming", async () => {
		const scratchDir = "scratch";
		await fs.mkdir(scratchDir, { recursive: true });
		const testDbPath = "scratch/test_detect_variance.db";

		const diskDb = new Database(testDbPath);
		diskDb.run(`
			CREATE TABLE trips (
				timetable_version INTEGER NOT NULL,
				trip_id TEXT NOT NULL,
				base_train_no INTEGER NOT NULL,
				line_name TEXT NOT NULL,
				route_name_raw TEXT NOT NULL,
				headsign TEXT NOT NULL,
				dest_station_id TEXT NOT NULL,
				dest_time TEXT NOT NULL,
				color TEXT NOT NULL,
				PRIMARY KEY (timetable_version, trip_id)
			);
			CREATE TABLE trip_stops (
				timetable_version INTEGER NOT NULL,
				trip_id TEXT NOT NULL,
				stop_sequence INTEGER NOT NULL,
				station_id TEXT NOT NULL,
				time_raw TEXT NOT NULL,
				departure_secs INTEGER,
				PRIMARY KEY (timetable_version, trip_id, stop_sequence)
			);
			CREATE TABLE trip_calendar (
				timetable_version INTEGER NOT NULL,
				trip_id TEXT NOT NULL,
				runs_weekday INTEGER NOT NULL,
				runs_saturday INTEGER NOT NULL,
				runs_sunday INTEGER NOT NULL,
				PRIMARY KEY (timetable_version, trip_id)
			);
		`);

		// Seed 10 trips in baseline
		for (let i = 1; i <= 10; i++) {
			const tid = `500${i}A`;
			const base = 5000 + i;
			const depSecs = 25200 + i * 600; // starts 07:00, every 10m
			const depTime = `${String(Math.floor(depSecs / 3600)).padStart(2, "0")}:${String(Math.floor((depSecs % 3600) / 60)).padStart(2, "0")}:00`;
			diskDb.run(
				`INSERT INTO trips VALUES (1, '${tid}', ${base}, 'Commuter Line Bogor', 'JAKK-BOO', 'BOGOR', 'BOO', '08:30:00', '#ED1B24')`,
			);
			diskDb.run(
				`INSERT INTO trip_stops VALUES (1, '${tid}', 1, 'MRI', '${depTime}', ${depSecs})`,
			);
			diskDb.run(`INSERT INTO trip_calendar VALUES (1, '${tid}', 1, 1, 1)`);
		}
		diskDb.close();

		// Live data: 9 identical, 1 retimed by 3 minutes (180s)
		const liveMriData = [];
		for (let i = 1; i <= 10; i++) {
			const tid = `500${i}A`;
			let depSecs = 25200 + i * 600;
			if (i === 1) depSecs += 180; // Retimed by +3 mins
			const depTime = `${String(Math.floor(depSecs / 3600)).padStart(2, "0")}:${String(Math.floor((depSecs % 3600) / 60)).padStart(2, "0")}:00`;
			liveMriData.push({
				train_id: tid,
				ka_name: "Commuter Line Bogor",
				route_name: "JAKK-BOO",
				dest: "BOGOR",
				time_est: depTime,
				color: "#ED1B24",
				dest_time: "08:30:00",
			});
		}

		const client = createMockClient({
			MRI: { status: 200, data: liveMriData },
			BKS: { status: 200, data: [] },
			RK: { status: 200, data: [] },
		});

		try {
			const result = await executeDetect({
				client,
				dbPath: testDbPath,
				version: 1,
				dayType: "weekday",
				stations: ["MRI"],
			});

			expect(result.status).toBe("OPERATIONAL_VARIANCE");
			expect(result.totalExpected).toBe(10);
			expect(result.totalIdentical).toBe(9);
			expect(result.totalRetimed).toBe(1);
			expect(result.actionRecommendation).toContain(
				"Minor operational variances observed",
			);
		} finally {
			await fs.unlink(testDbPath).catch(() => {});
		}
	});
});
