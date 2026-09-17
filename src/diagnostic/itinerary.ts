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

	const commonBefore = stopsBefore.filter((s) => afterMap.has(s.station_id));
	const commonAfter = stopsAfter.filter((s) => beforeMap.has(s.station_id));

	const commonBeforeRank = new Map<string, number>();
	for (let i = 0; i < commonBefore.length; i++) {
		commonBeforeRank.set(commonBefore[i].station_id, i);
	}

	const commonAfterRank = new Map<string, number>();
	for (let i = 0; i < commonAfter.length; i++) {
		commonAfterRank.set(commonAfter[i].station_id, i);
	}

	const sequenceChanged = commonBefore.some(
		(s, i) => s.station_id !== commonAfter[i]?.station_id,
	);

	const stopsDiff: ItineraryStopDiff[] = [];
	let retimedCount = 0;
	let unchangedCount = 0;
	let addedCount = 0;
	let removedCount = 0;

	// Walk after stops to identify unchanged, retimed, or added
	const handledBeforeStations = new Set<string>();

	for (let afterIndex = 0; afterIndex < stopsAfter.length; afterIndex++) {
		const afterStop = stopsAfter[afterIndex];
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
				sequenceBefore: null,
				sequenceAfter: afterIndex + 1,
				reordered: false,
			});
			continue;
		}

		handledBeforeStations.add(afterStop.station_id);
		const beforeSecs = toServiceDaySecs(beforeEntry.stop.time_est);
		const afterSecs = toServiceDaySecs(afterStop.time_est);
		const deltaSecs = afterSecs - beforeSecs;

		const rankBefore = commonBeforeRank.get(afterStop.station_id);
		const rankAfter = commonAfterRank.get(afterStop.station_id);
		const reordered =
			rankBefore !== undefined &&
			rankAfter !== undefined &&
			rankBefore !== rankAfter;

		if (deltaSecs === 0) {
			unchangedCount++;
			stopsDiff.push({
				stationId: afterStop.station_id,
				stationName: afterStop.station_name,
				status: "unchanged",
				timeBefore: beforeEntry.stop.time_est,
				timeAfter: afterStop.time_est,
				deltaSecs: 0,
				sequenceBefore: beforeEntry.index + 1,
				sequenceAfter: afterIndex + 1,
				reordered,
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
				sequenceBefore: beforeEntry.index + 1,
				sequenceAfter: afterIndex + 1,
				reordered,
			});
		}
	}

	// Walk before stops to find removed
	for (let beforeIndex = 0; beforeIndex < stopsBefore.length; beforeIndex++) {
		const beforeStop = stopsBefore[beforeIndex];
		if (!handledBeforeStations.has(beforeStop.station_id)) {
			removedCount++;
			stopsDiff.push({
				stationId: beforeStop.station_id,
				stationName: beforeStop.station_name,
				status: "removed",
				timeBefore: beforeStop.time_est,
				timeAfter: null,
				deltaSecs: 0,
				sequenceBefore: beforeIndex + 1,
				sequenceAfter: null,
				reordered: false,
			});
		}
	}

	const tripLabel =
		trainIdBefore === trainIdAfter
			? `Trip ${trainIdBefore}`
			: `Trip ${trainIdBefore} -> ${trainIdAfter}`;

	let summary: string;
	if (
		!sequenceChanged &&
		retimedCount === 0 &&
		addedCount === 0 &&
		removedCount === 0
	) {
		summary = `${tripLabel}: Identical (${unchangedCount} stops)`;
	} else {
		const parts: string[] = [];
		if (sequenceChanged) parts.push("sequence changed");
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
		sequenceChanged,
		summary,
	};
}
