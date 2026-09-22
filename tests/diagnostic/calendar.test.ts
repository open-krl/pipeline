// tests/diagnostic/calendar.test.ts

import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import {
	analyzeDayTypeCalendar,
	loadCalendarFromDatabase,
	loadCalendarFromSnapshots,
} from "@/diagnostic/calendar";
import type { TripSummary } from "@/diagnostic/fingerprint";
import { formatCalendarReport } from "@/diagnostic/format";

function makeTripSummary(params: {
	trainId: string;
	baseTrainNo: number;
	originStation: string;
	dest: string;
	destTime: string;
	destTimeSecs: number;
	originDepSecs?: number;
	isFakultatif?: boolean;
	kaName?: string;
	routeName?: string;
}): TripSummary {
	return {
		trainId: params.trainId,
		baseTrainNo: params.baseTrainNo,
		revision: null,
		isFakultatif: params.isFakultatif ?? false,
		kaName: params.kaName ?? "Commuter Line Bogor",
		routeName: params.routeName ?? "JAKARTA KOTA-BOGOR",
		dest: params.dest,
		destTime: params.destTime,
		destTimeSecs: params.destTimeSecs,
		originStation: params.originStation,
		originDepSecs: params.originDepSecs ?? params.destTimeSecs - 3600,
		departures: new Map(),
	};
}

