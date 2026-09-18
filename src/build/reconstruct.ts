// src/build/reconstruct.ts
import { toServiceDaySecs } from "../core/time";
import type { BoardOccurrence } from "./invariants";

interface ReconstructedStop {
	stop_sequence: number;
	station_id: string;
	time_raw: string;
	arrival_secs: number | null;
	departure_secs: number | null;
	is_transit: number;
}

export interface ReconstructedTripData {
	origin_station_id: string;
	dest_station_id: string;
	origin_time: string;
	dest_time: string;
	origin_secs: number;
	dest_secs: number;
	total_stops: number;
	stops: ReconstructedStop[];
}

/**
 * Reconstructs a train's complete itinerary topology from departure board observations (§10.4).
 * Used when no official probed itinerary envelope exists or when upstream returned 404.
 *
 * Sorts observed board departures chronologically by service-day seconds.
 * Appends the final terminus stop (which publishes no departure row by construction) using dest_time.
 */
export function reconstructFromBoards(
	occurrences: BoardOccurrence[],
	destStationId: string,
): ReconstructedTripData | null {
	if (occurrences.length === 0) {
		return null;
	}

	// 1. Sort departure board records chronologically by service-day seconds
	const sorted = [...occurrences].sort((a, b) => {
		const secsA = toServiceDaySecs(a.time_est);
		const secsB = toServiceDaySecs(b.time_est);
		return secsA - secsB;
	});

	const origin = sorted[0];
	const destTime = origin.dest_time;
	const originSecs = toServiceDaySecs(origin.time_est);
	const destSecs = toServiceDaySecs(destTime);

	const stops: ReconstructedStop[] = [];

	// 2. Add observed board departures
	for (let i = 0; i < sorted.length; i++) {
		const occ = sorted[i];
		const sec = toServiceDaySecs(occ.time_est);
		const isOrigin = i === 0;

		stops.push({
			stop_sequence: i + 1,
			station_id: occ.station_id,
			time_raw: occ.time_est,
			arrival_secs: isOrigin ? null : sec,
			departure_secs: sec,
			is_transit: 0,
		});
	}

	// 3. Append terminus stop (terminus publishes no departure row)
	const terminusSeq = stops.length + 1;
	stops.push({
		stop_sequence: terminusSeq,
		station_id: destStationId,
		time_raw: destTime,
		arrival_secs: destSecs,
		departure_secs: null,
		is_transit: 0,
	});

	return {
		origin_station_id: origin.station_id,
		dest_station_id: destStationId,
		origin_time: origin.time_est,
		dest_time: destTime,
		origin_secs: originSecs,
		dest_secs: destSecs,
		total_stops: stops.length,
		stops,
	};
}
