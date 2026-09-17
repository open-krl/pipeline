// src/diagnostic/calendar.ts

import { Database } from "bun:sqlite";
import { promises as fs } from "node:fs";
import path from "node:path";
import type {
	DepartureBoardItem,
	DepartureBoardResponse,
} from "../api/schemas";
import {
	readSnapshotBoards,
	scanSnapshots,
	scanTimetableVersions,
} from "../archive/snapshots";
import { resolveSafePath } from "../core/path";
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

	const matchedWeekday = new Set<string>();
	const matchedSaturday = new Set<string>();
	const matchedSunday = new Set<string>();
	const clusters: CalendarServiceCluster[] = [];

	// Step 1: Cluster starting from Weekday services
	for (const w of wTrips.values()) {
		matchedWeekday.add(w.trainId);

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

		clusters.push({
			serviceKey: `${w.baseTrainNo}_${w.originStation}_${w.dest}_${w.destTimeSecs}`,
			baseTrainNo: w.baseTrainNo,
			originStation: w.originStation,
			destStation: w.dest,
			lineName: w.kaName,
			routeName: w.routeName,
			isFakultatif: w.isFakultatif,
			runsWeekday: true,
			runsSaturday: runsSa,
			runsSunday: runsSu,
			trainIds,
			relettered,
			retimed,
			maxDeltaSecs,
			category,
		});
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

		clusters.push({
			serviceKey: `${sa.baseTrainNo}_${sa.originStation}_${sa.dest}_${sa.destTimeSecs}`,
			baseTrainNo: sa.baseTrainNo,
			originStation: sa.originStation,
			destStation: sa.dest,
			lineName: sa.kaName,
			routeName: sa.routeName,
			isFakultatif: sa.isFakultatif,
			runsWeekday: false,
			runsSaturday: true,
			runsSunday: runsSu,
			trainIds,
			relettered,
			retimed,
			maxDeltaSecs,
			category,
		});
	}

	// Step 3: Unmatched Sunday services
	for (const su of suTrips.values()) {
		if (matchedSunday.has(su.trainId)) continue;
		matchedSunday.add(su.trainId);

		clusters.push({
			serviceKey: `${su.baseTrainNo}_${su.originStation}_${su.dest}_${su.destTimeSecs}`,
			baseTrainNo: su.baseTrainNo,
			originStation: su.originStation,
			destStation: su.dest,
			lineName: su.kaName,
			routeName: su.routeName,
			isFakultatif: su.isFakultatif,
			runsWeekday: false,
			runsSaturday: false,
			runsSunday: true,
			trainIds: [su.trainId],
			relettered: false,
			retimed: false,
			maxDeltaSecs: 0,
			category: "sunday_only",
		});
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
	const cwd = params.cwd ?? process.cwd();

	// 1. Explicit DB path provided
	if (params.dbPath) {
		const resolvedDb = resolveSafePath(params.dbPath, cwd);
		const dbData = await loadCalendarFromDatabase(resolvedDb, params.version);
		return {
			version: dbData.version,
			source: "database",
			weekdayTrips: dbData.weekdayTrips,
			saturdayTrips: dbData.saturdayTrips,
			sundayTrips: dbData.sundayTrips,
		};
	}

	// 2. Try raw snapshot archive
	const rawDir = resolveSafePath(params.dataDir ?? "data/raw", cwd);
	try {
		const snapData = await loadCalendarFromSnapshots(rawDir, params.version);
		if (
			snapData.weekdayTrips ||
			snapData.saturdayTrips ||
			snapData.sundayTrips
		) {
			return {
				version: snapData.version,
				source: "snapshots",
				weekdayTrips: snapData.weekdayTrips,
				saturdayTrips: snapData.saturdayTrips,
				sundayTrips: snapData.sundayTrips,
			};
		}
	} catch {
		// Fallback to SQLite if raw directory unavailable
	}

	// 3. Fallback to default build database
	const v = params.version ?? 1;
	const defaultDb = path.join(cwd, "data/build", `krl_v${v}.db`);
	const dbExists = await fs
		.stat(defaultDb)
		.then(() => true)
		.catch(() => false);
	if (dbExists) {
		const dbData = await loadCalendarFromDatabase(defaultDb, v);
		return {
			version: dbData.version,
			source: "database",
			weekdayTrips: dbData.weekdayTrips,
			saturdayTrips: dbData.saturdayTrips,
			sundayTrips: dbData.sundayTrips,
		};
	}

	throw new Error(
		`No timetable data found for version ${params.version ?? "latest"} in raw snapshots (${rawDir}) or database (${defaultDb}).`,
	);
}

