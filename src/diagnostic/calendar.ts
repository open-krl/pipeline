// src/diagnostic/calendar.ts

import { Database } from "bun:sqlite";
import type {
	DepartureBoardItem,
	DepartureBoardResponse,
} from "../api/schemas";
import {
	readSnapshotBoards,
	scanSnapshots,
	scanTimetableVersions,
} from "../archive/snapshots";
import { resolveDiagnosticBaseline } from "./baseline";
import {
	extractTripSummaries,
	findBestFingerprintCandidate,
	type TripSummary,
} from "./fingerprint";
import type { CalendarAnalysisResult, CalendarServiceCluster } from "./types";

export interface MatchCalendarOptions {
	toleranceSecs?: number;
}

/**
 * Pure 3-way set difference and empirical identity analysis across day types (§9 Task 6.4).
 */
export function analyzeDayTypeCalendar(params: {
	timetableVersion: number;
	source: "snapshots" | "database";
	weekdayTrips?: Map<string, TripSummary> | null;
	saturdayTrips?: Map<string, TripSummary> | null;
	sundayTrips?: Map<string, TripSummary> | null;
	options?: MatchCalendarOptions;
}): CalendarAnalysisResult {
	const tolerance = params.options?.toleranceSecs ?? 900;
	const wTrips = params.weekdayTrips ?? new Map<string, TripSummary>();
	const saTrips = params.saturdayTrips ?? new Map<string, TripSummary>();
	const suTrips = params.sundayTrips ?? new Map<string, TripSummary>();

	const hasWeekday = Boolean(
		params.weekdayTrips && params.weekdayTrips.size > 0,
	);
	const hasSaturday = Boolean(
		params.saturdayTrips && params.saturdayTrips.size > 0,
	);
	const hasSunday = Boolean(params.sundayTrips && params.sundayTrips.size > 0);

	const matchedSaturday = new Set<string>();
	const matchedSunday = new Set<string>();
	function buildCluster(
		trip: TripSummary,
		runsWeekday: boolean,
		runsSaturday: boolean,
		runsSunday: boolean,
		trainIds: string[],
		relettered: boolean,
		retimed: boolean,
		maxDeltaSecs: number,
		category: CalendarServiceCluster["category"],
	): CalendarServiceCluster {
		return {
			serviceKey: `${trip.baseTrainNo}_${trip.originStation}_${trip.dest}_${trip.destTimeSecs}`,
			baseTrainNo: trip.baseTrainNo,
			originStation: trip.originStation,
			destStation: trip.dest,
			lineName: trip.kaName,
			routeName: trip.routeName,
			isFakultatif: trip.isFakultatif,
			runsWeekday,
			runsSaturday,
			runsSunday,
			trainIds,
			relettered,
			retimed,
			maxDeltaSecs,
			category,
		};
	}

	const clusters: CalendarServiceCluster[] = [];

	// Step 1: Cluster starting from Weekday services
	for (const w of wTrips.values()) {
		const saMatch = hasSaturday
			? findBestFingerprintCandidate(w, saTrips, matchedSaturday, tolerance)
			: null;
		if (saMatch) matchedSaturday.add(saMatch.match.trainId);

		const suMatch = hasSunday
			? findBestFingerprintCandidate(w, suTrips, matchedSunday, tolerance)
			: null;
		if (suMatch) matchedSunday.add(suMatch.match.trainId);

		const runsSa = Boolean(saMatch);
		const runsSu = Boolean(suMatch);
		const relettered =
			(saMatch?.relettered ?? false) ||
			(suMatch?.relettered ?? false) ||
			Boolean(
				saMatch && suMatch && saMatch.match.trainId !== suMatch.match.trainId,
			);
		const retimed = (saMatch?.retimed ?? false) || (suMatch?.retimed ?? false);
		const maxDeltaSecs = Math.max(
			saMatch?.deltaSecs ?? 0,
			suMatch?.deltaSecs ?? 0,
		);

		const trainIds = Array.from(
			new Set(
				[w.trainId, saMatch?.match.trainId, suMatch?.match.trainId].filter(
					(t): t is string => Boolean(t),
				),
			),
		);

		let category: CalendarServiceCluster["category"];
		if (runsSa && runsSu) {
			category = "daily";
		} else if (runsSa) {
			category = "mon_sat";
		} else if (runsSu) {
			category = "weekday_sunday";
		} else {
			category = "weekday_only";
		}

		clusters.push(
			buildCluster(
				w,
				true,
				runsSa,
				runsSu,
				trainIds,
				relettered,
				retimed,
				maxDeltaSecs,
				category,
			),
		);
	}

	// Step 2: Unmatched Saturday services
	for (const sa of saTrips.values()) {
		if (matchedSaturday.has(sa.trainId)) continue;
		matchedSaturday.add(sa.trainId);

		const suMatch = hasSunday
			? findBestFingerprintCandidate(sa, suTrips, matchedSunday, tolerance)
			: null;
		if (suMatch) matchedSunday.add(suMatch.match.trainId);

		const runsSu = Boolean(suMatch);
		const relettered = suMatch ? sa.trainId !== suMatch.match.trainId : false;
		const retimed = suMatch?.retimed ?? false;
		const maxDeltaSecs = suMatch?.deltaSecs ?? 0;

		const trainIds = Array.from(
			new Set(
				[sa.trainId, suMatch?.match.trainId].filter((t): t is string =>
					Boolean(t),
				),
			),
		);

		const category = runsSu ? "weekend_only" : "saturday_only";

		clusters.push(
			buildCluster(
				sa,
				false,
				true,
				runsSu,
				trainIds,
				relettered,
				retimed,
				maxDeltaSecs,
				category,
			),
		);
	}

	// Step 3: Unmatched Sunday services
	for (const su of suTrips.values()) {
		if (matchedSunday.has(su.trainId)) continue;
		matchedSunday.add(su.trainId);

		clusters.push(
			buildCluster(
				su,
				false,
				false,
				true,
				[su.trainId],
				false,
				false,
				0,
				"sunday_only",
			),
		);
	}

	// 7-way Venn breakdown
	const breakdown: CalendarAnalysisResult["breakdown"] = {
		daily: clusters.filter((c) => c.category === "daily"),
		weekdayOnly: clusters.filter((c) => c.category === "weekday_only"),
		monSat: clusters.filter((c) => c.category === "mon_sat"),
		weekendOnly: clusters.filter((c) => c.category === "weekend_only"),
		saturdayOnly: clusters.filter((c) => c.category === "saturday_only"),
		sundayOnly: clusters.filter((c) => c.category === "sunday_only"),
		weekdaySunday: clusters.filter((c) => c.category === "weekday_sunday"),
	};

	const totalServices = clusters.length;
	const coreSharedCount = breakdown.daily.length;
	const coreSharedRatio =
		totalServices > 0 ? coreSharedCount / totalServices : 0;
	const reletteredCount = clusters.filter((c) => c.relettered).length;
	const retimedCount = clusters.filter((c) => c.retimed).length;

	const fakultatifClusters = clusters.filter((c) => c.isFakultatif);
	const fWeekday = fakultatifClusters.filter((c) => c.runsWeekday).length;
	const fWeekend = fakultatifClusters.filter(
		(c) => c.runsSaturday || c.runsSunday,
	).length;
	const fSuspended = fakultatifClusters.filter(
		(c) => c.runsWeekday && !c.runsSaturday && !c.runsSunday,
	).length;

	const presentCount = [hasWeekday, hasSaturday, hasSunday].filter(
		Boolean,
	).length;
	let summary = "";
	if (presentCount === 3) {
		summary = `Resolved: 3/3 day types confirmed (${coreSharedCount} daily services, ${(coreSharedRatio * 100).toFixed(1)}% core retention)`;
	} else {
		const missing: string[] = [];
		if (!hasWeekday) missing.push("weekday");
		if (!hasSaturday) missing.push("saturday");
		if (!hasSunday) missing.push("sunday");
		summary = `Provisional: ${presentCount}/3 day types available (missing: ${missing.join(", ")})`;
	}

	return {
		timetableVersion: params.timetableVersion,
		source: params.source,
		availableDayTypes: {
			weekday: hasWeekday,
			saturday: hasSaturday,
			sunday: hasSunday,
		},
		totalServices,
		totalTripsByDayType: {
			weekday: wTrips.size,
			saturday: saTrips.size,
			sunday: suTrips.size,
		},
		breakdown,
		stats: {
			coreSharedCount,
			coreSharedRatio,
			reletteredCount,
			retimedCount,
			fakultatif: {
				total: fakultatifClusters.length,
				weekdayActive: fWeekday,
				weekendActive: fWeekend,
				suspendedOnWeekend: fSuspended,
			},
		},
		summary,
	};
}

