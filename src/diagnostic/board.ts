// src/diagnostic/board.ts
import type { DepartureBoardItem } from "../api/schemas";
import type { DayType } from "../archive/schemas";
import {
	extractTripSummaries,
	type MatchTripsOptions,
	matchTripsByFingerprint,
} from "./fingerprint";
import type { BoardDiff, DiffDayTypeContext } from "./types";

export interface DiffDepartureBoardsParams {
	boardsBefore:
		| Record<string, readonly DepartureBoardItem[]>
		| Map<string, readonly DepartureBoardItem[]>;
	boardsAfter:
		| Record<string, readonly DepartureBoardItem[]>
		| Map<string, readonly DepartureBoardItem[]>;
	manifestBefore?: {
		day_type?: DayType;
		snapshot_id?: number;
		timetable_version?: number;
	};
	manifestAfter?: {
		day_type?: DayType;
		snapshot_id?: number;
		timetable_version?: number;
	};
	options?: MatchTripsOptions;
}

/**
 * Computes a semantic diff between departure boards across two captures (§8.1 Gate 2, Invariant 11).
 * Detects station coverage gaps, matches trips via domain fingerprints, and evaluates day-type context.
 */
export function diffDepartureBoards(
	params: DiffDepartureBoardsParams,
): BoardDiff {
	const beforeStations = new Set(
		params.boardsBefore instanceof Map
			? params.boardsBefore.keys()
			: Object.keys(params.boardsBefore),
	);
	const afterStations = new Set(
		params.boardsAfter instanceof Map
			? params.boardsAfter.keys()
			: Object.keys(params.boardsAfter),
	);

	const stationsOnlyInBefore = Array.from(beforeStations)
		.filter((s) => !afterStations.has(s))
		.sort();
	const stationsOnlyInAfter = Array.from(afterStations)
		.filter((s) => !beforeStations.has(s))
		.sort();
	const stationsInBoth = Array.from(beforeStations).filter((s) =>
		afterStations.has(s),
	).length;

	// Extract and match trips
	const tripsBefore = extractTripSummaries(params.boardsBefore);
	const tripsAfter = extractTripSummaries(params.boardsAfter);

	const matchResult = matchTripsByFingerprint(
		tripsBefore,
		tripsAfter,
		params.options,
	);

	// Determine day-type context (§4.5, Invariant 11)
	const dtBefore = params.manifestBefore?.day_type;
	const dtAfter = params.manifestAfter?.day_type;
	const isCrossDayType = dtBefore && dtAfter && dtBefore !== dtAfter;
	const dayTypeContext: DiffDayTypeContext = isCrossDayType
		? "calendar_variance"
		: "potential_edition_drift";

	// Format concise summary
	const parts: string[] = [];
	if (matchResult.relettered.length > 0) {
		parts.push(`${matchResult.relettered.length} re-lettered`);
	}
	if (matchResult.retimed.length > 0) {
		parts.push(`${matchResult.retimed.length} retimed`);
	}
	if (matchResult.added.length > 0) {
		parts.push(`${matchResult.added.length} added`);
	}
	if (matchResult.withdrawn.length > 0) {
		parts.push(`${matchResult.withdrawn.length} withdrawn`);
	}

	let coverageNotice = "";
	if (stationsOnlyInBefore.length > 0 || stationsOnlyInAfter.length > 0) {
		coverageNotice = ` [Station Coverage: -${stationsOnlyInBefore.length}/+${stationsOnlyInAfter.length} stations]`;
	}

	const contextLabel = isCrossDayType
		? `[Calendar Variance: ${dtBefore} -> ${dtAfter}]`
		: `[Edition Drift]`;

	let summary: string;
	if (parts.length === 0 && !coverageNotice) {
		summary = `${contextLabel} Boards identical (${matchResult.identical.length} trips, ${stationsInBoth} stations)`;
	} else {
		const changeDetails =
			parts.length > 0 ? parts.join(", ") : "Identical trips";
		summary = `${contextLabel}${coverageNotice} ${changeDetails} (${matchResult.identical.length} identical trips)`;
	}

	return {
		dayTypeContext,
		dayTypeBefore: dtBefore,
		dayTypeAfter: dtAfter,
		stationCoverage: {
			stationsInBoth,
			stationsOnlyInBefore,
			stationsOnlyInAfter,
		},
		totalTripsBefore: tripsBefore.size,
		totalTripsAfter: tripsAfter.size,
		identicalCount: matchResult.identical.length,
		relettered: matchResult.relettered,
		retimed: matchResult.retimed,
		added: matchResult.added,
		withdrawn: matchResult.withdrawn,
		summary,
	};
}
