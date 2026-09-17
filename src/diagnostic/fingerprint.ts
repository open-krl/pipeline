// src/diagnostic/fingerprint.ts
import type { DepartureBoardItem } from "../api/schemas";
import { toServiceDaySecs } from "../core/time";
import { parseTrainId } from "../core/trainid";
import type { BoardDiffTripItem } from "./types";

export interface TripDepartureStop {
	stationId: string;
	depSecs: number;
	timeEst: string;
}

export interface TripSummary {
	trainId: string;
	baseTrainNo: number;
	revision: string | null;
	isFakultatif: boolean;
	kaName: string;
	routeName: string;
	dest: string;
	destTime: string;
	destTimeSecs: number;
	/**
	 * Station ID of the chronologically earliest departure stop across observed boards.
	 * NOTE: Represents the physical origin only under the invariant that boards cover the
	 * complete 24h service day (§2.2).
	 */
	originStation: string;
	originDepSecs: number;
	departures: Map<string, TripDepartureStop>;
}

/**
 * Extracts distinct operational trip summaries across departure boards (§4.1, §8.1).
 */
export function extractTripSummaries(
	boardsByStationId:
		| Record<string, readonly DepartureBoardItem[]>
		| Map<string, readonly DepartureBoardItem[]>,
): Map<string, TripSummary> {
	const entries =
		boardsByStationId instanceof Map
			? Array.from(boardsByStationId.entries())
			: Object.entries(boardsByStationId);

	const trips = new Map<
		string,
		{
			trainId: string;
			baseTrainNo: number;
			revision: string | null;
			isFakultatif: boolean;
			kaName: string;
			routeName: string;
			dest: string;
			destTime: string;
			destTimeSecs: number;
			stops: TripDepartureStop[];
		}
	>();

	for (const [stationId, departures] of entries) {
		for (const dep of departures) {
			const parsedId = parseTrainId(dep.train_id);
			if (!parsedId) continue;

			const depSecs = toServiceDaySecs(dep.time_est);
			const destSecs = toServiceDaySecs(dep.dest_time);

			const existing = trips.get(dep.train_id);
			if (existing) {
				existing.stops.push({
					stationId,
					depSecs,
					timeEst: dep.time_est,
				});
				if (!existing.kaName && dep.ka_name) existing.kaName = dep.ka_name;
				if (!existing.routeName && dep.route_name)
					existing.routeName = dep.route_name;
				if (!existing.dest && dep.dest) existing.dest = dep.dest;
				if (!existing.destTime && dep.dest_time) {
					existing.destTime = dep.dest_time;
					existing.destTimeSecs = destSecs;
				}
			} else {
				trips.set(dep.train_id, {
					trainId: dep.train_id,
					baseTrainNo: parsedId.base_train_no,
					revision: parsedId.revision,
					isFakultatif: parsedId.is_fakultatif,
					kaName: dep.ka_name,
					routeName: dep.route_name,
					dest: dep.dest,
					destTime: dep.dest_time,
					destTimeSecs: destSecs,
					stops: [{ stationId, depSecs, timeEst: dep.time_est }],
				});
			}
		}
	}

	const summaries = new Map<string, TripSummary>();

	for (const [trainId, trip] of trips.entries()) {
		// Sort stops chronologically to accurately detect origin station
		trip.stops.sort((a, b) => a.depSecs - b.depSecs);
		const origin = trip.stops[0];

		const departuresMap = new Map<string, TripDepartureStop>();
		for (const stop of trip.stops) {
			departuresMap.set(stop.stationId, stop);
		}

		summaries.set(trainId, {
			trainId,
			baseTrainNo: trip.baseTrainNo,
			revision: trip.revision,
			isFakultatif: trip.isFakultatif,
			kaName: trip.kaName,
			routeName: trip.routeName,
			dest: trip.dest,
			destTime: trip.destTime,
			destTimeSecs: trip.destTimeSecs,
			originStation: origin?.stationId ?? "UNKNOWN",
			originDepSecs: origin?.depSecs ?? 0,
			departures: departuresMap,
		});
	}

	return summaries;
}

export interface MatchTripsOptions {
	/**
	 * Tolerance in seconds for matching arrival times at destination (default: 900s / 15m).
	 */
	arrivalToleranceSecs?: number;
}

export interface MatchedTripsResult {
	identical: BoardDiffTripItem[];
	relettered: BoardDiffTripItem[];
	retimed: BoardDiffTripItem[];
	added: BoardDiffTripItem[];
	withdrawn: BoardDiffTripItem[];
}

/**
 * Matches trips across two captures using the Railway Fingerprint model (§4.1, Invariant 8):
 * Fingerprint = (base_train_no, origin_station, dest_station, arrival_time ± tolerance)
 */