/**
 * Loads day-type trip maps from SQLite database.
 */
export async function loadCalendarFromDatabase(
	dbPath: string,
	version?: number,
): Promise<{
	version: number;
	weekdayTrips: Map<string, TripSummary> | null;
	saturdayTrips: Map<string, TripSummary> | null;
	sundayTrips: Map<string, TripSummary> | null;
}> {
	const db = new Database(dbPath, { readonly: true });
	try {
		let v = version;
		if (v === undefined) {
			const vRow = db
				.query<{ timetable_version: number }, []>(
					"SELECT DISTINCT timetable_version FROM trips LIMIT 1",
				)
				.get();
			if (!vRow) throw new Error(`Database at ${dbPath} contains no trips.`);
			v = vRow.timetable_version;
		}

		interface DbTripRow {
			trip_id: string;
			base_train_no: number;
			revision: string | null;
			is_fakultatif: number | null;
			line_name: string;
			route_name_raw: string;
			dest_station_id: string;
			dest_time: string;
			dest_secs: number;
			origin_station_id: string | null;
			origin_secs: number;
			runs_weekday: number;
			runs_saturday: number;
			runs_sunday: number;
		}

		const rows = db
			.query<DbTripRow, [number]>(
				`SELECT t.trip_id, t.base_train_no, t.revision, t.is_fakultatif, t.line_name,
				        t.route_name_raw, t.dest_station_id, t.dest_time, t.dest_secs,
				        t.origin_station_id, t.origin_secs,
				        c.runs_weekday, c.runs_saturday, c.runs_sunday
				 FROM trips t
				 JOIN trip_calendar c ON t.timetable_version = c.timetable_version AND t.trip_id = c.trip_id
				 WHERE t.timetable_version = ?`,
			)
			.all(v);

		let hasWeekday = false;
		let hasSaturday = false;
		let hasSunday = false;

		const weekdayTrips = new Map<string, TripSummary>();
		const saturdayTrips = new Map<string, TripSummary>();
		const sundayTrips = new Map<string, TripSummary>();

		for (const row of rows) {
			const summary: TripSummary = {
				trainId: row.trip_id,
				baseTrainNo: row.base_train_no,
				revision: row.revision,
				isFakultatif: Boolean(row.is_fakultatif),
				kaName: row.line_name,
				routeName: row.route_name_raw,
				dest: row.dest_station_id,
				destTime: row.dest_time,
				destTimeSecs: row.dest_secs,
				originStation: row.origin_station_id ?? "UNKNOWN",
				originDepSecs: row.origin_secs,
				departures: new Map(),
			};

			if (row.runs_weekday === 1) {
				hasWeekday = true;
				weekdayTrips.set(row.trip_id, summary);
			}
			if (row.runs_saturday === 1) {
				hasSaturday = true;
				saturdayTrips.set(row.trip_id, summary);
			}
			if (row.runs_sunday === 1) {
				hasSunday = true;
				sundayTrips.set(row.trip_id, summary);
			}
		}

		return {
			version: v,
			weekdayTrips: hasWeekday ? weekdayTrips : null,
			saturdayTrips: hasSaturday ? saturdayTrips : null,
			sundayTrips: hasSunday ? sundayTrips : null,
		};
	} finally {
		db.close();
	}
}

