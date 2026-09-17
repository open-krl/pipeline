// src/build/fold.ts
import type { ItineraryStop } from "../api/schemas";
import type { DayType } from "../archive/schemas";
import { resolveStationCode } from "../config";
import { resolveStationId } from "../core/route";
import { resolveItinerarySecs, toServiceDaySecs } from "../core/time";
import { parseTrainId } from "../core/trainid";
import type * as schema from "../db/tables";
import {
	type BoardOccurrence,
	checkCrossCaptureTripConsistency,
	checkIntraTripConsistency,
	checkMinBoardOccurrence,
	checkStopMonotonicity,
	checkTerminusAlignment,
} from "./invariants";
import { reconstructFromBoards } from "./reconstruct";
import type { FoldResult, FoldStats, RawArchive } from "./types";

interface SnapshotBoardRecord extends BoardOccurrence {
	snapshot_id: number;
	day_type: DayType;
	ka_name: string;
}

export function foldArchive(archive: RawArchive): FoldResult {
	const version = archive.timetableVersion;
	const quarantinedTrips: Array<typeof schema.quarantinedTrips.$inferInsert> =
		[];

	// ─── 1. Fold Stations ────────────────────────────────────────────────────────
	const stationMap = new Map<
		string,
		{
			sta_id: string;
			sta_name: string;
			group_wil: number;
			fg_enable: number;
			lat: number | null;
			lon: number | null;
			first_seen: string;
			last_seen: string;
		}
	>();

	for (const snap of archive.snapshots) {
		const snapDate = snap.manifest.snapshot_date;
		for (const rawStation of snap.stations.data) {
			if (rawStation.sta_id.startsWith("WIL")) {
				continue;
			}
			const staId = resolveStationCode(rawStation.sta_id);
			const coords = archive.stationCoordinates.get(staId);

			const existing = stationMap.get(staId);
			if (existing) {
				if (snapDate < existing.first_seen) existing.first_seen = snapDate;
				if (snapDate > existing.last_seen) existing.last_seen = snapDate;
			} else {
				stationMap.set(staId, {
					sta_id: staId,
					sta_name: rawStation.sta_name,
					group_wil: rawStation.group_wil,
					fg_enable: rawStation.fg_enable,
					lat: coords?.lat ?? null,
					lon: coords?.lon ?? null,
					first_seen: snapDate,
					last_seen: snapDate,
				});
			}
		}
	}

	const sortedStations = Array.from(stationMap.values()).sort((a, b) =>
		a.sta_id.localeCompare(b.sta_id),
	);
	const validStationIds = new Set(sortedStations.map((s) => s.sta_id));
	const stationsCatalog = sortedStations.map((s) => ({
		sta_id: s.sta_id,
		sta_name: s.sta_name,
	}));

	// ─── 2. Fold Snapshots ───────────────────────────────────────────────────────
	const sortedSnapshots: Array<typeof schema.snapshots.$inferInsert> = [
		...archive.snapshots,
	]
		.sort((a, b) => a.id - b.id)
		.map((s) => ({
			snapshot_id: s.id,
			snapshot_date: s.manifest.snapshot_date,
			day_type: s.manifest.day_type,
			region_scope: s.manifest.region_scope,
			fetched_at: s.manifest.fetched_at,
			status: s.manifest.status,
			timetable_version: version,
			archive_commit: s.archiveCommit,
		}));

	// ─── 3. Fold Holidays ────────────────────────────────────────────────────────
	const sortedHolidays: Array<typeof schema.holidays.$inferInsert> = [
		...archive.holidays,
	]
		.sort((a, b) => a.holiday_date.localeCompare(b.holiday_date))
		.map((h) => ({
			holiday_date: h.holiday_date,
			name: h.name,
			is_collective_leave: h.is_collective_leave ? 1 : 0,
		}));

	// ─── 4. Aggregate Departures Across Snapshots ─────────────────────────────────
	const trainOccurrences = new Map<string, SnapshotBoardRecord[]>();

	for (const snap of archive.snapshots) {
		for (const [rawStaId, boardResp] of snap.boards) {
			const staId = resolveStationCode(rawStaId);
			for (const item of boardResp.data) {
				const trainId = item.train_id.trim();
				const record: SnapshotBoardRecord = {
					snapshot_id: snap.id,
					day_type: snap.manifest.day_type,
					station_id: staId,
					train_id: trainId,
					route_name: item.route_name.trim(),
					dest: item.dest.trim(),
					dest_time: item.dest_time.trim(),
					color: item.color.trim(),
					time_est: item.time_est.trim(),
					ka_name: item.ka_name.trim(),
				};

				let list = trainOccurrences.get(trainId);
				if (!list) {
					list = [];
					trainOccurrences.set(trainId, list);
				}
				list.push(record);
			}
		}
	}

	// ─── 5. Determine Calendar Completeness ─────────────────────────────────────
	const distinctDayTypes = new Set(
		archive.snapshots.map((s) => s.manifest.day_type),
	);
	const isCalendarResolved =
		distinctDayTypes.has("weekday") &&
		distinctDayTypes.has("saturday") &&
		distinctDayTypes.has("sunday");
	const calendarState = isCalendarResolved ? "resolved" : "provisional";

	// ─── 6. Fold Trips, Calendar, and Stops ─────────────────────────────────────
	const sortedTrainIds = Array.from(trainOccurrences.keys()).sort((a, b) =>
		a.localeCompare(b),
	);

	const trips: Array<typeof schema.trips.$inferInsert> = [];
	const tripCalendar: Array<typeof schema.tripCalendar.$inferInsert> = [];
	const tripStops: Array<typeof schema.tripStops.$inferInsert> = [];

	let itineraryTripsCount = 0;
	let reconstructedTripsCount = 0;

	for (const trainId of sortedTrainIds) {
		const occurrences = trainOccurrences.get(trainId);
		if (!occurrences || occurrences.length === 0) {
			continue;
		}
		const firstOccurrence = occurrences[0];
		const firstSnapshotId = firstOccurrence.snapshot_id;
		const nowIso = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");

		// Inv 7: Identifier Grammar
		const parsedId = parseTrainId(trainId);
		if (!parsedId) {
			quarantinedTrips.push({
				timetable_version: version,
				trip_id: trainId,
				day_type: firstOccurrence.day_type,
				reason: "malformed_identifier",
				raw_payload: JSON.stringify(occurrences),
				discovered_in: firstSnapshotId,
				quarantined_at: nowIso,
			});
			continue;
		}

		// Group occurrences by snapshot for intra-snapshot & cross-snapshot checks
		const bySnapshot = new Map<number, SnapshotBoardRecord[]>();
		for (const occ of occurrences) {
			let sList = bySnapshot.get(occ.snapshot_id);
			if (!sList) {
				sList = [];
				bySnapshot.set(occ.snapshot_id, sList);
			}
			sList.push(occ);
		}

		// Inv 1: Intra-trip board consistency per snapshot
		let intraTripConsistent = true;
		for (const [snapId, snapOccurrences] of bySnapshot) {
			const check1 = checkIntraTripConsistency(snapOccurrences);
			if (!check1.valid) {
				quarantinedTrips.push({
					timetable_version: version,
					trip_id: trainId,
					day_type: snapOccurrences[0].day_type,
					reason: "invariant_violation",
					raw_payload: JSON.stringify({
						error: `Intra-trip board attribute mismatch in snapshot ${snapId}: ${check1.reason}`,
						occurrences: snapOccurrences,
					}),
					discovered_in: snapId,
					quarantined_at: nowIso,
				});
				intraTripConsistent = false;
				break;
			}
		}
		if (!intraTripConsistent) {
			continue;
		}

		// Inv 2: Minimum Board Occurrence (>= 2)
		const maxBoardOccurrences = Math.max(
			...Array.from(bySnapshot.values()).map((l) => l.length),
		);
		if (!checkMinBoardOccurrence(maxBoardOccurrences)) {
			quarantinedTrips.push({
				timetable_version: version,
				trip_id: trainId,
				day_type: firstOccurrence.day_type,
				reason: "invariant_violation",
				raw_payload: JSON.stringify({
					error: `Train appeared on only ${maxBoardOccurrences} board departure row(s) (< 2 required)`,
					occurrences,
				}),
				discovered_in: firstSnapshotId,
				quarantined_at: nowIso,
			});
			continue;
		}

		// Resolve destination station ID
		const destStationId =
			resolveStationId(firstOccurrence.dest, stationsCatalog) ??
			resolveStationCode(firstOccurrence.dest);

		if (!validStationIds.has(destStationId)) {
			quarantinedTrips.push({
				timetable_version: version,
				trip_id: trainId,
				day_type: firstOccurrence.day_type,
				reason: "invariant_violation",
				raw_payload: JSON.stringify({
					error: `Unresolvable destination station '${firstOccurrence.dest}'`,
					occurrences,
				}),
				discovered_in: firstSnapshotId,
				quarantined_at: nowIso,
			});
			continue;
		}

		// Inv 12: Cross-Capture Trip Attribute Consistency
		let crossCaptureConsistent = true;
		const baseAttributes = {
			route_name_raw: firstOccurrence.route_name,
			headsign: firstOccurrence.dest,
			dest_station_id: destStationId,
			dest_time: firstOccurrence.dest_time,
			color: firstOccurrence.color,
		};

		for (const [snapId, snapOccs] of bySnapshot) {
			const currentOcc = snapOccs[0];
			const currentDestId =
				resolveStationId(currentOcc.dest, stationsCatalog) ??
				resolveStationCode(currentOcc.dest);
			const currentAttrs = {
				route_name_raw: currentOcc.route_name,
				headsign: currentOcc.dest,
				dest_station_id: currentDestId,
				dest_time: currentOcc.dest_time,
				color: currentOcc.color,
			};
			const conflict = checkCrossCaptureTripConsistency(
				baseAttributes,
				currentAttrs,
			);
			if (!conflict.valid) {
				quarantinedTrips.push({
					timetable_version: version,
					trip_id: trainId,
					day_type: currentOcc.day_type,
					reason: "attribute_conflict",
					raw_payload: JSON.stringify({
						error: `Attribute mismatch across captures (${conflict.fieldMismatch})`,
						base: baseAttributes,
						divergent: currentAttrs,
						snapshot_id: snapId,
					}),
					discovered_in: snapId,
					quarantined_at: nowIso,
				});
				crossCaptureConsistent = false;
				break;
			}
		}
		if (!crossCaptureConsistent) {
			continue;
		}

		// ─── 7. Evaluate Itinerary or Fallback Reconstruct ─────────────────────────
		const itineraryEnvelope = archive.itineraries.get(trainId);
		let source: "itinerary" | "reconstructed" = "reconstructed";
		let itineraryStatus: "200" | "404" | "unprobed" = itineraryEnvelope
			? "404"
			: "unprobed";

		let tripStopsRows: Array<typeof schema.tripStops.$inferInsert> = [];
		let originStationId = "";
		let originTime = "";
		let destTime = firstOccurrence.dest_time;
		let originSecs = 0;
		let destSecs = 0;
		let totalStops = 0;

		// Check if itinerary envelope contains valid observations
		let activeObservation =
			itineraryEnvelope?.observations[firstOccurrence.day_type];
		if (!activeObservation && itineraryEnvelope?.observations) {
			// Fallback to any available observation in envelope
			const obsKeys = Object.keys(itineraryEnvelope.observations);
			if (obsKeys.length > 0) {
				activeObservation =
					itineraryEnvelope.observations[
						obsKeys[0] as keyof typeof itineraryEnvelope.observations
					];
			}
		}

		let itineraryValid = false;
		if (activeObservation && activeObservation.stops.length >= 2) {
			const stops = activeObservation.stops;
			const resolvedSecs = resolveItinerarySecs(stops);
			const lastStop = stops[stops.length - 1];
			const lastStopStaId = resolveStationCode(lastStop.station_id);

			// Invariant 6: Strict Monotonicity
			const isMonotonic = checkStopMonotonicity(resolvedSecs);

			// Invariant 5: Terminus Alignment
			const isTerminusAligned = checkTerminusAlignment(
				destStationId,
				firstOccurrence.dest_time,
				lastStopStaId,
				lastStop.time_est,
			);

			// Invariant 9: Referential Integrity on Itinerary Stops
			const allStopsReferentiallyValid = stops.every((st) =>
				validStationIds.has(resolveStationCode(st.station_id)),
			);

			if (isMonotonic && isTerminusAligned && allStopsReferentiallyValid) {
				source = "itinerary";
				itineraryStatus = "200";
				itineraryValid = true;
				totalStops = stops.length;
				originStationId = resolveStationCode(stops[0].station_id);
				originTime = stops[0].time_est;
				destTime = lastStop.time_est;
				originSecs =
					resolvedSecs[0].departure_secs ?? toServiceDaySecs(originTime);
				destSecs =
					resolvedSecs[resolvedSecs.length - 1].arrival_secs ??
					toServiceDaySecs(destTime);

				tripStopsRows = stops.map((st: ItineraryStop, idx: number) => {
					const t = resolvedSecs[idx];
					return {
						timetable_version: version,
						trip_id: trainId,
						stop_sequence: idx + 1,
						station_id: resolveStationCode(st.station_id),
						time_raw: st.time_est,
						arrival_secs: t.arrival_secs,
						departure_secs: t.departure_secs,
						is_transit: st.transit_station ? 1 : 0,
					};
				});
				itineraryTripsCount++;
			}
		}

		if (!itineraryValid) {
			// Fallback to topological reconstruction using the most complete snapshot
			const representativeSnapOccs = Array.from(bySnapshot.values()).reduce(
				(best, curr) => (curr.length > best.length ? curr : best),
				[] as SnapshotBoardRecord[],
			);
			const reconstructed = reconstructFromBoards(
				representativeSnapOccs,
				destStationId,
			);

			if (!reconstructed) {
				quarantinedTrips.push({
					timetable_version: version,
					trip_id: trainId,
					day_type: firstOccurrence.day_type,
					reason: "invariant_violation",
					raw_payload: JSON.stringify({
						error: "Failed to reconstruct trip from departure boards",
						occurrences,
					}),
					discovered_in: firstSnapshotId,
					quarantined_at: nowIso,
				});
				continue;
			}

			source = "reconstructed";
			totalStops = reconstructed.total_stops;
			originStationId = reconstructed.origin_station_id;
			originTime = reconstructed.origin_time;
			destTime = reconstructed.dest_time;
			originSecs = reconstructed.origin_secs;
			destSecs = reconstructed.dest_secs;

			tripStopsRows = reconstructed.stops.map((st) => ({
				timetable_version: version,
				trip_id: trainId,
				stop_sequence: st.stop_sequence,
				station_id: st.station_id,
				time_raw: st.time_raw,
				arrival_secs: st.arrival_secs,
				departure_secs: st.departure_secs,
				is_transit: st.is_transit,
			}));
			reconstructedTripsCount++;
		}

		// Snapshot appearances
		const seenSnapshots = Array.from(bySnapshot.keys()).sort((a, b) => a - b);
		const firstSeenSnapshot = seenSnapshots[0];
		const lastSeenSnapshot = seenSnapshots[seenSnapshots.length - 1];

		// Calendar presence flags across complete snapshots
		const runsWeekday = occurrences.some((o) => o.day_type === "weekday")
			? 1
			: 0;
		const runsSaturday = occurrences.some((o) => o.day_type === "saturday")
			? 1
			: 0;
		const runsSunday = occurrences.some((o) => o.day_type === "sunday") ? 1 : 0;

		// Push clean trip
		trips.push({
			timetable_version: version,
			trip_id: parsedId.trip_id,
			base_train_no: parsedId.base_train_no,
			revision: parsedId.revision,
			line_name: firstOccurrence.ka_name,
			route_name_raw: firstOccurrence.route_name,
			headsign: firstOccurrence.dest,
			origin_station_id: originStationId,
			dest_station_id: destStationId,
			origin_time: originTime,
			dest_time: destTime,
			origin_secs: originSecs,
			dest_secs: destSecs,
			total_stops: totalStops,
			color: firstOccurrence.color,
			is_fakultatif: parsedId.is_fakultatif ? 1 : 0,
			source,
			itinerary_status: itineraryStatus,
			first_seen_snapshot: firstSeenSnapshot,
			last_seen_snapshot: lastSeenSnapshot,
		});

		// Push calendar presence
		tripCalendar.push({
			timetable_version: version,
			trip_id: parsedId.trip_id,
			runs_weekday: runsWeekday,
			runs_saturday: runsSaturday,
			runs_sunday: runsSunday,
			captured_day_types: distinctDayTypes.size,
			calendar_state: calendarState,
		});

		// Push stops
		for (const stop of tripStopsRows) {
			tripStops.push(stop);
		}
	}

	const stats: FoldStats = {
		totalTrips: trips.length,
		itineraryTrips: itineraryTripsCount,
		reconstructedTrips: reconstructedTripsCount,
		quarantinedTrips: quarantinedTrips.length,
		calendarResolved: isCalendarResolved,
		dayTypesCaptured: distinctDayTypes.size,
		totalStops: tripStops.length,
		totalStations: sortedStations.length,
	};

	return {
		stations: sortedStations,
		snapshots: sortedSnapshots,
		trips,
		tripCalendar,
		tripStops,
		holidays: sortedHolidays,
		quarantinedTrips,
		stats,
	};
}
