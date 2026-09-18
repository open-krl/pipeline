import * as z from "zod";

export const projectName = "Open-KRL-Pipeline";

export const API_BASE_URL = "https://www.kci.id";

export const API_HEADERS = {
	"User-Agent": "Mozilla/5.0",
	Accept: "application/json, text/plain, */*",
	Referer: "https://www.kci.id/",
} as const;

export const RegionScopeSchema = z.enum(["jabodetabek", "yogyakarta", "all"]);
export type RegionScope = z.infer<typeof RegionScopeSchema>;

export const REGION_GROUPS: Record<RegionScope, readonly number[]> = {
	jabodetabek: [0],
	yogyakarta: [6],
	all: [0, 6],
} as const;

export const DEFAULT_REGION_SCOPE: RegionScope = "jabodetabek";

export const CONCURRENCY = {
	captureBoards: 3,
	censusItineraries: 3,
} as const;

export const PACING_MS = 1000;

export const RETRY = {
	baseMs: 1000,
	factor: 2,
	maxRetries: 3,
	maxDelayMs: 30000,
} as const;

export const DEAD_BAND_CUTOFF_SECS = 12600; // 03:30:00 in seconds

export const TIMEZONE = "Asia/Jakarta";

export const DEFAULT_TIME_WINDOW = {
	timefrom: "00:00",
	timeto: "23:59",
} as const;

/**
 * 3-station signature representing key corridor families for drift detection (§9, §12):
 * - Manggarai (Central / Bogor trunk)
 * - Bekasi (Cikarang corridor)
 * - Rangkasbitung (Western branch)
 */
export const CORRIDOR_REFERENCE_STATIONS = {
	manggarai: "MRI",
	bekasi: "BKS",
	rangkasbitung: "RK",
} as const;

/**
 * Station code aliases for known upstream KCI API defects.
 * Strictly used when two codes represent the SAME physical station entity.
 *
 * 1. GGL -> GRG (Grogol):
 *    KCI's station catalog (`/api/krl/stations`) registers Grogol under `GGL`.
 *    However, the station departure board endpoint (`/api/krl/schedules?stationid=...`)
 *    returns 404 for `GGL`, train itinerary stops (`/api/krl/train-schedule`) emit `GRG`, and
 *    official KCI published timetable PDFs print `GRG`.
 */
export const STATION_CODE_OVERRIDES: Readonly<Record<string, string>> = {
	GGL: "GRG",
};

/**
 * Trip-scoped itinerary station overrides for specific upstream database migration glitches.
 * Constrained strictly to specific trip IDs to avoid corrupting distinct physical station
 * identities (e.g. Stasiun Karet vs. Stasiun BNI City) for other services or non-passenger operations.
 *
 * Train 5169D:
 * KAI Commuter Sept 1, 2026 operational diversion: 263 out of 264 daily Cikarang Line services
 * were updated to emit Stasiun BNI City (`SUDB`), but train 5169D was missed in KCI's backend
 * update and still emitted Stasiun Karet (`KAT`).
 */
export const TRIP_STATION_OVERRIDES: Readonly<
	Record<string, Readonly<Record<string, string>>>
> = {
	"5169D": {
		KAT: "SUDB",
	},
};

export function resolveStationCode(stationId: string): string {
	if (Object.hasOwn(STATION_CODE_OVERRIDES, stationId)) {
		return STATION_CODE_OVERRIDES[stationId];
	}
	return stationId;
}

export function resolveTripStationCode(
	tripId: string,
	stationId: string,
): string {
	const tripOverrides = TRIP_STATION_OVERRIDES[tripId];
	if (tripOverrides && Object.hasOwn(tripOverrides, stationId)) {
		return tripOverrides[stationId];
	}
	return resolveStationCode(stationId);
}
