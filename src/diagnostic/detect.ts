// src/diagnostic/detect.ts
import { Database } from "bun:sqlite";
import { promises as fs } from "node:fs";
import path from "node:path";
import { KciClient } from "../api/client";
import type { DepartureBoardItem } from "../api/schemas";
import {
	readSnapshotBoards,
	scanSnapshots,
	scanTimetableVersions,
} from "../archive/snapshots";
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
	cwd?: string;
}

const STATION_NAMES: Record<string, string> = {
	MRI: "Manggarai (Central Trunk)",
	BKS: "Bekasi (Eastern Corridor)",
	RK: "Rangkasbitung (Western Branch)",
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
		dest_station_id: string;
		dest_time: string;
		color: string;
		time_raw: string;
	}

	const rows = db
		.query<StopRow, [number, string]>(
			`SELECT t.trip_id, t.line_name, t.route_name_raw, t.dest_station_id, t.dest_time, t.color, s.time_raw
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
		dest: r.dest_station_id,
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
	let timetableVersion = options.version;
	let baselineSource: "database" | "snapshots" = "database";
	const expectedBoards = new Map<string, DepartureBoardItem[]>();

	// Try DB if explicitly provided, or if neither dbPath nor dataDir is specified
	let dbPath: string | null = null;
	if (options.dbPath) {
		dbPath = resolveSafePath(options.dbPath, cwd);
	} else if (!options.dataDir) {
		const v = timetableVersion ?? 1;
		const candidateDb = path.join(cwd, "data/build", `krl_v${v}.db`);
		if (
			await fs
				.stat(candidateDb)
				.then(() => true)
				.catch(() => false)
		) {
			dbPath = candidateDb;
		}
	}

	if (
		dbPath &&
		(await fs
			.stat(dbPath)
			.then(() => true)
			.catch(() => false))
	) {
		const db = new Database(dbPath, { readonly: true });
		try {
			if (timetableVersion === undefined) {
				const vRow = db
					.query<{ timetable_version: number }, []>(
						"SELECT DISTINCT timetable_version FROM trips LIMIT 1",
					)
					.get();
				timetableVersion = vRow?.timetable_version ?? 1;
			}
			for (const staId of targetStations) {
				const deps = loadStationDeparturesFromDb(
					db,
					timetableVersion,
					staId,
					presenceCol,
				);
				expectedBoards.set(staId, deps);
			}
			baselineSource = "database";
		} finally {
			db.close();
		}
	} else {
		// Fallback to raw snapshot boards
		baselineSource = "snapshots";
		const rawDir = resolveSafePath(options.dataDir ?? "data/raw", cwd);
		if (timetableVersion === undefined) {
			const versions = await scanTimetableVersions(rawDir);
			if (versions.length === 0) {
				throw new Error("No timetable versions found in raw data directory.");
			}
			timetableVersion = versions[versions.length - 1];
		}

		const allSnaps = await scanSnapshots(rawDir, timetableVersion);
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
			rawDir,
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
		totalRelettered > 5 ||
		congruenceRatio < 0.85 ||
		totalAdded > 5 ||
		totalWithdrawn > 10
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
		actionRecommendation =
			"Timetable is 100% congruent across all 3 key corridor hubs.";
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

/**
 * Pretty-prints a clean terminal report for corridor drift detection.
 */
export function formatDetectReport(result: DetectResult): string {
	const lines: string[] = [];
	lines.push("── Operational Corridor Drift Probe (§9, §12) ──────────────");
	lines.push(`Probe Timestamp:      ${result.probeTimeWib}`);
	lines.push(
		`Timetable Version:    ${result.timetableVersion} (baseline source: ${result.baselineSource})`,
	);
	lines.push(`Target Day Type:      ${result.dayType} (${result.dateStr})`);
	lines.push(
		`Corridor Signature:   ${result.stations.length} hub stations (${result.stations.map((s) => s.stationId).join(", ")})`,
	);
	lines.push("");

	lines.push("── Station Departure Results ────────────────────────────────");
	for (const s of result.stations) {
		const idTag = `[${s.stationId}]`.padEnd(5, " ");
		const name = s.stationName.slice(0, 20).padEnd(20, " ");
		const counts = `${String(s.expectedCount).padStart(3, " ")} exp, ${String(s.liveCount).padStart(3, " ")} live`;
		const diffs = `(${String(s.identicalCount).padStart(3, " ")} id, ${s.reletteredCount} re-let, ${s.retimedCount} retimed, ${s.addedCount} add, ${s.withdrawnCount} del)`;
		lines.push(`  ${idTag} ${name} : ${counts} ${diffs}`);
	}
	lines.push("");

	lines.push("── Overall Corridor Status ──────────────────────────────────");
	const statusEmoji =
		result.status === "STABLE"
			? "STABLE (Congruent) ✅"
			: result.status === "OPERATIONAL_VARIANCE"
				? "OPERATIONAL VARIANCE (Minor Drift) ℹ️"
				: "POTENTIAL TIMETABLE EDITION DRIFT ⚠️";
	lines.push(`Status:               ${statusEmoji}`);
	lines.push(
		`Congruent Departures: ${result.totalIdentical} / ${result.totalExpected} (${result.totalExpected > 0 ? ((result.totalIdentical / result.totalExpected) * 100).toFixed(1) : 0}%)`,
	);
	lines.push(`Re-lettered Services: ${result.totalRelettered}`);
	lines.push(`Retimed Services:     ${result.totalRetimed}`);
	lines.push(`Unexpected Added:     ${result.totalAdded}`);
	lines.push(`Missing / Cancelled:  ${result.totalWithdrawn}`);

	if (result.actionRecommendation) {
		lines.push("");
		lines.push(`Action Recommended:   ${result.actionRecommendation}`);
	}
	lines.push("─────────────────────────────────────────────────────────────");

	return lines.join("\n");
}