/**
 * Formats a terminal-friendly calendar identity and set-difference report.
 */
export function formatCalendarReport(
	result: CalendarAnalysisResult,
	detail = false,
): string {
	const { availableDayTypes, totalTripsByDayType, breakdown, stats } = result;

	const dayTypesStr: string[] = [];
	if (availableDayTypes.weekday) dayTypesStr.push("Weekday");
	if (availableDayTypes.saturday) dayTypesStr.push("Saturday");
	if (availableDayTypes.sunday) dayTypesStr.push("Sunday");

	const resolutionStatus =
		dayTypesStr.length === 3
			? "Resolved (3/3 day types confirmed)"
			: `Provisional (${dayTypesStr.length}/3 day types: ${dayTypesStr.join(", ") || "none"})`;

	const formatPct = (count: number) =>
		result.totalServices > 0
			? `${((count / result.totalServices) * 100).toFixed(1)}%`
			: "0.0%";

	const lines: string[] = [];
	lines.push("── Calendar Schedule Identity Report ────────────────────────");
	lines.push(
		`Timetable Version:    ${result.timetableVersion} (source: ${result.source})`,
	);
	lines.push(`Calendar Resolution:  ${resolutionStatus}`);
	lines.push(
		`Total Unique Services:${result.totalServices.toLocaleString()} distinct operational runs`,
	);
	lines.push(
		`Weekday Departures:   ${availableDayTypes.weekday ? `${totalTripsByDayType.weekday.toLocaleString()} trips` : "N/A"}`,
	);
	lines.push(
		`Saturday Departures:  ${availableDayTypes.saturday ? `${totalTripsByDayType.saturday.toLocaleString()} trips` : "N/A"}`,
	);
	lines.push(
		`Sunday Departures:    ${availableDayTypes.sunday ? `${totalTripsByDayType.sunday.toLocaleString()} trips` : "N/A"}`,
	);
	lines.push("");

	lines.push("── 3-Way Set Difference Breakdown ───────────────────────────");
	lines.push(
		`  Daily (All 7 Days):     ${String(breakdown.daily.length).padStart(5, " ")} services (${formatPct(breakdown.daily.length).padStart(5, " ")})`,
	);
	lines.push(
		`  Weekday Only:           ${String(breakdown.weekdayOnly.length).padStart(5, " ")} services (${formatPct(breakdown.weekdayOnly.length).padStart(5, " ")})`,
	);
	lines.push(
		`  Weekend Only (Sat+Sun): ${String(breakdown.weekendOnly.length).padStart(5, " ")} services (${formatPct(breakdown.weekendOnly.length).padStart(5, " ")})`,
	);
	lines.push(
		`  Mon - Sat:              ${String(breakdown.monSat.length).padStart(5, " ")} services (${formatPct(breakdown.monSat.length).padStart(5, " ")})`,
	);
	lines.push(
		`  Saturday Only:          ${String(breakdown.saturdayOnly.length).padStart(5, " ")} services (${formatPct(breakdown.saturdayOnly.length).padStart(5, " ")})`,
	);
	lines.push(
		`  Sunday Only:            ${String(breakdown.sundayOnly.length).padStart(5, " ")} services (${formatPct(breakdown.sundayOnly.length).padStart(5, " ")})`,
	);
	lines.push(
		`  Weekday + Sunday:       ${String(breakdown.weekdaySunday.length).padStart(5, " ")} services (${formatPct(breakdown.weekdaySunday.length).padStart(5, " ")})`,
	);
	lines.push("");

	lines.push("── Operational Variance Diagnostics ─────────────────────────");
	lines.push(
		`  Re-lettered on Weekend: ${stats.reletteredCount} services (e.g. 5022D -> 5022E)`,
	);
	lines.push(
		`  Retimed on Weekend:     ${stats.retimedCount} services (arrival delta within tolerance)`,
	);
	lines.push(
		`  Fakultatif Services:    ${stats.fakultatif.total} total (${stats.fakultatif.weekdayActive} weekday active, ${stats.fakultatif.weekendActive} weekend active, ${stats.fakultatif.suspendedOnWeekend} suspended on weekend)`,
	);
	lines.push("─────────────────────────────────────────────────────────────");

	if (detail) {
		// Group by commercial line name
		const linesMap = new Map<
			string,
			{
				daily: number;
				weekdayOnly: number;
				weekendOnly: number;
				other: number;
				total: number;
			}
		>();

		const allClusters = [
			...breakdown.daily,
			...breakdown.weekdayOnly,
			...breakdown.weekendOnly,
			...breakdown.monSat,
			...breakdown.saturdayOnly,
			...breakdown.sundayOnly,
			...breakdown.weekdaySunday,
		];

		for (const c of allClusters) {
			const key = c.lineName || "Unassigned";
			let entry = linesMap.get(key);
			if (!entry) {
				entry = {
					daily: 0,
					weekdayOnly: 0,
					weekendOnly: 0,
					other: 0,
					total: 0,
				};
				linesMap.set(key, entry);
			}
			entry.total++;
			if (c.category === "daily") entry.daily++;
			else if (c.category === "weekday_only") entry.weekdayOnly++;
			else if (c.category === "weekend_only") entry.weekendOnly++;
			else entry.other++;
		}

		lines.push(
			"\n── Line-by-Line Service Distribution ───────────────────────",
		);
		lines.push(
			`${"Line Name".padEnd(30, " ")} ${"Daily".padStart(6, " ")} ${"Wkday".padStart(6, " ")} ${"Wkend".padStart(6, " ")} ${"Other".padStart(6, " ")} ${"Total".padStart(6, " ")}`,
		);
		lines.push("─".repeat(61));
		for (const [name, counts] of Array.from(linesMap.entries()).sort(
			(a, b) => b[1].total - a[1].total,
		)) {
			lines.push(
				`${name.slice(0, 30).padEnd(30, " ")} ${String(counts.daily).padStart(6, " ")} ${String(counts.weekdayOnly).padStart(6, " ")} ${String(counts.weekendOnly).padStart(6, " ")} ${String(counts.other).padStart(6, " ")} ${String(counts.total).padStart(6, " ")}`,
			);
		}

		// List re-lettered samples
		const reletteredClusters = allClusters.filter((c) => c.relettered);
		if (reletteredClusters.length > 0) {
			lines.push(
				"\n── Re-lettered Weekend Services (Sample) ───────────────────",
			);
			for (const c of reletteredClusters.slice(0, 8)) {
				lines.push(
					`  • ${c.trainIds.join(" -> ")}: ${c.originStation} -> ${c.destStation} (${c.lineName})`,
				);
			}
			if (reletteredClusters.length > 8) {
				lines.push(`  ... and ${reletteredClusters.length - 8} more`);
			}
		}

		// List retimed samples
		const retimedClusters = allClusters.filter((c) => c.retimed);
		if (retimedClusters.length > 0) {
			lines.push(
				"\n── Retimed Services Across Day Types (Sample) ───────────────",
			);
			for (const c of retimedClusters.slice(0, 8)) {
				lines.push(
					`  • ${c.trainIds.join(", ")} (${c.destStation}): max delta ±${c.maxDeltaSecs}s`,
				);
			}
			if (retimedClusters.length > 8) {
				lines.push(`  ... and ${retimedClusters.length - 8} more`);
			}
		}
	}

	return lines.join("\n");
}