/**
 * Loads day-type trip maps from raw snapshot board archives.
 */
export async function loadCalendarFromSnapshots(
	dataDir: string,
	version?: number,
): Promise<{
	version: number;
	weekdayTrips: Map<string, TripSummary> | null;
	saturdayTrips: Map<string, TripSummary> | null;
	sundayTrips: Map<string, TripSummary> | null;
}> {
	let v = version;
	if (v === undefined) {
		const versions = await scanTimetableVersions(dataDir);
		if (versions.length === 0) {
			throw new Error(
				`No timetable versions found in data directory: ${dataDir}`,
			);
		}
		v = versions[versions.length - 1];
	}

	const allSnapshots = await scanSnapshots(dataDir, v);
	const complete = allSnapshots.filter((s) => s.manifest.status === "complete");

	const latestWeekday = complete
		.filter((s) => s.manifest.day_type === "weekday")
		.pop();
	const latestSaturday = complete
		.filter((s) => s.manifest.day_type === "saturday")
		.pop();
	const latestSunday = complete
		.filter((s) => s.manifest.day_type === "sunday")
		.pop();

	let weekdayTrips: Map<string, TripSummary> | null = null;
	let saturdayTrips: Map<string, TripSummary> | null = null;
	let sundayTrips: Map<string, TripSummary> | null = null;

	function flattenBoards(
		boardsMap: Map<string, DepartureBoardResponse>,
	): Map<string, DepartureBoardItem[]> {
		const flat = new Map<string, DepartureBoardItem[]>();
		for (const [staId, res] of boardsMap.entries()) {
			flat.set(staId, res.data);
		}
		return flat;
	}

	if (latestWeekday) {
		const boards = await readSnapshotBoards(dataDir, v, latestWeekday.id);
		weekdayTrips = extractTripSummaries(flattenBoards(boards));
	}
	if (latestSaturday) {
		const boards = await readSnapshotBoards(dataDir, v, latestSaturday.id);
		saturdayTrips = extractTripSummaries(flattenBoards(boards));
	}
	if (latestSunday) {
		const boards = await readSnapshotBoards(dataDir, v, latestSunday.id);
		sundayTrips = extractTripSummaries(flattenBoards(boards));
	}

	return {
		version: v,
		weekdayTrips,
		saturdayTrips,
		sundayTrips,
	};
}

