// src/diagnostic/detect.ts
import { Database } from "bun:sqlite";
import { promises as fs } from "node:fs";
import { KciClient } from "../api/client";
import type { DepartureBoardItem } from "../api/schemas";
import { readSnapshotBoards, scanSnapshots } from "../archive/snapshots";
import { CORRIDOR_REFERENCE_STATIONS, TIMEZONE } from "../config";
import {
	type DayType,
	foldDayTypeRule,
	formatDateWib,
	HolidayFileSchema,
	type HolidayItem,
	resolveDayType,
} from "../core/calendar";
import { resolveSafePath } from "../core/path";
import { resolveDiagnosticBaseline } from "./baseline";
import { diffDepartureBoards } from "./board";
import type {
	CorridorDriftStatus,
	DetectResult,
	StationDriftResult,
} from "./types";

export interface ExecuteDetectOptions {
	client?: KciClient;
	dbPath?: string;
	dataDir?: string;
	version?: number;
	date?: Date;
	dayType?: DayType;
	holidaysPath?: string;
	stations?: string[];
	toleranceSecs?: number;
	preferSource?: "database" | "snapshots";
	cwd?: string;
}

export const DRIFT_THRESHOLDS = {
	maxRelettered: 5,
	minCongruenceRatio: 0.85,
	maxAdded: 5,
	maxWithdrawn: 10,
} as const;

const STATION_NAMES: Record<string, string> = {
	[CORRIDOR_REFERENCE_STATIONS.manggarai]: "Manggarai (Central Trunk)",
	[CORRIDOR_REFERENCE_STATIONS.bekasi]: "Bekasi (Eastern Corridor)",
	[CORRIDOR_REFERENCE_STATIONS.rangkasbitung]: "Rangkasbitung (Western Branch)",
};

/**
 * Loads baseline departure items for a specific station and day type from SQLite database.
 */
function loadStationDeparturesFromDb(
	db: InstanceType<typeof Database>,
	version: number,
	stationId: string,
	presenceColumn: "runs_weekday" | "runs_saturday" | "runs_sunday",
): DepartureBoardItem[] {
	interface StopRow {
		trip_id: string;
		line_name: string;
		route_name_raw: string;
		dest: string;
		dest_time: string;
		color: string;
		time_raw: string;
	}

	const rows = db
		.query<StopRow, [number, string]>(
			`SELECT t.trip_id, t.line_name, t.route_name_raw, COALESCE(t.headsign, t.dest_station_id) as dest, t.dest_time, t.color, s.time_raw
			 FROM trip_stops s
			 JOIN trips t ON s.timetable_version = t.timetable_version AND s.trip_id = t.trip_id
			 JOIN trip_calendar c ON s.timetable_version = c.timetable_version AND s.trip_id = c.trip_id
			 WHERE s.timetable_version = ?
			   AND s.station_id = ?
			   AND s.departure_secs IS NOT NULL
			   AND c.${presenceColumn} = 1
			 ORDER BY s.departure_secs ASC`,
		)
		.all(version, stationId);

	return rows.map((r) => ({
		train_id: r.trip_id,
		ka_name: r.line_name,
		route_name: r.route_name_raw,
		dest: r.dest,
		time_est: r.time_raw,
		color: r.color,
		dest_time: r.dest_time,
	}));
}

/**
 * Executes the live 3-station corridor drift probe (§9 Task 6.5, §12).
 * Compares live KCI departures against the active edition filtered for today's day type.
 */
