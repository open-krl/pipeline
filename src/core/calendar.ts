import * as z from "zod";
import dayjs from "../lib/dayjs";

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
 * Resolves the operational day type (weekday | saturday | sunday | holiday)
 * for a given timestamp evaluated strictly under the Asia/Jakarta calendar (§4.5).
 * Statutory national holidays (where is_collective_leave === false) are classified
 * as 'holiday'.
 */
export function resolveDayType(
	date: Date,
	holidays: ReadonlyArray<HolidayItem>,
): DayType {
	const dateStr = dayjs(date).format("YYYY-MM-DD");

	// Check against statutory national holidays (cuti bersama is inert for day classification)
	const isStatutoryHoliday = holidays.some(
		(h) => h.holiday_date === dateStr && !h.is_collective_leave,
	);
	if (isStatutoryHoliday) {
		return "holiday";
	}

	const dow = dayjs(date).day();
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
