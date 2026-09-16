// src/config.ts

export const API_BASE_URL = "https://www.kci.id";

export const API_HEADERS = {
	"User-Agent":
		"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
	Accept: "application/json, text/plain, */*",
	Referer: "https://www.kci.id/",
} as const;

export type RegionScope = "jabodetabek" | "yogyakarta" | "all";

export const REGION_GROUPS: Record<RegionScope, readonly number[]> = {
	jabodetabek: [0],
	yogyakarta: [6],
	all: [0, 6],
} as const;

export const DEFAULT_REGION_SCOPE: RegionScope = "jabodetabek";

export const CONCURRENCY = {
	captureBoards: 5,
	censusItineraries: 4,
} as const;

export const RETRY = {
	baseMs: 1000,
	factor: 2,
	maxRetries: 3,
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
