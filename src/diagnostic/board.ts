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
	const unparsedBefore = new Set<string>();
	const unparsedAfter = new Set<string>();
	const tripsBefore = extractTripSummaries(params.boardsBefore, unparsedBefore);
	const tripsAfter = extractTripSummaries(params.boardsAfter, unparsedAfter);

	const unparsedBeforeList = Array.from(unparsedBefore).sort();
	const unparsedAfterList = Array.from(unparsedAfter).sort();
	const unparsedDiffCount =
		unparsedBeforeList.filter((id) => !unparsedAfter.has(id)).length +
		unparsedAfterList.filter((id) => !unparsedBefore.has(id)).length;

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
		const pureCount = matchResult.relettered.filter(
			(r) => r.classification === "relettered",
		).length;
		const retimedCount = matchResult.relettered.length - pureCount;
		parts.push(
			retimedCount > 0
				? `${matchResult.relettered.length} re-lettered (${pureCount} pure, ${retimedCount} retimed)`
				: `${matchResult.relettered.length} re-lettered`,
		);
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
	if (stationsOnlyInBefore.length > 0 && stationsOnlyInAfter.length > 0) {
		coverageNotice = ` [Coverage: ${stationsOnlyInBefore.length} missing, ${stationsOnlyInAfter.length} new stations]`;
	} else if (stationsOnlyInBefore.length > 0) {
		const list = stationsOnlyInBefore.slice(0, 3).join(", ");
		const suffix = stationsOnlyInBefore.length > 3 ? "..." : "";
		const s = stationsOnlyInBefore.length > 1 ? "s" : "";
		coverageNotice = ` [Coverage: ${stationsOnlyInBefore.length} missing station${s} (${list}${suffix})]`;
	} else if (stationsOnlyInAfter.length > 0) {
		const list = stationsOnlyInAfter.slice(0, 3).join(", ");
		const suffix = stationsOnlyInAfter.length > 3 ? "..." : "";
		const s = stationsOnlyInAfter.length > 1 ? "s" : "";
		coverageNotice = ` [Coverage: ${stationsOnlyInAfter.length} new station${s} (${list}${suffix})]`;
	}
	let unparsedNotice = "";
	if (unparsedBeforeList.length > 0 || unparsedAfterList.length > 0) {
		const addedUnparsed = unparsedAfterList.filter(
			(id) => !unparsedBefore.has(id),
		);
		const removedUnparsed = unparsedBeforeList.filter(
			(id) => !unparsedAfter.has(id),
		);
		if (addedUnparsed.length > 0 || removedUnparsed.length > 0) {
			const details: string[] = [];
			if (addedUnparsed.length > 0) {
				details.push(
					`+${addedUnparsed.length} unparsed (e.g. ${addedUnparsed.slice(0, 2).join(", ")})`,
				);
			}
			if (removedUnparsed.length > 0) {
				details.push(
					`-${removedUnparsed.length} unparsed (e.g. ${removedUnparsed.slice(0, 2).join(", ")})`,
				);
			}
			unparsedNotice = ` [Unparsed: ${details.join(", ")}]`;
		} else {
			unparsedNotice = ` [${unparsedAfterList.length} unparsed trips present in both]`;
		}
	}

	const hasChanges =
		matchResult.relettered.length > 0 ||
		matchResult.retimed.length > 0 ||
		matchResult.added.length > 0 ||
		matchResult.withdrawn.length > 0 ||
		unparsedDiffCount > 0;

	const contextLabel = isCrossDayType
		? `[Calendar Variance: ${dtBefore} -> ${dtAfter}]`
		: hasChanges
			? `[Edition Drift]`
			: `[Identical]`;

	let summary: string;
	if (parts.length === 0 && !coverageNotice && !unparsedNotice) {
		summary = `${contextLabel} Boards identical (${matchResult.identical.length} trips, ${stationsInBoth} stations)`;
	} else if (parts.length === 0) {
		summary = `${contextLabel}${coverageNotice}${unparsedNotice} All parsed trips identical (${matchResult.identical.length} trips)`;
	} else {
		summary = `${contextLabel}${coverageNotice}${unparsedNotice} ${parts.join(", ")} (${matchResult.identical.length} identical trips)`;
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
		unparsedTrips: {
			before: unparsedBeforeList,
			after: unparsedAfterList,
		},
		summary,
	};
}