/**
 * High-level data loader: resolves raw snapshots or SQLite database.
 */
export async function loadCalendarData(params: {
	version?: number;
	dataDir?: string;
	dbPath?: string;
	cwd?: string;
}): Promise<{
	version: number;
	source: "snapshots" | "database";
	weekdayTrips: Map<string, TripSummary> | null;
	saturdayTrips: Map<string, TripSummary> | null;
	sundayTrips: Map<string, TripSummary> | null;
}> {
	const baseline = await resolveDiagnosticBaseline({
		version: params.version,
		dataDir: params.dataDir,
		dbPath: params.dbPath,
		cwd: params.cwd,
		preferSource: "snapshots",
	});

	if (baseline.source === "database") {
		const dbData = await loadCalendarFromDatabase(
			baseline.dbPath,
			baseline.version,
		);
		return {
			version: dbData.version,
			source: "database",
			weekdayTrips: dbData.weekdayTrips,
			saturdayTrips: dbData.saturdayTrips,
			sundayTrips: dbData.sundayTrips,
		};
	}

	const snapData = await loadCalendarFromSnapshots(
		baseline.dataDir,
		baseline.version,
	);
	return {
		version: snapData.version,
		source: "snapshots",
		weekdayTrips: snapData.weekdayTrips,
		saturdayTrips: snapData.saturdayTrips,
		sundayTrips: snapData.sundayTrips,
	};
}
