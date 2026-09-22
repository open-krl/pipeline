// src/export/export.ts
import { Database } from "bun:sqlite";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { scanTimetableVersions } from "../archive/snapshots";
import { resolveSafePath } from "../core/path";
import dayjs from "../lib/dayjs";
import { evaluateReleaseGates } from "./gates";
import {
	DEFAULT_AGENCY_META,
	formatAgencyCsv,
	generateAgencyRows,
} from "./tables/agency";
import {
	computeServiceId,
	formatCalendarCsv,
	generateCalendarRows,
	type ServiceSignature,
} from "./tables/calendar";
import {
	formatCalendarDatesCsv,
	generateCalendarDateRows,
	type HolidayEntity,
} from "./tables/calendar-dates";
import { formatRoutesCsv, generateRouteRows } from "./tables/routes";
import {
	formatStopTimesCsv,
	generateStopTimeRows,
	type TripStopEntity,
} from "./tables/stop-times";
import {
	formatStopsCsv,
	generateStopRows,
	type StationEntity,
} from "./tables/stops";
import {
	formatTripsCsv,
	generateTripRows,
	type TripEntityWithCalendar,
} from "./tables/trips";
import type { ExportOptions, ExportResult, ExportStats } from "./types";
import { createGtfsZip, writeGtfsZip } from "./zip";

export function normalizeDateToGtfs(dateStr: string): string {
	const cleaned = dateStr.replaceAll("-", "").trim();
	if (!/^\d{8}$/.test(cleaned)) {
		throw new Error(
			`Invalid date format '${dateStr}', expected YYYY-MM-DD or YYYYMMDD`,
		);
	}

	const y = Number.parseInt(cleaned.slice(0, 4), 10);
	const m = Number.parseInt(cleaned.slice(4, 6), 10);
	const d = Number.parseInt(cleaned.slice(6, 8), 10);

	const parsed = new Date(Date.UTC(y, m - 1, d));
	if (
		parsed.getUTCFullYear() !== y ||
		parsed.getUTCMonth() !== m - 1 ||
		parsed.getUTCDate() !== d
	) {
		throw new Error(
			`Invalid calendar date '${dateStr}' (impossible date components)`,
		);
	}

	return cleaned;
}

/**
 * Stage 4 GTFS Export Pipeline Runner (§9, Milestone 5).
 */
