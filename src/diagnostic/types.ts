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

/**
 * Unified service cluster across day types (§9 Task 6.4).
 */
export interface CalendarServiceCluster {
	serviceKey: string;
	baseTrainNo: number;
	originStation: string;
	destStation: string;
	lineName: string;
	routeName: string;
	isFakultatif: boolean;
	runsWeekday: boolean;
	runsSaturday: boolean;
	runsSunday: boolean;
	trainIds: string[];
	relettered: boolean;
	retimed: boolean;
	maxDeltaSecs: number;
	category:
		| "daily"
		| "weekday_only"
		| "mon_sat"
		| "weekend_only"
		| "saturday_only"
		| "sunday_only"
		| "weekday_sunday";
}

export interface CalendarAnalysisResult {
	timetableVersion: number;
	source: "snapshots" | "database";
	availableDayTypes: {
		weekday: boolean;
		saturday: boolean;
		sunday: boolean;
	};
	totalServices: number;
	totalTripsByDayType: {
		weekday: number;
		saturday: number;
		sunday: number;
	};
	breakdown: {
		daily: CalendarServiceCluster[];
		weekdayOnly: CalendarServiceCluster[];
		monSat: CalendarServiceCluster[];
		weekendOnly: CalendarServiceCluster[];
		saturdayOnly: CalendarServiceCluster[];
		sundayOnly: CalendarServiceCluster[];
		weekdaySunday: CalendarServiceCluster[];
	};
	stats: {
		coreSharedCount: number;
		coreSharedRatio: number;
		reletteredCount: number;
		retimedCount: number;
		fakultatif: {
			total: number;
			weekdayActive: number;
			weekendActive: number;
			suspendedOnWeekend: number;
		};
	};
	summary: string;
}

/**
 * Operational corridor drift probe results (§9 Task 6.5, §12).
 */
export interface StationDriftResult {
	stationId: string;
	stationName: string;
	expectedCount: number;
	liveCount: number;
	identicalCount: number;
	reletteredCount: number;
	retimedCount: number;
	addedCount: number;
	withdrawnCount: number;
}

export type CorridorDriftStatus =
	| "STABLE"
	| "OPERATIONAL_VARIANCE"
	| "POTENTIAL_EDITION_DRIFT";

export interface DetectResult {
	probeTimeWib: string;
	timetableVersion: number;
	baselineSource: "database" | "snapshots";
	dayType: DayType;
	dateStr: string;
	stations: StationDriftResult[];
	totalExpected: number;
	totalLive: number;
	totalIdentical: number;
	totalRelettered: number;
	totalRetimed: number;
	totalAdded: number;
	totalWithdrawn: number;
	status: CorridorDriftStatus;
	summary: string;
	actionRecommendation?: string;
}