describe("Empirical Calendar Identity & Set Difference Engine (§9)", () => {
	it("classifies 3-way daily, re-lettered, retimed, and day-specific services accurately", () => {
		const weekday = new Map<string, TripSummary>();
		const saturday = new Map<string, TripSummary>();
		const sunday = new Map<string, TripSummary>();

		// 1. Identical daily service (5001 across all days)
		const trip5001 = makeTripSummary({
			trainId: "5001",
			baseTrainNo: 5001,
			originStation: "JAKK",
			dest: "BOO",
			destTime: "07:00:00",
			destTimeSecs: 25200,
		});
		weekday.set("5001", trip5001);
		saturday.set("5001", trip5001);
		sunday.set("5001", trip5001);

		// 2. Re-lettered daily service (5022D weekday -> 5022E saturday & sunday)
		const trip5022D = makeTripSummary({
			trainId: "5022D",
			baseTrainNo: 5022,
			originStation: "JAKK",
			dest: "BOO",
			destTime: "08:15:00",
			destTimeSecs: 29700,
		});
		const trip5022E = makeTripSummary({
			trainId: "5022E",
			baseTrainNo: 5022,
			originStation: "JAKK",
			dest: "BOO",
			destTime: "08:15:00",
			destTimeSecs: 29700,
		});
		weekday.set("5022D", trip5022D);
		saturday.set("5022E", trip5022E);
		sunday.set("5022E", trip5022E);

		// 3. Retimed daily service (2200 weekday 09:00 -> weekend 09:05, delta 300s)
		const trip2200W = makeTripSummary({
			trainId: "2200",
			baseTrainNo: 2200,
			originStation: "JAKK",
			dest: "BOO",
			destTime: "09:00:00",
			destTimeSecs: 32400,
		});
		const trip2200Sa = makeTripSummary({
			trainId: "2200",
			baseTrainNo: 2200,
			originStation: "JAKK",
			dest: "BOO",
			destTime: "09:05:00",
			destTimeSecs: 32700,
		});
		weekday.set("2200", trip2200W);
		saturday.set("2200", trip2200Sa);
		sunday.set("2200", trip2200Sa);

		// 4. Weekday only commuter reinforcement (5100)
		const trip5100 = makeTripSummary({
			trainId: "5100",
			baseTrainNo: 5100,
			originStation: "JAKK",
			dest: "BOO",
			destTime: "06:30:00",
			destTimeSecs: 23400,
		});
		weekday.set("5100", trip5100);

		// 5. Weekend only recreational service (5900)
		const trip5900 = makeTripSummary({
			trainId: "5900",
			baseTrainNo: 5900,
			originStation: "JAKK",
			dest: "BOO",
			destTime: "10:00:00",
			destTimeSecs: 36000,
		});
		saturday.set("5900", trip5900);
		sunday.set("5900", trip5900);

		// 6. Saturday only service (5901)
		const trip5901 = makeTripSummary({
			trainId: "5901",
			baseTrainNo: 5901,
			originStation: "JAKK",
			dest: "BOO",
			destTime: "11:00:00",
			destTimeSecs: 39600,
		});
		saturday.set("5901", trip5901);

		// 7. Sunday only service (5902)
		const trip5902 = makeTripSummary({
			trainId: "5902",
			baseTrainNo: 5902,
			originStation: "JAKK",
			dest: "BOO",
			destTime: "12:00:00",
			destTimeSecs: 43200,
		});
		sunday.set("5902", trip5902);

		// 8. Fakultatif service suspended on weekend (9002F)
		const trip9002F = makeTripSummary({
			trainId: "9002F",
			baseTrainNo: 9002,
			originStation: "MRI",
			dest: "BKS",
			destTime: "13:00:00",
			destTimeSecs: 46800,
			isFakultatif: true,
		});
		weekday.set("9002F", trip9002F);

		const result = analyzeDayTypeCalendar({
			timetableVersion: 1,
			source: "snapshots",
			weekdayTrips: weekday,
			saturdayTrips: saturday,
			sundayTrips: sunday,
		});

		expect(result.availableDayTypes.weekday).toBe(true);
		expect(result.availableDayTypes.saturday).toBe(true);
		expect(result.availableDayTypes.sunday).toBe(true);
		expect(result.totalServices).toBe(8);

		// 3-way breakdown checks
		expect(result.breakdown.daily.length).toBe(3); // 5001, 5022, 2200
		expect(result.breakdown.weekdayOnly.length).toBe(2); // 5100, 9002F
		expect(result.breakdown.weekendOnly.length).toBe(1); // 5900
		expect(result.breakdown.saturdayOnly.length).toBe(1); // 5901
		expect(result.breakdown.sundayOnly.length).toBe(1); // 5902

		// Diagnostic statistics
		expect(result.stats.coreSharedCount).toBe(3);
		expect(result.stats.reletteredCount).toBe(1); // 5022D -> 5022E
		expect(result.stats.retimedCount).toBe(1); // 2200 (+300s)
		expect(result.stats.fakultatif.total).toBe(1);
		expect(result.stats.fakultatif.suspendedOnWeekend).toBe(1);

		// Relettered cluster verified
		const reletteredCluster = result.breakdown.daily.find(
			(c) => c.baseTrainNo === 5022,
		);
		expect(reletteredCluster).toBeDefined();
		expect(reletteredCluster?.relettered).toBe(true);
		expect(reletteredCluster?.trainIds).toEqual(["5022D", "5022E"]);

		// Report formatting
		const textReport = formatCalendarReport(result, true);
		expect(textReport).toContain("Resolved (3/3 day types confirmed)");
		expect(textReport).toContain("Daily (All 7 Days):         3 services");
		expect(textReport).toContain(
			"Re-lettered on Weekend: 1 services (e.g. 5022D -> 5022E)",
		);
		expect(textReport).toContain("5022D -> 5022E");
	});

	it("handles provisional calendar state when only weekday is captured", () => {
		const weekday = new Map<string, TripSummary>();
		weekday.set(
			"5001",
			makeTripSummary({
				trainId: "5001",
				baseTrainNo: 5001,
				originStation: "JAKK",
				dest: "BOO",
				destTime: "07:00:00",
				destTimeSecs: 25200,
			}),
		);

		const result = analyzeDayTypeCalendar({
			timetableVersion: 1,
			source: "snapshots",
			weekdayTrips: weekday,
			saturdayTrips: null,
			sundayTrips: null,
		});

		expect(result.availableDayTypes.weekday).toBe(true);
		expect(result.availableDayTypes.saturday).toBe(false);
		expect(result.availableDayTypes.sunday).toBe(false);
		expect(result.summary).toContain("Provisional: 1/3 day types available");
		expect(result.breakdown.weekdayOnly.length).toBe(1);
		expect(result.breakdown.daily.length).toBe(0);

		const report = formatCalendarReport(result);
		expect(report).toContain("Provisional (1/3 day types: Weekday)");
		expect(report).toContain("Saturday Departures:  N/A");
	});

	it("loads calendar data from SQLite database schema", async () => {
		const { promises: fs } = await import("node:fs");
		const scratchDir = "scratch";
		await fs.mkdir(scratchDir, { recursive: true });
		const testDbPath = "scratch/test_calendar.db";
		const diskDb = new Database(testDbPath);
		diskDb.run(`
			CREATE TABLE trips (
				timetable_version INTEGER NOT NULL,
				trip_id TEXT NOT NULL,
				base_train_no INTEGER NOT NULL,
				revision TEXT,
				is_fakultatif INTEGER DEFAULT 0,
				line_name TEXT NOT NULL,
				route_name_raw TEXT NOT NULL,
				dest_station_id TEXT NOT NULL,
				dest_time TEXT NOT NULL,
				dest_secs INTEGER NOT NULL,
				origin_station_id TEXT,
				origin_secs INTEGER NOT NULL,
				PRIMARY KEY (timetable_version, trip_id)
			);
			CREATE TABLE trip_calendar (
				timetable_version INTEGER NOT NULL,
				trip_id TEXT NOT NULL,
				runs_weekday INTEGER NOT NULL,
				runs_saturday INTEGER NOT NULL,
				runs_sunday INTEGER NOT NULL,
				captured_day_types INTEGER NOT NULL,
				calendar_state TEXT NOT NULL,
				PRIMARY KEY (timetable_version, trip_id)
			);
			INSERT INTO trips VALUES
			(1, '5001', 5001, NULL, 0, 'Commuter Line Bogor', 'JAKK-BOO', 'BOO', '07:00:00', 25200, 'JAKK', 21600),
			(1, '5002', 5002, NULL, 1, 'Commuter Line Bogor', 'JAKK-BOO', 'BOO', '08:00:00', 28800, 'JAKK', 25200);

			INSERT INTO trip_calendar VALUES
			(1, '5001', 1, 1, 1, 3, 'resolved'),
			(1, '5002', 1, 0, 0, 3, 'resolved');
		`);
		diskDb.close();

		try {
			const loaded = await loadCalendarFromDatabase(testDbPath, 1);
			expect(loaded.version).toBe(1);
			expect(loaded.weekdayTrips?.size).toBe(2);
			expect(loaded.saturdayTrips?.size).toBe(1);
			expect(loaded.sundayTrips?.size).toBe(1);
			expect(loaded.weekdayTrips?.get("5001")?.trainId).toBe("5001");
			expect(loaded.saturdayTrips?.get("5001")?.trainId).toBe("5001");
			expect(loaded.saturdayTrips?.has("5002")).toBe(false);
		} finally {
			await fs.unlink(testDbPath).catch(() => {});
		}
	});

	it("loads raw snapshot captures from disk and analyzes baseline calendar", async () => {
		const rawDir = "data/raw";
		const data = await loadCalendarFromSnapshots(rawDir, 1);
		expect(data.version).toBe(1);
		expect(data.weekdayTrips).not.toBeNull();
		expect(data.weekdayTrips?.size).toBeGreaterThan(0);

		const analysis = analyzeDayTypeCalendar({
			timetableVersion: data.version,
			source: "snapshots",
			weekdayTrips: data.weekdayTrips,
			saturdayTrips: data.saturdayTrips,
			sundayTrips: data.sundayTrips,
		});

		expect(analysis.totalServices).toBeGreaterThan(0);
		expect(analysis.availableDayTypes.weekday).toBe(true);

		const report = formatCalendarReport(analysis);
		expect(report).toContain("Calendar Schedule Identity Report");
		expect(report).toContain("Timetable Version:    1");
	});

	it("executes calendar command through CLI runner", async () => {
		const { createCli } = await import("@/cli");
		const cli = createCli();
		let output = "";
		const originalLog = console.log;
		console.log = (msg?: unknown) => {
			output += `${String(msg)}\n`;
		};

		try {
			cli.parse(
				["bun", "src/cli.ts", "calendar", "1", "--data-dir", "data/raw"],
				{
					run: false,
				},
			);
			await cli.runMatchedCommand();
		} finally {
			console.log = originalLog;
		}

		expect(output).toContain("Calendar Schedule Identity Report");
		expect(output).toContain("Timetable Version:    1");
	});
});
