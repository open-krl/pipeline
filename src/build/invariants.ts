// src/build/invariants.ts
import { DEAD_BAND_CUTOFF_SECS, parseHMS } from "../core/time";
import { parseTrainId } from "../core/trainid";
import type { RawSnapshot } from "./types";

export interface BoardOccurrence {
	station_id: string;
	train_id: string;
	route_name: string;
	dest: string;
	dest_time: string;
	color: string;
	time_est: string;
}

const DEAD_BAND_START_SECS = 5400; // 01:30:00
const DEAD_BAND_END_SECS = DEAD_BAND_CUTOFF_SECS; // 12600 (03:30:00)

/**
 * Invariant 1: Intra-Trip Attribute Consistency
 * Across all station boards where a train_id appears within a capture,
 * route_name, dest, dest_time, and color must be byte-for-byte identical.
 */
export function checkIntraTripConsistency(occurrences: BoardOccurrence[]): {
	valid: boolean;
	reason?: string;
} {
	if (occurrences.length <= 1) {
		return { valid: true };
	}

	const first = occurrences[0];
	for (let i = 1; i < occurrences.length; i++) {
		const curr = occurrences[i];
		if (curr.route_name !== first.route_name) {
			return {
				valid: false,
				reason: `route_name mismatch: '${first.route_name}' vs '${curr.route_name}' at ${curr.station_id}`,
			};
		}
		if (curr.dest !== first.dest) {
			return {
				valid: false,
				reason: `dest mismatch: '${first.dest}' vs '${curr.dest}' at ${curr.station_id}`,
			};
		}
		if (curr.dest_time !== first.dest_time) {
			return {
				valid: false,
				reason: `dest_time mismatch: '${first.dest_time}' vs '${curr.dest_time}' at ${curr.station_id}`,
			};
		}
		if (curr.color !== first.color) {
			return {
				valid: false,
				reason: `color mismatch: '${first.color}' vs '${curr.color}' at ${curr.station_id}`,
			};
		}
	}

	return { valid: true };
}

/**
 * Invariant 2: Minimum Board Occurrence (>= 2)
 * A valid operational trip must appear on at least two distinct station departure boards
 * (origin and >= 1 upstream station; terminus publishes no departure).
 */
export function checkMinBoardOccurrence(boardRowCount: number): boolean {
	return boardRowCount >= 2;
}

/**
 * Invariant 3: Dead-Band Assertion
 * Zero scheduled departures network-wide between 01:30:00 (5400s) and 03:30:00 (12600s).
 */
export function checkDeadBand(times: string[]): {
	valid: boolean;
	violations: string[];
} {
	const violations: string[] = [];
	for (const timeStr of times) {
		try {
			const secs = parseHMS(timeStr);
			if (secs > DEAD_BAND_START_SECS && secs < DEAD_BAND_END_SECS) {
				violations.push(timeStr);
			}
		} catch {
			// Skip unparseable times; will be caught by format invariants
		}
	}
	return {
		valid: violations.length === 0,
		violations,
	};
}

/**
 * Invariant 4: Board-Itinerary Time Congruence
 * For every station board departure row, time_est must match the corresponding
 * itinerary stop entry, within whole-minute / ±60s rounding window.
 */
export function checkBoardItineraryTimeCongruence(
	boardHms: string,
	itineraryHms: string,
	toleranceSecs = 60,
): boolean {
	try {
		const bSecs = parseHMS(boardHms);
		const iSecs = parseHMS(itineraryHms);
		const diff = Math.abs(bSecs - iSecs);
		return diff <= toleranceSecs;
	} catch {
		return false;
	}
}

/**
 * Invariant 5: Terminus Alignment
 * The final scheduled stop in a train's itinerary must match trip-level dest
 * station and dest_time (within ±60s tolerance).
 */
export function checkTerminusAlignment(
	expectedDestId: string,
	expectedDestTime: string,
	actualLastStopId: string,
	actualLastStopTime: string,
	toleranceSecs = 60,
): boolean {
	if (expectedDestId !== actualLastStopId) {
		return false;
	}
	try {
		const expSecs = parseHMS(expectedDestTime);
		const actSecs = parseHMS(actualLastStopTime);
		return Math.abs(expSecs - actSecs) <= toleranceSecs;
	} catch {
		return false;
	}
}

/**
 * Invariant 6: Strict Monotonicity
 * Stop sequences must exhibit strictly non-decreasing service-day seconds:
 * secs_i <= secs_{i+1}. Consecutive equal times are permitted (dwell).
 */
export function checkStopMonotonicity(
	resolvedSecs: Array<{
		arrival_secs: number | null;
		departure_secs: number | null;
	}>,
): boolean {
	let prevSecs: number | null = null;
	for (const stop of resolvedSecs) {
		const currentSecs = stop.arrival_secs ?? stop.departure_secs;
		if (currentSecs !== null) {
			if (prevSecs !== null && currentSecs < prevSecs) {
				return false;
			}
			prevSecs = currentSecs;
		}
	}
	return true;
}

/**
 * Invariant 7: Identifier Grammar Adherence
 * 100% of discovered train_ids must conform to ^(\d+)([A-E])?(F)?$.
 * Violations are isolated to quarantined_trips.
 */
export function checkIdentifierGrammar(trainId: string): boolean {
	return parseTrainId(trainId) !== null;
}