export interface CandidateMatchResult {
	match: TripSummary;
	relettered: boolean;
	retimed: boolean;
	deltaSecs: number;
}

/**
 * Finds the optimal candidate trip matching a target trip by exact ID or Railway Fingerprint (§4.1, Invariant 8).
 * Selects candidate with minimum destination arrival time delta within tolerance.
 */
export function findBestFingerprintCandidate(
	target: TripSummary,
	candidates: Map<string, TripSummary> | Iterable<TripSummary>,
	matchedIds: Set<string>,
	tolerance = 900,
): CandidateMatchResult | null {
	const candidateList =
		candidates instanceof Map
			? Array.from(candidates.values())
			: Array.from(candidates);

	// 1. Direct match on identical train_id
	for (const candidate of candidateList) {
		if (
			candidate.trainId === target.trainId &&
			!matchedIds.has(candidate.trainId)
		) {
			if (candidate.dest === target.dest) {
				const delta = Math.abs(candidate.destTimeSecs - target.destTimeSecs);
				if (delta <= tolerance) {
					return {
						match: candidate,
						relettered: false,
						retimed: delta > 0,
						deltaSecs: delta,
					};
				}
			}
		}
	}

	// 2. Domain Fingerprint matching: same base_train_no, origin, dest, min arrival delta
	let bestCandidate: TripSummary | null = null;
	let minDelta = Number.POSITIVE_INFINITY;

	for (const candidate of candidateList) {
		if (matchedIds.has(candidate.trainId)) continue;
		if (candidate.baseTrainNo !== target.baseTrainNo) continue;
		if (candidate.dest !== target.dest) continue;

		if (
			candidate.originStation !== "UNKNOWN" &&
			target.originStation !== "UNKNOWN" &&
			candidate.originStation !== target.originStation
		) {
			continue;
		}

		const delta = Math.abs(candidate.destTimeSecs - target.destTimeSecs);
		if (delta <= tolerance && delta < minDelta) {
			minDelta = delta;
			bestCandidate = candidate;
		}
	}

	if (bestCandidate) {
		return {
			match: bestCandidate,
			relettered: bestCandidate.trainId !== target.trainId,
			retimed: minDelta > 0,
			deltaSecs: minDelta,
		};
	}

	return null;
}

/**
 * Matches trips across two captures using the Railway Fingerprint model (§4.1, Invariant 8):
 * Fingerprint = (base_train_no, origin_station, dest_station, arrival_time ± tolerance)
 */
