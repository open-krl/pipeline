// src/core/time.ts
import { DEAD_BAND_CUTOFF_SECS } from "../config";

export { DEAD_BAND_CUTOFF_SECS };
export const SECONDS_IN_DAY = 86400;

/**
 * Parses an 'HH:MM:SS' time string into seconds elapsed since 00:00:00 (0..86399).
 */
export function parseHMS(hms: string): number {
	const parts = hms.split(":").map((p) => Number.parseInt(p, 10));
	if (
		parts.length !== 3 ||
		Number.isNaN(parts[0]) ||
		Number.isNaN(parts[1]) ||
		Number.isNaN(parts[2])
	) {
		throw new Error(`Invalid time format, expected HH:MM:SS: ${hms}`);
	}
	const [h, m, s] = parts;
	return h * 3600 + m * 60 + s;
}

/**
 * Formats integer seconds past midnight into continuous 'HH:MM:SS'.
 * Supports values >= 86400 (e.g. 86520 -> "24:02:00") for GTFS continuity (§4.2).
 */
export function secsToDisplay(totalSecs: number): string {
	if (totalSecs < 0) {
		throw new Error(`Negative seconds cannot be displayed: ${totalSecs}`);
	}
	const h = Math.floor(totalSecs / 3600);
	const remainder = totalSecs % 3600;
	const m = Math.floor(remainder / 60);
	const s = remainder % 60;

	const hh = String(h).padStart(2, "0");
	const mm = String(m).padStart(2, "0");
	const ss = String(s).padStart(2, "0");
	return `${hh}:${mm}:${ss}`;
}

/**
 * Converts an 'HH:MM:SS' display time to service-day seconds (§4.2).
 * Clock times strictly below the dead-band cutoff (< 03:30:00 / < 12600s)
 * have 86400s added, grouping late-night tail runs with the active operating day.
 */
export function toServiceDaySecs(hms: string): number {
	const clockSecs = parseHMS(hms);
	if (clockSecs < DEAD_BAND_CUTOFF_SECS) {
		return clockSecs + SECONDS_IN_DAY;
	}
	return clockSecs;
}

export interface ResolvedStopTimes {
	arrival_secs: number | null;
	departure_secs: number | null;
}

/**
 * Resolves full itinerary stop times using a sequential monotonic walk (§4.2, §4.6).
 * - Origin stop has arrival_secs = null.
 * - Terminus stop has departure_secs = null.
 * - Intermediate stops have arrival_secs = departure_secs.
 * - Monotonic walk increments day offset by 86400s if clock time steps backward.
 */
export function resolveItinerarySecs(
	stops: Array<{ time_est: string }>,
): ResolvedStopTimes[] {
	if (stops.length === 0) {
		return [];
	}

	const result: ResolvedStopTimes[] = [];
	const originClock = parseHMS(stops[0].time_est);

	// Determine starting day offset based on the dead-band rule for origin
	let dayOffsetSecs = originClock < DEAD_BAND_CUTOFF_SECS ? SECONDS_IN_DAY : 0;
	let prevClock = originClock;

	for (let i = 0; i < stops.length; i++) {
		const currClock = parseHMS(stops[i].time_est);

		// If time steps backward (e.g. 23:59:00 -> 00:02:00), cross midnight
		if (i > 0 && currClock < prevClock) {
			dayOffsetSecs += SECONDS_IN_DAY;
		}
		prevClock = currClock;

		const currentServiceSecs = currClock + dayOffsetSecs;
		const isOrigin = i === 0;
		const isTerminus = i === stops.length - 1;

		result.push({
			arrival_secs: isOrigin ? null : currentServiceSecs,
			departure_secs: isTerminus ? null : currentServiceSecs,
		});
	}

	return result;
}