export async function executeDetect(
	options: ExecuteDetectOptions = {},
): Promise<DetectResult> {
	const cwd = options.cwd ?? process.cwd();
	const now = options.date ?? new Date();
	const dateStr = formatDateWib(now);

	// 1. Resolve Day Type
	let dayType = options.dayType;
	if (!dayType) {
		const holidaysFilePath = resolveSafePath(
			options.holidaysPath ?? "data/holidays.json",
			cwd,
		);
		let holidays: HolidayItem[] = [];
		try {
			const content = await fs.readFile(holidaysFilePath, "utf-8");
			holidays = HolidayFileSchema.parse(JSON.parse(content));
		} catch {
			// If holidays file is missing, default to calendar DOW
		}
		dayType = resolveDayType(now, holidays);
	}
	const presenceCol = foldDayTypeRule(dayType);

	// 2. Resolve Station Targets
	const targetStations = options.stations ?? [
		CORRIDOR_REFERENCE_STATIONS.manggarai,
		CORRIDOR_REFERENCE_STATIONS.bekasi,
		CORRIDOR_REFERENCE_STATIONS.rangkasbitung,
	];

	// 3. Resolve Baseline Source & Departures
	const baseline = await resolveDiagnosticBaseline({
		version: options.version,
		dataDir: options.dataDir,
		dbPath: options.dbPath,
		cwd,
		preferSource: options.preferSource ?? "database",
	});

	const timetableVersion = baseline.version;
	const baselineSource = baseline.source;
	const expectedBoards = new Map<string, DepartureBoardItem[]>();

	if (baseline.source === "database") {
		const db = new Database(baseline.dbPath, { readonly: true });
		try {
			for (const staId of targetStations) {
				const deps = loadStationDeparturesFromDb(
					db,
					timetableVersion,
					staId,
					presenceCol,
				);
				expectedBoards.set(staId, deps);
			}
		} finally {
			db.close();
		}
	} else {
		const allSnaps = await scanSnapshots(baseline.dataDir, timetableVersion);
		const completeSnaps = allSnaps.filter(
			(s) =>
				s.manifest.status === "complete" && s.manifest.day_type === dayType,
		);
		const latestSnap = completeSnaps.pop();
		if (!latestSnap) {
			throw new Error(
				`No completed raw snapshots found for version ${timetableVersion} on day type '${dayType}'.`,
			);
		}

		const snapshotBoards = await readSnapshotBoards(
			baseline.dataDir,
			timetableVersion,
			latestSnap.id,
		);
		for (const staId of targetStations) {
			const board = snapshotBoards.get(staId);
			expectedBoards.set(staId, board ? board.data : []);
		}
	}

	// 4. Fetch Live Departure Boards via KciClient
	const client =
		options.client ??
		new KciClient({
			pacingMs: 100,
			retryBaseMs: 500,
		});

	const liveBoards = new Map<string, DepartureBoardItem[]>();
	await Promise.all(
		targetStations.map(async (staId) => {
			const res = await client.fetchStationSchedule(staId);
			liveBoards.set(staId, res.data);
		}),
	);

	// 5. Semantic Diff per Station
	const stationResults: StationDriftResult[] = [];
	let totalExpected = 0;
	let totalLive = 0;
	let totalIdentical = 0;
	let totalRelettered = 0;
	let totalRetimed = 0;
	let totalAdded = 0;
	let totalWithdrawn = 0;

	for (const staId of targetStations) {
		const expectedList = expectedBoards.get(staId) ?? [];
		const liveList = liveBoards.get(staId) ?? [];

		const stationDiff = diffDepartureBoards({
			boardsBefore: new Map([[staId, expectedList]]),
			boardsAfter: new Map([[staId, liveList]]),
			options: {
				arrivalToleranceSecs: options.toleranceSecs ?? 900,
			},
		});

		const staResult: StationDriftResult = {
			stationId: staId,
			stationName: STATION_NAMES[staId] ?? staId,
			expectedCount: expectedList.length,
			liveCount: liveList.length,
			identicalCount: stationDiff.identicalCount,
			reletteredCount: stationDiff.relettered.length,
			retimedCount: stationDiff.retimed.length,
			addedCount: stationDiff.added.length,
			withdrawnCount: stationDiff.withdrawn.length,
		};

		stationResults.push(staResult);

		totalExpected += staResult.expectedCount;
		totalLive += staResult.liveCount;
		totalIdentical += staResult.identicalCount;
		totalRelettered += staResult.reletteredCount;
		totalRetimed += staResult.retimedCount;
		totalAdded += staResult.addedCount;
		totalWithdrawn += staResult.withdrawnCount;
	}

	// 6. Drift Classification & Verdict
	const congruenceRatio =
		totalExpected > 0 ? totalIdentical / totalExpected : 1;

	let status: CorridorDriftStatus = "STABLE";
	let actionRecommendation: string | undefined;

	if (
		totalRelettered > DRIFT_THRESHOLDS.maxRelettered ||
		congruenceRatio < DRIFT_THRESHOLDS.minCongruenceRatio ||
		totalAdded > DRIFT_THRESHOLDS.maxAdded ||
		totalWithdrawn > DRIFT_THRESHOLDS.maxWithdrawn
	) {
		status = "POTENTIAL_EDITION_DRIFT";
		actionRecommendation = `KCI appears to have revised timetable editions. Run 'krl capture --new-version' to bootstrap timetable version ${timetableVersion + 1}.`;
	} else if (
		totalRetimed > 0 ||
		totalRelettered > 0 ||
		totalAdded > 0 ||
		totalWithdrawn > 0
	) {
		status = "OPERATIONAL_VARIANCE";
		actionRecommendation =
			"Minor operational variances observed. Congruence remains high; no edition bump required.";
	} else {
		status = "STABLE";
		actionRecommendation = `Timetable is stable (${(congruenceRatio * 100).toFixed(1)}% congruent) across ${targetStations.length} probed station(s).`;
	}

	const probeTimeWib = new Intl.DateTimeFormat("en-CA", {
		timeZone: TIMEZONE,
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
		hour: "2-digit",
		minute: "2-digit",
		second: "2-digit",
		hour12: false,
	}).format(now);

	const summary =
		status === "STABLE"
			? `Corridor Stable: ${totalIdentical}/${totalExpected} departures congruent (${(congruenceRatio * 100).toFixed(1)}%)`
			: status === "OPERATIONAL_VARIANCE"
				? `Operational Variance: ${totalRetimed} retimed, ${totalRelettered} relettered, ${totalAdded} added, ${totalWithdrawn} missing`
				: `POTENTIAL EDITION DRIFT: ${(congruenceRatio * 100).toFixed(1)}% congruence, ${totalRelettered} relettered, ${totalAdded} added`;

	return {
		probeTimeWib: `${probeTimeWib} WIB`,
		timetableVersion,
		baselineSource,
		dayType,
		dateStr,
		stations: stationResults,
		totalExpected,
		totalLive,
		totalIdentical,
		totalRelettered,
		totalRetimed,
		totalAdded,
		totalWithdrawn,
		status,
		summary,
		actionRecommendation,
	};
}