export function matchTripsByFingerprint(
	tripsBefore: Map<string, TripSummary>,
	tripsAfter: Map<string, TripSummary>,
	options: MatchTripsOptions = {},
): MatchedTripsResult {
	const tolerance = options.arrivalToleranceSecs ?? 900;

	const identical: BoardDiffTripItem[] = [];
	const relettered: BoardDiffTripItem[] = [];
	const retimed: BoardDiffTripItem[] = [];
	const added: BoardDiffTripItem[] = [];
	const withdrawn: BoardDiffTripItem[] = [];

	const matchedBeforeIds = new Set<string>();
	const matchedAfterIds = new Set<string>();

	// Pass 1: Exact train_id match
	for (const [trainId, afterTrip] of tripsAfter.entries()) {
		const beforeTrip = tripsBefore.get(trainId);
		if (!beforeTrip) continue;

		matchedBeforeIds.add(trainId);
		matchedAfterIds.add(trainId);

		// Compare departures across common stations
		let totalDelta = 0;
		let commonStops = 0;
		let maxAbsDelta = 0;

		for (const [staId, afterStop] of afterTrip.departures.entries()) {
			const beforeStop = beforeTrip.departures.get(staId);
			if (beforeStop) {
				commonStops++;
				const delta = afterStop.depSecs - beforeStop.depSecs;
				totalDelta += delta;
				if (Math.abs(delta) > maxAbsDelta) {
					maxAbsDelta = Math.abs(delta);
				}
			}
		}

		if (maxAbsDelta === 0) {
			identical.push({
				classification: "identical",
				baseTrainNo: afterTrip.baseTrainNo,
				trainIdBefore: trainId,
				trainIdAfter: trainId,
				originStation: afterTrip.originStation,
				dest: afterTrip.dest,
				timeDeltaSecs: 0,
				details: `${trainId}: Identical timetable profile (${afterTrip.departures.size} stops)`,
			});
		} else {
			const avgDelta =
				commonStops > 0 ? Math.round(totalDelta / commonStops) : 0;
			const deltaMins = Math.round(avgDelta / 60);
			const sign = avgDelta >= 0 ? "+" : "";
			retimed.push({
				classification: "retimed",
				baseTrainNo: afterTrip.baseTrainNo,
				trainIdBefore: trainId,
				trainIdAfter: trainId,
				originStation: afterTrip.originStation,
				dest: afterTrip.dest,
				timeDeltaSecs: avgDelta,
				details: `${trainId}: Retimed (${sign}${deltaMins}m across ${commonStops} common stops)`,
			});
		}
	}

	// Pass 2: Fingerprint matching for remaining unmatched trips (§4.1)
	// Match on: base_train_no, dest, origin, and arrival_time within tolerance (best min-delta match)
	const remainingBefore = Array.from(tripsBefore.values()).filter(
		(t) => !matchedBeforeIds.has(t.trainId),
	);
	const remainingAfter = Array.from(tripsAfter.values()).filter(
		(t) => !matchedAfterIds.has(t.trainId),
	);

	for (const afterTrip of remainingAfter) {
		let bestIndex = -1;
		let minDelta = Number.POSITIVE_INFINITY;

		for (let i = 0; i < remainingBefore.length; i++) {
			const beforeTrip = remainingBefore[i];
			if (
				beforeTrip.baseTrainNo === afterTrip.baseTrainNo &&
				beforeTrip.dest === afterTrip.dest &&
				(beforeTrip.originStation === "UNKNOWN" ||
					afterTrip.originStation === "UNKNOWN" ||
					beforeTrip.originStation === afterTrip.originStation)
			) {
				const delta = Math.abs(
					beforeTrip.destTimeSecs - afterTrip.destTimeSecs,
				);
				if (delta <= tolerance && delta < minDelta) {
					minDelta = delta;
					bestIndex = i;
				}
			}
		}

		if (bestIndex >= 0) {
			const beforeTrip = remainingBefore[bestIndex];
			remainingBefore.splice(bestIndex, 1);
			matchedAfterIds.add(afterTrip.trainId);

			const destDeltaSecs = afterTrip.destTimeSecs - beforeTrip.destTimeSecs;
			const deltaMins = Math.round(destDeltaSecs / 60);
			const sign = destDeltaSecs >= 0 ? "+" : "";

			if (destDeltaSecs === 0) {
				relettered.push({
					classification: "relettered",
					baseTrainNo: afterTrip.baseTrainNo,
					trainIdBefore: beforeTrip.trainId,
					trainIdAfter: afterTrip.trainId,
					originStation: afterTrip.originStation,
					dest: afterTrip.dest,
					timeDeltaSecs: 0,
					details: `Re-lettered: ${beforeTrip.trainId} -> ${afterTrip.trainId} (identical path & timings)`,
				});
			} else {
				relettered.push({
					classification: "relettered_and_retimed",
					baseTrainNo: afterTrip.baseTrainNo,
					trainIdBefore: beforeTrip.trainId,
					trainIdAfter: afterTrip.trainId,
					originStation: afterTrip.originStation,
					dest: afterTrip.dest,
					timeDeltaSecs: destDeltaSecs,
					details: `Re-lettered & Retimed: ${beforeTrip.trainId} -> ${afterTrip.trainId} (${sign}${deltaMins}m arrival at ${afterTrip.dest})`,
				});
			}
		}
	}

	// Pass 3: Remaining in after are genuinely added services
	for (const afterTrip of remainingAfter) {
		if (matchedAfterIds.has(afterTrip.trainId)) continue;
		added.push({
			classification: "added",
			baseTrainNo: afterTrip.baseTrainNo,
			trainIdBefore: null,
			trainIdAfter: afterTrip.trainId,
			originStation: afterTrip.originStation,
			dest: afterTrip.dest,
			timeDeltaSecs: 0,
			details: `Added service: ${afterTrip.trainId} (${afterTrip.originStation} -> ${afterTrip.dest} at ${afterTrip.destTime})`,
		});
	}

	// Pass 4: Remaining in before are withdrawn services
	for (const beforeTrip of remainingBefore) {
		withdrawn.push({
			classification: "withdrawn",
			baseTrainNo: beforeTrip.baseTrainNo,
			trainIdBefore: beforeTrip.trainId,
			trainIdAfter: null,
			originStation: beforeTrip.originStation,
			dest: beforeTrip.dest,
			timeDeltaSecs: 0,
			details: `Withdrawn service: ${beforeTrip.trainId} (${beforeTrip.originStation} -> ${beforeTrip.dest} at ${beforeTrip.destTime})`,
		});
	}

	// Deterministic sorting across all result arrays
	identical.sort((a, b) => a.baseTrainNo - b.baseTrainNo);
	relettered.sort((a, b) => a.baseTrainNo - b.baseTrainNo);
	retimed.sort((a, b) => a.baseTrainNo - b.baseTrainNo);
	added.sort((a, b) => a.baseTrainNo - b.baseTrainNo);
	withdrawn.sort((a, b) => a.baseTrainNo - b.baseTrainNo);

	return {
		identical,
		relettered,
		retimed,
		added,
		withdrawn,
	};
}
