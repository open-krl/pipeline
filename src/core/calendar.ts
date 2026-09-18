import * as z from "zod";
import { TIMEZONE } from "../config";

// ─── Operational Day Type Schema (§4.5, §8.2) ────────────────────────────────
export const DayTypeSchema = z.enum([
	"weekday",
	"saturday",
	"sunday",
	"holiday",
]);
export type DayType = z.infer<typeof DayTypeSchema>;

// ─── Holiday File Schema ─────────────────────────────────────────────────────
const HolidayItemSchema = z.object({
	holiday_date: z
		.string()
		.regex(/^\d{4}-\d{2}-\d{2}$/, { error: "Expected YYYY-MM-DD" }),
	name: z.string().min(1),
	is_collective_leave: z.boolean(),
});
export type HolidayItem = z.infer<typeof HolidayItemSchema>;

export const HolidayFileSchema = z.array(HolidayItemSchema);

/**
 * Formats a given Date instance into 'YYYY-MM-DD' under Asia/Jakarta (WIB) clock.
 */
export function formatDateWib(date: Date): string {
	const formatter = new Intl.DateTimeFormat("en-CA", {
		timeZone: TIMEZONE,
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
	});
	return formatter.format(date);
}

/**
 * Returns the day of the week (0 = Sunday, 1 = Monday, ..., 6 = Saturday)
 * under Asia/Jakarta (WIB) clock.
 */
export function getDayOfWeekWib(date: Date): number {
	const formatter = new Intl.DateTimeFormat("en-US", {
		timeZone: TIMEZONE,
		weekday: "short",
	});
	const dayStr = formatter.format(date);
	switch (dayStr) {
		case "Sun":
			return 0;
		case "Mon":
			return 1;
		case "Tue":
			return 2;
		case "Wed":
			return 3;
		case "Thu":
			return 4;
		case "Fri":
			return 5;
		case "Sat":
			return 6;
		default:
			throw new Error(`Unexpected weekday format: ${dayStr}`);
	}
}

/**
 * Resolves the operational day type (weekday | saturday | sunday | holiday)
 * for a given timestamp evaluated strictly under the Asia/Jakarta calendar (§4.5).
 * Statutory national holidays (where is_collective_leave === false) are classified
 * as 'holiday'.
 */
export function resolveDayType(
	date: Date,
	holidays: ReadonlyArray<HolidayItem>,
): DayType {
	const dateStr = formatDateWib(date);

	// Check against statutory national holidays (cuti bersama is inert for day classification)
	const isStatutoryHoliday = holidays.some(
		(h) => h.holiday_date === dateStr && !h.is_collective_leave,
	);
	if (isStatutoryHoliday) {
		return "holiday";
	}

	const dow = getDayOfWeekWib(date);
	if (dow === 0) return "sunday";
	if (dow === 6) return "saturday";
	return "weekday";
}

/**
 * Maps a captured snapshot day type into its corresponding trip_calendar presence column (§4.5).
 * - 'weekday' & 'holiday' -> 'runs_weekday'
 * - 'saturday'            -> 'runs_saturday'
 * - 'sunday'              -> 'runs_sunday'
 */
export function foldDayTypeRule(
	dayType: DayType,
): "runs_weekday" | "runs_saturday" | "runs_sunday" {
	switch (dayType) {
		case "weekday":
		case "holiday":
			return "runs_weekday";
		case "saturday":
			return "runs_saturday";
		case "sunday":
			return "runs_sunday";
	}
}
