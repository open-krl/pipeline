// src/diagnostic/itinerary.ts
import type { ItineraryStop } from "../api/schemas";
import { toServiceDaySecs } from "../core/time";
import type { ItineraryDiff, ItineraryStopDiff } from "./types";

/**
 * Computes a semantic diff between two stop-level train itineraries (§9 Stratified Spot-Check).
 * Evaluates sequence changes, added/removed stops, and arrival/departure retiming (±Δ seconds).
 */
export function diffItineraries(
	trainIdBefore: string,
	stopsBefore: readonly ItineraryStop[],
	trainIdAfter: string,
	stopsAfter: readonly ItineraryStop[],
): ItineraryDiff {
	const beforeMap = new Map<string, { stop: ItineraryStop; index: number }>();
	stopsBefore.forEach((stop, index) => {
		beforeMap.set(stop.station_id, { stop, index });
	});

	const afterMap = new Map<string, { stop: ItineraryStop; index: number }>();
	stopsAfter.forEach((stop, index) => {
		afterMap.set(stop.station_id, { stop, index });
	});

	const stopsDiff: ItineraryStopDiff[] = [];
	let retimedCount = 0;
	let unchangedCount = 0;
	let addedCount = 0;
	let removedCount = 0;

	// Walk after stops to identify unchanged, retimed, or added
	const handledBeforeStations = new Set<string>();

	for (const afterStop of stopsAfter) {
		const beforeEntry = beforeMap.get(afterStop.station_id);

		if (!beforeEntry) {
			addedCount++;
			stopsDiff.push({
				stationId: afterStop.station_id,
				stationName: afterStop.station_name,
				status: "added",
				timeBefore: null,
				timeAfter: afterStop.time_est,
				deltaSecs: 0,
			});
			continue;
		}

		handledBeforeStations.add(afterStop.station_id);
		const beforeSecs = toServiceDaySecs(beforeEntry.stop.time_est);
		const afterSecs = toServiceDaySecs(afterStop.time_est);
		const deltaSecs = afterSecs - beforeSecs;

		if (deltaSecs === 0) {
			unchangedCount++;
			stopsDiff.push({
				stationId: afterStop.station_id,
				stationName: afterStop.station_name,
				status: "unchanged",
				timeBefore: beforeEntry.stop.time_est,
				timeAfter: afterStop.time_est,
				deltaSecs: 0,
			});
		} else {
			retimedCount++;
			stopsDiff.push({
				stationId: afterStop.station_id,
				stationName: afterStop.station_name,
				status: "retimed",
				timeBefore: beforeEntry.stop.time_est,
				timeAfter: afterStop.time_est,
				deltaSecs,
			});
		}
	}

	// Walk before stops to find removed
	for (const beforeStop of stopsBefore) {
		if (!handledBeforeStations.has(beforeStop.station_id)) {
			removedCount++;
			stopsDiff.push({
				stationId: beforeStop.station_id,
				stationName: beforeStop.station_name,
				status: "removed",
				timeBefore: beforeStop.time_est,
				timeAfter: null,
				deltaSecs: 0,
			});
		}
	}

	const tripLabel =
		trainIdBefore === trainIdAfter
			? `Trip ${trainIdBefore}`
			: `Trip ${trainIdBefore} -> ${trainIdAfter}`;

	let summary: string;
	if (retimedCount === 0 && addedCount === 0 && removedCount === 0) {
		summary = `${tripLabel}: Identical (${unchangedCount} stops)`;
	} else {
		const parts: string[] = [];
		if (retimedCount > 0) parts.push(`${retimedCount} retimed`);
		if (addedCount > 0) parts.push(`${addedCount} added`);
		if (removedCount > 0) parts.push(`${removedCount} removed`);
		summary = `${tripLabel}: ${parts.join(", ")} (${unchangedCount} unchanged)`;
	}

	return {
		trainIdBefore,
		trainIdAfter,
		stopsCountBefore: stopsBefore.length,
		stopsCountAfter: stopsAfter.length,
		stops: stopsDiff,
		retimedCount,
		addedCount,
		removedCount,
		unchangedCount,
		summary,
	};
}
