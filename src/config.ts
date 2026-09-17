import * as z from "zod";

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

export const PACING_MS = 500;

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
 * Station code overrides for known upstream KCI API defects and operational diversions.
 *
 * 1. GGL -> GRG (Grogol):
 *    KCI's station catalog (`/api/krl/stations`) registers Grogol under `GGL`.
 *    However, the station departure board endpoint (`/api/krl/schedules?stationid=...`)
 *    returns 404 for `GGL`, train itinerary stops (`/api/krl/train-schedule`) emit `GRG`, and
 *    official KCI published timetable PDFs print `GRG`.
 *
 * 2. KAT -> SUDB (Stasiun Karet -> Stasiun BNI City / Sudirman Baru):
 *    Starting September 1, 2026, KAI Commuter temporarily suspended passenger operations
 *    at Stasiun Karet (`KAT`) for integration works, diverting all 264 daily Cikarang corridor
 *    stops to Stasiun BNI City (`SUDB`). Upstream KCI updated their itinerary database for 263
 *    trains to emit `SUDB`, but missed train `5169D` which still emitted `KAT`. Mapping `KAT` ->
 *    `SUDB` aligns the un-migrated record with physical reality and the rest of the dataset.
 */
export const STATION_CODE_OVERRIDES: Readonly<Record<string, string>> = {
	GGL: "GRG",
	KAT: "SUDB",
};

export function resolveStationCode(stationId: string): string {
	return STATION_CODE_OVERRIDES[stationId] ?? stationId;
}
