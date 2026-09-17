// tests/export/gates.test.ts
import { describe, expect, it } from "bun:test";
import { evaluateReleaseGates } from "../../src/export/gates";

describe("src/export/gates — Release Gates", () => {
	it("--require-resolved-calendar: permits resolved state and halts on provisional", () => {
		const resolvedInput = {
			calendarStates: [
				{ trip_id: "5022D", calendar_state: "resolved" },
				{ trip_id: "1163F", calendar_state: "resolved" },
			],
			itineraryStatuses: [],
			holidayDates: [],
			endDate: "20261231",
			requireResolvedCalendar: true,
		};

		expect(() => evaluateReleaseGates(resolvedInput)).not.toThrow();

		const provisionalInput = {
			calendarStates: [
				{ trip_id: "5022D", calendar_state: "resolved" },
				{ trip_id: "1163F", calendar_state: "provisional" },
			],
			itineraryStatuses: [],
			holidayDates: [],
			endDate: "20261231",
			requireResolvedCalendar: true,
		};

		expect(() => evaluateReleaseGates(provisionalInput)).toThrow(
			"Release Gate Failed (--require-resolved-calendar): Calendar state is provisional",
		);
	});

	it("--require-census-complete: halts when unprobed itineraries exist", () => {
		const completeInput = {
			calendarStates: [],
			itineraryStatuses: [
				{ trip_id: "5022D", itinerary_status: "200" },
				{ trip_id: "1163F", itinerary_status: "404" },
			],
			holidayDates: [],
			endDate: "20261231",
			requireCensusComplete: true,
		};

		expect(() => evaluateReleaseGates(completeInput)).not.toThrow();

		const incompleteInput = {
			calendarStates: [],
			itineraryStatuses: [
				{ trip_id: "5022D", itinerary_status: "200" },
				{ trip_id: "1163F", itinerary_status: "unprobed" },
			],
			holidayDates: [],
			endDate: "20261231",
			requireCensusComplete: true,
		};

		expect(() => evaluateReleaseGates(incompleteInput)).toThrow(
			"Release Gate Failed (--require-census-complete): 1 discovered trips remain with itinerary_status = 'unprobed'",
		);
	});

	it("--require-holiday-coverage: verifies feed horizon does not exceed covered decrees", () => {
		const holidayDates = ["2026-01-01", "2026-08-17", "2026-12-25"];

		// Covered window
		const covered = evaluateReleaseGates({
			calendarStates: [],
			itineraryStatuses: [],
			holidayDates,
			endDate: "20261225",
			requireHolidayCoverage: true,
		});
		expect(covered.valid).toBe(true);
		expect(covered.warnings).toHaveLength(0);

		// Exceeding window with gate enabled -> throws
		expect(() =>
			evaluateReleaseGates({
				calendarStates: [],
				itineraryStatuses: [],
				holidayDates,
				endDate: "20261231",
				requireHolidayCoverage: true,
			}),
		).toThrow("Release Gate Failed (--require-holiday-coverage)");

		// Exceeding window without gate enabled -> emits audit warning
		const withWarning = evaluateReleaseGates({
			calendarStates: [],
			itineraryStatuses: [],
			holidayDates,
			endDate: "20261231",
			requireHolidayCoverage: false,
		});
		expect(withWarning.valid).toBe(true);
		expect(withWarning.warnings).toHaveLength(1);
		expect(withWarning.warnings[0]).toContain(
			"exceeds covered statutory holiday decrees",
		);

		// Empty holiday dates with gate enabled -> throws
		expect(() =>
			evaluateReleaseGates({
				calendarStates: [],
				itineraryStatuses: [],
				holidayDates: [],
				endDate: "20261231",
				requireHolidayCoverage: true,
			}),
		).toThrow("Database contains zero statutory holiday dates");

		// Empty holiday dates without gate enabled -> emits warning
		const emptyWarning = evaluateReleaseGates({
			calendarStates: [],
			itineraryStatuses: [],
			holidayDates: [],
			endDate: "20261231",
			requireHolidayCoverage: false,
		});
		expect(emptyWarning.valid).toBe(true);
		expect(emptyWarning.warnings).toHaveLength(1);
		expect(emptyWarning.warnings[0]).toContain(
			"Database contains zero statutory holiday dates",
		);
	});
});
