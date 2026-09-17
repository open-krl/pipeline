// src/diagnostic/types.ts
import type { StationItem } from "../api/schemas";
import type { DayType } from "../archive/schemas";

/**
 * Differences observed between two station catalogs (§8.1 Gate 1).
 */
export interface CatalogUpdatedStation {
	sta_id: string;
	before: StationItem;
	after: StationItem;
	changedFields: Array<"sta_name" | "group_wil" | "fg_enable">;
}

export interface CatalogDiff {
	added: StationItem[];
	removed: StationItem[];
	updated: CatalogUpdatedStation[];
	identicalCount: number;
	summary: string;
}

/**
 * Trip-level classification for board departures (§4.1, Invariant 8, Invariant 11).
 */
export type TripChangeClassification =
	| "identical"
	| "relettered"
	| "retimed"
	| "relettered_and_retimed"
	| "added"
	| "withdrawn";

export interface BoardDiffTripItem {
	classification: TripChangeClassification;
	baseTrainNo: number;
	trainIdBefore: string | null;
	trainIdAfter: string | null;
	originStation: string;
	dest: string;
	timeDeltaSecs: number;
	details: string;
}

export type DiffDayTypeContext =
	| "potential_edition_drift"
	| "calendar_variance";

export interface BoardDiff {
	dayTypeContext: DiffDayTypeContext;
	dayTypeBefore?: DayType;
	dayTypeAfter?: DayType;
	stationCoverage: {
		stationsInBoth: number;
		stationsOnlyInBefore: string[];
		stationsOnlyInAfter: string[];
	};
	totalTripsBefore: number;
	totalTripsAfter: number;
	identicalCount: number;
	relettered: BoardDiffTripItem[];
	retimed: BoardDiffTripItem[];
	added: BoardDiffTripItem[];
	withdrawn: BoardDiffTripItem[];
	summary: string;
}

/**
 * Stop-level itinerary difference (§9 Stratified Spot-Check, Invariant 4).
 */
export type ItineraryStopChangeStatus =
	| "unchanged"
	| "retimed"
	| "added"
	| "removed";

export interface ItineraryStopDiff {
	stationId: string;
	stationName: string;
	status: ItineraryStopChangeStatus;
	timeBefore: string | null;
	timeAfter: string | null;
	deltaSecs: number;
}

export interface ItineraryDiff {
	trainIdBefore: string;
	trainIdAfter: string;
	stopsCountBefore: number;
	stopsCountAfter: number;
	stops: ItineraryStopDiff[];
	retimedCount: number;
	addedCount: number;
	removedCount: number;
	unchangedCount: number;
	summary: string;
}