/**
 * Invariant 8: Cross-Capture Suffix Transition Bounds
 * For a stable base train number within same-day-type captures,
 * revision suffix drift must advance incrementally (<= +1 ASCII offset).
 */
export function checkSuffixTransition(
	revEarlier: string | null,
	revLater: string | null,
): boolean {
	if (revEarlier === revLater) {
		return true;
	}
	const earlierVal = revEarlier
		? revEarlier.charCodeAt(0)
		: "A".charCodeAt(0) - 1;
	const laterVal = revLater ? revLater.charCodeAt(0) : "A".charCodeAt(0) - 1;
	const diff = laterVal - earlierVal;
	return diff >= 0 && diff <= 1;
}

/**
 * Invariant 9: Referential Integrity on Inferred Stations
 * Station identifiers must resolve against valid station catalog rows (sta_id NOT LIKE 'WIL%').
 */
export function checkStationReferentialIntegrity(
	stationId: string | null | undefined,
	validStationIds: Set<string>,
): boolean {
	if (!stationId) {
		return false;
	}
	if (stationId.startsWith("WIL")) {
		return false;
	}
	return validStationIds.has(stationId);
}

/**
 * Invariant 10: Atomic Capture Integrity
 * Degraded captures are barred from build.
 */
function checkAtomicCaptureIntegrity(manifestStatus: string): boolean {
	return manifestStatus === "complete";
}

/**
 * Derives the canonical trip set from a snapshot's boards: the sorted,
 * deduplicated collection of grammar-conforming trip IDs across all stations.
 * Unparseable identifiers (e.g. paired-set IDs like "801A-802A") are excluded
 * because they are quarantined by Invariant 7 and have no effect on the build.
 */
function canonicalTripSet(snap: RawSnapshot): string {
	const ids = new Set<string>();
	for (const board of snap.boards.values()) {
		for (const row of board.data) {
			if (parseTrainId(row.train_id) !== null) {
				ids.add(row.train_id);
			}
		}
	}
	return [...ids].sort().join(",");
}

/**
 * Invariant 11: Cross-Capture Edition Consistency
 * - All complete captures within the version share an identical station_master_hash.
 * - Same-day-type captures share an identical canonical parsed trip set
 *   (sorted, deduplicated grammar-conforming train IDs). Raw board_response_hash
 *   is intentionally not compared here: non-semantic payload differences such as
 *   KCI emitting unparseable paired identifiers (e.g. "801A-802A") diverge the
 *   raw hash without changing the effective timetable.
 */
export function checkEditionConsistency(snapshots: RawSnapshot[]): {
	valid: boolean;
	reason?: string;
} {
	if (snapshots.length <= 1) {
		return { valid: true };
	}

	const baseStationHash = snapshots[0].manifest.station_master_hash;
	const dayTypeTripSets = new Map<string, { id: number; tripSet: string }>();

	for (const snap of snapshots) {
		// Station master hash must be identical across all captures (byte-level guard)
		if (snap.manifest.station_master_hash !== baseStationHash) {
			return {
				valid: false,
				reason: `Station master hash divergence in snapshot ${snap.id} (${snap.manifest.station_master_hash.slice(0, 8)} vs ${baseStationHash.slice(0, 8)})`,
			};
		}

		// Within-day-type: canonical parsed trip sets must be identical
		const tripSet = canonicalTripSet(snap);
		const prev = dayTypeTripSets.get(snap.manifest.day_type);
		if (prev) {
			if (prev.tripSet !== tripSet) {
				return {
					valid: false,
					reason: `Parsed trip set divergence between snapshot ${prev.id} and ${snap.id} for day type '${snap.manifest.day_type}'`,
				};
			}
		} else {
			dayTypeTripSets.set(snap.manifest.day_type, {
				id: snap.id,
				tripSet,
			});
		}
	}

	return { valid: true };
}

/**
 * Invariant 12: Cross-Capture Trip-Attribute Consistency
 * Across same-edition captures, any identical trip_id must carry identical
 * trip-level attributes (route_name_raw, headsign, dest_station_id, dest_time, color).
 */
export interface TripFoldAttributes {
	route_name_raw: string;
	headsign: string;
	dest_station_id: string;
	dest_time: string;
	color: string;
}

export function checkCrossCaptureTripConsistency(
	attr1: TripFoldAttributes,
	attr2: TripFoldAttributes,
): { valid: boolean; fieldMismatch?: string } {
	if (attr1.route_name_raw !== attr2.route_name_raw) {
		return { valid: false, fieldMismatch: "route_name_raw" };
	}
	if (attr1.headsign !== attr2.headsign) {
		return { valid: false, fieldMismatch: "headsign" };
	}
	if (attr1.dest_station_id !== attr2.dest_station_id) {
		return { valid: false, fieldMismatch: "dest_station_id" };
	}
	if (attr1.dest_time !== attr2.dest_time) {
		return { valid: false, fieldMismatch: "dest_time" };
	}
	if (attr1.color !== attr2.color) {
		return { valid: false, fieldMismatch: "color" };
	}
	return { valid: true };
}

/**
 * Invariant 13: Board-Itinerary Stop Count Congruence
 * For source = 'itinerary', board departure rows count across network must strictly equal total_stops - 1.
 */
export function checkBoardItineraryStopCountCongruence(
	boardRowCount: number,
	totalStops: number,
): boolean {
	return boardRowCount === totalStops - 1;
}