export async function executeExport(
	options: ExportOptions = {},
): Promise<ExportResult> {
	const startTime = Date.now();
	const cwd = options.cwd ?? process.cwd();

	// 1. Resolve Database Path
	let dbPath: string;
	let version = options.version;

	if (options.dbPath) {
		dbPath = resolveSafePath(options.dbPath, cwd);
	} else {
		if (version === undefined) {
			const dataDir = resolveSafePath("data/raw", cwd);
			const versions = await scanTimetableVersions(dataDir);
			if (versions.length === 0) {
				throw new Error("No timetable versions found in raw archive");
			}
			version = versions[versions.length - 1];
		}
		dbPath = path.join(cwd, "data/build", `krl_v${version}.db`);
	}

	const db = new Database(dbPath, { readonly: true });

	try {
		// 2. Query Version and Snapshots
		const versionRow = db
			.query<{ timetable_version: number }, [number] | []>(
				version !== undefined
					? "SELECT DISTINCT timetable_version FROM trips WHERE timetable_version = ? LIMIT 1"
					: "SELECT DISTINCT timetable_version FROM trips LIMIT 1",
			)
			.get(...(version !== undefined ? [version] : []));
		if (!versionRow) {
			throw new Error(
				`Database at ${dbPath} contains no compiled trips for version ${version ?? "any"}`,
			);
		}
		const resolvedVersion = versionRow.timetable_version;

		const snapshots = db
			.query<{ snapshot_date: string }, [number]>(
				"SELECT snapshot_date FROM snapshots WHERE timetable_version = ? ORDER BY snapshot_date ASC",
			)
			.all(resolvedVersion);

		// 3. Resolve Feed Validity Window (start_date, end_date)
		let startDate: string;
		if (options.startDate) {
			startDate = normalizeDateToGtfs(options.startDate);
		} else if (snapshots.length > 0) {
			startDate = normalizeDateToGtfs(snapshots[0].snapshot_date);
		} else {
			startDate = normalizeDateToGtfs(dayjs(new Date()).format("YYYY-MM-DD"));
		}

		let endDate: string;
		if (options.endDate) {
			endDate = normalizeDateToGtfs(options.endDate);
		} else {
			// Default to the end of the start date's year
			const year = startDate.slice(0, 4);
			endDate = `${year}1231`;
		}

		if (startDate > endDate) {
			throw new Error(
				`Invalid feed window: start_date (${startDate}) cannot be after end_date (${endDate})`,
			);
		}

		// 4. Query Relational Entities
		const allStations = db
			.query<StationEntity, []>(
				"SELECT sta_id, sta_name, lat, lon FROM stations ORDER BY sta_id ASC",
			)
			.all();

		const rawTrips = db
			.query<
				{
					trip_id: string;
					line_name: string;
					headsign: string;
					color: string;
					is_fakultatif: number | null;
					itinerary_status: string;
					runs_weekday: number;
					runs_saturday: number;
					runs_sunday: number;
					calendar_state: string;
				},
				[number]
			>(
				`SELECT t.trip_id, t.line_name, t.headsign, t.color, t.is_fakultatif, t.itinerary_status,
				        c.runs_weekday, c.runs_saturday, c.runs_sunday, c.calendar_state
				 FROM trips t
				 JOIN trip_calendar c ON t.timetable_version = c.timetable_version AND t.trip_id = c.trip_id
				 WHERE t.timetable_version = ?
				 ORDER BY t.trip_id ASC`,
			)
			.all(resolvedVersion);

		const rawStops = db
			.query<TripStopEntity, [number]>(
				`SELECT trip_id, stop_sequence, station_id, arrival_secs, departure_secs
				 FROM trip_stops
				 WHERE timetable_version = ?
				 ORDER BY trip_id ASC, stop_sequence ASC`,
			)
			.all(resolvedVersion);

		const rawHolidays = db
			.query<HolidayEntity, []>(
				"SELECT holiday_date, name, is_collective_leave FROM holidays ORDER BY holiday_date ASC",
			)
			.all();

		// 5. Release Gate Checks (§9, Task 5.3)
		const gateResult = evaluateReleaseGates({
			calendarStates: rawTrips.map((t) => ({
				trip_id: t.trip_id,
				calendar_state: t.calendar_state,
			})),
			itineraryStatuses: rawTrips.map((t) => ({
				trip_id: t.trip_id,
				itinerary_status: t.itinerary_status,
			})),
			holidayDates: rawHolidays.map((h) => h.holiday_date),
			endDate,
			requireResolvedCalendar: options.requireResolvedCalendar,
			requireCensusComplete: options.requireCensusComplete,
			requireHolidayCoverage: options.requireHolidayCoverage,
		});

		// 6. Map Tables
		const activeStationIds = new Set<string>(rawStops.map((s) => s.station_id));

		// A. agency.txt
		const agencyRows = generateAgencyRows(DEFAULT_AGENCY_META);
		const agencyCsv = formatAgencyCsv(agencyRows);

		// B. stops.txt
		const stopRows = generateStopRows(allStations, activeStationIds);
		const stopsCsv = formatStopsCsv(stopRows);

		// C. routes.txt
		const routeRows = generateRouteRows(
			rawTrips,
			DEFAULT_AGENCY_META.agency_id,
		);
		const routesCsv = formatRoutesCsv(routeRows);

		// D. calendar.txt
		const signaturesMap = new Map<string, ServiceSignature>();
		for (const trip of rawTrips) {
			const isFakultatif = trip.is_fakultatif ? 1 : 0;
			const serviceId = computeServiceId(
				trip.runs_weekday,
				trip.runs_saturday,
				trip.runs_sunday,
				isFakultatif,
			);
			if (!signaturesMap.has(serviceId)) {
				signaturesMap.set(serviceId, {
					service_id: serviceId,
					runs_weekday: trip.runs_weekday,
					runs_saturday: trip.runs_saturday,
					runs_sunday: trip.runs_sunday,
					is_fakultatif: isFakultatif,
				});
			}
		}
		const signatures = Array.from(signaturesMap.values());
		const calendarRows = generateCalendarRows(signatures, startDate, endDate);
		const calendarCsv = formatCalendarCsv(calendarRows);

		// E. calendar_dates.txt
		const fakultatifServiceIds = signatures
			.filter((s) => s.is_fakultatif === 1)
			.map((s) => s.service_id);
		const calendarDateRows = generateCalendarDateRows(
			fakultatifServiceIds,
			rawHolidays,
			startDate,
			endDate,
		);
		const calendarDatesCsv = formatCalendarDatesCsv(calendarDateRows);

		// F. trips.txt
		const tripsWithCalendar: TripEntityWithCalendar[] = rawTrips.map((t) => ({
			trip_id: t.trip_id,
			line_name: t.line_name,
			headsign: t.headsign,
			runs_weekday: t.runs_weekday,
			runs_saturday: t.runs_saturday,
			runs_sunday: t.runs_sunday,
			is_fakultatif: t.is_fakultatif,
		}));
		const tripRows = generateTripRows(tripsWithCalendar);
		const tripsCsv = formatTripsCsv(tripRows);

		// G. stop_times.txt
		const stopTimeRows = generateStopTimeRows(rawStops);
		const stopTimesCsv = formatStopTimesCsv(stopTimeRows);

		// 7. Dump CSVs if requested
		if (options.dumpCsvDir) {
			const csvDir = resolveSafePath(options.dumpCsvDir, cwd);
			await fs.mkdir(csvDir, { recursive: true });
			await fs.writeFile(path.join(csvDir, "agency.txt"), agencyCsv);
			await fs.writeFile(path.join(csvDir, "stops.txt"), stopsCsv);
			await fs.writeFile(path.join(csvDir, "routes.txt"), routesCsv);
			await fs.writeFile(path.join(csvDir, "trips.txt"), tripsCsv);
			await fs.writeFile(path.join(csvDir, "stop_times.txt"), stopTimesCsv);
			await fs.writeFile(path.join(csvDir, "calendar.txt"), calendarCsv);
			await fs.writeFile(
				path.join(csvDir, "calendar_dates.txt"),
				calendarDatesCsv,
			);
		}

		// 8. Package ZIP
		const files: Record<string, string> = {
			"agency.txt": agencyCsv,
			"stops.txt": stopsCsv,
			"routes.txt": routesCsv,
			"trips.txt": tripsCsv,
			"stop_times.txt": stopTimesCsv,
			"calendar.txt": calendarCsv,
			"calendar_dates.txt": calendarDatesCsv,
		};

		const outDir = options.outDir
			? resolveSafePath(options.outDir, cwd)
			: path.join(cwd, "data/build");
		const zipPath = path.join(outDir, `krl_gtfs_v${resolvedVersion}.zip`);

		const zipResult = createGtfsZip(files);
		await writeGtfsZip(zipPath, zipResult.zipBuffer, zipResult.sha256);

		const durationSecs = Number(((Date.now() - startTime) / 1000).toFixed(2));

		const stats: ExportStats = {
			agencyCount: agencyRows.length,
			stopsCount: stopRows.length,
			routesCount: routeRows.length,
			tripsCount: tripRows.length,
			stopTimesCount: stopTimeRows.length,
			calendarCount: calendarRows.length,
			calendarDatesCount: calendarDateRows.length,
		};

		return {
			zipPath,
			zipSizeBytes: zipResult.sizeBytes,
			sha256: zipResult.sha256,
			timetableVersion: resolvedVersion,
			startDate,
			endDate,
			durationSecs,
			stats,
			warnings: gateResult.warnings,
		};
	} finally {
		db.close();
	}
}
