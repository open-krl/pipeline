// src/export/gates.ts

export interface ReleaseGateInput {
	calendarStates: Array<{ trip_id: string; calendar_state: string }>;
	itineraryStatuses: Array<{ trip_id: string; itinerary_status: string }>;
	holidayDates: string[]; // YYYY-MM-DD
	endDate: string; // YYYYMMDD
	requireResolvedCalendar?: boolean;
	requireCensusComplete?: boolean;
	requireHolidayCoverage?: boolean;
}

export interface ReleaseGateResult {
	valid: boolean;
	warnings: string[];
}

/**
 * Evaluates production release gates prior to compiling the GTFS feed (§9, Task 5.3).
 */
export function evaluateReleaseGates(
	input: ReleaseGateInput,
): ReleaseGateResult {
	const warnings: string[] = [];

	// Gate 1: --require-resolved-calendar
	if (input.requireResolvedCalendar) {
		const provisionalTrips = input.calendarStates.filter(
			(c) => c.calendar_state !== "resolved",
		);
		if (provisionalTrips.length > 0) {
			throw new Error(
				`Release Gate Failed (--require-resolved-calendar): Calendar state is provisional (${provisionalTrips.length} trips unconfirmed). Requires all 3 day types (weekday, saturday, sunday) to be captured and folded before release.`,
			);
		}
	}

	// Gate 2: --require-census-complete
	if (input.requireCensusComplete) {
		const unprobedTrips = input.itineraryStatuses.filter(
			(t) => t.itinerary_status === "unprobed",
		);
		if (unprobedTrips.length > 0) {
			throw new Error(
				`Release Gate Failed (--require-census-complete): ${unprobedTrips.length} discovered trips remain with itinerary_status = 'unprobed'. Execute 'krl census' before production export.`,
			);
		}
	}

	// Gate 3: --require-holiday-coverage
	if (input.holidayDates.length === 0) {
		if (input.requireHolidayCoverage) {
			throw new Error(
				"Release Gate Failed (--require-holiday-coverage): Database contains zero statutory holiday dates. Cannot verify holiday coverage.",
			);
		}
		warnings.push(
			"Notice: Database contains zero statutory holiday dates. Fakultatif exceptions cannot be modeled.",
		);
	} else {
		const sortedHolidays = [...input.holidayDates].sort();
		const latestHolidayYmd = sortedHolidays[sortedHolidays.length - 1];
		const latestHolidayGtfs = latestHolidayYmd.replaceAll("-", "");

		if (input.endDate > latestHolidayGtfs) {
			if (input.requireHolidayCoverage) {
				throw new Error(
					`Release Gate Failed (--require-holiday-coverage): Feed end date (${input.endDate}) exceeds latest statutory holiday decree covered in database (${latestHolidayGtfs}). Update data/holidays.json or constrain feed end date.`,
				);
			}
			warnings.push(
				`Notice: Feed validity horizon (${input.endDate}) exceeds covered statutory holiday decrees (${latestHolidayGtfs}). Fakultatif exceptions beyond this date cannot be modeled.`,
			);
		}
	}

	return {
		valid: true,
		warnings,
	};
}
